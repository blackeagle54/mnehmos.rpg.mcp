/**
 * Consolidated Achievement Management Tool (Phase 3).
 *
 * Two data halves, mirroring the quest split:
 *   - a GLOBAL catalog (achievements table, via AchievementRepository) holding
 *     definitions any character can earn, and
 *   - per-character unlock/progress state stored as the character row's
 *     `achievements` JSON column (Record<achievementId, {unlockedAt?, progress?}>).
 *
 * Actions:
 *   define   - upsert a catalog definition
 *   list     - list definitions; per-character annotation + hidden filtering
 *   unlock   - mark unlocked for a character (idempotent)
 *   progress - increment toward an incremental achievement's target (auto-unlock)
 *   get      - per-character summary (totals)
 *   revoke   - remove a character's unlock/progress entry (admin)
 *
 * Philosophy: the LLM describes the achievement; the engine validates and the
 * database is the source of truth (e.g. progress is clamped at target here, not
 * trusted from the caller).
 */

import { z } from 'zod';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { SessionContext } from '../types.js';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { resolveConsolidatedDbPath } from './db-path.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { AchievementRepository } from '../../storage/repos/achievement.repo.js';
import { ToolContract } from '../tool-metadata.js';
import {
    AchievementDefinition,
    CharacterAchievements,
} from '../../schema/achievement.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = ['define', 'list', 'unlock', 'progress', 'get', 'revoke'] as const;
type AchievementManageAction = typeof ACTIONS[number];

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPER
// ═══════════════════════════════════════════════════════════════════════════

function ensureDb() {
    const dbPath = resolveConsolidatedDbPath();
    const db = getDb(dbPath);
    return {
        characterRepo: new CharacterRepository(db),
        achievementRepo: new AchievementRepository(db),
    };
}

/**
 * Default-on-read: legacy characters have no achievements column, so resolve
 * undefined to an empty map before any read/write. Keeps every handler off the
 * undefined branch.
 */
function resolveAchievements(achievements: CharacterAchievements | undefined): CharacterAchievements {
    return achievements ? { ...achievements } : {};
}

/**
 * Shape a catalog definition into the FROZEN response field set (the parallel UI
 * agent builds against this exact shape).
 */
