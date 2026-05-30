/**
 * Consolidated batch_manage tool
 * Replaces: batch_create_characters, batch_create_npcs, batch_distribute_items, execute_workflow, list_templates, get_template
 * 6 tools → 1 tool with 6 actions
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { matchAction, isGuidingError } from '../../utils/fuzzy-enum.js';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { resolveConsolidatedDbPath } from './db-path.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { InventoryRepository } from '../../storage/repos/inventory.repo.js';
import { ItemRepository } from '../../storage/repos/item.repo.js';
import { SessionContext } from '../types.js';
import { ToolContract } from '../tool-metadata.js';

export interface McpResponse {
    content: Array<{ type: 'text'; text: string }>;
}

const ACTIONS = [
    'create_characters', 'create_npcs', 'distribute_items',
    'execute_workflow', 'list_templates', 'get_template', 'execute_sequence'
] as const;

type BatchAction = typeof ACTIONS[number];

// Alias map for fuzzy action matching
const ALIASES: Record<string, BatchAction> = {
    'characters': 'create_characters',
    'batch_characters': 'create_characters',
    'create_party': 'create_characters',
    'spawn_characters': 'create_characters',
    'npcs': 'create_npcs',
    'batch_npcs': 'create_npcs',
    'populate': 'create_npcs',
    'spawn_npcs': 'create_npcs',
    'distribute': 'distribute_items',
    'give_items': 'distribute_items',
    'equip_all': 'distribute_items',
    'batch_items': 'distribute_items',
    'workflow': 'execute_workflow',
    'execute': 'execute_workflow',
    'run_workflow': 'execute_workflow',
    'run': 'execute_workflow',
    'templates': 'list_templates',
    'list_workflows': 'list_templates',
    'available': 'list_templates',
    'template': 'get_template',
    'get_workflow': 'get_template',
    'show_template': 'get_template',
    'sequence': 'execute_sequence',
    'run_sequence': 'execute_sequence',
    'pipeline': 'execute_sequence',
    'chain': 'execute_sequence',
    'multi_tool': 'execute_sequence'
};

function ensureDb() {
    const dbPath = resolveConsolidatedDbPath();
    const db = getDb(dbPath);
    return {
        db,
        charRepo: new CharacterRepository(db)
    };
}

// Workflow templates
// Exported so tests can register transient templates (e.g. an intentionally
// failing step) to exercise the auto-execute path without polluting the
// built-in template set at runtime.
export const WORKFLOW_TEMPLATES: Record<string, {
    name: string;
    description: string;
    // `id` is optional and, when present, is PRESERVED through to runSteps so
    // inter-step {{thatId.prop}} references can target a template-authored id
    // (not just the positional `step{n}` default).
    steps: Array<{ tool: string; args: Record<string, any>; id?: string }>;
    requiredParams: string[];
}> = {
    'start_campaign': {
        name: 'Start Campaign',
        description: 'Create a new world, party, and starting location',
        // world_manage `generate` requires seed/width/height (GenerateSchema). The
        // previous template omitted width/height and left seed as an unsupplied
        // {{seed}} param, so the step ALWAYS failed validation — a failure that
        // was silently masked while the executor mis-parsed every result as
        // { raw: text } (fake success). With the result parser fixed, the step
        // is supplied valid defaults so the workflow runs end to end.
        steps: [
            { tool: 'world_manage', args: { action: 'generate', seed: '{{worldName}}', width: 50, height: 50 } },
            { tool: 'party_manage', args: { action: 'create', name: '{{partyName}}' } },
            { tool: 'spawn_manage', args: { action: 'spawn_preset_location', preset: 'generic_tavern' } }
        ],
        requiredParams: ['worldName', 'partyName']
    },
    'setup_encounter': {
        name: 'Setup Encounter',
        description: 'Create an encounter with enemies and position party',
        steps: [
            { tool: 'spawn_manage', args: { action: 'spawn_encounter', preset: '{{encounterPreset}}', partyId: '{{partyId}}' } }
        ],
        requiredParams: ['encounterPreset', 'partyId']
    },
    'end_session': {
        name: 'End Session',
        description: 'Save state and rest party',
        steps: [
            { tool: 'travel_manage', args: { action: 'rest', partyId: '{{partyId}}', restType: 'long' } },
            { tool: 'session_manage', args: { action: 'get_context', partyId: '{{partyId}}' } }
        ],
        requiredParams: ['partyId']
    }
};

// Character schema for batch creation
const BatchCharacterSchema = z.object({
    name: z.string().min(1),
    class: z.string().optional().default('Adventurer'),
    race: z.string().optional().default('Human'),
    level: z.number().int().min(1).optional().default(1),
    hp: z.number().int().min(1).optional(),
    maxHp: z.number().int().min(1).optional(),
    ac: z.number().int().min(0).optional().default(10),
    stats: z.object({
        str: z.number().int().min(0).default(10),
        dex: z.number().int().min(0).default(10),
        con: z.number().int().min(0).default(10),
        int: z.number().int().min(0).default(10),
        wis: z.number().int().min(0).default(10),
        cha: z.number().int().min(0).default(10)
    }).optional(),
    characterType: z.enum(['pc', 'npc', 'enemy', 'ally']).optional().default('pc'),
    background: z.string().optional()
});

// NPC schema for batch creation
const BatchNpcSchema = z.object({
    name: z.string().min(1),
    role: z.string().describe('NPC profession or role'),
    race: z.string().optional().default('Human'),
    behavior: z.string().optional().describe('NPC personality'),
    factionId: z.string().optional()
});

// Input schema
const BatchManageInputSchema = z.object({
    action: z.string().describe('Action: create_characters, create_npcs, distribute_items, execute_workflow, list_templates, get_template'),

    // create_characters fields
    characters: z.array(BatchCharacterSchema).max(20).optional()
        .describe('Array of characters to create (1-20)'),

    // create_npcs fields
    locationName: z.string().optional().describe('Location for NPCs'),
    npcs: z.array(BatchNpcSchema).max(50).optional()
        .describe('Array of NPCs to create (1-50)'),

    // distribute_items fields
    distributions: z.array(z.object({
        characterId: z.string().describe('Character ID'),
        items: z.array(z.string()).min(1).describe('Items to give')
    })).max(20).optional().describe('Item distributions (1-20)'),

    // workflow fields
    templateId: z.string().optional().describe('Workflow template ID'),
    params: z.record(z.string(), z.any()).optional().describe('Template parameters'),
    autoExecute: z.boolean().optional().default(false)
        .describe('execute_workflow: if true, actually run the resolved steps through the sequence engine. Default false = prepare-only (returns resolved steps without running them).'),

    // execute_sequence fields
    steps: z.array(z.object({
        tool: z.string().describe('Tool name (e.g., "character_manage", "item_manage")'),
        args: z.record(z.any()).describe('Tool arguments'),
        id: z.string().optional().describe('Step ID for referencing results in later steps')
    })).max(10).optional().describe('Sequence of tools to execute (1-10)'),
    stopOnError: z.boolean().optional().default(true).describe('Stop execution if a step fails')
});

type BatchManageInput = z.infer<typeof BatchManageInputSchema>;

// Action handlers
async function handleCreateCharacters(input: BatchManageInput, _ctx: SessionContext): Promise<McpResponse> {
    if (!input.characters || input.characters.length === 0) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('create_characters requires characters array') +
                    RichFormatter.embedJson({ error: true, message: 'characters required' }, 'BATCH_MANAGE')
            }]
        };
    }

    const { charRepo } = ensureDb();
    const now = new Date().toISOString();

    const createdCharacters: Array<{ id: string; name: string; class: string; race: string; characterType: string }> = [];
    const errors: string[] = [];

    for (const charData of input.characters) {
        try {
            const stats = charData.stats ?? { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
            const conModifier = Math.floor((stats.con - 10) / 2);
            const baseHp = Math.max(1, 8 + conModifier);
            const hp = charData.hp ?? baseHp;
            const maxHp = charData.maxHp ?? hp;

            const character = {
                id: randomUUID(),
                name: charData.name,
                race: charData.race,
                characterClass: charData.class || 'Adventurer',
                characterType: charData.characterType,
                level: charData.level,
                stats,
                hp,
                maxHp,
                ac: charData.ac,
                background: charData.background,
                createdAt: now,
                updatedAt: now
            };

            charRepo.create(character as any);
            createdCharacters.push({
                id: character.id,
                name: charData.name,
                class: charData.class,
                race: charData.race,
                characterType: charData.characterType
            });
        } catch (err: unknown) {
            errors.push(`Failed to create ${charData.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    let output = RichFormatter.header('Characters Created', '👥');
    const rows = createdCharacters.map(c => [c.name, c.class, c.race, c.characterType]);
    output += RichFormatter.table(['Name', 'Class', 'Race', 'Type'], rows);
    output += `\n*${createdCharacters.length} character(s) created*\n`;

    if (errors.length > 0) {
        output += RichFormatter.section('Errors');
        output += RichFormatter.list(errors);
    }

    const result = {
        success: errors.length === 0,
        actionType: 'create_characters',
        created: createdCharacters,
        createdCount: createdCharacters.length,
        errors: errors.length > 0 ? errors : undefined
    };

    output += RichFormatter.embedJson(result, 'BATCH_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

async function handleCreateNpcs(input: BatchManageInput, _ctx: SessionContext): Promise<McpResponse> {
    if (!input.npcs || input.npcs.length === 0) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('create_npcs requires npcs array') +
                    RichFormatter.embedJson({ error: true, message: 'npcs required' }, 'BATCH_MANAGE')
            }]
        };
    }

    const { charRepo } = ensureDb();
    const now = new Date().toISOString();

    const createdNpcs: Array<{ id: string; name: string; role: string; race: string; location?: string }> = [];
    const errors: string[] = [];

    for (const npcData of input.npcs) {
        try {
            const npc = {
                id: randomUUID(),
                name: npcData.name,
                race: npcData.race,
                characterClass: npcData.role,
                characterType: 'npc' as const,
                behavior: npcData.behavior,
                factionId: npcData.factionId,
                hp: 10,
                maxHp: 10,
                ac: 10,
                level: 1,
                stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
                createdAt: now,
                updatedAt: now,
                metadata: input.locationName ? JSON.stringify({ location: input.locationName }) : undefined
            };

            charRepo.create(npc as any);
            createdNpcs.push({
                id: npc.id,
                name: npcData.name,
                role: npcData.role,
                race: npcData.race,
                location: input.locationName
            });
        } catch (err: unknown) {
            errors.push(`Failed to create NPC ${npcData.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    let output = RichFormatter.header('NPCs Created', '🧑');
    if (input.locationName) {
        output += RichFormatter.keyValue({ 'Location': input.locationName });
    }
    const rows = createdNpcs.map(n => [n.name, n.role, n.race]);
    output += RichFormatter.table(['Name', 'Role', 'Race'], rows);
    output += `\n*${createdNpcs.length} NPC(s) created*\n`;

    if (errors.length > 0) {
        output += RichFormatter.section('Errors');
        output += RichFormatter.list(errors);
    }

    const result = {
        success: errors.length === 0,
        actionType: 'create_npcs',
        locationName: input.locationName,
        created: createdNpcs,
        createdCount: createdNpcs.length,
        errors: errors.length > 0 ? errors : undefined
    };

    output += RichFormatter.embedJson(result, 'BATCH_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

async function handleDistributeItems(input: BatchManageInput, _ctx: SessionContext): Promise<McpResponse> {
    if (!input.distributions || input.distributions.length === 0) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('distribute_items requires distributions array') +
                    RichFormatter.embedJson({ error: true, message: 'distributions required' }, 'BATCH_MANAGE')
            }]
        };
    }

    const { db, charRepo } = ensureDb();
    const inventoryRepo = new InventoryRepository(db);
    const itemRepo = new ItemRepository(db);

    const distributions: Array<{ characterId: string; characterName: string; itemsGiven: string[]; newInventorySize: number }> = [];
    const errors: string[] = [];

    for (const dist of input.distributions) {
        try {
            const character = charRepo.findById(dist.characterId);

            if (!character) {
                errors.push(`Character not found: ${dist.characterId}`);
                continue;
            }

            const itemsAdded: string[] = [];
            const itemErrors: string[] = [];

            for (const itemId of dist.items) {
                // Verify item exists in the items table
                const item = itemRepo.findById(itemId);
                if (!item) {
                    itemErrors.push(`Item not found: ${itemId}`);
                    continue;
                }

                // Use the proper repository method to add item
                inventoryRepo.addItem(dist.characterId, itemId, 1);
                itemsAdded.push(item.name);
            }

            if (itemsAdded.length > 0) {
                // Get updated inventory size
                const inventory = inventoryRepo.getInventory(dist.characterId);
                distributions.push({
                    characterId: dist.characterId,
                    characterName: character.name,
                    itemsGiven: itemsAdded,
                    newInventorySize: inventory.items.length
                });
            }

            if (itemErrors.length > 0) {
                errors.push(...itemErrors.map(e => `${character.name}: ${e}`));
            }
        } catch (err: unknown) {
            errors.push(`Failed to distribute to ${dist.characterId}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    const totalItems = distributions.reduce((sum, d) => sum + d.itemsGiven.length, 0);

    let output = RichFormatter.header('Items Distributed', '🎁');
    output += RichFormatter.keyValue({ 'Total Items': totalItems, 'Recipients': distributions.length });

    for (const dist of distributions) {
        output += `\n**${dist.characterName}**: ${dist.itemsGiven.join(', ')}\n`;
    }

    if (errors.length > 0) {
        output += RichFormatter.section('Errors');
        output += RichFormatter.list(errors);
    }

    const result = {
        success: errors.length === 0,
        actionType: 'distribute_items',
        distributions,
        totalItemsDistributed: totalItems,
        errors: errors.length > 0 ? errors : undefined
    };

    output += RichFormatter.embedJson(result, 'BATCH_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

async function handleExecuteWorkflow(input: BatchManageInput, _ctx: SessionContext): Promise<McpResponse> {
    if (!input.templateId) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('execute_workflow requires templateId') +
                    RichFormatter.embedJson({ error: true, message: 'templateId required' }, 'BATCH_MANAGE')
            }]
        };
    }

    const template = WORKFLOW_TEMPLATES[input.templateId];
    if (!template) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error(`Unknown workflow template: ${input.templateId}`) +
                    RichFormatter.embedJson({
                        error: true,
                        message: `Unknown template: ${input.templateId}`,
                        availableTemplates: Object.keys(WORKFLOW_TEMPLATES)
                    }, 'BATCH_MANAGE')
            }]
        };
    }

    // Check required params. Test for key PRESENCE, not truthiness: `!params[p]`
    // would reject legitimately-supplied falsy values (0, false, ''), so a
    // template whose required param is meant to be `0`/`false`/`''` could never
    // run. A param counts as supplied when the key exists and is not `undefined`.
    const params = input.params || {};
    const missingParams = template.requiredParams.filter(
        p => !Object.prototype.hasOwnProperty.call(params, p) || params[p] === undefined
    );
    if (missingParams.length > 0) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error(`Missing required parameters: ${missingParams.join(', ')}`) +
                    RichFormatter.embedJson({
                        error: true,
                        message: 'Missing parameters',
                        missingParams,
                        requiredParams: template.requiredParams
                    }, 'BATCH_MANAGE')
            }]
        };
    }

    // Substitute template {{param}} placeholders with the caller's params BEFORE
    // execution. Only placeholders that name an ACTUAL caller param are
    // substituted here; anything else (notably inter-step {{stepId.prop}}
    // references) is left intact so the shared executor can resolve it later
    // during the run. Previously this pass clobbered EVERY `{{...}}` string,
    // turning inter-step references into `undefined` before the executor ever
    // saw them — so cross-step passing never worked through the workflow path.
    // Deeply substitute caller {{param}} placeholders inside args, walking
    // nested objects AND arrays (the previous pass only handled top-level string
    // args, so a {{partyName}} nested one level deep never resolved). A pure
    // `{{name}}` string is replaced only when `name` is an ACTUAL caller param;
    // anything else (notably inter-step {{stepId.prop}} references, which are NOT
    // caller params) is left intact for the shared executor to resolve at run time.
    const resolveTemplateValue = (value: unknown): unknown => {
        if (
            typeof value === 'string' &&
            value.startsWith('{{') &&
            value.endsWith('}}')
        ) {
            // Only treat `{{key}}` as a CALLER PARAM when `key` is a plain name
            // (no `.`, no `[`) AND is an actually-supplied param. Inter-step
            // references contain a `.`/`[` (e.g. `{{A.party.id}}`,
            // `{{A.created[0].id}}`); substituting those here would clobber the
            // reference with a caller value (or `undefined`) BEFORE the shared
            // executor's {{stepId.prop}} resolver ever sees it, so cross-step
            // passing through the workflow path would silently break.
            // (CodeRabbit round-4 @498 — Minor.)
            const key = value.slice(2, -2).trim();
            const isCallerParam =
                !key.includes('.') && !key.includes('[') &&
                Object.prototype.hasOwnProperty.call(params, key) && params[key] !== undefined;
            return isCallerParam ? params[key] : value;
        }
        if (Array.isArray(value)) {
            return value.map(resolveTemplateValue);
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(
                Object.entries(value as Record<string, unknown>).map(
                    ([k, v]) => [k, resolveTemplateValue(v)]
                )
            );
        }
        return value;
    };

    // Preserve any template-authored step `id` so inter-step {{id.prop}}
    // references can target it; runSteps falls back to `step{n}` when absent.
    const resolvedSteps = template.steps.map(step => ({
        tool: step.tool,
        id: step.id,
        args: resolveTemplateValue(step.args) as Record<string, unknown>
    }));

    // Opt-in auto-execute: route the resolved steps through the SAME engine
    // execute_sequence uses. Default (autoExecute=false) preserves the original
    // prepare-only / dry-run behavior for backward compatibility.
    if (input.autoExecute) {
        const stopOnError = input.stopOnError ?? true;

        let output = RichFormatter.header(`Workflow: ${template.name}`, '⚙️');
        output += `*${template.description}*\n\n`;
        output += `*Auto-executing ${resolvedSteps.length} step(s)...*\n\n`;

        // runSteps rejects duplicate normalized step ids up front (before any
        // step runs). Surface that as a BATCH_MANAGE error envelope; nothing was
        // partially executed. actionType stays 'execute_workflow' (the caller's
        // action identity), consistent with the success path below.
        let run: RunStepsResult;
        try {
            run = await runSteps(resolvedSteps as RunnableStep[], _ctx, { stopOnError });
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                content: [{
                    type: 'text',
                    text: RichFormatter.error(message) +
                        RichFormatter.embedJson({
                            error: true,
                            message,
                            actionType: 'execute_workflow',
                            templateId: input.templateId,
                            templateName: template.name
                        }, 'BATCH_MANAGE')
                }]
            };
        }
        output += run.output;

        output += RichFormatter.section('Summary');
        output += RichFormatter.keyValue({
            'Total Steps': resolvedSteps.length,
            'Executed': run.executedSteps.length,
            'Succeeded': run.successCount,
            'Failed': run.failureCount
        });

        const resultPayload = {
            success: run.failureCount === 0,
            // The caller invoked `execute_workflow`; even though we route through
            // the shared sequence executor, the machine-readable actionType must
            // stay stable for clients that branch on it. `autoExecuted: true`
            // distinguishes the run mode without changing the action's identity.
            // (The standalone `execute_sequence` action keeps actionType
            // 'execute_sequence' — see handleExecuteSequence.)
            actionType: 'execute_workflow',
            templateId: input.templateId,
            templateName: template.name,
            autoExecuted: true,
            totalSteps: resolvedSteps.length,
            executedSteps: run.executedSteps.length,
            successCount: run.successCount,
            failureCount: run.failureCount,
            steps: run.executedSteps,
            stepResults: Object.fromEntries(run.stepResults)
        };

        output += RichFormatter.embedJson(resultPayload, 'BATCH_MANAGE');

        return { content: [{ type: 'text', text: output }] };
    }

    let output = RichFormatter.header(`Workflow: ${template.name}`, '⚙️');
    output += `*${template.description}*\n\n`;

    output += RichFormatter.section('Steps to Execute');
    for (let i = 0; i < resolvedSteps.length; i++) {
        const step = resolvedSteps[i];
        output += `${i + 1}. \`${step.tool}\` with action: ${step.args.action || 'default'}\n`;
    }

    output += '\n*Note: Workflow prepared but not auto-executed. Call each tool step manually for safety.*\n';

    const result = {
        success: true,
        actionType: 'execute_workflow',
        templateId: input.templateId,
        templateName: template.name,
        steps: resolvedSteps,
        message: 'Workflow prepared. Execute steps manually.'
    };

    output += RichFormatter.embedJson(result, 'BATCH_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

async function handleListTemplates(_input: BatchManageInput, _ctx: SessionContext): Promise<McpResponse> {
    const templates = Object.entries(WORKFLOW_TEMPLATES).map(([id, t]) => ({
        id,
        name: t.name,
        description: t.description,
        requiredParams: t.requiredParams,
        stepCount: t.steps.length
    }));

    let output = RichFormatter.header('Workflow Templates', '📋');

    for (const t of templates) {
        output += `\n**${t.name}** (\`${t.id}\`)\n`;
        output += `${t.description}\n`;
        output += `Steps: ${t.stepCount} | Params: ${t.requiredParams.join(', ') || 'none'}\n`;
    }

    const result = {
        success: true,
        actionType: 'list_templates',
        templates,
        count: templates.length
    };

    output += RichFormatter.embedJson(result, 'BATCH_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

async function handleGetTemplate(input: BatchManageInput, _ctx: SessionContext): Promise<McpResponse> {
    if (!input.templateId) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('get_template requires templateId') +
                    RichFormatter.embedJson({ error: true, message: 'templateId required' }, 'BATCH_MANAGE')
            }]
        };
    }

    const template = WORKFLOW_TEMPLATES[input.templateId];
    if (!template) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error(`Unknown template: ${input.templateId}`) +
                    RichFormatter.embedJson({
                        error: true,
                        message: `Unknown template: ${input.templateId}`,
                        availableTemplates: Object.keys(WORKFLOW_TEMPLATES)
                    }, 'BATCH_MANAGE')
            }]
        };
    }

    let output = RichFormatter.header(template.name, '📄');
    output += `*${template.description}*\n\n`;

    output += RichFormatter.section('Required Parameters');
    if (template.requiredParams.length > 0) {
        output += RichFormatter.list(template.requiredParams);
    } else {
        output += '*None*\n';
    }

    output += RichFormatter.section('Steps');
    for (let i = 0; i < template.steps.length; i++) {
        const step = template.steps[i];
        output += `${i + 1}. **${step.tool}**\n`;
        output += `   Args: ${JSON.stringify(step.args)}\n`;
    }

    const result = {
        success: true,
        actionType: 'get_template',
        templateId: input.templateId,
        template: {
            name: template.name,
            description: template.description,
            requiredParams: template.requiredParams,
            steps: template.steps
        }
    };

    output += RichFormatter.embedJson(result, 'BATCH_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

/**
 * Resolve parameter references like {{step1.characterId}} from previous step results
 */
