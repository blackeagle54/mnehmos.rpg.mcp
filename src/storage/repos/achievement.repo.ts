import Database from 'better-sqlite3';
import { AchievementDefinition, AchievementDefinitionSchema } from '../../schema/achievement.js';

/**
 * Repository for the GLOBAL achievement catalog (the `achievements` table).
 *
 * Per-character unlock/progress lives on the character row's `achievements` JSON
 * column (see CharacterRepository) — this repo owns ONLY the definitions.
 *
 * Mapping rules (DB row <-> domain):
 *  - hidden:  stored 0/1 integer  <-> boolean
 *  - target:  stored NULL         <-> undefined (non-incremental achievement)
 *  - criteria: stored NULL        <-> undefined
 */
export class AchievementRepository {
    constructor(private db: Database.Database) { }

    /**
     * Insert-or-replace a catalog definition (define is idempotent on id).
     */
    upsert(def: AchievementDefinition): AchievementDefinition {
        const valid = AchievementDefinitionSchema.parse(def);

        const stmt = this.db.prepare(`
            INSERT INTO achievements (id, name, description, category, points, criteria, hidden, target)
            VALUES (@id, @name, @description, @category, @points, @criteria, @hidden, @target)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                category = excluded.category,
                points = excluded.points,
                criteria = excluded.criteria,
                hidden = excluded.hidden,
                target = excluded.target
        `);

        stmt.run({
            id: valid.id,
            name: valid.name,
            description: valid.description,
            category: valid.category,
            points: valid.points,
            criteria: valid.criteria ?? null,
            hidden: valid.hidden ? 1 : 0,
            target: valid.target ?? null,
        });

        return valid;
    }

    findById(id: string): AchievementDefinition | null {
        const row = this.db
            .prepare('SELECT * FROM achievements WHERE id = ?')
            .get(id) as AchievementRow | undefined;
        if (!row) return null;
        return this.rowToDefinition(row);
    }

    findAll(category?: string): AchievementDefinition[] {
        let rows: AchievementRow[];
        if (category) {
            rows = this.db
                .prepare('SELECT * FROM achievements WHERE category = ?')
                .all(category) as AchievementRow[];
        } else {
            rows = this.db.prepare('SELECT * FROM achievements').all() as AchievementRow[];
        }
        return rows.map(row => this.rowToDefinition(row));
    }

    delete(id: string): boolean {
        const result = this.db.prepare('DELETE FROM achievements WHERE id = ?').run(id);
        return result.changes > 0;
    }

    private rowToDefinition(row: AchievementRow): AchievementDefinition {
        return AchievementDefinitionSchema.parse({
            id: row.id,
            name: row.name,
            description: row.description,
            category: row.category,
            points: row.points,
            // NULL columns map back to undefined (omitted) for the optional fields.
            criteria: row.criteria ?? undefined,
            hidden: row.hidden === 1,
            target: row.target ?? undefined,
        });
    }
}

interface AchievementRow {
    id: string;
    name: string;
    description: string;
    category: string;
    points: number;
    criteria: string | null;
    hidden: number;
    target: number | null;
}
