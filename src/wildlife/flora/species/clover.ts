/**
 * Clover - Nutritious wildlife food, rabbit favorite
 */

import type { PlantSpecies, PlantSpawnConfig } from '../types';

export const clover: PlantSpecies = {
  id: 'clover',
  name: 'Clover',
  description: 'A leafy plant with distinctive three-part leaves. Highly nutritious for herbivores.',
  plantType: 'herb',

  growthStages: [
    { stage: 'seed', durationSeconds: 45, canHarvest: false, yieldMultiplier: 0 },
    { stage: 'sprout', durationSeconds: 90, canHarvest: false, yieldMultiplier: 0 },
    { stage: 'growing', durationSeconds: 180, canHarvest: true, yieldMultiplier: 0.5 },
    { stage: 'mature', durationSeconds: 480, canHarvest: true, yieldMultiplier: 1.0 },
    { stage: 'flowering', durationSeconds: 240, canHarvest: true, yieldMultiplier: 1.2 },
    { stage: 'withering', durationSeconds: 180, canHarvest: true, yieldMultiplier: 0.4 },
  ],
  totalGrowthTime: 315,

  biomePreferences: [
    { biome: 'grassland', growthMultiplier: 1.3, spawnWeight: 8 },
    { biome: 'forest', growthMultiplier: 1.0, spawnWeight: 5 },
    { biome: 'urban', growthMultiplier: 0.8, spawnWeight: 3 },
    { biome: 'coastal', growthMultiplier: 0.9, spawnWeight: 4 },
  ],
  requiresWater: false,
  lightRequirement: 'partial_shade',

  harvestItems: [
    { itemId: 'clover', baseQuantity: { min: 2, max: 5 }, chance: 1.0 },
    { itemId: 'four_leaf_clover', baseQuantity: { min: 1, max: 1 }, chance: 0.01 }, // Lucky!
    { itemId: 'clover_seed', baseQuantity: { min: 1, max: 3 }, chance: 0.4, requiresStage: 'flowering' },
  ],
  harvestTime: 3,
  regrowsAfterHarvest: true,
  regrowthTime: 240, // 4 minutes
  destroyedOnHarvest: false,

  isWildlifeFood: true,
  foodValue: 25, // More nutritious than grass

  modelId: 'plant_clover',
};

export const cloverSpawnConfig: PlantSpawnConfig = {
  speciesId: 'clover',
  biomes: ['grassland', 'forest', 'urban', 'coastal'],
  spawnChance: 0.5,
  maxPerZone: 50,
  minDistanceBetween: 3,
  clusterSize: { min: 3, max: 8 },
  clusterRadius: 6,
};
