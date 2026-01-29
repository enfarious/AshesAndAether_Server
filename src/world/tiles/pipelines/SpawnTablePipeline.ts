/**
 * SpawnTablePipeline - Generates spawn tables for tiles.
 *
 * Determines what creatures, resources, and items can spawn in a tile
 * based on biome, corruption level, and settlement type.
 *
 * Output is used by the wildlife/mob spawning systems at runtime.
 */

import { type TileAddress, tileAddressToId } from '../TileAddress';
import { TileBuildJobType, TileService } from '../TileService';
import { BaseTilePipeline, type PipelineResult } from './TilePipeline';
import { BiomeType, BiomePipeline, type TileBiomeData } from './BiomePipeline';
import { SettlementType, PopulationPipeline, type TilePopulationData } from './PopulationPipeline';

/**
 * Spawn entry type
 */
export enum SpawnEntryType {
  /** Wildlife (deer, wolves, etc.) */
  WILDLIFE = 'WILDLIFE',
  /** Hostile creatures */
  HOSTILE = 'HOSTILE',
  /** Corrupted creatures */
  CORRUPTED = 'CORRUPTED',
  /** Gatherable resource node */
  RESOURCE = 'RESOURCE',
  /** Loot container */
  LOOT = 'LOOT',
  /** NPC (survivor, trader, etc.) */
  NPC = 'NPC',
}

/**
 * A spawn table entry
 */
export interface SpawnEntry {
  /** Entry type */
  type: SpawnEntryType;
  /** Specific spawn ID (e.g., "wolf", "deer", "oak_tree") */
  spawnId: string;
  /** Display name for debugging */
  name: string;
  /** Weight for spawn selection */
  weight: number;
  /** Minimum count per spawn event */
  minCount: number;
  /** Maximum count per spawn event */
  maxCount: number;
  /** Level range for scaling */
  minLevel: number;
  maxLevel: number;
  /** Time restrictions (empty = any time) */
  timeRestrictions: ('day' | 'night' | 'dawn' | 'dusk')[];
  /** Weather restrictions (empty = any weather) */
  weatherRestrictions: string[];
  /** Required corruption level (0 = no requirement) */
  minCorruption: number;
  /** Maximum corruption level (1 = no cap) */
  maxCorruption: number;
}

/**
 * Spawn group (used for pack spawns)
 */
export interface SpawnGroup {
  /** Group ID */
  id: string;
  /** Display name */
  name: string;
  /** Entries in this group */
  entries: SpawnEntry[];
  /** Total weight of this group */
  totalWeight: number;
  /** Respawn cooldown in seconds */
  respawnCooldown: number;
  /** Max active spawns from this group */
  maxActive: number;
}

/**
 * Complete spawn table for a tile
 */
export interface TileSpawnTable {
  /** Tile ID */
  tileId: string;
  /** Version (incremented on regeneration) */
  version: number;
  /** Biome this was generated for */
  biome: BiomeType;
  /** Settlement type */
  settlementType: SettlementType;
  /** Corruption level (0-1) */
  corruptionLevel: number;
  /** Wildlife spawn group */
  wildlife: SpawnGroup;
  /** Hostile spawn group */
  hostiles: SpawnGroup;
  /** Resource spawn group */
  resources: SpawnGroup;
  /** Loot spawn group */
  loot: SpawnGroup;
  /** Special spawns (bosses, rare creatures) */
  special: SpawnEntry[];
  /** Total spawn capacity (max simultaneous spawns) */
  spawnCapacity: number;
  /** Spawn rate modifier (1.0 = normal) */
  spawnRateModifier: number;
}

/**
 * Configuration for spawn table generation
 */
export interface SpawnTablePipelineConfig {
  /** Base spawn capacity per tile */
  baseSpawnCapacity: number;
  /** Corruption threshold for corrupted spawns */
  corruptionSpawnThreshold: number;
}

const DEFAULT_CONFIG: SpawnTablePipelineConfig = {
  baseSpawnCapacity: 20,
  corruptionSpawnThreshold: 0.3,
};

/**
 * Wildlife spawns by biome
 */
