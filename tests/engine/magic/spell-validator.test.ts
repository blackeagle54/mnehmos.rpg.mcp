/**
 * Spell validator class-lookup tests (#25)
 *
 * character.characterClass is a free-form string (schema default 'fighter'); a
 * character created from input like "Cleric" is stored capitalized. The
 * SPELLCASTING_CONFIG keys are all lowercase, so a capitalized — or custom —
 * class must not crash the config lookup with
 * "Cannot read properties of undefined (reading 'canCast')".
 */

import { describe, it, expect } from 'vitest';
import {
    getMaxSpellLevel,
    getInitialSpellSlots,
    calculateSpellSaveDC,
    calculateSpellAttackBonus,
    hasSpellSlotAvailable,
    canCastSpells,
    getSpellcastingConfig,
} from '../../../src/engine/magic/spell-validator.js';
import type { Character } from '../../../src/schema/character.js';
import type { CharacterClass } from '../../../src/schema/spell.js';

function makeCharacter(overrides: Partial<Character> = {}): Character {
    return {
        id: 'char-1',
        name: 'Test',
        level: 5,
        hp: 30,
        maxHp: 30,
        ac: 14,
        stats: { str: 14, dex: 10, con: 14, int: 10, wis: 18, cha: 12 },
        conditions: [],
        ...overrides,
    } as Character;
}

describe('spell-validator class lookup is case-insensitive and null-safe (#25)', () => {
    it('getMaxSpellLevel treats a capitalized class like its lowercase form', () => {
        expect(getMaxSpellLevel('Cleric' as CharacterClass, 5)).toBe(
            getMaxSpellLevel('cleric' as CharacterClass, 5)
        );
        expect(getMaxSpellLevel('Cleric' as CharacterClass, 5)).toBeGreaterThan(0);
    });

    it('calculateSpellSaveDC works for a capitalized class (was: crash on undefined config)', () => {
        const cleric = makeCharacter({ characterClass: 'Cleric' });
        // 8 + proficiency (+3 at level 5) + WIS modifier (+4 at 18) = 15
        expect(calculateSpellSaveDC(cleric)).toBe(15);
    });

    it('calculateSpellAttackBonus works for a capitalized class', () => {
        const cleric = makeCharacter({ characterClass: 'Cleric' });
        expect(calculateSpellAttackBonus(cleric)).toBe(7); // prof +3 + WIS +4
    });

    it('hasSpellSlotAvailable does not crash for a capitalized class', () => {
        const cleric = makeCharacter({
            characterClass: 'Cleric',
            spellSlots: getInitialSpellSlots('cleric' as CharacterClass, 5),
        } as Partial<Character>);

        expect(hasSpellSlotAvailable(cleric, 1).available).toBe(true);
    });

    it('treats an unknown/custom class as a non-caster instead of crashing (null-safety)', () => {
        const custom = makeCharacter({ characterClass: 'Chronomancer' });
        expect(() => calculateSpellSaveDC(custom)).not.toThrow();
        expect(calculateSpellSaveDC(custom)).toBe(0);
        expect(calculateSpellAttackBonus(custom)).toBe(0);
        expect(getMaxSpellLevel('Chronomancer' as CharacterClass, 20)).toBe(0);
    });

    it('tolerates surrounding whitespace in the class name (#25 — CodeRabbit)', () => {
        const cleric = makeCharacter({ characterClass: '  Cleric  ' });
        // Whitespace must not demote a real caster to a non-caster (DC/attack 0).
        expect(calculateSpellSaveDC(cleric)).toBe(15);
        expect(calculateSpellAttackBonus(cleric)).toBe(7);
        expect(getMaxSpellLevel('  Cleric  ' as CharacterClass, 5)).toBeGreaterThan(0);
    });

    it('canCastSpells gate also tolerates whitespace (#25 — CodeRabbit)', () => {
        // The gate runs first in validateSpellCast; if it rejects "  Cleric  "
        // the save-DC fix alone wouldn't make casting work end-to-end.
        const cleric = makeCharacter({ characterClass: '  Cleric  ' });
        expect(canCastSpells(cleric).canCast).toBe(true);
    });

    it('getSpellcastingConfig is null-safe and normalizes case + whitespace (#25 — CodeRabbit)', () => {
        // Exported helper: harden against a null/undefined class (no .trim() crash).
        expect(() => getSpellcastingConfig(undefined as unknown as string)).not.toThrow();
        expect(getSpellcastingConfig(undefined as unknown as string).canCast).toBe(false);
        // Mixed case + surrounding whitespace resolves to the real config.
        expect(getSpellcastingConfig('  WiZaRd  ').canCast).toBe(true);
    });
});
