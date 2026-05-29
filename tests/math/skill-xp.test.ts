/**
 * Golden-value tests for the OSRS-style skill XP curve (Phase 3 PR-1).
 *
 * The curve uses the canonical Jagex formula, frozen into a table at module
 * load. These golden values are the EXACT published OSRS XP-to-level totals, so
 * any floating-point drift in Math.pow(2, n/7) or a change in the sum-then-floor
 * order would be caught here.
 */

import {
    xpForLevel,
    levelFromXp,
    xpProgress,
} from '../../src/math/skill-xp.js';
import { MAX_SKILL_LEVEL, MAX_SKILL_XP } from '../../src/schema/skill.js';

describe('skill-xp curve', () => {
    describe('xpForLevel — canonical OSRS golden values', () => {
        it('matches the published table exactly', () => {
            expect(xpForLevel(1)).toBe(0);
            expect(xpForLevel(2)).toBe(83);
            expect(xpForLevel(3)).toBe(174);
            expect(xpForLevel(10)).toBe(1154);
            expect(xpForLevel(50)).toBe(101333);
            expect(xpForLevel(92)).toBe(6517253);
            expect(xpForLevel(99)).toBe(13034431);
        });

        it('the level-99 total equals MAX_SKILL_XP', () => {
            expect(xpForLevel(MAX_SKILL_LEVEL)).toBe(MAX_SKILL_XP);
            expect(MAX_SKILL_XP).toBe(13034431);
        });

        it('is monotonically increasing across the whole table', () => {
            for (let lvl = 2; lvl <= MAX_SKILL_LEVEL; lvl++) {
                expect(xpForLevel(lvl)).toBeGreaterThan(xpForLevel(lvl - 1));
            }
        });

        it('clamps out-of-range levels', () => {
            expect(xpForLevel(0)).toBe(0);
            expect(xpForLevel(-5)).toBe(0);
            expect(xpForLevel(200)).toBe(xpForLevel(MAX_SKILL_LEVEL));
        });

        it('coerces a non-finite level to the safe floor (level 1 → 0 XP)', () => {
            expect(xpForLevel(NaN)).toBe(0);
            expect(xpForLevel(Infinity)).toBe(0);
            expect(xpForLevel(-Infinity)).toBe(0);
        });
    });

    describe('levelFromXp — round-trip and boundaries', () => {
        it('round-trips levelFromXp(xpForLevel(L)) === L for all 1..99', () => {
            for (let lvl = 1; lvl <= MAX_SKILL_LEVEL; lvl++) {
                expect(levelFromXp(xpForLevel(lvl))).toBe(lvl);
            }
        });

        it('one XP below a threshold is the previous level for 2..99', () => {
            for (let lvl = 2; lvl <= MAX_SKILL_LEVEL; lvl++) {
                expect(levelFromXp(xpForLevel(lvl) - 1)).toBe(lvl - 1);
            }
        });

        it('clamps XP below 0 to level 1', () => {
            expect(levelFromXp(-5)).toBe(1);
            expect(levelFromXp(0)).toBe(1);
        });

        it('clamps XP above MAX to level 99', () => {
            expect(levelFromXp(99999999)).toBe(MAX_SKILL_LEVEL);
            expect(levelFromXp(MAX_SKILL_XP)).toBe(MAX_SKILL_LEVEL);
        });

        it('coerces non-finite XP to the safe floor (level 1)', () => {
            // Non-finite is coerced to 0 BEFORE the range clamps, so all three
            // resolve to level 1 (no NaN, no spurious level 99 from +Infinity).
            expect(levelFromXp(NaN)).toBe(1);
            expect(levelFromXp(Infinity)).toBe(1);
            expect(levelFromXp(-Infinity)).toBe(1);
        });
    });

    describe('xpProgress — UI bar data', () => {
        it('reports a fresh skill at level 1', () => {
            const p = xpProgress(0);
            expect(p.level).toBe(1);
            expect(p.totalXp).toBe(0);
            expect(p.xpIntoLevel).toBe(0);
            expect(p.xpForNextLevel).toBe(xpForLevel(2));
            expect(p.xpToNext).toBe(xpForLevel(2));
            expect(p.atMax).toBe(false);
        });

        it('reports atMax with no remaining XP at the cap', () => {
            const p = xpProgress(MAX_SKILL_XP);
            expect(p.level).toBe(MAX_SKILL_LEVEL);
            expect(p.atMax).toBe(true);
            expect(p.xpToNext).toBe(0);
            expect(p.xpForNextLevel).toBeNull();
        });

        it('reports partial progress within a level', () => {
            const base = xpForLevel(10);
            const next = xpForLevel(11);
            const p = xpProgress(base + 50);
            expect(p.level).toBe(10);
            expect(p.xpIntoLevel).toBe(50);
            expect(p.xpForNextLevel).toBe(next);
            expect(p.xpToNext).toBe(next - (base + 50));
            expect(p.atMax).toBe(false);
        });

        it('coerces non-finite XP to level 1 with all-finite fields (no NaN)', () => {
            const p = xpProgress(NaN);
            expect(p.level).toBe(1);
            expect(p.totalXp).toBe(0);
            expect(p.xpIntoLevel).toBe(0);
            expect(p.xpForNextLevel).toBe(xpForLevel(2));
            expect(p.xpToNext).toBe(xpForLevel(2));
            expect(p.atMax).toBe(false);
            // Every numeric field is finite — the regression the guard prevents.
            expect(Number.isFinite(p.totalXp)).toBe(true);
            expect(Number.isFinite(p.xpIntoLevel)).toBe(true);
            expect(Number.isFinite(p.xpToNext)).toBe(true);
            expect(Number.isFinite(p.xpForNextLevel as number)).toBe(true);
        });
    });
});
