/**
 * Consolidated Turn Management Tool
 * Replaces 5 separate tools: init_turn_state, get_turn_status, submit_turn_actions, mark_ready, poll_turn_results
 */

import { z } from 'zod';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { SessionContext } from '../types.js';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { resolveConsolidatedDbPath } from './db-path.js';
import { TurnStateRepository } from '../../storage/repos/turn-state.repo.js';
import { NationRepository } from '../../storage/repos/nation.repo.js';
import { DiplomacyRepository } from '../../storage/repos/diplomacy.repo.js';
import { RegionRepository } from '../../storage/repos/region.repo.js';
import { TurnProcessor } from '../../engine/strategy/turn-processor.js';
import { ConflictResolver } from '../../engine/strategy/conflict-resolver.js';
import { DiplomacyEngine } from '../../engine/strategy/diplomacy-engine.js';
import { TurnActionSchema } from '../../schema/turn-state.js';
import { ToolContract } from '../tool-metadata.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = [
    'init', 'get_status', 'submit_actions', 'mark_ready', 'poll_results'
] as const;
type TurnAction = typeof ACTIONS[number];

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function getRepos() {
    const dbPath = resolveConsolidatedDbPath();
    const db = getDb(dbPath);
    return {
        turnStateRepo: new TurnStateRepository(db),
        nationRepo: new NationRepository(db),
        diplomacyRepo: new DiplomacyRepository(db),
        regionRepo: new RegionRepository(db),
        db
    };
}

type DiplomaticAction = z.infer<typeof TurnActionSchema>;

/** Human-readable summary of a queued action (no world mutation). (#67) */
function describeQueuedAction(a: DiplomaticAction): string {
    switch (a.type) {
        case 'claim_region': return `claim_region: ${a.regionId ?? ''}`;
        case 'propose_alliance': return `propose_alliance → ${a.toNationId ?? ''}`;
        case 'break_alliance': return `break_alliance → ${a.toNationId ?? ''}`;
        case 'declare_intent': return `declare_intent: ${a.intent ?? ''}`;
        case 'send_message': return `send_message → ${a.toNationId ?? ''}`;
        case 'adjust_relations': return `adjust_relations → ${a.toNationId ?? ''} (${a.opinionDelta ?? 0})`;
        default: return a.type;
    }
}

/**
 * Validate that an action is something resolution can actually execute — a
 * handled type with its required fields — so we reject it at submit time instead
 * of queueing a silent no-op. Returns an error message, or null if OK. (#67)
 */
function validateActionExecutable(a: DiplomaticAction): string | null {
    switch (a.type) {
        case 'claim_region': return a.regionId ? null : 'claim_region requires regionId';
        case 'propose_alliance': return a.toNationId ? null : 'propose_alliance requires toNationId';
        case 'break_alliance': return a.toNationId ? null : 'break_alliance requires toNationId';
        case 'adjust_relations':
            return a.toNationId && a.opinionDelta !== undefined
                ? null
                : 'adjust_relations requires toNationId and opinionDelta';
        case 'declare_intent': return a.intent ? null : 'declare_intent requires intent';
        case 'send_message': return a.message && a.toNationId ? null : 'send_message requires message and toNationId';
        case 'transfer_region': return 'transfer_region is not yet supported';
        default: return `unsupported action type: ${(a as { type?: string }).type}`;
    }
}

/**
 * Apply one queued action's world mutation. Invoked only at turn resolution, so
 * planning-phase submissions stay invisible until the turn advances. (#67)
 *
 * Diplomacy mutations delegate to DiplomacyEngine rather than writing relations
 * inline, so the turn-resolution path shares ONE rule set with the standalone
 * strategy path: the paranoia-adjusted alliance-acceptance threshold, symmetric
 * alliance/break state in both directions, and bounded ([-100,100]) opinion
 * updates. Re-implementing these here let the two paths drift. (#63)
 */
