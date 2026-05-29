import { z } from 'zod';

/**
 * PHASE-3: Factions & Reputation system.
 *
 * Two halves, mirroring the achievement split (global catalog table +
 * per-character state on the character row):
 *
 *  1. FactionDefinitionSchema — a GLOBAL catalog entry (the factions table).
 *     Definitions are world-agnostic organizations any character can build
 *     standing with.
 *  2. CharacterReputationSchema — a per-character map of reputation VALUES
 *     stored as a JSON column on the character row, keyed by factionId. This is
 *     intentionally a z.record (sparse): a character only has entries for
 *     factions they have interacted with. Legacy rows have no column and
 *     default-on-read to {} at the tool layer (a missing entry == value 0 /
 *     "Neutral").
 *
 * The STANDING (Exalted/Revered/.../Hated) is DERIVED from the value at read
 * time via standingFromValue() — never stored. The value is the single source
 * of truth; a parallel UI mirrors the exact tier table below.
 */

// ═══════════════════════════════════════════════════════════════════════════
// STANDING TIERS (FROZEN — a parallel UI mirrors this table)
// ═══════════════════════════════════════════════════════════════════════════

/** Reputation value is an integer clamped to [REPUTATION_MIN, REPUTATION_MAX]. */
export const REPUTATION_MIN = -1000;
export const REPUTATION_MAX = 1000;

/**
 * Ordered tiers, highest threshold first. standingFromValue() returns the label
 * of the FIRST tier whose `min` the value meets, so the order here is
 * load-bearing. Frozen so no consumer can mutate the canonical table.
 */
export const REPUTATION_TIERS = Object.freeze([
    { min: 1000, standing: 'Exalted' },
    { min: 600, standing: 'Revered' },
    { min: 300, standing: 'Honored' },
    { min: 100, standing: 'Friendly' },
    { min: 0, standing: 'Neutral' },
    { min: -100, standing: 'Unfriendly' },
    { min: -500, standing: 'Hostile' },
    { min: -Infinity, standing: 'Hated' },
] as const);

export type ReputationStanding =
    typeof REPUTATION_TIERS[number]['standing'];

/**
 * Derive the standing label from a reputation value. Pure, deterministic.
 * Highest matching tier wins (scan in declared order). A value outside the
 * clamp range still resolves (>= 1000 → Exalted, anything below -500 → Hated),
 * so callers may pass a raw value safely; the tool layer clamps on write.
 */
export function standingFromValue(value: number): ReputationStanding {
    // Coerce non-finite input to the safe floor (0 / Neutral) so NaN/-∞ never
    // slips through to a bogus tier.
    const safe = Number.isFinite(value) ? value : 0;
    for (const tier of REPUTATION_TIERS) {
        if (safe >= tier.min) return tier.standing;
    }
    // Unreachable (the final tier's min is -Infinity), but keeps the return total.
    return 'Hated';
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single faction catalog definition (the factions table). `description` is
 * optional/nullable (NULL in the DB maps back to undefined).
 */
export const FactionDefinitionSchema = z.object({
    id: z.string().describe('Stable faction identifier'),
    name: z.string().describe('Display name'),
    description: z.string().optional().describe('What the faction is'),
});
export type FactionDefinition = z.infer<typeof FactionDefinitionSchema>;

/**
 * Per-character reputation entry for ONE faction. Only the integer value is
 * stored; standing is derived at read time. (A z.object — not a bare number —
 * leaves room for future per-faction metadata without a column change.)
 */
export const ReputationEntrySchema = z.object({
    value: z.number().int(),
});
export type ReputationEntry = z.infer<typeof ReputationEntrySchema>;

/**
 * The per-character map persisted as the character's `reputation` JSON column,
 * keyed by factionId. Sparse by design (z.record): only touched factions
 * appear. A missing key == value 0 / "Neutral".
 */
export const CharacterReputationSchema = z.record(ReputationEntrySchema);
export type CharacterReputation = z.infer<typeof CharacterReputationSchema>;
