/**
 * RuinGenPipeline - Generates ruin layouts from population data.
 *
 * Takes the ruinScore/damageScore from population pipeline and places
 * appropriate structures: buildings, roads, landmarks, debris.
 *
 * Output is deterministic based on tile coordinates (seeded RNG).
 */

import { type TileAddress, tileAddressToId } from '../TileAddress';
import { tileToLatLonBounds, getTileCenter } from '../TileUtils';
import { TileBuildJobType, TileService } from '../TileService';
import { BaseTilePipeline, type PipelineResult } from './TilePipeline';
import { SettlementType, PopulationPipeline, type TilePopulationData } from './PopulationPipeline';

/**
 * Types of structures that can appear in ruins
 */
export enum StructureType {
  /** Small residential building */
  HOUSE = 'HOUSE',
  /** Apartment/larger residential */
  APARTMENT = 'APARTMENT',
  /** Commercial/office building */
  COMMERCIAL = 'COMMERCIAL',
  /** Industrial building */
  INDUSTRIAL = 'INDUSTRIAL',
  /** Tall office/residential tower */
  SKYSCRAPER = 'SKYSCRAPER',
  /** Church, monument, government */
  LANDMARK = 'LANDMARK',
  /** Gas station, convenience store */
  GAS_STATION = 'GAS_STATION',
  /** Road segment */
  ROAD = 'ROAD',
  /** Highway/major road */
  HIGHWAY = 'HIGHWAY',
  /** Bridge */
  BRIDGE = 'BRIDGE',
  /** Debris pile (collapsed structure) */
  DEBRIS = 'DEBRIS',
  /** Vehicle wreck */
  VEHICLE = 'VEHICLE',
  /** Farm building */
  FARM = 'FARM',
  /** Barn or silo */
  BARN = 'BARN',
}

/**
 * Condition of a structure
 */
export enum StructureCondition {
  /** Fully intact, safe to enter */
  INTACT = 'INTACT',
  /** Some damage but structurally sound */
  DAMAGED = 'DAMAGED',
  /** Partially collapsed, dangerous */
  PARTIAL_COLLAPSE = 'PARTIAL_COLLAPSE',
  /** Fully collapsed, just rubble */
  COLLAPSED = 'COLLAPSED',
  /** Burned out shell */
  BURNED = 'BURNED',
}

/**
 * A placed structure in the ruin layout
 */
export interface PlacedStructure {
  /** Unique ID within the tile */
  id: string;
  /** Structure type */
  type: StructureType;
  /** Condition (affects loot, danger, navigation) */
  condition: StructureCondition;
  /** Position within tile (0-1 normalized) */
  x: number;
  z: number;
  /** Rotation in degrees */
  rotation: number;
  /** Scale factor (1.0 = normal) */
  scale: number;
  /** Number of floors (for buildings) */
  floors: number;
  /** Whether this is a lootable location */
  hasLoot: boolean;
  /** Danger level (0-1) */
  dangerLevel: number;
  /** Optional name for landmarks */
  name?: string;
}

/**
 * Road/path segment
 */
export interface RoadSegment {
  /** Start point (normalized 0-1) */
  startX: number;
  startZ: number;
  /** End point (normalized 0-1) */
  endX: number;
  endZ: number;
  /** Road width in meters */
  width: number;
  /** Is this a major road */
  isMajor: boolean;
  /** Condition (affects vehicle spawns, navigation) */
  condition: StructureCondition;
}

/**
 * Complete ruin layout for a tile
 */
export interface TileRuinLayout {
  /** Tile ID */
  tileId: string;
  /** Version (incremented on regeneration) */
  version: number;
  /** Settlement type this was generated for */
  settlementType: SettlementType;
  /** All placed structures */
  structures: PlacedStructure[];
  /** Road network */
  roads: RoadSegment[];
  /** Total structure count */
  structureCount: number;
  /** Average damage level (0-1) */
  averageDamage: number;
  /** Seed used for generation */
  seed: number;
}

/**
 * Configuration for ruin generation
 */
export interface RuinGenPipelineConfig {
  /** Maximum structures per tile */
  maxStructuresPerTile: number;
  /** Minimum structures for non-wilderness */
  minStructuresForSettlement: number;
  /** Base loot chance (modified by damage) */
  baseLootChance: number;
}

const DEFAULT_CONFIG: RuinGenPipelineConfig = {
  maxStructuresPerTile: 50,
  minStructuresForSettlement: 3,
  baseLootChance: 0.3,
};

/**
 * Structure weights by settlement type
 */
