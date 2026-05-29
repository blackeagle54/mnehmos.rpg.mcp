/**
 * Tests for the consolidated save_manage tool (Phase 5 — Campaign Save Bundles).
 * Actions: export, import.
 *
 * Design under test (FROZEN):
 *  - export serializes ONE campaign (scoped by worldId, +partyId) into a
 *    self-contained JSON bundle, keeping every row's UUID verbatim.
 *  - import re-inserts every entity with the SAME UUIDs via upsert inside ONE
 *    transaction, in FK-safe order. "load == restore/overwrite this campaign."
 *  - schemaVersion === 1 + bundle shape are validated BEFORE any write; a
 *    malformed/wrong-version bundle rejects with {error:true} and writes nothing
 *    (transaction rollback / pre-write guard — no half-write).
 *
 * The DERIVED worldgen tables (regions/tiles/structures/rivers/room_nodes) are
 * intentionally EXCLUDED: they regenerate from worlds.seed + worlds.gen_options,
 * which the bundle carries on the world row.
 */

import {
    handleSaveManage,
    SaveManageTool,
} from '../../../src/server/consolidated/save-manage.js';
import { getDb, closeDb } from '../../../src/storage/index.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { PartyRepository } from '../../../src/storage/repos/party.repo.js';
import { QuestRepository } from '../../../src/storage/repos/quest.repo.js';
import { ItemRepository } from '../../../src/storage/repos/item.repo.js';
import { InventoryRepository } from '../../../src/storage/repos/inventory.repo.js';
import { FactionRepository } from '../../../src/storage/repos/faction.repo.js';
import { SecretRepository } from '../../../src/storage/repos/secret.repo.js';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

process.env.NODE_ENV = 'test';

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
    const text = result.content[0].text;
    const jsonMatch = text.match(/<!-- SAVE_MANAGE_JSON\n([\s\S]*?)\nSAVE_MANAGE_JSON -->/);
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

interface SeededCampaign {
    worldId: string;
    partyId: string;
    memberId: string;
    heroId: string;
    companionId: string;
    questId: string;
    itemId: string;
    factionId: string;
    secretId: string;
    noteId: string;
}

const now = () => new Date().toISOString();

function makeWorld(db: Database.Database, name: string): string {
    const id = randomUUID();
    new WorldRepository(db).create({
        id,
        name,
        seed: 'seed-' + name,
        width: 50,
        height: 50,
        createdAt: now(),
        updatedAt: now(),
        genOptions: { algorithm: 'perlin', octaves: 4 },
    } as any);
    return id;
}

function makeCharacter(
    db: Database.Database,
    name: string,
    extra: Record<string, unknown> = {}
): string {
    const id = randomUUID();
    new CharacterRepository(db).create({
        id,
        name,
        stats: { str: 16, dex: 14, con: 15, int: 10, wis: 12, cha: 8 },
        hp: 45,
        maxHp: 45,
        ac: 18,
        level: 5,
        xp: 6500,
        characterType: 'pc',
        createdAt: now(),
        updatedAt: now(),
        ...extra,
    } as any);
    return id;
}

