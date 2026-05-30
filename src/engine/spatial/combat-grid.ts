/**
 * Combat Grid System - Spatial Combat with Grid Positions
 *
 * This module implements the 5-phase spatial combat system:
 * - Phase 1: Position Persistence (handled by EncounterRepository)
 * - Phase 2: Boundary Validation (BUG-001 fix)
 * - Phase 3: Collision Enforcement
 * - Phase 4: Movement Economy (speed, terrain costs, dash)
 * - Phase 5: AoE Integration
 *
 * Design Principles:
 * - "LLM describes, engine validates" - Database is source of truth
 * - All positions validated against grid bounds
 * - Movement follows pathfinding strictly
 * - D&D 5e rules for movement (30ft = 6 squares, 1.5x diagonal cost)
 *
 * @module spatial/combat-grid
 */

import { SpatialEngine, Point, PathfindingOptions, TerrainCostMap } from './engine.js';
import {
    Position,
    GridBounds,
    DEFAULT_GRID_BOUNDS,
    SizeCategory,
    getSizeFootprint
} from '../../schema/encounter.js';
import { CombatParticipant, CombatState } from '../combat/engine.js';

// ============================================================
// CONSTANTS
// ============================================================

/** Feet per grid square (D&D 5e standard) */
export const FEET_PER_SQUARE = 5;

/** Default movement speed in feet (D&D 5e standard for medium humanoids) */
export const DEFAULT_MOVEMENT_SPEED = 30;

/** Squares of movement for default speed (30ft / 5ft = 6 squares) */
export const DEFAULT_MOVEMENT_SQUARES = DEFAULT_MOVEMENT_SPEED / FEET_PER_SQUARE;

/** Diagonal movement cost multiplier (D&D 5e strict 5-10-5 rule, avg 1.5) */
export const DIAGONAL_COST = 1.5;

/** Difficult terrain cost multiplier */
export const DIFFICULT_TERRAIN_COST = 2;

// ============================================================
// TYPES
// ============================================================

/**
 * Extended combat participant with spatial properties
 */
export interface SpatialParticipant extends CombatParticipant {
    position?: Position;
    movementSpeed: number;       // Base speed in feet
    movementRemaining?: number;  // Remaining movement this turn (in feet)
    size: SizeCategory;
    hasDashed?: boolean;         // Whether dash action was used this turn
}

/**
 * Extended combat state with spatial properties
 */
export interface SpatialCombatState extends CombatState {
    participants: SpatialParticipant[];
    gridBounds: GridBounds;
    terrain?: {
        obstacles: string[];          // "x,y" format, impassable
        difficultTerrain?: string[];  // "x,y" format, 2x movement cost
    };
}

/**
 * Result of a movement validation
 */
export interface MovementValidation {
    valid: boolean;
    error?: string;
    path?: Point[];
    pathCost?: number;           // Total movement cost in feet
    triggersOpportunityAttacks?: string[]; // IDs of participants who can make OA
}

/**
 * Result of an AoE calculation
 */
export interface AoEResult {
    affectedTiles: Point[];
    affectedParticipants: SpatialParticipant[];
    blockedByLOS?: Point[];      // Tiles blocked by line of sight
}

// ============================================================
// PHASE 2: BOUNDARY VALIDATION (BUG-001 FIX)
// ============================================================

/**
 * Validates that a position is within grid bounds.
 *
 * @param position The position to validate
 * @param bounds The grid bounds to check against
 * @returns true if position is within bounds
 *
 * @example
 * ```typescript
 * const bounds = { minX: 0, maxX: 100, minY: 0, maxY: 100 };
 * isPositionInBounds({ x: 50, y: 50 }, bounds); // true
 * isPositionInBounds({ x: -1, y: 50 }, bounds); // false
 * ```
 *
 * Complexity: O(1)
 */
export function isPositionInBounds(position: Position, bounds: GridBounds): boolean {
    if (position.x < bounds.minX || position.x > bounds.maxX) {
        return false;
    }
    if (position.y < bounds.minY || position.y > bounds.maxY) {
        return false;
    }
    if (position.z !== undefined) {
        if (bounds.minZ !== undefined && position.z < bounds.minZ) {
            return false;
        }
        if (bounds.maxZ !== undefined && position.z > bounds.maxZ) {
            return false;
        }
    }
    return true;
}

