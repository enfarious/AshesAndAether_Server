/**
 * POIPipeline - Generates Points of Interest for tiles.
 *
 * Places dungeon entrances, cave mouths, special locations, and landmarks
 * based on terrain, biome, and settlement type.
 *
 * Output is deterministic based on tile coordinates.
 */

import { type TileAddress, tileAddressToId } from '../TileAddress';
import { TileBuildJobType, TileService } from '../TileService';
import { BaseTilePipeline, type PipelineResult } from './TilePipeline';
import { BiomeType, BiomePipeline, type TileBiomeData } from './BiomePipeline';
import { SettlementType, PopulationPipeline, type TilePopulationData } from './PopulationPipeline';
import { ElevationPipeline, type TileElevationData } from './ElevationPipeline';

/**
 * Types of POIs
 */
export enum POIType {
  /** Natural cave entrance */
  CAVE_ENTRANCE = 'CAVE_ENTRANCE',
  /** Mine entrance */
  MINE_ENTRANCE = 'MINE_ENTRANCE',
  /** Bunker/shelter entrance */
  BUNKER_ENTRANCE = 'BUNKER_ENTRANCE',
  /** Subway/metro entrance */
  SUBWAY_ENTRANCE = 'SUBWAY_ENTRANCE',
  /** Sewer entrance */
  SEWER_ENTRANCE = 'SEWER_ENTRANCE',
  /** Building basement */
  BASEMENT_ENTRANCE = 'BASEMENT_ENTRANCE',
  /** Ancient ruins entrance */
  ANCIENT_RUINS = 'ANCIENT_RUINS',
  /** Corrupted rift */
  CORRUPTION_RIFT = 'CORRUPTION_RIFT',
  /** Safe house / shelter */
  SAFE_HOUSE = 'SAFE_HOUSE',
  /** Trader camp */
  TRADER_CAMP = 'TRADER_CAMP',
  /** Water source */
  WATER_SOURCE = 'WATER_SOURCE',
  /** Viewpoint / lookout */
  VIEWPOINT = 'VIEWPOINT',
  /** Crashed vehicle */
  CRASH_SITE = 'CRASH_SITE',
  /** Military checkpoint */
  CHECKPOINT = 'CHECKPOINT',
  /** Radio tower */
  RADIO_TOWER = 'RADIO_TOWER',
}

/**
 * POI difficulty/tier
 */
export enum POITier {
  /** Easy, for beginners */
  TIER_1 = 'TIER_1',
  /** Moderate challenge */
  TIER_2 = 'TIER_2',
  /** Difficult */
  TIER_3 = 'TIER_3',
  /** Very dangerous */
  TIER_4 = 'TIER_4',
  /** Endgame content */
  TIER_5 = 'TIER_5',
}

/**
 * A point of interest
 */
export interface PointOfInterest {
  /** Unique ID within the tile */
  id: string;
  /** POI type */
  type: POIType;
  /** Display name */
  name: string;
  /** Difficulty tier */
  tier: POITier;
  /** Position within tile (0-1 normalized) */
  x: number;
  z: number;
  /** Radius of the POI area in meters */
  radius: number;
  /** Whether this leads to an instanced dungeon */
  isInstance: boolean;
  /** Instance ID if applicable */
  instanceId?: string;
  /** Recommended level range */
  minLevel: number;
  maxLevel: number;
  /** Required corruption level to access (0 = none) */
  corruptionRequired: number;
  /** Whether this POI is currently active */
  isActive: boolean;
  /** Respawn timer if applicable (seconds) */
  respawnTime?: number;
  /** Special flags */
  flags: string[];
  /** Associated quest IDs */
  questIds: string[];
}

/**
 * Complete POI layout for a tile
 */
export interface TilePOILayout {
  /** Tile ID */
  tileId: string;
  /** Version (incremented on regeneration) */
  version: number;
  /** All POIs in this tile */
  pois: PointOfInterest[];
  /** Count by type */
  countByType: Record<POIType, number>;
  /** Whether tile has dungeon entrance */
  hasDungeon: boolean;
  /** Whether tile has safe zone */
  hasSafeZone: boolean;
  /** Seed used for generation */
  seed: number;
}