const STRUCTURE_WEIGHTS: Record<SettlementType, Partial<Record<StructureType, number>>> = {
  [SettlementType.WILDERNESS]: {},
  [SettlementType.RURAL]: {
    [StructureType.FARM]: 3,
    [StructureType.BARN]: 2,
    [StructureType.HOUSE]: 1,
  },
  [SettlementType.VILLAGE]: {
    [StructureType.HOUSE]: 5,
    [StructureType.COMMERCIAL]: 1,
    [StructureType.GAS_STATION]: 1,
    [StructureType.LANDMARK]: 0.5,
  },
  [SettlementType.SUBURBAN]: {
    [StructureType.HOUSE]: 8,
    [StructureType.APARTMENT]: 2,
    [StructureType.COMMERCIAL]: 2,
    [StructureType.GAS_STATION]: 1,
  },
  [SettlementType.URBAN]: {
    [StructureType.APARTMENT]: 5,
    [StructureType.COMMERCIAL]: 4,
    [StructureType.HOUSE]: 2,
    [StructureType.INDUSTRIAL]: 1,
    [StructureType.LANDMARK]: 0.5,
  },
  [SettlementType.URBAN_CORE]: {
    [StructureType.COMMERCIAL]: 6,
    [StructureType.APARTMENT]: 4,
    [StructureType.SKYSCRAPER]: 2,
    [StructureType.LANDMARK]: 1,
  },
  [SettlementType.METROPOLIS]: {
    [StructureType.SKYSCRAPER]: 5,
    [StructureType.COMMERCIAL]: 4,
    [StructureType.APARTMENT]: 3,
    [StructureType.LANDMARK]: 1,
  },
};

/**
 * RuinGenPipeline - Generates ruin layouts
 */
export class RuinGenPipeline extends BaseTilePipeline {
  jobType = TileBuildJobType.RUIN_GEN;
  name = 'RuinGenPipeline';

  private config: RuinGenPipelineConfig;