/**
 * Validates a position and returns a detailed error message if invalid.
 *
 * @param position The position to validate
 * @param bounds The grid bounds
 * @param context Optional context for error message (e.g., "move destination")
 * @returns null if valid, error message string if invalid
 *
 * Complexity: O(1)
 */
export function validatePosition(
    position: Position,
    bounds: GridBounds,
    context: string = 'position'
): string | null {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
        return `Invalid ${context}: coordinates must be finite numbers`;
    }

    if (position.x < bounds.minX) {
        return `Invalid ${context}: x=${position.x} is below minimum (${bounds.minX})`;
    }
    if (position.x > bounds.maxX) {
        return `Invalid ${context}: x=${position.x} exceeds maximum (${bounds.maxX})`;
    }
    if (position.y < bounds.minY) {
        return `Invalid ${context}: y=${position.y} is below minimum (${bounds.minY})`;
    }
    if (position.y > bounds.maxY) {
        return `Invalid ${context}: y=${position.y} exceeds maximum (${bounds.maxY})`;
    }

    if (position.z !== undefined) {
        if (!Number.isFinite(position.z)) {
            return `Invalid ${context}: z-coordinate must be a finite number`;
        }
        if (bounds.minZ !== undefined && position.z < bounds.minZ) {
            return `Invalid ${context}: z=${position.z} is below minimum (${bounds.minZ})`;
        }
        if (bounds.maxZ !== undefined && position.z > bounds.maxZ) {
            return `Invalid ${context}: z=${position.z} exceeds maximum (${bounds.maxZ})`;
        }
    }

    return null;
}

// ============================================================
// PHASE 3: COLLISION ENFORCEMENT
// ============================================================

/**
 * Get all tiles occupied by a creature based on its position and size.
 *
 * @param position Top-left corner of creature's space
 * @param size Creature's size category
 * @returns Array of all occupied tile keys ("x,y" format)
 *
 * @example
 * ```typescript
 * getOccupiedTiles({ x: 5, y: 5 }, 'medium'); // ['5,5']
 * getOccupiedTiles({ x: 5, y: 5 }, 'large');  // ['5,5', '6,5', '5,6', '6,6']
 * ```
 *
 * Complexity: O(n²) where n is the footprint size (max 4 for gargantuan)
 */
export function getOccupiedTiles(position: Position, size: SizeCategory): string[] {
    const footprint = getSizeFootprint(size);
    const tiles: string[] = [];

    for (let dx = 0; dx < footprint; dx++) {
        for (let dy = 0; dy < footprint; dy++) {
            tiles.push(`${position.x + dx},${position.y + dy}`);
        }
    }

    return tiles;
}

/**
 * Build obstacle set from combat state (participants + terrain).
 *
 * @param state The combat state
 * @param excludeParticipantId Optional participant to exclude (for self-movement)
 * @returns Set of blocked tile keys ("x,y" format)
 *
 * Complexity: O(p * s² + t) where p=participants, s=max size footprint, t=terrain tiles
 */
export function buildObstacleSet(
    state: SpatialCombatState,
    excludeParticipantId?: string
): Set<string> {
    const obstacles = new Set<string>();

    // Add participant positions
    for (const p of state.participants) {
        if (p.id === excludeParticipantId) continue;
        if (!p.position) continue;
        if (p.hp <= 0) continue; // Defeated creatures don't block (they're prone/dead)

        const occupied = getOccupiedTiles(p.position, p.size || 'medium');
        for (const tile of occupied) {
            obstacles.add(tile);
        }
    }

    // Add terrain obstacles
    if (state.terrain?.obstacles) {
        for (const obs of state.terrain.obstacles) {
            obstacles.add(obs);
        }
    }

    return obstacles;
}

/**
 * Build difficult terrain set from combat state.
 *
 * @param state The combat state
 * @returns Set of difficult terrain tile keys ("x,y" format)
 *
 * Complexity: O(d) where d=difficult terrain tiles
 */
export function buildDifficultTerrainSet(state: SpatialCombatState): Set<string> {
    const difficult = new Set<string>();

    if (state.terrain?.difficultTerrain) {
        for (const tile of state.terrain.difficultTerrain) {
            difficult.add(tile);
        }
    }

    return difficult;
}

