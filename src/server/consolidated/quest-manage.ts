/**
 * Consolidated Quest Management Tool
 * Replaces 8 separate tools for quest operations:
 * create_quest, get_quest, list_quests, assign_quest, update_objective,
 * complete_objective, complete_quest, get_quest_log
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { SessionContext } from '../types.js';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { resolveConsolidatedDbPath } from './db-path.js';
import { QuestRepository } from '../../storage/repos/quest.repo.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { InventoryRepository } from '../../storage/repos/inventory.repo.js';
import { ItemRepository } from '../../storage/repos/item.repo.js';
import { ToolContract } from '../tool-metadata.js';
import { SkillNameSchema } from '../../schema/skill.js';
import { levelFromXp } from '../../math/skill-xp.js';
import type { Quest } from '../../schema/quest.js';
import type { Character } from '../../schema/character.js';
// Quest types from schema: kill, collect, deliver, explore, interact, custom

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = ['create', 'get', 'list', 'assign', 'update_objective', 'complete_objective', 'complete', 'get_log', 'set_chain', 'get_chain', 'list_chains', 'select_branch'] as const;
type QuestManageAction = typeof ACTIONS[number];

// Shared shape for a chain branch edge (player-choice path).
const ChainBranchSchema = z.object({
    choiceId: z.string().describe('Stable id for this branch choice'),
    label: z.string().describe('Human-readable label for the choice'),
    questId: z.string().describe('Quest unlocked when this branch is chosen')
});

type UnlockState = 'locked' | 'available' | 'active' | 'completed';

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPER
// ═══════════════════════════════════════════════════════════════════════════

function ensureDb() {
    const dbPath = resolveConsolidatedDbPath();
    const db = getDb(dbPath);
    return {
        questRepo: new QuestRepository(db),
        characterRepo: new CharacterRepository(db),
        inventoryRepo: new InventoryRepository(db),
        itemRepo: new ItemRepository(db)
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const CreateSchema = z.object({
    action: z.literal('create'),
    name: z.string().min(1).describe('Quest name'),
    description: z.string().describe('Quest description'),
    worldId: z.string().describe('World ID'),
    giver: z.string().optional().describe('Quest giver name'),
    objectives: z.array(z.object({
        id: z.string().optional(),
        description: z.string(),
        type: z.enum(['kill', 'collect', 'deliver', 'explore', 'interact', 'custom']).default('custom')
            .describe('Objective type; defaults to "custom" when omitted'),
        target: z.string().default(''),
        required: z.number().int().min(1).default(1),
        current: z.number().int().default(0),
        completed: z.boolean().default(false)
    })).min(1).describe('Quest objectives'),
    rewards: z.object({
        experience: z.number().int().min(0).default(0),
        gold: z.number().int().min(0).default(0),
        items: z.array(z.string()).default([])
    }).default({ experience: 0, gold: 0, items: [] }),
    prerequisites: z.array(z.string()).default([]).describe('Required completed quest IDs'),
    skillRequirements: z.array(z.object({
        skill: SkillNameSchema,
        level: z.number().int().min(1).max(99)
    })).default([]).describe('Required minimum skill levels checked on assign'),
    chain: z.object({
        chainId: z.string().optional(),
        order: z.number().int().min(0).optional(),
        nextQuests: z.array(z.string()).default([]),
        branches: z.array(ChainBranchSchema).default([])
    }).default({ nextQuests: [], branches: [] }).describe('Quest-chain graph metadata'),
    status: z.enum(['available', 'active', 'completed', 'failed']).default('available')
});

const GetSchema = z.object({
    action: z.literal('get'),
    questId: z.string().describe('Quest ID')
});

const ListSchema = z.object({
    action: z.literal('list'),
    worldId: z.string().optional().describe('Filter by world ID')
});

const AssignSchema = z.object({
    action: z.literal('assign'),
    characterId: z.string().describe('Character ID'),
    questId: z.string().describe('Quest ID to assign')
});

const UpdateObjectiveSchema = z.object({
    action: z.literal('update_objective'),
    characterId: z.string().describe('Character ID'),
    questId: z.string().describe('Quest ID'),
    objectiveId: z.string().describe('Objective ID'),
    progress: z.number().int().min(1).default(1).describe('Progress increment')
});

const CompleteObjectiveSchema = z.object({
    action: z.literal('complete_objective'),
    questId: z.string().describe('Quest ID'),
    objectiveId: z.string().describe('Objective ID to complete')
});

const CompleteSchema = z.object({
    action: z.literal('complete'),
    characterId: z.string().describe('Character ID'),
    questId: z.string().describe('Quest ID to complete')
});

const GetLogSchema = z.object({
    action: z.literal('get_log'),
    characterId: z.string().describe('Character ID')
});

const SetChainSchema = z.object({
    action: z.literal('set_chain'),
    questId: z.string().describe('Quest ID whose chain metadata is being set'),
    chainId: z.string().optional().describe('Storyline grouping id'),
    order: z.number().int().min(0).optional().describe('Position in a linear chain'),
    nextQuests: z.array(z.string()).default([]).describe('Quest IDs auto-unlocked when this quest completes'),
    branches: z.array(ChainBranchSchema).default([]).describe('Branching player-choice paths')
});

const GetChainSchema = z.object({
    action: z.literal('get_chain'),
    chainId: z.string().optional().describe('Chain ID to read'),
    questId: z.string().optional().describe('Any quest ID in the chain (resolves its chainId)'),
    characterId: z.string().optional().describe('Character to derive per-character unlock state for')
}).refine(a => a.chainId !== undefined || a.questId !== undefined, {
    message: 'get_chain requires either chainId or questId'
});

const ListChainsSchema = z.object({
    action: z.literal('list_chains'),
    worldId: z.string().optional().describe('Filter by world ID')
});

const SelectBranchSchema = z.object({
    action: z.literal('select_branch'),
    characterId: z.string().describe('Character ID making the choice'),
    chainId: z.string().describe('Chain ID the branch belongs to'),
    choiceId: z.string().describe('The branch choiceId to select')
});

// ═══════════════════════════════════════════════════════════════════════════
// GATING HELPERS (shared by assign / complete auto-unlock / get_chain)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * SINGLE SOURCE OF TRUTH for "can this quest be assigned right now?".
 *
 * Returns null when the gate passes, or a human-readable reason string when it
 * is blocked. Mirrors the prerequisite + skillRequirements checks that
 * handleAssign enforces so that chain auto-unlock and get_chain's unlockState
 * can NEVER bypass the Phase-3 skill gate. Skill level is always DERIVED from
 * the character's stored XP via the curve — never a client-supplied level.
 */