function resolveStepReferences(
    args: Record<string, unknown>,
    stepResults: Map<string, unknown>
): Record<string, unknown> {
    return resolveValue(args, stepResults) as Record<string, unknown>;
}

/**
 * Resolve {{stepId.property}} references inside any value, preserving structure.
 *
 * Arrays must stay arrays — the previous implementation rebuilt every object
 * (including arrays) via Object.entries into a plain object, turning
 * `distributions: [ {...} ]` into `distributions: { "0": {...} }` and breaking
 * downstream Zod array schemas. This walker keeps arrays as arrays and only
 * substitutes string values that are pure `{{...}}` references.
 */
function resolveValue(value: unknown, stepResults: Map<string, unknown>): unknown {
    if (typeof value === 'string' && value.startsWith('{{') && value.endsWith('}}')) {
        // Extract reference like "step1.characterId" or "step1.created[0].id"
        const refPath = value.slice(2, -2).trim();
        const dotIndex = refPath.indexOf('.');
        if (dotIndex > 0) {
            const stepId = refPath.slice(0, dotIndex);
            const propertyPath = refPath.slice(dotIndex + 1);

            const stepResult = stepResults.get(stepId);
            if (stepResult) {
                // Navigate the property path (supports array indexing like created[0].id).
                // If the property does NOT exist on the prior step result,
                // getNestedValue returns undefined — keep the original {{...}}
                // literal instead of silently nulling the downstream arg, so an
                // unresolvable reference stays explicit (and fails loudly at the
                // consuming tool) rather than mutating args to undefined.
                const resolved = getNestedValue(stepResult as Record<string, unknown>, propertyPath);
                return resolved === undefined ? value : resolved;
            }
            // Reference not found (no such step), keep original
            return value;
        }
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(item => resolveValue(item, stepResults));
    }

    if (typeof value === 'object' && value !== null) {
        const resolved: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            resolved[key] = resolveValue(child, stepResults);
        }
        return resolved;
    }

    return value;
}

