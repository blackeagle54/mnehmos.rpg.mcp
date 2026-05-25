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
 * Returns `null` when the schema is not object-like (extraction failure), which
 * callers can treat as an error — distinct from a legitimately empty
 * `z.object({})`, which returns `{}`. Throws on an intersection whose sides
 * define the same key, since a single flat MCP param shape cannot preserve
 * "validate with both" semantics.
 */
export function toolParamShape(schema: z.ZodTypeAny): z.ZodRawShape | null {
    return collectShape(schema, new Set());
}

function collectShape(schema: unknown, seen: Set<unknown>): z.ZodRawShape | null {
    if (!schema || typeof schema !== 'object' || seen.has(schema)) return null;
    seen.add(schema);

    const anySchema = schema as { shape?: z.ZodRawShape; _def?: Record<string, unknown> };

    // ZodObject (incl. results of .omit()/.pick()). May legitimately be empty.
    if (anySchema.shape) return { ...anySchema.shape };

    const def = anySchema._def;
    if (!def) return null;

    // ZodIntersection (.and / z.intersection): both sides contribute. A key
    // present on both can't be flattened without dropping one validator.
    if (def.left && def.right) {
        const left = collectShape(def.left, seen);
        const right = collectShape(def.right, seen);
        if (left === null || right === null) return left ?? right; // best effort if one side isn't object-like
        for (const key of Object.keys(right)) {
            if (key in left) {
                throw new Error(
                    `toolParamShape: intersection defines conflicting key "${key}"; ` +
                    `cannot flatten to a single MCP param shape.`
                );
            }
        }
        return { ...left, ...right };
    }

    // ZodEffects (refine/transform/preprocess): params are on the inner schema.
    if (def.schema) return collectShape(def.schema, seen);

    // ZodOptional/Nullable/Default/etc.: unwrap the wrapped type.
    if (def.innerType) return collectShape(def.innerType, seen);

    return null;
}
