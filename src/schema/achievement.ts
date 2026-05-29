import { z } from 'zod';

/**
 * PHASE-3: Achievement system.
 *
 * Two halves, mirroring the quest split (global catalog table + per-character
 * progress on the character row):
 *
 *  1. AchievementDefinitionSchema — a GLOBAL catalog entry (the achievements
 *     table). Definitions are world-agnostic trophies/milestones any character
 *     can earn.
 *  2. CharacterAchievementsSchema — a per-character map of unlock/progress
 *     state stored as a JSON column on the character row, keyed by
 *     achievementId. This is intentionally a z.record (sparse): a character only
 *     has entries for achievements they have touched. Legacy rows have no column
 *     and default-on-read to {} at the tool layer.
 */

/**
 * A single catalog definition. `target` is nullable/optional: NULL = a
 * non-incremental (binary unlock) achievement; a number = the threshold a
 * character's progress must reach to auto-unlock. `hidden` achievements are
 * omitted from list/get for characters who have not yet unlocked them.
 */
export const AchievementDefinitionSchema = z.object({
    id: z.string().describe('Stable achievement identifier'),
    name: z.string().describe('Display name'),
    description: z.string().describe('What the achievement is for'),
    category: z.string().describe('Grouping bucket (e.g. combat, exploration)'),
    points: z.number().int().min(0).default(0).describe('Score awarded on unlock'),
    criteria: z.string().optional().describe('Human-readable unlock condition'),
    hidden: z.boolean().default(false).describe('Hide from catalog until unlocked'),
    target: z.number().int().min(1).optional()
        .describe('Progress threshold for incremental achievements (undefined = binary)'),
});
export type AchievementDefinition = z.infer<typeof AchievementDefinitionSchema>;

/**
 * Per-character state for ONE achievement. `unlockedAt` is set the moment it is
 * earned (and never overwritten on a repeat unlock — see the unlock handler's
 * idempotency). `progress` tracks incremental advancement toward `target`.
 */
export const AchievementUnlockSchema = z.object({
    unlockedAt: z.string().optional(),
    progress: z.number().int().min(0).optional(),
});
export type AchievementUnlock = z.infer<typeof AchievementUnlockSchema>;

/**
 * The per-character map persisted as the character's `achievements` JSON column,
 * keyed by achievementId. Sparse by design (z.record): only touched
 * achievements appear.
 */
export const CharacterAchievementsSchema = z.record(AchievementUnlockSchema);
export type CharacterAchievements = z.infer<typeof CharacterAchievementsSchema>;
