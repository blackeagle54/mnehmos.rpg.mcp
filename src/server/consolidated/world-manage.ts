/**
 * Consolidated World Management Tool
 * Replaces 7 separate tools for world lifecycle management:
 * create_world, get_world, list_worlds, delete_world, update_world_environment,
 * generate_world, get_world_state
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { SessionContext } from '../types.js';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { resolveConsolidatedDbPath } from './db-path.js';
import { WorldRepository } from '../../storage/repos/world.repo.js';
import { RegionRepository } from '../../storage/repos/region.repo.js';
import { StructureRepository } from '../../storage/repos/structure.repo.js';
import { World, EnvironmentSchema } from '../../schema/world.js';
import { Region } from '../../schema/region.js';
import { Structure, StructureType } from '../../schema/structure.js';
import { BiomeType } from '../../schema/biome.js';
import { generateWorld as generateWorldProc } from '../../engine/worldgen/index.js';
import { getWorldManager } from '../state/world-manager.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = ['create', 'get', 'list', 'delete', 'update', 'generate', 'get_state'] as const;
type WorldManageAction = typeof ACTIONS[number];

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPER
// ═══════════════════════════════════════════════════════════════════════════

function getWorldRepo(): WorldRepository {
    const db = getDb(resolveConsolidatedDbPath());
    return new WorldRepository(db);
}

function getRegionRepo(): RegionRepository {
    const db = getDb(resolveConsolidatedDbPath());
    return new RegionRepository(db);
}

function getStructureRepo(): StructureRepository {
    const db = getDb(resolveConsolidatedDbPath());
    return new StructureRepository(db);
}

// ═══════════════════════════════════════════════════════════════════════════
// WORLDGEN → PERSISTED-SCHEMA MAPPING (#64)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Explicit biome → RegionSchema.type mapping. The worldgen Region carries a
 * dominant BiomeType, but the persisted RegionSchema constrains `type` to a small
 * gameplay enum. This table is intentionally exhaustive over BiomeType; the
 * `?? 'wilderness'` fallback below NEVER silently coerces an unknown biome — it is
 * only a defensive default if a NEW BiomeType is added without updating this table.
 */
const BIOME_TO_REGION_TYPE: Partial<Record<BiomeType, Region['type']>> = {
    [BiomeType.GRASSLAND]: 'plains',
    [BiomeType.SAVANNA]: 'plains',
    [BiomeType.FOREST]: 'forest',
    [BiomeType.RAINFOREST]: 'forest',
    [BiomeType.TAIGA]: 'forest',
    [BiomeType.DESERT]: 'desert',
    [BiomeType.LAKE]: 'water',
    [BiomeType.OCEAN]: 'water',
    [BiomeType.DEEP_OCEAN]: 'water',
    [BiomeType.SWAMP]: 'wilderness',
    [BiomeType.TUNDRA]: 'wilderness',
    [BiomeType.GLACIER]: 'wilderness',
};

/**
 * Deterministic region color: a pure function of the region type so the same
 * generated world always persists identical colors (no randomUUID, no Date).
 */
const REGION_TYPE_COLOR: Record<Region['type'], string> = {
    kingdom: '#c0392b',
    duchy: '#8e44ad',
    county: '#2980b9',
    wilderness: '#27ae60',
    water: '#2c82c9',
    plains: '#9acd32',
    forest: '#228b22',
    mountain: '#7f8c8d',
    desert: '#e1b16a',
    city: '#bdc3c7',
};

/**
 * Deterministic structure population by type. The worldgen StructureLocation has
 * no population, but the persisted StructureSchema REQUIRES a nonnegative number,
 * so we assign a fixed, pure-function population per type (no randomness/clock).
 */
