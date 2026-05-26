/**
 * RPG-MCP Server - Dynamic Loader Pattern Implementation
 * 
 * Token reduction: ~50K → ~6-8K (85%+ reduction)
 * 
 * Meta-tools (search_tools, load_tool_schema) enable:
 * - Tool discovery by keyword/category
 * - On-demand schema loading
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// Meta-tools and registry
import { MetaTools, handleSearchTools, handleLoadToolSchema } from './meta-tools.js';
import { buildConsolidatedRegistry } from './consolidated-registry.js';
import { toolParamShape } from './tool-shape.js';
import { toInlinedJsonSchema } from './tool-json-schema.js';
// MINIMAL_SCHEMA removed - must pass actual schema for MCP SDK to pass arguments

// PubSub and utilities
import { PubSub } from '../engine/pubsub.js';
import { registerEventTools } from './events.js';
import { AuditLogger } from './audit.js';
import { withSession } from './types.js';
import { closeDb, getDbPath } from '../storage/index.js';

/**
 * Setup graceful shutdown handlers to ensure database is properly closed.
 */
function setupShutdownHandlers(): void {
  let isShuttingDown = false;

  const shutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.error(`[Server] Received ${signal}, shutting down gracefully...`);

    try {
      closeDb();
      console.error('[Server] Shutdown complete');
      process.exit(0);
    } catch (e) {
      console.error('[Server] Error during shutdown:', (e as Error).message);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  }

  process.on('uncaughtException', (error) => {
    console.error('[Server] Uncaught exception:', error);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[Server] Unhandled rejection:', reason);
    shutdown('unhandledRejection');
  });

  process.on('exit', (code) => {
    if (!isShuttingDown) {
      console.error(`[Server] Process exiting with code ${code}`);
      closeDb();
    }
  });
}

