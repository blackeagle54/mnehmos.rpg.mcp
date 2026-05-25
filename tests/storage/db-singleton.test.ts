/**
 * getDb() process-singleton path semantics (#68)
 *
 * getDb(path?) looks path-aware but only the first call wins — later callers
 * silently received the first instance even when requesting a different path,
 * and getDbPath() reported the configured/default path rather than the path of
 * the instance actually open. These tests pin: the active path is reported, and
 * a conflicting path is rejected rather than silently ignored.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, getDbPath, closeDb, setDb } from '../../src/storage/index.js';

describe('getDb singleton path semantics (#68)', () => {
    beforeEach(() => closeDb()); // start from an uninitialized singleton
    afterEach(() => closeDb());

    it('getDbPath() reports the active instance path once initialized', () => {
        getDb(':memory:');
        expect(getDbPath()).toBe(':memory:');
    });

    it('rejects a conflicting path instead of silently returning the first instance', () => {
        const db1 = getDb(':memory:');

        // A different path must be rejected loudly, not silently ignored.
        expect(() => getDb('/tmp/rpgmcp-conflict-should-not-open.db'))
            .toThrow(/already initialized|different path|singleton/i);

        // The same path — or no path — still returns the existing instance.
        expect(getDb(':memory:')).toBe(db1);
        expect(getDb()).toBe(db1);
    });

    it('does not throw a confusing "null path" error when the active path is unknown (#68 — CodeRabbit)', () => {
        // An injected instance whose path can't be determined leaves activeDbPath
        // null; the conflict check must be skipped (we can't prove a conflict)
        // rather than reporting "already initialized at null".
        const fake = { name: undefined, close() { /* no-op */ }, pragma() { /* no-op */ } } as never;
        setDb(fake);

        expect(() => getDb('/tmp/rpgmcp-unknown.db')).not.toThrow();
        expect(getDb('/tmp/rpgmcp-unknown.db')).toBe(fake);
    });
});