/**
 * Check if a destination tile is blocked.
 *
 * @param destination Target position
 * @param size Creature's size
 * @param obstacles Set of blocked tiles
 * @returns true if destination is blocked
 *
 * Complexity: O(s²) where s=size footprint
 */
export function isDestinationBlocked(
    destination: Position,
    size: SizeCategory,
    obstacles: Set<string>
): boolean {
    const neededTiles = getOccupiedTiles(destination, size);
    return neededTiles.some(tile => obstacles.has(tile));
}

// ============================================================
// PHASE 4: MOVEMENT ECONOMY
// ============================================================

/**
 * Create a terrain cost map for pathfinding.
 *
 * @param difficultTerrain Set of difficult terrain tiles
 * @returns TerrainCostMap for SpatialEngine
 *
 * Complexity: O(1) per tile lookup
 */
export function createTerrainCostMap(difficultTerrain: Set<string>): TerrainCostMap {
    return {
        getTileCost(point: Point): number {
            const key = `${point.x},${point.y}`;
            return difficultTerrain.has(key) ? DIFFICULT_TERRAIN_COST : 1;
        }
    };
}

/**
 * Calculate movement cost along a path.
 *
 * @param path Array of points in the path
 * @param difficultTerrain Set of difficult terrain tiles
 * @returns Total movement cost in feet
 *
 * @example
 * ```typescript
 * // Straight line 3 squares = 15 feet
 * calculatePathCost([{x:0,y:0}, {x:1,y:0}, {x:2,y:0}, {x:3,y:0}], new Set());
 * // Returns 15 (3 moves × 5 feet)
 *
 * // Diagonal movement = 1.5x cost
 * calculatePathCost([{x:0,y:0}, {x:1,y:1}], new Set());
 * // Returns 7.5 (1 diagonal × 1.5 × 5 feet)
 * ```
 *
 * Complexity: O(n) where n=path length
 */
export function calculatePathCost(path: Point[], difficultTerrain: Set<string>): number {
    if (path.length <= 1) return 0;

    let totalCost = 0;

    for (let i = 1; i < path.length; i++) {
        const from = path[i - 1];
        const to = path[i];

        // Calculate base cost (1 for orthogonal, 1.5 for diagonal)
        const dx = Math.abs(to.x - from.x);
        const dy = Math.abs(to.y - from.y);
        const isDiagonal = dx > 0 && dy > 0;
        let baseCost = isDiagonal ? DIAGONAL_COST : 1;

        // Apply difficult terrain multiplier for destination tile
        const destKey = `${to.x},${to.y}`;
        if (difficultTerrain.has(destKey)) {
            baseCost *= DIFFICULT_TERRAIN_COST;
        }

        // Convert squares to feet
        totalCost += baseCost * FEET_PER_SQUARE;
    }

    return totalCost;
}

/**
 * Convert feet to squares (rounding down).
 *
 * @param feet Distance in feet
 * @returns Distance in grid squares
 */
export function feetToSquares(feet: number): number {
    return Math.floor(feet / FEET_PER_SQUARE);
}

/**
 * Convert squares to feet.
 *
 * @param squares Distance in grid squares
 * @returns Distance in feet
 */
export function squaresToFeet(squares: number): number {
    return squares * FEET_PER_SQUARE;
}

/**
 * Initialize movement for start of turn.
 *
 * @param participant The participant starting their turn
 * @returns Updated participant with reset movement
 */
export function initializeMovement(participant: SpatialParticipant): SpatialParticipant {
    return {
        ...participant,
        movementRemaining: participant.movementSpeed || DEFAULT_MOVEMENT_SPEED,
        hasDashed: false
    };
}

/**
 * Apply dash action (doubles remaining movement).
 *
 * @param participant The participant dashing
 * @returns Updated participant with doubled movement
 */
export function applyDash(participant: SpatialParticipant): SpatialParticipant {
    const baseSpeed = participant.movementSpeed || DEFAULT_MOVEMENT_SPEED;
    const currentRemaining = participant.movementRemaining ?? baseSpeed;

    return {
        ...participant,
        movementRemaining: currentRemaining + baseSpeed,
        hasDashed: true
    };
}

// ============================================================
// PHASE 3 & 4: MOVEMENT VALIDATION
// ============================================================

