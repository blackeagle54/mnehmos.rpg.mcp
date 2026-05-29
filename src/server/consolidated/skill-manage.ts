/**
 * Consolidated Skill Management Tool (Phase 3 PR-1).
 *
 * Manages the OSRS-style per-skill XP progression that is ORTHOGONAL to the
 * D&D character level/xp. grant_xp never touches character.xp/level, and the
 * D&D add_xp path never touches skills.
 *
 * Actions:
 *   get_skills         - read the five skills (defaults legacy chars to lvl 1)
 *   grant_xp           - the normal write: add XP, recompute level from the curve
 *   set_level          - admin/seed escape hatch: xp = xpForLevel(level)
 *   check_requirement  - pure read: does the character meet a skill threshold?
 */

import { z } from 'zod';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { SessionContext } from '../types.js';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { resolveConsolidatedDbPath } from './db-path.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { ToolContract } from '../tool-metadata.js';
import {
    SKILL_NAMES,
    SkillNameSchema,
    MAX_SKILL_LEVEL,
    type Skills,
} from '../../schema/skill.js';
import { xpForLevel, levelFromXp, xpProgress } from '../../math/skill-xp.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = ['get_skills', 'grant_xp', 'set_level', 'check_requirement'] as const;
type SkillManageAction = typeof ACTIONS[number];

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPER
// ═══════════════════════════════════════════════════════════════════════════

function ensureDb() {
    const dbPath = resolveConsolidatedDbPath();
    const db = getDb(dbPath);
    return {
        characterRepo: new CharacterRepository(db),
    };
}

/**
 * Default-on-read: legacy characters have no skills, so resolve undefined to
 * the all-{xp:0, level:1} map before any read/write. Single source of truth is
 * SKILL_NAMES, so the five keys never drift.
 */
