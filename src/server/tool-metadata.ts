/**
 * Tool Metadata Types for Dynamic Loader Pattern
 * Enables search_tools discovery and load_tool_schema on-demand loading
 */

import { z } from 'zod';

export type ToolCategory =
  | 'world' | 'combat' | 'character' | 'inventory' | 'quest' | 'party'
  | 'math' | 'strategy' | 'secret' | 'concentration' | 'rest' | 'scroll'
  | 'aura' | 'npc' | 'spatial' | 'theft' | 'corpse' | 'improvisation'
  | 'turn-management' | 'meta' | 'batch' | 'context' | 'narrative' | 'composite';

export type TokenCost = 'low' | 'medium' | 'high' | 'variable';

export interface ToolMetadata {
  name: string;
  description: string;
  category: ToolCategory;
  keywords: string[];
  capabilities: string[];
  contextAware: boolean;
  estimatedTokenCost: TokenCost;
  usageExample: string;
  /** If true, tool is only loaded when discovered via search_tools (MCP spec) */
  deferLoading: boolean;
}

/**
 * ToolContract — the single source of truth a consolidated tool declares for
 * itself (ADR-001 Phase 1, #13). The registry derives ToolMetadata FROM this,
 * so discovery metadata (category/keywords/capabilities) lives next to the
 * tool's name/description/inputSchema rather than in parallel maps.
 *
 * Each tool literal in src/server/consolidated/*.ts uses `satisfies ToolContract`
 * so a missing/misspelled field — or a category not in the ToolCategory union —
 * is a compile error.
 */
export interface ToolContract {
  name: string;
  description: string;
  category: ToolCategory;
  keywords: string[];
  capabilities: string[];
  inputSchema: z.ZodTypeAny; // Zod schema — typed so a non-Zod value fails under `satisfies ToolContract`
}

export interface ToolRegistryEntry {
  metadata: ToolMetadata;
  schema: z.ZodTypeAny; // Zod schema
  handler: Function;
}

export interface ToolRegistry {
  [toolName: string]: ToolRegistryEntry;
}

// Minimal schema for MCP registration - empty shape, validation happens in handler
// The MCP SDK expects Zod schema shapes, so we export an empty object
export const MINIMAL_SCHEMA = {};
