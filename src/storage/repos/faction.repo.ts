import Database from 'better-sqlite3';
import { FactionDefinition, FactionDefinitionSchema } from '../../schema/reputation.js';

/**
 * Repository for the GLOBAL faction catalog (the `factions` table).
 *
 * Per-character reputation VALUES live on the character row's `reputation` JSON
 * column (see CharacterRepository) — this repo owns ONLY the definitions.
 *
 * Mapping rules (DB row <-> domain):
 *  - description: stored NULL <-> undefined
 */
export class FactionRepository {
    constructor(private db: Database.Database) { }

    /**
     * Insert-or-replace a catalog definition (define_faction is idempotent on id).
     */
    upsert(def: FactionDefinition): FactionDefinition {
        const valid = FactionDefinitionSchema.parse(def);

        const stmt = this.db.prepare(`
            INSERT INTO factions (id, name, description, created_at)
            VALUES (@id, @name, @description, @createdAt)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description
        `);

        stmt.run({
            id: valid.id,
            name: valid.name,
            description: valid.description ?? null,
            createdAt: new Date().toISOString(),
        });

        return valid;
    }

    findById(id: string): FactionDefinition | null {
        const row = this.db
            .prepare('SELECT * FROM factions WHERE id = ?')
            .get(id) as FactionRow | undefined;
        if (!row) return null;
        return this.rowToDefinition(row);
    }

    findAll(): FactionDefinition[] {
        const rows = this.db.prepare('SELECT * FROM factions').all() as FactionRow[];
        return rows.map(row => this.rowToDefinition(row));
    }

    delete(id: string): boolean {
        const result = this.db.prepare('DELETE FROM factions WHERE id = ?').run(id);
        return result.changes > 0;
    }

    private rowToDefinition(row: FactionRow): FactionDefinition {
        return FactionDefinitionSchema.parse({
            id: row.id,
            name: row.name,
            // NULL column maps back to undefined (omitted) for the optional field.
            description: row.description ?? undefined,
        });
    }
}

interface FactionRow {
    id: string;
    name: string;
    description: string | null;
    created_at: string;
}