/**
 * Get nested value from object using dot notation (supports array indexing)
 * e.g., "created[0].id" or "character.stats.str"
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split(/\.|\[|\]/).filter(p => p !== '');
    let current: unknown = obj;

    for (const part of parts) {
        if (current === null || current === undefined) return undefined;
        current = (current as Record<string, unknown>)[part];
    }

    return current;
}

/**
 * Extract the JSON payload that RichFormatter.embedJson writes into tool output.
 *
 * Tools emit `<!-- <TAG>_JSON\n{...}\n<TAG>_JSON -->` (e.g. PARTY_MANAGE_JSON,
 * CHARACTER_MANAGE_JSON, BATCH_MANAGE_JSON). This is the inverse of
 * RichFormatter.embedJson and matches the canonical extraction regex already
 * used elsewhere in the codebase (e.g. combat-map.ts), tying the opening and
 * closing tags via a backreference so a partial/garbled envelope won't match.
 *
 * Returns the parsed object, or undefined when there is no parseable envelope.
 */
function extractEmbeddedJson(text: string): unknown {
    const match = text.match(/<!-- (\w+_JSON)\n([\s\S]*?)\n\1 -->/);
    if (!match) return undefined;
    try {
        return JSON.parse(match[2]);
    } catch {
        return undefined;
    }
}

