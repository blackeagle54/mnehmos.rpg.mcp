import Database from 'better-sqlite3';
import { join, isAbsolute } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { initDB } from './db.js';
import { migrate } from './migrations.js';

let dbInstance: Database.Database | null = null;
let configuredDbPath: string | null = null;
// Resolved path of the currently-open singleton instance (null when uninitialized). (#68)
let activeDbPath: string | null = null;

/**
 * Get the platform-specific app data directory for rpg-mcp.
 * - Windows: %APPDATA%/rpg-mcp
 * - macOS: ~/Library/Application Support/rpg-mcp
 * - Linux: ~/.local/share/rpg-mcp
 */
function getAppDataDir(): string {
    const platform = process.platform;
    let appDataDir: string;

    if (platform === 'win32') {
        // Windows: %APPDATA% (typically C:\Users\<user>\AppData\Roaming)
        appDataDir = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    } else if (platform === 'darwin') {
        // macOS: ~/Library/Application Support
        appDataDir = join(homedir(), 'Library', 'Application Support');
    } else {
        // Linux/Unix: ~/.local/share (XDG Base Directory spec)
        appDataDir = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
    }

    const rpgMcpDir = join(appDataDir, 'rpg-mcp');
    
    // Ensure the directory exists
    if (!existsSync(rpgMcpDir)) {
        mkdirSync(rpgMcpDir, { recursive: true });
        console.error(`[Database] Created app data directory: ${rpgMcpDir}`);
    }

    return rpgMcpDir;
}

/**
 * Get the default database path.
 * Uses environment variable, CLI argument, or falls back to app data directory.
 *
 * Priority:
 * 1. RPG_MCP_DB_PATH environment variable
 * 2. --db-path CLI argument
 * 3. Platform-specific app data directory (%APPDATA%/rpg-mcp on Windows)
 */
function getDefaultDbPath(): string {
    // Check for environment variable first
    if (process.env.RPG_MCP_DB_PATH) {
        return process.env.RPG_MCP_DB_PATH;
    }

    // Check for CLI argument --db-path
    const args = process.argv;
    const dbPathIndex = args.indexOf('--db-path');
    if (dbPathIndex !== -1 && args[dbPathIndex + 1]) {
        return args[dbPathIndex + 1];
    }

    // Use platform-specific app data directory
    return join(getAppDataDir(), 'rpg.db');
}

/**
 * Resolve database path, ensuring it's absolute.
 */
function resolveDbPath(path?: string): string {
    const dbPath = path || configuredDbPath || getDefaultDbPath();

    // Special case: SQLite in-memory database
    if (dbPath === ':memory:') {
        return dbPath;
    }

    if (isAbsolute(dbPath)) {
        return dbPath;
    }

    // CRIT-005: If the path is the default 'rpg.db', use APPDATA instead of CWD
    // This ensures the database is always in a consistent location
    if (dbPath === 'rpg.db') {
        return join(getAppDataDir(), 'rpg.db');
    }

    // Make relative paths absolute based on CWD
    return join(process.cwd(), dbPath);
}

/**
 * Configure the database path before initialization.
 * Call this before getDb() to set a custom path.
 */
export function configureDbPath(path: string): void {
    if (dbInstance) {
        throw new Error('Cannot configure database path after database has been initialized');
    }
    configuredDbPath = isAbsolute(path) ? path : join(process.cwd(), path);
}

/**
 * Get the configured or default database path (for logging/debugging).
 */
export function getDbPath(): string {
    // Report the ACTIVE instance's path once initialized; otherwise the path a
    // fresh getDb() would resolve to. (#68)
    return activeDbPath ?? resolveDbPath();
}

export function getDb(path?: string): Database.Database {
    if (!dbInstance) {
        const resolvedPath = resolveDbPath(path);
        console.error(`[Database] Initializing database at: ${resolvedPath}`);
        // Keep the handle local until migration succeeds: if migrate() throws,
        // don't publish a half-initialized singleton (which would be reused by the
        // next getDb() and never retry migrations). Close the handle on failure. (#68)
        const db = initDB(resolvedPath);
        try {
            migrate(db);
        } catch (err) {
            db.close();
            throw err;
        }
        dbInstance = db;
        activeDbPath = resolvedPath;
        return dbInstance;
    }
    // Process-global singleton: an explicit path that conflicts with the open
    // instance is rejected rather than silently returning a different DB. Only
    // enforced when the active path is known — an injected instance with no
    // resolvable path (activeDbPath null) can't be proven to conflict. (#68)
    if (path !== undefined && activeDbPath !== null) {
        const requested = resolveDbPath(path);
        if (requested !== activeDbPath) {
            throw new Error(
                `[Database] Already initialized at "${activeDbPath}"; cannot open a different ` +
                `path "${requested}". getDb() is a process-global singleton — call closeDb() ` +
                `before switching databases.`
            );
        }
    }
    return dbInstance;
}

export function setDb(database: Database.Database) {
    dbInstance = database;
    // better-sqlite3 exposes the opened path as `.name` (':memory:' for in-memory),
    // so getDbPath() stays accurate for injected instances too. (#68)
    activeDbPath = (database as { name?: string }).name ?? null;
}

/**
 * Close the database with proper WAL checkpoint.
 * This ensures all WAL data is written to the main database file.
 */
export function closeDb() {
    if (dbInstance) {
        try {
            // Checkpoint WAL to ensure all changes are written to main database
            dbInstance.pragma('wal_checkpoint(TRUNCATE)');
            console.error('[Database] WAL checkpoint completed');
        } catch (e) {
            console.error('[Database] WAL checkpoint failed:', (e as Error).message);
        }
        dbInstance.close();
        dbInstance = null;
        activeDbPath = null;
        console.error('[Database] Database closed');
    }
}

export * from './db.js';
export * from './migrations.js';
export * from './audit.repo.js';
