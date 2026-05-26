import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Convert a tool's parameter shape to JSON Schema with every internal `$ref`
 * INLINED, so the advertised `tools/list` schema is fully self-contained.
 *
 * Why this exists (#73): the MCP SDK converts each tool's Zod schema with
 * zod-to-json-schema's DEFAULT `$refStrategy` ('root'), which emits
 * `{ "$ref": "#/properties/..." }` whenever the SAME Zod instance (typically a
 * shared enum constant reused across fields — e.g. a `status` enum used at both
 * `status` and `statusFilter: z.array(status)`) appears more than once in a
 * tool's schema. That is valid JSON Schema, but several MCP clients/bridges
 * (OpenAI + Open WebUI via `mcpo`) cannot resolve internal `$ref`s, which makes
 * the affected tools unusable through them.
 *
 * `$refStrategy: 'none'` fully inlines every occurrence instead of de-duplicating
 * by reference, producing schemas with no internal `$ref`. `strictUnions` and
 * `pipeStrategy` mirror the SDK's own conversion options (see the SDK's
 * `toJsonSchemaCompat`) so the ONLY behavioural difference from the SDK default
 * is ref handling. This keeps our Zod enum constants DRY — the fix lives at
 * serialization time, not by denormalizing the domain schemas.
 */
export function toInlinedJsonSchema(shape: z.ZodRawShape): ReturnType<typeof zodToJsonSchema> {
    return zodToJsonSchema(z.object(shape), {
        $refStrategy: 'none',
        strictUnions: true,
        pipeStrategy: 'input',
    });
}