/**
 * Configuration for POI generation
 */
export interface POIPipelineConfig {
  /** Maximum POIs per tile */
  maxPOIsPerTile: number;
  /** Base chance for dungeon entrance (per tile) */
  dungeonChance: number;
  /** Chance for corruption rift in corrupted areas */
  corruptionRiftChance: number;
}

const DEFAULT_CONFIG: POIPipelineConfig = {
  maxPOIsPerTile: 10,
  dungeonChance: 0.1,
  corruptionRiftChance: 0.3,
};

/**
 * POI weights by biome
 */
const BIOME_POI_WEIGHTS: Record<BiomeType, Partial<Record<POIType, number>>> = {
  [BiomeType.FOREST]: {
    [POIType.CAVE_ENTRANCE]: 3,
    [POIType.WATER_SOURCE]: 4,
    [POIType.ANCIENT_RUINS]: 1,
    [POIType.SAFE_HOUSE]: 1,
  },
  [BiomeType.GRASSLAND]: {
    [POIType.WATER_SOURCE]: 3,
    [POIType.VIEWPOINT]: 2,
    [POIType.TRADER_CAMP]: 2,
  },
  [BiomeType.SCRUB]: {
    [POIType.CAVE_ENTRANCE]: 2,
    [POIType.WATER_SOURCE]: 2,
    [POIType.CRASH_SITE]: 1,
  },
  [BiomeType.MARSH]: {
    [POIType.WATER_SOURCE]: 5,
    [POIType.ANCIENT_RUINS]: 2,
  },
  [BiomeType.DESERT]: {
    [POIType.CAVE_ENTRANCE]: 2,
    [POIType.ANCIENT_RUINS]: 2,
    [POIType.WATER_SOURCE]: 1,
  },
  [BiomeType.ROCKY]: {
    [POIType.CAVE_ENTRANCE]: 5,
    [POIType.MINE_ENTRANCE]: 3,
    [POIType.VIEWPOINT]: 2,
  },
  [BiomeType.TUNDRA]: {
    [POIType.CAVE_ENTRANCE]: 3,
    [POIType.BUNKER_ENTRANCE]: 2,
    [POIType.CRASH_SITE]: 1,
  },
  [BiomeType.RUINS]: {
    [POIType.BUNKER_ENTRANCE]: 4,
    [POIType.SUBWAY_ENTRANCE]: 3,
    [POIType.SEWER_ENTRANCE]: 3,
    [POIType.BASEMENT_ENTRANCE]: 4,
    [POIType.SAFE_HOUSE]: 2,
    [POIType.CHECKPOINT]: 2,
    [POIType.RADIO_TOWER]: 1,
    [POIType.CRASH_SITE]: 2,
  },
  [BiomeType.WATER]: {},
  [BiomeType.COASTAL]: {
    [POIType.CAVE_ENTRANCE]: 2,
    [POIType.CRASH_SITE]: 2,
    [POIType.SAFE_HOUSE]: 1,
  },
  [BiomeType.FARMLAND]: {
    [POIType.BASEMENT_ENTRANCE]: 2,
    [POIType.WATER_SOURCE]: 3,
    [POIType.SAFE_HOUSE]: 2,
  },
};

/**
 * Settlement POI modifiers
 */
const SETTLEMENT_POI_WEIGHTS: Partial<Record<SettlementType, Partial<Record<POIType, number>>>> = {
  [SettlementType.URBAN]: {
    [POIType.SUBWAY_ENTRANCE]: 3,
    [POIType.SEWER_ENTRANCE]: 3,
    [POIType.BASEMENT_ENTRANCE]: 4,
    [POIType.CHECKPOINT]: 2,
  },
  [SettlementType.URBAN_CORE]: {
    [POIType.SUBWAY_ENTRANCE]: 5,
    [POIType.BUNKER_ENTRANCE]: 3,
    [POIType.CHECKPOINT]: 3,
    [POIType.RADIO_TOWER]: 2,
  },
  [SettlementType.METROPOLIS]: {
    [POIType.SUBWAY_ENTRANCE]: 6,
    [POIType.BUNKER_ENTRANCE]: 4,
    [POIType.CHECKPOINT]: 4,
    [POIType.RADIO_TOWER]: 3,
  },
};

