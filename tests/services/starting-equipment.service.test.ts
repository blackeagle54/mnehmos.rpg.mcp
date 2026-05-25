/**
 * Tests for starting-equipment.service item-type inference. [#29]
 */

import { describe, it, expect } from 'vitest';
import { getItemDefaults } from '../../src/services/starting-equipment.service.js';

describe('getItemDefaults — weapon type inference (#29)', () => {
  it('types generic weapon placeholders as weapon, not misc', () => {
    expect(getItemDefaults('Martial Weapon').type).toBe('weapon');
    expect(getItemDefaults('Simple Weapon').type).toBe('weapon');
    expect(getItemDefaults('Martial Melee Weapon').type).toBe('weapon');
  });

  it('still types specific weapons correctly (regression)', () => {
    expect(getItemDefaults('Longsword').type).toBe('weapon');
  });

  it('does not misclassify non-weapons', () => {
    expect(getItemDefaults('Leather Armor').type).toBe('armor');
    expect(getItemDefaults('Rations (1 day)').type).toBe('consumable');
  });
});