const BIOME_WILDLIFE: Record<BiomeType, Array<{ id: string; name: string; weight: number }>> = {
  [BiomeType.FOREST]: [
    { id: 'deer', name: 'Deer', weight: 10 },
    { id: 'rabbit', name: 'Rabbit', weight: 8 },
    { id: 'wolf', name: 'Wolf', weight: 3 },
    { id: 'bear', name: 'Bear', weight: 1 },
    { id: 'boar', name: 'Wild Boar', weight: 4 },
  ],
  [BiomeType.GRASSLAND]: [
    { id: 'deer', name: 'Deer', weight: 8 },
    { id: 'rabbit', name: 'Rabbit', weight: 10 },
    { id: 'coyote', name: 'Coyote', weight: 4 },
    { id: 'snake', name: 'Snake', weight: 3 },
  ],
  [BiomeType.SCRUB]: [
    { id: 'rabbit', name: 'Rabbit', weight: 6 },
    { id: 'coyote', name: 'Coyote', weight: 5 },
    { id: 'snake', name: 'Snake', weight: 5 },
    { id: 'lizard', name: 'Lizard', weight: 4 },
  ],
  [BiomeType.MARSH]: [
    { id: 'frog', name: 'Frog', weight: 8 },
    { id: 'snake', name: 'Water Snake', weight: 6 },
    { id: 'alligator', name: 'Alligator', weight: 2 },
    { id: 'heron', name: 'Heron', weight: 4 },
  ],
  [BiomeType.DESERT]: [
    { id: 'snake', name: 'Rattlesnake', weight: 6 },
    { id: 'scorpion', name: 'Scorpion', weight: 5 },
    { id: 'lizard', name: 'Desert Lizard', weight: 7 },
    { id: 'vulture', name: 'Vulture', weight: 3 },
  ],
  [BiomeType.ROCKY]: [
    { id: 'goat', name: 'Mountain Goat', weight: 6 },
    { id: 'eagle', name: 'Eagle', weight: 3 },
    { id: 'snake', name: 'Rock Viper', weight: 4 },
  ],
  [BiomeType.TUNDRA]: [
    { id: 'caribou', name: 'Caribou', weight: 8 },
    { id: 'arctic_fox', name: 'Arctic Fox', weight: 5 },
    { id: 'wolf', name: 'Arctic Wolf', weight: 3 },
    { id: 'polar_bear', name: 'Polar Bear', weight: 1 },
  ],
  [BiomeType.RUINS]: [
    { id: 'rat', name: 'Rat', weight: 10 },
    { id: 'crow', name: 'Crow', weight: 6 },
    { id: 'feral_dog', name: 'Feral Dog', weight: 4 },
    { id: 'feral_cat', name: 'Feral Cat', weight: 3 },
  ],
  [BiomeType.WATER]: [],
  [BiomeType.COASTAL]: [
    { id: 'crab', name: 'Crab', weight: 6 },
    { id: 'seagull', name: 'Seagull', weight: 8 },
    { id: 'seal', name: 'Seal', weight: 3 },
  ],
  [BiomeType.FARMLAND]: [
    { id: 'rabbit', name: 'Rabbit', weight: 8 },
    { id: 'crow', name: 'Crow', weight: 6 },
    { id: 'rat', name: 'Rat', weight: 5 },
    { id: 'deer', name: 'Deer', weight: 3 },
  ],
};

/**
 * Resources by biome
 */
