/**
 * ADR-003 architecture guard (#15) — combat-domain phase 1.
 *
 * Locks the handler<->repo boundary contract:
 *  - combat-handlers.ts must NOT call getDb() directly (it routes through the
 *    CombatRepos service facade, which is the single combat DB-path seam).
 *  - the facade module exposes getCombatRepos() and the handler exposes the
 *    DI seam (setCombatRepos / resetCombatRepos) so handlers can be driven in
 *    tests without a DB dependency.
 *
 * Source path is resolved from import.meta.url (NOT cwd) so the guard stays
 * meaningful under vitest's per-file isolate forks.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { describe, it, expect } from 'vitest';

import * as combatDb from '../../src/services/combat-db.service.js';
import * as combatHandlers from '../../src/server/handlers/combat-handlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../../');

const combatHandlersSource = readFileSync(
    resolve(repoRoot, 'src/server/handlers/combat-handlers.ts'),
    'utf8'
);

describe('ADR-003 combat handler<->repo boundary (#15)', () => {
    it('combat-handlers.ts contains no direct getDb( calls', () => {
        // Tolerate whitespace before the paren (`getDb (`) so the guard can't be bypassed.
        const matches = combatHandlersSource.match(/getDb\s*\(/g) ?? [];
        // Was 31 before the facade landed -> RED. Must be 0 after.
        expect(matches.length).toBe(0);
    });

    it('combat-handlers.ts does not reintroduce the legacy rpg.db ternary', () => {
        // The whole point of the facade is path-honesty via resolveConsolidatedDbPath().
        // Match either quote style so a "rpg.db" variant can't slip past the guard.
        expect(combatHandlersSource).not.toMatch(/['"]rpg\.db['"]/);
    });

    it('exposes the combat DB facade and the handler DI seam', () => {
        expect(typeof combatDb.getCombatRepos).toBe('function');
        expect(typeof combatHandlers.setCombatRepos).toBe('function');
        expect(typeof combatHandlers.resetCombatRepos).toBe('function');
    });
});
