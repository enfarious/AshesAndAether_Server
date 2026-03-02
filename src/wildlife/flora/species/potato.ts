/**
 * Wild Potato - Underground tuber, boar favourite
 */

import type { PlantSpecies, PlantSpawnConfig } from '../types';

export const potato: PlantSpecies = {
  id: 'potato',
  name: 'Wild Potato',
  description: 'Leafy surface growth hides a starchy tuber below. Needs to be dug out.',
  plantType: 'crop',

  growthStages: [
    { stage: 'seed',     durationSeconds: 45,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'sprout',   durationSeconds: 60,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'growing',  durationSeconds: 150, canHarvest: false, yieldMultiplier: 0   },
    { stage: 'mature',   durationSeconds: 600, canHarvest: true,  yieldMultiplier: 1.0 },
    { stage: 'withering',durationSeconds: 240, canHarvest: true,  yieldMultiplier: 0.6 },
  ],
  totalGrowthTime: 400,

  biomePreferences: [
    { biome: 'grassland', growthMultiplier: 1.2, spawnWeight: 4 },
    { biome: 'forest',    growthMultiplier: 1.0, spawnWeight: 5 },
    { biome: 'mountain',  growthMultiplier: 0.8, spawnWeight: 3 },
  ],
  requiresWater: false,
  lightRequirement: 'partial_shade',

  harvestItems: [
    { itemId: 'potato', baseQuantity: { min: 2, max: 5 }, chance: 1.0 },
  ],
  harvestTime: 4,
  regrowsAfterHarvest: false,
  regrowthTime: 0,
  destroyedOnHarvest: true,

  isWildlifeFood: false, // Underground — animals can smell it but can't easily eat it
  foodValue: 0,

  modelId: 'plant_potato',
};

export const potatoSpawnConfig: PlantSpawnConfig = {
  speciesId: 'potato',
  biomes: ['grassland', 'forest', 'mountain'],
  spawnChance: 0.15,
  maxPerZone: 20,
  minDistanceBetween: 5,
  clusterSize: { min: 2, max: 4 },
  clusterRadius: 5,
};
