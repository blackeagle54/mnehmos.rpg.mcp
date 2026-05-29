/**
 * Tests for the consolidated reputation_manage tool (Phase 3 — Factions & Reputation).
 * Actions: define_faction, list_factions, adjust, set, get, check.
 *
 * Data model under test:
 *  - factions catalog table (global definitions) via FactionRepository.
 *  - per-character reputation VALUES (Record<factionId, {value}>) stored as a
 *    JSON column on the character row. Standing is DERIVED at read time.
 *
 * Core invariants:
 *  - define_faction upserts (create + update-existing share an id).
 *  - list_factions lists definitions; with a characterId it annotates each with
 *    that character's value + derived standing (default 0/Neutral if untracked).
 *  - adjust changes a value by amount, clamps to [-1000, 1000], reports the
 *    standing transition (standingChanged true only when crossing a tier).
 *  - set writes an absolute value (clamped).
 *  - get summarizes ALL defined factions (untracked == 0/Neutral).
 *  - check tests a numeric threshold (met + shortfall).
 *  - legacy characters with no reputation column behave as empty {} (all 0/Neutral).
 */

import {
    handleReputationManage,
    ReputationManageTool,
} from '../../../src/server/consolidated/reputation-manage.js';
import {
    standingFromValue,
    ReputationEntrySchema,
    REPUTATION_MIN,
    REPUTATION_MAX,
} from '../../../src/schema/reputation.js';
import { getDb, closeDb } from '../../../src/storage/index.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { randomUUID } from 'crypto';

process.env.NODE_ENV = 'test';

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
    const text = result.content[0].text;
    const jsonMatch = text.match(/<!-- REPUTATION_MANAGE_JSON\n([\s\S]*?)\nREPUTATION_MANAGE_JSON -->/);
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
    // Note: no `reputation` field — this is a legacy/fresh character.
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

async function defineFaction(args: Record<string, unknown>) {
    return parseResult(await handleReputationManage({ action: 'define_faction', ...args }, ctx));
}

