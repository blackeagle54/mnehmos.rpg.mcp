/**
 * Cover application tests (audited gap: cover captured but never applied)
 *
 * Part A: determineCover pure helper + cover applied to executeAttack resolution.
 *
 * D&D 5e simplification (tile-based, documented in determineCover):
 *   half           -> +2 effective AC
 *   three_quarter  -> +5 effective AC
 *   full           -> target cannot be hit (forced miss)
 *   none           -> +0 (identical to legacy behavior)
 *
 * Only cover-providing props that lie STRICTLY BETWEEN the attacker tile and the
 * target tile count; the attacker's and target's own tiles are excluded.
 */

import { CombatEngine, CombatParticipant, CombatState } from '../../src/engine/combat/engine';
import { determineCover } from '../../src/engine/spatial/combat-grid';

describe('Cover applied to attack resolution', () => {
    // A deterministic seed where a d20 roll (+attackBonus) lands in the window
    // that beats AC 15 but would be turned into a MISS by a +2/+5 cover bonus.
    // We assert on the breakdown text + hit/miss rather than a fixed roll so the
    // intent is clear even if the seed's first roll shifts.

    function buildEngine(props?: CombatState['props'], seed: string = 'cover-test-seed'): { engine: CombatEngine; state: CombatState } {
        const engine = new CombatEngine(seed);
        const participants: CombatParticipant[] = [
            {
                id: 'archer', name: 'Archer', initiativeBonus: 0,
                hp: 30, maxHp: 30, conditions: [],
                position: { x: 0, y: 0 }, isEnemy: false
            },
            {
                id: 'goblin', name: 'Goblin', initiativeBonus: 0,
                hp: 30, maxHp: 30, conditions: [],
                position: { x: 6, y: 0 }, ac: 15, isEnemy: true
            }
        ];
        const state = engine.startEncounter(participants);
        if (props) {
            state.props = props;
        }
        return { engine, state };
    }

    describe('determineCover pure helper', () => {
        it('returns "none" when there are no props between attacker and target', () => {
            const { state } = buildEngine();
            expect(determineCover(state, { x: 0, y: 0 }, { x: 6, y: 0 })).toBe('none');
        });

        it('returns "half" for a half-cover prop strictly between the tiles', () => {
            const { state } = buildEngine([
                { id: 'crate', position: '3,0', label: 'Crate', propType: 'cover', cover: 'half' }
            ]);
            expect(determineCover(state, { x: 0, y: 0 }, { x: 6, y: 0 })).toBe('half');
        });

        it('treats a terrain obstacle between the tiles as FULL cover (consistent with hasLineOfSight/AoE)', () => {
            const { state } = buildEngine();
            state.terrain = { obstacles: ['3,0'] }; // solid wall on the line, no cover props
            expect(determineCover(state, { x: 0, y: 0 }, { x: 6, y: 0 })).toBe('full');
        });

        it('returns "three_quarter" for a three-quarter-cover prop between the tiles', () => {
            const { state } = buildEngine([
                { id: 'wall', position: '3,0', label: 'Low Wall', propType: 'cover', cover: 'three_quarter' }
            ]);
            expect(determineCover(state, { x: 0, y: 0 }, { x: 6, y: 0 })).toBe('three_quarter');
        });

        it('returns "full" for a full-cover prop between the tiles', () => {
            const { state } = buildEngine([
                { id: 'pillar', position: '3,0', label: 'Pillar', propType: 'cover', cover: 'full' }
            ]);
            expect(determineCover(state, { x: 0, y: 0 }, { x: 6, y: 0 })).toBe('full');
        });

        it('returns the HIGHEST cover among multiple intervening props', () => {
            const { state } = buildEngine([
                { id: 'crate', position: '2,0', label: 'Crate', propType: 'cover', cover: 'half' },
                { id: 'wall', position: '4,0', label: 'Wall', propType: 'cover', cover: 'three_quarter' }
            ]);
            expect(determineCover(state, { x: 0, y: 0 }, { x: 6, y: 0 })).toBe('three_quarter');
        });

        it('EXCLUDES a cover prop sitting on the attacker tile', () => {
            const { state } = buildEngine([
                { id: 'crate', position: '0,0', label: 'Crate', propType: 'cover', cover: 'full' }
            ]);
            expect(determineCover(state, { x: 0, y: 0 }, { x: 6, y: 0 })).toBe('none');
        });

        it('EXCLUDES a cover prop sitting on the target tile', () => {
            const { state } = buildEngine([
                { id: 'crate', position: '6,0', label: 'Crate', propType: 'cover', cover: 'full' }
            ]);
            expect(determineCover(state, { x: 0, y: 0 }, { x: 6, y: 0 })).toBe('none');
        });

        it('ignores props whose cover is "none" or undefined', () => {
            const { state } = buildEngine([
                { id: 'tree', position: '3,0', label: 'Tree', propType: 'decoration' },
                { id: 'bush', position: '4,0', label: 'Bush', propType: 'cover', cover: 'none' }
            ]);
            expect(determineCover(state, { x: 0, y: 0 }, { x: 6, y: 0 })).toBe('none');
        });
    });

    describe('executeAttack honors cover (the audited gap)', () => {
        it('half cover surfaces "+2 half cover" against effective AC in the breakdown', () => {
            const { engine } = buildEngine([
                { id: 'crate', position: '3,0', label: 'Crate', propType: 'cover', cover: 'half' }
            ]);
            // Goblin AC 15 -> effective AC 17 with half cover.
            const result = engine.executeAttack('archer', 'goblin', 5, 15, 8);
            expect(result.detailedBreakdown).toContain('+2 half cover');
            // Effective AC is 17 (15 + 2). The roll is resolved vs 17, not 15.
            expect(result.detailedBreakdown).toContain('AC 17');
        });

        it('three_quarter cover surfaces "+5 three-quarter cover" against effective AC', () => {
            const { engine } = buildEngine([
                { id: 'wall', position: '3,0', label: 'Wall', propType: 'cover', cover: 'three_quarter' }
            ]);
            const result = engine.executeAttack('archer', 'goblin', 5, 15, 8);
            expect(result.detailedBreakdown).toContain('three-quarter cover');
            expect(result.detailedBreakdown).toContain('AC 20'); // 15 + 5
        });

        it('full cover forces a MISS and deals no damage even on a would-be hit', () => {
            const { engine, state } = buildEngine([
                { id: 'pillar', position: '3,0', label: 'Pillar', propType: 'cover', cover: 'full' }
            ]);
            const hpBefore = state.participants.find(p => p.id === 'goblin')!.hp;
            // Big attack bonus -> would always hit AC 15 if cover were ignored.
            const result = engine.executeAttack('archer', 'goblin', 50, 15, 8);
            expect(result.success).toBe(false);
            expect(result.damage).toBe(0);
            const hpAfter = state.participants.find(p => p.id === 'goblin')!.hp;
            expect(hpAfter).toBe(hpBefore);
            expect(result.detailedBreakdown.toLowerCase()).toContain('full cover');
        });

        it('no cover props => behavior identical to legacy (no AC mutation in breakdown)', () => {
            const { engine } = buildEngine();
            const result = engine.executeAttack('archer', 'goblin', 5, 15, 8);
            // Legacy breakdown: "vs AC 15" with no cover annotation.
            expect(result.detailedBreakdown).toContain('vs AC 15');
            expect(result.detailedBreakdown).not.toContain('cover');
        });

        it('a high attack bonus that beats effective AC still HITS through half cover', () => {
            const { engine, state } = buildEngine([
                { id: 'crate', position: '3,0', label: 'Crate', propType: 'cover', cover: 'half' }
            ]);
            const hpBefore = state.participants.find(p => p.id === 'goblin')!.hp;
            // +50 beats AC 17 easily -> should hit and deal damage.
            const result = engine.executeAttack('archer', 'goblin', 50, 15, 8);
            expect(result.success).toBe(true);
            expect(result.damage).toBeGreaterThan(0);
            const hpAfter = state.participants.find(p => p.id === 'goblin')!.hp;
            expect(hpAfter).toBeLessThan(hpBefore);
        });

        // Seed 'cover-flip' rolls a mid value (13, not a nat-20 auto-hit), so a
        // marginal hit can be flipped to a miss by the +2/+5 cover AC. We read the
        // bare total, then a SAME-SEED engine with base AC == that total clears AC by
        // exactly 0; cover pushes the SAME roll under the bar.
        it('half cover converts a marginal HIT into a MISS (same roll, +2 effective AC)', () => {
            const bare = buildEngine(undefined, 'cover-flip').engine.executeAttack('archer', 'goblin', 5, 15, 8);
            const total = Number(bare.detailedBreakdown.match(/= (\d+) vs AC/)![1]);
            const { engine } = buildEngine([
                { id: 'crate', position: '3,0', label: 'Crate', propType: 'cover', cover: 'half' }
            ], 'cover-flip');
            const covered = engine.executeAttack('archer', 'goblin', 5, total, 8); // base AC == total
            expect(covered.success).toBe(false); // total < total + 2
            expect(covered.damage).toBe(0);
            expect(covered.detailedBreakdown).toContain('+2 half cover');
        });

        it('three-quarter cover converts a marginal HIT into a MISS (same roll, +5 effective AC)', () => {
            const bare = buildEngine(undefined, 'cover-flip').engine.executeAttack('archer', 'goblin', 5, 15, 8);
            const total = Number(bare.detailedBreakdown.match(/= (\d+) vs AC/)![1]);
            const { engine } = buildEngine([
                { id: 'wall', position: '3,0', label: 'Wall', propType: 'cover', cover: 'three_quarter' }
            ], 'cover-flip');
            const covered = engine.executeAttack('archer', 'goblin', 5, total, 8);
            expect(covered.success).toBe(false); // total < total + 5
            expect(covered.damage).toBe(0);
            expect(covered.detailedBreakdown).toContain('three-quarter cover');
        });
    });
});