/**
 * Validate a movement from current position to destination.
 * Enforces:
 * - Boundary validation (Phase 2)
 * - Collision detection (Phase 3)
 * - Movement economy (Phase 4)
 *
 * @param state The combat state
 * @param participantId ID of the moving participant
 * @param destination Target position
 * @param spatialEngine Optional SpatialEngine instance (creates one if not provided)
 * @returns MovementValidation result
 *
 * @example
 * ```typescript
 * const result = validateMovement(state, 'hero-1', { x: 5, y: 3 });
 * if (result.valid) {
 *     console.log(`Path found: ${result.path?.length} tiles, cost: ${result.pathCost}ft`);
 * } else {
 *     console.log(`Movement blocked: ${result.error}`);
 * }
 * ```
 *
 * Complexity: O(V log V + E) for A* pathfinding, where V=grid tiles, E=edges
 */
export function validateMovement(
    state: SpatialCombatState,
    participantId: string,
    destination: Position,
    spatialEngine?: SpatialEngine
): MovementValidation {
    const participant = state.participants.find(p => p.id === participantId) as SpatialParticipant | undefined;

    if (!participant) {
        return { valid: false, error: `Participant ${participantId} not found` };
    }

    const bounds = state.gridBounds || DEFAULT_GRID_BOUNDS;

    // Phase 2: Validate destination is within bounds
    const boundsError = validatePosition(destination, bounds, 'destination');
    if (boundsError) {
        return { valid: false, error: boundsError };
    }

    // Get current position
    const currentPos = participant.position;
    if (!currentPos) {
        // No current position - allow setting initial position without pathfinding
        // But still validate bounds
        return {
            valid: true,
            path: [destination],
            pathCost: 0
        };
    }

    // Phase 2: Validate current position is within bounds (sanity check)
    const currentBoundsError = validatePosition(currentPos, bounds, 'current position');
    if (currentBoundsError) {
        return { valid: false, error: `Invalid starting state: ${currentBoundsError}` };
    }

    // Build obstacles (excluding self)
    const obstacles = buildObstacleSet(state, participantId);
    const difficultTerrain = buildDifficultTerrainSet(state);

    // Phase 3: Check if destination is blocked
    const size = participant.size || 'medium';
    if (isDestinationBlocked(destination, size, obstacles)) {
        return { valid: false, error: 'Destination is blocked by obstacle or creature' };
    }

    // Phase 3 & 4: Find path using A* with terrain costs
    const engine = spatialEngine || new SpatialEngine();
    const terrainCostMap = createTerrainCostMap(difficultTerrain);

    const pathOptions: PathfindingOptions = {
        diagonalCost: 'alternating', // D&D 5e 5-10-5 rule
        terrainCosts: terrainCostMap,
        bounds: {
            min: { x: bounds.minX, y: bounds.minY },
            max: { x: bounds.maxX, y: bounds.maxY }
        }
    };

    const path = engine.findPath(
        { x: currentPos.x, y: currentPos.y },
        { x: destination.x, y: destination.y },
        obstacles,
        pathOptions
    );

    if (!path) {
        return { valid: false, error: 'No valid path - blocked by obstacles' };
    }

    // Phase 4: Calculate path cost
    const pathCost = calculatePathCost(path, difficultTerrain);
    const movementRemaining = participant.movementRemaining ??
        (participant.movementSpeed || DEFAULT_MOVEMENT_SPEED);

    if (pathCost > movementRemaining) {
        return {
            valid: false,
            error: `Insufficient movement: path costs ${pathCost}ft, have ${movementRemaining}ft remaining`,
            path,
            pathCost
        };
    }

    return {
        valid: true,
        path,
        pathCost
    };
}

// ============================================================
// PHASE 5: AOE INTEGRATION
// ============================================================

/**
 * Get all participants within a circular area.
 *
 * @param state The combat state
 * @param center Center point of the circle
 * @param radiusFeet Radius in feet
 * @param excludeIds Optional IDs to exclude (e.g., caster)
 * @returns AoEResult with affected tiles and participants
 *
 * @example
 * ```typescript
 * // 20ft radius Fireball centered at (10, 10)
 * const result = getParticipantsInCircle(state, { x: 10, y: 10 }, 20);
 * console.log(`Fireball hits ${result.affectedParticipants.length} creatures`);
 * ```
 *
 * Complexity: O(r² + p) where r=radius in squares, p=participants
 */