  constructor(config: Partial<RuinGenPipelineConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async process(tile: TileAddress, _inputHash?: string): Promise<PipelineResult> {
    this.log(tile, 'Generating ruin layout');

    try {
      // Get population data from tile record
      const tileId = tileAddressToId(tile);
      const tileRecord = await TileService.getTile(tileId);

      // If no population data, generate minimal layout
      let populationData: TilePopulationData | null = null;
      if (tileRecord?.populationHash) {
        const buffer = await this.storage.get(tileRecord.populationHash);
        if (buffer) {
          populationData = PopulationPipeline.deserializePopulationData(buffer);
        }
      }

      // Generate layout
      const layout = this.generateLayout(tile, populationData);

      // Serialize and store
      const buffer = Buffer.from(JSON.stringify(layout), 'utf-8');
      const hash = await this.storage.put(buffer);

      this.log(
        tile,
        `Generated ${layout.structureCount} structures, ${layout.roads.length} roads ` +
          `(${layout.settlementType}, damage=${layout.averageDamage.toFixed(2)})`
      );

      return this.success(hash, {
        structureCount: layout.structureCount,
        settlementType: layout.settlementType,
        averageDamage: layout.averageDamage,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(tile, `Failed: ${message}`);
      return this.failure(message);
    }
  }

  /**
   * Generate ruin layout for a tile
   */
  private generateLayout(
    tile: TileAddress,
    populationData: TilePopulationData | null
  ): TileRuinLayout {
    const tileId = tileAddressToId(tile);
    const seed = this.computeSeed(tile);
    const rng = this.createRNG(seed);

    const settlementType = populationData?.settlementType ?? SettlementType.WILDERNESS;
    const ruinScore = populationData?.ruinScore ?? 0;
    const damageScore = populationData?.damageScore ?? 0;

    const structures: PlacedStructure[] = [];
    const roads: RoadSegment[] = [];

    // Calculate structure count based on ruin score
    const targetCount = Math.floor(
      ruinScore * this.config.maxStructuresPerTile
    );

    if (targetCount > 0 && settlementType !== SettlementType.WILDERNESS) {
      // Generate road network first
      this.generateRoads(roads, settlementType, damageScore, rng);

      // Generate structures
      const weights = STRUCTURE_WEIGHTS[settlementType];
      for (let i = 0; i < targetCount; i++) {
        const structure = this.generateStructure(
          i,
          weights,
          damageScore,
          roads,
          rng
        );
        if (structure) {
          structures.push(structure);
        }
      }
    }

    // Calculate average damage
    let totalDamage = 0;
    for (const s of structures) {
      totalDamage += this.conditionToDamage(s.condition);
    }
    const averageDamage = structures.length > 0 ? totalDamage / structures.length : 0;

    return {
      tileId,
      version: 1,
      settlementType,
      structures,
      roads,
      structureCount: structures.length,
      averageDamage,
      seed,
    };
  }

  /**
   * Generate road network
   */
  private generateRoads(
    roads: RoadSegment[],
    settlementType: SettlementType,
    damageScore: number,
    rng: () => number
  ): void {
    // Number of roads based on settlement type
    const roadCounts: Record<SettlementType, number> = {
      [SettlementType.WILDERNESS]: 0,
      [SettlementType.RURAL]: 1,
      [SettlementType.VILLAGE]: 2,
      [SettlementType.SUBURBAN]: 4,
      [SettlementType.URBAN]: 6,
      [SettlementType.URBAN_CORE]: 8,
      [SettlementType.METROPOLIS]: 10,
    };

    const count = roadCounts[settlementType];

    // Generate grid-ish roads
    for (let i = 0; i < count; i++) {
      const isVertical = i % 2 === 0;
      const offset = (i + 1) / (count + 1);

      const condition = this.rollCondition(damageScore * 0.5, rng); // Roads less damaged
      const isMajor = i < 2;

      if (isVertical) {
        roads.push({
          startX: offset,
          startZ: 0,
          endX: offset + (rng() - 0.5) * 0.1,
          endZ: 1,
          width: isMajor ? 12 : 6,
          isMajor,
          condition,
        });
      } else {
        roads.push({
          startX: 0,
          startZ: offset,
          endX: 1,
          endZ: offset + (rng() - 0.5) * 0.1,
          width: isMajor ? 12 : 6,
          isMajor,
          condition,
        });
      }
    }
  }

  /**
   * Generate a single structure
   */
  private generateStructure(
    index: number,
    weights: Partial<Record<StructureType, number>>,
    damageScore: number,
    roads: RoadSegment[],
    rng: () => number
  ): PlacedStructure | null {
    const type = this.weightedChoice(weights, rng);
    if (!type) return null;

    const condition = this.rollCondition(damageScore, rng);

    // Position near roads if possible
    let x = rng();
    let z = rng();

    if (roads.length > 0 && rng() > 0.3) {
      const road = roads[Math.floor(rng() * roads.length)];
      // Place near road
      const t = rng();
      x = road.startX + (road.endX - road.startX) * t + (rng() - 0.5) * 0.15;
      z = road.startZ + (road.endZ - road.startZ) * t + (rng() - 0.5) * 0.15;
      x = Math.max(0, Math.min(1, x));
      z = Math.max(0, Math.min(1, z));
    }

    const floors = this.getFloorCount(type, rng);
    const hasLoot = rng() < this.config.baseLootChance * (1 - damageScore * 0.5);
    const dangerLevel = damageScore * (0.5 + rng() * 0.5);

    return {
      id: `struct_${index}`,
      type,
      condition,
      x,
      z,
      rotation: Math.floor(rng() * 4) * 90,
      scale: 0.8 + rng() * 0.4,
      floors,
      hasLoot,
      dangerLevel,
    };
  }

  /**
   * Get floor count for a structure type
   */
  private getFloorCount(type: StructureType, rng: () => number): number {
    switch (type) {
      case StructureType.HOUSE:
      case StructureType.FARM:
      case StructureType.BARN:
      case StructureType.GAS_STATION:
        return 1 + Math.floor(rng() * 2);
      case StructureType.APARTMENT:
      case StructureType.COMMERCIAL:
        return 2 + Math.floor(rng() * 4);
      case StructureType.INDUSTRIAL:
        return 1 + Math.floor(rng() * 3);
      case StructureType.SKYSCRAPER:
        return 10 + Math.floor(rng() * 30);
      case StructureType.LANDMARK:
        return 1 + Math.floor(rng() * 5);
      default:
        return 1;
    }
  }

  /**
   * Roll condition based on damage score
   */
  private rollCondition(damageScore: number, rng: () => number): StructureCondition {
    const roll = rng();
    const threshold = damageScore;

    if (roll < threshold * 0.3) return StructureCondition.COLLAPSED;
    if (roll < threshold * 0.6) return StructureCondition.PARTIAL_COLLAPSE;
    if (roll < threshold * 0.8) return StructureCondition.BURNED;
    if (roll < threshold) return StructureCondition.DAMAGED;
    return StructureCondition.INTACT;
  }

  /**
   * Convert condition to damage value (0-1)
   */
  private conditionToDamage(condition: StructureCondition): number {
    switch (condition) {
      case StructureCondition.INTACT:
        return 0;
      case StructureCondition.DAMAGED:
        return 0.25;
      case StructureCondition.BURNED:
        return 0.5;
      case StructureCondition.PARTIAL_COLLAPSE:
        return 0.75;
      case StructureCondition.COLLAPSED:
        return 1;
    }
  }

  /**
   * Weighted random choice
   */
  private weightedChoice<T extends string>(
    weights: Partial<Record<T, number>>,
    rng: () => number
  ): T | null {
    const entries = Object.entries(weights) as [T, number][];
    if (entries.length === 0) return null;

    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = rng() * total;

    for (const [type, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return type;
    }

    return entries[0][0];
  }

  /**
   * Compute deterministic seed from tile coordinates
   */
  private computeSeed(tile: TileAddress): number {
    // Simple hash of coordinates
    return (tile.z * 73856093) ^ (tile.x * 19349663) ^ (tile.y * 83492791);
  }

  /**
   * Create a seeded RNG function
   */
  private createRNG(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  /**
   * Deserialize ruin layout from storage
   */
  static deserializeRuinLayout(buffer: Buffer): TileRuinLayout {
    return JSON.parse(buffer.toString('utf-8'));
  }
}