/** A single tool step to dispatch through the shared executor. */
interface RunnableStep {
    tool: string;
    args: Record<string, unknown>;
    id?: string;
}

/** Per-step outcome recorded by the shared executor. */
interface ExecutedStepRecord {
    stepIndex: number;
    stepId: string;
    tool: string;
    success: boolean;
    result?: unknown;
    error?: string;
}

/** Aggregate outcome of running a list of steps. */
interface RunStepsResult {
    /** Human-readable progress log (per-step lines). */
    output: string;
    executedSteps: ExecutedStepRecord[];
    stepResults: Map<string, unknown>;
    successCount: number;
    failureCount: number;
}

/**
 * Shared step executor used by BOTH `execute_sequence` and the
 * `execute_workflow` auto-execute path.
 *
 * Builds the consolidated tool registry, dispatches each step's tool handler,
 * threads results between steps via {{stepId.property}} resolution, and honors
 * `stopOnError`. This is the single source of truth for sequence execution —
 * `handleExecuteSequence` and `handleExecuteWorkflow(autoExecute)` both call it
 * so behavior cannot drift between the two entry points.
 */
async function runSteps(
    steps: RunnableStep[],
    ctx: SessionContext,
    options: { stopOnError: boolean }
): Promise<RunStepsResult> {
    // Resolve the consolidated registry LAZILY (dynamic import at call time)
    // rather than via a static top-level import. The registry barrel
    // (consolidated/index.ts) imports BatchManageTool back from this module, so a
    // static `import { buildConsolidatedRegistry }` here created a registry ↔
    // batch-manage cycle: importing batch-manage in isolation triggered registry
    // module eval against a partially-initialized ConsolidatedTools array, and
    // tests had to import the barrel FIRST as a workaround. Deferring resolution
    // to runtime breaks that eval-order dependency — by the time runSteps is
    // actually called, every module has finished initializing.
    // (CodeRabbit round-3 Major @815 — light decoupling, not the facade refactor.)
    const { buildConsolidatedRegistry } = await import('../consolidated-registry.js');
    const registry = buildConsolidatedRegistry();
    const { stopOnError } = options;

    // Re-apply the 10-step cap in the SHARED executor. execute_sequence enforced
    // this via its Zod schema (steps.max(10)), but execute_workflow routes a
    // TEMPLATE's steps straight through runSteps and bypasses that schema — so a
    // template with >10 steps would otherwise run uncapped. Throw BEFORE any step
    // executes; callers convert this into a BATCH_MANAGE error envelope (error:true)
    // with NO partial run. (CodeRabbit round-4 @852 — Major.)
    if (steps.length > 10) {
        throw new Error('execute_sequence supports at most 10 steps');
    }

    // Reject duplicate NORMALIZED step ids BEFORE executing anything. Each step's
    // id is `step.id || stepN`, and that id keys stepResults — so a collision
    // (two equal explicit ids, OR an explicit id equal to a generated `stepN`)
    // would let `stepResults.set(stepId, ...)` silently overwrite an earlier
    // step, making {{stepId.prop}} resolution ambiguous and dropping data from
    // the final payload. Throw up front so the whole sequence is rejected with
    // NO partial run (no side effects). Callers convert this into a BATCH_MANAGE
    // error envelope. (CodeRabbit round-3 Major @822-870.)
    const normalizedIds = steps.map((step, i) => step.id || `step${i + 1}`);
    const duplicateIds = [
        ...new Set(normalizedIds.filter((id, i) => normalizedIds.indexOf(id) !== i))
    ];
    if (duplicateIds.length > 0) {
        throw new Error(`Duplicate step id(s): ${duplicateIds.join(', ')}`);
    }

    const stepResults = new Map<string, unknown>();
    const executedSteps: ExecutedStepRecord[] = [];
    let output = '';

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepId = step.id || `step${i + 1}`;
        const toolEntry = registry[step.tool];

        output += `**Step ${i + 1}/${steps.length}**: \`${step.tool}\`\n`;

        if (!toolEntry) {
            const error = `Unknown tool: ${step.tool}`;
            output += `  ❌ ${error}\n`;

            executedSteps.push({
                stepIndex: i,
                stepId,
                tool: step.tool,
                success: false,
                error
            });

            if (stopOnError) {
                output += `\n*Execution stopped due to error (stopOnError=true)*\n`;
                break;
            }
            continue;
        }

        try {
            // Resolve any references to previous step results
            const resolvedArgs = resolveStepReferences(step.args, stepResults);

            // Execute the tool
            const response = await toolEntry.handler(resolvedArgs, ctx);

            // Parse the result from the response. Tools embed their structured
            // payload via RichFormatter.embedJson as `<!-- <TAG>_JSON\n{...}\n<TAG>_JSON -->`
            // (e.g. PARTY_MANAGE_JSON). Reuse the shared extractor so step results
            // become the REAL parsed object — this is what lets resolveStepReferences /
            // getNestedValue read fields like `created[0].id` for {{stepId.property}}
            // cross-step passing. Falling back to { raw } only when there is no
            // parseable envelope.
            let result: unknown = null;
            const text = response.content?.[0]?.text;
            if (text) {
                const embedded = extractEmbeddedJson(text);
                result = embedded !== undefined ? embedded : { raw: text };
            }

            // Store result for reference by later steps
            stepResults.set(stepId, result);

            // A step is FAILED if its parsed result reports failure via EITHER
            // convention: `error` truthy OR `success === false`. Handlers in this
            // file return `{ success: false, errors: [...] }` on partial failure
            // without an `error` field, so checking only `error` (the old
            // `!(result?.error)`) silently counted those as successful and never
            // tripped stopOnError. (CodeRabbit Major @793-794.)
            const resObj = result as Record<string, unknown> | null;
            const success = !resObj?.error && resObj?.success !== false;
            output += success ? `  ✅ Success\n` : `  ⚠️ Step reported failure\n`;

            executedSteps.push({
                stepIndex: i,
                stepId,
                tool: step.tool,
                success,
                result
            });

            // Honor stopOnError for steps that completed but reported failure
            // (not just steps that threw). Without this, a `{ success: false }`
            // step would let later steps run even though stopOnError is true.
            if (!success && stopOnError) {
                output += `\n*Execution stopped due to error (stopOnError=true)*\n`;
                break;
            }

        } catch (err: unknown) {
            const error = (err instanceof Error ? err.message : String(err)) || 'Unknown error';
            output += `  ❌ Error: ${error}\n`;

            executedSteps.push({
                stepIndex: i,
                stepId,
                tool: step.tool,
                success: false,
                error
            });

            if (stopOnError) {
                output += `\n*Execution stopped due to error (stopOnError=true)*\n`;
                break;
            }
        }
    }

    const successCount = executedSteps.filter(s => s.success).length;
    const failureCount = executedSteps.filter(s => !s.success).length;

    return { output, executedSteps, stepResults, successCount, failureCount };
}