export function getParticipantsInCircle(
    state: SpatialCombatState,
    center: Position,
    radiusFeet: number,
    excludeIds: string[] = []
): AoEResult {
    const engine = new SpatialEngine();
    const radiusSquares = radiusFeet / FEET_PER_SQUARE;

    const affectedTiles = engine.getCircleTiles(
        { x: center.x, y: center.y },
        radiusSquares
    );

    const tileSet = new Set(affectedTiles.map(p => `${p.x},${p.y}`));

    const affectedParticipants = state.participants.filter(p => {
        if (excludeIds.includes(p.id)) return false;
        if (!p.position) return false;

        // Check if any of the creature's occupied tiles are in the area
        const occupied = getOccupiedTiles(p.position, p.size || 'medium');
        return occupied.some(tile => tileSet.has(tile));
    }) as SpatialParticipant[];

    return { affectedTiles, affectedParticipants };
}

/**
 * Get all participants within a cone area.
 *
 * @param state The combat state
 * @param origin Origin point of the cone
 * @param direction Direction vector (e.g., {x: 1, y: 0} for East)
 * @param lengthFeet Length in feet
 * @param angleDegrees Cone angle in degrees
 * @param excludeIds Optional IDs to exclude
 * @returns AoEResult with affected tiles and participants
 *
 * @example
 * ```typescript
 * // 15ft cone of cold facing North
 * const result = getParticipantsInCone(state, { x: 5, y: 5 }, { x: 0, y: -1 }, 15, 90);
 * ```
 *
 * Complexity: O(l² + p) where l=length in squares, p=participants
 */
export function getParticipantsInCone(
    state: SpatialCombatState,
    origin: Position,
    direction: Position,
    lengthFeet: number,
    angleDegrees: number,
    excludeIds: string[] = []
): AoEResult {
    const engine = new SpatialEngine();
    const lengthSquares = lengthFeet / FEET_PER_SQUARE;

    const affectedTiles = engine.getConeTiles(
        { x: origin.x, y: origin.y },
        { x: direction.x, y: direction.y },
        lengthSquares,
        angleDegrees
    );

    const tileSet = new Set(affectedTiles.map(p => `${p.x},${p.y}`));

    const affectedParticipants = state.participants.filter(p => {
        if (excludeIds.includes(p.id)) return false;
        if (!p.position) return false;

        const occupied = getOccupiedTiles(p.position, p.size || 'medium');
        return occupied.some(tile => tileSet.has(tile));
    }) as SpatialParticipant[];

    return { affectedTiles, affectedParticipants };
}

/**
 * Get all participants along a line (e.g., Lightning Bolt).
 *
 * @param state The combat state
 * @param start Start point of the line
 * @param end End point of the line
 * @param excludeIds Optional IDs to exclude
 * @returns AoEResult with affected tiles and participants
 *
 * @example
 * ```typescript
 * // 100ft Lightning Bolt from (0,0) to (20,0)
 * const result = getParticipantsInLine(state, { x: 0, y: 0 }, { x: 20, y: 0 });
 * ```
 *
 * Complexity: O(d + p) where d=distance in squares, p=participants
 */
export function getParticipantsInLine(
    state: SpatialCombatState,
    start: Position,
    end: Position,
    excludeIds: string[] = []
): AoEResult {
    const engine = new SpatialEngine();

    const affectedTiles = engine.getLineTiles(
        { x: start.x, y: start.y },
        { x: end.x, y: end.y }
    );

    const tileSet = new Set(affectedTiles.map(p => `${p.x},${p.y}`));

    const affectedParticipants = state.participants.filter(p => {
        if (excludeIds.includes(p.id)) return false;
        if (!p.position) return false;

        const occupied = getOccupiedTiles(p.position, p.size || 'medium');
        return occupied.some(tile => tileSet.has(tile));
    }) as SpatialParticipant[];

    return { affectedTiles, affectedParticipants };
}

/** Cover level a target can benefit from (D&D 5e). */
export type CoverLevel = 'none' | 'half' | 'three_quarter' | 'full';

/** Rank used to compare cover levels (higher = more protective). */
const COVER_RANK: Record<CoverLevel, number> = {
    none: 0,
    half: 1,
    three_quarter: 2,
    full: 3,
};

