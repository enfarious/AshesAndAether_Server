/**
 * Wild Carrot - Root vegetable, rabbit favourite
 */

import type { PlantSpecies, PlantSpawnConfig } from '../types';

export const carrot: PlantSpecies = {
  id: 'carrot',
  name: 'Wild Carrot',
  description: 'Feathery white flowers mark where this root vegetable hides underground. Sweet and nutritious.',
  plantType: 'crop',

  growthStages: [
    { stage: 'seed',     durationSeconds: 30,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'sprout',   durationSeconds: 60,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'growing',  durationSeconds: 120, canHarvest: false, yieldMultiplier: 0   },
    { stage: 'mature',   durationSeconds: 480, canHarvest: true,  yieldMultiplier: 1.0 },
    { stage: 'withering',durationSeconds: 180, canHarvest: true,  yieldMultiplier: 0.5 },
  ],
  totalGrowthTime: 300,

  biomePreferences: [
    { biome: 'grassland', growthMultiplier: 1.3, spawnWeight: 6 },
    { biome: 'forest',    growthMultiplier: 1.0, spawnWeight: 4 },
    { biome: 'mountain',  growthMultiplier: 0.7, spawnWeight: 2 },
    { biome: 'coastal',   growthMultiplier: 0.8, spawnWeight: 2 },
  ],
  requiresWater: false,
  lightRequirement: 'full_sun',

  harvestItems: [
    { itemId: 'carrot', baseQuantity: { min: 1, max: 3 }, chance: 1.0 },
    { itemId: 'carrot_top', baseQuantity: { min: 1, max: 2 }, chance: 0.5 },
  ],
  harvestTime: 3,
  regrowsAfterHarvest: false,
  regrowthTime: 0,
  destroyedOnHarvest: true,

  isWildlifeFood: true,
  foodValue: 30,

  modelId: 'plant_carrot',
  stageModels: {
    seed:      'plant_carrot_seed',
    sprout:    'plant_carrot_sprout',
    growing:   'plant_carrot_growing',
    mature:    'plant_carrot_mature',
    flowering: 'plant_carrot_mature',
    withering: 'plant_carrot_withering',
    dead:      'plant_carrot_dead',
  },
};

export const carrotSpawnConfig: PlantSpawnConfig = {
  speciesId: 'carrot',
  biomes: ['grassland', 'forest', 'mountain'],
  spawnChance: 0.25,
  maxPerZone: 30,
  minDistanceBetween: 4,
  clusterSize: { min: 2, max: 5 },
  clusterRadius: 6,
};