/** Seed a complete small campaign and return the IDs for assertions. */
function seedCampaign(db: Database.Database): SeededCampaign {
    const worldId = makeWorld(db, 'Eldoria');

    // Faction catalog (referenced by character reputation).
    const factionRepo = new FactionRepository(db);
    const factionId = 'thieves_guild';
    factionRepo.upsert({ id: factionId, name: 'Thieves Guild', description: 'Shadows.' });

    // Two characters with skills/achievements/reputation JSON columns populated.
    const heroId = makeCharacter(db, 'Aria', {
        skills: { mining: { xp: 1200, rank: 5 } },
        achievements: { first_blood: { unlockedAt: now() } },
        reputation: { [factionId]: { value: 350 } },
        currency: { gold: 100, silver: 5, copper: 0 },
    });
    const companionId = makeCharacter(db, 'Borin', {
        achievements: { explorer: { progress: 3 } },
    });

    // Party + members.
    const partyRepo = new PartyRepository(db);
    const partyId = randomUUID();
    partyRepo.create({
        id: partyId,
        name: 'The Wayfarers',
        worldId,
        status: 'active',
        formation: 'standard',
        createdAt: now(),
        updatedAt: now(),
    } as any);
    const memberId = randomUUID();
    partyRepo.addMember({
        id: memberId,
        partyId,
        characterId: heroId,
        role: 'leader',
        isActive: true,
        sharePercentage: 100,
        joinedAt: now(),
    } as any);
    partyRepo.addMember({
        id: randomUUID(),
        partyId,
        characterId: companionId,
        role: 'member',
        isActive: false,
        sharePercentage: 100,
        joinedAt: now(),
    } as any);

    // Item + inventory.
    const itemRepo = new ItemRepository(db);
    const itemId = randomUUID();
    itemRepo.create({
        id: itemId,
        name: 'Iron Sword',
        type: 'weapon',
        weight: 3,
        value: 50,
        createdAt: now(),
        updatedAt: now(),
    } as any);
    new InventoryRepository(db).addItem(heroId, itemId, 1);

    // Quest + quest log.
    const questRepo = new QuestRepository(db);
    const questId = randomUUID();
    questRepo.create({
        id: questId,
        worldId,
        name: 'Slay the Dragon',
        description: 'A great wyrm threatens the realm.',
        status: 'active',
        objectives: [{ id: 'obj1', description: 'Find the lair', type: 'explore', target: 'dragon_lair', required: 1, current: 0, completed: false }],
        rewards: { experience: 1000, gold: 500, items: [] },
        prerequisites: [],
        createdAt: now(),
        updatedAt: now(),
    } as any);
    questRepo.updateLog({
        characterId: heroId,
        activeQuests: [questId],
        completedQuests: [],
        failedQuests: [],
    } as any);

    // Secret.
    const secretRepo = new SecretRepository(db);
    const secretId = randomUUID();
    secretRepo.create({
        id: secretId,
        worldId,
        type: 'plot',
        category: 'betrayal',
        name: 'The Traitor',
        publicDescription: 'A loyal advisor.',
        secretDescription: 'Secretly working for the enemy.',
        revealed: false,
        revealConditions: [],
        sensitivity: 'high',
        leakPatterns: [],
        createdAt: now(),
        updatedAt: now(),
    } as any);

    // Narrative note (raw insert — no dedicated repo).
    const noteId = randomUUID();
    db.prepare(
        `INSERT INTO narrative_notes (id, world_id, type, content, metadata, visibility, tags, status, created_at, updated_at)
         VALUES (?, ?, 'plot_thread', 'The dragon stirs.', '{}', 'dm_only', '[]', 'active', ?, ?)`
    ).run(noteId, worldId, now(), now());

    return { worldId, partyId, memberId, heroId, companionId, questId, itemId, factionId, secretId, noteId };
}

function rowCounts(db: Database.Database) {
    const count = (sql: string, ...params: unknown[]) =>
        (db.prepare(sql).get(...params) as { n: number }).n;
    return {
        worlds: count('SELECT COUNT(*) n FROM worlds'),
        parties: count('SELECT COUNT(*) n FROM parties'),
        partyMembers: count('SELECT COUNT(*) n FROM party_members'),
        characters: count('SELECT COUNT(*) n FROM characters'),
        items: count('SELECT COUNT(*) n FROM items'),
        inventoryItems: count('SELECT COUNT(*) n FROM inventory_items'),
        quests: count('SELECT COUNT(*) n FROM quests'),
        questLogs: count('SELECT COUNT(*) n FROM quest_logs'),
        factions: count('SELECT COUNT(*) n FROM factions'),
        secrets: count('SELECT COUNT(*) n FROM secrets'),
        narrativeNotes: count('SELECT COUNT(*) n FROM narrative_notes'),
    };
}

