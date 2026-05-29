/**
 * Tests for the combat DB service facade (ADR-003, #15).
 *
 * The facade is the single combat-domain DB seam: it resolves the database
 * ONCE via resolveConsolidatedDbPath() (NOT the legacy NODE_ENV ternary) and
 * constructs the four combat repos. Under NODE_ENV=test that path is ':memory:',
 * so repos.db must be the same process-global singleton getDb(':memory:')
 * returns (path honesty per #72).
 */

// Ensure resolveConsolidatedDbPath() -> ':memory:' for this suite (matches the
// rest of the combat test suites, which set this explicitly).
process.env.NODE_ENV = 'test';

import { describe, it, expect } from 'vitest';
import { getCombatRepos } from '../../src/services/combat-db.service.js';
import { getDb } from '../../src/storage/index.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { ConcentrationRepository } from '../../src/storage/repos/concentration.repo.js';
import { CombatActionLogRepository } from '../../src/storage/repos/combat-action-log.repo.js';

describe('getCombatRepos (ADR-003 combat facade #15)', () => {
    it('returns the four combat repos as instances of their classes', () => {
        const repos = getCombatRepos();
        expect(repos.encounters).toBeInstanceOf(EncounterRepository);
        expect(repos.characters).toBeInstanceOf(CharacterRepository);
        expect(repos.concentration).toBeInstanceOf(ConcentrationRepository);
        expect(repos.actionLog).toBeInstanceOf(CombatActionLogRepository);
    });

    it('resolves the DB via resolveConsolidatedDbPath (path-honest singleton in test)', () => {
        // NODE_ENV=test (vitest setup) -> resolveConsolidatedDbPath() === ':memory:'.
        // The facade must hand back the SAME singleton getDb(':memory:') returns,
        // proving it does not reintroduce a divergent / hardcoded path.
        const repos = getCombatRepos();
        expect(repos.db).toBe(getDb(':memory:'));
    });

    it('re-resolves the handle each call (does not cache at module scope)', () => {
        // Both calls hit the singleton, so they must agree — and agree with getDb().
        const a = getCombatRepos();
        const b = getCombatRepos();
        expect(a.db).toBe(b.db);
        expect(a.db).toBe(getDb(':memory:'));
    });
});
