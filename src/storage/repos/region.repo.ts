import Database from 'better-sqlite3';
import { Region, RegionSchema } from '../../schema/region.js';

export class RegionRepository {
    constructor(private db: Database.Database) { }

    create(region: Region): void {
        const validRegion = RegionSchema.parse(region);
        const stmt = this.db.prepare(`
      INSERT INTO regions (
        id, world_id, name, type, center_x, center_y, color, 
        owner_nation_id, control_level, created_at, updated_at
      )
      VALUES (
        @id, @worldId, @name, @type, @centerX, @centerY, @color,
        @ownerNationId, @controlLevel, @createdAt, @updatedAt
      )
    `);
        stmt.run({
            id: validRegion.id,
            worldId: validRegion.worldId,
            name: validRegion.name,
            type: validRegion.type,
            centerX: validRegion.centerX,
            centerY: validRegion.centerY,
            color: validRegion.color,
            ownerNationId: validRegion.ownerNationId || null,
            controlLevel: validRegion.controlLevel || 0,
            createdAt: validRegion.createdAt,
            updatedAt: validRegion.updatedAt,
        });
    }

    /**
     * Create multiple regions in a single transaction.
     * Optimized for worldgen region persistence (#64).
     *
     * Mirrors StructureRepository.createBatch: early-returns 0 on empty, reuses the
     * exact INSERT column list + @-named params from create() (including the
     * owner_nation_id/control_level columns added by the runMigrations ALTER), and
     * validates every row at the DB boundary via RegionSchema.parse.
     *
     * @param regions - Array of regions to create
     * @returns Number of regions created
     */
    createBatch(regions: Region[]): number {
        if (regions.length === 0) return 0;

        const stmt = this.db.prepare(`
            INSERT INTO regions (
                id, world_id, name, type, center_x, center_y, color,
                owner_nation_id, control_level, created_at, updated_at
            )
            VALUES (
                @id, @worldId, @name, @type, @centerX, @centerY, @color,
                @ownerNationId, @controlLevel, @createdAt, @updatedAt
            )
        `);

        const insertMany = this.db.transaction((toInsert: Region[]) => {
            let count = 0;
            for (const region of toInsert) {
                const valid = RegionSchema.parse(region);
                stmt.run({
                    id: valid.id,
                    worldId: valid.worldId,
                    name: valid.name,
                    type: valid.type,
                    centerX: valid.centerX,
                    centerY: valid.centerY,
                    color: valid.color,
                    ownerNationId: valid.ownerNationId || null,
                    controlLevel: valid.controlLevel || 0,
                    createdAt: valid.createdAt,
                    updatedAt: valid.updatedAt,
                });
                count++;
            }
            return count;
        });

        return insertMany(regions);
    }

    findById(id: string): Region | null {
        const stmt = this.db.prepare('SELECT * FROM regions WHERE id = ?');
        const row = stmt.get(id) as RegionRow | undefined;

        if (!row) return null;

        return this.mapRowToRegion(row);
    }

    findByWorldId(worldId: string): Region[] {
        const stmt = this.db.prepare('SELECT * FROM regions WHERE world_id = ?');
        const rows = stmt.all(worldId) as RegionRow[];

        return rows.map((row) => this.mapRowToRegion(row));
    }

    updateOwnership(regionId: string, ownerNationId: string | null, controlLevel: number): void {
        const stmt = this.db.prepare(`
            UPDATE regions 
            SET owner_nation_id = ?, control_level = ?, updated_at = ?
            WHERE id = ?
        `);
        stmt.run(ownerNationId, controlLevel, new Date().toISOString(), regionId);
    }

    findByOwner(ownerNationId: string): Region[] {
        const stmt = this.db.prepare('SELECT * FROM regions WHERE owner_nation_id = ?');
        const rows = stmt.all(ownerNationId) as RegionRow[];
        return rows.map((row) => this.mapRowToRegion(row));
    }

    private mapRowToRegion(row: RegionRow): Region {
        return RegionSchema.parse({
            id: row.id,
            worldId: row.world_id,
            name: row.name,
            type: row.type,
            centerX: row.center_x,
            centerY: row.center_y,
            color: row.color,
            ownerNationId: row.owner_nation_id || undefined,
            controlLevel: row.control_level || 0,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        });
    }
}

interface RegionRow {
    id: string;
    world_id: string;
    name: string;
    type: string;
    center_x: number;
    center_y: number;
    color: string;
    owner_nation_id: string | null;
    control_level: number;
    created_at: string;
    updated_at: string;
}
