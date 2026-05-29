/**
 * Tests for the consolidated achievement_manage tool (Phase 3).
 * Actions: define, list, unlock, progress, get, revoke.
 *
 * Data model under test:
 *  - achievements catalog table (global definitions) via AchievementRepository.
 *  - per-character unlock/progress JSON column on the character row.
 *
 * Core invariants:
 *  - define upserts (create + update-existing share an id).
 *  - list omits hidden && !unlocked definitions; annotates per-character state.
 *  - unlock is idempotent (alreadyUnlocked keeps the original unlockedAt).
 *  - progress increments toward target, auto-unlocks at target, clamps at target,
 *    and errors for non-incremental achievements.
 *  - get sums points / counts from per-character unlock state.
 *  - revoke removes an entry (revoked:false when nothing to remove).
 *  - legacy characters with no achievements column behave as empty {}.
 */

import { handleAchievementManage, AchievementManageTool } from '../../../src/server/consolidated/achievement-manage.js';
import { getDb, closeDb } from '../../../src/storage/index.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { randomUUID } from 'crypto';

process.env.NODE_ENV = 'test';

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
    const text = result.content[0].text;
    const jsonMatch = text.match(/<!-- ACHIEVEMENT_MANAGE_JSON\n([\s\S]*?)\nACHIEVEMENT_MANAGE_JSON -->/);
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

const ctx = { sessionId: 'test-session' };

