import { z } from 'zod';
import { SkillNameSchema } from './skill.js';

export const QuestSchema = z.object({
    id: z.string(),
    worldId: z.string(),
    name: z.string(),
    description: z.string(),
    status: z.enum(['available', 'active', 'completed', 'failed']),
    objectives: z.array(z.object({
        id: z.string(),
        description: z.string(),
        type: z.enum(['kill', 'collect', 'deliver', 'explore', 'interact', 'custom']),
        target: z.string(), // Entity ID, item ID, location, etc.
        required: z.number().int().min(1),
        current: z.number().int().min(0).default(0),
        completed: z.boolean().default(false)
    })),
    rewards: z.object({
        experience: z.number().int().min(0).default(0),
        gold: z.number().int().min(0).default(0),
        items: z.array(z.string()).default([]) // Item IDs
    }),
    prerequisites: z.array(z.string()).default([]), // Quest IDs that must be completed first
    // PHASE-3: optional OSRS-style skill gates checked on assign.
    skillRequirements: z.array(z.object({
        skill: SkillNameSchema,
        level: z.number().int().min(1).max(99)
    })).default([]),
    // PHASE-3: quest-chain graph. Groups quests into named storylines and wires
    // up the auto-unlock / branching edges. Lock-ness is DERIVED (from
    // prerequisites + skillRequirements), never stored on `status` — see
    // get_chain's unlockState in quest-manage.ts.
    chain: z.object({
        chainId: z.string().optional(), // groups quests into a named storyline
        order: z.number().int().min(0).optional(), // position in a linear chain
        nextQuests: z.array(z.string()).default([]), // quest IDs auto-unlocked on complete
        branches: z.array(z.object({
            choiceId: z.string(),
            label: z.string(),
            questId: z.string()
        })).default([]) // branching paths: completing offers a player choice that unlocks ONE branch
    }).default({ nextQuests: [], branches: [] }),
    giver: z.string().optional(), // NPC ID
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
});

export const QuestLogSchema = z.object({
    characterId: z.string(),
    activeQuests: z.array(z.string()), // Quest IDs
    completedQuests: z.array(z.string()),
    failedQuests: z.array(z.string()),
    // PHASE-3: per-character branch choices, keyed by the SOURCE (branching)
    // quest id -> chosen choiceId. A decision belongs to its branch point, not
    // the whole storyline, so a chain with two branching quests records both
    // (keying by chainId would let the second overwrite the first). Records
    // which branch a character picked at each branching quest so only the chosen
    // path unlocks (see select_branch in quest-manage.ts). Defaults to {} for
    // legacy logs (back-compat on read).
    chainChoices: z.record(z.string(), z.string()).default({})
});

export type Quest = z.infer<typeof QuestSchema>;
export type QuestLog = z.infer<typeof QuestLogSchema>;
