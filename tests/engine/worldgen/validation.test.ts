/**
 * Regression tests for validateStructurePlacement (issue #66).
 *
 * validateStructurePlacement ran against the POST-normalization GeneratedWorld
 * (ocean = 0, land = 1..100) but used the PRE-normalization raw sea-level cutoff
 * `elevation < 20`, so it rejected legitimate low-elevation land (1..19) as
 * "below sea level". The biome check is the authoritative water guard; the
 * elevation guard should only reject the normalized ocean surface (<= 0).
 */
import { validateStructurePlacement } from '../../../src/engine/worldgen/validation.js';
import { BiomeType } from '../../../src/schema/biome.js';
import { StructureType } from '../../../src/schema/structure.js';

// Minimal normalized world: a 2x1 grid.
//   (0,0) = grassland land at normalized elevation 5 (legitimate land, 1..19)
//   (1,0) = ocean at normalized elevation 0
function makeWorld() {
    return {
        width: 2,
        height: 1,
        biomes: [[BiomeType.GRASSLAND, BiomeType.OCEAN]] as BiomeType[][],
        elevation: new Uint8Array([5, 0]),
    };
}

describe('validateStructurePlacement (issue #66)', () => {
    it('allows a city on low-elevation (1..19) normalized land', () => {
        const result = validateStructurePlacement(StructureType.CITY, 0, 0, makeWorld());
        expect(result.valid).toBe(true);
        expect(result.reason ?? '').not.toMatch(/below sea level/i);
    });

    it('still rejects placement on an ocean tile (regression guard)', () => {
        const result = validateStructurePlacement(StructureType.CITY, 1, 0, makeWorld());
        expect(result.valid).toBe(false);
    });
});
