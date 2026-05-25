/**
 * Consolidated DB-path resolution (#72)
 *
 * Every consolidated tool now resolves its database path through the single
 * resolveConsolidatedDbPath() helper, so they can no longer drift (some honoring
 * RPG_DATA_DIR, others hardcoding 'rpg.db'). These tests pin the three branches.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resolveConsolidatedDbPath } from '../../../src/server/consolidated/db-path.js';

describe('resolveConsolidatedDbPath (#72)', () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origDataDir = process.env.RPG_DATA_DIR;

    afterEach(() => {
        // Restore env so we never leak NODE_ENV / RPG_DATA_DIR to other tests.
        if (origNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = origNodeEnv;
        if (origDataDir === undefined) delete process.env.RPG_DATA_DIR;
        else process.env.RPG_DATA_DIR = origDataDir;
    });

    it('resolves to in-memory under NODE_ENV=test', () => {
        process.env.NODE_ENV = 'test';
        expect(resolveConsolidatedDbPath()).toBe(':memory:');
    });

    it('honors RPG_DATA_DIR when not in test mode', () => {
        process.env.NODE_ENV = 'production';
        process.env.RPG_DATA_DIR = '/tmp/rpgdata';
        expect(resolveConsolidatedDbPath()).toBe('/tmp/rpgdata/rpg.db');
    });

    it("falls back to 'rpg.db' when not in test and RPG_DATA_DIR is unset", () => {
        process.env.NODE_ENV = 'production';
        delete process.env.RPG_DATA_DIR;
        expect(resolveConsolidatedDbPath()).toBe('rpg.db');
    });
});
