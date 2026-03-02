/**
 * Wild Garlic - Fragrant herb, medicinal and culinary use
 */

import type { PlantSpecies, PlantSpawnConfig } from '../types';

export const garlic: PlantSpecies = {
  id: 'garlic',
  name: 'Wild Garlic',
  description: 'White star-shaped flowers carpet forest floors in spring. The whole plant carries a powerful aroma.',
  plantType: 'herb',

  growthStages: [
    { stage: 'seed',      durationSeconds: 45,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'sprout',    durationSeconds: 60,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'growing',   durationSeconds: 150, canHarvest: false, yieldMultiplier: 0   },
    { stage: 'mature',    durationSeconds: 540, canHarvest: true,  yieldMultiplier: 1.0 },
    { stage: 'flowering', durationSeconds: 300, canHarvest: true,  yieldMultiplier: 1.3 },
    { stage: 'withering', durationSeconds: 180, canHarvest: true,  yieldMultiplier: 0.4 },
  ],
  totalGrowthTime: 450,

  biomePreferences: [
    { biome: 'forest',    growthMultiplier: 1.3, spawnWeight: 6 },
    { biome: 'grassland', growthMultiplier: 1.1, spawnWeight: 4 },
    { biome: 'mountain',  growthMultiplier: 0.9, spawnWeight: 3 },
  ],
  requiresWater: false,
  lightRequirement: 'partial_shade',

  harvestItems: [
    { itemId: 'garlic',      baseQuantity: { min: 1, max: 4 }, chance: 1.0 },
    { itemId: 'garlic_seed', baseQuantity: { min: 0, max: 2 }, chance: 0.3, requiresStage: 'flowering' },
  ],
  harvestTime: 3,
  regrowsAfterHarvest: false,
  regrowthTime: 0,
  destroyedOnHarvest: true,

  isWildlifeFood: false, // Too pungent for most animals
  foodValue: 0,

  modelId: 'plant_garlic',
};

export const garlicSpawnConfig: PlantSpawnConfig = {
  speciesId: 'garlic',
  biomes: ['forest', 'grassland', 'mountain'],
  spawnChance: 0.15,
  maxPerZone: 20,
  minDistanceBetween: 3,
  clusterSize: { min: 4, max: 12 }, // Grows in big carpets
  clusterRadius: 8,
};