/**
 * Determine the cover a target receives from cover-providing props that lie on
 * the line between the attacker tile and the target tile.
 *
 * Returns the HIGHEST cover level among props strictly between the two tiles
 * (the attacker's and the target's own tiles are excluded). Returns 'none' when
 * there are no intervening cover props.
 *
 * SIMPLIFICATION (documented): D&D 5e determines cover by tracing lines from
 * each corner of the attacker's square to every corner of the target's square
 * (the "corner rule"). This engine uses a single Bresenham line between the two
 * tile centers (the same primitive used for line-of-sight) and treats any
 * cover-providing prop on that line as granting its cover. This is a reasonable
 * tile-based approximation that is deterministic and consistent with how the
 * rest of the spatial system reasons about lines. Edge nuances (true corner
 * rules, diagonal grazing) are intentionally out of scope here.
 *
 * @param state Combat state carrying `props` (cover-providing objects)
 * @param fromPos Attacker tile
 * @param toPos Target tile
 * @returns The highest applicable cover level, or 'none'
 *
 * Complexity: O(d + p) where d=line length, p=number of props
 */
export function determineCover(
    state: Pick<CombatState, 'props'>,
    fromPos: Position,
    toPos: Position
): CoverLevel {
    const props = state.props;
    if (!props || props.length === 0) return 'none';

    // Index cover-providing props by tile for O(1) lookup along the line.
    // Only props that actually grant cover (half/three_quarter/full) count.
    const coverByTile = new Map<string, CoverLevel>();
    for (const prop of props) {
        const cover = prop.cover;
        if (!cover || cover === 'none') continue;
        const existing = coverByTile.get(prop.position);
        if (existing === undefined || COVER_RANK[cover] > COVER_RANK[existing]) {
            coverByTile.set(prop.position, cover);
        }
    }
    if (coverByTile.size === 0) return 'none';

    const engine = new SpatialEngine();
    const line = engine.getLineTiles(
        { x: fromPos.x, y: fromPos.y },
        { x: toPos.x, y: toPos.y }
    );

    // Walk the interior of the line (exclude endpoints: attacker + target tiles).
    let best: CoverLevel = 'none';
    for (let i = 1; i < line.length - 1; i++) {
        const key = `${line[i].x},${line[i].y}`;
        const cover = coverByTile.get(key);
        if (cover && COVER_RANK[cover] > COVER_RANK[best]) {
            best = cover;
            if (best === 'full') break; // cannot get higher
        }
    }
    return best;
}

/**
 * Check line of sight from caster to target.
 *
 * @param state The combat state
 * @param from Origin point
 * @param to Target point
 * @returns true if clear line of sight exists
 *
 * Complexity: O(d + o) where d=distance, o=obstacles
 */
export function hasLineOfSight(
    state: SpatialCombatState,
    from: Position,
    to: Position
): boolean {
    const engine = new SpatialEngine();

    // Build obstacles (only terrain blocks LOS, not creatures)
    const obstacles = new Set<string>();
    if (state.terrain?.obstacles) {
        for (const obs of state.terrain.obstacles) {
            obstacles.add(obs);
        }
    }

    return engine.hasLineOfSight(
        { x: from.x, y: from.y },
        { x: to.x, y: to.y },
        obstacles
    );
}

// ============================================================
// COMBAT GRID MANAGER CLASS
// ============================================================

/**
 * CombatGridManager - High-level API for spatial combat operations.
 *
 * Provides a unified interface for all spatial combat operations,
 * integrating all 5 phases into a cohesive system.
 *
 * @example
 * ```typescript
 * const grid = new CombatGridManager(combatState);
 *
 * // Start of turn
 * grid.startTurn('hero-1');
 *
 * // Validate and execute movement
 * const moveResult = grid.validateMove('hero-1', { x: 5, y: 3 });
 * if (moveResult.valid) {
 *     grid.executeMove('hero-1', { x: 5, y: 3 });
 * }
 *
 * // Use dash action
 * grid.dash('hero-1');
 *
 * // Get fireball targets
 * const targets = grid.getCircleTargets({ x: 10, y: 10 }, 20);
 * ```
 */
export class CombatGridManager {
    private state: SpatialCombatState;
    private spatialEngine: SpatialEngine;

    constructor(state: SpatialCombatState) {
        this.state = state;
        this.spatialEngine = new SpatialEngine();

        // Ensure grid bounds exist
        if (!this.state.gridBounds) {
            this.state.gridBounds = { ...DEFAULT_GRID_BOUNDS };
        }
    }

