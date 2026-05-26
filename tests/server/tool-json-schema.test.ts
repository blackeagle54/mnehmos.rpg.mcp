/**
 * #73: advertised tool schemas (tools/list) must be fully self-contained — no
 * internal $ref — because some MCP clients/bridges (OpenAI + Open WebUI via
 * mcpo) can't resolve them.
 *
 * The discovery payload is built by buildAdvertisedTools(): the SINGLE source of
 * truth the ListTools override returns. It MUST cover every registered tool
 * category (meta + event + consolidated) — otherwise a tool silently vanishes
 * from discovery while staying callable (the regression CodeRabbit caught when
 * the override first shipped with a partial list).
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { buildAdvertisedTools } from '../../src/server/advertised-tools.js';
import { buildConsolidatedRegistry } from '../../src/server/consolidated-registry.js';
import { toolParamShape } from '../../src/server/tool-shape.js';

process.env.NODE_ENV = 'test';

function hasRef(schema: unknown): boolean {
    return JSON.stringify(schema).includes('"$ref"');
}

describe('advertised tool JSON Schema $ref inlining (#73)', () => {
    it('documents the bug: SDK-default conversion emits $ref for the reused-enum tools', () => {
        const registry = buildConsolidatedRegistry();
        // These four reuse a shared enum instance within one tool schema, so the
        // SDK's default ($refStrategy: 'root') de-duplicates by reference → $ref.
        for (const name of ['narrative_manage', 'character_manage', 'party_manage', 'spatial_manage']) {
            const base = toolParamShape((registry[name] as { schema: z.ZodTypeAny }).schema);
            if (!base) throw new Error(`toolParamShape returned null for ${name}`);
            const shape = { ...base, sessionId: z.string().optional() };
            // Mirror the SDK's options; only $refStrategy is left at its default.
            const sdkStyle = zodToJsonSchema(z.object(shape), { strictUnions: true, pipeStrategy: 'input' });
            expect(hasRef(sdkStyle), `${name} expected to emit $ref under SDK defaults`).toBe(true);
        }
    });

    it('advertises every tool with a fully self-contained schema (no $ref)', () => {
        const advertised = buildAdvertisedTools();
        // Completeness: 28 consolidated + 2 meta + 2 event.
        const consolidatedCount = Object.keys(buildConsolidatedRegistry()).length;
        expect(advertised.length).toBe(consolidatedCount + 4);
        for (const t of advertised) {
            expect(hasRef(t.inputSchema), `${t.name} should advertise an inlined schema with no $ref`).toBe(false);
        }
    });

    it('advertises ALL registered categories incl. event tools (override regression guard)', () => {
        const names = buildAdvertisedTools().map(t => t.name);
        // Event tools were dropped when the override first replaced the SDK's
        // auto-handler with a partial list — guard against that recurring (#73).
        expect(names).toContain('subscribe_to_events');
        expect(names).toContain('unsubscribe_from_events');
        // ...alongside meta + a representative consolidated tool.
        expect(names).toContain('search_tools');
        expect(names).toContain('load_tool_schema');
        expect(names).toContain('narrative_manage');
    });
});
