import { z } from 'zod';

/**
 * PHASE-3: OSRS-style progression skills.
 *
 * This axis is intentionally ORTHOGONAL to the D&D character level/xp on
 * CharacterSchema. The five named skills here track per-skill grind XP on a
 * deep level-1..99 curve (see src/math/skill-xp.ts), while character.level/xp
 * remain the D&D 1..20 progression. The two systems never write to each other.
 *
 * SKILL_NAMES is the SINGLE SOURCE OF TRUTH for the skill list — the tool
 * schema, quest gating, the store parser, and the UI all import it rather than
 * re-listing the five names (avoids drift / missing-key bugs).
 */
export const SKILL_NAMES = ['combat', 'magic', 'crafting', 'gathering', 'social'] as const;
export const SkillNameSchema = z.enum(SKILL_NAMES);
export type SkillName = z.infer<typeof SkillNameSchema>;

/** Hard caps for the OSRS-style curve. Named constants so 99/13034431 are never inlined. */
export const MAX_SKILL_LEVEL = 99;
export const MAX_SKILL_XP = 13_034_431;

export const SkillEntrySchema = z.object({
    xp: z.number().int().min(0).max(MAX_SKILL_XP).default(0),
    level: z.number().int().min(1).max(MAX_SKILL_LEVEL).default(1),
});
export type SkillEntry = z.infer<typeof SkillEntrySchema>;

/**
 * Fixed object map (NOT z.record) — deliberately mirrors the explicit `stats`
 * object on CharacterSchema. A fixed shape guarantees every one of the five
 * skill keys always resolves (with a {xp:0, level:1} default), so the UI and
 * quest-gating never hit an undefined skill entry. Do NOT "simplify" this into
 * z.record(SkillNameSchema, ...): a record makes every key optional and
 * reintroduces missing-key bugs.
 */
export const SkillsSchema = z.object({
    combat: SkillEntrySchema.default({ xp: 0, level: 1 }),
    magic: SkillEntrySchema.default({ xp: 0, level: 1 }),
    crafting: SkillEntrySchema.default({ xp: 0, level: 1 }),
    gathering: SkillEntrySchema.default({ xp: 0, level: 1 }),
    social: SkillEntrySchema.default({ xp: 0, level: 1 }),
}).default({});
export type Skills = z.infer<typeof SkillsSchema>;