    /**
     * Get the current combat state.
     */
    getState(): SpatialCombatState {
        return this.state;
    }

    /**
     * Get grid bounds.
     */
    getBounds(): GridBounds {
        return this.state.gridBounds;
    }

    /**
     * Initialize movement for a participant's turn.
     *
     * @param participantId The participant starting their turn
     */
    startTurn(participantId: string): void {
        const index = this.state.participants.findIndex(p => p.id === participantId);
        if (index === -1) return;

        this.state.participants[index] = initializeMovement(this.state.participants[index]);
    }

    /**
     * Validate a movement without executing it.
     *
     * @param participantId ID of the moving participant
     * @param destination Target position
     * @returns MovementValidation result
     */
    validateMove(participantId: string, destination: Position): MovementValidation {
        return validateMovement(this.state, participantId, destination, this.spatialEngine);
    }

    /**
     * Execute a validated movement.
     * Call validateMove first to ensure movement is valid.
     *
     * @param participantId ID of the moving participant
     * @param destination Target position
     * @param pathCost Cost in feet (from validation result)
     * @returns true if movement was executed
     */
    executeMove(participantId: string, destination: Position, pathCost: number): boolean {
        const index = this.state.participants.findIndex(p => p.id === participantId);
        if (index === -1) return false;

        const participant = this.state.participants[index];
        const currentRemaining = participant.movementRemaining ??
            (participant.movementSpeed || DEFAULT_MOVEMENT_SPEED);

        // Update position and deduct movement
        this.state.participants[index] = {
            ...participant,
            position: destination,
            movementRemaining: currentRemaining - pathCost
        };

        return true;
    }

    /**
     * Apply dash action to double movement.
     *
     * @param participantId ID of the participant
     * @returns true if dash was applied
     */
    dash(participantId: string): boolean {
        const index = this.state.participants.findIndex(p => p.id === participantId);
        if (index === -1) return false;

        if (this.state.participants[index].hasDashed) {
            return false; // Already dashed this turn
        }

        this.state.participants[index] = applyDash(this.state.participants[index]);
        return true;
    }

    /**
     * Set initial position for a participant.
     * Used when placing tokens at encounter start.
     *
     * @param participantId ID of the participant
     * @param position Initial position
     * @returns null if successful, error message if invalid
     */
    setPosition(participantId: string, position: Position): string | null {
        const error = validatePosition(position, this.state.gridBounds, 'initial position');
        if (error) return error;

        const index = this.state.participants.findIndex(p => p.id === participantId);
        if (index === -1) return `Participant ${participantId} not found`;

        // Check collision
        const obstacles = buildObstacleSet(this.state, participantId);
        const size = this.state.participants[index].size || 'medium';

        if (isDestinationBlocked(position, size, obstacles)) {
            return 'Position is blocked by obstacle or creature';
        }

        this.state.participants[index] = {
            ...this.state.participants[index],
            position
        };

        return null;
    }

    /**
     * Get participants in a circular area (e.g., Fireball).
     */
    getCircleTargets(center: Position, radiusFeet: number, excludeIds: string[] = []): AoEResult {
        return getParticipantsInCircle(this.state, center, radiusFeet, excludeIds);
    }

    /**
     * Get participants in a cone area (e.g., Burning Hands).
     */
    getConeTargets(
        origin: Position,
        direction: Position,
        lengthFeet: number,
        angleDegrees: number,
        excludeIds: string[] = []
    ): AoEResult {
        return getParticipantsInCone(this.state, origin, direction, lengthFeet, angleDegrees, excludeIds);
    }

    /**
     * Get participants along a line (e.g., Lightning Bolt).
     */
    getLineTargets(start: Position, end: Position, excludeIds: string[] = []): AoEResult {
        return getParticipantsInLine(this.state, start, end, excludeIds);
    }

    /**
     * Check line of sight between two points.
     */
    hasLineOfSight(from: Position, to: Position): boolean {
        return hasLineOfSight(this.state, from, to);
    }

    /**
     * Get remaining movement for a participant.
     */
    getRemainingMovement(participantId: string): number {
        const p = this.state.participants.find(p => p.id === participantId);
        if (!p) return 0;
        return p.movementRemaining ?? (p.movementSpeed || DEFAULT_MOVEMENT_SPEED);
    }
}
