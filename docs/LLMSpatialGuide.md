# LLM Spatial Combat Guide

## Encounter Creation Workflow

Follow this sequence when creating 3D combat encounters:

1. **Generate Terrain** → `combat_map` (action `generate_patch`) with biome/density
2. **Add Details** → `combat_map` (action `place_prop`) for POIs, buildings, structures
3. **Place Party** → Party members positioned safely
4. **Place Enemies** → Enemies positioned tactically
5. **Start Combat** → `spawn_manage` (action `spawn_encounter`) with all positions

---

## Critical Verticality Rules

### Z-Coordinate Semantics

| Z Value | Meaning                          | Use Case                    |
| ------- | -------------------------------- | --------------------------- |
| `z=0`   | Standing on surface at (x,y)     | **Default for everything**  |
| `z>0`   | Flying/levitating in air         | Only with flight capability |
| `z<0`   | In pit/valley/water below ground | Deep rivers, chasms         |

### The Golden Rule

> **"Standing on rocks" = same (x,y) as rock obstacle, z=0**
>
> The terrain height is IMPLICIT. Don't add synthetic Z values!

### Examples

```json
// ✅ CORRECT: Goblin standing ON rock at (15,3)
{ "position": { "x": 15, "y": 3, "z": 0 } }

// ❌ WRONG: Goblin floating above rock (will FALL!)
{ "position": { "x": 15, "y": 3, "z": 25 } }
```

---

## Terrain Generation Rules

### Obstacles Should Cluster

Create natural formations, not random squares:

- **Hills/Mountains**: Obstacles cluster with adjacent slopes
- **Valleys**: Negative elevation with gradual descent
- **Cliffs**: Only isolated vertical surfaces if INTENTIONALLY inaccessible
- **Default**: Add adjacent terrain that steps down to ground level

### Slopes Are Required

Unless designing inaccessible terrain:

```
Ground(0) → Low(1) → Mid(2) → High(3)  ✅ Natural mountain
Ground(0) → HIGH(5)                      ❌ Floating platform (needs flying)
```

### Water Must Connect

Water bodies should be connected as rivers, streams, or pools:

- **Rivers**: Long chains of tiles, narrow (1-2 wide)
- **Streams**: Short chains (2-5 tiles)
- **Pools**: Clustered circular-ish areas
- **Lakes**: Large connected bodies

Never place isolated single water tiles.

---

## Prop Placement

### Height Semantics

`heightFeet` describes the PROP's visual height, NOT entity position:

```json
{
  "position": "5,5",
  "label": "30ft Cliff",
  "heightFeet": 30 // Visual appearance
  // Entity standing on top uses z=0, not z=30!
}
```

### Structure Types

| Type         | Description               | Example               |
| ------------ | ------------------------- | --------------------- |
| `cliff`      | Vertical rocky terrain    | Mountain side         |
| `wall`       | Stone/brick barrier       | Building wall         |
| `bridge`     | Spanning structure        | River crossing        |
| `tree`       | Vegetation                | Forest cover          |
| `stairs`     | Stepped ascent            | Access to high ground |
| `pit`        | Below ground (negative Y) | Trap, ravine          |
| `water_pool` | Recessed water            | Pond, stream section  |

---

## Entity Placement

### Creature Archetypes

| Archetype   | Description   | Examples              |
| ----------- | ------------- | --------------------- |
| `humanoid`  | Bipedal       | Goblins, orcs, humans |
| `quadruped` | Four-legged   | Wolves, horses        |
| `beast`     | Hunched/bulky | Trolls, bears         |
| `serpent`   | Elongated     | Snakes, worms         |
| `avian`     | Winged        | Dragons, harpies      |
| `arachnid`  | Multi-legged  | Spiders, scorpions    |
| `amorphous` | Blob-like     | Oozes, elementals     |

### Tactical Positioning

- **Archers**: On elevated terrain (standing ON obstacles)
- **Melee**: Ground level, near approaches
- **Ambushers**: Behind cover props
- **Flying**: Only creatures with flight (z>0)

---

## Terrain Pattern Templates

Use these exact patterns for consistent generation. COPY the coordinate patterns!

### River Valley Ambush

Parallel cliff walls with wide river in the middle.

```
Layout (top-down view):
  CLIFF ROW 1 (West Wall)  |  RIVER (3-wide)  |  CLIFF ROW 2 (East Wall)
       x=5                 |    x=8,9,10      |       x=13
```