function resolveSkills(skills: Skills | undefined): Skills {
    if (skills) return skills;
    const fresh = {} as Skills;
    for (const name of SKILL_NAMES) {
        fresh[name] = { xp: 0, level: 1 };
    }
    return fresh;
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const GetSkillsSchema = z.object({
    action: z.literal('get_skills'),
    characterId: z.string().describe('Character ID'),
});

const GrantXpSchema = z.object({
    action: z.literal('grant_xp'),
    characterId: z.string().describe('Character ID'),
    skill: SkillNameSchema.describe('Skill to grant XP to'),
    amount: z.number().int().min(0).describe('XP to grant'),
});

const SetLevelSchema = z.object({
    action: z.literal('set_level'),
    characterId: z.string().describe('Character ID'),
    skill: SkillNameSchema.describe('Skill to set'),
    level: z.number().int().min(1).max(MAX_SKILL_LEVEL).describe('Target skill level (admin/seed)'),
});

const CheckRequirementSchema = z.object({
    action: z.literal('check_requirement'),
    characterId: z.string().describe('Character ID'),
    skill: SkillNameSchema.describe('Skill to check'),
    level: z.number().int().min(1).max(MAX_SKILL_LEVEL).describe('Required skill level'),
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

async function handleGetSkills(args: z.infer<typeof GetSkillsSchema>): Promise<object> {
    const { characterRepo } = ensureDb();
    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    return {
        success: true,
        actionType: 'get_skills',
        characterId: args.characterId,
        characterName: character.name,
        skills: resolveSkills(character.skills),
    };
}

async function handleGrantXp(args: z.infer<typeof GrantXpSchema>): Promise<object> {
    const { characterRepo } = ensureDb();
    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    const skills = resolveSkills(character.skills);
    const entry = skills[args.skill];
    const oldXp = entry.xp;
    const oldLevel = entry.level;

    // Earn-via-XP: clamp at the cap and ALWAYS derive level from the curve —
    // never trust a client-supplied level.
    const newXp = Math.min(xpForLevel(MAX_SKILL_LEVEL), oldXp + args.amount);
    const newLevel = levelFromXp(newXp);

    skills[args.skill] = { xp: newXp, level: newLevel };
    // Orthogonality: only the skills map is updated — character.xp/level untouched.
    // Check the write result: update() returns null if the character was deleted
    // between the read above and this write (TOCTOU window).
    const updated = characterRepo.update(args.characterId, { skills });
    if (!updated) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    return {
        success: true,
        actionType: 'grant_xp',
        characterId: args.characterId,
        characterName: character.name,
        skill: args.skill,
        amount: args.amount,
        oldXp,
        newXp,
        oldLevel,
        newLevel,
        leveledUp: newLevel > oldLevel,
        xpProgress: xpProgress(newXp),
    };
}

async function handleSetLevel(args: z.infer<typeof SetLevelSchema>): Promise<object> {
    const { characterRepo } = ensureDb();
    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    const skills = resolveSkills(character.skills);
    // Admin/seed escape hatch: keep xp/level consistent by anchoring xp to the
    // exact threshold for the requested level.
    const xp = xpForLevel(args.level);
    skills[args.skill] = { xp, level: args.level };
    // Check the write result: update() returns null if the character was deleted
    // between the read above and this write (TOCTOU window).
    const updated = characterRepo.update(args.characterId, { skills });
    if (!updated) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    return {
        success: true,
        actionType: 'set_level',
        characterId: args.characterId,
        characterName: character.name,
        skill: args.skill,
        level: args.level,
        xp,
        xpProgress: xpProgress(xp),
    };
}

async function handleCheckRequirement(args: z.infer<typeof CheckRequirementSchema>): Promise<object> {
    const { characterRepo } = ensureDb();
    const character = characterRepo.findById(args.characterId);
    if (!character) {
        return { error: true, message: `Character ${args.characterId} not found` };
    }

    const skills = resolveSkills(character.skills);
    // Derive the level from stored XP (the authoritative source) rather than
    // trusting a possibly stale stored level.
    const currentLevel = levelFromXp(skills[args.skill].xp);
    const met = currentLevel >= args.level;

    return {
        success: true,
        actionType: 'check_requirement',
        characterId: args.characterId,
        characterName: character.name,
        skill: args.skill,
        currentLevel,
        requiredLevel: args.level,
        met,
        shortfall: met ? 0 : args.level - currentLevel,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════

const definitions: Record<SkillManageAction, ActionDefinition> = {
    get_skills: {
        schema: GetSkillsSchema,
        handler: handleGetSkills,
        aliases: ['skills', 'list_skills', 'view'],
        description: 'Get all skills for a character',
    },
    grant_xp: {
        schema: GrantXpSchema,
        handler: handleGrantXp,
        aliases: ['add_xp', 'award_xp', 'train'],
        description: 'Grant XP to a skill (recomputes level from the curve)',
    },
    set_level: {
        schema: SetLevelSchema,
        handler: handleSetLevel,
        aliases: ['set_skill', 'seed'],
        description: 'Set a skill to an exact level (admin/seed)',
    },
    check_requirement: {
        schema: CheckRequirementSchema,
        handler: handleCheckRequirement,
        aliases: ['check_req', 'meets', 'requires'],
        description: 'Check whether a character meets a skill-level requirement',
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

export const SkillManageTool = {
    name: 'skill_manage',
    // category:'character' — reuses an existing ToolCategory union member rather
    // than widening it (a new 'skill' category would also need tool-metadata.ts
    // and getConsolidatedToolCategories() edits). Skills are a character axis.
    category: 'character',
    keywords: ['skill', 'xp', 'rank', 'train', 'proficiency'],
    capabilities: ['Per-skill XP', 'Skill levels', 'Training'],
    description: `Manage OSRS-style progression skills (orthogonal to D&D level/xp).
Skills: ${SKILL_NAMES.join(', ')}
Actions: get_skills, grant_xp, set_level, check_requirement
Aliases: add_xp→grant_xp, set_skill→set_level, check_req→check_requirement

🎯 SKILL WORKFLOW:
1. grant_xp - award XP; level is recomputed from the curve (never trust a client level)
2. get_skills - read all five skills (legacy characters default to level 1)
3. check_requirement - test a skill-level gate (used by quest skillRequirements)
4. set_level - admin/seed only: anchors xp to the exact level threshold`,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        characterId: z.string().optional().describe('Character ID'),
        skill: z.string().optional().describe(`Skill name: ${SKILL_NAMES.join(', ')}`),
        amount: z.number().optional().describe('XP amount (for grant_xp)'),
        level: z.number().optional().describe('Skill level (for set_level / check_requirement)'),
    }),
} satisfies ToolContract;

export async function handleSkillManage(args: unknown, _ctx: SessionContext): Promise<McpResponse> {
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
            case 'get_skills':
                output = RichFormatter.header(`${parsed.characterName}'s Skills`, '🎯');
                if (parsed.skills) {
                    for (const [name, entry] of Object.entries(parsed.skills as Record<string, { xp: number; level: number }>)) {
                        output += `- **${name}:** level ${entry.level} (${entry.xp} XP)\n`;
                    }
                }
                break;
            case 'grant_xp':
                output = RichFormatter.header('Skill XP Granted', '⬆️');
                output += RichFormatter.keyValue({
                    'Character': parsed.characterName,
                    'Skill': parsed.skill,
                    'XP': `${parsed.oldXp} → ${parsed.newXp}`,
                    'Level': `${parsed.oldLevel} → ${parsed.newLevel}`,
                });
                if (parsed.leveledUp) {
                    output += RichFormatter.success(`🎉 ${parsed.skill} reached level ${parsed.newLevel}!`);
                }
                break;
            case 'set_level':
                output = RichFormatter.header('Skill Level Set', '🛠️');
                output += RichFormatter.keyValue({
                    'Character': parsed.characterName,
                    'Skill': parsed.skill,
                    'Level': parsed.level,
                    'XP': parsed.xp,
                });
                break;
            case 'check_requirement':
                output = RichFormatter.header('Skill Requirement', parsed.met ? '✅' : '❌');
                output += RichFormatter.keyValue({
                    'Character': parsed.characterName,
                    'Skill': parsed.skill,
                    'Required': parsed.requiredLevel,
                    'Current': parsed.currentLevel,
                    'Met': parsed.met ? 'yes' : `no (short ${parsed.shortfall})`,
                });
                break;
            default:
                output = RichFormatter.header('Skill', '🎯');
                if (parsed.message) output += parsed.message + '\n';
        }
    }

    output += RichFormatter.embedJson(parsed, 'SKILL_MANAGE');

    return {
        content: [{
            type: 'text' as const,
            text: output,
        }],
    };
}