describe('reputation_manage consolidated tool', () => {
    let charId: string;

    beforeEach(() => {
        closeDb();
        const db = getDb(':memory:');
        charId = makeCharacter(new CharacterRepository(db));
    });

    describe('Tool Definition', () => {
        it('has the correct tool name', () => {
            expect(ReputationManageTool.name).toBe('reputation_manage');
        });

        it('declares the character category', () => {
            expect(ReputationManageTool.category).toBe('character');
        });

        it('lists every action in its description', () => {
            for (const action of ['define_faction', 'list_factions', 'adjust', 'set', 'get', 'check']) {
                expect(ReputationManageTool.description).toContain(action);
            }
        });
    });

    describe('standingFromValue (unit, tier boundaries)', () => {
        it('maps each boundary value to the FROZEN tier', () => {
            expect(standingFromValue(1000)).toBe('Exalted');
            expect(standingFromValue(600)).toBe('Revered');
            expect(standingFromValue(300)).toBe('Honored');
            expect(standingFromValue(100)).toBe('Friendly');
            expect(standingFromValue(0)).toBe('Neutral');
            expect(standingFromValue(-100)).toBe('Unfriendly');
            expect(standingFromValue(-500)).toBe('Hostile');
            expect(standingFromValue(-1000)).toBe('Hated');
        });

        it('resolves values just below each boundary to the lower tier', () => {
            expect(standingFromValue(999)).toBe('Revered');
            expect(standingFromValue(599)).toBe('Honored');
            expect(standingFromValue(299)).toBe('Friendly');
            expect(standingFromValue(99)).toBe('Neutral');
            expect(standingFromValue(-1)).toBe('Unfriendly');
            expect(standingFromValue(-101)).toBe('Hostile');
            expect(standingFromValue(-501)).toBe('Hated');
        });

        it('exports the clamp bounds', () => {
            expect(REPUTATION_MIN).toBe(-1000);
            expect(REPUTATION_MAX).toBe(1000);
        });

        it('keeps ±Infinity at the extreme tiers (only NaN falls back to Neutral)', () => {
            // Infinity must resolve to the top tier, not collapse to Neutral.
            expect(standingFromValue(Infinity)).toBe('Exalted');
            expect(standingFromValue(-Infinity)).toBe('Hated');
            // Only NaN is undefined input → safe Neutral floor.
            expect(standingFromValue(NaN)).toBe('Neutral');
        });
    });

    describe('ReputationEntrySchema (persisted invariant)', () => {
        it('rejects values outside the clamp range so DB/JSON state stays in-contract', () => {
            expect(ReputationEntrySchema.safeParse({ value: 500 }).success).toBe(true);
            expect(ReputationEntrySchema.safeParse({ value: REPUTATION_MAX }).success).toBe(true);
            expect(ReputationEntrySchema.safeParse({ value: REPUTATION_MIN }).success).toBe(true);
            expect(ReputationEntrySchema.safeParse({ value: REPUTATION_MAX + 1 }).success).toBe(false);
            expect(ReputationEntrySchema.safeParse({ value: REPUTATION_MIN - 1 }).success).toBe(false);
        });
    });

    describe('define_faction', () => {
        it('creates a new faction definition', async () => {
            const data = await defineFaction({
                factionId: 'thieves_guild',
                name: 'Thieves Guild',
                description: 'A shadowy network of rogues.',
            });
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('define_faction');
            expect(data.faction.id).toBe('thieves_guild');
            expect(data.faction.name).toBe('Thieves Guild');
            expect(data.faction.description).toBe('A shadowy network of rogues.');
        });

        it('updates an existing faction (upsert on the same id)', async () => {
            await defineFaction({ factionId: 'mages', name: 'Mages' });
            const updated = await defineFaction({
                factionId: 'mages',
                name: 'Mages Guild',
                description: 'Arcane scholars.',
            });
            expect(updated.faction.name).toBe('Mages Guild');
            expect(updated.faction.description).toBe('Arcane scholars.');

            const list = parseResult(await handleReputationManage({ action: 'list_factions' }, ctx));
            const matches = list.factions.filter((f: { id: string }) => f.id === 'mages');
            expect(matches).toHaveLength(1);
            expect(matches[0].name).toBe('Mages Guild');
        });
    });

    describe('list_factions', () => {
        beforeEach(async () => {
            await defineFaction({ factionId: 'guild_a', name: 'Guild A', description: 'd' });
            await defineFaction({ factionId: 'guild_b', name: 'Guild B' });
        });

        it('lists all definitions with no character (no value/standing annotation)', async () => {
            const data = parseResult(await handleReputationManage({ action: 'list_factions' }, ctx));
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('list_factions');
            const ids = data.factions.map((f: { id: string }) => f.id).sort();
            expect(ids).toEqual(['guild_a', 'guild_b']);
            const a = data.factions.find((f: { id: string }) => f.id === 'guild_a');
            expect(a.value).toBeUndefined();
            expect(a.standing).toBeUndefined();
        });

        it('annotates each faction with the character value + standing (default 0/Neutral)', async () => {
            await handleReputationManage({ action: 'set', characterId: charId, factionId: 'guild_a', value: 350 }, ctx);
            const data = parseResult(await handleReputationManage({ action: 'list_factions', characterId: charId }, ctx));
            const a = data.factions.find((f: { id: string }) => f.id === 'guild_a');
            const b = data.factions.find((f: { id: string }) => f.id === 'guild_b');
            expect(a.value).toBe(350);
            expect(a.standing).toBe('Honored');
            // Untracked faction defaults to 0 / Neutral.
            expect(b.value).toBe(0);
            expect(b.standing).toBe('Neutral');
        });
    });

    describe('adjust', () => {
        beforeEach(async () => {
            await defineFaction({ factionId: 'guild', name: 'Guild' });
        });

        it('increases reputation by a positive amount', async () => {
            const data = parseResult(await handleReputationManage({
                action: 'adjust', characterId: charId, factionId: 'guild', amount: 50,
            }, ctx));
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('adjust');
            expect(data.oldValue).toBe(0);
            expect(data.newValue).toBe(50);
            expect(data.oldStanding).toBe('Neutral');
            expect(data.newStanding).toBe('Neutral');
            expect(data.standingChanged).toBe(false);
            expect(data.name).toBe('Guild');
        });

        it('decreases reputation by a negative amount', async () => {
            await handleReputationManage({ action: 'set', characterId: charId, factionId: 'guild', value: 50 }, ctx);
            const data = parseResult(await handleReputationManage({
                action: 'adjust', characterId: charId, factionId: 'guild', amount: -200,
            }, ctx));
            expect(data.oldValue).toBe(50);
            expect(data.newValue).toBe(-150);
            expect(data.oldStanding).toBe('Neutral');
            expect(data.newStanding).toBe('Hostile');
            expect(data.standingChanged).toBe(true);
        });

        it('reports standingChanged true when crossing a tier boundary (Neutral -> Friendly)', async () => {
            const data = parseResult(await handleReputationManage({
                action: 'adjust', characterId: charId, factionId: 'guild', amount: 100,
            }, ctx));
            expect(data.oldValue).toBe(0);
            expect(data.newValue).toBe(100);
            expect(data.oldStanding).toBe('Neutral');
            expect(data.newStanding).toBe('Friendly');
            expect(data.standingChanged).toBe(true);
        });

        it('reports standingChanged false when staying within a tier', async () => {
            await handleReputationManage({ action: 'set', characterId: charId, factionId: 'guild', value: 100 }, ctx);
            const data = parseResult(await handleReputationManage({
                action: 'adjust', characterId: charId, factionId: 'guild', amount: 50,
            }, ctx));
            expect(data.oldValue).toBe(100);
            expect(data.newValue).toBe(150);
            expect(data.oldStanding).toBe('Friendly');
            expect(data.newStanding).toBe('Friendly');
            expect(data.standingChanged).toBe(false);
        });

        it('clamps at the positive cap (+1000)', async () => {
            await handleReputationManage({ action: 'set', characterId: charId, factionId: 'guild', value: 900 }, ctx);
            const data = parseResult(await handleReputationManage({
                action: 'adjust', characterId: charId, factionId: 'guild', amount: 500,
            }, ctx));
            expect(data.newValue).toBe(1000);
            expect(data.newStanding).toBe('Exalted');
        });

        it('clamps at the negative cap (-1000)', async () => {
            await handleReputationManage({ action: 'set', characterId: charId, factionId: 'guild', value: -900 }, ctx);
            const data = parseResult(await handleReputationManage({
                action: 'adjust', characterId: charId, factionId: 'guild', amount: -500,
            }, ctx));
            expect(data.newValue).toBe(-1000);
            expect(data.newStanding).toBe('Hated');
        });

        it('errors for an unknown faction', async () => {
            const data = parseResult(await handleReputationManage({
                action: 'adjust', characterId: charId, factionId: 'nope', amount: 10,
            }, ctx));
            expect(data.error).toBe(true);
            expect(data.message).toBe('Faction nope not found');
        });

        it('errors for an unknown character', async () => {
            const data = parseResult(await handleReputationManage({
                action: 'adjust', characterId: 'ghost', factionId: 'guild', amount: 10,
            }, ctx));
            expect(data.error).toBe(true);
            expect(data.message).toBe('Character ghost not found');
        });
    });

    describe('set', () => {
        beforeEach(async () => {
            await defineFaction({ factionId: 'guild', name: 'Guild' });
        });

        it('sets an absolute value and derives the standing', async () => {
            const data = parseResult(await handleReputationManage({
                action: 'set', characterId: charId, factionId: 'guild', value: 600,
            }, ctx));
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('set');
            expect(data.value).toBe(600);
            expect(data.standing).toBe('Revered');
            expect(data.name).toBe('Guild');
        });

        it('clamps an out-of-range value', async () => {
            const high = parseResult(await handleReputationManage({
                action: 'set', characterId: charId, factionId: 'guild', value: 9999,
            }, ctx));
            expect(high.value).toBe(1000);
            expect(high.standing).toBe('Exalted');

            const low = parseResult(await handleReputationManage({
                action: 'set', characterId: charId, factionId: 'guild', value: -9999,
            }, ctx));
            expect(low.value).toBe(-1000);
            expect(low.standing).toBe('Hated');
        });

        it('errors for an unknown faction / character', async () => {
            const f = parseResult(await handleReputationManage({
                action: 'set', characterId: charId, factionId: 'nope', value: 10,
            }, ctx));
            expect(f.error).toBe(true);
            expect(f.message).toBe('Faction nope not found');

            const c = parseResult(await handleReputationManage({
                action: 'set', characterId: 'ghost', factionId: 'guild', value: 10,
            }, ctx));
            expect(c.error).toBe(true);
            expect(c.message).toBe('Character ghost not found');
        });
    });

    describe('get', () => {
        beforeEach(async () => {
            await defineFaction({ factionId: 'f1', name: 'F1' });
            await defineFaction({ factionId: 'f2', name: 'F2' });
            await defineFaction({ factionId: 'f3', name: 'F3' });
        });

        it('summarizes ALL defined factions, including untracked as 0/Neutral', async () => {
            await handleReputationManage({ action: 'set', characterId: charId, factionId: 'f1', value: 300 }, ctx);
            await handleReputationManage({ action: 'set', characterId: charId, factionId: 'f2', value: -200 }, ctx);

            const data = parseResult(await handleReputationManage({ action: 'get', characterId: charId }, ctx));
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('get');
            expect(data.characterId).toBe(charId);
            expect(data.characterName).toBe('Test Hero');
            expect(data.factionCount).toBe(3);
            expect(data.reputations).toHaveLength(3);

            const f1 = data.reputations.find((r: { id: string }) => r.id === 'f1');
            const f2 = data.reputations.find((r: { id: string }) => r.id === 'f2');
            const f3 = data.reputations.find((r: { id: string }) => r.id === 'f3');
            expect(f1.value).toBe(300);
            expect(f1.standing).toBe('Honored');
            expect(f2.value).toBe(-200);
            expect(f2.standing).toBe('Hostile');
            // Untracked faction appears as 0 / Neutral.
            expect(f3.value).toBe(0);
            expect(f3.standing).toBe('Neutral');
        });

        it('returns all-Neutral for a fresh character (legacy back-compat, no reputation column)', async () => {
            const data = parseResult(await handleReputationManage({ action: 'get', characterId: charId }, ctx));
            expect(data.factionCount).toBe(3);
            expect(data.reputations).toHaveLength(3);
            for (const r of data.reputations) {
                expect(r.value).toBe(0);
                expect(r.standing).toBe('Neutral');
            }
        });

        it('errors for an unknown character', async () => {
            const data = parseResult(await handleReputationManage({ action: 'get', characterId: 'ghost' }, ctx));
            expect(data.error).toBe(true);
            expect(data.message).toBe('Character ghost not found');
        });
    });

    describe('check', () => {
        beforeEach(async () => {
            await defineFaction({ factionId: 'guild', name: 'Guild' });
        });

        it('returns met:true with shortfall 0 when the threshold is met', async () => {
            await handleReputationManage({ action: 'set', characterId: charId, factionId: 'guild', value: 400 }, ctx);
            const data = parseResult(await handleReputationManage({
                action: 'check', characterId: charId, factionId: 'guild', value: 300,
            }, ctx));
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('check');
            expect(data.currentValue).toBe(400);
            expect(data.currentStanding).toBe('Honored');
            expect(data.requiredValue).toBe(300);
            expect(data.met).toBe(true);
            expect(data.shortfall).toBe(0);
            expect(data.name).toBe('Guild');
        });

        it('returns met:false with the shortfall when below the threshold', async () => {
            await handleReputationManage({ action: 'set', characterId: charId, factionId: 'guild', value: 100 }, ctx);
            const data = parseResult(await handleReputationManage({
                action: 'check', characterId: charId, factionId: 'guild', value: 300,
            }, ctx));
            expect(data.met).toBe(false);
            expect(data.currentValue).toBe(100);
            expect(data.requiredValue).toBe(300);
            expect(data.shortfall).toBe(200);
        });

        it('treats an untracked faction as value 0 for the check', async () => {
            const data = parseResult(await handleReputationManage({
                action: 'check', characterId: charId, factionId: 'guild', value: 100,
            }, ctx));
            expect(data.currentValue).toBe(0);
            expect(data.currentStanding).toBe('Neutral');
            expect(data.met).toBe(false);
            expect(data.shortfall).toBe(100);
        });

        it('errors for an unknown faction / character', async () => {
            const f = parseResult(await handleReputationManage({
                action: 'check', characterId: charId, factionId: 'nope', value: 10,
            }, ctx));
            expect(f.error).toBe(true);
            expect(f.message).toBe('Faction nope not found');

            const c = parseResult(await handleReputationManage({
                action: 'check', characterId: 'ghost', factionId: 'guild', value: 10,
            }, ctx));
            expect(c.error).toBe(true);
            expect(c.message).toBe('Character ghost not found');
        });
    });

    describe('output formatting', () => {
        it('embeds a parseable REPUTATION_MANAGE_JSON marker', async () => {
            await defineFaction({ factionId: 'x', name: 'X' });
            const result = await handleReputationManage({ action: 'list_factions' }, ctx);
            const text = result.content[0].text;
            expect(text).toContain('<!-- REPUTATION_MANAGE_JSON');
            expect(parseResult(result).actionType).toBe('list_factions');
        });
    });
});
