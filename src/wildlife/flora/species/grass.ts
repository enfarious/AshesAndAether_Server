/**
 * Grass - Basic wildlife food, very common
 */

import type { PlantSpecies, PlantSpawnConfig } from '../types';

export const grass: PlantSpecies = {
  id: 'grass',
  name: 'Wild Grass',
  description: 'Common grass that grows in meadows and fields. Food for herbivores.',
  plantType: 'grass',

  growthStages: [
    { stage: 'seed', durationSeconds: 30, canHarvest: false, yieldMultiplier: 0 },
    { stage: 'sprout', durationSeconds: 60, canHarvest: false, yieldMultiplier: 0 },
    { stage: 'growing', durationSeconds: 120, canHarvest: true, yieldMultiplier: 0.5 },
    { stage: 'mature', durationSeconds: 600, canHarvest: true, yieldMultiplier: 1.0 },
    { stage: 'withering', durationSeconds: 300, canHarvest: true, yieldMultiplier: 0.3 },
  ],
  totalGrowthTime: 210,

  biomePreferences: [
    { biome: 'grassland', growthMultiplier: 1.5, spawnWeight: 10 },
    { biome: 'forest', growthMultiplier: 0.8, spawnWeight: 3 },
    { biome: 'coastal', growthMultiplier: 1.0, spawnWeight: 5 },
    { biome: 'mountain', growthMultiplier: 0.5, spawnWeight: 2 },
    { biome: 'swamp', growthMultiplier: 1.2, spawnWeight: 4 },
  ],
  requiresWater: false,
  lightRequirement: 'full_sun',

  harvestItems: [
    { itemId: 'grass_bundle', baseQuantity: { min: 1, max: 3 }, chance: 1.0 },
    { itemId: 'grass_seed', baseQuantity: { min: 0, max: 2 }, chance: 0.3, requiresStage: 'mature' },
  ],
  harvestTime: 2,
  regrowsAfterHarvest: true,
  regrowthTime: 180, // 3 minutes
  destroyedOnHarvest: false,

  isWildlifeFood: true,
  foodValue: 15, // Low nutrition per patch

  modelId: 'plant_grass',
};

export const grassSpawnConfig: PlantSpawnConfig = {
  speciesId: 'grass',
  biomes: ['grassland', 'forest', 'coastal', 'mountain', 'swamp'],
  spawnChance: 0.8,
  maxPerZone: 100,
  minDistanceBetween: 2,
  clusterSize: { min: 5, max: 15 },
  clusterRadius: 10,
};