function questGateReason(
    quest: Quest,
    character: Character,
    completedQuestIds: string[]
): string | null {
    for (const prereqId of quest.prerequisites) {
        if (!completedQuestIds.includes(prereqId)) {
            return `prerequisite ${prereqId} not completed`;
        }
    }
    for (const req of quest.skillRequirements) {
        const entry = character.skills?.[req.skill];
        const currentLevel = entry ? levelFromXp(entry.xp) : 1;
        if (currentLevel < req.level) {
            return `requires ${req.skill} level ${req.level} (have ${currentLevel})`;
        }
    }
    return null;
}

/**
 * Find whether `quest` is a branch target of some OTHER quest. Returns the
 * owning source's { chainId, choiceId } so callers can check the character's
 * recorded branch choice. A quest reachable only via a player branch is gated
 * behind that choice (in addition to its own prerequisites/skill gates).
 *
 * The branch-source quest must carry a chainId (set_chain validates the edge),
 * which scopes the recorded choice to that chain. The TARGET quest does NOT
 * need its own chainId — a branch target is gated purely by being referenced.
 */
function findBranchGate(
    questRepo: QuestRepository,
    quest: Quest
): { chainId: string; choiceId: string } | null {
    for (const candidate of questRepo.findAll()) {
        const sourceChainId = candidate.chain.chainId;
        if (sourceChainId === undefined) continue; // a chainless source has no recorded-choice scope
        const match = candidate.chain.branches.find(b => b.questId === quest.id);
        if (match) return { chainId: sourceChainId, choiceId: match.choiceId };
    }
    return null;
}

/**
 * Derive the per-character unlockState for a quest from STORED data only:
 *  - completed: in the character's completedQuests
 *  - active:    in the character's activeQuests
 *  - available: gate (prereqs + skill + branch choice) passes
 *  - locked:    gate fails
 */
