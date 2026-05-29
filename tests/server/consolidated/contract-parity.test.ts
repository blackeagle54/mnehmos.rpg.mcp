/**
 * Contract parity tests for ADR-001 Phase 1 (#13)
 *
 * Each consolidated tool must be the single source of truth for its discovery
 * metadata (category/keywords/capabilities). These tests assert that:
 *  - all 31 tools are exported,
 *  - each tool owns non-empty category/keywords/capabilities on its contract,
 *  - buildConsolidatedRegistry() derives that metadata FROM the contract (parity),
 *  - the moved values match the historical TOOL_* map values VERBATIM (no drift).
 *
 * The EXPECTED_METADATA fixture is a frozen snapshot of the original
 * TOOL_CATEGORIES / TOOL_KEYWORDS / TOOL_CAPABILITIES maps that previously lived
 * in src/server/consolidated-registry.ts (plus Phase-3 skill_manage,
 * achievement_manage and reputation_manage). Any transcription error across the
 * 31 tool files is caught here.
 */

import { ConsolidatedTools } from '../../../src/server/consolidated/index.js';
import { buildConsolidatedRegistry } from '../../../src/server/consolidated-registry.js';

// Verbatim snapshot of the original parallel maps (pre-#13).
const EXPECTED_METADATA: Record<
  string,
  { category: string; keywords: string[]; capabilities: string[] }
> = {
  secret_manage: {
    category: 'secret',
    keywords: ['secret', 'dm', 'hidden', 'mystery', 'reveal', 'clue'],
    capabilities: ['Create/manage DM secrets', 'Reveal conditions', 'Leak detection'],
  },
  rest_manage: {
    category: 'rest',
    keywords: ['rest', 'long', 'short', 'heal', 'recovery', 'hit dice'],
    capabilities: ['Long/short rest processing', 'HP restoration', 'Hit dice management'],
  },
  concentration_manage: {
    category: 'concentration',
    keywords: ['concentration', 'spell', 'save', 'break', 'maintain'],
    capabilities: ['Concentration checks', 'Break concentration', 'Duration tracking'],
  },
  narrative_manage: {
    category: 'narrative',
    keywords: ['narrative', 'story', 'note', 'journal', 'log'],
    capabilities: ['Story notes', 'Search history', 'Context retrieval'],
  },
  scroll_manage: {
    category: 'scroll',
    keywords: ['scroll', 'spell', 'use', 'create', 'identify', 'arcana'],
    capabilities: ['Use scrolls', 'Create scrolls', 'Check usability'],
  },
  character_manage: {
    category: 'character',
    keywords: ['character', 'pc', 'npc', 'create', 'update', 'stats', 'level'],
    capabilities: ['CRUD characters', 'Level up', 'Stats management'],
  },
  party_manage: {
    category: 'party',
    keywords: ['party', 'group', 'member', 'leader', 'formation', 'gold'],
    capabilities: ['Party management', 'Member operations', 'Treasury'],
  },
  item_manage: {
    category: 'inventory',
    keywords: ['item', 'weapon', 'armor', 'gear', 'equipment', 'create'],
    capabilities: ['Item templates', 'CRUD items', 'Item search'],
  },
  inventory_manage: {
    category: 'inventory',
    keywords: ['inventory', 'give', 'take', 'equip', 'use', 'transfer'],
    capabilities: ['Give/take items', 'Equip/use', 'Transfer between characters'],
  },
  corpse_manage: {
    category: 'corpse',
    keywords: ['corpse', 'loot', 'harvest', 'decay', 'body', 'death'],
    capabilities: ['Loot corpses', 'Harvest materials', 'Decay management'],
  },
  combat_manage: {
    category: 'combat',
    keywords: ['combat', 'encounter', 'initiative', 'turn', 'end', 'start'],
    capabilities: ['Start/end encounters', 'Initiative', 'Death saves'],
  },
  combat_action: {
    category: 'combat',
    keywords: ['attack', 'cast', 'move', 'action', 'damage', 'heal'],
    capabilities: ['Attacks', 'Spell casting', 'Movement', 'Standard actions'],
  },
  combat_map: {
    category: 'combat',
    keywords: ['map', 'terrain', 'grid', 'aoe', 'position', 'tactical'],
    capabilities: ['Terrain management', 'AoE calculation', 'Grid operations'],
  },
  world_manage: {
    category: 'world',
    keywords: ['world', 'generate', 'seed', 'terrain', 'biome'],
    capabilities: ['World generation', 'State queries', 'Environment updates'],
  },
  world_map: {
    category: 'world',
    keywords: ['map', 'overview', 'region', 'patch', 'tiles'],
    capabilities: ['Map overview', 'Region details', 'Tile patching'],
  },
  spatial_manage: {
    category: 'spatial',
    keywords: ['room', 'look', 'move', 'exits', 'dungeon', 'space'],
    capabilities: ['Room generation', 'Movement', 'Exit management'],
  },
  quest_manage: {
    category: 'quest',
    keywords: ['quest', 'objective', 'assign', 'complete', 'reward'],
    capabilities: ['Quest lifecycle', 'Objectives', 'Rewards'],
  },
  skill_manage: {
    category: 'character',
    keywords: ['skill', 'xp', 'rank', 'train', 'proficiency'],
    capabilities: ['Per-skill XP', 'Skill levels', 'Training'],
  },
  achievement_manage: {
    category: 'character',
    keywords: ['achievement', 'unlock', 'trophy', 'milestone', 'badge', 'reward'],
    capabilities: ['Achievement catalog', 'Unlock tracking', 'Progress milestones'],
  },
  reputation_manage: {
    category: 'character',
    keywords: ['reputation', 'faction', 'standing', 'rep', 'relationship', 'alignment'],
    capabilities: ['Faction reputation', 'Standing tiers', 'Reputation gating'],
  },
  npc_manage: {
    category: 'npc',
    keywords: ['npc', 'relationship', 'memory', 'conversation', 'social'],
    capabilities: ['Relationships', 'Memory', 'Social interactions'],
  },
  aura_manage: {
    category: 'aura',
    keywords: ['aura', 'effect', 'radius', 'buff', 'debuff', 'area'],
    capabilities: ['Create auras', 'Effect processing', 'Expiration'],
  },
  theft_manage: {
    category: 'theft',
    keywords: ['theft', 'steal', 'fence', 'crime', 'recognition', 'heat'],
    capabilities: ['Theft attempts', 'Fence operations', 'Heat tracking'],
  },
  improvisation_manage: {
    category: 'improvisation',
    keywords: ['stunt', 'improvise', 'creative', 'effect', 'homebrew'],
    capabilities: ['Stunts', 'Custom effects', 'Arcane synthesis'],
  },
  math_manage: {
    category: 'math',
    keywords: ['dice', 'roll', 'probability', 'algebra', 'physics', 'math'],
    capabilities: ['Dice rolling', 'Probability', 'Math operations'],
  },
  strategy_manage: {
    category: 'strategy',
    keywords: ['nation', 'alliance', 'territory', 'strategy', 'diplomacy'],
    capabilities: ['Nation management', 'Diplomacy', 'Territory'],
  },
  turn_manage: {
    category: 'turn-management',
    keywords: ['turn', 'phase', 'ready', 'poll', 'results', 'async'],
    capabilities: ['Turn phases', 'Action submission', 'Result polling'],
  },
  spawn_manage: {
    category: 'world',
    keywords: ['spawn', 'create', 'encounter', 'location', 'tactical'],
    capabilities: ['Spawn characters', 'Create locations', 'Generate encounters'],
  },
  session_manage: {
    category: 'meta',
    keywords: ['session', 'initialize', 'context', 'start', 'resume'],
    capabilities: ['Session initialization', 'Context loading'],
  },
  travel_manage: {
    category: 'party',
    keywords: ['travel', 'move', 'rest', 'loot', 'journey', 'party'],
    capabilities: ['Party travel', 'Encounter looting', 'Camp/rest'],
  },
  batch_manage: {
    category: 'meta',
    keywords: ['batch', 'bulk', 'create', 'workflow', 'template'],
    capabilities: ['Bulk character creation', 'Workflows', 'Templates'],
  },
};

