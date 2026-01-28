/**
 * NavmeshPipeline - Generates navigation data for pathfinding.
 *
 * Creates a walkability grid and movement cost map from terrain,
 * structures, and water data. Used for server-side pathfinding.
 *
 * Grid resolution: 64x64 cells per micro tile (~39m per cell at z=14)
 */

import { type TileAddress, tileAddressToId } from '../TileAddress';
import { TileBuildJobType, TileService } from '../TileService';
import { BaseTilePipeline, type PipelineResult } from './TilePipeline';
import { ElevationPipeline, type TileElevationData } from './ElevationPipeline';
import { BiomePipeline, BiomeType, type TileBiomeData } from './BiomePipeline';
import { RuinGenPipeline, type TileRuinLayout, StructureCondition } from './RuinGenPipeline';

/**
 * Cell walkability flags (bitfield)
 */
export enum WalkabilityFlag {
  /** Cell is fully walkable */
  WALKABLE = 0,
  /** Blocked by structure */
  BLOCKED_STRUCTURE = 1 << 0,
  /** Blocked by water */
  BLOCKED_WATER = 1 << 1,
  /** Blocked by steep slope */
  BLOCKED_SLOPE = 1 << 2,
  /** Blocked by corruption */
  BLOCKED_CORRUPTION = 1 << 3,
  /** Road - faster movement */
  ROAD = 1 << 4,
  /** Dense vegetation - slower movement */
  DENSE_VEGETATION = 1 << 5,
  /** Rubble/debris - slower movement */
  RUBBLE = 1 << 6,
  /** Indoor area */
  INDOOR = 1 << 7,
}

/**
 * Movement cost modifiers
 */
export enum MovementCost {
  /** Standard terrain */
  NORMAL = 1.0,
  /** Road - fast travel */
  ROAD = 0.7,
  /** Dense forest/vegetation */
  VEGETATION = 1.5,
  /** Rubble/debris field */
  RUBBLE = 2.0,
  /** Marsh/swamp */
  MARSH = 2.5,
  /** Sand/desert */
  SAND = 1.3,
  /** Snow/ice */
  SNOW = 1.8,
  /** Rocky terrain */
  ROCKY = 1.4,
  /** Impassable */
  IMPASSABLE = Infinity,
}

/**
 * A single navigation cell
 */
export interface NavCell {
  /** Walkability flags */
  flags: number;
  /** Movement cost multiplier */
  cost: number;
  /** Elevation at cell center */
  elevation: number;
  /** Slope angle in degrees */
  slope: number;
}

/**
 * Edge connection data for cross-tile pathfinding
 */
export interface TileEdge {
  /** Direction: 'N', 'S', 'E', 'W' */
  direction: 'N' | 'S' | 'E' | 'W';
  /** Array of walkable cell indices along this edge */
  walkableCells: number[];
  /** Matching cell indices on adjacent tile (for stitching) */
  connectionPoints: number[];
}

/**
 * Complete navmesh data for a tile
 */
export interface TileNavmesh {
  /** Tile ID */
  tileId: string;
  /** Version (incremented on regeneration) */
  version: number;
  /** Grid resolution (cells per side) */
  resolution: number;
  /** Cell size in meters */
  cellSize: number;
  /** Flattened grid of navigation cells (row-major order) */
  cells: NavCell[];
  /** Edge connection data for adjacent tiles */
  edges: TileEdge[];
  /** Statistics */
  stats: {
    totalCells: number;
    walkableCells: number;
    blockedCells: number;
    averageCost: number;
  };
  /** Seed used for generation */
  seed: number;
}

/**
 * Configuration for navmesh generation
 */
export interface NavmeshPipelineConfig {
  /** Grid resolution (cells per side) */
  resolution: number;
  /** Maximum walkable slope in degrees */
  maxWalkableSlope: number;
  /** Whether to block water cells */
  blockWater: boolean;
  /** Minimum corruption level that blocks movement */
  corruptionBlockThreshold: number;
}

const DEFAULT_CONFIG: NavmeshPipelineConfig = {
  resolution: 64,
  maxWalkableSlope: 45,
  blockWater: true,
  corruptionBlockThreshold: 0.9,
};

/**
 * Biome to movement cost mapping
 */
