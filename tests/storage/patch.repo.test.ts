
import * as fs from 'fs';
import { initDB } from '../../src/storage/db';
import { migrate } from '../../src/storage/migrations';
import { PatchRepository } from '../../src/storage/repos/patch.repo';
import { MapPatch } from '../../src/schema/patch';
import { FIXED_TIMESTAMP } from '../fixtures';

const TEST_DB_PATH = 'test-patch-repo.db';

describe('PatchRepository', () => {
    let db: ReturnType<typeof initDB>;
    let repo: PatchRepository;

    beforeEach(() => {
        if (fs.existsSync(TEST_DB_PATH)) {
            fs.unlinkSync(TEST_DB_PATH);
        }
        db = initDB(TEST_DB_PATH);
        migrate(db);
        repo = new PatchRepository(db);
    });

    afterEach(() => {
        db.close();
        if (fs.existsSync(TEST_DB_PATH)) {
            fs.unlinkSync(TEST_DB_PATH);
        }
    });

    it('should log and retrieve patches', () => {
        const patch1: MapPatch = {
            op: 'add',
            path: '/structures/1',
            value: { id: 's1' },
            timestamp: FIXED_TIMESTAMP,
        };
        const patch2: MapPatch = {
            op: 'remove',
            path: '/structures/2',
            timestamp: FIXED_TIMESTAMP,
        };

        repo.log(patch1);
        repo.log(patch2);

        const history = repo.getHistory();
        expect(history).toHaveLength(2);
        expect(history[0]).toEqual(patch1);
        expect(history[1]).toEqual(patch2);
    });

    it('logs and retrieves world-scoped DSL patch scripts in order (#62)', () => {
        repo.logScript('world-A', 'ADD_STRUCTURE city 5 5 "X"');
        repo.logScript('world-A', 'ADD_STRUCTURE town 6 6 "Y"');
        repo.logScript('world-B', 'ADD_STRUCTURE village 1 1 "Z"');

        expect(repo.getScripts('world-A')).toEqual([
            'ADD_STRUCTURE city 5 5 "X"',
            'ADD_STRUCTURE town 6 6 "Y"',
        ]);
        expect(repo.getScripts('world-B')).toHaveLength(1);
        expect(repo.getScripts('missing')).toEqual([]);
    });

    it('keeps DSL script rows out of the legacy op/path/value history (#62)', () => {
        repo.log({ op: 'add', path: '/structures/1', value: { id: 's1' }, timestamp: FIXED_TIMESTAMP });
        repo.logScript('world-A', 'ADD_STRUCTURE city 5 5 "X"');

        // getHistory only sees the legacy patch; getScripts only sees the DSL script.
        const history = repo.getHistory();
        expect(history).toHaveLength(1);
        expect(history[0].op).toBe('add');
        expect(repo.getScripts('world-A')).toEqual(['ADD_STRUCTURE city 5 5 "X"']);
    });

    it('rejects empty worldId or script (#62)', () => {
        expect(() => repo.logScript('', 'ADD_STRUCTURE city 1 1 "X"')).toThrow();
        expect(() => repo.logScript('world-A', '')).toThrow();
    });
});
