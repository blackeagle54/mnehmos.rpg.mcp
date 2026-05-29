/**
 * Consolidated Reputation Management Tool (Phase 3 — Factions & Reputation).
 *
 * Two data halves, mirroring the achievement split:
 *   - a GLOBAL catalog (factions table, via FactionRepository) holding faction
 *     definitions any character can build standing with, and
 *   - per-character reputation state stored as the character row's `reputation`
 *     JSON column (Record<factionId, {value}>).
 *
 * The STANDING tier (Exalted/.../Hated) is DERIVED from the value at read time
 * via standingFromValue() — never stored. The value is clamped to [-1000, 1000]
 * on every write; a missing entry == value 0 / "Neutral".
 *
 * Actions:
 *   define_faction - upsert a catalog definition
 *   list_factions  - list definitions; per-character value + standing annotation
 *   adjust         - change a character's value by amount (clamped)
 *   set            - admin: set a character's absolute value (clamped)
 *   get            - per-character summary across ALL defined factions
 *   check          - does the character meet a numeric reputation threshold?
 *
 * Philosophy: the LLM describes the reputation change; the engine validates and
 * the database is the source of truth (the value is clamped here, not trusted
 * from the caller, and the standing is computed — never accepted as input).
 */

import { z } from 'zod';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { SessionContext } from '../types.js';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { resolveConsolidatedDbPath } from './db-path.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { FactionRepository } from '../../storage/repos/faction.repo.js';
import { ToolContract } from '../tool-metadata.js';
import {
    FactionDefinition,
    CharacterReputation,
    standingFromValue,
    REPUTATION_MIN,
    REPUTATION_MAX,
} from '../../schema/reputation.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = ['define_faction', 'list_factions', 'adjust', 'set', 'get', 'check'] as const;
type ReputationManageAction = typeof ACTIONS[number];

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPER
// ═══════════════════════════════════════════════════════════════════════════

function ensureDb() {
    const dbPath = resolveConsolidatedDbPath();
    const db = getDb(dbPath);
    return {
        characterRepo: new CharacterRepository(db),
        factionRepo: new FactionRepository(db),
    };
}

/**
 * Default-on-read: legacy characters have no reputation column, so resolve
 * undefined to an empty map before any read/write. Keeps every handler off the
 * undefined branch (a missing faction entry == value 0 / "Neutral").
 */
function resolveReputation(reputation: CharacterReputation | undefined): CharacterReputation {
    return reputation ? { ...reputation } : {};
}

/** Clamp a reputation value into the canonical [-1000, 1000] range. */
function clampValue(value: number): number {
    if (value < REPUTATION_MIN) return REPUTATION_MIN;
    if (value > REPUTATION_MAX) return REPUTATION_MAX;
    return Math.trunc(value);
}

/** The integer reputation value a character currently holds for a faction (0 if untracked). */
function valueFor(reputation: CharacterReputation, factionId: string): number {
    return reputation[factionId]?.value ?? 0;
}

/**
 * Shape a catalog definition into the FROZEN response field set (the parallel UI
 * agent builds against this exact shape).
 */