const BIOME_RESOURCES: Record<BiomeType, Array<{ id: string; name: string; weight: number }>> = {
  [BiomeType.FOREST]: [
    { id: 'oak_tree', name: 'Oak Tree', weight: 10 },
    { id: 'pine_tree', name: 'Pine Tree', weight: 8 },
    { id: 'berry_bush', name: 'Berry Bush', weight: 5 },
    { id: 'mushroom', name: 'Mushroom', weight: 4 },
    { id: 'herb_common', name: 'Common Herb', weight: 6 },
  ],
  [BiomeType.GRASSLAND]: [
    { id: 'herb_common', name: 'Common Herb', weight: 8 },
    { id: 'wildflower', name: 'Wildflower', weight: 6 },
    { id: 'flint_node', name: 'Flint Node', weight: 3 },
  ],
  [BiomeType.SCRUB]: [
    { id: 'scrub_wood', name: 'Scrub Wood', weight: 6 },
    { id: 'herb_desert', name: 'Desert Herb', weight: 4 },
    { id: 'flint_node', name: 'Flint Node', weight: 5 },
  ],
  [BiomeType.MARSH]: [
    { id: 'reed', name: 'Reed', weight: 10 },
    { id: 'clay_deposit', name: 'Clay Deposit', weight: 6 },
    { id: 'herb_marsh', name: 'Marsh Herb', weight: 5 },
    { id: 'peat', name: 'Peat', weight: 4 },
  ],
  [BiomeType.DESERT]: [
    { id: 'cactus', name: 'Cactus', weight: 6 },
    { id: 'sand_crystal', name: 'Sand Crystal', weight: 2 },
    { id: 'herb_desert', name: 'Desert Herb', weight: 3 },
  ],
  [BiomeType.ROCKY]: [
    { id: 'iron_ore', name: 'Iron Ore', weight: 5 },
    { id: 'stone_node', name: 'Stone Node', weight: 8 },
    { id: 'copper_ore', name: 'Copper Ore', weight: 3 },
    { id: 'crystal_node', name: 'Crystal Node', weight: 1 },
  ],
  [BiomeType.TUNDRA]: [
    { id: 'ice_crystal', name: 'Ice Crystal', weight: 4 },
    { id: 'frozen_herb', name: 'Frozen Herb', weight: 3 },
    { id: 'birch_tree', name: 'Birch Tree', weight: 5 },
  ],
  [BiomeType.RUINS]: [
    { id: 'scrap_metal', name: 'Scrap Metal', weight: 10 },
    { id: 'electronic_parts', name: 'Electronic Parts', weight: 5 },
    { id: 'salvage_wood', name: 'Salvage Wood', weight: 8 },
    { id: 'glass_shards', name: 'Glass Shards', weight: 6 },
  ],
  [BiomeType.WATER]: [],
  [BiomeType.COASTAL]: [
    { id: 'driftwood', name: 'Driftwood', weight: 8 },
    { id: 'seaweed', name: 'Seaweed', weight: 6 },
    { id: 'shell', name: 'Shell', weight: 5 },
    { id: 'salt_deposit', name: 'Salt Deposit', weight: 3 },
  ],
  [BiomeType.FARMLAND]: [
    { id: 'wheat', name: 'Wild Wheat', weight: 6 },
    { id: 'vegetable', name: 'Wild Vegetable', weight: 5 },
    { id: 'herb_common', name: 'Common Herb', weight: 4 },
    { id: 'salvage_wood', name: 'Salvage Wood', weight: 3 },
  ],
};

/**
 * Corrupted creature variants
 */
const CORRUPTED_SPAWNS = [
  { id: 'shadow_wolf', name: 'Shadow Wolf', weight: 5, minCorruption: 0.3 },
  { id: 'blighted_deer', name: 'Blighted Deer', weight: 4, minCorruption: 0.3 },
  { id: 'void_crawler', name: 'Void Crawler', weight: 3, minCorruption: 0.5 },
  { id: 'wraith', name: 'Wraith', weight: 2, minCorruption: 0.6 },
  { id: 'abomination', name: 'Abomination', weight: 1, minCorruption: 0.8 },
];

/**
 * SpawnTablePipeline - Generates spawn tables
 */
export class SpawnTablePipeline extends BaseTilePipeline {
  jobType = TileBuildJobType.SPAWN_GEN;
  name = 'SpawnTablePipeline';

  private config: SpawnTablePipelineConfig;

