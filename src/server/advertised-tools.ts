import { z } from 'zod';
import { MetaTools } from './meta-tools.js';
import { EventTools } from './events.js';
import { buildConsolidatedRegistry } from './consolidated-registry.js';
import { toolParamShape } from './tool-shape.js';
import { toInlinedJsonSchema } from './tool-json-schema.js';

export interface AdvertisedTool {
    name: string;
    description: string;
    inputSchema: ReturnType<typeof toInlinedJsonSchema>;
}

/**
 * Tools declared with a full Zod object inputSchema (meta + event tools). Each is
 * registered (via server.tool / registerEventTools) with `sessionId` appended, so
 * we advertise the same shape.
 */
const FULL_SCHEMA_TOOLS: ReadonlyArray<{ name: string; description: string; inputSchema: z.AnyZodObject }> = [
    MetaTools.SEARCH_TOOLS,
    MetaTools.LOAD_TOOL_SCHEMA,
    EventTools.SUBSCRIBE,
    EventTools.UNSUBSCRIBE,
];

/**
 * Build the COMPLETE `tools/list` payload with every internal `$ref` inlined (#73).
 *
 * This is the single source of truth for what the server advertises, returned by
 * the ListTools override in index.ts. It MUST enumerate every registered tool
 * category — meta, event, and consolidated — because the override replaces the
 * SDK's auto-generated handler: any category omitted here silently disappears
 * from discovery while remaining callable (a broken layer contract). index.ts
 * registers exactly these same sources, and the #73 guard test asserts the result
 * covers them all (count + event-tool presence).
 *
 * Schemas are converted with `toInlinedJsonSchema` ($refStrategy: 'none') so they
 * carry no internal `$ref`, which several MCP bridges (OpenAI + Open WebUI via
 * mcpo) cannot resolve.
 */
export function buildAdvertisedTools(): AdvertisedTool[] {
    const tools: AdvertisedTool[] = [];

    // Meta + event tools: full Zod object schemas, plus the registered sessionId.
    for (const t of FULL_SCHEMA_TOOLS) {
        tools.push({
            name: t.name,
            description: t.description,
            inputSchema: toInlinedJsonSchema(t.inputSchema.extend({ sessionId: z.string().optional() }).shape),
        });
    }

    // Consolidated tools: minimal param-shape extracted from each action schema.
    const registry = buildConsolidatedRegistry();
    for (const [name, entry] of Object.entries(registry)) {
        const base = toolParamShape((entry as { schema: z.ZodTypeAny }).schema);
        if (base === null) {
            // Mirror index.ts's fail-loud: an unextractable inputSchema is a bug.
            throw new Error(`[advertised-tools] Tool "${name}" has an unsupported inputSchema; toolParamShape returned null.`);
        }
        tools.push({
            name,
            description: (entry as { metadata: { description: string } }).metadata.description,
            inputSchema: toInlinedJsonSchema({ ...base, sessionId: z.string().optional() }),
        });
    }

    return tools;
}
