/**
 * Consolidated Tool Registry for v1.0 Clean-Break Release
 *
 * Registers only the 28 consolidated tools (85% reduction from 195 tools).
 * Each tool uses action-based routing with fuzzy matching and guiding errors.
 */

import { ToolMetadata, ToolCategory, ToolRegistry, ToolContract } from './tool-metadata.js';
import { ConsolidatedTools } from './consolidated/index.js';
import { SessionContext } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// METADATA HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function meta(
    name: string,
    description: string,
    category: ToolCategory,
    keywords: string[],
    capabilities: string[],
    contextAware: boolean = false,
    estimatedTokenCost: 'low' | 'medium' | 'high' | 'variable' = 'medium',
    deferLoading: boolean = true
): ToolMetadata {
    return {
        name,
        description,
        category,
        keywords,
        capabilities,
        contextAware,
        estimatedTokenCost,
        usageExample: `${name}({ action: '...' })`,
        deferLoading
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// REGISTRY BUILDER
// ═══════════════════════════════════════════════════════════════════════════
//
// ADR-001 Phase 1 (#13): discovery metadata (category/keywords/capabilities) is
// declared on each tool contract in src/server/consolidated/*.ts (typed via
// `satisfies ToolContract`). The registry reads it FROM the contract and fails
// LOUD if any tool is missing it — replacing the previous silent fallbacks
// (`|| 'meta'`, `|| [name]`, `|| []`) so future drift is a crash, not a silent
// degrade of search_tools relevance.

let cachedRegistry: ToolRegistry | null = null;

export function buildConsolidatedRegistry(): ToolRegistry {
    if (cachedRegistry) return cachedRegistry;

    cachedRegistry = {};

    for (const { tool, handler } of ConsolidatedTools) {
        const t = tool as ToolContract;
        const name = t.name;

        // Fail loud: a tool that omits its discovery metadata is a bug, not a
        // default-to-'meta' situation. Name the offending tool and the file to fix.
        if (
            !t.category ||
            !Array.isArray(t.keywords) || t.keywords.length === 0 ||
            !Array.isArray(t.capabilities) || t.capabilities.length === 0
        ) {
            throw new Error(
                `[Registry] Tool "${name}" is missing required discovery metadata ` +
                `(category/keywords/capabilities); declare it on the tool contract in ` +
                `src/server/consolidated/${name.replace(/_/g, '-')}.ts`
            );
        }

        cachedRegistry[name] = {
            metadata: meta(
                name,
                t.description,
                t.category,
                t.keywords,
                t.capabilities,
                false,  // contextAware
                'medium',  // estimatedTokenCost
                true  // deferLoading
            ),
            schema: t.inputSchema,
            handler: handler as (args: unknown, ctx: SessionContext) => Promise<any>
        };
    }

    return cachedRegistry;
}

// ═══════════════════════════════════════════════════════════════════════════
// METADATA ACCESS FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

export function getAllConsolidatedToolMetadata(): ToolMetadata[] {
    const registry = buildConsolidatedRegistry();
    return Object.values(registry).map(entry => entry.metadata);
}

export function getConsolidatedToolCategories(): ToolCategory[] {
    return [
        'world', 'combat', 'character', 'inventory', 'quest', 'party',
        'math', 'strategy', 'secret', 'concentration', 'rest', 'scroll',
        'aura', 'npc', 'spatial', 'theft', 'corpse', 'improvisation',
        'turn-management', 'meta', 'narrative'
    ];
}

export function getConsolidatedToolByName(name: string) {
    const registry = buildConsolidatedRegistry();
    return registry[name] || null;
}
