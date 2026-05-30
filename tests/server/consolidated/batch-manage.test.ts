/**
 * Tests for consolidated batch_manage tool
 * Validates all 6 actions: create_characters, create_npcs, distribute_items, execute_workflow, list_templates, get_template
 */

// Import the consolidated barrel FIRST so the full ConsolidatedTools array is
// initialized before buildConsolidatedRegistry() runs (the execute_sequence /
// auto-execute paths build the registry; importing batch-manage in isolation
// would otherwise hit a circular-load partial array).
import { ConsolidatedTools } from '../../../src/server/consolidated/index.js';
import { handleBatchManage, BatchManageTool, WORKFLOW_TEMPLATES } from '../../../src/server/consolidated/batch-manage.js';
import { getDb, closeDb } from '../../../src/storage/index.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { PartyRepository } from '../../../src/storage/repos/party.repo.js';
import { randomUUID } from 'crypto';

void ConsolidatedTools;

process.env.NODE_ENV = 'test';

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
    const text = result.content[0].text;
    const jsonMatch = text.match(/<!-- BATCH_MANAGE_JSON\n([\s\S]*?)\nBATCH_MANAGE_JSON -->/);
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

describe('batch_manage consolidated tool', () => {
    let testCharacterId: string;
    const ctx = { sessionId: 'test-session' };

    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        const now = new Date().toISOString();

        // Create test character for distribution tests
        const charRepo = new CharacterRepository(db);
        testCharacterId = randomUUID();
        charRepo.create({
            id: testCharacterId,
            name: 'Test Character',
            race: 'Human',
            characterClass: 'Fighter',
            characterType: 'pc',
            level: 1,
            hp: 10,
            maxHp: 10,
            ac: 10,
            stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
            inventory: JSON.stringify([]),
            createdAt: now,
            updatedAt: now
        } as any);
    });

    describe('Tool Definition', () => {
        it('should have correct tool name', () => {
            expect(BatchManageTool.name).toBe('batch_manage');
        });

        it('should list all available actions in description', () => {
            expect(BatchManageTool.description).toContain('create_characters');
            expect(BatchManageTool.description).toContain('create_npcs');
            expect(BatchManageTool.description).toContain('distribute_items');
            expect(BatchManageTool.description).toContain('execute_workflow');
            expect(BatchManageTool.description).toContain('list_templates');
            expect(BatchManageTool.description).toContain('get_template');
        });
    });

    describe('create_characters action', () => {
        it('should create multiple characters', async () => {
            const result = await handleBatchManage({
                action: 'create_characters',
                characters: [
                    { name: 'Valeros', class: 'Fighter', race: 'Human' },
                    { name: 'Kyra', class: 'Cleric', race: 'Human' },
                    { name: 'Merisiel', class: 'Rogue', race: 'Elf' }
                ]
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('create_characters');
            expect(data.createdCount).toBe(3);
            expect(data.created.length).toBe(3);
        });

        it('should use default values for missing fields', async () => {
            const result = await handleBatchManage({
                action: 'create_characters',
                characters: [
                    { name: 'Minimal Character' }
                ]
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.created[0].class).toBe('Adventurer');
            expect(data.created[0].race).toBe('Human');
        });

        it('should create characters with full stats', async () => {
            const result = await handleBatchManage({
                action: 'create_characters',
                characters: [
                    {
                        name: 'Strong Hero',
                        class: 'Barbarian',
                        race: 'Half-Orc',
                        level: 5,
                        hp: 55,
                        maxHp: 55,
                        ac: 14,
                        stats: { str: 18, dex: 14, con: 16, int: 8, wis: 10, cha: 10 },
                        characterType: 'pc'
                    }
                ]
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.created[0].name).toBe('Strong Hero');
        });

        it('should return error for empty characters array', async () => {
            const result = await handleBatchManage({
                action: 'create_characters',
                characters: []
            }, ctx);

            // Should return error response (not throw)
            const data = parseResult(result);
            expect(data.error).toBe(true);
        });

        it('should accept "characters" alias', async () => {
            const result = await handleBatchManage({
                action: 'characters',
                characters: [{ name: 'Alias Test' }]
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('create_characters');
        });
    });

    describe('create_npcs action', () => {
        it('should create multiple NPCs', async () => {
            const result = await handleBatchManage({
                action: 'create_npcs',
                locationName: 'Thornwood Village',
                npcs: [
                    { name: 'Marta', role: 'Innkeeper', race: 'Human' },
                    { name: 'Grom', role: 'Blacksmith', race: 'Dwarf' },
                    { name: 'Elara', role: 'Herbalist', race: 'Half-Elf' }
                ]
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('create_npcs');
            expect(data.createdCount).toBe(3);
            expect(data.locationName).toBe('Thornwood Village');
        });

        it('should create NPCs without location', async () => {
            const result = await handleBatchManage({
                action: 'create_npcs',
                npcs: [
                    { name: 'Wandering Merchant', role: 'Merchant' }
                ]
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.locationName).toBeUndefined();
        });

        it('should include behavior in NPC data', async () => {
            const result = await handleBatchManage({
                action: 'create_npcs',
                npcs: [
                    { name: 'Grumpy Guard', role: 'Guard', behavior: 'Suspicious of strangers' }
                ]
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });

        it('should return error for empty npcs array', async () => {
            const result = await handleBatchManage({
                action: 'create_npcs'
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBe(true);
        });

        it('should accept "npcs" alias', async () => {
            const result = await handleBatchManage({
                action: 'npcs',
                npcs: [{ name: 'Test NPC', role: 'Test' }]
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('create_npcs');
        });

        it('should accept "populate" alias', async () => {
            const result = await handleBatchManage({
                action: 'populate',
                locationName: 'Test Town',
                npcs: [{ name: 'Townsperson', role: 'Commoner' }]
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('create_npcs');
        });
    });

    describe('distribute_items action', () => {
        // SKIP(medium): Tests need items pre-created in items table before distribution.
        // distribute_items uses ItemRepository.findById() + InventoryRepository.addItem().
        // Fix: create items via ItemRepository.create() before each test, pass item IDs not names.
        it.skip('should distribute items to character', async () => {
            const result = await handleBatchManage({
                action: 'distribute_items',
                distributions: [
                    { characterId: testCharacterId, items: ['Longsword', 'Chain Mail', 'Shield'] }
                ]
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('distribute_items');
            expect(data.totalItemsDistributed).toBe(3);
            expect(data.distributions[0].itemsGiven).toContain('Longsword');
        });

        // SKIP(medium): Same as above - needs items in items table first
        it.skip('should distribute to multiple characters', async () => {
            // Create another character
            const db = getDb(':memory:');
            const charRepo = new CharacterRepository(db);
            const char2Id = randomUUID();
            charRepo.create({
                id: char2Id,
                name: 'Second Character',
                race: 'Elf',
                characterClass: 'Wizard',
                characterType: 'pc',
                level: 1,
                hp: 6,
                maxHp: 6,
                ac: 10,
                stats: { str: 8, dex: 14, con: 10, int: 16, wis: 12, cha: 10 },
                inventory: JSON.stringify([]),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            } as any);

            const result = await handleBatchManage({
                action: 'distribute_items',
                distributions: [
                    { characterId: testCharacterId, items: ['Longsword'] },
                    { characterId: char2Id, items: ['Staff', 'Spellbook'] }
                ]
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.distributions.length).toBe(2);
            expect(data.totalItemsDistributed).toBe(3);
        });

        it('should handle non-existent character', async () => {
            const result = await handleBatchManage({
                action: 'distribute_items',
                distributions: [
                    { characterId: 'non-existent', items: ['Item'] }
                ]
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(false);
            expect(data.errors.length).toBeGreaterThan(0);
        });

        it('should return error for empty distributions', async () => {
            const result = await handleBatchManage({
                action: 'distribute_items'
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBe(true);
        });

        it('should accept "distribute" alias', async () => {
            const result = await handleBatchManage({
                action: 'distribute',
                distributions: [
                    { characterId: testCharacterId, items: ['Test Item'] }
                ]
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('distribute_items');
        });
    });

    describe('execute_workflow action', () => {
        it('should prepare workflow with parameters', async () => {
            const result = await handleBatchManage({
                action: 'execute_workflow',
                templateId: 'start_campaign',
                params: {
                    worldName: 'Faerun',
                    partyName: 'Heroes of Neverwinter'
                }
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('execute_workflow');
            expect(data.templateId).toBe('start_campaign');
            expect(data.steps.length).toBeGreaterThan(0);
        });

        it('should return error for unknown template', async () => {
            const result = await handleBatchManage({
                action: 'execute_workflow',
                templateId: 'unknown_template'
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBe(true);
            expect(data.availableTemplates).toBeDefined();
        });

        it('should return error for missing required params', async () => {
            const result = await handleBatchManage({
                action: 'execute_workflow',
                templateId: 'start_campaign',
                params: {
                    worldName: 'Test'
                    // Missing partyName
                }
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBe(true);
            expect(data.missingParams).toContain('partyName');
        });

        it('should return error for missing templateId', async () => {
            const result = await handleBatchManage({
                action: 'execute_workflow'
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBe(true);
        });

        it('should accept "workflow" alias', async () => {
            const result = await handleBatchManage({
                action: 'workflow',
                templateId: 'end_session',
                params: { partyId: 'test-party' }
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('execute_workflow');
        });
    });

    describe('execute_workflow autoExecute (Phase 6 PR-1)', () => {
        // RED test 3 registers a transient template with an intentionally failing
        // (unknown-tool) step; clean it up so it never leaks into other tests.
        const FAILING_TEMPLATE_ID = '__test_failing_workflow__';
        afterEach(() => {
            delete WORKFLOW_TEMPLATES[FAILING_TEMPLATE_ID];
        });

        it('autoExecute:true actually EXECUTES the steps (real per-step results + DB writes)', async () => {
            const result = await handleBatchManage({
                action: 'execute_workflow',
                templateId: 'start_campaign',
                params: { worldName: 'Faerun', partyName: 'Heroes of Neverwinter' },
                autoExecute: true
            }, ctx);

            const data = parseResult(result);
            // Routed through the shared sequence engine, NOT prepare-only.
            expect(data.actionType).toBe('execute_sequence');
            expect(data.autoExecuted).toBe(true);
            // Real per-step execution records (not just resolved arg specs).
            expect(Array.isArray(data.steps)).toBe(true);
            expect(data.steps.length).toBe(3);
            expect(data.steps[0]).toHaveProperty('stepIndex');
            expect(data.steps[0]).toHaveProperty('result');
            // It must NOT be the prepare-only message.
            const text = result.content[0].text;
            expect(text).not.toContain('prepared but not auto-executed');

            // Side effect in the in-memory DB: the party step actually created the party.
            const db = getDb(':memory:');
            const partyRepo = new PartyRepository(db);
            const names = partyRepo.findAll().map(p => p.name);
            expect(names).toContain('Heroes of Neverwinter');
        });

        it('without autoExecute → unchanged prepare-only behavior (nothing executed)', async () => {
            const result = await handleBatchManage({
                action: 'execute_workflow',
                templateId: 'start_campaign',
                params: { worldName: 'Faerun', partyName: 'Prep Only Party' }
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('execute_workflow');
            expect(data.message).toBe('Workflow prepared. Execute steps manually.');
            // Resolved arg specs returned, NOT executed-step records.
            expect(data.steps[0]).toHaveProperty('tool');
            expect(data.steps[0]).not.toHaveProperty('result');

            const text = result.content[0].text;
            expect(text).toContain('prepared but not auto-executed');

            // No DB side effects: the party was NOT created.
            const db = getDb(':memory:');
            const partyRepo = new PartyRepository(db);
            const names = partyRepo.findAll().map(p => p.name);
            expect(names).not.toContain('Prep Only Party');
        });

        it('autoExecute:false explicitly → still prepare-only', async () => {
            const result = await handleBatchManage({
                action: 'execute_workflow',
                templateId: 'start_campaign',
                params: { worldName: 'Faerun', partyName: 'Explicit False' },
                autoExecute: false
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('execute_workflow');
            expect(data.message).toBe('Workflow prepared. Execute steps manually.');

            const db = getDb(':memory:');
            const partyRepo = new PartyRepository(db);
            const names = partyRepo.findAll().map(p => p.name);
            expect(names).not.toContain('Explicit False');
        });

        it('autoExecute:true + failing step + stopOnError:true → halts and surfaces the error, later steps do not run', async () => {
            // Transient template: a guaranteed-failing first step (unknown tool),
            // then a party_manage step that must NOT run if execution halts.
            WORKFLOW_TEMPLATES[FAILING_TEMPLATE_ID] = {
                name: 'Failing Workflow',
                description: 'first step fails, second must not run',
                steps: [
                    { tool: 'definitely_not_a_real_tool', args: { action: 'noop' } },
                    { tool: 'party_manage', args: { action: 'create', name: 'ShouldNeverExist' } }
                ],
                requiredParams: []
            };

            const result = await handleBatchManage({
                action: 'execute_workflow',
                templateId: FAILING_TEMPLATE_ID,
                autoExecute: true,
                stopOnError: true
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('execute_sequence');
            expect(data.success).toBe(false);
            expect(data.failureCount).toBeGreaterThan(0);
            // Only the failing step ran; the party step was skipped.
            expect(data.executedSteps).toBe(1);
            expect(data.steps).toHaveLength(1);
            expect(data.steps[0].success).toBe(false);
            expect(data.steps[0].error).toContain('Unknown tool');

            const text = result.content[0].text;
            expect(text).toContain('Execution stopped due to error');

            // The later party step did not run → no such party in the DB.
            const db = getDb(':memory:');
            const partyRepo = new PartyRepository(db);
            const names = partyRepo.findAll().map(p => p.name);
            expect(names).not.toContain('ShouldNeverExist');
        });

        it('template {{param}} substitution flows into the EXECUTED step args', async () => {
            const result = await handleBatchManage({
                action: 'execute_workflow',
                templateId: 'start_campaign',
                params: { worldName: 'Faerun', partyName: 'SubstitutedPartyName' },
                autoExecute: true
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('execute_sequence');

            // The party_manage step received the substituted {{partyName}} value:
            // assert the dispatched tool actually created a party with that exact name.
            const db = getDb(':memory:');
            const partyRepo = new PartyRepository(db);
            const created = partyRepo.findAll().find(p => p.name === 'SubstitutedPartyName');
            expect(created).toBeDefined();
        });
    });

    describe('list_templates action', () => {
        it('should list all available templates', async () => {
            const result = await handleBatchManage({
                action: 'list_templates'
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('list_templates');
            expect(data.templates).toBeDefined();
            expect(data.templates.length).toBeGreaterThan(0);
        });

        it('should include template details', async () => {
            const result = await handleBatchManage({
                action: 'list_templates'
            }, ctx);

            const data = parseResult(result);
            const template = data.templates[0];
            expect(template.id).toBeDefined();
            expect(template.name).toBeDefined();
            expect(template.description).toBeDefined();
            expect(template.requiredParams).toBeDefined();
        });

        it('should accept "templates" alias', async () => {
            const result = await handleBatchManage({
                action: 'templates'
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('list_templates');
        });
    });

    describe('get_template action', () => {
        it('should get template details', async () => {
            const result = await handleBatchManage({
                action: 'get_template',
                templateId: 'start_campaign'
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('get_template');
            expect(data.template.name).toBe('Start Campaign');
            expect(data.template.steps.length).toBeGreaterThan(0);
        });

        it('should return error for unknown template', async () => {
            const result = await handleBatchManage({
                action: 'get_template',
                templateId: 'unknown'
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBe(true);
            expect(data.availableTemplates).toBeDefined();
        });

        it('should return error for missing templateId', async () => {
            const result = await handleBatchManage({
                action: 'get_template'
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBe(true);
        });

        it('should accept "template" alias', async () => {
            const result = await handleBatchManage({
                action: 'template',
                templateId: 'start_campaign'
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('get_template');
        });
    });

    describe('fuzzy matching', () => {
        it('should auto-correct close typos', async () => {
            const result = await handleBatchManage({
                action: 'create_charactr',  // Missing 'e'
                characters: [{ name: 'Typo Test' }]
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('create_characters');
        });

        it('should provide helpful error for unknown action', async () => {
            const result = await handleBatchManage({
                action: 'xyz'
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBe('invalid_action');
            expect(data.message).toContain('Unknown action');
        });
    });

    describe('output formatting', () => {
        it('should include rich text formatting', async () => {
            const result = await handleBatchManage({
                action: 'create_characters',
                characters: [{ name: 'Format Test' }]
            }, ctx);

            const text = result.content[0].text;
            expect(text.toUpperCase()).toContain('CHARACTER');
        });

        it('should embed JSON for parsing', async () => {
            const result = await handleBatchManage({
                action: 'list_templates'
            }, ctx);

            const text = result.content[0].text;
            expect(text).toContain('<!-- BATCH_MANAGE_JSON');
        });
    });
});