function toAchievementResponse(def: AchievementDefinition) {
    return {
        id: def.id,
        name: def.name,
        description: def.description,
        category: def.category,
        points: def.points,
        criteria: def.criteria,
        hidden: def.hidden,
        target: def.target,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const DefineSchema = z.object({
    action: z.literal('define'),
    achievementId: z.string().describe('Stable achievement identifier'),
    name: z.string().describe('Display name'),
    description: z.string().describe('What the achievement is for'),
    category: z.string().describe('Grouping bucket (e.g. combat, exploration)'),
    points: z.number().int().min(0).optional().describe('Score awarded on unlock (default 0)'),
    criteria: z.string().optional().describe('Human-readable unlock condition'),
    hidden: z.boolean().optional().describe('Hide from catalog until unlocked (default false)'),
    target: z.number().int().min(1).optional().describe('Progress threshold (incremental achievements)'),
});

const ListSchema = z.object({
    action: z.literal('list'),
    category: z.string().optional().describe('Filter to a single category'),
    characterId: z.string().optional().describe('Annotate with this character\'s state'),
});

const UnlockSchema = z.object({
    action: z.literal('unlock'),
    characterId: z.string().describe('Character ID'),
    achievementId: z.string().describe('Achievement ID to unlock'),
});

const ProgressSchema = z.object({
    action: z.literal('progress'),
    characterId: z.string().describe('Character ID'),
    achievementId: z.string().describe('Achievement ID to advance'),
    amount: z.number().int().min(1).optional().describe('Increment amount (default 1)'),
});

const GetSchema = z.object({
    action: z.literal('get'),
    characterId: z.string().describe('Character ID'),
});

const RevokeSchema = z.object({
    action: z.literal('revoke'),
    characterId: z.string().describe('Character ID'),
    achievementId: z.string().describe('Achievement ID to remove'),
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

async function handleDefine(args: z.infer<typeof DefineSchema>): Promise<object> {
    const { achievementRepo } = ensureDb();

    // Upsert: the repo + schema apply points-default 0 and hidden-default false.
    const def = achievementRepo.upsert({
        id: args.achievementId,
        name: args.name,
        description: args.description,
        category: args.category,
        points: args.points ?? 0,
        criteria: args.criteria,
        hidden: args.hidden ?? false,
        target: args.target,
    });

    return {
        success: true,
        actionType: 'define',
        achievement: toAchievementResponse(def),
    };
}

async function handleList(args: z.infer<typeof ListSchema>): Promise<object> {
    const { achievementRepo, characterRepo } = ensureDb();
    const defs = achievementRepo.findAll(args.category);

    // Resolve per-character state once (if requested).
    let unlocks: CharacterAchievements | null = null;
    if (args.characterId) {
        const character = characterRepo.findById(args.characterId);
        if (!character) {
            return { error: true, message: `Character ${args.characterId} not found` };
        }
        unlocks = resolveAchievements(character.achievements);
    }

    const achievements = defs
        .map((def) => {
            const entry = unlocks ? unlocks[def.id] : undefined;
            const unlocked = !!entry?.unlockedAt;
            return {
                ...toAchievementResponse(def),
                ...(unlocks
                    ? {
                          unlocked,
                          unlockedAt: entry?.unlockedAt,
                          progress: entry?.progress,
                      }
                    : {}),
                // private flag used only for filtering below; stripped before output.
                _unlocked: unlocked,
            };
        })
        // Hidden achievements are omitted unless this character has unlocked them.
        .filter((a) => !(a.hidden && !a._unlocked))
        .map(({ _unlocked, ...rest }) => rest);

    return {
        success: true,
        actionType: 'list',
        achievements,
    };
}

async function handleUnlock(args: z.infer<typeof UnlockSchema>): Promise<object> {
    const { achievementRepo, characterRepo } = ensureDb();

    const def = achievementRepo.findById(args.achievementId);
    if (!def) {
        return { error: true, message: `Achievement ${args.achievementId} not found` };
    }

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    const unlocks = resolveAchievements(character.achievements);
    const existing = unlocks[args.achievementId];
    const alreadyUnlocked = !!existing?.unlockedAt;

    // Idempotent: keep the ORIGINAL unlockedAt on a repeat unlock.
    const unlockedAt = alreadyUnlocked ? existing.unlockedAt! : new Date().toISOString();
    unlocks[args.achievementId] = { ...existing, unlockedAt };

    const updated = characterRepo.update(args.characterId, { achievements: unlocks });
    if (!updated) {
        // TOCTOU: character deleted between read and write.
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    return {
        success: true,
        actionType: 'unlock',
        characterId: args.characterId,
        achievementId: args.achievementId,
        name: def.name,
        points: def.points,
        unlockedAt,
        alreadyUnlocked,
    };
}

async function handleProgress(args: z.infer<typeof ProgressSchema>): Promise<object> {
    const { achievementRepo, characterRepo } = ensureDb();

    const def = achievementRepo.findById(args.achievementId);
    if (!def) {
        return { error: true, message: `Achievement ${args.achievementId} not found` };
    }
    if (def.target === undefined) {
        return { error: true, message: `achievement ${args.achievementId} is not incremental` };
    }

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    const unlocks = resolveAchievements(character.achievements);
    const existing = unlocks[args.achievementId];
    const wasUnlocked = !!existing?.unlockedAt;

    const amount = args.amount ?? 1;
    // Engine clamps progress at target — never trust an overshoot from the caller.
    const progress = Math.min(def.target, (existing?.progress ?? 0) + amount);
    const reached = progress >= def.target;

    // Auto-unlock on reaching target; preserve an existing unlockedAt otherwise.
    const unlockedAt = wasUnlocked
        ? existing!.unlockedAt
        : reached
          ? new Date().toISOString()
          : undefined;
    const justUnlocked = !wasUnlocked && reached;

    unlocks[args.achievementId] = {
        progress,
        ...(unlockedAt ? { unlockedAt } : {}),
    };

    const updated = characterRepo.update(args.characterId, { achievements: unlocks });
    if (!updated) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    return {
        success: true,
        actionType: 'progress',
        characterId: args.characterId,
        achievementId: args.achievementId,
        name: def.name,
        progress,
        target: def.target,
        unlocked: !!unlockedAt,
        justUnlocked,
    };
}

async function handleGet(args: z.infer<typeof GetSchema>): Promise<object> {
    const { achievementRepo, characterRepo } = ensureDb();

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    const defs = achievementRepo.findAll();
    const byId = new Map(defs.map((d) => [d.id, d]));
    const unlocks = resolveAchievements(character.achievements);

    const unlocked: Array<{ id: string; name: string; points: number; unlockedAt: string }> = [];
    const inProgress: Array<{ id: string; name: string; progress: number; target: number }> = [];
    let totalPoints = 0;

    for (const [id, entry] of Object.entries(unlocks)) {
        const def = byId.get(id);
        if (!def) continue; // orphaned entry (definition deleted) — skip.

        if (entry.unlockedAt) {
            unlocked.push({ id, name: def.name, points: def.points, unlockedAt: entry.unlockedAt });
            totalPoints += def.points;
        } else if (def.target !== undefined && entry.progress !== undefined) {
            inProgress.push({ id, name: def.name, progress: entry.progress, target: def.target });
        }
    }

    return {
        success: true,
        actionType: 'get',
        characterId: args.characterId,
        characterName: character.name,
        unlocked,
        inProgress,
        totalPoints,
        unlockedCount: unlocked.length,
        totalCount: defs.length,
    };
}

async function handleRevoke(args: z.infer<typeof RevokeSchema>): Promise<object> {
    const { characterRepo } = ensureDb();

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    const unlocks = resolveAchievements(character.achievements);
    const revoked = Object.prototype.hasOwnProperty.call(unlocks, args.achievementId);

    if (revoked) {
        delete unlocks[args.achievementId];
        const updated = characterRepo.update(args.characterId, { achievements: unlocks });
        if (!updated) {
            return { error: true, message: `Character ${args.characterId} not found` };
        }
    }

    return {
        success: true,
        actionType: 'revoke',
        characterId: args.characterId,
        achievementId: args.achievementId,
        revoked,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════

const definitions: Record<AchievementManageAction, ActionDefinition> = {
    define: {
        schema: DefineSchema,
        handler: handleDefine,
        aliases: ['create', 'add', 'register'],
        description: 'Upsert an achievement definition in the catalog',
    },
    list: {
        schema: ListSchema,
        handler: handleList,
        aliases: ['catalog', 'all'],
        description: 'List achievement definitions (optionally annotated per character)',
    },
    unlock: {
        schema: UnlockSchema,
        handler: handleUnlock,
        aliases: ['award', 'grant', 'earn'],
        description: 'Unlock an achievement for a character (idempotent)',
    },
    progress: {
        schema: ProgressSchema,
        handler: handleProgress,
        aliases: ['advance', 'increment'],
        description: 'Advance progress toward an incremental achievement (auto-unlocks at target)',
    },
    get: {
        schema: GetSchema,
        handler: handleGet,
        aliases: ['status', 'character', 'mine'],
        description: 'Get a character\'s achievement summary',
    },
    revoke: {
        schema: RevokeSchema,
        handler: handleRevoke,
        aliases: ['remove', 'reset'],
        description: 'Remove a character\'s achievement unlock/progress (admin)',
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

export const AchievementManageTool = {
    name: 'achievement_manage',
    // category:'character' — reuses an existing ToolCategory union member rather
    // than widening it (a new 'achievement' category would also need
    // tool-metadata.ts + getConsolidatedToolCategories() edits). Achievements are
    // a character axis (catalog is global, but unlocks live on the character).
    category: 'character',
    keywords: ['achievement', 'unlock', 'trophy', 'milestone', 'badge', 'reward'],
    capabilities: ['Achievement catalog', 'Unlock tracking', 'Progress milestones'],
    description: `Manage achievements: a global catalog of trophies/milestones plus per-character unlocks and progress.
Actions: define, list, unlock, progress, get, revoke
Aliases: create/add/register→define, catalog/all→list, award/grant/earn→unlock, advance/increment→progress, status/character/mine→get, remove/reset→revoke

🏆 ACHIEVEMENT WORKFLOW:
1. define - upsert a catalog entry (points, hidden, optional target for incremental ones)
2. list - browse the catalog (hidden ones are omitted until a character unlocks them)
3. unlock - award a binary achievement to a character (idempotent)
4. progress - advance an incremental achievement; auto-unlocks (and clamps) at target
5. get - read a character's unlocked/in-progress achievements and total points
6. revoke - admin removal of a character's unlock/progress`,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        achievementId: z.string().optional().describe('Achievement ID'),
        name: z.string().optional().describe('Display name (for define)'),
        description: z.string().optional().describe('Description (for define)'),
        category: z.string().optional().describe('Category (for define / list filter)'),
        points: z.number().optional().describe('Score awarded on unlock (for define)'),
        criteria: z.string().optional().describe('Human-readable unlock condition (for define)'),
        hidden: z.boolean().optional().describe('Hide until unlocked (for define)'),
        target: z.number().optional().describe('Progress threshold for incremental achievements (for define)'),
        characterId: z.string().optional().describe('Character ID'),
        amount: z.number().optional().describe('Increment amount (for progress)'),
    }),
} satisfies ToolContract;

export async function handleAchievementManage(args: unknown, _ctx: SessionContext): Promise<McpResponse> {
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
            case 'define':
                output = RichFormatter.header('Achievement Defined', '🏆');
                output += RichFormatter.keyValue({
                    'ID': parsed.achievement?.id,
                    'Name': parsed.achievement?.name,
                    'Category': parsed.achievement?.category,
                    'Points': parsed.achievement?.points,
                    'Target': parsed.achievement?.target ?? '—',
                    'Hidden': parsed.achievement?.hidden ? 'yes' : 'no',
                });
                break;
            case 'list':
                output = RichFormatter.header('Achievements', '📜');
                if (Array.isArray(parsed.achievements) && parsed.achievements.length > 0) {
                    for (const a of parsed.achievements) {
                        const state = a.unlocked === true ? ' ✅' : a.unlocked === false ? ' 🔒' : '';
                        output += `- **${a.name}** (${a.category}, ${a.points} pts)${state}\n`;
                    }
                } else {
                    output += RichFormatter.alert('No achievements found.', 'info');
                }
                break;
            case 'unlock':
                output = RichFormatter.header(parsed.alreadyUnlocked ? 'Already Unlocked' : 'Achievement Unlocked', '🏅');
                output += RichFormatter.keyValue({
                    'Achievement': parsed.name,
                    'Points': parsed.points,
                    'Unlocked At': parsed.unlockedAt,
                });
                if (!parsed.alreadyUnlocked) {
                    output += RichFormatter.success(`🎉 Unlocked ${parsed.name}!`);
                }
                break;
            case 'progress':
                output = RichFormatter.header('Achievement Progress', '📈');
                output += RichFormatter.keyValue({
                    'Achievement': parsed.name,
                    'Progress': `${parsed.progress} / ${parsed.target}`,
                    'Unlocked': parsed.unlocked ? 'yes' : 'no',
                });
                if (parsed.justUnlocked) {
                    output += RichFormatter.success(`🎉 Unlocked ${parsed.name}!`);
                }
                break;
            case 'get':
                output = RichFormatter.header(`${parsed.characterName}'s Achievements`, '🏆');
                output += RichFormatter.keyValue({
                    'Unlocked': `${parsed.unlockedCount} / ${parsed.totalCount}`,
                    'Total Points': parsed.totalPoints,
                });
                if (Array.isArray(parsed.unlocked) && parsed.unlocked.length > 0) {
                    output += RichFormatter.section('Unlocked');
                    for (const u of parsed.unlocked) {
                        output += `- ✅ **${u.name}** (${u.points} pts)\n`;
                    }
                }
                if (Array.isArray(parsed.inProgress) && parsed.inProgress.length > 0) {
                    output += RichFormatter.section('In Progress');
                    for (const p of parsed.inProgress) {
                        output += `- ⏳ **${p.name}** (${p.progress} / ${p.target})\n`;
                    }
                }
                break;
            case 'revoke':
                output = RichFormatter.header('Achievement Revoked', '🗑️');
                output += RichFormatter.keyValue({
                    'Achievement': parsed.achievementId,
                    'Removed': parsed.revoked ? 'yes' : 'nothing to remove',
                });
                break;
            default:
                output = RichFormatter.header('Achievement', '🏆');
                if (parsed.message) output += parsed.message + '\n';
        }
    }

    output += RichFormatter.embedJson(parsed, 'ACHIEVEMENT_MANAGE');

    return {
        content: [{
            type: 'text' as const,
            text: output,
        }],
    };
}
