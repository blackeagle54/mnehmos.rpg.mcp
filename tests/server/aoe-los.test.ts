/**
 * AoE line-of-sight tests (audited gap: AoE filters by tile membership only,
 * never checks LoS, so it hits targets through full-cover walls / obstacles).
 *
 * Part B: calculateAoE must drop participants whose line from the AoE origin is
 * blocked by a full-cover prop or a terrain obstacle. With no blockers, behavior
 * is identical to today.
 */

import { CombatEngine, CombatParticipant, CombatState } from '../../src/engine/combat/engine.js';
import { calculateAoE } from '../../src/server/handlers/combat-handlers.js';

describe('AoE respects line-of-sight', () => {
    function buildState(props?: CombatState['props'], terrain?: CombatState['terrain']): CombatState {
        const engine = new CombatEngine('aoe-los-seed');
        const participants: CombatParticipant[] = [
            {
                id: 'sheltered', name: 'Sheltered Goblin', initiativeBonus: 0,
                hp: 7, maxHp: 7, conditions: [],
                position: { x: 6, y: 0 }, isEnemy: true
            },
            {
                id: 'exposed', name: 'Exposed Goblin', initiativeBonus: 0,
                hp: 7, maxHp: 7, conditions: [],
                position: { x: 6, y: 2 }, isEnemy: true
            }
        ];
        const state = engine.startEncounter(participants);
        if (props) state.props = props;
        if (terrain) state.terrain = terrain;
        return state;
    }

    it('hits a target through open space (no blockers) — unchanged baseline', () => {
        const state = buildState();
        // Circle radius 8 from origin (0,0) covers both goblins.
        const result = calculateAoE(state, 'circle', { x: 0, y: 0 }, { radius: 8 });
        const names = result.affectedParticipants.map(p => p.name);
        expect(names).toContain('Sheltered Goblin');
        expect(names).toContain('Exposed Goblin');
    });

    it('DROPS a target whose line from origin is blocked by a FULL-cover prop', () => {
        const state = buildState([
            // Full-cover wall directly between origin (0,0) and sheltered goblin (6,0).
            { id: 'wall', position: '3,0', label: 'Wall', propType: 'cover', cover: 'full' }
        ]);
        const result = calculateAoE(state, 'circle', { x: 0, y: 0 }, { radius: 8 });
        const names = result.affectedParticipants.map(p => p.name);
        expect(names).not.toContain('Sheltered Goblin'); // behind full-cover wall
        expect(names).toContain('Exposed Goblin');        // clear line
    });

    it('DROPS a target whose line from origin is blocked by a terrain obstacle', () => {
        const state = buildState(undefined, { obstacles: ['3,0'] });
        const result = calculateAoE(state, 'circle', { x: 0, y: 0 }, { radius: 8 });
        const names = result.affectedParticipants.map(p => p.name);
        expect(names).not.toContain('Sheltered Goblin');
        expect(names).toContain('Exposed Goblin');
    });

    it('does NOT treat HALF cover props as LoS blockers for AoE', () => {
        const state = buildState([
            { id: 'crate', position: '3,0', label: 'Crate', propType: 'cover', cover: 'half' }
        ]);
        const result = calculateAoE(state, 'circle', { x: 0, y: 0 }, { radius: 8 });
        const names = result.affectedParticipants.map(p => p.name);
        // Half cover does not block the area spell's line entirely.
        expect(names).toContain('Sheltered Goblin');
        expect(names).toContain('Exposed Goblin');
    });

    it('does NOT block a target when the only full-cover prop sits ON the target tile (endpoints excluded)', () => {
        const state = buildState([
            // Full-cover prop AT the sheltered goblin's own tile (6,0) — the LoS endpoint.
            { id: 'on-target', position: '6,0', label: 'Pillar', propType: 'cover', cover: 'full' }
        ]);
        const result = calculateAoE(state, 'circle', { x: 0, y: 0 }, { radius: 8 });
        const names = result.affectedParticipants.map(p => p.name);
        // A blocker AT the endpoint must not shield the target — it IS the target's tile.
        expect(names).toContain('Sheltered Goblin');
        expect(names).toContain('Exposed Goblin');
    });

    it('does NOT block when the only full-cover prop sits ON the AoE origin tile (endpoints excluded)', () => {
        const state = buildState([
            { id: 'on-origin', position: '0,0', label: 'Brazier', propType: 'cover', cover: 'full' }
        ]);
        const result = calculateAoE(state, 'circle', { x: 0, y: 0 }, { radius: 8 });
        const names = result.affectedParticipants.map(p => p.name);
        // A blocker at the origin endpoint must not shield everyone in the area.
        expect(names).toContain('Sheltered Goblin');
        expect(names).toContain('Exposed Goblin');
    });

    it('does NOT treat THREE-QUARTER cover as an AoE LoS blocker (only FULL cover blocks area reach)', () => {
        const state = buildState([
            { id: 'rampart', position: '3,0', label: 'Rampart', propType: 'cover', cover: 'three_quarter' }
        ]);
        const result = calculateAoE(state, 'circle', { x: 0, y: 0 }, { radius: 8 });
        const names = result.affectedParticipants.map(p => p.name);
        // Three-quarter cover raises AC on attacks but does NOT block an area spell.
        expect(names).toContain('Sheltered Goblin');
        expect(names).toContain('Exposed Goblin');
    });
});
