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

    // ════════════════════════════════════════════════════════════════════
    // PHASE-3: QUEST CHAINS
    // ════════════════════════════════════════════════════════════════════
    describe('quest chains (Phase-3)', () => {
        // helper: create a bare quest and return its id
        async function createQuest(name: string, extra: Record<string, unknown> = {}): Promise<string> {
            const res = parseResult(await handleQuestManage({
                action: 'create',
                name,
                description: name,
                worldId: testWorldId,
                objectives: [{ description: 'do it', type: 'custom' }],
                ...extra
            }, ctx));
            return res.questId;
        }

        // helper: assign, complete all objectives, then complete the quest
        async function completeQuest(characterId: string, questId: string) {
            await handleQuestManage({ action: 'assign', characterId, questId }, ctx);
            const objectives = parseResult(await handleQuestManage({ action: 'get', questId }, ctx)).quest.objectives;
            for (const obj of objectives) {
                await handleQuestManage({ action: 'complete_objective', questId, objectiveId: obj.id }, ctx);
            }
            return parseResult(await handleQuestManage({ action: 'complete', characterId, questId }, ctx));
        }

        describe('set_chain', () => {
            it('persists chain and round-trips nextQuests/branches verbatim', async () => {
                const a = await createQuest('Chain A');
                const b = await createQuest('Chain B');
                const c = await createQuest('Chain C');

                const setRes = parseResult(await handleQuestManage({
                    action: 'set_chain',
                    questId: a,
                    chainId: 'epic',
                    order: 0,
                    nextQuests: [b],
                    branches: [
                        { choiceId: 'good', label: 'The good path', questId: b },
                        { choiceId: 'evil', label: 'The evil path', questId: c }
                    ]
                }, ctx));

                expect(setRes.success).toBe(true);
                expect(setRes.actionType).toBe('set_chain');
                expect(setRes.questId).toBe(a);
                expect(setRes.chain.chainId).toBe('epic');
                expect(setRes.chain.order).toBe(0);
                expect(setRes.chain.nextQuests).toEqual([b]);
                expect(setRes.chain.branches).toEqual([
                    { choiceId: 'good', label: 'The good path', questId: b },
                    { choiceId: 'evil', label: 'The evil path', questId: c }
                ]);

                // Reload round-trip: get must return the persisted chain.
                const got = parseResult(await handleQuestManage({ action: 'get', questId: a }, ctx));
                expect(got.quest.chain.chainId).toBe('epic');
                expect(got.quest.chain.nextQuests).toEqual([b]);
                expect(got.quest.chain.branches).toEqual([
                    { choiceId: 'good', label: 'The good path', questId: b },
                    { choiceId: 'evil', label: 'The evil path', questId: c }
                ]);
            });

            it('rejects a nextQuests target that does not exist', async () => {
                const a = await createQuest('Chain A2');
                const res = parseResult(await handleQuestManage({
                    action: 'set_chain',
                    questId: a,
                    nextQuests: ['nonexistent-quest']
                }, ctx));
                expect(res.error).toBe(true);
                expect(res.message).toContain('nonexistent-quest');
            });

            it('rejects a branch target that does not exist', async () => {
                const a = await createQuest('Chain A3');
                const res = parseResult(await handleQuestManage({
                    action: 'set_chain',
                    questId: a,
                    branches: [{ choiceId: 'x', label: 'X', questId: 'ghost-quest' }]
                }, ctx));
                expect(res.error).toBe(true);
                expect(res.message).toContain('ghost-quest');
            });

            it('rejects self-reference in nextQuests', async () => {
                const a = await createQuest('Chain A4');
                const res = parseResult(await handleQuestManage({
                    action: 'set_chain',
                    questId: a,
                    nextQuests: [a]
                }, ctx));
                expect(res.error).toBe(true);
                expect(res.message.toLowerCase()).toContain('itself');
            });

            it('rejects self-reference in a branch', async () => {
                const a = await createQuest('Chain A5');
                const res = parseResult(await handleQuestManage({
                    action: 'set_chain',
                    questId: a,
                    branches: [{ choiceId: 'self', label: 'Self', questId: a }]
                }, ctx));
                expect(res.error).toBe(true);
                expect(res.message.toLowerCase()).toContain('itself');
            });

            it('errors when the source quest does not exist', async () => {
                const res = parseResult(await handleQuestManage({
                    action: 'set_chain',
                    questId: 'no-such-quest',
                    nextQuests: []
                }, ctx));
                expect(res.error).toBe(true);
                expect(res.message).toContain('no-such-quest');
            });
        });

        describe('complete auto-unlock', () => {
            it('flips a gated next quest from locked to available when prereqs are met', async () => {
                const a = await createQuest('Gate A');
                // B requires A as a prerequisite and is the chain.nextQuests of A.
                const b = await createQuest('Gate B', { prerequisites: [a] });
                await handleQuestManage({
                    action: 'set_chain', questId: a, chainId: 'linear', order: 0, nextQuests: [b]
                }, ctx);
                await handleQuestManage({
                    action: 'set_chain', questId: b, chainId: 'linear', order: 1
                }, ctx);

                // Before completing A, B is locked for this character.
                const beforeChain = parseResult(await handleQuestManage({
                    action: 'get_chain', chainId: 'linear', characterId: testCharacterId
                }, ctx));
                const bBefore = beforeChain.quests.find((q: { id: string }) => q.id === b);
                expect(bBefore.unlockState).toBe('locked');

                // Assigning B now must fail (prereq A not completed).
                const assignBefore = parseResult(await handleQuestManage({
                    action: 'assign', characterId: testCharacterId, questId: b
                }, ctx));
                expect(assignBefore.error).toBe(true);

                // Complete A.
                const completeRes = await completeQuest(testCharacterId, a);
                expect(completeRes.success).toBe(true);
                // The complete payload reports B as newly unlocked.
                expect(completeRes.unlockedNext).toContain(b);

                // get_chain now reports B as available.
                const afterChain = parseResult(await handleQuestManage({
                    action: 'get_chain', chainId: 'linear', characterId: testCharacterId
                }, ctx));
                const bAfter = afterChain.quests.find((q: { id: string }) => q.id === b);
                expect(bAfter.unlockState).toBe('available');

                // And assigning B now succeeds.
                const assignAfter = parseResult(await handleQuestManage({
                    action: 'assign', characterId: testCharacterId, questId: b
                }, ctx));
                expect(assignAfter.success).toBe(true);
            });

            it('does NOT bypass an unmet skill gate on a next quest', async () => {
                const a = await createQuest('SkillGate A');
                // B gated behind a skill the character does not have.
                const b = await createQuest('SkillGate B', {
                    prerequisites: [a],
                    skillRequirements: [{ skill: 'crafting', level: 20 }]
                });
                await handleQuestManage({ action: 'set_chain', questId: a, chainId: 'sg', order: 0, nextQuests: [b] }, ctx);
                await handleQuestManage({ action: 'set_chain', questId: b, chainId: 'sg', order: 1 }, ctx);

                const completeRes = await completeQuest(testCharacterId, a);
                expect(completeRes.success).toBe(true);
                // B must NOT appear in unlockedNext because its skill gate is unmet.
                expect(completeRes.unlockedNext ?? []).not.toContain(b);

                // get_chain still reports B as locked.
                const chain = parseResult(await handleQuestManage({
                    action: 'get_chain', chainId: 'sg', characterId: testCharacterId
                }, ctx));
                const bNode = chain.quests.find((q: { id: string }) => q.id === b);
                expect(bNode.unlockState).toBe('locked');

                // Assign still errors with the skill message (chain did not bypass it).
                const assignRes = parseResult(await handleQuestManage({
                    action: 'assign', characterId: testCharacterId, questId: b
                }, ctx));
                expect(assignRes.error).toBe(true);
                expect(assignRes.message).toContain('crafting');
            });
        });

        describe('branching', () => {
            it('does not auto-unlock branch targets; select_branch unlocks only the chosen one', async () => {
                const a = await createQuest('Branch A');
                const good = await createQuest('Good Path', { prerequisites: [a] });
                const evil = await createQuest('Evil Path', { prerequisites: [a] });
                await handleQuestManage({
                    action: 'set_chain',
                    questId: a,
                    chainId: 'moral',
                    order: 0,
                    branches: [
                        { choiceId: 'good', label: 'Good', questId: good },
                        { choiceId: 'evil', label: 'Evil', questId: evil }
                    ]
                }, ctx);

                const completeRes = await completeQuest(testCharacterId, a);
                expect(completeRes.success).toBe(true);
                // Branch quests surfaced for the player to choose, NOT auto-unlocked.
                expect(completeRes.unlockedBranches).toEqual([
                    { choiceId: 'good', label: 'Good', questId: good },
                    { choiceId: 'evil', label: 'Evil', questId: evil }
                ]);
                // Auto-unlock must not have unlocked branch targets directly.
                expect(completeRes.unlockedNext ?? []).not.toContain(good);
                expect(completeRes.unlockedNext ?? []).not.toContain(evil);

                // Player chooses good.
                const sel = parseResult(await handleQuestManage({
                    action: 'select_branch',
                    characterId: testCharacterId,
                    chainId: 'moral',
                    choiceId: 'good'
                }, ctx));
                expect(sel.success).toBe(true);
                expect(sel.chosenQuestId).toBe(good);

                // The good path is now assignable; the evil path is not.
                const assignGood = parseResult(await handleQuestManage({
                    action: 'assign', characterId: testCharacterId, questId: good
                }, ctx));
                expect(assignGood.success).toBe(true);

                const assignEvil = parseResult(await handleQuestManage({
                    action: 'assign', characterId: testCharacterId, questId: evil
                }, ctx));
                expect(assignEvil.error).toBe(true);

                // The choice is recorded on the log.
                const chain = parseResult(await handleQuestManage({
                    action: 'get_chain', chainId: 'moral', characterId: testCharacterId
                }, ctx));
                expect(chain.chainChoices?.moral).toBe('good');
            });

            it('select_branch rejects a choiceId not present in the source quest branches', async () => {
                const a = await createQuest('Branch A2');
                const good = await createQuest('Good Path 2', { prerequisites: [a] });
                await handleQuestManage({
                    action: 'set_chain',
                    questId: a,
                    chainId: 'moral2',
                    order: 0,
                    branches: [{ choiceId: 'good', label: 'Good', questId: good }]
                }, ctx);
                await completeQuest(testCharacterId, a);

                const sel = parseResult(await handleQuestManage({
                    action: 'select_branch',
                    characterId: testCharacterId,
                    chainId: 'moral2',
                    choiceId: 'nonexistent'
                }, ctx));
                expect(sel.error).toBe(true);
                expect(sel.message).toContain('nonexistent');
            });
        });

        describe('get_chain unlockState derivation', () => {
            it('reflects locked/available/active/completed across a linear chain', async () => {
                const a = await createQuest('Linear 1');
                const b = await createQuest('Linear 2', { prerequisites: [a] });
                const c = await createQuest('Linear 3', { prerequisites: [b] });
                await handleQuestManage({ action: 'set_chain', questId: a, chainId: 'lin', order: 0, nextQuests: [b] }, ctx);
                await handleQuestManage({ action: 'set_chain', questId: b, chainId: 'lin', order: 1, nextQuests: [c] }, ctx);
                await handleQuestManage({ action: 'set_chain', questId: c, chainId: 'lin', order: 2 }, ctx);

                // Initial: A available, B & C locked.
                let chain = parseResult(await handleQuestManage({
                    action: 'get_chain', chainId: 'lin', characterId: testCharacterId
                }, ctx));
                const node = (id: string) => chain.quests.find((q: { id: string }) => q.id === id);
                expect(node(a).unlockState).toBe('available');
                expect(node(b).unlockState).toBe('locked');
                expect(node(c).unlockState).toBe('locked');
                // Quests come back ordered by chain.order.
                expect(chain.quests.map((q: { id: string }) => q.id)).toEqual([a, b, c]);

                // Assign A -> active.
                await handleQuestManage({ action: 'assign', characterId: testCharacterId, questId: a }, ctx);
                chain = parseResult(await handleQuestManage({
                    action: 'get_chain', chainId: 'lin', characterId: testCharacterId
                }, ctx));
                expect(node(a).unlockState).toBe('active');

                // Complete A -> A completed, B available.
                await completeQuest(testCharacterId, a);
                chain = parseResult(await handleQuestManage({
                    action: 'get_chain', chainId: 'lin', characterId: testCharacterId
                }, ctx));
                expect(node(a).unlockState).toBe('completed');
                expect(node(b).unlockState).toBe('available');
                expect(node(c).unlockState).toBe('locked');
            });

            it('supports get_chain lookup by questId', async () => {
                const a = await createQuest('ByQuest A');
                const b = await createQuest('ByQuest B');
                await handleQuestManage({ action: 'set_chain', questId: a, chainId: 'byq', order: 0, nextQuests: [b] }, ctx);
                await handleQuestManage({ action: 'set_chain', questId: b, chainId: 'byq', order: 1 }, ctx);

                const chain = parseResult(await handleQuestManage({
                    action: 'get_chain', questId: a, characterId: testCharacterId
                }, ctx));
                expect(chain.success).toBe(true);
                expect(chain.chainId).toBe('byq');
                expect(chain.quests.map((q: { id: string }) => q.id).sort()).toEqual([a, b].sort());
            });
        });

        describe('list_chains', () => {
            it('groups quests by chainId with counts', async () => {
                const a = await createQuest('Group A');
                const b = await createQuest('Group B');
                await handleQuestManage({ action: 'set_chain', questId: a, chainId: 'grp', order: 0, nextQuests: [b] }, ctx);
                await handleQuestManage({ action: 'set_chain', questId: b, chainId: 'grp', order: 1 }, ctx);

                const res = parseResult(await handleQuestManage({ action: 'list_chains', worldId: testWorldId }, ctx));
                expect(res.success).toBe(true);
                const grp = res.chains.find((c: { chainId: string }) => c.chainId === 'grp');
                expect(grp).toBeDefined();
                expect(grp.questCount).toBe(2);
            });
        });

        describe('persistence round-trip', () => {
            it('survives a getDb reload (chain + chainChoices persisted to disk semantics)', async () => {
                const a = await createQuest('Persist A');
                const b = await createQuest('Persist B', { prerequisites: [a] });
                await handleQuestManage({
                    action: 'set_chain',
                    questId: a,
                    chainId: 'persist',
                    order: 0,
                    branches: [{ choiceId: 'pick', label: 'Pick', questId: b }]
                }, ctx);
                await completeQuest(testCharacterId, a);
                await handleQuestManage({
                    action: 'select_branch', characterId: testCharacterId, chainId: 'persist', choiceId: 'pick'
                }, ctx);

                // Re-read via a fresh handler call (repo round-trips through rowToQuest / rowToQuestLog).
                const got = parseResult(await handleQuestManage({ action: 'get', questId: a }, ctx));
                expect(got.quest.chain.chainId).toBe('persist');
                expect(got.quest.chain.branches).toEqual([{ choiceId: 'pick', label: 'Pick', questId: b }]);

                const chain = parseResult(await handleQuestManage({
                    action: 'get_chain', chainId: 'persist', characterId: testCharacterId
                }, ctx));
                expect(chain.chainChoices?.persist).toBe('pick');
            });
        });
    });
});
