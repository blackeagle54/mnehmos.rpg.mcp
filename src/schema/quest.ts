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
    giver: z.string().optional(), // NPC ID
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
});

export const QuestLogSchema = z.object({
    characterId: z.string(),
    activeQuests: z.array(z.string()), // Quest IDs
    completedQuests: z.array(z.string()),
    failedQuests: z.array(z.string())
});

export type Quest = z.infer<typeof QuestSchema>;
export type QuestLog = z.infer<typeof QuestLogSchema>;