async function main() {
  setupShutdownHandlers();
  console.error(`[Server] Database path: ${getDbPath()}`);

  const server = new McpServer({
    name: 'rpg-mcp',
    version: '1.1.0'
  });

  // Initialize PubSub for event subscription
  const pubsub = new PubSub();

  // Register Event Tools (subscribe_to_events)
  registerEventTools(server, pubsub);

  // Initialize AuditLogger
  const auditLogger = new AuditLogger();

  // =========================================================================
  // META-TOOLS: Register with FULL schemas (they're the discovery mechanism)
  // =========================================================================
  
  // Accumulate the tools/list payload as we register each tool, built from the
  // SAME shapes handed to the SDK but serialized with internal $refs INLINED (#73).
  // A ListTools override below advertises this in place of the SDK's default
  // (which emits $refs that some MCP bridges, e.g. mcpo, can't resolve).
  const advertisedTools: Array<{
    name: string;
    description: string;
    inputSchema: ReturnType<typeof toInlinedJsonSchema>;
  }> = [];

  const searchToolsShape = MetaTools.SEARCH_TOOLS.inputSchema.extend({ sessionId: z.string().optional() }).shape;
  server.tool(
    MetaTools.SEARCH_TOOLS.name,
    MetaTools.SEARCH_TOOLS.description,
    searchToolsShape,
    auditLogger.wrapHandler(MetaTools.SEARCH_TOOLS.name, withSession(MetaTools.SEARCH_TOOLS.inputSchema, handleSearchTools))
  );
  advertisedTools.push({
    name: MetaTools.SEARCH_TOOLS.name,
    description: MetaTools.SEARCH_TOOLS.description,
    inputSchema: toInlinedJsonSchema(searchToolsShape),
  });

  const loadToolSchemaShape = MetaTools.LOAD_TOOL_SCHEMA.inputSchema.extend({ sessionId: z.string().optional() }).shape;
  server.tool(
    MetaTools.LOAD_TOOL_SCHEMA.name,
    MetaTools.LOAD_TOOL_SCHEMA.description,
    loadToolSchemaShape,
    auditLogger.wrapHandler(MetaTools.LOAD_TOOL_SCHEMA.name, withSession(MetaTools.LOAD_TOOL_SCHEMA.inputSchema, handleLoadToolSchema))
  );
  advertisedTools.push({
    name: MetaTools.LOAD_TOOL_SCHEMA.name,
    description: MetaTools.LOAD_TOOL_SCHEMA.description,
    inputSchema: toInlinedJsonSchema(loadToolSchemaShape),
  });

  // =========================================================================
  // CONSOLIDATED TOOLS: 28 action-based tools (85% reduction from 195)
  // =========================================================================

  const registry = buildConsolidatedRegistry();
  const toolCount = Object.keys(registry).length;

  for (const [toolName, entry] of Object.entries(registry)) {
    // Build the ZodRawShape the MCP SDK expects, robustly unwrapping refined /
    // intersected / wrapped schemas so a tool's parameters are never silently
    // dropped to `{}` (which would make the tool invisible to the LLM). (#24)
    const baseShape = toolParamShape(entry.schema as z.ZodTypeAny);
    if (baseShape === null) {
      // Fail loud: an unextractable inputSchema (not object-like) is a schema bug,
      // not intent — surface it at startup instead of shipping a paramless tool.
      // (An intentionally empty z.object({}) extracts to {}, which is allowed.)
      throw new Error(
        `[Server] Tool "${toolName}" has an unsupported inputSchema; ` +
        `toolParamShape could not extract a parameter shape from it.`
      );
    }
    const shape = { ...baseShape, sessionId: z.string().optional() };

    server.tool(
      toolName,
      entry.metadata.description,
      shape,
      auditLogger.wrapHandler(
        toolName,
        withSession(entry.schema, entry.handler as any)
      )
    );
    advertisedTools.push({
      name: toolName,
      description: entry.metadata.description,
      inputSchema: toInlinedJsonSchema(shape),
    });
  }

  // #73: Advertise fully-inlined tool schemas. The MCP SDK auto-registers a
  // ListTools handler (on first server.tool call) that serializes schemas with
  // zod-to-json-schema's default $refStrategy, emitting internal $refs for reused
  // Zod instances (e.g. a status enum used at both `status` and `statusFilter`).
  // Some MCP clients/bridges (OpenAI + Open WebUI via mcpo) can't resolve those.
  // Registering on the low-level server overwrites the SDK's handler in place;
  // CallTool dispatch/validation is unaffected (it still uses the Zod schemas
  // registered via server.tool above).
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: advertisedTools }));

  console.error(`[Server] Registered ${toolCount} tools with minimal schemas`);
  console.error(`[Server] Meta-tools: search_tools, load_tool_schema`);

  // =========================================================================
  // TRANSPORT SETUP
  // =========================================================================
  
  const args = process.argv.slice(2);
  const transportType = args.includes('--tcp') ? 'tcp'
    : (args.includes('--unix') || args.includes('--socket')) ? 'unix'
    : (args.includes('--ws') || args.includes('--websocket')) ? 'websocket'
    : 'stdio';

  if (transportType === 'tcp') {
    const { TCPServerTransport } = await import('./transport/tcp.js');
    const portIndex = args.indexOf('--port');
    const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3000;

    const transport = new TCPServerTransport(port);
    await server.connect(transport);
    console.error(`RPG MCP Server running on TCP port ${port}`);
  } else if (transportType === 'unix') {
    const { UnixServerTransport } = await import('./transport/unix.js');
    let socketPath = '';
    const unixIndex = args.indexOf('--unix');
    const socketIndex = args.indexOf('--socket');

    if (unixIndex !== -1 && args[unixIndex + 1]) {
      socketPath = args[unixIndex + 1];
    } else if (socketIndex !== -1 && args[socketIndex + 1]) {
      socketPath = args[socketIndex + 1];
    }

    if (!socketPath) {
      socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\rpg-mcp' : '/tmp/rpg-mcp.sock';
    }

    const transport = new UnixServerTransport(socketPath);
    await server.connect(transport);
    console.error(`RPG MCP Server running on Unix socket ${socketPath}`);
  } else if (transportType === 'websocket') {
    const { WebSocketServerTransport } = await import('./transport/websocket.js');
    const portIndex = args.indexOf('--port');
    const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3001;

    const transport = new WebSocketServerTransport(port);
    await server.connect(transport);
    console.error(`RPG MCP Server running on WebSocket port ${port}`);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('RPG MCP Server running on stdio');
  }
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
