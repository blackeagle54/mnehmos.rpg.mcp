/**
 * Regression test for durable map-patch persistence (issue #62).
 *
 * Applied DSL patches (ADD_STRUCTURE/SET_BIOME/EDIT_TILE/MOVE_STRUCTURE) lived only
 * in the in-memory world. On eviction/restart, getOrRestoreWorld regenerated purely
 * from (seed, dimensions, genOptions) and silently discarded those mutations. This
 * proves patches survive eviction by being persisted and replayed on restore.
 */
import { handleWorldMap } from '../../src/server/consolidated/world-map.js';
import { handleWorldManage } from '../../src/server/consolidated/world-manage.js';
import { getDb } from '../../src/storage/index.js';
import { getWorldManager } from '../../src/server/state/world-manager.js';
import { randomUUID } from 'crypto';

process.env.NODE_ENV = 'test';

function parseMap(result: { content: Array<{ type: string; text: string }> }) {
    const t = result.content[0].text;
    const m = t.match(/<!-- WORLD_MAP_JSON\n([\s\S]*?)\nWORLD_MAP_JSON -->/);
    return m ? JSON.parse(m[1]) : JSON.parse(t);
}
function parseWorld(result: { content: Array<{ type: string; text: string }> }) {
    const t = result.content[0].text;
    const m = t.match(/<!-- WORLD_MANAGE_JSON\n([\s\S]*?)\nWORLD_MANAGE_JSON -->/);
    return m ? JSON.parse(m[1]) : JSON.parse(t);
}

describe('world_map patch persistence across eviction (issue #62)', () => {
    let ctx: { sessionId: string };

    beforeEach(() => {
        ctx = { sessionId: `test-${randomUUID()}` };
        getDb(':memory:').exec('DELETE FROM worlds; DELETE FROM patches;');
    });

    it('replays applied map patches after the in-memory world is evicted', async () => {
        const gen = parseWorld(await handleWorldManage({
            action: 'generate', seed: 'persist-test', width: 30, height: 30
        }, ctx));
        const worldId = gen.worldId as string;

        const baseline = parseMap(await handleWorldMap({ action: 'overview', worldId }, ctx)).structureCount as number;

        // Pick a terrain-valid coordinate for a city (deterministic for this seed).
        const poi = parseMap(await handleWorldMap({ action: 'find_poi', worldId, poiType: 'city', count: 1 }, ctx));
        const { x, y } = poi.candidates[0];

        const patch = parseMap(await handleWorldMap({
            action: 'patch', worldId, script: `ADD_STRUCTURE city ${x} ${y} "Persisted City"`
        }, ctx));
        expect(patch.success).toBe(true);

        // Applied in-memory: structure count is up by one.
        expect(parseMap(await handleWorldMap({ action: 'overview', worldId }, ctx)).structureCount).toBe(baseline + 1);

        // Evict the in-memory world → the next access must restore from the DB.
        expect(getWorldManager().delete(worldId)).toBe(true);

        // The applied patch must survive eviction: restore replays the persisted script.
        // Before the fix, restore regenerated the baseline world and the structure vanished.
        expect(parseMap(await handleWorldMap({ action: 'overview', worldId }, ctx)).structureCount).toBe(baseline + 1);
    });
});
