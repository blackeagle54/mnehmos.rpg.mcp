/**
 * Tool param-shape extraction (#24)
 *
 * server/index.ts registers each consolidated tool with the MCP SDK by passing a
 * ZodRawShape (the param map). The old logic extracted `extendedSchema.shape ||
 * extendedSchema._def?.schema?.shape || {}`, which silently fell back to `{}` for
 * intersection-wrapped schemas — so a tool whose inputSchema is a refined
 * (ZodEffects) object would be registered with NO parameters. These tests pin a
 * robust extraction that distinguishes "no shape" (null) from an empty object.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toolParamShape } from '../../src/server/tool-shape.js';
import { buildConsolidatedRegistry } from '../../src/server/consolidated-registry.js';
import { handleLoadToolSchema } from '../../src/server/meta-tools.js';

describe('toolParamShape (#24)', () => {
    it('extracts the shape of a plain ZodObject', () => {
        const shape = toolParamShape(z.object({ action: z.string(), x: z.number() }));
        expect(Object.keys(shape!).sort()).toEqual(['action', 'x']);
    });

    it('extracts the shape from a refined (ZodEffects) schema — the path that fell back to {}', () => {
        // A refined object lacks `.extend`, so index.ts wrapped it in an intersection
        // whose `.shape` is undefined → params were lost.
        const refined = z.object({ action: z.string(), target: z.string() }).refine(() => true);
        expect(Object.keys(toolParamShape(refined)!).sort()).toEqual(['action', 'target']);
    });

    it('merges both sides of an intersection (.and / z.intersection)', () => {
        const inter = z.object({ a: z.string() }).and(z.object({ b: z.string() }));
        expect(Object.keys(toolParamShape(inter)!).sort()).toEqual(['a', 'b']);
    });

    it('returns null for a non-object schema — distinct from an empty object', () => {
        expect(toolParamShape(z.string())).toBeNull();
    });

    it('returns {} for a legitimately empty z.object({}), not a failure signal', () => {
        expect(toolParamShape(z.object({}))).toEqual({});
    });

    it('throws on an intersection with conflicting keys (unrepresentable as a flat shape)', () => {
        const conflicting = z.object({ a: z.string() }).and(z.object({ a: z.number() }));
        expect(() => toolParamShape(conflicting)).toThrow(/conflicting key/i);
    });

    it('returns null for a mixed object/non-object intersection (advertised contract must match validation)', () => {
        // collectShape can extract { a } from the object side, but the real schema
        // also requires the string side — advertising { a } would diverge from
        // runtime validation, so extraction must fail.
        const mixed = z.intersection(z.object({ a: z.string() }), z.string());
        expect(toolParamShape(mixed)).toBeNull();
    });

    it('every consolidated tool exposes a non-empty parameter shape', () => {
        const registry = buildConsolidatedRegistry();
        const names = Object.keys(registry);
        expect(names.length).toBeGreaterThan(0);
        for (const [name, entry] of Object.entries(registry)) {
            const shape = toolParamShape(entry.schema as z.ZodTypeAny);
            expect(shape, `tool "${name}" produced no shape`).not.toBeNull();
            expect(Object.keys(shape!).length, `tool "${name}" exposed no parameters`).toBeGreaterThan(0);
        }
    });

    it('load_tool_schema exposes the same params as registration — no contract drift (#24)', async () => {
        // Discovery (load_tool_schema) and runtime registration must extract the
        // schema identically; both now route through toolParamShape.
        const registry = buildConsolidatedRegistry();
        const toolName = 'spatial_manage';
        const regShape = toolParamShape(registry[toolName].schema as z.ZodTypeAny);
        expect(regShape).not.toBeNull();
        const expectedKeys = [...Object.keys(regShape!), 'sessionId'].sort();

        const result = await handleLoadToolSchema({ toolName } as Parameters<typeof handleLoadToolSchema>[0]);
        expect('inputSchema' in result).toBe(true);
        const loadedKeys = Object.keys((result as { inputSchema: Record<string, unknown> }).inputSchema).sort();

        expect(loadedKeys.length).toBeGreaterThan(1); // not just sessionId / not {}
        expect(loadedKeys).toContain('action');
        expect(loadedKeys).toEqual(expectedKeys);
    });
});