function toFactionResponse(def: FactionDefinition) {
    return {
        id: def.id,
        name: def.name,
        description: def.description,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const DefineFactionSchema = z.object({
    action: z.literal('define_faction'),
    factionId: z.string().describe('Stable faction identifier'),
    name: z.string().describe('Display name'),
    description: z.string().optional().describe('What the faction is'),
});

const ListFactionsSchema = z.object({
    action: z.literal('list_factions'),
    characterId: z.string().optional().describe('Annotate each faction with this character\'s value + standing'),
});

const AdjustSchema = z.object({
    action: z.literal('adjust'),
    characterId: z.string().describe('Character ID'),
    factionId: z.string().describe('Faction ID'),
    amount: z.number().int().describe('Reputation delta (may be negative); result is clamped to [-1000, 1000]'),
});

const SetSchema = z.object({
    action: z.literal('set'),
    characterId: z.string().describe('Character ID'),
    factionId: z.string().describe('Faction ID'),
    value: z.number().int().describe('Absolute reputation value (clamped to [-1000, 1000])'),
});

const GetSchema = z.object({
    action: z.literal('get'),
    characterId: z.string().describe('Character ID'),
});

const CheckSchema = z.object({
    action: z.literal('check'),
    characterId: z.string().describe('Character ID'),
    factionId: z.string().describe('Faction ID'),
    value: z.number().int().describe('Required reputation threshold to test against'),
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

async function handleDefineFaction(args: z.infer<typeof DefineFactionSchema>): Promise<object> {
    const { factionRepo } = ensureDb();

    const def = factionRepo.upsert({
        id: args.factionId,
        name: args.name,
        description: args.description,
    });

    return {
        success: true,
        actionType: 'define_faction',
        faction: toFactionResponse(def),
    };
}

async function handleListFactions(args: z.infer<typeof ListFactionsSchema>): Promise<object> {
    const { factionRepo, characterRepo } = ensureDb();
    const defs = factionRepo.findAll();

    // Resolve per-character reputation once (if requested).
    let reputation: CharacterReputation | null = null;
    if (args.characterId) {
        const character = characterRepo.findById(args.characterId);
        if (!character) {
            return { error: true, message: `Character ${args.characterId} not found` };
        }
        reputation = resolveReputation(character.reputation);
    }

    const factions = defs.map((def) => {
        if (!reputation) {
            return toFactionResponse(def);
        }
        const value = valueFor(reputation, def.id);
        return {
            ...toFactionResponse(def),
            value,
            standing: standingFromValue(value),
        };
    });

    return {
        success: true,
        actionType: 'list_factions',
        factions,
    };
}

async function handleAdjust(args: z.infer<typeof AdjustSchema>): Promise<object> {
    const { factionRepo, characterRepo } = ensureDb();

    const def = factionRepo.findById(args.factionId);
    if (!def) {
        return { error: true, message: `Faction ${args.factionId} not found` };
    }

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    const reputation = resolveReputation(character.reputation);
    const oldValue = valueFor(reputation, args.factionId);
    // Engine clamps the result — never trust an out-of-range delta from the caller.
    const newValue = clampValue(oldValue + args.amount);
    reputation[args.factionId] = { value: newValue };

    // Atomic by construction: findById → mutate → update runs synchronously with
    // NO await between read and write, and better-sqlite3 is synchronous over a
    // single process-global connection, so no other handler can interleave inside
    // this critical section (same read-modify-write idiom as skill_manage /
    // achievement_manage). The only real race — character deletion between read
    // and write — is caught by the update()-returns-null guard below.
    const updated = characterRepo.update(args.characterId, { reputation });
    if (!updated) {
        // TOCTOU: character deleted between read and write.
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    const oldStanding = standingFromValue(oldValue);
    const newStanding = standingFromValue(newValue);

    return {
        success: true,
        actionType: 'adjust',
        characterId: args.characterId,
        factionId: args.factionId,
        name: def.name,
        oldValue,
        newValue,
        oldStanding,
        newStanding,
        standingChanged: oldStanding !== newStanding,
    };
}

async function handleSet(args: z.infer<typeof SetSchema>): Promise<object> {
    const { factionRepo, characterRepo } = ensureDb();

    const def = factionRepo.findById(args.factionId);
    if (!def) {
        return { error: true, message: `Faction ${args.factionId} not found` };
    }

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    const reputation = resolveReputation(character.reputation);
    const value = clampValue(args.value);
    reputation[args.factionId] = { value };

    // Atomic for the same reason as handleAdjust: synchronous read-modify-write
    // with no await between, single process-global better-sqlite3 connection.
    const updated = characterRepo.update(args.characterId, { reputation });
    if (!updated) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    return {
        success: true,
        actionType: 'set',
        characterId: args.characterId,
        factionId: args.factionId,
        name: def.name,
        value,
        standing: standingFromValue(value),
    };
}

async function handleGet(args: z.infer<typeof GetSchema>): Promise<object> {
    const { factionRepo, characterRepo } = ensureDb();

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    const defs = factionRepo.findAll();
    const reputation = resolveReputation(character.reputation);

    // Include EVERY defined faction — untracked ones surface as 0 / Neutral.
    const reputations = defs.map((def) => {
        const value = valueFor(reputation, def.id);
        return {
            id: def.id,
            name: def.name,
            value,
            standing: standingFromValue(value),
        };
    });

    return {
        success: true,
        actionType: 'get',
        characterId: args.characterId,
        characterName: character.name,
        reputations,
        factionCount: defs.length,
    };
}

async function handleCheck(args: z.infer<typeof CheckSchema>): Promise<object> {
    const { factionRepo, characterRepo } = ensureDb();

    const def = factionRepo.findById(args.factionId);
    if (!def) {
        return { error: true, message: `Faction ${args.factionId} not found` };
    }

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    const reputation = resolveReputation(character.reputation);
    const currentValue = valueFor(reputation, args.factionId);
    const requiredValue = args.value;
    const met = currentValue >= requiredValue;

    return {
        success: true,
        actionType: 'check',
        characterId: args.characterId,
        factionId: args.factionId,
        name: def.name,
        currentValue,
        currentStanding: standingFromValue(currentValue),
        requiredValue,
        met,
        shortfall: met ? 0 : requiredValue - currentValue,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════

const definitions: Record<ReputationManageAction, ActionDefinition> = {
    define_faction: {
        schema: DefineFactionSchema,
        handler: handleDefineFaction,
        aliases: ['define', 'create_faction', 'add_faction'],
        description: 'Upsert a faction definition in the catalog',
    },
    list_factions: {
        schema: ListFactionsSchema,
        handler: handleListFactions,
        aliases: ['factions', 'list'],
        description: 'List faction definitions (optionally annotated per character)',
    },
    adjust: {
        schema: AdjustSchema,
        handler: handleAdjust,
        aliases: ['change', 'modify', 'add_rep', 'gain', 'lose'],
        description: 'Change a character\'s reputation with a faction by an amount (clamped)',
    },
    set: {
        schema: SetSchema,
        handler: handleSet,
        aliases: ['set_rep', 'seed'],
        description: 'Set a character\'s absolute reputation value with a faction (admin, clamped)',
    },
    get: {
        schema: GetSchema,
        handler: handleGet,
        aliases: ['status', 'character', 'mine', 'reputation'],
        description: 'Get a character\'s reputation across all defined factions',
    },
    check: {
        schema: CheckSchema,
        handler: handleCheck,
        aliases: ['check_rep', 'requires', 'meets'],
        description: 'Check whether a character meets a numeric reputation threshold with a faction',
    },
};

const router = createActionRouter({
    actions: ACTIONS,
    definitions,
    threshold: 0.6,
});

// ═══════════════════════════════════════════════════════════════════════════
// TOOL DEFINITION & HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export const ReputationManageTool = {
    name: 'reputation_manage',
    // category:'character' — reuses an existing ToolCategory union member rather
    // than widening it (a new 'reputation' category would also need
    // tool-metadata.ts + getConsolidatedToolCategories() edits). Reputation is a
    // character axis (the faction catalog is global, but the values live on the
    // character).
    category: 'character',
    keywords: ['reputation', 'faction', 'standing', 'rep', 'relationship', 'alignment'],
    capabilities: ['Faction reputation', 'Standing tiers', 'Reputation gating'],
    description: `Manage factions & reputation: a global faction catalog plus per-character standing (value clamped to [-1000, 1000], standing tier derived).
Actions: define_faction, list_factions, adjust, set, get, check
Aliases: define/create_faction/add_faction→define_faction, factions/list→list_factions, change/modify/add_rep/gain/lose→adjust, set_rep/seed→set, status/character/mine/reputation→get, check_rep/requires/meets→check

🤝 REPUTATION WORKFLOW:
1. define_faction - upsert a faction in the catalog
2. list_factions - browse factions (with a characterId, annotates value + standing)
3. adjust - change a character's reputation by an amount (clamped; reports the standing transition)
4. set - admin set of an absolute reputation value (clamped)
5. get - read a character's standing across ALL factions (untracked = 0 / Neutral)
6. check - test whether a character meets a numeric reputation threshold (gating)

Standing tiers: Exalted (≥1000), Revered (≥600), Honored (≥300), Friendly (≥100), Neutral (≥0), Unfriendly (≥-100), Hostile (≥-500), Hated (below).`,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        factionId: z.string().optional().describe('Faction ID'),
        name: z.string().optional().describe('Display name (for define_faction)'),
        description: z.string().optional().describe('Description (for define_faction)'),
        characterId: z.string().optional().describe('Character ID'),
        amount: z.number().optional().describe('Reputation delta (for adjust)'),
        value: z.number().optional().describe('Absolute value (for set) or required threshold (for check)'),
    }),
} satisfies ToolContract;

export async function handleReputationManage(args: unknown, _ctx: SessionContext): Promise<McpResponse> {
    const result = await router(args as Record<string, unknown>);
    const parsed = JSON.parse(result.content[0].text);

    let output = '';

    if (parsed.error) {
        output = RichFormatter.header('Error', '❌');
        output += RichFormatter.alert(parsed.message || 'Unknown error', 'error');
        if (parsed.suggestions) {
            output += '\n**Did you mean:**\n';
            parsed.suggestions.forEach((s: { value: string; similarity: number }) => {
                output += `  • ${s.value} (${s.similarity}% match)\n`;
            });
        }
    } else {
        switch (parsed.actionType) {
            case 'define_faction':
                output = RichFormatter.header('Faction Defined', '🏛️');
                output += RichFormatter.keyValue({
                    'ID': parsed.faction?.id,
                    'Name': parsed.faction?.name,
                    'Description': parsed.faction?.description ?? '—',
                });
                break;
            case 'list_factions':
                output = RichFormatter.header('Factions', '🏛️');
                if (Array.isArray(parsed.factions) && parsed.factions.length > 0) {
                    for (const f of parsed.factions) {
                        const standing = f.standing !== undefined ? ` — ${f.standing} (${f.value})` : '';
                        output += `- **${f.name}**${standing}\n`;
                    }
                } else {
                    output += RichFormatter.alert('No factions defined.', 'info');
                }
                break;
            case 'adjust':
                output = RichFormatter.header('Reputation Adjusted', '📊');
                output += RichFormatter.keyValue({
                    'Faction': parsed.name,
                    'Value': `${parsed.oldValue} → ${parsed.newValue}`,
                    'Standing': parsed.standingChanged
                        ? `${parsed.oldStanding} → ${parsed.newStanding}`
                        : parsed.newStanding,
                });
                if (parsed.standingChanged) {
                    output += RichFormatter.success(`Standing changed: ${parsed.oldStanding} → ${parsed.newStanding}`);
                }
                break;
            case 'set':
                output = RichFormatter.header('Reputation Set', '📊');
                output += RichFormatter.keyValue({
                    'Faction': parsed.name,
                    'Value': parsed.value,
                    'Standing': parsed.standing,
                });
                break;
            case 'get':
                output = RichFormatter.header(`${parsed.characterName}'s Reputation`, '🤝');
                output += RichFormatter.keyValue({
                    'Factions': parsed.factionCount,
                });
                if (Array.isArray(parsed.reputations) && parsed.reputations.length > 0) {
                    output += RichFormatter.section('Standing');
                    for (const r of parsed.reputations) {
                        output += `- **${r.name}**: ${r.standing} (${r.value})\n`;
                    }
                }
                break;
            case 'check':
                output = RichFormatter.header(parsed.met ? 'Reputation Met' : 'Reputation Not Met', parsed.met ? '✅' : '🔒');
                output += RichFormatter.keyValue({
                    'Faction': parsed.name,
                    'Current': `${parsed.currentValue} (${parsed.currentStanding})`,
                    'Required': parsed.requiredValue,
                    'Met': parsed.met ? 'yes' : 'no',
                    'Shortfall': parsed.shortfall,
                });
                break;
            default:
                output = RichFormatter.header('Reputation', '🤝');
                if (parsed.message) output += parsed.message + '\n';
        }
    }

    output += RichFormatter.embedJson(parsed, 'REPUTATION_MANAGE');

    return {
        content: [{
            type: 'text' as const,
            text: output,
        }],
    };
}