/**
 * POIPipeline - Generates POI layouts
 */
export class POIPipeline extends BaseTilePipeline {
  jobType = TileBuildJobType.POI_PLACEMENT;
  name = 'POIPipeline';

  private config: POIPipelineConfig;

  constructor(config: Partial<POIPipelineConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async process(tile: TileAddress, _inputHash?: string): Promise<PipelineResult> {
    this.log(tile, 'Generating POI layout');

    try {
      const tileId = tileAddressToId(tile);
      const tileRecord = await TileService.getTile(tileId);

      // Load truth layer data
      let biomeData: TileBiomeData | null = null;
      let populationData: TilePopulationData | null = null;
      let elevationData: TileElevationData | null = null;

      if (tileRecord?.biomeHash) {
        const buffer = await this.storage.get(tileRecord.biomeHash);
        if (buffer) biomeData = BiomePipeline.deserializeBiomeData(buffer);
      }

      if (tileRecord?.populationHash) {
        const buffer = await this.storage.get(tileRecord.populationHash);
        if (buffer) populationData = PopulationPipeline.deserializePopulationData(buffer);
      }

      if (tileRecord?.elevationHash) {
        const buffer = await this.storage.get(tileRecord.elevationHash);
        if (buffer) elevationData = ElevationPipeline.deserializeElevationData(buffer);
      }

      // Generate POI layout
      const layout = this.generatePOILayout(tile, biomeData, populationData, elevationData);

      // Serialize and store
      const buffer = Buffer.from(JSON.stringify(layout), 'utf-8');
      const hash = await this.storage.put(buffer);

      this.log(
        tile,
        `Generated ${layout.pois.length} POIs ` +
          `(dungeon=${layout.hasDungeon}, safe=${layout.hasSafeZone})`
      );

      return this.success(hash, {
        poiCount: layout.pois.length,
        hasDungeon: layout.hasDungeon,
        hasSafeZone: layout.hasSafeZone,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(tile, `Failed: ${message}`);
      return this.failure(message);
    }
  }

  /**
   * Generate POI layout for a tile
   */
  private generatePOILayout(
    tile: TileAddress,
    biomeData: TileBiomeData | null,
    populationData: TilePopulationData | null,
    elevationData: TileElevationData | null
  ): TilePOILayout {
    const tileId = tileAddressToId(tile);
    const seed = this.computeSeed(tile);
    const rng = this.createRNG(seed);

    const biome = biomeData?.dominantBiome ?? BiomeType.GRASSLAND;
    const settlementType = populationData?.settlementType ?? SettlementType.WILDERNESS;
    const corruptionLevel = populationData?.corruptionScore ?? 0;
    const meanElevation = elevationData?.meanElevation ?? 100;

    const pois: PointOfInterest[] = [];
    const countByType: Record<POIType, number> = {} as Record<POIType, number>;
    for (const type of Object.values(POIType)) {
      countByType[type] = 0;
    }

    // Merge biome and settlement weights
    const weights = { ...BIOME_POI_WEIGHTS[biome] };
    const settlementWeights = SETTLEMENT_POI_WEIGHTS[settlementType];
    if (settlementWeights) {
      for (const [type, weight] of Object.entries(settlementWeights)) {
        weights[type as POIType] = (weights[type as POIType] ?? 0) + weight;
      }
    }

    // Calculate how many POIs to generate
    const ruinScore = populationData?.ruinScore ?? 0;
    const poiCount = Math.min(
      this.config.maxPOIsPerTile,
      Math.floor(2 + ruinScore * 8 + rng() * 3)
    );

    // Generate POIs
    for (let i = 0; i < poiCount; i++) {
      const poi = this.generatePOI(
        i,
        weights,
        biome,
        settlementType,
        corruptionLevel,
        meanElevation,
        rng
      );
      if (poi) {
        pois.push(poi);
        countByType[poi.type]++;
      }
    }

    // Add corruption rift if highly corrupted
    if (corruptionLevel > 0.7 && rng() < this.config.corruptionRiftChance) {
      const rift = this.generateCorruptionRift(pois.length, corruptionLevel, rng);
      pois.push(rift);
      countByType[POIType.CORRUPTION_RIFT]++;
    }

    // Determine flags
    const hasDungeon = pois.some(p => p.isInstance);
    const hasSafeZone = pois.some(p =>
      p.type === POIType.SAFE_HOUSE ||
      p.type === POIType.TRADER_CAMP
    );

    return {
      tileId,
      version: 1,
      pois,
      countByType,
      hasDungeon,
      hasSafeZone,
      seed,
    };
  }

  /**
   * Generate a single POI
   */
  private generatePOI(
    index: number,
    weights: Partial<Record<POIType, number>>,
    biome: BiomeType,
    _settlementType: SettlementType,
    corruptionLevel: number,
    _meanElevation: number,
    rng: () => number
  ): PointOfInterest | null {
    const type = this.weightedChoice(weights, rng);
    if (!type) return null;

    const tier = this.determineTier(type, corruptionLevel, rng);
    const isInstance = this.isInstancePOI(type, tier, rng);

    // Position
    const x = 0.1 + rng() * 0.8;
    const z = 0.1 + rng() * 0.8;

    // Level range based on tier
    const levelRanges: Record<POITier, [number, number]> = {
      [POITier.TIER_1]: [1, 10],
      [POITier.TIER_2]: [8, 18],
      [POITier.TIER_3]: [15, 25],
      [POITier.TIER_4]: [22, 35],
      [POITier.TIER_5]: [30, 50],
    };
    const [minLevel, maxLevel] = levelRanges[tier];

    return {
      id: `poi_${index}`,
      type,
      name: this.generatePOIName(type, biome, rng),
      tier,
      x,
      z,
      radius: this.getPOIRadius(type),
      isInstance,
      instanceId: isInstance ? `inst_${type}_${index}` : undefined,
      minLevel,
      maxLevel,
      corruptionRequired: type === POIType.CORRUPTION_RIFT ? 0.5 : 0,
      isActive: true,
      respawnTime: isInstance ? 3600 : undefined,
      flags: this.getPOIFlags(type, tier),
      questIds: [],
    };
  }

  /**
   * Generate a corruption rift
   */
  private generateCorruptionRift(index: number, corruptionLevel: number, rng: () => number): PointOfInterest {
    const tier = corruptionLevel > 0.9 ? POITier.TIER_5 :
      corruptionLevel > 0.8 ? POITier.TIER_4 : POITier.TIER_3;

    return {
      id: `poi_${index}`,
      type: POIType.CORRUPTION_RIFT,
      name: 'Corruption Rift',
      tier,
      x: 0.3 + rng() * 0.4,
      z: 0.3 + rng() * 0.4,
      radius: 30,
      isInstance: true,
      instanceId: `rift_${index}`,
      minLevel: 25,
      maxLevel: 50,
      corruptionRequired: 0.5,
      isActive: true,
      respawnTime: 7200,
      flags: ['corrupted', 'boss_area', 'high_danger'],
      questIds: [],
    };
  }

  /**
   * Determine POI tier based on type and corruption
   */
  private determineTier(type: POIType, corruptionLevel: number, rng: () => number): POITier {
    let baseTier = 1;

    // Some types are inherently more dangerous
    if (type === POIType.BUNKER_ENTRANCE || type === POIType.ANCIENT_RUINS) {
      baseTier = 2;
    }
    if (type === POIType.CORRUPTION_RIFT) {
      baseTier = 3;
    }

    // Corruption increases tier
    baseTier += Math.floor(corruptionLevel * 2);

    // Random variance
    baseTier += rng() < 0.2 ? 1 : 0;
    baseTier -= rng() < 0.1 ? 1 : 0;

    baseTier = Math.max(1, Math.min(5, baseTier));

    return `TIER_${baseTier}` as POITier;
  }

  /**
   * Check if POI should be an instance entrance
   */
  private isInstancePOI(type: POIType, tier: POITier, rng: () => number): boolean {
    const instanceTypes = [
      POIType.CAVE_ENTRANCE,
      POIType.MINE_ENTRANCE,
      POIType.BUNKER_ENTRANCE,
      POIType.SUBWAY_ENTRANCE,
      POIType.ANCIENT_RUINS,
      POIType.CORRUPTION_RIFT,
    ];

    if (!instanceTypes.includes(type)) return false;

    // Higher tiers more likely to be instances
    const tierNum = parseInt(tier.replace('TIER_', ''));
    return rng() < 0.3 + tierNum * 0.1;
  }

  /**
   * Generate a name for the POI
   */
  private generatePOIName(type: POIType, _biome: BiomeType, rng: () => number): string {
    const prefixes = ['Old', 'Abandoned', 'Hidden', 'Dark', 'Lost', 'Forgotten'];
    const prefix = prefixes[Math.floor(rng() * prefixes.length)];

    const names: Partial<Record<POIType, string[]>> = {
      [POIType.CAVE_ENTRANCE]: ['Cave', 'Cavern', 'Grotto'],
      [POIType.MINE_ENTRANCE]: ['Mine', 'Mining Shaft', 'Quarry'],
      [POIType.BUNKER_ENTRANCE]: ['Bunker', 'Shelter', 'Vault'],
      [POIType.SUBWAY_ENTRANCE]: ['Metro Station', 'Subway', 'Underground'],
      [POIType.SAFE_HOUSE]: ['Hideout', 'Safe House', 'Refuge'],
      [POIType.WATER_SOURCE]: ['Spring', 'Well', 'Stream'],
    };

    const typeNames = names[type] ?? [type.replace('_', ' ')];
    const baseName = typeNames[Math.floor(rng() * typeNames.length)];

    return `${prefix} ${baseName}`;
  }

  /**
   * Get radius for POI type
   */
  private getPOIRadius(type: POIType): number {
    const radii: Partial<Record<POIType, number>> = {
      [POIType.CAVE_ENTRANCE]: 10,
      [POIType.MINE_ENTRANCE]: 15,
      [POIType.BUNKER_ENTRANCE]: 20,
      [POIType.SUBWAY_ENTRANCE]: 15,
      [POIType.CORRUPTION_RIFT]: 30,
      [POIType.SAFE_HOUSE]: 25,
      [POIType.TRADER_CAMP]: 30,
      [POIType.CHECKPOINT]: 40,
    };
    return radii[type] ?? 15;
  }

  /**
   * Get flags for POI
   */
  private getPOIFlags(type: POIType, tier: POITier): string[] {
    const flags: string[] = [];

    if (type === POIType.SAFE_HOUSE || type === POIType.TRADER_CAMP) {
      flags.push('safe_zone', 'no_combat');
    }
    if (type === POIType.CORRUPTION_RIFT) {
      flags.push('corrupted', 'boss_area');
    }
    if (tier === POITier.TIER_4 || tier === POITier.TIER_5) {
      flags.push('high_danger');
    }
    if (type === POIType.WATER_SOURCE) {
      flags.push('water', 'gatherable');
    }

    return flags;
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
   * Compute deterministic seed
   */
  private computeSeed(tile: TileAddress): number {
    return (tile.z * 73856093) ^ (tile.x * 19349669) ^ (tile.y * 83492797);
  }

  /**
   * Create seeded RNG
   */
  private createRNG(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  /**
   * Deserialize POI layout from storage
   */
  static deserializePOILayout(buffer: Buffer): TilePOILayout {
    return JSON.parse(buffer.toString('utf-8'));
  }
}
