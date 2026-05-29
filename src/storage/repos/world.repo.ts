import Database from 'better-sqlite3';
import { World, WorldSchema } from '../../schema/world.js';

export class WorldRepository {
    constructor(private db: Database.Database) {
        this.ensureColumns();
    }

    private ensureColumns() {
        try {
            const columns = this.db.prepare(`PRAGMA table_info(worlds)`).all() as any[];
            const names = new Set(columns.map(col => col.name));
            if (!names.has('environment')) {
                this.db.exec(`ALTER TABLE worlds ADD COLUMN environment TEXT`);
            }
            // Persist procedural generation options for lossless world rehydration. (#61)
            if (!names.has('gen_options')) {
                this.db.exec(`ALTER TABLE worlds ADD COLUMN gen_options TEXT`);
            }
        } catch (err) {
            // Ignore if table doesn't exist yet; creation/migrations will handle it
        }
    }

    create(world: World): void {
        const validWorld = WorldSchema.parse(world);
        const stmt = this.db.prepare(`
      INSERT INTO worlds (id, name, seed, width, height, created_at, updated_at, environment, gen_options)
      VALUES (@id, @name, @seed, @width, @height, @createdAt, @updatedAt, @environment, @genOptions)
    `);
        stmt.run({
            id: validWorld.id,
            name: validWorld.name,
            seed: validWorld.seed,
            width: validWorld.width,
            height: validWorld.height,
            createdAt: validWorld.createdAt,
            updatedAt: validWorld.updatedAt,
            environment: JSON.stringify(validWorld.environment || {}),
            genOptions: JSON.stringify(validWorld.genOptions || {})
        });
    }

    private static parseJsonColumn(value: string | null | undefined): Record<string, unknown> {
        if (!value) return {};
        try {
            return JSON.parse(value);
        } catch {
            return {};
        }
    }

    findById(id: string): World | null {
        const stmt = this.db.prepare('SELECT * FROM worlds WHERE id = ?');
        const row = stmt.get(id) as WorldRow | undefined;

        if (!row) return null;

        return WorldSchema.parse({
            id: row.id,
            name: row.name,
            seed: row.seed,
            width: row.width,
            height: row.height,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            environment: WorldRepository.parseJsonColumn(row.environment),
            genOptions: WorldRepository.parseJsonColumn(row.gen_options),
        });
    }

    findAll(): World[] {
        const stmt = this.db.prepare('SELECT * FROM worlds');
        const rows = stmt.all() as WorldRow[];

        return rows.map((row) =>
            WorldSchema.parse({
                id: row.id,
                name: row.name,
                seed: row.seed,
                width: row.width,
                height: row.height,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                environment: WorldRepository.parseJsonColumn(row.environment),
                genOptions: WorldRepository.parseJsonColumn(row.gen_options),
            })
        );
    }

    delete(id: string): void {
        const stmt = this.db.prepare('DELETE FROM worlds WHERE id = ?');
        stmt.run(id);
    }

    updateEnvironment(id: string, envPatch: Record<string, any>): World | null {
        const current = this.findById(id);
        if (!current) return null;

        const mergedEnv = { ...(current.environment || {}), ...envPatch };
        const updatedAt = new Date().toISOString();

        const stmt = this.db.prepare(`
          UPDATE worlds
          SET environment = @environment,
              updated_at = @updatedAt
          WHERE id = @id
        `);

        stmt.run({
            id,
            environment: JSON.stringify(mergedEnv),
            updatedAt,
        });

        return {
            ...current,
            environment: mergedEnv,
            updatedAt,
        };
    }
}

interface WorldRow {
    id: string;
    name: string;
    seed: string;
    width: number;
    height: number;
    created_at: string;
    updated_at: string;
    environment?: string | null;
    gen_options?: string | null;
}