describe('consolidated tool contract parity (#13 ADR-001)', () => {
  it('exports all 31 consolidated tools', () => {
    expect(ConsolidatedTools.length).toBe(31);
  });

  // RED: today tool objects only carry {name,description,inputSchema}
  it.each(ConsolidatedTools.map(({ tool }) => [tool.name, tool] as const))(
    '%s owns its discovery metadata on the contract',
    (_name, tool: any) => {
      expect(typeof tool.category).toBe('string');
      expect(tool.category.length).toBeGreaterThan(0);
      expect(Array.isArray(tool.keywords)).toBe(true);
      expect(tool.keywords.length).toBeGreaterThan(0);
      expect(Array.isArray(tool.capabilities)).toBe(true);
      expect(tool.capabilities.length).toBeGreaterThan(0);
    }
  );

  // RED: today registry metadata comes from the separate TOOL_* maps, not the contract
  it('derives registry metadata FROM the tool contract (parity)', () => {
    const registry = buildConsolidatedRegistry();
    for (const { tool } of ConsolidatedTools as any[]) {
      const entry = registry[tool.name];
      expect(entry).toBeDefined();
      expect(entry.metadata.category).toBe(tool.category);
      expect(entry.metadata.keywords).toEqual(tool.keywords);
      expect(entry.metadata.capabilities).toEqual(tool.capabilities);
    }
  });

  // Data-driven verbatim check across ALL 31 tools — the main transcription guard.
  it.each(ConsolidatedTools.map(({ tool }) => [tool.name, tool] as const))(
    '%s matches the historical TOOL_* map values verbatim',
    (name, tool: any) => {
      const expected = EXPECTED_METADATA[name];
      expect(expected).toBeDefined();
      expect(tool.category).toBe(expected.category);
      expect(tool.keywords).toEqual(expected.keywords);
      expect(tool.capabilities).toEqual(expected.capabilities);
    }
  );

  // Every tool in the fixture must be present in the exported set (no orphan/typo).
  it('covers exactly the 31 tools named in the fixture', () => {
    const exportedNames = ConsolidatedTools.map(({ tool }) => tool.name).sort();
    const fixtureNames = Object.keys(EXPECTED_METADATA).sort();
    expect(exportedNames).toEqual(fixtureNames);
  });

  // Anchor a couple of exact values so the move is verbatim (no silent drift)
  it('preserves secret_manage metadata verbatim', () => {
    const secret = (ConsolidatedTools as any[]).find(
      (t) => t.tool.name === 'secret_manage'
    ).tool;
    expect(secret.category).toBe('secret');
    expect(secret.keywords).toEqual(['secret', 'dm', 'hidden', 'mystery', 'reveal', 'clue']);
    expect(secret.capabilities).toEqual([
      'Create/manage DM secrets',
      'Reveal conditions',
      'Leak detection',
    ]);
  });
});
