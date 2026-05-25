/**
 * Tool param-shape extraction (#24)
 *
 * server/index.ts registers each consolidated tool with the MCP SDK by passing a
 * ZodRawShape (the param map). The old logic extracted `extendedSchema.shape ||
 * extendedSchema._def?.schema?.shape || {}`, which silently fell back to `{}` for
 * intersection-wrapped schemas — so a tool whose inputSchema is a refined
 * (ZodEffects) object would be registered with NO parameters. These tests pin a
 * robust, fail-loud extraction.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toolParamShape } from '../../src/server/tool-shape.js';
import { buildConsolidatedRegistry } from '../../src/server/consolidated-registry.js';

describe('toolParamShape (#24)', () => {
    it('extracts the shape of a plain ZodObject', () => {
        const shape = toolParamShape(z.object({ action: z.string(), x: z.number() }));
        expect(Object.keys(shape).sort()).toEqual(['action', 'x']);
    });

    it('extracts the shape from a refined (ZodEffects) schema — the path that fell back to {}', () => {
        // A refined object lacks `.extend`, so index.ts wrapped it in an intersection
        // whose `.shape` is undefined → params were lost.
        const refined = z.object({ action: z.string(), target: z.string() }).refine(() => true);
        expect(Object.keys(toolParamShape(refined)).sort()).toEqual(['action', 'target']);
    });

    it('merges both sides of an intersection (.and / z.intersection)', () => {
        const inter = z.object({ a: z.string() }).and(z.object({ b: z.string() }));
        expect(Object.keys(toolParamShape(inter)).sort()).toEqual(['a', 'b']);
    });

    it('returns an empty shape for a non-object schema (so callers can detect it)', () => {
        expect(Object.keys(toolParamShape(z.string()))).toHaveLength(0);
    });

    it('every consolidated tool exposes a non-empty parameter shape', () => {
        const registry = buildConsolidatedRegistry();
        const names = Object.keys(registry);
        expect(names.length).toBeGreaterThan(0);
        for (const [name, entry] of Object.entries(registry)) {
            const shape = toolParamShape(entry.schema as z.ZodTypeAny);
            expect(Object.keys(shape).length, `tool "${name}" exposed no parameters`).toBeGreaterThan(0);
        }
    });
});