describe('save_manage consolidated tool', () => {
    let db: Database.Database;

    beforeEach(() => {
        closeDb();
        db = getDb(':memory:');
    });

    describe('Tool Definition', () => {
        it('has the correct tool name', () => {
            expect(SaveManageTool.name).toBe('save_manage');
        });

        it('declares the meta category (reuses an existing ToolCategory member)', () => {
            expect(SaveManageTool.category).toBe('meta');
        });

        it('lists every action in its description', () => {
            for (const action of ['export', 'import']) {
                expect(SaveManageTool.description).toContain(action);
            }
        });
    });

    describe('export', () => {
        it('produces a self-contained bundle scoped to one campaign with verbatim UUIDs', async () => {
            const seed = seedCampaign(db);
            const data = parseResult(
                await handleSaveManage({ action: 'export', worldId: seed.worldId }, ctx)
            );

            expect(data.success).toBe(true);
            expect(data.actionType).toBe('export');
            expect(data.schemaVersion).toBe(1);

            const b = data.bundle;
            expect(b).toBeDefined();
            // World identity carried verbatim (incl. seed + gen_options for regeneration).
            expect(b.worlds).toHaveLength(1);
            expect(b.worlds[0].id).toBe(seed.worldId);
            expect(b.worlds[0].seed).toBe('seed-Eldoria');

            // Party + members.
            expect(b.parties.map((p: any) => p.id)).toContain(seed.partyId);
            expect(b.party_members.map((m: any) => m.id)).toContain(seed.memberId);
            expect(b.party_members).toHaveLength(2);

            // Both characters, with their JSON columns preserved.
            const charIds = b.characters.map((c: any) => c.id).sort();
            expect(charIds).toEqual([seed.heroId, seed.companionId].sort());
            const hero = b.characters.find((c: any) => c.id === seed.heroId);
            expect(hero.skills).toBeTruthy();
            expect(hero.achievements).toBeTruthy();
            expect(hero.reputation).toBeTruthy();

            // Items + inventory.
            expect(b.items.map((i: any) => i.id)).toContain(seed.itemId);
            expect(b.inventory_items).toHaveLength(1);
            expect(b.inventory_items[0].character_id).toBe(seed.heroId);
            expect(b.inventory_items[0].item_id).toBe(seed.itemId);

            // Quests + quest logs.
            expect(b.quests.map((q: any) => q.id)).toContain(seed.questId);
            expect(b.quest_logs.map((l: any) => l.character_id)).toContain(seed.heroId);

            // Factions, secrets, narrative notes.
            expect(b.factions.map((f: any) => f.id)).toContain(seed.factionId);
            expect(b.secrets.map((s: any) => s.id)).toContain(seed.secretId);
            expect(b.narrative_notes.map((n: any) => n.id)).toContain(seed.noteId);
        });

        it('does NOT include derived worldgen tables (regions/tiles/structures/rivers/room_nodes)', async () => {
            const seed = seedCampaign(db);
            const data = parseResult(
                await handleSaveManage({ action: 'export', worldId: seed.worldId }, ctx)
            );
            const b = data.bundle;
            expect(b.regions).toBeUndefined();
            expect(b.tiles).toBeUndefined();
            expect(b.structures).toBeUndefined();
            expect(b.rivers).toBeUndefined();
            expect(b.room_nodes).toBeUndefined();
        });

        it('errors for an unknown world', async () => {
            const data = parseResult(
                await handleSaveManage({ action: 'export', worldId: 'ghost-world' }, ctx)
            );
            expect(data.error).toBe(true);
            expect(typeof data.message).toBe('string');
        });
    });

    describe('scoping', () => {
        it('export of worldA does not include worldB entities', async () => {
            const seedA = seedCampaign(db);
            const seedB = seedCampaign(db);

            const data = parseResult(
                await handleSaveManage({ action: 'export', worldId: seedA.worldId }, ctx)
            );
            const b = data.bundle;

            expect(b.worlds.map((w: any) => w.id)).toEqual([seedA.worldId]);
            expect(b.parties.map((p: any) => p.id)).toContain(seedA.partyId);
            expect(b.parties.map((p: any) => p.id)).not.toContain(seedB.partyId);
            expect(b.characters.map((c: any) => c.id)).not.toContain(seedB.heroId);
            expect(b.quests.map((q: any) => q.id)).not.toContain(seedB.questId);
            expect(b.secrets.map((s: any) => s.id)).not.toContain(seedB.secretId);
            expect(b.narrative_notes.map((n: any) => n.id)).not.toContain(seedB.noteId);
        });
    });

    describe('round-trip (export -> wipe -> import restores verbatim)', () => {
        it('restores every entity with identical UUIDs + field values', async () => {
            const seed = seedCampaign(db);
            const before = rowCounts(db);

            // Capture the SOURCE raw JSON columns so we can assert the round-trip
            // is byte-for-byte (save_manage stores rows verbatim; the character
            // schema's read-time skill-map normalization is orthogonal).
            const sourceHeroRow = db
                .prepare('SELECT skills, reputation FROM characters WHERE id = ?')
                .get(seed.heroId) as { skills: string | null; reputation: string | null };

            const exported = parseResult(
                await handleSaveManage({ action: 'export', worldId: seed.worldId }, ctx)
            );
            const bundle = exported.bundle;

            // Fresh in-memory DB — nothing exists.
            closeDb();
            db = getDb(':memory:');
            expect(rowCounts(db).characters).toBe(0);

            const imported = parseResult(
                await handleSaveManage({ action: 'import', bundle }, ctx)
            );
            expect(imported.success).toBe(true);
            expect(imported.actionType).toBe('import');
            expect(imported.imported.worlds).toBe(1);
            expect(imported.imported.parties).toBe(1);
            expect(imported.imported.characters).toBe(2);
            expect(imported.imported.quests).toBe(1);
            expect(imported.imported.items).toBe(1);

            // Counts match the original campaign exactly.
            expect(rowCounts(db)).toEqual(before);

            // Spot-check verbatim restoration via the repos.
            const world = new WorldRepository(db).findById(seed.worldId);
            expect(world?.name).toBe('Eldoria');
            expect(world?.seed).toBe('seed-Eldoria');

            const hero = new CharacterRepository(db).findById(seed.heroId);
            expect(hero?.name).toBe('Aria');
            // Assert at the RAW column level — save_manage round-trips the stored
            // JSON columns verbatim, so the restored columns must equal the source
            // columns byte-for-byte (independent of any read-time normalization).
            const heroRow = db
                .prepare('SELECT skills, reputation FROM characters WHERE id = ?')
                .get(seed.heroId) as { skills: string | null; reputation: string | null };
            expect(heroRow.skills).toBe(sourceHeroRow.skills);
            expect(heroRow.reputation).toBe(sourceHeroRow.reputation);
            expect(JSON.parse(heroRow.reputation!)).toEqual({ [seed.factionId]: { value: 350 } });

            const inv = new InventoryRepository(db).getInventory(seed.heroId);
            expect(inv.items.map((i) => i.itemId)).toContain(seed.itemId);

            const log = new QuestRepository(db).getLog(seed.heroId);
            expect(log?.activeQuests).toContain(seed.questId);

            const faction = new FactionRepository(db).findById(seed.factionId);
            expect(faction?.name).toBe('Thieves Guild');

            const note = db
                .prepare('SELECT * FROM narrative_notes WHERE id = ?')
                .get(seed.noteId) as { content: string } | undefined;
            expect(note?.content).toBe('The dragon stirs.');
        });
    });

    describe('validation (pre-write guard / rollback — no clobber)', () => {
        it('rejects a missing schemaVersion and writes nothing', async () => {
            const seed = seedCampaign(db);
            const exported = parseResult(
                await handleSaveManage({ action: 'export', worldId: seed.worldId }, ctx)
            );
            const before = rowCounts(db);

            // Strip schemaVersion off the bundle entirely.
            const bundle = { ...exported.bundle };
            delete bundle.schemaVersion;

            const data = parseResult(
                await handleSaveManage({ action: 'import', bundle, schemaVersion: 99 }, ctx)
            );
            expect(data.error).toBe(true);
            expect(typeof data.message).toBe('string');
            // DB unchanged.
            expect(rowCounts(db)).toEqual(before);
        });

        it('rejects a wrong schemaVersion and writes nothing', async () => {
            closeDb();
            db = getDb(':memory:');
            const before = rowCounts(db);

            const data = parseResult(
                await handleSaveManage(
                    { action: 'import', bundle: { schemaVersion: 2, worlds: [] }, schemaVersion: 2 },
                    ctx
                )
            );
            expect(data.error).toBe(true);
            expect(rowCounts(db)).toEqual(before);
        });

        it('rejects a structurally malformed bundle with no partial write (rollback)', async () => {
            closeDb();
            db = getDb(':memory:');
            const before = rowCounts(db);

            // worlds present but a child table is the wrong type → fails shape validation
            // BEFORE any row is written.
            const malformed = {
                schemaVersion: 1,
                worlds: [{ id: 'w1', name: 'X', seed: 's', width: 10, height: 10, created_at: now(), updated_at: now() }],
                parties: 'not-an-array',
            };

            const data = parseResult(
                await handleSaveManage({ action: 'import', bundle: malformed }, ctx)
            );
            expect(data.error).toBe(true);
            // The valid-looking world must NOT have been written (validate-before-write).
            expect(rowCounts(db)).toEqual(before);
        });
    });

    describe('upsert / idempotency', () => {
        it('importing the same bundle twice yields the same final state (no duplicates)', async () => {
            const seed = seedCampaign(db);
            const exported = parseResult(
                await handleSaveManage({ action: 'export', worldId: seed.worldId }, ctx)
            );
            const expectedCounts = rowCounts(db);

            closeDb();
            db = getDb(':memory:');

            await handleSaveManage({ action: 'import', bundle: exported.bundle }, ctx);
            await handleSaveManage({ action: 'import', bundle: exported.bundle }, ctx);

            expect(rowCounts(db)).toEqual(expectedCounts);
        });

        it('import overwrites a diverged existing row to match the bundle', async () => {
            const seed = seedCampaign(db);
            const exported = parseResult(
                await handleSaveManage({ action: 'export', worldId: seed.worldId }, ctx)
            );

            // Diverge the live hero AFTER export.
            new CharacterRepository(db).update(seed.heroId, { name: 'Aria the Corrupted' } as any);
            expect(new CharacterRepository(db).findById(seed.heroId)?.name).toBe('Aria the Corrupted');

            // Re-import the bundle (load == restore/overwrite).
            await handleSaveManage({ action: 'import', bundle: exported.bundle }, ctx);

            expect(new CharacterRepository(db).findById(seed.heroId)?.name).toBe('Aria');
        });
    });

    describe('import hardening (untrusted bundle)', () => {
        // ── Fix 1: SQL injection via untrusted column keys ──────────────────
        it('rejects a row whose column key is an injection payload and writes nothing', async () => {
            const seed = seedCampaign(db);
            const exported = parseResult(
                await handleSaveManage({ action: 'export', worldId: seed.worldId }, ctx)
            );

            // Wipe to a fresh DB so a successful injection would be observable.
            closeDb();
            db = getDb(':memory:');
            const before = rowCounts(db);

            // Craft a malicious column key on a world row. A naive INSERT that
            // interpolates Object.keys(row) would emit SQL that drops a table.
            const bundle = JSON.parse(JSON.stringify(exported.bundle));
            bundle.worlds[0]['id") VALUES ("x"); DROP TABLE characters; --'] = 'pwned';

            const data = parseResult(
                await handleSaveManage({ action: 'import', bundle }, ctx)
            );
            expect(data.error).toBe(true);
            expect(typeof data.message).toBe('string');
            // No partial write — and the characters table must still exist.
            expect(rowCounts(db)).toEqual(before);
            expect(() => db.prepare('SELECT COUNT(*) FROM characters').get()).not.toThrow();
        });

        it('rejects a row with an unknown-but-harmless column not in the table schema', async () => {
            const seed = seedCampaign(db);
            const exported = parseResult(
                await handleSaveManage({ action: 'export', worldId: seed.worldId }, ctx)
            );

            closeDb();
            db = getDb(':memory:');
            const before = rowCounts(db);

            // A perfectly-named identifier that simply is not a column on `worlds`.
            const bundle = JSON.parse(JSON.stringify(exported.bundle));
            bundle.worlds[0]['totally_made_up_column'] = 'nope';

            const data = parseResult(
                await handleSaveManage({ action: 'import', bundle }, ctx)
            );
            expect(data.error).toBe(true);
            expect(rowCounts(db)).toEqual(before);
        });

        it('still round-trips a normal valid bundle after hardening', async () => {
            const seed = seedCampaign(db);
            const exported = parseResult(
                await handleSaveManage({ action: 'export', worldId: seed.worldId }, ctx)
            );
            const before = rowCounts(db);

            closeDb();
            db = getDb(':memory:');

            const data = parseResult(
                await handleSaveManage({ action: 'import', bundle: exported.bundle }, ctx)
            );
            expect(data.success).toBe(true);
            expect(rowCounts(db)).toEqual(before);
        });

        // ── Fix 2: schemaVersion reconciliation ─────────────────────────────
        it('rejects when declared version differs from the bundle version and writes nothing', async () => {
            const seed = seedCampaign(db);
            const exported = parseResult(
                await handleSaveManage({ action: 'export', worldId: seed.worldId }, ctx)
            );

            closeDb();
            db = getDb(':memory:');
            const before = rowCounts(db);

            // Bundle says v1, caller declares v2 → genuine mismatch.
            const data = parseResult(
                await handleSaveManage(
                    { action: 'import', bundle: exported.bundle, schemaVersion: 2 },
                    ctx
                )
            );
            expect(data.error).toBe(true);
            expect(data.message).toContain('mismatch');
            expect(rowCounts(db)).toEqual(before);
        });

        it('rejects an unsupported bundle version and writes nothing', async () => {
            closeDb();
            db = getDb(':memory:');
            const before = rowCounts(db);

            const data = parseResult(
                await handleSaveManage(
                    {
                        action: 'import',
                        bundle: { schemaVersion: 99, worlds: [{ id: 'w1', name: 'X', seed: 's' }] },
                    },
                    ctx
                )
            );
            expect(data.error).toBe(true);
            expect(rowCounts(db)).toEqual(before);
        });

        // ── Fix 3: exactly one world row ────────────────────────────────────
        it('rejects a bundle with zero worlds', async () => {
            closeDb();
            db = getDb(':memory:');
            const before = rowCounts(db);

            const data = parseResult(
                await handleSaveManage(
                    { action: 'import', bundle: { schemaVersion: 1, worlds: [] } },
                    ctx
                )
            );
            expect(data.error).toBe(true);
            expect(rowCounts(db)).toEqual(before);
        });

        it('rejects a bundle with more than one world', async () => {
            const seedA = seedCampaign(db);
            seedCampaign(db);
            const exportedA = parseResult(
                await handleSaveManage({ action: 'export', worldId: seedA.worldId }, ctx)
            );

            closeDb();
            db = getDb(':memory:');
            const before = rowCounts(db);

            // Duplicate the single world into two distinct rows.
            const bundle = JSON.parse(JSON.stringify(exportedA.bundle));
            const second = JSON.parse(JSON.stringify(bundle.worlds[0]));
            second.id = randomUUID();
            bundle.worlds.push(second);

            const data = parseResult(
                await handleSaveManage({ action: 'import', bundle }, ctx)
            );
            expect(data.error).toBe(true);
            expect(rowCounts(db)).toEqual(before);
        });

        // ── Fix 4: required primary-key columns present before any write ────
        it('rejects a row missing its primary key and writes nothing', async () => {
            const seed = seedCampaign(db);
            const exported = parseResult(
                await handleSaveManage({ action: 'export', worldId: seed.worldId }, ctx)
            );

            closeDb();
            db = getDb(':memory:');
            const before = rowCounts(db);

            // Strip the world's primary key — the import must reject pre-write.
            const bundle = JSON.parse(JSON.stringify(exported.bundle));
            delete bundle.worlds[0].id;

            const data = parseResult(
                await handleSaveManage({ action: 'import', bundle }, ctx)
            );
            expect(data.error).toBe(true);
            expect(data.message).toContain('primary key');
            expect(rowCounts(db)).toEqual(before);
        });

        it('rejects a composite-pk child row missing one pk column and writes nothing', async () => {
            const seed = seedCampaign(db);
            const exported = parseResult(
                await handleSaveManage({ action: 'export', worldId: seed.worldId }, ctx)
            );

            closeDb();
            db = getDb(':memory:');
            const before = rowCounts(db);

            // inventory_items has composite pk (character_id, item_id); drop one.
            const bundle = JSON.parse(JSON.stringify(exported.bundle));
            expect(bundle.inventory_items.length).toBeGreaterThan(0);
            delete bundle.inventory_items[0].item_id;

            const data = parseResult(
                await handleSaveManage({ action: 'import', bundle }, ctx)
            );
            expect(data.error).toBe(true);
            expect(data.message).toContain('primary key');
            expect(rowCounts(db)).toEqual(before);
        });
    });

    describe('output formatting', () => {
        it('embeds a parseable SAVE_MANAGE_JSON marker', async () => {
            const seed = seedCampaign(db);
            const result = await handleSaveManage({ action: 'export', worldId: seed.worldId }, ctx);
            const text = result.content[0].text;
            expect(text).toContain('<!-- SAVE_MANAGE_JSON');
            expect(parseResult(result).actionType).toBe('export');
        });
    });
});
