/**
 * Tests for the consolidated skill_manage tool (Phase 3 PR-1).
 * Actions: get_skills, grant_xp, set_level, check_requirement.
 *
 * Core invariants:
 *  - get_skills defaults legacy (skill-less) characters to the all-{xp:0,level:1} map.
 *  - grant_xp recomputes level FROM the curve (never trusts a client level) and
 *    persists both xp and the derived level.
 *  - grant_xp is ORTHOGONAL to D&D progression: it never mutates character.xp/level.
 *  - set_level (admin/seed) sets xp = xpForLevel(level) so xp/level stay consistent.
 */

import { handleSkillManage, SkillManageTool } from '../../../src/server/consolidated/skill-manage.js';
import { getDb, closeDb } from '../../../src/storage/index.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { xpForLevel } from '../../../src/math/skill-xp.js';
import { randomUUID } from 'crypto';

process.env.NODE_ENV = 'test';

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
    const text = result.content[0].text;
    const jsonMatch = text.match(/<!-- SKILL_MANAGE_JSON\n([\s\S]*?)\nSKILL_MANAGE_JSON -->/);
    if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
    }
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
        // not JSON
    }
    return { error: 'parse_failed', rawText: text };
}

describe('skill_manage consolidated tool', () => {
    let testCharacterId: string;
    let testWorldId: string;
    const ctx = { sessionId: 'test-session' };

    beforeEach(() => {
        closeDb();
        const db = getDb(':memory:');
        const now = new Date().toISOString();

        const worldRepo = new WorldRepository(db);
        testWorldId = randomUUID();
        worldRepo.create({
            id: testWorldId,
            name: 'Test World',
            seed: '12345',
            width: 100,
            height: 100,
            tileData: '{}',
            createdAt: now,
            updatedAt: now,
        });

        const characterRepo = new CharacterRepository(db);
        testCharacterId = randomUUID();
        // Note: no `skills` field — this is a legacy/fresh character.
        characterRepo.create({
            id: testCharacterId,
            name: 'Test Hero',
            stats: { str: 16, dex: 14, con: 15, int: 10, wis: 12, cha: 8 },
            hp: 45,
            maxHp: 45,
            ac: 18,
            level: 5,
            xp: 6500,
            characterType: 'pc',
            createdAt: now,
            updatedAt: now,
        });
    });

    describe('Tool Definition', () => {
        it('has the correct tool name', () => {
            expect(SkillManageTool.name).toBe('skill_manage');
        });

        it('declares the character category', () => {
            expect(SkillManageTool.category).toBe('character');
        });

        it('lists every action in its description', () => {
            for (const action of ['get_skills', 'grant_xp', 'set_level', 'check_requirement']) {
                expect(SkillManageTool.description).toContain(action);
            }
        });
    });

    describe('get_skills', () => {
        it('defaults all five skills to {xp:0, level:1} for a fresh character', async () => {
            const result = await handleSkillManage({
                action: 'get_skills',
                characterId: testCharacterId,
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('get_skills');
            for (const skill of ['combat', 'magic', 'crafting', 'gathering', 'social']) {
                expect(data.skills[skill]).toEqual({ xp: 0, level: 1 });
            }
        });

        it('returns an error for a missing character', async () => {
            const result = await handleSkillManage({
                action: 'get_skills',
                characterId: 'does-not-exist',
            }, ctx);
            expect(parseResult(result).error).toBe(true);
        });
    });

    describe('grant_xp', () => {
        it('recomputes the derived level from the curve and persists both', async () => {
            const result = await handleSkillManage({
                action: 'grant_xp',
                characterId: testCharacterId,
                skill: 'combat',
                amount: 83, // exactly the level-2 threshold
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('grant_xp');
            expect(data.skill).toBe('combat');
            expect(data.oldXp).toBe(0);
            expect(data.newXp).toBe(83);
            expect(data.oldLevel).toBe(1);
            expect(data.newLevel).toBe(2);
            expect(data.leveledUp).toBe(true);
            expect(data.xpProgress.level).toBe(2);

            // Persisted: a subsequent get_skills reflects the new state.
            const after = parseResult(await handleSkillManage({
                action: 'get_skills',
                characterId: testCharacterId,
            }, ctx));
            expect(after.skills.combat).toEqual({ xp: 83, level: 2 });
        });

        it('leveledUp flips exactly at the level-2 boundary (82 false, 83 true)', async () => {
            const below = parseResult(await handleSkillManage({
                action: 'grant_xp',
                characterId: testCharacterId,
                skill: 'combat',
                amount: 82,
            }, ctx));
            expect(below.newLevel).toBe(1);
            expect(below.leveledUp).toBe(false);

            // grant one more to cross the boundary
            const at = parseResult(await handleSkillManage({
                action: 'grant_xp',
                characterId: testCharacterId,
                skill: 'combat',
                amount: 1,
            }, ctx));
            expect(at.newXp).toBe(83);
            expect(at.newLevel).toBe(2);
            expect(at.leveledUp).toBe(true);
        });

        it('NEVER mutates the D&D character.xp/level (orthogonality)', async () => {
            const repo = new CharacterRepository(getDb(':memory:'));
            const before = repo.findById(testCharacterId)!;

            await handleSkillManage({
                action: 'grant_xp',
                characterId: testCharacterId,
                skill: 'magic',
                amount: 50000,
            }, ctx);

            const after = repo.findById(testCharacterId)!;
            expect(after.xp).toBe(before.xp);
            expect(after.level).toBe(before.level);
        });

        it('clamps at MAX_SKILL_XP / level 99', async () => {
            const data = parseResult(await handleSkillManage({
                action: 'grant_xp',
                characterId: testCharacterId,
                skill: 'gathering',
                amount: 999999999,
            }, ctx));
            expect(data.newLevel).toBe(99);
            expect(data.newXp).toBe(13034431);
            expect(data.xpProgress.atMax).toBe(true);
        });
    });

    describe('set_level', () => {
        it('sets xp to exactly xpForLevel(level)', async () => {
            const data = parseResult(await handleSkillManage({
                action: 'set_level',
                characterId: testCharacterId,
                skill: 'crafting',
                level: 50,
            }, ctx));
            expect(data.actionType).toBe('set_level');
            expect(data.level).toBe(50);
            expect(data.xp).toBe(xpForLevel(50));

            const after = parseResult(await handleSkillManage({
                action: 'get_skills',
                characterId: testCharacterId,
            }, ctx));
            expect(after.skills.crafting).toEqual({ xp: xpForLevel(50), level: 50 });
        });
    });

    describe('check_requirement', () => {
        it('reports met=false below the threshold with the shortfall', async () => {
            const data = parseResult(await handleSkillManage({
                action: 'check_requirement',
                characterId: testCharacterId,
                skill: 'social',
                level: 10,
            }, ctx));
            expect(data.actionType).toBe('check_requirement');
            expect(data.met).toBe(false);
            expect(data.currentLevel).toBe(1);
            expect(data.requiredLevel).toBe(10);
            expect(data.shortfall).toBe(9);
        });

        it('reports met=true at/above the threshold', async () => {
            await handleSkillManage({
                action: 'set_level',
                characterId: testCharacterId,
                skill: 'social',
                level: 10,
            }, ctx);

            const at = parseResult(await handleSkillManage({
                action: 'check_requirement',
                characterId: testCharacterId,
                skill: 'social',
                level: 10,
            }, ctx));
            expect(at.met).toBe(true);
            expect(at.shortfall).toBe(0);
        });

        it('is a pure read — does not change stored skills', async () => {
            const before = parseResult(await handleSkillManage({
                action: 'get_skills',
                characterId: testCharacterId,
            }, ctx));
            await handleSkillManage({
                action: 'check_requirement',
                characterId: testCharacterId,
                skill: 'combat',
                level: 50,
            }, ctx);
            const after = parseResult(await handleSkillManage({
                action: 'get_skills',
                characterId: testCharacterId,
            }, ctx));
            expect(after.skills).toEqual(before.skills);
        });
    });

    describe('output formatting', () => {
        it('embeds a parseable SKILL_MANAGE_JSON marker', async () => {
            const result = await handleSkillManage({
                action: 'get_skills',
                characterId: testCharacterId,
            }, ctx);
            const text = result.content[0].text;
            expect(text).toContain('<!-- SKILL_MANAGE_JSON');
            // and it parses back to the same structured payload
            expect(parseResult(result).actionType).toBe('get_skills');
        });
    });
});
