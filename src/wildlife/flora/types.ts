/**
 * Flora/Plant System Types
 *
 * Plants are harvestable resources that:
 * - Grow over time through stages
 * - Can be harvested by players for items
 * - Can be eaten by herbivore wildlife
 * - Respawn after being harvested
 * - Exist in specific biomes
 */

import type { Vector3 } from '@/network/protocol/types';
import type { BiomeType } from '../types';

// ========== Plant Growth Stages ==========

export type PlantGrowthStage =
  | 'seed'        // Just planted/spawned, not visible
  | 'sprout'      // Small, visible but not harvestable
  | 'growing'     // Getting bigger
  | 'mature'      // Full size, harvestable
  | 'flowering'   // Bonus stage for some plants
  | 'withering'   // Past prime, reduced yields
  | 'dead';       // Needs removal/respawn

export interface GrowthStageTiming {
  stage: PlantGrowthStage;
  durationSeconds: number;    // How long this stage lasts
  canHarvest: boolean;
  yieldMultiplier: number;    // 1.0 = normal, 0.5 = half yield
}

// ========== Plant Species Definition ==========

export interface PlantSpecies {
  id: string;
  name: string;
  description: string;
  plantType: 'herb' | 'bush' | 'tree' | 'mushroom' | 'flower' | 'crop' | 'grass';

  // Growth
  growthStages: GrowthStageTiming[];
  totalGrowthTime: number;    // Seconds from seed to mature

  // Environment
  biomePreferences: Array<{
    biome: BiomeType;
    growthMultiplier: number; // 1.0 = normal, 1.5 = faster, 0.5 = slower
    spawnWeight: number;      // Relative spawn chance in this biome
  }>;
  requiresWater: boolean;     // Must be near water to grow
  lightRequirement: 'full_sun' | 'partial_shade' | 'shade' | 'any';

  // Harvesting
  harvestItems: PlantHarvestItem[];
  harvestTime: number;        // Seconds to harvest
  regrowsAfterHarvest: boolean;
  regrowthTime: number;       // Seconds to regrow if regrows
  destroyedOnHarvest: boolean;

  // Wildlife interaction
  isWildlifeFood: boolean;    // Can herbivores eat this?
  foodValue: number;          // How much hunger it satisfies (0-100)

  // Visual
  modelId?: string;
  stageModels?: Record<PlantGrowthStage, string>;
}

export interface PlantHarvestItem {
  itemId: string;
  baseQuantity: { min: number; max: number };
  chance: number;             // 0-1 probability
  requiresStage?: PlantGrowthStage; // Only drops at specific stage
  requiresTool?: string;      // Tool type needed (e.g., 'axe' for trees)
}

// ========== Plant Instance (Runtime State) ==========

export interface PlantEntity {
  id: string;
  speciesId: string;
  position: Vector3;
  zoneId: string;

  // Growth state
  currentStage: PlantGrowthStage;
  stageStartedAt: number;     // Timestamp when current stage started
  growthProgress: number;     // 0-100% through current stage

  // Health/state
  isAlive: boolean;
  timesHarvested: number;     // How many times this plant has been harvested
  lastHarvestedAt?: number;
  lastHarvestedBy?: string;   // Character ID

  // Spawn info
  spawnedAt: number;
  despawnAt?: number;         // When to remove (for temporary plants)
}

// ========== Spawn Configuration ==========

export interface PlantSpawnConfig {
  speciesId: string;
  biomes: BiomeType[];
  spawnChance: number;        // 0-1 per spawn attempt
  maxPerZone: number;
  minDistanceBetween: number;
  clusterSize?: { min: number; max: number }; // Plants often grow in clusters
  clusterRadius?: number;
  nearWaterOnly?: boolean;
  nearWaterDistance?: number;
}

// ========== Events ==========

export type PlantEventType =
  | 'plant_spawn'
  | 'plant_grow'              // Stage change
  | 'plant_harvest'
  | 'plant_eaten'             // By wildlife
  | 'plant_wither'
  | 'plant_death';

export interface PlantEvent {
  type: PlantEventType;
  plantId: string;
  speciesId: string;
  position: Vector3;
  zoneId: string;
  timestamp: number;
  data?: Record<string, unknown>;
}