function applyTurnAction(
    action: DiplomaticAction,
    nationId: string,
    diplomacyRepo: DiplomacyRepository,
    diplomacyEngine: DiplomacyEngine
): void {
    switch (action.type) {
        case 'claim_region':
            // Territorial claims aren't the diplomacy engine's concern — write directly.
            if (action.regionId) {
                diplomacyRepo.createClaim({
                    id: `claim-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    nationId,
                    regionId: action.regionId,
                    claimStrength: 100,
                    justification: action.justification,
                    createdAt: new Date().toISOString()
                });
            }
            break;
        case 'propose_alliance':
            // Engine enforces the paranoia-adjusted acceptance rule and, on success,
            // establishes the alliance symmetrically in both directions.
            if (action.toNationId) diplomacyEngine.proposeAlliance(nationId, action.toNationId);
            break;
        case 'break_alliance':
            // Engine clears both directions and applies the break-up opinion penalties.
            if (action.toNationId) diplomacyEngine.breakAlliance(nationId, action.toNationId);
            break;
        case 'adjust_relations':
            // Engine clamps the result into the [-100, 100] opinion bound.
            if (action.toNationId && action.opinionDelta !== undefined) {
                diplomacyEngine.adjustOpinion(nationId, action.toNationId, action.opinionDelta);
            }
            break;
        // declare_intent / send_message: narrative only — no world-state mutation.
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const InitSchema = z.object({
    action: z.literal('init'),
    worldId: z.string().describe('World ID to initialize turn management for')
});

const GetStatusSchema = z.object({
    action: z.literal('get_status'),
    worldId: z.string().describe('World ID to get turn status for')
});

const SubmitActionsSchema = z.object({
    action: z.literal('submit_actions'),
    worldId: z.string().describe('World ID'),
    nationId: z.string().describe('Nation submitting actions'),
    actions: z.array(TurnActionSchema).describe('Array of actions to submit')
});

const MarkReadySchema = z.object({
    action: z.literal('mark_ready'),
    worldId: z.string().describe('World ID'),
    nationId: z.string().describe('Nation marking ready')
});

const PollResultsSchema = z.object({
    action: z.literal('poll_results'),
    worldId: z.string().describe('World ID'),
    turnNumber: z.number().describe('Turn number to poll results for')
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

async function handleInit(args: z.infer<typeof InitSchema>): Promise<object> {
    const { turnStateRepo } = getRepos();

    const existing = turnStateRepo.findByWorldId(args.worldId);
    if (existing) {
        return {
            success: true,
            actionType: 'init',
            worldId: args.worldId,
            alreadyInitialized: true,
            currentTurn: existing.currentTurn,
            phase: existing.turnPhase,
            message: 'Turn state already initialized'
        };
    }

    const now = new Date().toISOString();
    turnStateRepo.create({
        worldId: args.worldId,
        currentTurn: 1,
        turnPhase: 'planning',
        phaseStartedAt: now,
        nationsReady: [],
        createdAt: now,
        updatedAt: now
    });

    return {
        success: true,
        actionType: 'init',
        worldId: args.worldId,
        currentTurn: 1,
        phase: 'planning',
        message: 'Turn state initialized'
    };
}

async function handleGetStatus(args: z.infer<typeof GetStatusSchema>): Promise<object> {
    const { turnStateRepo, nationRepo } = getRepos();

    const turnState = turnStateRepo.findByWorldId(args.worldId);
    if (!turnState) {
        return {
            error: true,
            actionType: 'get_status',
            message: 'Turn state not initialized. Call init first.'
        };
    }

    const allNations = nationRepo.findByWorldId(args.worldId);
    const waitingFor = allNations
        .filter(n => !turnState.nationsReady.includes(n.id))
        .map(n => ({ id: n.id, name: n.name }));

    return {
        success: true,
        actionType: 'get_status',
        worldId: args.worldId,
        currentTurn: turnState.currentTurn,
        phase: turnState.turnPhase,
        phaseStartedAt: turnState.phaseStartedAt,
        nationsReady: turnState.nationsReady.length,
        totalNations: allNations.length,
        waitingFor: waitingFor,
        canSubmitActions: turnState.turnPhase === 'planning',
        allReady: waitingFor.length === 0 && allNations.length > 0
    };
}

async function handleSubmitActions(args: z.infer<typeof SubmitActionsSchema>): Promise<object> {
    const { turnStateRepo, nationRepo, regionRepo } = getRepos();

    const turnState = turnStateRepo.findByWorldId(args.worldId);
    if (!turnState) {
        return {
            error: true,
            actionType: 'submit_actions',
            message: 'Turn state not initialized'
        };
    }

    if (turnState.turnPhase !== 'planning') {
        return {
            error: true,
            actionType: 'submit_actions',
            message: `Cannot submit actions in ${turnState.turnPhase} phase. Only allowed during planning.`
        };
    }

    const nation = nationRepo.findById(args.nationId);
    if (!nation) {
        return {
            error: true,
            actionType: 'submit_actions',
            message: 'Nation not found'
        };
    }
    // World isolation: the nation must belong to this world, not merely exist. (#67 — CodeRabbit)
    if (nation.worldId !== args.worldId) {
        return {
            error: true,
            actionType: 'submit_actions',
            message: 'Nation does not belong to this world'
        };
    }

    // A nation that already marked ready has locked in its turn — it must not be
    // able to submit or alter its queued actions afterward. (#67 — CodeRabbit)
    if (turnState.nationsReady.includes(args.nationId)) {
        return {
            error: true,
            actionType: 'submit_actions',
            message: `${nation.name} has already marked ready this turn; cannot submit or modify actions until the next turn.`
        };
    }

    // Reject anything resolution can't execute (unsupported type or missing
    // required fields) rather than queueing a silent no-op. (#67 — CodeRabbit)
    for (const action of args.actions) {
        const problem = validateActionExecutable(action);
        if (problem) {
            return {
                error: true,
                actionType: 'submit_actions',
                message: `Invalid action — ${problem}`
            };
        }
        // Referenced entities must exist and belong to THIS world — not just be
        // non-empty — so resolution-time writes can't fail or link across worlds. (#67 — CodeRabbit)
        if (action.type === 'claim_region' && action.regionId) {
            const region = regionRepo.findById(action.regionId);
            if (!region || region.worldId !== args.worldId) {
                return {
                    error: true,
                    actionType: 'submit_actions',
                    message: `claim_region references region "${action.regionId}", which is not in this world`
                };
            }
        }
        if ((action.type === 'propose_alliance' || action.type === 'break_alliance' || action.type === 'adjust_relations') && action.toNationId) {
            const target = nationRepo.findById(action.toNationId);
            if (!target || target.worldId !== args.worldId) {
                return {
                    error: true,
                    actionType: 'submit_actions',
                    message: `${action.type} references nation "${action.toNationId}", which is not in this world`
                };
            }
        }
    }

    // Record intent only — world mutations are applied at resolution (mark_ready,
    // once all nations are ready), not during the planning phase. (#67)
    turnStateRepo.queueActions(args.worldId, turnState.currentTurn, args.nationId, args.actions);

    return {
        success: true,
        actionType: 'submit_actions',
        worldId: args.worldId,
        nationId: args.nationId,
        nationName: nation.name,
        turn: turnState.currentTurn,
        actionsSubmitted: args.actions.length,
        queuedActions: args.actions.map(describeQueuedAction),
        message: `Queued ${args.actions.length} action(s) for ${nation.name}; applied when the turn resolves.`
    };
}

async function handleMarkReady(args: z.infer<typeof MarkReadySchema>): Promise<object> {
    const { turnStateRepo, nationRepo, diplomacyRepo, regionRepo, db } = getRepos();

    const turnState = turnStateRepo.findByWorldId(args.worldId);
    if (!turnState) {
        return {
            error: true,
            actionType: 'mark_ready',
            message: 'Turn state not initialized'
        };
    }

    if (turnState.turnPhase !== 'planning') {
        return {
            error: true,
            actionType: 'mark_ready',
            message: `Cannot mark ready in ${turnState.turnPhase} phase`
        };
    }

    const nation = nationRepo.findById(args.nationId);
    if (!nation) {
        return {
            error: true,
            actionType: 'mark_ready',
            message: 'Nation not found'
        };
    }
    // World isolation: the nation must belong to this world, not merely exist. (#67 — CodeRabbit)
    if (nation.worldId !== args.worldId) {
        return {
            error: true,
            actionType: 'mark_ready',
            message: 'Nation does not belong to this world'
        };
    }

    const allNations = nationRepo.findByWorldId(args.worldId);
    const currentTurn = turnState.currentTurn;
    // Would this nation marking ready complete the set? Compute it BEFORE committing
    // the ready flag, so resolution and the ready write can be one atomic unit.
    const readyAfter = new Set(turnState.nationsReady);
    readyAfter.add(args.nationId);
    const willResolve = readyAfter.size === allNations.length && allNations.length > 0;

    if (willResolve) {
        // Resolve the turn atomically: record this nation ready, apply every
        // nation's queued actions, clear the queue, run turn processing, and
        // advance — all-or-nothing. Including the ready write means a resolution
        // failure rolls it back too, so we never get stuck "all ready, still
        // planning". (#67 — CodeRabbit) All steps are synchronous, so the
        // synchronous better-sqlite3 transaction is safe.
        db.transaction(() => {
            turnStateRepo.addReadyNation(args.worldId, args.nationId);
            turnStateRepo.updatePhase(args.worldId, 'resolution');

            // Planning-phase submissions were only recorded; apply them now, routing
            // diplomacy through the shared engine (#63).
            const diplomacyEngine = new DiplomacyEngine(diplomacyRepo, nationRepo);
            const queued = turnStateRepo.getQueuedActions(args.worldId, currentTurn);
            for (const { nationId, actions } of queued) {
                for (const action of actions) {
                    applyTurnAction(action, nationId, diplomacyRepo, diplomacyEngine);
                }
            }
            turnStateRepo.clearQueuedActions(args.worldId, currentTurn);

            // Process turn (conflict resolution on the resulting world).
            const conflictResolver = new ConflictResolver();
            const turnProcessor = new TurnProcessor(nationRepo, regionRepo, diplomacyRepo, conflictResolver);
            turnProcessor.processTurn(args.worldId, currentTurn);

            // Advance to the next planning turn.
            turnStateRepo.updatePhase(args.worldId, 'finished');
            turnStateRepo.incrementTurn(args.worldId);
            turnStateRepo.clearReadyNations(args.worldId);
            turnStateRepo.updatePhase(args.worldId, 'planning');
        })();

        return {
            success: true,
            actionType: 'mark_ready',
            worldId: args.worldId,
            nationId: args.nationId,
            nationName: nation.name,
            allReady: true,
            turnResolved: currentTurn,
            nextTurn: currentTurn + 1,
            message: 'All nations ready! Turn resolved automatically.'
        };
    }

    // Not all ready yet — just record this nation's readiness.
    turnStateRepo.addReadyNation(args.worldId, args.nationId);
    const updated = turnStateRepo.findByWorldId(args.worldId)!;
    const waitingFor = allNations
        .filter(n => !updated.nationsReady.includes(n.id))
        .map(n => ({ id: n.id, name: n.name }));

    return {
        success: true,
        actionType: 'mark_ready',
        worldId: args.worldId,
        nationId: args.nationId,
        nationName: nation.name,
        allReady: false,
        nationsReady: updated.nationsReady.length,
        totalNations: allNations.length,
        waitingFor: waitingFor
    };
}

async function handlePollResults(args: z.infer<typeof PollResultsSchema>): Promise<object> {
    const { turnStateRepo, diplomacyRepo } = getRepos();

    const turnState = turnStateRepo.findByWorldId(args.worldId);
    if (!turnState) {
        return {
            error: true,
            actionType: 'poll_results',
            message: 'Turn state not found'
        };
    }

    if (turnState.currentTurn > args.turnNumber) {
        // Turn has resolved
        const events = diplomacyRepo.getEventsByWorld(args.worldId, args.turnNumber);
        return {
            success: true,
            actionType: 'poll_results',
            worldId: args.worldId,
            turnNumber: args.turnNumber,
            resolved: true,
            eventsCount: events.length,
            events: events.slice(0, 10),
            nextTurn: turnState.currentTurn,
            currentPhase: turnState.turnPhase
        };
    } else if (turnState.turnPhase === 'resolution') {
        return {
            success: true,
            actionType: 'poll_results',
            worldId: args.worldId,
            turnNumber: args.turnNumber,
            resolved: false,
            phase: 'resolution',
            message: 'Turn is being resolved...'
        };
    } else {
        return {
            success: true,
            actionType: 'poll_results',
            worldId: args.worldId,
            turnNumber: args.turnNumber,
            resolved: false,
            phase: turnState.turnPhase,
            currentTurn: turnState.currentTurn,
            message: args.turnNumber === turnState.currentTurn
                ? 'Turn not yet resolved. Waiting for all nations to mark ready.'
                : `Turn ${args.turnNumber} is in the future (current: ${turnState.currentTurn})`
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════

const definitions: Record<TurnAction, ActionDefinition> = {
    init: {
        schema: InitSchema,
        handler: async (args) => handleInit(args as z.infer<typeof InitSchema>),
        aliases: ['initialize', 'init_turn', 'start_turns', 'setup'],
        description: 'Initialize turn management for a world'
    },
    get_status: {
        schema: GetStatusSchema,
        handler: async (args) => handleGetStatus(args as z.infer<typeof GetStatusSchema>),
        aliases: ['status', 'turn_status', 'check_turn', 'get_turn'],
        description: 'Get current turn status and which nations are ready'
    },
    submit_actions: {
        schema: SubmitActionsSchema,
        handler: async (args) => handleSubmitActions(args as z.infer<typeof SubmitActionsSchema>),
        aliases: ['submit', 'actions', 'queue_actions', 'turn_actions'],
        description: 'Submit actions for this turn'
    },
    mark_ready: {
        schema: MarkReadySchema,
        handler: async (args) => handleMarkReady(args as z.infer<typeof MarkReadySchema>),
        aliases: ['ready', 'done', 'end_planning', 'finish_planning'],
        description: 'Signal that nation is done planning for this turn'
    },
    poll_results: {
        schema: PollResultsSchema,
        handler: async (args) => handlePollResults(args as z.infer<typeof PollResultsSchema>),
        aliases: ['results', 'poll', 'check_results', 'get_results'],
        description: 'Check if turn has resolved and get results'
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

export const TurnManageTool = {
    name: 'turn_manage',
    category: 'turn-management',
    keywords: ['turn', 'phase', 'ready', 'poll', 'results', 'async'],
    capabilities: ['Turn phases', 'Action submission', 'Result polling'],
    description: `Turn-based strategy game lifecycle (multi-agent coordination).

🎮 STRATEGY TURN CYCLE:
1. init - Initialize turn state (once per world)
2. get_status - Check current turn, phase, which nations ready
3. submit_actions - Submit batched actions (claims, alliances, diplomacy)
4. mark_ready - Signal planning complete
5. poll_results - Get resolved turn events

⚔️ MULTI-AGENT PLAY:
Each AI agent controls one nation. Turn resolves automatically
when ALL nations call mark_ready. Use get_status to see who's waiting.

📋 ACTION TYPES (for submit_actions):
- claim_region: Territorial expansion
- propose_alliance: Diplomatic pact
- send_message: Communication to other nations
- trade_request: Resource exchange

🔄 INTEGRATION:
- Use strategy_manage for nation state queries
- Use world_manage for world creation
- Each turn triggers economy/conflict resolution

Actions: init, get_status, submit_actions, mark_ready, poll_results`,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        worldId: z.string().describe('World ID'),
        nationId: z.string().optional().describe('Nation ID (for submit_actions, mark_ready)'),
        actions: z.array(TurnActionSchema).optional().describe('Actions to submit'),
        turnNumber: z.number().optional().describe('Turn number (for poll_results)')
    })
} satisfies ToolContract;

export async function handleTurnManage(args: unknown, _ctx: SessionContext): Promise<McpResponse> {
    const result = await router(args as Record<string, unknown>);
    const parsed = JSON.parse(result.content[0].text);

    let output = '';

    if (parsed.error) {
        output = RichFormatter.header('Turn Management Error', '');
        output += RichFormatter.alert(parsed.message || 'Unknown error', 'error');
        if (parsed.suggestions) {
            output += '\n**Did you mean:**\n';
            parsed.suggestions.forEach((s: { value: string; similarity: number }) => {
                output += `  - ${s.value} (${s.similarity}% match)\n`;
            });
        }
    } else {
        switch (parsed.actionType) {
            case 'init':
                output = RichFormatter.header('Turn State', '');
                output += RichFormatter.keyValue({
                    'World': parsed.worldId,
                    'Current Turn': parsed.currentTurn,
                    'Phase': parsed.phase,
                    'Status': parsed.alreadyInitialized ? 'Already initialized' : 'Newly initialized'
                });
                break;

            case 'get_status':
                output = RichFormatter.header('Turn Status', '');
                output += RichFormatter.keyValue({
                    'World': parsed.worldId,
                    'Turn': parsed.currentTurn,
                    'Phase': parsed.phase,
                    'Nations Ready': `${parsed.nationsReady}/${parsed.totalNations}`,
                    'Can Submit': parsed.canSubmitActions ? 'Yes' : 'No'
                });
                if (parsed.waitingFor?.length > 0) {
                    output += '\n**Waiting for:**\n';
                    parsed.waitingFor.forEach((n: { name: string }) => {
                        output += `  • ${n.name}\n`;
                    });
                }
                break;

            case 'submit_actions':
                output = RichFormatter.header('Actions Submitted', '');
                output += RichFormatter.keyValue({
                    'Nation': parsed.nationName,
                    'Turn': parsed.turn,
                    'Actions': parsed.actionsSubmitted
                });
                if (parsed.queuedActions?.length > 0) {
                    output += '\n**Queued (applied at resolution):**\n';
                    parsed.queuedActions.forEach((a: string) => {
                        output += `  • ${a}\n`;
                    });
                }
                break;

            case 'mark_ready':
                output = RichFormatter.header('Nation Ready', '');
                if (parsed.allReady) {
                    output += RichFormatter.alert('All nations ready! Turn resolved.', 'success');
                    output += RichFormatter.keyValue({
                        'Turn Resolved': parsed.turnResolved,
                        'Next Turn': parsed.nextTurn
                    });
                } else {
                    output += RichFormatter.keyValue({
                        'Nation': parsed.nationName,
                        'Ready': `${parsed.nationsReady}/${parsed.totalNations}`
                    });
                    if (parsed.waitingFor?.length > 0) {
                        output += '\n**Still waiting for:**\n';
                        parsed.waitingFor.forEach((n: { name: string }) => {
                            output += `  • ${n.name}\n`;
                        });
                    }
                }
                break;

            case 'poll_results':
                output = RichFormatter.header('Turn Results', '');
                if (parsed.resolved) {
                    output += RichFormatter.alert(`Turn ${parsed.turnNumber} resolved!`, 'success');
                    output += RichFormatter.keyValue({
                        'Events': parsed.eventsCount,
                        'Next Turn': parsed.nextTurn,
                        'Current Phase': parsed.currentPhase
                    });
                } else {
                    output += RichFormatter.keyValue({
                        'Turn': parsed.turnNumber,
                        'Resolved': 'No',
                        'Phase': parsed.phase || parsed.currentPhase,
                        'Message': parsed.message
                    });
                }
                break;

            default:
                output = RichFormatter.header('Turn Management', '');
                output += JSON.stringify(parsed, null, 2) + '\n';
        }
    }

    output += RichFormatter.embedJson(parsed, 'TURN_MANAGE');

    return {
        content: [{
            type: 'text' as const,
            text: output
        }]
    };
}