```json
{
  "terrain": {
    "obstacles": [
      // WEST CLIFF WALL (straight line at x=5)
      "5,0",
      "5,1",
      "5,2",
      "5,3",
      "5,4",
      "5,5",
      "5,6",
      "5,7",
      "5,8",
      "5,9",
      "5,10",
      "5,11",
      "5,12",
      "5,13",
      "5,14",
      "5,15",
      "5,16",
      "5,17",
      "5,18",
      "5,19",
      // EAST CLIFF WALL (straight line at x=13)
      "13,0",
      "13,1",
      "13,2",
      "13,3",
      "13,4",
      "13,5",
      "13,6",
      "13,7",
      "13,8",
      "13,9",
      "13,10",
      "13,11",
      "13,12",
      "13,13",
      "13,14",
      "13,15",
      "13,16",
      "13,17",
      "13,18",
      "13,19"
    ],
    "water": [
      // RIVER CENTER (3 tiles wide, x=8,9,10)
      "8,0",
      "9,0",
      "10,0",
      "8,1",
      "9,1",
      "10,1",
      "8,2",
      "9,2",
      "10,2",
      "8,3",
      "9,3",
      "10,3",
      "8,4",
      "9,4",
      "10,4",
      "8,5",
      "9,5",
      "10,5",
      "8,6",
      "9,6",
      "10,6",
      "8,7",
      "9,7",
      "10,7",
      "8,8",
      "9,8",
      "10,8",
      "8,9",
      "9,9",
      "10,9",
      "8,10",
      "9,10",
      "10,10",
      "8,11",
      "9,11",
      "10,11",
      "8,12",
      "9,12",
      "10,12",
      "8,13",
      "9,13",
      "10,13",
      "8,14",
      "9,14",
      "10,14",
      "8,15",
      "9,15",
      "10,15",
      "8,16",
      "9,16",
      "10,16",
      "8,17",
      "9,17",
      "10,17",
      "8,18",
      "9,18",
      "10,18",
      "8,19",
      "9,19",
      "10,19"
    ]
  }
}
```

### Canyon (Two Parallel Walls)

```json
{
  "terrain": {
    "obstacles": [
      // NORTH WALL
      "0,5",
      "1,5",
      "2,5",
      "3,5",
      "4,5",
      "5,5",
      "6,5",
      "7,5",
      "8,5",
      "9,5",
      // SOUTH WALL
      "0,15",
      "1,15",
      "2,15",
      "3,15",
      "4,15",
      "5,15",
      "6,15",
      "7,15",
      "8,15",
      "9,15"
    ]
  }
}
```

### Circular Arena

```json
{
  "terrain": {
    "obstacles": [
      // Circle perimeter (radius 8, center at 10,10)
      "10,2",
      "11,2",
      "12,3",
      "13,4",
      "14,5",
      "15,6",
      "16,7",
      "17,8",
      "17,9",
      "17,10",
      "17,11",
      "16,12",
      "15,13",
      "14,14",
      "13,15",
      "12,16",
      "11,17",
      "10,17",
      "9,17",
      "8,16",
      "7,15",
      "6,14",
      "5,13",
      "4,12",
      "3,11",
      "3,10",
      "3,9",
      "3,8",
      "4,7",
      "5,6",
      "6,5",
      "7,4",
      "8,3",
      "9,2"
    ]
  }
}
```

### Mountain Pass (Narrowing Corridor)

```json
{
  "terrain": {
    "obstacles": [
      // LEFT WALL (narrows toward center)
      "3,0",
      "4,2",
      "5,4",
      "6,6",
      "7,8",
      "8,10",
      "7,12",
      "6,14",
      "5,16",
      "4,18",
      "3,20",
      // RIGHT WALL (mirrors left)
      "17,0",
      "16,2",
      "15,4",
      "14,6",
      "13,8",
      "12,10",
      "13,12",
      "14,14",
      "15,16",
      "16,18",
      "17,20"
    ]
  }
}
```

---

## Complete Example

```json
{
  "seed": "forest-ambush-001",
  "terrain": {
    "obstacles": [
      "10,5",
      "11,5",
      "12,5", // Hill cluster
      "10,6",
      "11,6", // Slope down
      "10,7" // Ground adjacent
    ],
    "water": [
      "5,10",
      "5,11",
      "5,12",
      "6,12",
      "7,12" // Connected stream
    ],
    "difficultTerrain": [
      "8,8",
      "8,9",
      "9,8",
      "9,9" // Undergrowth cluster
    ]
  },
  "participants": [
    // Party at ground level
    { "id": "player-1", "position": { "x": 15, "y": 15, "z": 0 } },

    // Goblin archer ON the hill (not floating above it)
    { "id": "goblin-archer", "position": { "x": 10, "y": 5, "z": 0 } },

    // Melee goblin at ground near slope
    { "id": "goblin-melee", "position": { "x": 10, "y": 8, "z": 0 } }
  ]
}
```
