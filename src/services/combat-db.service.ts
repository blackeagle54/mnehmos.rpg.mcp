/**
 * Combat DB Service / Facade (ADR-003 — combat domain, phase 1)
 *
 * The single combat-domain seam between MCP combat handlers and the storage
 * layer. Handlers depend on the {@link CombatRepos} interface and never touch
 * getDb() or a DB path directly.
 *
 * WHY THIS EXISTS:
 *  - combat-handlers.ts previously inlined `getDb(NODE_ENV==='test' ? ':memory:'
 *    : 'rpg.db')` 31 times. That hardcoded 'rpg.db' and ignored RPG_DATA_DIR,
 *    violating the #72 single-source-of-truth contract that
 *    resolveConsolidatedDbPath() enforces. Because getDb() is a process-global
 *    singleton with the #68 conflict guard, a 'rpg.db' vs <RPG_DATA_DIR>/rpg.db
 *    mismatch became a hard error once RPG_DATA_DIR was set.
 *  - Routing all combat DB access through resolveConsolidatedDbPath() here makes
 *    the combat domain path-honest, exactly like every consolidated tool.
 *
 * IMPORTANT: do NOT cache the db handle or the repos at module scope. getDb() is
 * a process-global singleton and vitest runs each file in an isolate fork; a
 * memoized handle would pin a stale/closed connection across forks. The factory
 * re-resolves via getDb() on every call (the singleton makes this cheap).
 */

import Database from 'better-sqlite3';
import { getDb } from '../storage/index.js';
import { resolveConsolidatedDbPath } from '../server/consolidated/db-path.js';
import { EncounterRepository } from '../storage/repos/encounter.repo.js';
import { CharacterRepository } from '../storage/repos/character.repo.js';
import { ConcentrationRepository } from '../storage/repos/concentration.repo.js';
import { CombatActionLogRepository } from '../storage/repos/combat-action-log.repo.js';

/**
 * The combat-domain repository bundle the handlers depend on.
 * `db` is exposed for the rare case a handler needs the raw handle, but the
 * preferred contract is to use the typed repos.
 */
export interface CombatRepos {
    db: Database.Database;
    encounters: EncounterRepository;
    characters: CharacterRepository;
    concentration: ConcentrationRepository;
    actionLog: CombatActionLogRepository;
}

/**
 * Resolve the combat DB ONCE (via the #72 single source of truth) and construct
 * the four combat repos. Called per-invocation by the handler DI seam so it
 * always respects the getDb() singleton and vitest isolation.
 */
export function getCombatRepos(): CombatRepos {
    const db = getDb(resolveConsolidatedDbPath());
    return {
        db,
        encounters: new EncounterRepository(db),
        characters: new CharacterRepository(db),
        concentration: new ConcentrationRepository(db),
        actionLog: new CombatActionLogRepository(db),
    };
}
