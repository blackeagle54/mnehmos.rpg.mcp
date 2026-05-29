import { z } from 'zod';
import { MAX_SKILL_LEVEL, MAX_SKILL_XP, levelFromXp } from '../math/skill-xp.js';

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

/**
 * Hard caps for the OSRS-style curve. The OWNER of these constants is
 * `src/math/skill-xp.ts`; we re-export them here so existing importers of
 * `MAX_SKILL_LEVEL`/`MAX_SKILL_XP` from this module keep working. Owning them
 * in skill-xp breaks the import cycle (skill-xp ← schema/skill becomes
 * one-directional), which lets this schema import `levelFromXp` for the
 * consistency refine below.
 */
export { MAX_SKILL_LEVEL, MAX_SKILL_XP } from '../math/skill-xp.js';

/**
 * A single skill's stored {xp, level} pair.
 *
 * `.superRefine` enforces that the stored `level` is exactly the level derived
 * from `xp` via the curve, so contradictory pairs (e.g. {xp:0, level:50}) are
 * rejected at parse time. superRefine (not refine) keeps the result a
 * ZodObject so `.default(...)` chaining and `SkillsSchema` composition below
 * stay type-compatible (no ZodEffects-wrapping surprises for SkillsSchema's
 * per-key defaults). levelFromXp(0)===1, so the {xp:0, level:1} defaults pass.
 */
export const SkillEntrySchema = z.object({
    xp: z.number().int().min(0).max(MAX_SKILL_XP).default(0),
    level: z.number().int().min(1).max(MAX_SKILL_LEVEL).default(1),
}).superRefine((data, ctx) => {
    const expected = levelFromXp(data.xp);
    if (data.level !== expected) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['level'],
            message: `level ${data.level} is inconsistent with xp ${data.xp} (expected level ${expected})`,
        });
    }
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
