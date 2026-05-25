import { z } from 'zod';

/**
 * Extract a ZodRawShape (the param map the MCP SDK's `server.tool` expects) from a
 * tool's input schema, regardless of how the schema was composed.
 *
 * The MCP SDK only understands a flat shape of `{ key: ZodType }`. A plain
 * `z.object()` exposes this as `.shape`, but composed schemas hide it:
 *   - `.refine()` / `.transform()` / `.default()` wrap the object in ZodEffects /
 *     wrapper types whose params live under `_def.schema` / `_def.innerType`.
 *   - `.and()` / `z.intersection()` produce a ZodIntersection with no `.shape` at
 *     all — its members are under `_def.left` / `_def.right`.
 *
 * The previous registration logic (`schema.shape || schema._def?.schema?.shape || {}`)
 * silently returned `{}` for intersections, registering the tool with no
 * parameters. This walker unwraps each case so params are never silently lost.
 */
export function toolParamShape(schema: z.ZodTypeAny): z.ZodRawShape {
    return collectShape(schema, new Set());
}

function collectShape(schema: unknown, seen: Set<unknown>): z.ZodRawShape {
    if (!schema || typeof schema !== 'object' || seen.has(schema)) return {};
    seen.add(schema);

    const anySchema = schema as { shape?: z.ZodRawShape; _def?: Record<string, unknown> };

    // ZodObject (incl. results of .omit()/.pick(), which stay ZodObjects)
    if (anySchema.shape) return { ...anySchema.shape };

    const def = anySchema._def;
    if (!def) return {};

    // ZodIntersection (.and / z.intersection): merge both members.
    if (def.left && def.right) {
        return {
            ...collectShape(def.left, seen),
            ...collectShape(def.right, seen),
        };
    }

    // ZodEffects (refine/transform/preprocess): params are on the inner schema.
    if (def.schema) return collectShape(def.schema, seen);

    // ZodOptional/Nullable/Default/etc.: unwrap the wrapped type.
    if (def.innerType) return collectShape(def.innerType, seen);

    return {};
}