async function handleExecuteSequence(input: BatchManageInput, ctx: SessionContext): Promise<McpResponse> {
    if (!input.steps || input.steps.length === 0) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('execute_sequence requires steps array') +
                    RichFormatter.embedJson({ error: true, message: 'steps required' }, 'BATCH_MANAGE')
            }]
        };
    }

    const stopOnError = input.stopOnError ?? true;

    let output = RichFormatter.header('Executing Sequence', '⚙️');
    output += `*${input.steps.length} step(s) to execute*\n\n`;

    // runSteps rejects duplicate normalized step ids up front (before any step
    // runs). Surface that as a BATCH_MANAGE error envelope so callers branching
    // on the embedded `error` flag see it, and nothing was partially executed.
    let run: RunStepsResult;
    try {
        run = await runSteps(input.steps as RunnableStep[], ctx, { stopOnError });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error(message) +
                    RichFormatter.embedJson({ error: true, message, actionType: 'execute_sequence' }, 'BATCH_MANAGE')
            }]
        };
    }
    output += run.output;

    output += RichFormatter.section('Summary');
    output += RichFormatter.keyValue({
        'Total Steps': input.steps.length,
        'Executed': run.executedSteps.length,
        'Succeeded': run.successCount,
        'Failed': run.failureCount
    });

    const resultPayload = {
        success: run.failureCount === 0,
        actionType: 'execute_sequence',
        totalSteps: input.steps.length,
        executedSteps: run.executedSteps.length,
        successCount: run.successCount,
        failureCount: run.failureCount,
        steps: run.executedSteps,
        stepResults: Object.fromEntries(run.stepResults)
    };

    output += RichFormatter.embedJson(resultPayload, 'BATCH_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

// Main handler
export async function handleBatchManage(args: unknown, _ctx: SessionContext): Promise<McpResponse> {
    const input = BatchManageInputSchema.parse(args);
    const matchResult = matchAction(input.action, ACTIONS, ALIASES, 0.6);

    if (isGuidingError(matchResult)) {
        let output = RichFormatter.error(`Unknown action: "${input.action}"`);
        output += `\nAvailable actions: ${ACTIONS.join(', ')}`;
        if (matchResult.suggestions.length > 0) {
            output += `\nDid you mean: ${matchResult.suggestions.map(s => `"${s.value}" (${Math.round(s.similarity * 100)}%)`).join(', ')}?`;
        }
        output += RichFormatter.embedJson(matchResult, 'BATCH_MANAGE');
        return { content: [{ type: 'text', text: output }] };
    }

    switch (matchResult.matched) {
        case 'create_characters':
            return handleCreateCharacters(input, _ctx);
        case 'create_npcs':
            return handleCreateNpcs(input, _ctx);
        case 'distribute_items':
            return handleDistributeItems(input, _ctx);
        case 'execute_workflow':
            return handleExecuteWorkflow(input, _ctx);
        case 'list_templates':
            return handleListTemplates(input, _ctx);
        case 'get_template':
            return handleGetTemplate(input, _ctx);
        case 'execute_sequence':
            return handleExecuteSequence(input, _ctx);
        default:
            return {
                content: [{
                    type: 'text',
                    text: RichFormatter.error(`Unhandled action: ${matchResult.matched}`) +
                        RichFormatter.embedJson({ error: true, message: `Unhandled: ${matchResult.matched}` }, 'BATCH_MANAGE')
                }]
            };
    }
}

// Tool definition for registration
export const BatchManageTool = {
    name: 'batch_manage',
    category: 'meta',
    keywords: ['batch', 'bulk', 'create', 'workflow', 'template'],
    capabilities: ['Bulk character creation', 'Workflows', 'Templates'],
    description: `Consolidated batch operations (7 actions).

🔗 WORKFLOW ORCHESTRATION:
Use execute_sequence to chain ANY tools together with parameter passing.
Results from step N can be referenced in step N+1 using {{stepId.property}}.

Actions:
• execute_sequence - Chain multiple tools with parameter passing (NEW!)
• create_characters - Create multiple characters at once (up to 20)
• create_npcs - Create NPCs for a location (up to 50)
• distribute_items - Give items to multiple characters
• execute_workflow - Run a predefined workflow template
• list_templates - List available workflow templates
• get_template - Get details of a workflow template

Examples:
- Chain tools: { action: "execute_sequence", steps: [
    { tool: "item_manage", args: { action: "create", name: "Longsword" }, id: "sword" },
    { tool: "inventory_manage", args: { action: "give", characterId: "xxx", itemId: "{{sword.item.id}}" } }
  ]}
- Create party: { action: "create_characters", characters: [{ name: "Valeros", class: "Fighter" }] }
- Populate village: { action: "create_npcs", locationName: "Thornwood", npcs: [{ name: "Marta", role: "Innkeeper" }] }`,
    inputSchema: BatchManageInputSchema
} satisfies ToolContract;
