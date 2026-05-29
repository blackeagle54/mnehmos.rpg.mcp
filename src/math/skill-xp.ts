/**
 * Hard caps for the OSRS-style curve. Named constants so 99/13034431 are never
 * inlined. This module is the OWNER of these constants — `schema/skill.ts`
 * re-exports them. Owning them here keeps the dependency one-directional
 * (skill-xp imports nothing from schema/skill) so schema/skill can import
 * `levelFromXp` to enforce xp↔level consistency without a circular import.
 */
export const MAX_SKILL_LEVEL = 99;
export const MAX_SKILL_XP = 13_034_431;

/**
 * PHASE-3: OSRS-style skill XP curve (pure, deterministic).
 *
 * The canonical Jagex formula gives the cumulative XP required to REACH a level:
 *   xpForLevel(1) = 0
 *   for L >= 2:  floor( (1/4) * Σ_{n=1}^{L-1} floor( n + 300 * 2^(n/7) ) )
 *
 * The exact published golden values (L2=83, L3=174, L10=1154, L50=101333,
 * L92=6517253, L99=13034431) only reproduce under Node's Math if we keep the
 * sum-then-floor ORDER below: accumulate `points += Math.floor(...)` per inner
 * level, then `table[lvl+1] = Math.floor(points / 4)`. The table is computed
 * ONCE at module load and Object.freeze'd so no consumer can mutate it and the
 * floating-point result is locked behind golden-value tests.
 */
function buildXpTable(): readonly number[] {
    // Index 0 is unused; index L holds the total XP to reach level L.
    const table: number[] = new Array(MAX_SKILL_LEVEL + 1).fill(0);
    let points = 0;
    for (let lvl = 1; lvl < MAX_SKILL_LEVEL; lvl++) {
        points += Math.floor(lvl + 300 * Math.pow(2, lvl / 7));
        table[lvl + 1] = Math.floor(points / 4);
    }
    return Object.freeze(table);
}

const SKILL_XP_TABLE = buildXpTable();

/** Clamp a level into the valid 1..MAX_SKILL_LEVEL range. */
function clampLevel(level: number): number {
    // Non-finite (NaN/±Infinity) coerces to the safe floor (level 1) BEFORE the
    // range clamps so it never slips through and produces NaN downstream.
    const safe = Number.isFinite(level) ? level : 1;
    if (safe < 1) return 1;
    if (safe > MAX_SKILL_LEVEL) return MAX_SKILL_LEVEL;
    return Math.floor(safe);
}

/** Cumulative XP required to reach `level`. Pure; clamps out-of-range input. */
export function xpForLevel(level: number): number {
    return SKILL_XP_TABLE[clampLevel(level)];
}

/**
 * Derive the level from a total XP value. Pure, deterministic, monotonic.
 * Scans from the top so the FIRST threshold met wins. Clamps XP to 0..MAX.
 */
export function levelFromXp(totalXp: number): number {
    // Coerce non-finite XP to the safe floor (0) BEFORE range clamps so NaN/±∞
    // can never reach the comparison and yield a bogus level.
    const finiteXp = Number.isFinite(totalXp) ? totalXp : 0;
    const xp = finiteXp < 0 ? 0 : finiteXp > MAX_SKILL_XP ? MAX_SKILL_XP : finiteXp;
    for (let lvl = MAX_SKILL_LEVEL; lvl >= 1; lvl--) {
        if (xp >= SKILL_XP_TABLE[lvl]) return lvl;
    }
    return 1;
}

export interface SkillProgress {
    level: number;
    totalXp: number;
    xpIntoLevel: number;
    xpForNextLevel: number | null;
    xpToNext: number;
    atMax: boolean;
}

/** Progress data for UI bars: how far into the current level the XP sits. */
export function xpProgress(totalXp: number): SkillProgress {
    // Coerce non-finite XP to the safe floor (0) up front so no field (totalXp,
    // xpIntoLevel, xpToNext) can ever come out NaN.
    const finiteXp = Number.isFinite(totalXp) ? totalXp : 0;
    const xp = finiteXp < 0 ? 0 : finiteXp > MAX_SKILL_XP ? MAX_SKILL_XP : finiteXp;
    const level = levelFromXp(xp);
    const atMax = level >= MAX_SKILL_LEVEL;
    const xpForNextLevel = atMax ? null : xpForLevel(level + 1);
    return {
        level,
        totalXp: xp,
        xpIntoLevel: xp - xpForLevel(level),
        xpForNextLevel,
        xpToNext: atMax ? 0 : (xpForNextLevel as number) - xp,
        atMax,
    };
}