function deriveUnlockState(
    questRepo: QuestRepository,
    quest: Quest,
    character: Character,
    log: { activeQuests: string[]; completedQuests: string[]; chainChoices: Record<string, string> }
): UnlockState {
    if (log.completedQuests.includes(quest.id)) return 'completed';
    if (log.activeQuests.includes(quest.id)) return 'active';
    if (questGateReason(quest, character, log.completedQuests) !== null) return 'locked';
    // Branch gate: an unchosen branch target stays locked even when its
    // prerequisites pass.
    const branchGate = findBranchGate(questRepo, quest);
    if (branchGate && log.chainChoices[branchGate.chainId] !== branchGate.choiceId) {
        return 'locked';
    }
    return 'available';
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

async function handleCreate(args: z.infer<typeof CreateSchema>): Promise<object> {
    const { questRepo } = ensureDb();
    const now = new Date().toISOString();

    // Ensure all objectives have IDs and required fields
    const objectives = args.objectives.map(obj => ({
        ...obj,
        id: obj.id || randomUUID(),
        target: obj.target || '',
        current: obj.current ?? 0,
        completed: obj.completed ?? false
    }));

    const quest = {
        id: randomUUID(),
        name: args.name,
        description: args.description,
        worldId: args.worldId,
        giver: args.giver,
        objectives,
        rewards: args.rewards,
        prerequisites: args.prerequisites,
        skillRequirements: args.skillRequirements,
        chain: args.chain,
        status: args.status,
        createdAt: now,
        updatedAt: now
    };

    questRepo.create(quest);

    return {
        success: true,
        actionType: 'create',
        questId: quest.id,
        name: quest.name,
        objectiveCount: objectives.length,
        message: `Created quest "${quest.name}" with ${objectives.length} objectives`
    };
}

async function handleGet(args: z.infer<typeof GetSchema>): Promise<object> {
    const { questRepo } = ensureDb();
    const quest = questRepo.findById(args.questId);

    if (!quest) {
        return { error: true, message: `Quest ${args.questId} not found` };
    }

    return {
        success: true,
        actionType: 'get',
        quest: {
            id: quest.id,
            name: quest.name,
            description: quest.description,
            worldId: quest.worldId,
            giver: quest.giver,
            status: quest.status,
            objectives: quest.objectives,
            rewards: quest.rewards,
            prerequisites: quest.prerequisites,
            // create persists skillRequirements; return them here so a
            // create→get round-trip preserves the skill gates.
            skillRequirements: quest.skillRequirements,
            // create/set_chain persist chain metadata; return it so a
            // create→set_chain→get round-trip preserves the chain graph.
            chain: quest.chain
        }
    };
}

async function handleList(args: z.infer<typeof ListSchema>): Promise<object> {
    const { questRepo } = ensureDb();
    const quests = questRepo.findAll(args.worldId);

    return {
        success: true,
        actionType: 'list',
        count: quests.length,
        quests: quests.map((q: { id: string; name: string; status?: string; objectives?: unknown[]; worldId: string }) => ({
            id: q.id,
            name: q.name,
            status: q.status || 'available',
            objectiveCount: q.objectives?.length || 0,
            worldId: q.worldId
        }))
    };
}

async function handleAssign(args: z.infer<typeof AssignSchema>): Promise<object> {
    const { questRepo, characterRepo } = ensureDb();

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    const quest = questRepo.findById(args.questId);
    if (!quest) {
        return { error: true, message: `Quest ${args.questId} not found` };
    }

    let log = questRepo.getLog(args.characterId);
    if (!log) {
        log = {
            characterId: args.characterId,
            activeQuests: [],
            completedQuests: [],
            failedQuests: [],
            chainChoices: {}
        };
    }

    if (log.activeQuests.includes(args.questId)) {
        return { error: true, message: `Quest already active for this character` };
    }
    if (log.completedQuests.includes(args.questId)) {
        return { error: true, message: `Quest already completed by this character` };
    }

    // Check prerequisites
    for (const prereqId of quest.prerequisites) {
        if (!log.completedQuests.includes(prereqId)) {
            const prereqQuest = questRepo.findById(prereqId);
            const prereqName = prereqQuest?.name || prereqId;
            return { error: true, message: `Prerequisite quest "${prereqName}" not completed` };
        }
    }

    // PHASE-3: Check skill requirements. Derive the current skill level from the
    // character's stored XP (default skills for legacy characters) rather than a
    // possibly stale stored level.
    for (const req of quest.skillRequirements) {
        const entry = character.skills?.[req.skill];
        const currentLevel = entry ? levelFromXp(entry.xp) : 1;
        if (currentLevel < req.level) {
            return {
                error: true,
                message: `Requires ${req.skill} level ${req.level} (you have ${currentLevel})`
            };
        }
    }

    // PHASE-3: Branch gate. If this quest is a branch target of any quest in its
    // chain, it is only assignable to a character who SELECTED that branch.
    // Prevents both branches of a fork from being startable just because they
    // share the source quest as a prerequisite. Locked branches stay locked
    // until select_branch records the choice.
    const branchGate = findBranchGate(questRepo, quest);
    if (branchGate) {
        const chosen = log.chainChoices[branchGate.chainId];
        if (chosen !== branchGate.choiceId) {
            return {
                error: true,
                message: `Quest "${quest.name}" is a locked branch — choose it via select_branch first`
            };
        }
    }

    log.activeQuests.push(args.questId);
    questRepo.updateLog(log);

    return {
        success: true,
        actionType: 'assign',
        questId: args.questId,
        questName: quest.name,
        characterId: args.characterId,
        characterName: character.name,
        message: `${character.name} has accepted "${quest.name}"`
    };
}

async function handleUpdateObjective(args: z.infer<typeof UpdateObjectiveSchema>): Promise<object> {
    const { questRepo, characterRepo } = ensureDb();

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    const log = questRepo.getLog(args.characterId);
    if (!log || !log.activeQuests.includes(args.questId)) {
        return { error: true, message: `Quest is not active for this character` };
    }

    const quest = questRepo.findById(args.questId);
    if (!quest) {
        return { error: true, message: `Quest ${args.questId} not found` };
    }

    const objectiveIndex = quest.objectives.findIndex(o => o.id === args.objectiveId);
    if (objectiveIndex === -1) {
        return { error: true, message: `Objective ${args.objectiveId} not found in quest` };
    }

    const updatedQuest = questRepo.updateObjectiveProgress(
        args.questId,
        args.objectiveId,
        args.progress
    );

    if (!updatedQuest) {
        return { error: true, message: 'Failed to update objective progress' };
    }

    const objective = updatedQuest.objectives[objectiveIndex];
    const allComplete = questRepo.areAllObjectivesComplete(args.questId);

    return {
        success: true,
        actionType: 'update_objective',
        questId: args.questId,
        questName: updatedQuest.name,
        objective: {
            id: objective.id,
            description: objective.description,
            current: objective.current,
            required: objective.required,
            completed: objective.completed
        },
        questComplete: allComplete,
        message: allComplete
            ? `All objectives complete! Ready to turn in.`
            : `Progress: ${objective.current}/${objective.required}`
    };
}

async function handleCompleteObjective(args: z.infer<typeof CompleteObjectiveSchema>): Promise<object> {
    const { questRepo } = ensureDb();

    const quest = questRepo.findById(args.questId);
    if (!quest) {
        return { error: true, message: `Quest ${args.questId} not found` };
    }

    const objectiveIndex = quest.objectives.findIndex(o => o.id === args.objectiveId);
    if (objectiveIndex === -1) {
        return { error: true, message: `Objective ${args.objectiveId} not found` };
    }

    const updatedQuest = questRepo.completeObjective(args.questId, args.objectiveId);
    if (!updatedQuest) {
        return { error: true, message: 'Failed to complete objective' };
    }

    const objective = updatedQuest.objectives[objectiveIndex];
    const allComplete = questRepo.areAllObjectivesComplete(args.questId);

    return {
        success: true,
        actionType: 'complete_objective',
        questId: args.questId,
        questName: updatedQuest.name,
        objective: {
            id: objective.id,
            description: objective.description,
            completed: true
        },
        questComplete: allComplete,
        message: allComplete
            ? `Objective complete! All objectives done - ready to turn in.`
            : `Objective "${objective.description}" completed`
    };
}

async function handleComplete(args: z.infer<typeof CompleteSchema>): Promise<object> {
    const { questRepo, characterRepo, inventoryRepo, itemRepo } = ensureDb();

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    const quest = questRepo.findById(args.questId);
    if (!quest) {
        return { error: true, message: `Quest ${args.questId} not found` };
    }

    let log = questRepo.getLog(args.characterId);
    if (!log || !log.activeQuests.includes(args.questId)) {
        return { error: true, message: `Quest is not active for this character` };
    }

    // Verify all objectives are completed
    const allCompleted = quest.objectives.every(o => o.completed);
    if (!allCompleted) {
        const incomplete = quest.objectives.filter(o => !o.completed);
        return {
            error: true,
            message: `Not all objectives completed. Remaining: ${incomplete.map(o => o.description).join(', ')}`
        };
    }

    // Grant rewards
    const rewardsGranted: { xp: number; gold: number; items: string[] } = {
        xp: quest.rewards.experience || 0,
        gold: quest.rewards.gold || 0,
        items: []
    };

    // Grant items
    for (const itemId of quest.rewards.items) {
        try {
            inventoryRepo.addItem(args.characterId, itemId, 1);
            const item = itemRepo.findById(itemId);
            rewardsGranted.items.push(item?.name || itemId);
        } catch {
            rewardsGranted.items.push(`${itemId} (not found)`);
        }
    }

    // Update quest log
    log.activeQuests = log.activeQuests.filter(id => id !== args.questId);
    log.completedQuests.push(args.questId);
    questRepo.updateLog(log);

    // Update quest status
    questRepo.update(args.questId, { status: 'completed' });

    // PHASE-3: Quest-chain auto-unlock. With this quest now in completedQuests,
    // any chain.nextQuests whose prerequisites + skill gates now pass become
    // assignable (lock-ness is DERIVED, so there is no status write — we report
    // which quests transitioned locked→available). The gate is re-checked here
    // so chains can NEVER bypass the Phase-3 skill gate.
    const unlockedNext: string[] = [];
    for (const nextId of quest.chain.nextQuests) {
        // Skip self/already-progressed quests.
        if (nextId === args.questId) continue;
        if (log.completedQuests.includes(nextId) || log.activeQuests.includes(nextId)) continue;
        const nextQuest = questRepo.findById(nextId);
        if (!nextQuest) continue; // dangling edge (target deleted) — skip, don't crash
        // Branch targets are NOT auto-unlocked; the player must choose them.
        if (findBranchGate(questRepo, nextQuest)) continue;
        if (questGateReason(nextQuest, character, log.completedQuests) === null) {
            unlockedNext.push(nextId);
        }
    }

    // PHASE-3: Branches are offered for the player to choose (NOT auto-unlocked).
    const unlockedBranches = quest.chain.branches;

    return {
        success: true,
        actionType: 'complete',
        questId: args.questId,
        questName: quest.name,
        characterId: args.characterId,
        characterName: character.name,
        rewards: rewardsGranted,
        unlockedNext,
        unlockedBranches,
        message: `${character.name} completed "${quest.name}"! Rewards: ${rewardsGranted.xp} XP, ${rewardsGranted.gold} gold`
    };
}

async function handleGetLog(args: z.infer<typeof GetLogSchema>): Promise<object> {
    const { questRepo, characterRepo } = ensureDb();

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    const fullLog = questRepo.getFullQuestLog(args.characterId);

    const quests = fullLog.quests.map(quest => ({
        id: quest.id,
        name: quest.name,
        description: quest.description,
        status: quest.logStatus,
        giver: quest.giver,
        objectives: quest.objectives.map(obj => ({
            id: obj.id,
            description: obj.description,
            type: obj.type,
            current: obj.current,
            required: obj.required,
            completed: obj.completed
        })),
        rewards: quest.rewards
    }));

    return {
        success: true,
        actionType: 'get_log',
        characterId: args.characterId,
        characterName: character.name,
        summary: fullLog.summary,
        quests
    };
}

// ───────────────────────────────────────────────────────────────────────────
// PHASE-3: QUEST CHAIN ACTIONS
// ───────────────────────────────────────────────────────────────────────────

async function handleSetChain(args: z.infer<typeof SetChainSchema>): Promise<object> {
    const { questRepo } = ensureDb();

    const quest = questRepo.findById(args.questId);
    if (!quest) {
        return { error: true, message: `Quest ${args.questId} not found` };
    }

    const nextQuests = args.nextQuests ?? [];
    const branches = args.branches ?? [];

    // Reject self-reference: a quest may not unlock itself (would dead-lock /
    // loop on completion).
    if (nextQuests.includes(args.questId)) {
        return { error: true, message: `Quest cannot reference itself in nextQuests` };
    }
    if (branches.some(b => b.questId === args.questId)) {
        return { error: true, message: `Quest cannot reference itself in a branch` };
    }

    // Reject duplicate branch choiceIds (ambiguous select_branch target).
    const seenChoices = new Set<string>();
    for (const b of branches) {
        if (seenChoices.has(b.choiceId)) {
            return { error: true, message: `Duplicate branch choiceId "${b.choiceId}"` };
        }
        seenChoices.add(b.choiceId);
    }

    // Validate every referenced quest ID exists (no dangling graph edges).
    const referenced = [...nextQuests, ...branches.map(b => b.questId)];
    for (const refId of referenced) {
        if (!questRepo.findById(refId)) {
            return { error: true, message: `Referenced quest ${refId} does not exist` };
        }
    }

    const chain = {
        chainId: args.chainId,
        order: args.order,
        nextQuests,
        branches
    };

    const updated = questRepo.update(args.questId, { chain });
    if (!updated) {
        // TOCTOU: quest deleted between findById and update.
        return { error: true, message: `Quest ${args.questId} not found` };
    }

    return {
        success: true,
        actionType: 'set_chain',
        questId: args.questId,
        chain: updated.chain
    };
}

/**
 * Resolve the set of quests in a chain. Lookup is by chainId, or by a questId
 * whose stored chain.chainId names the chain. Quests lacking a chainId can
 * still be looked up directly by their own id (singleton chain).
 */
function resolveChainQuests(
    questRepo: QuestRepository,
    opts: { chainId?: string; questId?: string }
): { chainId: string | undefined; quests: Quest[] } | null {
    let chainId = opts.chainId;
    if (chainId === undefined && opts.questId) {
        const seed = questRepo.findById(opts.questId);
        if (!seed) return null;
        chainId = seed.chain.chainId;
        if (chainId === undefined) {
            // No chainId on the seed quest — treat it as a singleton chain.
            return { chainId: undefined, quests: [seed] };
        }
    }
    if (chainId === undefined) return null;
    const all = questRepo.findAll();
    const quests = all.filter(q => q.chain.chainId === chainId);
    return { chainId, quests };
}

async function handleGetChain(args: z.infer<typeof GetChainSchema>): Promise<object> {
    const { questRepo, characterRepo } = ensureDb();

    const resolved = resolveChainQuests(questRepo, { chainId: args.chainId, questId: args.questId });
    if (!resolved || resolved.quests.length === 0) {
        return { error: true, message: `No chain found for ${args.chainId ?? args.questId}` };
    }

    // Per-character unlock state derivation (optional characterId).
    let character: Character | null = null;
    let log: { activeQuests: string[]; completedQuests: string[]; chainChoices: Record<string, string> } = {
        activeQuests: [], completedQuests: [], chainChoices: {}
    };
    if (args.characterId) {
        character = characterRepo.findById(args.characterId);
        if (!character) {
            return { error: true, message: `Character ${args.characterId} not found` };
        }
        const found = questRepo.getLog(args.characterId);
        if (found) {
            log = { activeQuests: found.activeQuests, completedQuests: found.completedQuests, chainChoices: found.chainChoices };
        }
    }

    // Sort by chain.order (undefined orders sink to the end, preserving stable order otherwise).
    const sorted = [...resolved.quests].sort((a, b) => {
        const ao = a.chain.order ?? Number.MAX_SAFE_INTEGER;
        const bo = b.chain.order ?? Number.MAX_SAFE_INTEGER;
        return ao - bo;
    });

    const quests = sorted.map(q => ({
        id: q.id,
        name: q.name,
        order: q.chain.order,
        status: q.status,
        // unlockState is DERIVED, never trusted from the caller.
        unlockState: character ? deriveUnlockState(questRepo, q, character, log) : 'locked' as UnlockState,
        prerequisites: q.prerequisites,
        skillRequirements: q.skillRequirements,
        nextQuests: q.chain.nextQuests,
        branches: q.chain.branches
    }));

    return {
        success: true,
        actionType: 'get_chain',
        chainId: resolved.chainId,
        characterId: args.characterId,
        chainChoices: log.chainChoices,
        quests
    };
}

async function handleListChains(args: z.infer<typeof ListChainsSchema>): Promise<object> {
    const { questRepo } = ensureDb();
    const quests = questRepo.findAll(args.worldId);

    const groups = new Map<string, { chainId: string; questCount: number; completedCount: number }>();
    for (const q of quests) {
        const cid = q.chain.chainId;
        if (cid === undefined) continue; // ungrouped quests are not part of any named chain
        let g = groups.get(cid);
        if (!g) {
            g = { chainId: cid, questCount: 0, completedCount: 0 };
            groups.set(cid, g);
        }
        g.questCount += 1;
        if (q.status === 'completed') g.completedCount += 1;
    }

    return {
        success: true,
        actionType: 'list_chains',
        count: groups.size,
        chains: [...groups.values()]
    };
}

async function handleSelectBranch(args: z.infer<typeof SelectBranchSchema>): Promise<object> {
    const { questRepo, characterRepo } = ensureDb();

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    // Find the source quest in this chain that owns the branch (a completed
    // quest whose chain.branches contains the choiceId).
    const chainQuests = questRepo.findAll().filter(q => q.chain.chainId === args.chainId);
    if (chainQuests.length === 0) {
        return { error: true, message: `No chain found for ${args.chainId}` };
    }

    let branch: { choiceId: string; label: string; questId: string } | undefined;
    let sourceQuest: Quest | undefined;
    for (const q of chainQuests) {
        const match = q.chain.branches.find(b => b.choiceId === args.choiceId);
        if (match) {
            branch = match;
            sourceQuest = q;
            break;
        }
    }

    if (!branch || !sourceQuest) {
        return { error: true, message: `Branch choice "${args.choiceId}" not found in chain ${args.chainId}` };
    }

    // The branch's source quest must have been completed by this character
    // before its branches can be chosen.
    const log = questRepo.getLog(args.characterId);
    if (!log || !log.completedQuests.includes(sourceQuest.id)) {
        return { error: true, message: `Quest "${sourceQuest.name}" must be completed before selecting a branch` };
    }

    // Confirm the chosen branch's target quest still exists.
    const target = questRepo.findById(branch.questId);
    if (!target) {
        return { error: true, message: `Branch target quest ${branch.questId} no longer exists` };
    }

    // Record the choice. The chosen branch's questId becomes assignable purely
    // because the chosen path's prerequisites (typically the source quest) are
    // now satisfied; the OTHER branches stay gated since they are not chosen and
    // their assign path will still see the choice recorded here.
    log.chainChoices[args.chainId] = args.choiceId;
    questRepo.updateLog(log);

    return {
        success: true,
        actionType: 'select_branch',
        characterId: args.characterId,
        chainId: args.chainId,
        choiceId: args.choiceId,
        chosenQuestId: branch.questId,
        message: `Chose "${branch.label}" — unlocked "${target.name}"`
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════

const definitions: Record<QuestManageAction, ActionDefinition> = {
    create: {
        schema: CreateSchema,
        handler: handleCreate,
        aliases: ['new', 'add'],
        description: 'Create a new quest'
    },
    get: {
        schema: GetSchema,
        handler: handleGet,
        aliases: ['fetch', 'find'],
        description: 'Get quest details by ID'
    },
    list: {
        schema: ListSchema,
        handler: handleList,
        aliases: ['all', 'show'],
        description: 'List all quests'
    },
    assign: {
        schema: AssignSchema,
        handler: handleAssign,
        aliases: ['accept', 'start'],
        description: 'Assign a quest to a character'
    },
    update_objective: {
        schema: UpdateObjectiveSchema,
        handler: handleUpdateObjective,
        aliases: ['progress', 'advance'],
        description: 'Update objective progress (requires characterId — quest must be active for that character)'
    },
    complete_objective: {
        schema: CompleteObjectiveSchema,
        handler: handleCompleteObjective,
        aliases: ['finish_objective', 'done_objective'],
        description: 'Mark an objective as complete'
    },
    complete: {
        schema: CompleteSchema,
        handler: handleComplete,
        aliases: ['finish', 'turn_in'],
        description: 'Complete quest and grant rewards'
    },
    get_log: {
        schema: GetLogSchema,
        handler: handleGetLog,
        aliases: ['log', 'journal'],
        description: 'Get character quest log'
    },
    set_chain: {
        schema: SetChainSchema,
        handler: handleSetChain,
        aliases: ['link_chain', 'chain'],
        description: 'Set quest-chain links (nextQuests / branches) on a quest'
    },
    get_chain: {
        schema: GetChainSchema,
        handler: handleGetChain,
        aliases: ['chain_graph', 'view_chain'],
        description: 'Read a chain graph with per-character unlock state'
    },
    list_chains: {
        schema: ListChainsSchema,
        handler: handleListChains,
        aliases: ['chains'],
        description: 'List all quest chains grouped by chainId'
    },
    select_branch: {
        schema: SelectBranchSchema,
        handler: handleSelectBranch,
        aliases: ['choose_branch', 'pick_branch'],
        description: 'Record a branch choice and unlock only the chosen path'
    }
};

const router = createActionRouter({
    actions: ACTIONS,
    definitions,
    threshold: 0.6
});

// ═══════════════════════════════════════════════════════════════════════════
// TOOL DEFINITION & HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export const QuestManageTool = {
    name: 'quest_manage',
    category: 'quest',
    keywords: ['quest', 'objective', 'assign', 'complete', 'reward'],
    capabilities: ['Quest lifecycle', 'Objectives', 'Rewards'],
    description: `Manage RPG quests - creation, assignment, progress, completion, and chains.
Actions: create, get, list, assign, update_objective, complete_objective, complete, get_log, set_chain, get_chain, list_chains, select_branch
Aliases: new→create, accept→assign, progress→update_objective, finish→complete, log→get_log

🔗 QUEST CHAINS (Phase-3):
- set_chain - Link a quest to nextQuests (auto-unlocked on complete) and/or branches (player-choice paths)
- get_chain - View a chain graph with per-character unlock state (locked/available/active/completed)
- list_chains - List all chains grouped by chainId
- select_branch - Record a branch choice; unlocks ONLY the chosen path

📜 QUEST WORKFLOW:
1. create - Define a quest with objectives and rewards
2. assign - Character accepts the quest
3. update_objective - Track progress on objectives (requires characterId)
4. complete_objective - Mark objectives done
5. complete - Turn in quest for rewards
6. get_log - View character's quest journal

🎯 OBJECTIVE TYPES (for create):
Each objective requires a "type" field. Valid values:
- kill: defeat enemies
- collect: gather items
- deliver: bring an item to a destination
- explore: visit a location
- interact: talk to / interact with an entity
- custom: anything else (escape, escort, survive, etc.)`,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        questId: z.string().optional().describe('Quest ID'),
        characterId: z.string().optional().describe('Character ID'),
        objectiveId: z.string().optional().describe('Objective ID'),
        name: z.string().optional().describe('Quest name (for create)'),
        description: z.string().optional().describe('Quest description'),
        worldId: z.string().optional().describe('World ID'),
        giver: z.string().optional().describe('Quest giver name'),
        objectives: z.array(z.any()).optional().describe('Quest objectives. Each requires { description, type } where type is one of: kill, collect, deliver, explore, interact, custom'),
        rewards: z.any().optional().describe('Quest rewards'),
        prerequisites: z.array(z.string()).optional(),
        skillRequirements: z.array(z.any()).optional().describe('Skill gates: [{ skill, level }] checked on assign'),
        status: z.string().optional(),
        progress: z.number().optional().describe('Progress increment'),
        // PHASE-3: quest-chain fields (for set_chain / get_chain / list_chains / select_branch)
        chainId: z.string().optional().describe('Chain (storyline) id'),
        order: z.number().optional().describe('Position in a linear chain (set_chain)'),
        nextQuests: z.array(z.string()).optional().describe('Quest IDs auto-unlocked on complete (set_chain)'),
        branches: z.array(z.any()).optional().describe('Branching paths: [{ choiceId, label, questId }] (set_chain)'),
        choiceId: z.string().optional().describe('Branch choice id (select_branch)')
    })
} satisfies ToolContract;

