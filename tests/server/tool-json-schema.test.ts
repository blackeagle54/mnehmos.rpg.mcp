/**
 * #73: advertised tool schemas must be fully self-contained (no internal $ref),
 * because some MCP clients/bridges (OpenAI + Open WebUI via mcpo) can't resolve
 * them. The $ref originates from reused Zod enum INSTANCES within a tool schema;
 * we fix it at serialization time via toInlinedJsonSchema ($refStrategy: 'none')
 * rather than denormalizing our DRY enum constants.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { toInlinedJsonSchema } from '../../src/server/tool-json-schema.js';
import { buildConsolidatedRegistry } from '../../src/server/consolidated-registry.js';
import { toolParamShape } from '../../src/server/tool-shape.js';
import { MetaTools } from '../../src/server/meta-tools.js';

process.env.NODE_ENV = 'test';

// Reproduce the EXACT ZodRawShape index.ts registers for each tool, so the guard
// reflects what the server actually advertises in tools/list.
function allToolShapes(): Array<{ name: string; shape: z.ZodRawShape }> {
    const out: Array<{ name: string; shape: z.ZodRawShape }> = [];
    // Meta-tools: full schema + sessionId (mirrors index.ts registration).
    for (const meta of [MetaTools.SEARCH_TOOLS, MetaTools.LOAD_TOOL_SCHEMA]) {
        out.push({ name: meta.name, shape: meta.inputSchema.extend({ sessionId: z.string().optional() }).shape });
    }
    // Consolidated tools: {...toolParamShape(schema), sessionId} (mirrors index.ts).
    const registry = buildConsolidatedRegistry();
    for (const [name, entry] of Object.entries(registry)) {
        const base = toolParamShape((entry as { schema: z.ZodTypeAny }).schema);
        if (!base) throw new Error(`toolParamShape returned null for ${name}`);
        out.push({ name, shape: { ...base, sessionId: z.string().optional() } });
    }
    return out;
}

function hasRef(schema: unknown): boolean {
    return JSON.stringify(schema).includes('"$ref"');
}

describe('tool JSON Schema $ref inlining (#73)', () => {
    it('documents the bug: SDK-default conversion emits $ref for the reused-enum tools', () => {
        const shapes = Object.fromEntries(allToolShapes().map(t => [t.name, t.shape]));
        // These four reuse a shared enum instance within one tool schema, so the
        // SDK's default ($refStrategy: 'root') de-duplicates by reference → $ref.
        for (const name of ['narrative_manage', 'character_manage', 'party_manage', 'spatial_manage']) {
            // Mirror the SDK's own options; only $refStrategy is left at its default.
            const sdkStyle = zodToJsonSchema(z.object(shapes[name]), { strictUnions: true, pipeStrategy: 'input' });
            expect(hasRef(sdkStyle), `${name} expected to emit $ref under SDK defaults`).toBe(true);
        }
    });

    it('inlines all $refs: every advertised tool schema is self-contained', () => {
        const shapes = allToolShapes();
        expect(shapes.length).toBeGreaterThanOrEqual(28); // 28 consolidated + 2 meta
        for (const { name, shape } of shapes) {
            const inlined = toInlinedJsonSchema(shape);
            expect(hasRef(inlined), `${name} should advertise an inlined schema with no $ref`).toBe(false);
        }
    });
});
