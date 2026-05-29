import Database from 'better-sqlite3';
import { MapPatch, MapPatchSchema } from '../../schema/patch.js';

export class PatchRepository {
    constructor(private db: Database.Database) { }

    log(patch: MapPatch): void {
        const validPatch = MapPatchSchema.parse(patch);
        const stmt = this.db.prepare(`
      INSERT INTO patches (op, path, value, timestamp)
      VALUES (@op, @path, @value, @timestamp)
    `);
        stmt.run({
            op: validPatch.op,
            path: validPatch.path,
            value: validPatch.value ? JSON.stringify(validPatch.value) : null,
            timestamp: validPatch.timestamp,
        });
    }

    getHistory(): MapPatch[] {
        // Only the legacy op/path/value rows are MapPatches. World-scoped DSL script
        // rows (script IS NOT NULL) are a separate record type read via getScripts. (#62)
        const stmt = this.db.prepare('SELECT * FROM patches WHERE script IS NULL ORDER BY id ASC');
        const rows = stmt.all() as PatchRow[];

        return rows.map((row) =>
            MapPatchSchema.parse({
                op: row.op,
                path: row.path,
                value: row.value ? JSON.parse(row.value) : undefined,
                timestamp: row.timestamp,
            })
        );
    }

    /**
     * Append a raw DSL map-patch script for a specific world. This is the durable,
     * replayable mutation record used to rehydrate a world's edits on restore (#62).
     * Stored alongside the legacy op/path/value rows; op/path are NOT NULL in the
     * table, so sentinel values are supplied and `value` is left null.
     */
    logScript(worldId: string, script: string): void {
        if (!worldId) throw new Error('logScript requires a non-empty worldId');
        if (!script) throw new Error('logScript requires a non-empty script');
        const stmt = this.db.prepare(`
      INSERT INTO patches (world_id, script, op, path, value, timestamp)
      VALUES (@worldId, @script, 'replace', '/', NULL, @timestamp)
    `);
        stmt.run({ worldId, script, timestamp: new Date().toISOString() });
    }

    /** Return a world's DSL map-patch scripts in application order (oldest first). (#62) */
    getScripts(worldId: string): string[] {
        const rows = this.db
            .prepare('SELECT script FROM patches WHERE world_id = ? AND script IS NOT NULL ORDER BY id ASC')
            .all(worldId) as { script: string }[];
        return rows.map((row) => row.script);
    }
}

interface PatchRow {
    op: string;
    path: string;
    value: string | null;
    timestamp: string;
}
