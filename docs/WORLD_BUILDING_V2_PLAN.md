# World Building v2 - Implementation Plan

## Overview

Transform from manual zone definitions to planet-scale slippy tile system with streaming, procedural generation, and dynamic sim loading.

## Data Sources

| Layer | Source | Resolution | License | Download |
|-------|--------|------------|---------|----------|
| Elevation | SRTM 30m | 30m | Public Domain | USGS/OpenTopo |
| Water | OpenStreetMap | Vector | ODbL | Overpass API |
| Population | GHS-POP 2020 | 100m | CC-BY-4.0 | EU JRC |
| Biomes | ESA WorldCover | 10m | CC-BY-4.0 | ESA |

**Attribution Required**: OpenStreetMap, GHS-POP, ESA WorldCover

---

## Phase A: Foundation (Current Focus)

### A1: Tile Addressing System
Create utilities for slippy tile ↔ lat/lon conversion.

**Files to create:**
```
src/world/tiles/
├── TileAddress.ts       # (z, x, y) type + conversions
├── TileUtils.ts         # lat/lon ↔ tile, neighbors, containment
└── TileConstants.ts     # Zoom levels, tile sizes
```

**Key functions:**
- `latLonToTile(lat, lon, zoom)` → `{z, x, y}`
- `tileToLatLonBounds(z, x, y)` → `{north, south, east, west}`
- `getNeighborTiles(z, x, y)` → `TileAddress[]`
- `getTileContaining(lat, lon, zoom)` → `TileAddress`
- `subdivide(z, x, y)` → `TileAddress[]` (4 children)

**Zoom level decisions:**
- **Macro tiles (streaming)**: z=12 (~10km × 10km at equator)
- **Micro tiles (simulation)**: z=14 (~2.5km × 2.5km at equator)

### A2: Tile State Machine
Implement Cold/Warm/Hot lifecycle for micro tiles.

**States:**
- `COLD` - No sim loaded, manifest only
- `WARM` - Sim loaded, low-frequency tick (1/min)
- `HOT` - Full sim, high-frequency tick (1/sec)

**Transitions:**
- `COLD → WARM`: Player within prefetch radius
- `WARM → HOT`: Player enters tile
- `HOT → WARM`: 2-5 min no players nearby
- `WARM → COLD`: 20-40 min no players nearby

**Files to create:**
```
src/world/tiles/
├── TileState.ts         # State enum + transition logic
├── TileStateManager.ts  # Manages all tile states
└── TileWakePolicy.ts    # Wake/sleep decision rules
```

### A3: Database Schema
New tables for tile-based world.

```prisma
model WorldTile {
  id              String   @id // Format: "z_x_y"
  z               Int
  x               Int
  y               Int
  state           String   @default("COLD") // COLD, WARM, HOT
  lastTouchedAt   DateTime @default(now())

  // Truth layer hashes (for cache invalidation)
  elevationHash   String?
  waterHash       String?
  populationHash  String?
  biomeHash       String?

  // Game layer versions
  ruinLayoutVersion    Int @default(0)
  spawnTableVersion    Int @default(0)
  navmeshVersion       Int @default(0)

  // Computed scores
  ruinScore       Float @default(0)
  damageScore     Float @default(0)
  corruptionScore Float @default(0)

  // Manifest
  manifestHash    String?

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([z, x, y])
  @@index([state])
  @@map("world_tiles")
}

model TileBuildJob {
  id          String   @id @default(uuid())
  tileId      String   // Reference to WorldTile.id
  jobType     String   // ELEVATION_FETCH, RUIN_GEN, NAV_BAKE, etc.
  status      String   @default("PENDING") // PENDING, RUNNING, COMPLETED, FAILED
  priority    Int      @default(0)
  attempts    Int      @default(0)
  errorMsg    String?
  outputHash  String?
  createdAt   DateTime @default(now())
  startedAt   DateTime?
  completedAt DateTime?

  @@index([status, priority])
  @@map("tile_build_jobs")
}
```

### A4: Manifest System
Define what a tile needs to exist.

**Macro Tile Manifest:**
```typescript
interface MacroTileManifest {
  tileId: string;        // "z_x_y"
  version: number;

  // Asset references (content-addressed)
  assets: {
    elevation: string;   // Hash of heightmap chunk
    water: string;       // Hash of water mask
    biome: string;       // Hash of biome classification
  };

  // Child micro tiles
  microTiles: string[];  // List of micro tile IDs
}
```

**Micro Tile Manifest:**
```typescript
interface MicroTileManifest {
  tileId: string;
  version: number;
  parentMacroTile: string;

  // Computed scores
  ruinScore: number;
  damageScore: number;
  corruptionScore: number;

  // Game data versions
  ruinLayoutVersion: number;
  spawnTableVersion: number;
  navmeshVersion: number;

  // Asset references
  assets: {
    navmesh?: string;    // Hash of navmesh data
    ruinLayout?: string; // Hash of ruin placement data
    spawnTable?: string; // Hash of spawn configuration
  };
}
```