  constructor(config: Partial<SpawnTablePipelineConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async process(tile: TileAddress, _inputHash?: string): Promise<PipelineResult> {
    this.log(tile, 'Generating spawn table');

    try {
      const tileId = tileAddressToId(tile);
      const tileRecord = await TileService.getTile(tileId);

      // Load biome and population data
      let biomeData: TileBiomeData | null = null;
      let populationData: TilePopulationData | null = null;

      if (tileRecord?.biomeHash) {
        const buffer = await this.storage.get(tileRecord.biomeHash);
        if (buffer) {
          biomeData = BiomePipeline.deserializeBiomeData(buffer);
        }
      }

      if (tileRecord?.populationHash) {
        const buffer = await this.storage.get(tileRecord.populationHash);
        if (buffer) {
          populationData = PopulationPipeline.deserializePopulationData(buffer);
        }
      }

      // Generate spawn table
      const spawnTable = this.generateSpawnTable(
        tileId,
        biomeData,
        populationData
      );

      // Serialize and store
      const buffer = Buffer.from(JSON.stringify(spawnTable), 'utf-8');
      const hash = await this.storage.put(buffer);

      this.log(
        tile,
        `Generated spawn table: ${spawnTable.biome}, ` +
          `wildlife=${spawnTable.wildlife.entries.length}, ` +
          `resources=${spawnTable.resources.entries.length}, ` +
          `corruption=${spawnTable.corruptionLevel.toFixed(2)}`
      );

      return this.success(hash, {
        biome: spawnTable.biome,
        spawnCapacity: spawnTable.spawnCapacity,
        wildlifeTypes: spawnTable.wildlife.entries.length,
        resourceTypes: spawnTable.resources.entries.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(tile, `Failed: ${message}`);
      return this.failure(message);
    }
  }

  /**
   * Generate spawn table for a tile
   */
  private generateSpawnTable(
    tileId: string,
    biomeData: TileBiomeData | null,
    populationData: TilePopulationData | null
  ): TileSpawnTable {
    const biome = biomeData?.dominantBiome ?? BiomeType.GRASSLAND;
    const settlementType = populationData?.settlementType ?? SettlementType.WILDERNESS;
    const corruptionLevel = populationData?.corruptionScore ?? 0;

    // Adjust spawn capacity based on settlement
    let spawnCapacity = this.config.baseSpawnCapacity;
    if (settlementType === SettlementType.WILDERNESS) {
      spawnCapacity *= 1.5;
    } else if (settlementType === SettlementType.URBAN_CORE || settlementType === SettlementType.METROPOLIS) {
      spawnCapacity *= 0.5;
    }

    // Calculate spawn rate modifier
    let spawnRateModifier = 1.0;
    if (corruptionLevel > 0.5) {
      spawnRateModifier *= 1 + (corruptionLevel - 0.5); // More spawns in corrupted areas
    }

    return {
      tileId,
      version: 1,
      biome,
      settlementType,
      corruptionLevel,
      wildlife: this.generateWildlifeGroup(biome, settlementType, corruptionLevel),
      hostiles: this.generateHostileGroup(biome, settlementType, corruptionLevel),
      resources: this.generateResourceGroup(biome, settlementType),
      loot: this.generateLootGroup(settlementType, corruptionLevel),
      special: this.generateSpecialSpawns(corruptionLevel),
      spawnCapacity: Math.floor(spawnCapacity),
      spawnRateModifier,
    };
  }

  /**
   * Generate wildlife spawn group
   */
  private generateWildlifeGroup(
    biome: BiomeType,
    settlementType: SettlementType,
    corruptionLevel: number
  ): SpawnGroup {
    const baseWildlife = BIOME_WILDLIFE[biome] || [];
    const entries: SpawnEntry[] = [];

    // Reduce wildlife in settlements
    const settlementModifier = settlementType === SettlementType.WILDERNESS ? 1.0 :
      settlementType === SettlementType.RURAL ? 0.8 : 0.3;

    for (const w of baseWildlife) {
      if (corruptionLevel < 0.8) { // High corruption kills normal wildlife
        entries.push({
          type: SpawnEntryType.WILDLIFE,
          spawnId: w.id,
          name: w.name,
          weight: w.weight * settlementModifier * (1 - corruptionLevel * 0.5),
          minCount: 1,
          maxCount: w.id === 'wolf' || w.id === 'coyote' ? 4 : 2,
          minLevel: 1,
          maxLevel: 10,
          timeRestrictions: [],
          weatherRestrictions: [],
          minCorruption: 0,
          maxCorruption: 0.8,
        });
      }
    }

    return {
      id: 'wildlife',
      name: 'Wildlife',
      entries,
      totalWeight: entries.reduce((sum, e) => sum + e.weight, 0),
      respawnCooldown: 300,
      maxActive: 10,
    };
  }

  /**
   * Generate hostile spawn group
   */
  private generateHostileGroup(
    _biome: BiomeType,
    settlementType: SettlementType,
    corruptionLevel: number
  ): SpawnGroup {
    const entries: SpawnEntry[] = [];

    // Add corrupted spawns if corruption is high enough
    if (corruptionLevel >= this.config.corruptionSpawnThreshold) {
      for (const c of CORRUPTED_SPAWNS) {
        if (corruptionLevel >= c.minCorruption) {
          entries.push({
            type: SpawnEntryType.CORRUPTED,
            spawnId: c.id,
            name: c.name,
            weight: c.weight * (corruptionLevel / c.minCorruption),
            minCount: 1,
            maxCount: c.id === 'abomination' ? 1 : 3,
            minLevel: Math.floor(c.minCorruption * 20),
            maxLevel: Math.floor(c.minCorruption * 30),
            timeRestrictions: c.minCorruption > 0.5 ? ['night'] : [],
            weatherRestrictions: [],
            minCorruption: c.minCorruption,
            maxCorruption: 1,
          });
        }
      }
    }

    // Add regular hostiles for ruins
    if (settlementType !== SettlementType.WILDERNESS && settlementType !== SettlementType.RURAL) {
      entries.push({
        type: SpawnEntryType.HOSTILE,
        spawnId: 'raider',
        name: 'Raider',
        weight: 5,
        minCount: 1,
        maxCount: 3,
        minLevel: 5,
        maxLevel: 15,
        timeRestrictions: [],
        weatherRestrictions: [],
        minCorruption: 0,
        maxCorruption: 1,
      });
    }

    return {
      id: 'hostiles',
      name: 'Hostiles',
      entries,
      totalWeight: entries.reduce((sum, e) => sum + e.weight, 0),
      respawnCooldown: 600,
      maxActive: 5,
    };
  }

  /**
   * Generate resource spawn group
   */
  private generateResourceGroup(biome: BiomeType, settlementType: SettlementType): SpawnGroup {
    const baseResources = BIOME_RESOURCES[biome] || [];
    const entries: SpawnEntry[] = [];

    const resourceModifier = settlementType === SettlementType.WILDERNESS ? 1.2 :
      settlementType === SettlementType.RURAL ? 1.0 : 0.6;

    for (const r of baseResources) {
      entries.push({
        type: SpawnEntryType.RESOURCE,
        spawnId: r.id,
        name: r.name,
        weight: r.weight * resourceModifier,
        minCount: 1,
        maxCount: 3,
        minLevel: 1,
        maxLevel: 1,
        timeRestrictions: [],
        weatherRestrictions: [],
        minCorruption: 0,
        maxCorruption: 1,
      });
    }

    return {
      id: 'resources',
      name: 'Resources',
      entries,
      totalWeight: entries.reduce((sum, e) => sum + e.weight, 0),
      respawnCooldown: 1800,
      maxActive: 15,
    };
  }

  /**
   * Generate loot spawn group
   */
  private generateLootGroup(settlementType: SettlementType, corruptionLevel: number): SpawnGroup {
    const entries: SpawnEntry[] = [];

    if (settlementType !== SettlementType.WILDERNESS) {
      const lootQuality = settlementType === SettlementType.METROPOLIS ? 'rare' :
        settlementType === SettlementType.URBAN_CORE ? 'uncommon' : 'common';

      entries.push({
        type: SpawnEntryType.LOOT,
        spawnId: `loot_${lootQuality}`,
        name: `${lootQuality.charAt(0).toUpperCase() + lootQuality.slice(1)} Loot`,
        weight: 10,
        minCount: 1,
        maxCount: 1,
        minLevel: 1,
        maxLevel: 1,
        timeRestrictions: [],
        weatherRestrictions: [],
        minCorruption: 0,
        maxCorruption: 1,
      });

      // Corrupted loot in corrupted areas
      if (corruptionLevel > 0.4) {
        entries.push({
          type: SpawnEntryType.LOOT,
          spawnId: 'loot_corrupted',
          name: 'Corrupted Loot',
          weight: corruptionLevel * 5,
          minCount: 1,
          maxCount: 1,
          minLevel: 1,
          maxLevel: 1,
          timeRestrictions: [],
          weatherRestrictions: [],
          minCorruption: 0.4,
          maxCorruption: 1,
        });
      }
    }

    return {
      id: 'loot',
      name: 'Loot',
      entries,
      totalWeight: entries.reduce((sum, e) => sum + e.weight, 0),
      respawnCooldown: 3600,
      maxActive: 5,
    };
  }

  /**
   * Generate special/rare spawns
   */
  private generateSpecialSpawns(corruptionLevel: number): SpawnEntry[] {
    const special: SpawnEntry[] = [];

    // Very rare boss spawn in highly corrupted areas
    if (corruptionLevel > 0.9) {
      special.push({
        type: SpawnEntryType.CORRUPTED,
        spawnId: 'corruption_heart',
        name: 'Corruption Heart',
        weight: 1,
        minCount: 1,
        maxCount: 1,
        minLevel: 30,
        maxLevel: 40,
        timeRestrictions: ['night'],
        weatherRestrictions: [],
        minCorruption: 0.9,
        maxCorruption: 1,
      });
    }

    return special;
  }

  /**
   * Deserialize spawn table from storage
   */
  static deserializeSpawnTable(buffer: Buffer): TileSpawnTable {
    return JSON.parse(buffer.toString('utf-8'));
  }
}