const BIOME_COSTS: Record<BiomeType, number> = {
  [BiomeType.FOREST]: MovementCost.VEGETATION,
  [BiomeType.SCRUB]: MovementCost.NORMAL,
  [BiomeType.GRASSLAND]: MovementCost.NORMAL,
  [BiomeType.MARSH]: MovementCost.MARSH,
  [BiomeType.DESERT]: MovementCost.SAND,
  [BiomeType.ROCKY]: MovementCost.ROCKY,
  [BiomeType.TUNDRA]: MovementCost.SNOW,
  [BiomeType.RUINS]: MovementCost.RUBBLE,
  [BiomeType.WATER]: MovementCost.IMPASSABLE,
  [BiomeType.COASTAL]: MovementCost.SAND,
  [BiomeType.FARMLAND]: MovementCost.NORMAL,
};

/**
 * NavmeshPipeline - Generates navigation grids
 */
export class NavmeshPipeline extends BaseTilePipeline {
  jobType = TileBuildJobType.NAV_BAKE;
  name = 'NavmeshPipeline';

  private config: NavmeshPipelineConfig;

  constructor(config: Partial<NavmeshPipelineConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async process(tile: TileAddress, _inputHash?: string): Promise<PipelineResult> {
    this.log(tile, 'Generating navmesh');

    try {
      const tileId = tileAddressToId(tile);
      const tileRecord = await TileService.getTile(tileId);

      // Load prerequisite data
      let elevationData: TileElevationData | null = null;
      let biomeData: TileBiomeData | null = null;
      let ruinLayout: TileRuinLayout | null = null;

      if (tileRecord?.elevationHash) {
        const buffer = await this.storage.get(tileRecord.elevationHash);
        if (buffer) {
          elevationData = ElevationPipeline.deserializeElevationData(buffer);
        }
      }

      if (tileRecord?.biomeHash) {
        const buffer = await this.storage.get(tileRecord.biomeHash);
        if (buffer) {
          biomeData = BiomePipeline.deserializeBiomeData(buffer);
        }
      }

      if (tileRecord?.ruinLayoutHash) {
        const buffer = await this.storage.get(tileRecord.ruinLayoutHash);
        if (buffer) {
          ruinLayout = RuinGenPipeline.deserializeRuinLayout(buffer);
        }
      }

      // Generate navmesh
      const navmesh = this.generateNavmesh(tile, elevationData, biomeData, ruinLayout);

      // Serialize and store
      const buffer = Buffer.from(JSON.stringify(navmesh), 'utf-8');
      const hash = await this.storage.put(buffer);

      const walkablePercent = (navmesh.stats.walkableCells / navmesh.stats.totalCells * 100).toFixed(1);
      this.log(
        tile,
        `Generated navmesh: ${navmesh.stats.walkableCells}/${navmesh.stats.totalCells} walkable (${walkablePercent}%), ` +
          `avg cost=${navmesh.stats.averageCost.toFixed(2)}`
      );

      return this.success(hash, {
        version: navmesh.version,
        walkableCells: navmesh.stats.walkableCells,
        blockedCells: navmesh.stats.blockedCells,
        averageCost: navmesh.stats.averageCost,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(tile, `Failed: ${message}`);
      return this.failure(message);
    }
  }

  /**
   * Generate navmesh for a tile
   */
  private generateNavmesh(
    tile: TileAddress,
    elevationData: TileElevationData | null,
    biomeData: TileBiomeData | null,
    ruinLayout: TileRuinLayout | null
  ): TileNavmesh {
    const tileId = tileAddressToId(tile);
    const seed = this.computeSeed(tile);
    const resolution = this.config.resolution;
    const totalCells = resolution * resolution;

    // Calculate cell size in meters (approximate for micro tile ~2.5km)
    const tileSize = 2500; // meters at z=14
    const cellSize = tileSize / resolution;

    // Initialize cells
    const cells: NavCell[] = [];
    let walkableCount = 0;
    let totalCost = 0;

    for (let row = 0; row < resolution; row++) {
      for (let col = 0; col < resolution; col++) {
        const cell = this.generateCell(
          row,
          col,
          resolution,
          elevationData,
          biomeData,
          ruinLayout
        );
        cells.push(cell);

        if ((cell.flags & (
          WalkabilityFlag.BLOCKED_STRUCTURE |
          WalkabilityFlag.BLOCKED_WATER |
          WalkabilityFlag.BLOCKED_SLOPE |
          WalkabilityFlag.BLOCKED_CORRUPTION
        )) === 0) {
          walkableCount++;
          totalCost += cell.cost;
        }
      }
    }

    // Generate edge connections
    const edges = this.generateEdges(cells, resolution);

    const averageCost = walkableCount > 0 ? totalCost / walkableCount : 0;

    return {
      tileId,
      version: 1,
      resolution,
      cellSize,
      cells,
      edges,
      stats: {
        totalCells,
        walkableCells: walkableCount,
        blockedCells: totalCells - walkableCount,
        averageCost,
      },
      seed,
    };
  }

  /**
   * Generate a single navigation cell
   */
  private generateCell(
    row: number,
    col: number,
    resolution: number,
    elevationData: TileElevationData | null,
    biomeData: TileBiomeData | null,
    ruinLayout: TileRuinLayout | null
  ): NavCell {
    let flags = WalkabilityFlag.WALKABLE;
    let cost = MovementCost.NORMAL;
    let elevation = 0;
    let slope = 0;

    // Normalized position (0-1)
    const x = col / resolution;
    const z = row / resolution;

    // Get elevation and calculate slope
    if (elevationData) {
      elevation = this.sampleElevation(elevationData, x, z);
      slope = this.calculateSlope(elevationData, x, z, resolution);

      if (slope > this.config.maxWalkableSlope) {
        flags |= WalkabilityFlag.BLOCKED_SLOPE;
      }
    }

    // Check biome for base cost and water blocking
    if (biomeData) {
      const biome = biomeData.dominantBiome;
      cost = BIOME_COSTS[biome] ?? MovementCost.NORMAL;

      if (this.config.blockWater && biome === BiomeType.WATER) {
        flags |= WalkabilityFlag.BLOCKED_WATER;
      }

      if (biome === BiomeType.FOREST) {
        flags |= WalkabilityFlag.DENSE_VEGETATION;
      }

      if (biome === BiomeType.MARSH) {
        flags |= WalkabilityFlag.DENSE_VEGETATION;
      }
    }

    // Check structures
    if (ruinLayout) {
      // Check if cell intersects with any structure
      for (const structure of ruinLayout.structures) {
        const dist = Math.sqrt((x - structure.x) ** 2 + (z - structure.z) ** 2);
        const structureRadius = 0.02 * structure.scale; // Approximate

        if (dist < structureRadius) {
          // Inside structure footprint
          if (structure.condition === StructureCondition.COLLAPSED) {
            flags |= WalkabilityFlag.RUBBLE;
            cost = Math.max(cost, MovementCost.RUBBLE);
          } else if (structure.condition === StructureCondition.PARTIAL_COLLAPSE) {
            flags |= WalkabilityFlag.RUBBLE;
            cost = Math.max(cost, MovementCost.RUBBLE * 0.7);
          } else {
            // Standing structure blocks movement
            flags |= WalkabilityFlag.BLOCKED_STRUCTURE;
            flags |= WalkabilityFlag.INDOOR;
          }
          break;
        }
      }

      // Check roads - override cost if on road
      for (const road of ruinLayout.roads) {
        if (this.isPointNearRoad(x, z, road)) {
          if (road.condition !== StructureCondition.COLLAPSED) {
            flags |= WalkabilityFlag.ROAD;
            // Road cost is best, unless blocked
            if ((flags & WalkabilityFlag.BLOCKED_STRUCTURE) === 0) {
              cost = MovementCost.ROAD;
            }
          } else {
            flags |= WalkabilityFlag.RUBBLE;
          }
          break;
        }
      }
    }

    return { flags, cost, elevation, slope };
  }

  /**
   * Sample elevation at a normalized position
   */
  private sampleElevation(data: TileElevationData, x: number, z: number): number {
    const res = data.width; // Use width as resolution (square grid)
    const col = Math.min(Math.floor(x * res), res - 1);
    const row = Math.min(Math.floor(z * res), res - 1);
    const idx = row * res + col;

    return data.elevations[idx] ?? data.meanElevation;
  }

  /**
   * Calculate slope at a position (degrees)
   */
  private calculateSlope(
    data: TileElevationData,
    x: number,
    z: number,
    navResolution: number
  ): number {
    const cellSize = 2500 / navResolution; // meters per nav cell
    const elevRes = data.width; // Use width as resolution

    // Sample points for gradient
    const dx = 1 / elevRes;
    const dz = 1 / elevRes;

    const e0 = this.sampleElevation(data, x, z);
    const ex = this.sampleElevation(data, Math.min(x + dx, 1), z);
    const ez = this.sampleElevation(data, x, Math.min(z + dz, 1));

    // Gradient in meters per cell
    const gradX = (ex - e0) / cellSize;
    const gradZ = (ez - e0) / cellSize;

    // Slope angle
    const gradient = Math.sqrt(gradX * gradX + gradZ * gradZ);
    return Math.atan(gradient) * (180 / Math.PI);
  }

  /**
   * Check if a point is near a road segment
   */
  private isPointNearRoad(
    x: number,
    z: number,
    road: { startX: number; startZ: number; endX: number; endZ: number; width: number }
  ): boolean {
    // Point-to-line-segment distance
    const dx = road.endX - road.startX;
    const dz = road.endZ - road.startZ;
    const lengthSq = dx * dx + dz * dz;

    let t = 0;
    if (lengthSq > 0) {
      t = Math.max(0, Math.min(1, ((x - road.startX) * dx + (z - road.startZ) * dz) / lengthSq));
    }

    const nearestX = road.startX + t * dx;
    const nearestZ = road.startZ + t * dz;
    const dist = Math.sqrt((x - nearestX) ** 2 + (z - nearestZ) ** 2);

    // Road width in normalized coords (width in meters / tile size)
    const normalizedWidth = road.width / 2500 / 2;

    return dist < normalizedWidth;
  }

  /**
   * Generate edge connection data
   */
  private generateEdges(cells: NavCell[], resolution: number): TileEdge[] {
    const edges: TileEdge[] = [];
    const blockMask =
      WalkabilityFlag.BLOCKED_STRUCTURE |
      WalkabilityFlag.BLOCKED_WATER |
      WalkabilityFlag.BLOCKED_SLOPE |
      WalkabilityFlag.BLOCKED_CORRUPTION;

    // North edge (row 0)
    const northWalkable: number[] = [];
    for (let col = 0; col < resolution; col++) {
      if ((cells[col].flags & blockMask) === 0) {
        northWalkable.push(col);
      }
    }
    edges.push({ direction: 'N', walkableCells: northWalkable, connectionPoints: northWalkable });

    // South edge (last row)
    const southWalkable: number[] = [];
    const southRowStart = (resolution - 1) * resolution;
    for (let col = 0; col < resolution; col++) {
      if ((cells[southRowStart + col].flags & blockMask) === 0) {
        southWalkable.push(col);
      }
    }
    edges.push({ direction: 'S', walkableCells: southWalkable, connectionPoints: southWalkable });

    // West edge (col 0)
    const westWalkable: number[] = [];
    for (let row = 0; row < resolution; row++) {
      if ((cells[row * resolution].flags & blockMask) === 0) {
        westWalkable.push(row);
      }
    }
    edges.push({ direction: 'W', walkableCells: westWalkable, connectionPoints: westWalkable });

    // East edge (last col)
    const eastWalkable: number[] = [];
    for (let row = 0; row < resolution; row++) {
      if ((cells[row * resolution + resolution - 1].flags & blockMask) === 0) {
        eastWalkable.push(row);
      }
    }
    edges.push({ direction: 'E', walkableCells: eastWalkable, connectionPoints: eastWalkable });

    return edges;
  }

  /**
   * Compute deterministic seed from tile coordinates
   */
  private computeSeed(tile: TileAddress): number {
    return (tile.z * 73856093) ^ (tile.x * 19349663) ^ (tile.y * 83492791);
  }

  /**
   * Deserialize navmesh from storage
   */
  static deserializeNavmesh(buffer: Buffer): TileNavmesh {
    return JSON.parse(buffer.toString('utf-8'));
  }
}