---

## Phase B: Truth Layers

### B1: Elevation Pipeline
Fetch and process SRTM data per tile.

**Pipeline:**
1. Check if elevation exists for tile (by hash)
2. If not, fetch from SRTM source
3. Process: clip to tile bounds, convert format
4. Store: content-addressed blob storage
5. Update manifest hash

**Tools needed:**
- GDAL for processing (via Node bindings or external process)
- Blob storage (local filesystem initially, S3 later)

### B2: Water Pipeline
Extract water features from OSM.

**Pipeline:**
1. Query Overpass API for tile bounds
2. Extract: rivers, lakes, coastlines
3. Rasterize to water mask (or keep as vector)
4. Store content-addressed
5. Update manifest

### B3: Population/Ruin Scoring
Process GHS-POP for ruin density.

**Pipeline:**
1. Fetch GHS-POP tile
2. Compute average population per micro tile
3. Map to scores:
   - `ruin_score = log(population + 1) / max_log`
   - `damage_score = ruin_score^1.5`
   - `corruption_score = damage_score + cataclysm_modifier`

### B4: Biome Classification
Process ESA WorldCover.

**Pipeline:**
1. Fetch WorldCover tile
2. Classify dominant biome per micro tile
3. Map ESA classes to game biomes:
   - 10 (Trees) → FOREST
   - 20 (Shrubland) → SCRUB
   - 30 (Herbaceous) → GRASSLAND
   - 40 (Wetland) → MARSH
   - 60 (Sparse) → DESERT
   - 70 (Bare) → ROCKY
   - 90 (Snow) → TUNDRA
   - 95 (Built-up) → RUINS

---

## Phase C: Game Layers

### C1: Ruin Generation
Procedural placement of ruins based on scores.

**Rules:**
- High `ruin_score` → more structures
- High `damage_score` → more collapsed/dangerous
- Seed from tile coordinates for determinism

### C2: Spawn Tables
Per-tile spawn configuration.

**Influenced by:**
- Biome type
- Corruption score
- Distance from settlements
- Ruin density

### C3: Dungeon/Cave Entrances
PCG entrance placement.

**Rules:**
- Mountains/hills: cave entrances
- Urban ruins: basement/bunker entrances
- Special sites: authored locations

---

## Phase D: Navmesh

### D1: Base Terrain Nav
Generate walkability from heightmap.

**Rules:**
- Slope > 45° = unwalkable
- Water = unwalkable
- Cliff edges = marked

### D2: Structure Nav
Add nav modifiers for ruins.

**Types:**
- Blocked (collapsed)
- Traversable (intact floors)
- Climb points
- Jump links

### D3: Dynamic Obstacles
Runtime nav updates.

**Handled via:**
- Nav blockers (temporary)
- Local avoidance (crowd)
- Not full rebake

---

## Migration Strategy

### From Current Zone System

1. **Keep zones for Phase 1-3 content**
   - Stephentown, etc. remain as authored zones
   - Coexist with tile system

2. **Tiles for expansion**
   - New areas use tile system
   - Tiles can "contain" legacy zones

3. **Gradual migration**
   - Convert legacy zones to tiles when ready
   - Keep both systems running

### Zone → Tile Mapping

```typescript
// Legacy zone maps to micro tile(s)
interface ZoneTileMapping {
  zoneId: string;           // Legacy zone ID
  microTileIds: string[];   // Covering micro tiles
  authoredContent: boolean; // True if has manual content
}
```

---

## Services Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Game Server                             │
│  ┌─────────────────┐  ┌─────────────────┐                   │
│  │  ZoneServer     │  │  TileService    │                   │
│  │  (legacy)       │  │  (new)          │                   │
│  └────────┬────────┘  └────────┬────────┘                   │
│           │                    │                             │
│           └──────────┬─────────┘                             │
│                      ▼                                       │
│              DistributedWorldManager                         │
└──────────────────────┬───────────────────────────────────────┘
                       │ Redis
┌──────────────────────▼───────────────────────────────────────┐
│                   Tile Builder Service                        │
│  (separate process - handles heavy lifting)                   │
│                                                               │
│  - Elevation fetching/processing                              │
│  - Water extraction                                           │
│  - Navmesh baking                                             │
│  - Ruin generation                                            │
└───────────────────────────────────────────────────────────────┘
```

---

## Immediate Next Steps

1. **Create `TileAddress.ts`** - Core addressing utilities
2. **Create `TileState.ts`** - State machine
3. **Add Prisma schema** - WorldTile, TileBuildJob
4. **Create `TileService.ts`** - CRUD for tiles
5. **Prototype**: Load one SRTM tile for Stephentown
