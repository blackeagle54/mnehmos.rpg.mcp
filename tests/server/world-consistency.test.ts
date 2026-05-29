/**
 * Regression tests for world generate ↔ restore consistency (issue #61).
 *
 * Two bugs:
 *  (a) world_manage.generate cached the GeneratedWorld under the bare worldId, but
 *      tools.ts getOrRestoreWorld looked it up under `${sessionId}:${worldId}` — so
 *      the cache always missed and the world was regenerated.
 *  (b) Persistence stored only seed/width/height and restore regenerated with only
 *      those, dropping landRatio/temperatureOffset/moistureOffset — so a non-default
 *      world rehydrated as a materially different (e.g. ocean-heavy) world.
 */
import { handleWorldManage } from '../../src/server/consolidated/world-manage.js';
import { handleGetWorldState } from '../../src/server/tools.js';
import { getWorldManager } from '../../src/server/state/world-manager.js';
import { getDb } from '../../src/storage/index.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { BiomeType } from '../../src/schema/biome.js';

process.env.NODE_ENV = 'test';

function parseWorldManage(result: { content: Array<{ type: string; text: string }> }) {
    const m = result.content[0].text.match(/<!-- WORLD_MANAGE_JSON\n([\s\S]*?)\nWORLD_MANAGE_JSON -->/);
    return m ? JSON.parse(m[1]) : JSON.parse(result.content[0].text);
}

function countOcean(world: { biomes: BiomeType[][] }): number {
    let n = 0;
    for (const row of world.biomes) {
        for (const b of row) {
            if (b === BiomeType.OCEAN || b === BiomeType.DEEP_OCEAN) n++;
        }
    }
    return n;
}

describe('world consistency: generate ↔ restore (issue #61)', () => {
    beforeEach(() => {
        const db = getDb(':memory:');
        db.exec('DELETE FROM worlds');
    });

    it('rehydrates a non-default world identically from persisted generation options', async () => {
        const ctx = { sessionId: 'consistency-session' };

        // Generate a deliberately land-heavy world (non-default landRatio).
        const gen = parseWorldManage(await handleWorldManage({
            action: 'generate', seed: 'analysis-seed', width: 40, height: 40, landRatio: 0.8
        }, ctx));
        const worldId = gen.worldId as string;

        const wm = getWorldManager();
        const original = wm.get(worldId);
        expect(original).toBeTruthy(); // cached under the bare worldId (keying)
        const oceanBefore = countOcean(original!);

        // Generation options were persisted (lossless restore prerequisite).
        const stored = new WorldRepository(getDb(':memory:')).findById(worldId);
        expect(stored?.genOptions?.landRatio).toBe(0.8);

        // Evict in-memory state → the next access must restore from the DB.
        wm.delete(worldId);
        expect(wm.get(worldId)).toBeNull();

        // Trigger the restore path via a tools handler that uses getOrRestoreWorld.
        await handleGetWorldState({ worldId }, ctx);

        const restored = wm.get(worldId);
        expect(restored).toBeTruthy(); // restored under the same canonical key
        // Identical world → generation options were applied on restore. Before the
        // fix this regenerated with the default landRatio and produced far more ocean.
        expect(countOcean(restored!)).toBe(oceanBefore);
    });
});