export async function handleQuestManage(args: unknown, _ctx: SessionContext): Promise<McpResponse> {
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
            case 'create':
                output = RichFormatter.header('Quest Created', '📜');
                output += RichFormatter.keyValue({
                    'ID': `\`${parsed.questId}\``,
                    'Name': parsed.name,
                    'Objectives': parsed.objectiveCount
                });
                break;
            case 'get':
                output = RichFormatter.header('Quest Details', '📜');
                if (parsed.quest) {
                    output += RichFormatter.keyValue({
                        'Name': parsed.quest.name,
                        'Status': parsed.quest.status,
                        'Giver': parsed.quest.giver || 'Unknown',
                        'Objectives': parsed.quest.objectives?.length || 0
                    });
                    if (parsed.quest.objectives?.length > 0) {
                        output += '\n**Objectives:**\n';
                        parsed.quest.objectives.forEach((obj: { completed: boolean; description: string; current: number; required: number }) => {
                            const check = obj.completed ? '☑️' : '☐';
                            output += `  ${check} ${obj.description} (${obj.current}/${obj.required})\n`;
                        });
                    }
                }
                break;
            case 'list':
                output = RichFormatter.header(`Quests (${parsed.count})`, '📜');
                if (parsed.quests?.length > 0) {
                    parsed.quests.forEach((q: { name: string; status: string; objectiveCount: number }) => {
                        output += `• **${q.name}** (${q.status}) - ${q.objectiveCount} objectives\n`;
                    });
                } else {
                    output += 'No quests found.\n';
                }
                break;
            case 'assign':
                output = RichFormatter.header('Quest Assigned', '✅');
                output += RichFormatter.keyValue({
                    'Quest': parsed.questName,
                    'Character': parsed.characterName
                });
                output += RichFormatter.success(parsed.message);
                break;
            case 'update_objective':
                output = RichFormatter.header('Objective Progress', '📊');
                output += RichFormatter.keyValue({
                    'Quest': parsed.questName,
                    'Objective': parsed.objective?.description,
                    'Progress': `${parsed.objective?.current}/${parsed.objective?.required}`,
                    'Complete': parsed.objective?.completed ? '✅' : '❌'
                });
                if (parsed.questComplete) {
                    output += RichFormatter.success('🎉 All objectives complete!');
                }
                break;
            case 'complete_objective':
                output = RichFormatter.header('Objective Completed', '☑️');
                output += RichFormatter.keyValue({
                    'Quest': parsed.questName,
                    'Objective': parsed.objective?.description
                });
                if (parsed.questComplete) {
                    output += RichFormatter.success('🎉 All objectives complete! Ready to turn in.');
                }
                break;
            case 'complete':
                output = RichFormatter.header('Quest Completed!', '🎉');
                output += RichFormatter.keyValue({
                    'Quest': parsed.questName,
                    'Character': parsed.characterName
                });
                output += '\n**Rewards:**\n';
                output += RichFormatter.keyValue({
                    'XP': parsed.rewards?.xp || 0,
                    'Gold': parsed.rewards?.gold || 0
                });
                if (parsed.rewards?.items?.length > 0) {
                    output += '**Items:** ' + parsed.rewards.items.join(', ') + '\n';
                }
                break;
            case 'get_log':
                output = RichFormatter.header(`${parsed.characterName}'s Quest Log`, '📖');
                output += RichFormatter.keyValue({
                    'Active': parsed.summary?.active || 0,
                    'Completed': parsed.summary?.completed || 0,
                    'Failed': parsed.summary?.failed || 0
                });
                if (parsed.quests?.length > 0) {
                    output += '\n';
                    parsed.quests.forEach((q: { name: string; status: string }) => {
                        const icon = q.status === 'completed' ? '✅' : q.status === 'failed' ? '❌' : '📜';
                        output += `${icon} **${q.name}** (${q.status})\n`;
                    });
                }
                break;
            case 'set_chain':
                output = RichFormatter.header('Quest Chain Set', '🔗');
                output += RichFormatter.keyValue({
                    'Quest': `\`${parsed.questId}\``,
                    'Chain': parsed.chain?.chainId || '(none)',
                    'Next': (parsed.chain?.nextQuests || []).length,
                    'Branches': (parsed.chain?.branches || []).length
                });
                break;
            case 'get_chain':
                output = RichFormatter.header(`Quest Chain${parsed.chainId ? `: ${parsed.chainId}` : ''}`, '🔗');
                if (parsed.quests?.length > 0) {
                    parsed.quests.forEach((q: { name: string; unlockState: string }) => {
                        const icon = q.unlockState === 'completed' ? '✅'
                            : q.unlockState === 'active' ? '⚔️'
                            : q.unlockState === 'available' ? '🟢' : '🔒';
                        output += `${icon} **${q.name}** (${q.unlockState})\n`;
                    });
                } else {
                    output += 'No quests in this chain.\n';
                }
                break;
            case 'list_chains':
                output = RichFormatter.header(`Quest Chains (${parsed.count})`, '🔗');
                if (parsed.chains?.length > 0) {
                    parsed.chains.forEach((c: { chainId: string; questCount: number; completedCount: number }) => {
                        output += `• **${c.chainId}** — ${c.completedCount}/${c.questCount} complete\n`;
                    });
                } else {
                    output += 'No chains found.\n';
                }
                break;
            case 'select_branch':
                output = RichFormatter.header('Branch Chosen', '🔀');
                output += RichFormatter.keyValue({
                    'Chain': parsed.chainId,
                    'Choice': parsed.choiceId,
                    'Unlocked': `\`${parsed.chosenQuestId}\``
                });
                if (parsed.message) output += RichFormatter.success(parsed.message);
                break;
            default:
                output = RichFormatter.header('Quest', '📜');
                if (parsed.message) output += parsed.message + '\n';
        }
    }

    output += RichFormatter.embedJson(parsed, 'QUEST_MANAGE');

    return {
        content: [{
            type: 'text' as const,
            text: output
        }]
    };
}