function structurePopulationFor(type: StructureType): number {
    switch (type) {
        case StructureType.CITY: return 5000;
        case StructureType.TOWN: return 1000;
        case StructureType.VILLAGE: return 200;
        case StructureType.CASTLE: return 500;
        case StructureType.TEMPLE: return 100;
        case StructureType.RUINS: return 0;
        case StructureType.DUNGEON: return 0;
        default: return 0;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const CreateSchema = z.object({
    action: z.literal('create'),
    name: z.string().min(1).describe('World name'),
    seed: z.string().describe('Seed for generation'),
    width: z.number().int().min(10).max(1000).describe('World width'),
    height: z.number().int().min(10).max(1000).describe('World height'),
    landRatio: z.number().min(0.1).max(0.9).optional().describe('Land to water ratio')
});

const GetSchema = z.object({
    action: z.literal('get'),
    id: z.string().describe('World ID')
});

const ListSchema = z.object({
    action: z.literal('list')
});

const DeleteSchema = z.object({
    action: z.literal('delete'),
    id: z.string().describe('World ID to delete')
});

const UpdateSchema = z.object({
    action: z.literal('update'),
    id: z.string().describe('World ID'),
    // Derived from the canonical EnvironmentSchema so the tool input cannot drift
    // from the stored/readable fields. `season` is constrained to an enum at the
    // tool boundary, plus deprecated aliases normalized in handleUpdate. (#65)
    environment: EnvironmentSchema.extend({
        season: z.enum(['spring', 'summer', 'autumn', 'winter']).optional(),
        dayNightCycle: z.enum(['day', 'night', 'dawn', 'dusk']).optional().describe('Deprecated: use timeOfDay'),
        weather: z.string().optional().describe('Deprecated: use weatherConditions')
    }).passthrough().describe('Environment properties to update (canonical field names match the stored world environment)')
});

const GenerateSchema = z.object({
    action: z.literal('generate'),
    seed: z.string().describe('Seed for random number generation'),
    width: z.number().int().min(10).max(1000).describe('Width of the world grid'),
    height: z.number().int().min(10).max(1000).describe('Height of the world grid'),
    landRatio: z.number().min(0.1).max(0.9).optional().describe('Land to water ratio'),
    temperatureOffset: z.number().min(-30).max(30).optional().describe('Temperature offset'),
    moistureOffset: z.number().min(-30).max(30).optional().describe('Moisture offset')
});

const GetStateSchema = z.object({
    action: z.literal('get_state'),
    worldId: z.string().describe('World ID')
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

async function handleCreate(args: z.infer<typeof CreateSchema>): Promise<object> {
    const worldRepo = getWorldRepo();
    const now = new Date().toISOString();

    const world: World = {
        id: randomUUID(),
        name: args.name,
        seed: args.seed,
        width: args.width,
        height: args.height,
        createdAt: now,
        updatedAt: now
    };

    worldRepo.create(world);

    return {
        success: true,
        actionType: 'create',
        worldId: world.id,
        name: world.name,
        seed: world.seed,
        dimensions: { width: world.width, height: world.height },
        message: `Created world "${world.name}" (${world.width}x${world.height})`
    };
}

async function handleGet(args: z.infer<typeof GetSchema>): Promise<object> {
    const worldRepo = getWorldRepo();
    const world = worldRepo.findById(args.id);

    if (!world) {
        return { error: true, message: `World not found: ${args.id}` };
    }

    return {
        success: true,
        actionType: 'get',
        world: {
            id: world.id,
            name: world.name,
            seed: world.seed,
            width: world.width,
            height: world.height,
            environment: world.environment,
            createdAt: world.createdAt,
            updatedAt: world.updatedAt
        }
    };
}

async function handleList(): Promise<object> {
    const worldRepo = getWorldRepo();
    const worlds = worldRepo.findAll();

    return {
        success: true,
        actionType: 'list',
        count: worlds.length,
        worlds: worlds.map(w => ({
            id: w.id,
            name: w.name,
            seed: w.seed,
            dimensions: { width: w.width, height: w.height },
            createdAt: w.createdAt
        }))
    };
}

async function handleDelete(args: z.infer<typeof DeleteSchema>): Promise<object> {
    const worldRepo = getWorldRepo();
    worldRepo.delete(args.id);

    // Also remove from in-memory state
    const worldManager = getWorldManager();
    worldManager.delete(args.id);

    return {
        success: true,
        actionType: 'delete',
        deletedId: args.id,
        message: `Deleted world ${args.id}`
    };
}

/**
 * Map deprecated environment field aliases onto the canonical names used by
 * WorldSchema.environment and readers (session_manage reads `timeOfDay`). Without
 * this, update_world_environment writes via the documented legacy fields
 * (dayNightCycle/weather) never reached the canonical fields. (#65)
 */
function normalizeEnvironmentPatch(env: Record<string, unknown>): Record<string, unknown> {
    const { dayNightCycle, weather, ...rest } = env;
    const normalized: Record<string, unknown> = { ...rest };
    if (dayNightCycle !== undefined && normalized.timeOfDay === undefined) {
        normalized.timeOfDay = dayNightCycle;
    }
    if (weather !== undefined && normalized.weatherConditions === undefined) {
        normalized.weatherConditions = weather;
    }
    // Explicitly clear the deprecated aliases. WorldRepository.updateEnvironment
    // shallow-merges this patch over the stored record and persists via
    // JSON.stringify (which omits undefined), so setting these undefined removes
    // any legacy dayNightCycle/weather already persisted on a world. (#65, CodeRabbit)
    normalized.dayNightCycle = undefined;
    normalized.weather = undefined;
    return normalized;
}

async function handleUpdate(args: z.infer<typeof UpdateSchema>): Promise<object> {
    const worldRepo = getWorldRepo();
    const environment = normalizeEnvironmentPatch(args.environment as Record<string, unknown>);
    const updated = worldRepo.updateEnvironment(args.id, environment);

    if (!updated) {
        return { error: true, message: `World not found: ${args.id}` };
    }

    return {
        success: true,
        actionType: 'update',
        worldId: args.id,
        environment: updated.environment,
        message: `Updated environment for world ${args.id}`
    };
}

async function handleGenerate(args: z.infer<typeof GenerateSchema>): Promise<object> {
    const worldRepo = getWorldRepo();
    const worldManager = getWorldManager();

    // Generate the procedural world
    const generatedWorld = generateWorldProc({
        seed: args.seed,
        width: args.width,
        height: args.height,
        landRatio: args.landRatio,
        temperatureOffset: args.temperatureOffset,
        moistureOffset: args.moistureOffset
    });

    // Create DB record
    const now = new Date().toISOString();
    const world: World = {
        id: `world-${args.seed}-${Date.now()}`,
        name: `World (${args.seed})`,
        seed: args.seed,
        width: args.width,
        height: args.height,
        createdAt: now,
        updatedAt: now,
        // Persist generation options so the world rehydrates identically. (#61)
        genOptions: {
            landRatio: args.landRatio,
            temperatureOffset: args.temperatureOffset,
            moistureOffset: args.moistureOffset
        }
    };

    worldRepo.create(world);

    // Store in memory keyed on the bare worldId — the canonical key getOrRestoreWorld
    // also uses, so a generate→use sequence hits the cache instead of regenerating. (#61)
    worldManager.create(world.id, generatedWorld);

    // Persist generated regions + structures to the SAME db so strategy_manage and
    // other consumers can read them. Previously only the world row + in-memory copy
    // were written, so regionRepo.findByWorldId returned [] and claim_region failed
    // with "Region not found" for every generated world. (#64)
    const now2 = new Date().toISOString();

    // Regions: map worldgen Region (numeric id, BiomeType, capital{x,y}) onto the
    // persisted RegionSchema (string id, gameplay type enum, centerX/Y, color, ...).
    const persistedRegions: Region[] = generatedWorld.regions.map((region) => {
        // `?? 'wilderness'` is a defensive default for an unmapped BiomeType only;
        // every current BiomeType is covered by BIOME_TO_REGION_TYPE above.
        const type = BIOME_TO_REGION_TYPE[region.biome] ?? 'wilderness';
        return {
            id: `${world.id}-region-${region.id}`,
            worldId: world.id,
            name: region.name,
            type,
            centerX: region.capital.x,
            centerY: region.capital.y,
            color: REGION_TYPE_COLOR[type],
            controlLevel: 0,
            createdAt: now2,
            updatedAt: now2,
        };
    });
    getRegionRepo().createBatch(persistedRegions);

    // Structures: map worldgen StructureLocation onto the persisted StructureSchema.
    // regionMap[y*width+x] holds the numeric region id for that tile (-1 if none);
    // link to the matching persisted region id when present.
    const persistedStructures: Structure[] = generatedWorld.structures.map((s, i) => {
        const { x, y } = s.location;
        const regionNum = generatedWorld.regionMap[y * world.width + x];
        const regionId = regionNum >= 0 ? `${world.id}-region-${regionNum}` : undefined;
        return {
            id: `${world.id}-structure-${i}`,
            worldId: world.id,
            regionId,
            name: s.name,
            type: s.type,
            x,
            y,
            population: structurePopulationFor(s.type),
            createdAt: now2,
            updatedAt: now2,
        };
    });
    getStructureRepo().createBatch(persistedStructures);

    // Calculate biome stats from 2D biomes array
    const biomeStats: Record<string, number> = {};
    for (let y = 0; y < generatedWorld.biomes.length; y++) {
        for (let x = 0; x < generatedWorld.biomes[y].length; x++) {
            const biome = generatedWorld.biomes[y][x];
            biomeStats[biome] = (biomeStats[biome] || 0) + 1;
        }
    }

    const tileCount = args.width * args.height;

    return {
        success: true,
        actionType: 'generate',
        worldId: world.id,
        seed: args.seed,
        dimensions: { width: args.width, height: args.height },
        tileCount: tileCount,
        regionCount: generatedWorld.regions.length,
        // #64: surface the count of persisted structures alongside regionCount.
        structureCount: persistedStructures.length,
        biomeDistribution: biomeStats,
        message: `Generated ${args.width}x${args.height} world with ${generatedWorld.regions.length} regions`
    };
}

async function handleGetState(args: z.infer<typeof GetStateSchema>): Promise<object> {
    const worldManager = getWorldManager();
    const worldRepo = getWorldRepo();

    const dbWorld = worldRepo.findById(args.worldId);
    const memWorld = worldManager.get(args.worldId);

    if (!dbWorld && !memWorld) {
        return { error: true, message: `World not found: ${args.worldId}` };
    }

    // Calculate tile count from biomes 2D array if in memory
    let tileCount = 0;
    if (memWorld?.biomes) {
        tileCount = memWorld.width * memWorld.height;
    }

    return {
        success: true,
        actionType: 'get_state',
        worldId: args.worldId,
        name: dbWorld?.name,
        inMemory: !!memWorld,
        inDatabase: !!dbWorld,
        tileCount: tileCount,
        regionCount: memWorld?.regions?.length || 0,
        environment: dbWorld?.environment
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════

const definitions: Record<WorldManageAction, ActionDefinition> = {
    create: {
        schema: CreateSchema,
        handler: handleCreate,
        aliases: ['new', 'add'],
        description: 'Create a new world in the database'
    },
    get: {
        schema: GetSchema,
        handler: handleGet,
        aliases: ['fetch', 'retrieve'],
        description: 'Get world details by ID'
    },
    list: {
        schema: ListSchema,
        handler: handleList,
        aliases: ['all', 'show'],
        description: 'List all worlds'
    },
    delete: {
        schema: DeleteSchema,
        handler: handleDelete,
        aliases: ['remove', 'destroy'],
        description: 'Delete a world'
    },
    update: {
        schema: UpdateSchema,
        handler: handleUpdate,
        aliases: ['set', 'modify', 'environment'],
        description: 'Update world environment (time, weather, season)'
    },
    generate: {
        schema: GenerateSchema,
        handler: handleGenerate,
        aliases: ['gen', 'procedural', 'worldgen'],
        description: 'Generate a procedural world with terrain and biomes'
    },
    get_state: {
        schema: GetStateSchema,
        handler: handleGetState,
        aliases: ['state', 'status'],
        description: 'Get current world state (in-memory and database)'
    }
};

const router = createActionRouter({
    actions: ACTIONS,
    definitions,
    threshold: 0.6
});

// ═══════════════════════════════════════════════════════════════════════════
// TOOL DEFINITION & HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export const WorldManageTool = {
    name: 'world_manage',
    description: `Manage RPG worlds - creation, retrieval, and procedural generation.
Actions: create, get, list, delete, update (environment), generate (procedural), get_state
Aliases: new→create, fetch→get, all→list, remove→delete, set→update, gen→generate, state→get_state

🌍 WORLD WORKFLOW:
1. generate - Create procedural world with terrain/biomes
2. get_state - Check world status
3. update - Set time/weather/season
4. For map operations, use world_map tool instead`,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        id: z.string().optional().describe('World ID'),
        worldId: z.string().optional().describe('World ID (for get_state)'),
        name: z.string().optional().describe('World name (for create)'),
        seed: z.string().optional().describe('Seed for generation'),
        width: z.number().optional().describe('World width'),
        height: z.number().optional().describe('World height'),
        landRatio: z.number().optional(),
        temperatureOffset: z.number().optional(),
        moistureOffset: z.number().optional(),
        environment: z.any().optional().describe('Environment properties (for update)')
    })
};

export async function handleWorldManage(args: unknown, _ctx: SessionContext): Promise<McpResponse> {
    const result = await router(args as Record<string, unknown>);
    const parsed = JSON.parse(result.content[0].text);

    let output = '';

    if (parsed.error) {
        output = RichFormatter.header('Error', '❌');
        output += RichFormatter.alert(parsed.message || 'Unknown error', 'error');
        if (parsed.suggestions) {
            output += '\n**Did you mean:**\n';
            parsed.suggestions.forEach((s: { value: string; similarity: number }) => {
                output += `  • ${s.value} (${s.similarity}% match)\n`;
            });
        }
    } else {
        switch (parsed.actionType) {
            case 'create':
                output = RichFormatter.header('World Created', '🌍');
                output += RichFormatter.keyValue({
                    'ID': `\`${parsed.worldId}\``,
                    'Name': parsed.name,
                    'Dimensions': `${parsed.dimensions?.width}x${parsed.dimensions?.height}`
                });
                break;
            case 'get':
                output = RichFormatter.header('World Details', '🌍');
                if (parsed.world) {
                    output += RichFormatter.keyValue({
                        'ID': `\`${parsed.world.id}\``,
                        'Name': parsed.world.name,
                        'Seed': parsed.world.seed,
                        'Dimensions': `${parsed.world.width}x${parsed.world.height}`
                    });
                }
                break;
            case 'list':
                output = RichFormatter.header(`Worlds (${parsed.count})`, '🌍');
                if (parsed.worlds?.length > 0) {
                    parsed.worlds.forEach((w: { name: string; id: string }) => {
                        output += `• **${w.name}** (\`${w.id}\`)\n`;
                    });
                } else {
                    output += 'No worlds found.\n';
                }
                break;
            case 'delete':
                output = RichFormatter.header('World Deleted', '🗑️');
                output += RichFormatter.keyValue({ 'Deleted ID': `\`${parsed.deletedId}\`` });
                break;
            case 'update':
                output = RichFormatter.header('Environment Updated', '🌤️');
                output += RichFormatter.keyValue({ 'World ID': `\`${parsed.worldId}\`` });
                break;
            case 'generate':
                output = RichFormatter.header('World Generated', '🌍');
                output += RichFormatter.keyValue({
                    'ID': `\`${parsed.worldId}\``,
                    'Seed': parsed.seed,
                    'Dimensions': `${parsed.dimensions?.width}x${parsed.dimensions?.height}`,
                    'Tiles': parsed.tileCount,
                    'Regions': parsed.regionCount
                });
                break;
            case 'get_state':
                output = RichFormatter.header('World State', '📊');
                output += RichFormatter.keyValue({
                    'ID': `\`${parsed.worldId}\``,
                    'In Memory': parsed.inMemory ? '✅' : '❌',
                    'In Database': parsed.inDatabase ? '✅' : '❌',
                    'Tiles': parsed.tileCount,
                    'Regions': parsed.regionCount
                });
                break;
            default:
                output = RichFormatter.header('World', '🌍');
                if (parsed.message) output += parsed.message + '\n';
        }
    }

    output += RichFormatter.embedJson(parsed, 'WORLD_MANAGE');

    return {
        content: [{
            type: 'text' as const,
            text: output
        }]
    };
}