function makeCharacter(repo: CharacterRepository): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    // Note: no `achievements` field — this is a legacy/fresh character.
    repo.create({
        id,
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
    return id;
}

async function define(args: Record<string, unknown>) {
    return parseResult(await handleAchievementManage({ action: 'define', ...args }, ctx));
}

describe('achievement_manage consolidated tool', () => {
    let charId: string;

    beforeEach(() => {
        closeDb();
        const db = getDb(':memory:');
        charId = makeCharacter(new CharacterRepository(db));
    });

    describe('Tool Definition', () => {
        it('has the correct tool name', () => {
            expect(AchievementManageTool.name).toBe('achievement_manage');
        });

        it('declares the character category', () => {
            expect(AchievementManageTool.category).toBe('character');
        });

        it('lists every action in its description', () => {
            for (const action of ['define', 'list', 'unlock', 'progress', 'get', 'revoke']) {
                expect(AchievementManageTool.description).toContain(action);
            }
        });
    });

    describe('define', () => {
        it('creates a new definition with defaults (points 0, hidden false)', async () => {
            const data = await define({
                achievementId: 'first_blood',
                name: 'First Blood',
                description: 'Defeat your first enemy.',
                category: 'combat',
            });
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('define');
            expect(data.achievement.id).toBe('first_blood');
            expect(data.achievement.name).toBe('First Blood');
            expect(data.achievement.points).toBe(0);
            expect(data.achievement.hidden).toBe(false);
            expect(data.achievement.target).toBeUndefined();
        });

        it('updates an existing definition (upsert on the same id)', async () => {
            await define({
                achievementId: 'first_blood',
                name: 'First Blood',
                description: 'Defeat your first enemy.',
                category: 'combat',
                points: 5,
            });
            const updated = await define({
                achievementId: 'first_blood',
                name: 'First Blood (Revised)',
                description: 'Defeat your first foe.',
                category: 'combat',
                points: 10,
            });
            expect(updated.achievement.name).toBe('First Blood (Revised)');
            expect(updated.achievement.points).toBe(10);

            // Catalog still has exactly one entry for this id.
            const list = parseResult(await handleAchievementManage({ action: 'list' }, ctx));
            const matches = list.achievements.filter((a: { id: string }) => a.id === 'first_blood');
            expect(matches).toHaveLength(1);
            expect(matches[0].points).toBe(10);
        });

        it('stores target for incremental achievements', async () => {
            const data = await define({
                achievementId: 'monster_slayer',
                name: 'Monster Slayer',
                description: 'Defeat 100 monsters.',
                category: 'combat',
                target: 100,
            });
            expect(data.achievement.target).toBe(100);
        });
    });

    describe('list', () => {
        beforeEach(async () => {
            await define({ achievementId: 'a_combat', name: 'A', description: 'd', category: 'combat', points: 5 });
            await define({ achievementId: 'a_explore', name: 'B', description: 'd', category: 'exploration', points: 3 });
            await define({ achievementId: 'a_secret', name: 'Secret', description: 'd', category: 'combat', hidden: true });
        });

        it('lists all non-hidden definitions with no filter / no character', async () => {
            const data = parseResult(await handleAchievementManage({ action: 'list' }, ctx));
            const ids = data.achievements.map((a: { id: string }) => a.id);
            expect(ids).toContain('a_combat');
            expect(ids).toContain('a_explore');
            // hidden && not-unlocked is omitted with no characterId
            expect(ids).not.toContain('a_secret');
        });

        it('filters by category', async () => {
            const data = parseResult(await handleAchievementManage({ action: 'list', category: 'exploration' }, ctx));
            const ids = data.achievements.map((a: { id: string }) => a.id);
            expect(ids).toEqual(['a_explore']);
        });

        it('omits hidden+locked for a character but annotates state', async () => {
            const data = parseResult(await handleAchievementManage({ action: 'list', characterId: charId }, ctx));
            const ids = data.achievements.map((a: { id: string }) => a.id);
            expect(ids).not.toContain('a_secret');
            const combat = data.achievements.find((a: { id: string }) => a.id === 'a_combat');
            expect(combat.unlocked).toBe(false);
        });

        it('includes a hidden achievement once the character has unlocked it', async () => {
            await handleAchievementManage({ action: 'unlock', characterId: charId, achievementId: 'a_secret' }, ctx);
            const data = parseResult(await handleAchievementManage({ action: 'list', characterId: charId }, ctx));
            const secret = data.achievements.find((a: { id: string }) => a.id === 'a_secret');
            expect(secret).toBeDefined();
            expect(secret.unlocked).toBe(true);
            expect(typeof secret.unlockedAt).toBe('string');
        });
    });

    describe('unlock', () => {
        beforeEach(async () => {
            await define({ achievementId: 'first_blood', name: 'First Blood', description: 'd', category: 'combat', points: 5 });
        });

        it('marks an achievement unlocked for a character', async () => {
            const data = parseResult(await handleAchievementManage({
                action: 'unlock', characterId: charId, achievementId: 'first_blood',
            }, ctx));
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('unlock');
            expect(data.characterId).toBe(charId);
            expect(data.achievementId).toBe('first_blood');
            expect(data.name).toBe('First Blood');
            expect(data.points).toBe(5);
            expect(typeof data.unlockedAt).toBe('string');
            expect(data.alreadyUnlocked).toBe(false);
        });

        it('is idempotent: a repeat unlock keeps the original unlockedAt and sets alreadyUnlocked', async () => {
            const first = parseResult(await handleAchievementManage({
                action: 'unlock', characterId: charId, achievementId: 'first_blood',
            }, ctx));
            // Let the wall clock advance so a (buggy) rewritten unlockedAt would be
            // a DIFFERENT ISO timestamp — otherwise a same-millisecond rewrite would
            // false-pass this idempotency assertion.
            await new Promise((resolve) => setTimeout(resolve, 2));
            const second = parseResult(await handleAchievementManage({
                action: 'unlock', characterId: charId, achievementId: 'first_blood',
            }, ctx));
            expect(second.alreadyUnlocked).toBe(true);
            expect(second.unlockedAt).toBe(first.unlockedAt);
        });

        it('errors for an unknown achievement', async () => {
            const data = parseResult(await handleAchievementManage({
                action: 'unlock', characterId: charId, achievementId: 'nope',
            }, ctx));
            expect(data.error).toBe(true);
            expect(data.message).toBe('Achievement nope not found');
        });

        it('errors for an unknown character', async () => {
            const data = parseResult(await handleAchievementManage({
                action: 'unlock', characterId: 'ghost', achievementId: 'first_blood',
            }, ctx));
            expect(data.error).toBe(true);
            expect(data.message).toBe('Character ghost not found');
        });
    });

    describe('progress', () => {
        beforeEach(async () => {
            await define({ achievementId: 'slayer', name: 'Slayer', description: 'd', category: 'combat', target: 10, points: 20 });
            await define({ achievementId: 'binary', name: 'Binary', description: 'd', category: 'combat' });
        });

        it('increments progress by amount (default 1) without unlocking below target', async () => {
            const data = parseResult(await handleAchievementManage({
                action: 'progress', characterId: charId, achievementId: 'slayer', amount: 4,
            }, ctx));
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('progress');
            expect(data.progress).toBe(4);
            expect(data.target).toBe(10);
            expect(data.unlocked).toBe(false);
            expect(data.justUnlocked).toBe(false);

            // Default amount is 1.
            const next = parseResult(await handleAchievementManage({
                action: 'progress', characterId: charId, achievementId: 'slayer',
            }, ctx));
            expect(next.progress).toBe(5);
        });

        it('auto-unlocks at target with justUnlocked:true', async () => {
            await handleAchievementManage({ action: 'progress', characterId: charId, achievementId: 'slayer', amount: 9 }, ctx);
            const data = parseResult(await handleAchievementManage({
                action: 'progress', characterId: charId, achievementId: 'slayer', amount: 1,
            }, ctx));
            expect(data.progress).toBe(10);
            expect(data.unlocked).toBe(true);
            expect(data.justUnlocked).toBe(true);
        });

        it('clamps progress at target on overshoot', async () => {
            const data = parseResult(await handleAchievementManage({
                action: 'progress', characterId: charId, achievementId: 'slayer', amount: 999,
            }, ctx));
            expect(data.progress).toBe(10);
            expect(data.unlocked).toBe(true);

            // A subsequent progress call stays clamped and is no longer justUnlocked.
            const again = parseResult(await handleAchievementManage({
                action: 'progress', characterId: charId, achievementId: 'slayer', amount: 5,
            }, ctx));
            expect(again.progress).toBe(10);
            expect(again.unlocked).toBe(true);
            expect(again.justUnlocked).toBe(false);
        });

        it('errors for a non-incremental (no target) achievement', async () => {
            const data = parseResult(await handleAchievementManage({
                action: 'progress', characterId: charId, achievementId: 'binary', amount: 1,
            }, ctx));
            expect(data.error).toBe(true);
            expect(data.message).toBe('achievement binary is not incremental');
        });

        it('errors for unknown achievement / character', async () => {
            const a = parseResult(await handleAchievementManage({
                action: 'progress', characterId: charId, achievementId: 'nope', amount: 1,
            }, ctx));
            expect(a.error).toBe(true);
            expect(a.message).toBe('Achievement nope not found');

            const c = parseResult(await handleAchievementManage({
                action: 'progress', characterId: 'ghost', achievementId: 'slayer', amount: 1,
            }, ctx));
            expect(c.error).toBe(true);
            expect(c.message).toBe('Character ghost not found');
        });
    });

    describe('get', () => {
        beforeEach(async () => {
            await define({ achievementId: 'a1', name: 'A1', description: 'd', category: 'combat', points: 5 });
            await define({ achievementId: 'a2', name: 'A2', description: 'd', category: 'combat', points: 15 });
            await define({ achievementId: 'a3', name: 'A3', description: 'd', category: 'combat', target: 10, points: 100 });
        });

        it('summarizes unlocked, inProgress, totalPoints and counts', async () => {
            await handleAchievementManage({ action: 'unlock', characterId: charId, achievementId: 'a1' }, ctx);
            await handleAchievementManage({ action: 'unlock', characterId: charId, achievementId: 'a2' }, ctx);
            await handleAchievementManage({ action: 'progress', characterId: charId, achievementId: 'a3', amount: 4 }, ctx);

            const data = parseResult(await handleAchievementManage({ action: 'get', characterId: charId }, ctx));
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('get');
            expect(data.characterId).toBe(charId);
            expect(data.characterName).toBe('Test Hero');
            expect(data.unlockedCount).toBe(2);
            expect(data.totalPoints).toBe(20); // 5 + 15 (a3 not yet unlocked)
            expect(data.totalCount).toBe(3); // all definitions
            const unlockedIds = data.unlocked.map((u: { id: string }) => u.id).sort();
            expect(unlockedIds).toEqual(['a1', 'a2']);
            const inProgressIds = data.inProgress.map((p: { id: string }) => p.id);
            expect(inProgressIds).toEqual(['a3']);
            const a3 = data.inProgress.find((p: { id: string }) => p.id === 'a3');
            expect(a3.progress).toBe(4);
            expect(a3.target).toBe(10);
        });

        it('includes a zero-progress incremental entry in inProgress (progress 0 is present, not absent)', async () => {
            // Seed a tracked-but-unstarted entry directly: progress 0, no unlockedAt.
            // The get handler must treat progress:0 as a real value, not "absent"
            // (a truthy check on entry.progress would wrongly drop it).
            const repo = new CharacterRepository(getDb(':memory:'));
            repo.update(charId, { achievements: { a3: { progress: 0 } } as never });

            const data = parseResult(await handleAchievementManage({ action: 'get', characterId: charId }, ctx));
            const a3 = data.inProgress.find((p: { id: string }) => p.id === 'a3');
            expect(a3).toBeDefined();
            expect(a3.progress).toBe(0);
            expect(a3.target).toBe(10);
        });

        it('returns zeros for a fresh character (legacy back-compat, no achievements column)', async () => {
            const data = parseResult(await handleAchievementManage({ action: 'get', characterId: charId }, ctx));
            expect(data.unlockedCount).toBe(0);
            expect(data.totalPoints).toBe(0);
            expect(data.unlocked).toEqual([]);
            expect(data.inProgress).toEqual([]);
            expect(data.totalCount).toBe(3);
        });

        it('errors for an unknown character', async () => {
            const data = parseResult(await handleAchievementManage({ action: 'get', characterId: 'ghost' }, ctx));
            expect(data.error).toBe(true);
            expect(data.message).toBe('Character ghost not found');
        });
    });

    describe('revoke', () => {
        beforeEach(async () => {
            await define({ achievementId: 'first_blood', name: 'First Blood', description: 'd', category: 'combat', points: 5 });
        });

        it('removes a character unlock and reports revoked:true', async () => {
            await handleAchievementManage({ action: 'unlock', characterId: charId, achievementId: 'first_blood' }, ctx);
            const data = parseResult(await handleAchievementManage({
                action: 'revoke', characterId: charId, achievementId: 'first_blood',
            }, ctx));
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('revoke');
            expect(data.revoked).toBe(true);

            // The unlock is gone: get shows zero.
            const after = parseResult(await handleAchievementManage({ action: 'get', characterId: charId }, ctx));
            expect(after.unlockedCount).toBe(0);
        });

        it('reports revoked:false when there was nothing to remove', async () => {
            const data = parseResult(await handleAchievementManage({
                action: 'revoke', characterId: charId, achievementId: 'first_blood',
            }, ctx));
            expect(data.revoked).toBe(false);
        });

        it('errors for an unknown character', async () => {
            const data = parseResult(await handleAchievementManage({
                action: 'revoke', characterId: 'ghost', achievementId: 'first_blood',
            }, ctx));
            expect(data.error).toBe(true);
            expect(data.message).toBe('Character ghost not found');
        });
    });

    describe('output formatting', () => {
        it('embeds a parseable ACHIEVEMENT_MANAGE_JSON marker', async () => {
            await define({ achievementId: 'x', name: 'X', description: 'd', category: 'combat' });
            const result = await handleAchievementManage({ action: 'list' }, ctx);
            const text = result.content[0].text;
            expect(text).toContain('<!-- ACHIEVEMENT_MANAGE_JSON');
            expect(parseResult(result).actionType).toBe('list');
        });
    });
});
