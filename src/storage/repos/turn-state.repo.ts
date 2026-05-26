import Database from 'better-sqlite3';
import { z } from 'zod';
import { TurnState, TurnStateSchema, TurnAction, TurnActionSchema } from '../../schema/turn-state.js';

interface TurnStateRow {
    world_id: string;
    current_turn: number;
    turn_phase: string;
    phase_started_at: string;
    nations_ready: string;
    created_at: string;
    updated_at: string;
}

export class TurnStateRepository {
    constructor(private db: Database.Database) { }

    create(turnState: TurnState): void {
        const valid = TurnStateSchema.parse(turnState);
        const stmt = this.db.prepare(`
            INSERT INTO turn_state (world_id, current_turn, turn_phase, phase_started_at, nations_ready, created_at, updated_at)
            VALUES (@worldId, @currentTurn, @turnPhase, @phaseStartedAt, @nationsReady, @createdAt, @updatedAt)
        `);
        stmt.run({
            ...valid,
            worldId: valid.worldId,
            currentTurn: valid.currentTurn,
            turnPhase: valid.turnPhase,
            phaseStartedAt: valid.phaseStartedAt,
            nationsReady: JSON.stringify(valid.nationsReady),
        });
    }

    findByWorldId(worldId: string): TurnState | null {
        const stmt = this.db.prepare('SELECT * FROM turn_state WHERE world_id = ?');
        const row = stmt.get(worldId) as TurnStateRow | undefined;
        if (!row) return null;
        return this.mapRowToTurnState(row);
    }

    updatePhase(worldId: string, phase: 'planning' | 'resolution' | 'finished'): void {
        const stmt = this.db.prepare(`
            UPDATE turn_state 
            SET turn_phase = ?, phase_started_at = ?, updated_at = ?
            WHERE world_id = ?
        `);
        const now = new Date().toISOString();
        stmt.run(phase, now, now, worldId);
    }

    addReadyNation(worldId: string, nationId: string): void {
        const current = this.findByWorldId(worldId);
        if (!current) throw new Error('Turn state not found');
        if (current.nationsReady.includes(nationId)) return; // Already ready

        const updated = [...current.nationsReady, nationId];
        const stmt = this.db.prepare(`
            UPDATE turn_state 
            SET nations_ready = ?, updated_at = ?
            WHERE world_id = ?
        `);
        stmt.run(JSON.stringify(updated), new Date().toISOString(), worldId);
    }

    clearReadyNations(worldId: string): void {
        const stmt = this.db.prepare(`
            UPDATE turn_state 
            SET nations_ready = '[]', updated_at = ?
            WHERE world_id = ?
        `);
        stmt.run(new Date().toISOString(), worldId);
    }

    incrementTurn(worldId: string): void {
        const stmt = this.db.prepare(`
            UPDATE turn_state
            SET current_turn = current_turn + 1, updated_at = ?
            WHERE world_id = ?
        `);
        stmt.run(new Date().toISOString(), worldId);
    }

    // ── Submitted-action queue (#67): submit_actions records intent here; the
    //    actions are applied to the world only at turn resolution. ──────────────

    /** Replace a nation's queued actions for the given turn. */
    queueActions(worldId: string, turn: number, nationId: string, actions: TurnAction[]): void {
        // Validate at write time so the queue never persists malformed actions.
        const validated = z.array(TurnActionSchema).parse(actions);
        const now = new Date().toISOString();
        const stmt = this.db.prepare(`
            INSERT INTO turn_action_queue (world_id, turn, nation_id, actions, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(world_id, turn, nation_id) DO UPDATE SET
                actions = excluded.actions, updated_at = excluded.updated_at
        `);
        stmt.run(worldId, turn, nationId, JSON.stringify(validated), now, now);
    }

    /** All queued actions for a turn, grouped by nation (submission order). */
    getQueuedActions(worldId: string, turn: number): Array<{ nationId: string; actions: TurnAction[] }> {
        // Order by nation_id, not created_at: resolution must be deterministic and
        // neutral, not biased by which nation happened to submit first. (#67 — CodeRabbit)
        const stmt = this.db.prepare(
            'SELECT nation_id, actions FROM turn_action_queue WHERE world_id = ? AND turn = ? ORDER BY nation_id'
        );
        const rows = stmt.all(worldId, turn) as Array<{ nation_id: string; actions: string }>;
        // Validate persisted payloads instead of trusting a raw cast — a malformed
        // queue row must fail loudly, not feed garbage into resolution.
        return rows.map(r => ({
            nationId: r.nation_id,
            actions: z.array(TurnActionSchema).parse(JSON.parse(r.actions)) as TurnAction[],
        }));
    }

    /** Clear the queue for a resolved turn. */
    clearQueuedActions(worldId: string, turn: number): void {
        this.db.prepare('DELETE FROM turn_action_queue WHERE world_id = ? AND turn = ?').run(worldId, turn);
    }

    private mapRowToTurnState(row: TurnStateRow): TurnState {
        return TurnStateSchema.parse({
            worldId: row.world_id,
            currentTurn: row.current_turn,
            turnPhase: row.turn_phase,
            phaseStartedAt: row.phase_started_at,
            nationsReady: JSON.parse(row.nations_ready),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        });
    }
}
