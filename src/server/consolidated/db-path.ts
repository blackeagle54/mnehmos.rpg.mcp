/**
 * Single source of truth for the database path used by every consolidated tool.
 *
 * Previously each tool inlined its own resolution and they drifted: some honored
 * RPG_DATA_DIR while others hardcoded 'rpg.db'. Because getDb() is a process-global
 * singleton (see #68), whichever tool opened it first decided the active database,
 * and after the #68 conflict guard a mismatch became a hard error. Routing every
 * tool through this helper keeps the resolution identical and prevents re-drift. (#72)
 *
 *  - tests:            in-memory
 *  - RPG_DATA_DIR set: <RPG_DATA_DIR>/rpg.db
 *  - otherwise:        'rpg.db'  (the storage layer resolves this to the app-data dir)
 */
export function resolveConsolidatedDbPath(): string {
    if (process.env.NODE_ENV === 'test') return ':memory:';
    if (process.env.RPG_DATA_DIR) return `${process.env.RPG_DATA_DIR}/rpg.db`;
    return 'rpg.db';
}
