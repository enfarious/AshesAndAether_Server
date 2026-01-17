/**
 * Sage - Herb for crafting/alchemy, also wildlife food
 */

import type { PlantSpecies, PlantSpawnConfig } from '../types';

export const sage: PlantSpecies = {
  id: 'herb_sage',
  name: 'Wild Sage',
  description: 'A fragrant herb with silvery-green leaves. Used in cooking and alchemy.',
  plantType: 'herb',

  growthStages: [
    { stage: 'seed', durationSeconds: 60, canHarvest: false, yieldMultiplier: 0 },
    { stage: 'sprout', durationSeconds: 120, canHarvest: false, yieldMultiplier: 0 },
    { stage: 'growing', durationSeconds: 300, canHarvest: true, yieldMultiplier: 0.3 },
    { stage: 'mature', durationSeconds: 600, canHarvest: true, yieldMultiplier: 1.0 },
    { stage: 'flowering', durationSeconds: 300, canHarvest: true, yieldMultiplier: 1.5 },
    { stage: 'withering', durationSeconds: 240, canHarvest: true, yieldMultiplier: 0.5 },
  ],
  totalGrowthTime: 480,

  biomePreferences: [
    { biome: 'grassland', growthMultiplier: 1.2, spawnWeight: 5 },
    { biome: 'mountain', growthMultiplier: 1.0, spawnWeight: 4 },
    { biome: 'forest', growthMultiplier: 0.8, spawnWeight: 3 },
    { biome: 'desert', growthMultiplier: 0.6, spawnWeight: 2 },
  ],
  requiresWater: false,
  lightRequirement: 'full_sun',

  harvestItems: [
    { itemId: 'herb_sage', baseQuantity: { min: 1, max: 3 }, chance: 1.0 },
    { itemId: 'sage_seed', baseQuantity: { min: 0, max: 2 }, chance: 0.5, requiresStage: 'flowering' },
    { itemId: 'sage_oil', baseQuantity: { min: 1, max: 1 }, chance: 0.1, requiresStage: 'flowering' },
  ],
  harvestTime: 4,
  regrowsAfterHarvest: true,
  regrowthTime: 360, // 6 minutes
  destroyedOnHarvest: false,

  isWildlifeFood: true,
  foodValue: 10, // Not very filling but edible

  modelId: 'plant_sage',
};

export const sageSpawnConfig: PlantSpawnConfig = {
  speciesId: 'herb_sage',
  biomes: ['grassland', 'mountain', 'forest', 'desert'],
  spawnChance: 0.25,
  maxPerZone: 20,
  minDistanceBetween: 8,
  clusterSize: { min: 2, max: 4 },
  clusterRadius: 5,
};
