/**
 * Tests for consolidated quest_manage tool
 * Validates all 8 actions: create, get, list, assign, update_objective, complete_objective, complete, get_log
 */

import { handleQuestManage, QuestManageTool } from '../../../src/server/consolidated/quest-manage.js';
import { handleSkillManage } from '../../../src/server/consolidated/skill-manage.js';
import { getDb, closeDb } from '../../../src/storage/index.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { randomUUID } from 'crypto';

process.env.NODE_ENV = 'test';

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
    const text = result.content[0].text;
    const jsonMatch = text.match(/<!-- QUEST_MANAGE_JSON\n([\s\S]*?)\nQUEST_MANAGE_JSON -->/);
    if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
    }
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed;
        }
    } catch {
        // Not valid JSON
    }
    return { error: 'parse_failed', rawText: text };
}

describe('quest_manage consolidated tool', () => {
    let testCharacterId: string;
    let testQuestId: string;
    let testWorldId: string;
    const ctx = { sessionId: 'test-session' };

    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        const now = new Date().toISOString();

        // Create a test world (required for foreign key constraint)
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
            updatedAt: now
        });

        // Create a test character
        const characterRepo = new CharacterRepository(db);
        testCharacterId = randomUUID();
        characterRepo.create({
            id: testCharacterId,
            name: 'Test Hero',
            class: 'Fighter',
            level: 5,
            race: 'Human',
            stats: { str: 16, dex: 14, con: 15, int: 10, wis: 12, cha: 8 },
            hp: 45,
            maxHp: 45,
            ac: 18,
            worldId: testWorldId,
            createdAt: now,
            updatedAt: now
        });

        // Create a test quest
        const createResult = await handleQuestManage({
            action: 'create',
            name: 'Slay the Dragon',
            description: 'A dragon terrorizes the village',
            worldId: testWorldId,
            giver: 'Village Elder',
            objectives: [
                { description: 'Find the dragon\'s lair', type: 'explore', target: 'dragon-lair', required: 1 },
                { description: 'Defeat the dragon', type: 'kill', target: 'dragon', required: 1 }
            ],
            rewards: { experience: 500, gold: 100, items: [] }
        }, ctx);
        testQuestId = parseResult(createResult).questId;
    });

    describe('Tool Definition', () => {
        it('should have correct tool name', () => {
            expect(QuestManageTool.name).toBe('quest_manage');
        });

        it('should list all available actions in description', () => {
            expect(QuestManageTool.description).toContain('create');
            expect(QuestManageTool.description).toContain('get');
            expect(QuestManageTool.description).toContain('list');
            expect(QuestManageTool.description).toContain('assign');
            expect(QuestManageTool.description).toContain('update_objective');
            expect(QuestManageTool.description).toContain('complete_objective');
            expect(QuestManageTool.description).toContain('complete');
            expect(QuestManageTool.description).toContain('get_log');
        });

        it('should document objective type enum values in description', () => {
            for (const type of ['kill', 'collect', 'deliver', 'explore', 'interact', 'custom']) {
                expect(QuestManageTool.description).toContain(type);
            }
        });

        it('should document characterId requirement on update_objective', () => {
            expect(QuestManageTool.description).toMatch(/update_objective.*characterId/i);
        });
    });

    describe('create action', () => {
        it('should create a new quest', async () => {
            const result = await handleQuestManage({
                action: 'create',
                name: 'Rescue the Princess',
                description: 'Save the princess from the tower',
                worldId: testWorldId,
                objectives: [
                    { description: 'Find the tower', type: 'explore', target: 'tower', required: 1 }
                ],
                rewards: { experience: 200, gold: 50 }
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('create');
            expect(data.name).toBe('Rescue the Princess');
            expect(data.questId).toBeDefined();
        });

        // #21: objective `type` was required, so omitting it failed validation.
        // It should default to 'custom' (the catch-all) so a quest can be created
        // without the DM guessing the enum.
        it('defaults objective type to "custom" when omitted (#21)', async () => {
            const createResult = await handleQuestManage({
                action: 'create',
                name: 'Find the Cave',
                description: 'Locate the hidden cave',
                worldId: testWorldId,
                objectives: [
                    { description: 'Find the cave' } // no `type`
                ]
            }, ctx);

            const created = parseResult(createResult);
            expect(created.success).toBe(true);
            expect(created.questId).toBeDefined();

            // The stored objective must have defaulted to 'custom'.
            const getResult = await handleQuestManage({ action: 'get', questId: created.questId }, ctx);
            const got = parseResult(getResult);
            expect(got.quest.objectives[0].type).toBe('custom');
        });

        it('should accept "new" alias', async () => {
            const result = await handleQuestManage({
                action: 'new',
                name: 'Alias Quest',
                description: 'Test alias',
                worldId: testWorldId,
                objectives: [{ description: 'Test', type: 'custom', target: 'test', required: 1 }]
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('create');
        });
    });

    describe('get action', () => {
        it('should get quest by ID', async () => {
            const result = await handleQuestManage({
                action: 'get',
                questId: testQuestId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('get');
            expect(data.quest.name).toBe('Slay the Dragon');
        });

        it('should return error for non-existent quest', async () => {
            const result = await handleQuestManage({
                action: 'get',
                questId: 'non-existent'
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBe(true);
        });

        it('should accept "fetch" alias', async () => {
            const result = await handleQuestManage({
                action: 'fetch',
                questId: testQuestId
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('get');
        });

        // create persists skillRequirements; get must return them so the
        // create→get round-trip is lossless (regression: get dropped them).
        it('returns skillRequirements created on the quest (round-trip parity)', async () => {
            const created = parseResult(await handleQuestManage({
                action: 'create',
                name: 'Arcane Trial',
                description: 'Prove your magical aptitude',
                worldId: testWorldId,
                objectives: [{ description: 'Cast the rite', type: 'custom' }],
                skillRequirements: [
                    { skill: 'magic', level: 30 },
                    { skill: 'social', level: 5 }
                ]
            }, ctx));

            const got = parseResult(await handleQuestManage({
                action: 'get',
                questId: created.questId
            }, ctx));

            expect(got.success).toBe(true);
            expect(got.quest.skillRequirements).toEqual([
                { skill: 'magic', level: 30 },
                { skill: 'social', level: 5 }
            ]);
        });
    });

    describe('list action', () => {
        it('should list all quests', async () => {
            const result = await handleQuestManage({
                action: 'list'
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('list');
            expect(data.count).toBeGreaterThanOrEqual(1);
        });

        it('should filter by worldId', async () => {
            const result = await handleQuestManage({
                action: 'list',
                worldId: testWorldId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.quests.every((q: any) => q.worldId === testWorldId)).toBe(true);
        });

        it('should accept "all" alias', async () => {
            const result = await handleQuestManage({
                action: 'all'
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('list');
        });
    });

    describe('assign action', () => {
        it('should assign quest to character', async () => {
            const result = await handleQuestManage({
                action: 'assign',
                characterId: testCharacterId,
                questId: testQuestId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('assign');
            expect(data.questName).toBe('Slay the Dragon');
            expect(data.characterName).toBe('Test Hero');
        });

        it('should prevent duplicate assignment', async () => {
            // First assignment
            await handleQuestManage({
                action: 'assign',
                characterId: testCharacterId,
                questId: testQuestId
            }, ctx);

            // Duplicate attempt
            const result = await handleQuestManage({
                action: 'assign',
                characterId: testCharacterId,
                questId: testQuestId
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBe(true);
        });

        it('should accept "accept" alias', async () => {
            const result = await handleQuestManage({
                action: 'accept',
                characterId: testCharacterId,
                questId: testQuestId
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('assign');
        });
    });

    describe('assign with skillRequirements (Phase-3 gate)', () => {
        it('rejects assign when the character does not meet a skill gate', async () => {
            const created = parseResult(await handleQuestManage({
                action: 'create',
                name: 'Master Smith',
                description: 'Forge a legendary blade',
                worldId: testWorldId,
                objectives: [{ description: 'Forge', type: 'custom' }],
                skillRequirements: [{ skill: 'crafting', level: 20 }]
            }, ctx));

            const result = await handleQuestManage({
                action: 'assign',
                characterId: testCharacterId,
                questId: created.questId
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBe(true);
            expect(data.message).toContain('crafting');
            expect(data.message).toContain('20');
            expect(data.message).toContain('1'); // current level
        });

        it('permits assign once the character meets the skill gate', async () => {
            const created = parseResult(await handleQuestManage({
                action: 'create',
                name: 'Master Smith II',
                description: 'Forge a legendary blade',
                worldId: testWorldId,
                objectives: [{ description: 'Forge', type: 'custom' }],
                skillRequirements: [{ skill: 'crafting', level: 20 }]
            }, ctx));

            // Seed the character's crafting skill to meet the gate.
            await handleSkillManage({
                action: 'set_level',
                characterId: testCharacterId,
                skill: 'crafting',
                level: 20
            }, ctx);

            const result = await handleQuestManage({
                action: 'assign',
                characterId: testCharacterId,
                questId: created.questId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('assign');
        });
    });

    describe('update_objective action', () => {
        beforeEach(async () => {
            // Assign quest first
            await handleQuestManage({
                action: 'assign',
                characterId: testCharacterId,
                questId: testQuestId
            }, ctx);
        });

        it('should update objective progress', async () => {
            // Get objective ID
            const getResult = await handleQuestManage({
                action: 'get',
                questId: testQuestId
            }, ctx);
            const objectiveId = parseResult(getResult).quest.objectives[0].id;

            const result = await handleQuestManage({
                action: 'update_objective',
                characterId: testCharacterId,
                questId: testQuestId,
                objectiveId: objectiveId,
                progress: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('update_objective');
            expect(data.objective.current).toBeGreaterThan(0);
        });

        it('should accept "progress" alias', async () => {
            const getResult = await handleQuestManage({
                action: 'get',
                questId: testQuestId
            }, ctx);
            const objectiveId = parseResult(getResult).quest.objectives[0].id;

            const result = await handleQuestManage({
                action: 'progress',
                characterId: testCharacterId,
                questId: testQuestId,
                objectiveId: objectiveId,
                progress: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('update_objective');
        });
    });

    describe('complete_objective action', () => {
        it('should mark objective as complete', async () => {
            // Get objective ID
            const getResult = await handleQuestManage({
                action: 'get',
                questId: testQuestId
            }, ctx);
            const objectiveId = parseResult(getResult).quest.objectives[0].id;

            const result = await handleQuestManage({
                action: 'complete_objective',
                questId: testQuestId,
                objectiveId: objectiveId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('complete_objective');
            expect(data.objective.completed).toBe(true);
        });

        it('should accept "finish_objective" alias', async () => {
            const getResult = await handleQuestManage({
                action: 'get',
                questId: testQuestId
            }, ctx);
            const objectiveId = parseResult(getResult).quest.objectives[1].id;

            const result = await handleQuestManage({
                action: 'finish_objective',
                questId: testQuestId,
                objectiveId: objectiveId
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('complete_objective');
        });
    });

    describe('complete action', () => {
        beforeEach(async () => {
            // Assign quest
            await handleQuestManage({
                action: 'assign',
                characterId: testCharacterId,
                questId: testQuestId
            }, ctx);

            // Complete all objectives
            const getResult = await handleQuestManage({
                action: 'get',
                questId: testQuestId
            }, ctx);
            const objectives = parseResult(getResult).quest.objectives;

            for (const obj of objectives) {
                await handleQuestManage({
                    action: 'complete_objective',
                    questId: testQuestId,
                    objectiveId: obj.id
                }, ctx);
            }
        });

        it('should complete quest and grant rewards', async () => {
            const result = await handleQuestManage({
                action: 'complete',
                characterId: testCharacterId,
                questId: testQuestId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('complete');
            expect(data.rewards.xp).toBe(500);
            expect(data.rewards.gold).toBe(100);
        });

        it('should accept "finish" alias', async () => {
            const result = await handleQuestManage({
                action: 'finish',
                characterId: testCharacterId,
                questId: testQuestId
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('complete');
        });
    });

    describe('get_log action', () => {
        it('should get character quest log', async () => {
            // Assign a quest first
            await handleQuestManage({
                action: 'assign',
                characterId: testCharacterId,
                questId: testQuestId
            }, ctx);

            const result = await handleQuestManage({
                action: 'get_log',
                characterId: testCharacterId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('get_log');
            expect(data.characterName).toBe('Test Hero');
            expect(data.summary.active).toBeGreaterThanOrEqual(1);
        });

        it('should accept "log" alias', async () => {
            const result = await handleQuestManage({
                action: 'log',
                characterId: testCharacterId
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('get_log');
        });
    });

    describe('fuzzy matching', () => {
        it('should auto-correct close typos', async () => {
            const result = await handleQuestManage({
                action: 'creat',  // Missing 'e'
                name: 'Fuzzy Quest',
                description: 'Test fuzzy',
                worldId: testWorldId,
                objectives: [{ description: 'Test', type: 'custom', target: 'test', required: 1 }]
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('create');
        });

        it('should provide helpful error for unknown action', async () => {
            const result = await handleQuestManage({
                action: 'xyz'
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBe('invalid_action');
            expect(data.message).toContain('Unknown action');
        });
    });

    describe('output formatting', () => {
        it('should include rich text formatting', async () => {
            const result = await handleQuestManage({
                action: 'get',
                questId: testQuestId
            }, ctx);

            const text = result.content[0].text;
            expect(text).toContain('📜');
        });

        it('should embed JSON for parsing', async () => {
            const result = await handleQuestManage({
                action: 'list'
            }, ctx);

            const text = result.content[0].text;
            expect(text).toContain('<!-- QUEST_MANAGE_JSON');
        });
    });
});
