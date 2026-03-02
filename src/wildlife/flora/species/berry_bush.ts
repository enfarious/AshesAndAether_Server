/**
 * Berry Bush - Thorny shrub with seasonal fruit
 *
 * Bears berries in flowering stage. Deer, foxes and birds all eat them.
 * Thorns mean you take minor damage harvesting without gloves (future mechanic).
 */

import type { PlantSpecies, PlantSpawnConfig } from '../types';

export const berryBush: PlantSpecies = {
  id: 'berry_bush',
  name: 'Berry Bush',
  description: 'A thorny shrub that explodes with small red berries each summer. Worth the scratches.',
  plantType: 'bush',

  growthStages: [
    { stage: 'sprout',    durationSeconds: 120,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'growing',   durationSeconds: 300,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'mature',    durationSeconds: 240,  canHarvest: false, yieldMultiplier: 0   }, // Leafy but no fruit yet
    { stage: 'flowering', durationSeconds: 600,  canHarvest: true,  yieldMultiplier: 1.0 }, // Fruiting = flowering stage
    { stage: 'withering', durationSeconds: 300,  canHarvest: true,  yieldMultiplier: 0.4 },
  ],
  totalGrowthTime: 720,

  biomePreferences: [
    { biome: 'forest',    growthMultiplier: 1.2, spawnWeight: 7 },
    { biome: 'grassland', growthMultiplier: 1.0, spawnWeight: 5 },
    { biome: 'coastal',   growthMultiplier: 1.1, spawnWeight: 5 },
    { biome: 'mountain',  growthMultiplier: 0.8, spawnWeight: 3 },
    { biome: 'swamp',     growthMultiplier: 0.9, spawnWeight: 3 },
  ],
  requiresWater: false,
  lightRequirement: 'partial_shade',

  harvestItems: [
    { itemId: 'berries',     baseQuantity: { min: 3, max: 8 }, chance: 1.0,  requiresStage: 'flowering' },
    { itemId: 'berries',     baseQuantity: { min: 1, max: 3 }, chance: 0.7,  requiresStage: 'withering' },
    { itemId: 'berry_seeds', baseQuantity: { min: 0, max: 2 }, chance: 0.3,  requiresStage: 'flowering' },
  ],
  harvestTime: 4,
  regrowsAfterHarvest: true,
  regrowthTime: 480, // Returns to mature (bare), flowers again next season
  destroyedOnHarvest: false,

  isWildlifeFood: true,
  foodValue: 20,

  modelId: 'plant_berry_bush',
  stageModels: {
    seed:      'plant_berry_bush_tiny',
    sprout:    'plant_berry_bush_tiny',
    growing:   'plant_berry_bush_small',
    mature:    'plant_berry_bush',
    flowering: 'plant_berry_bush_fruiting',
    withering: 'plant_berry_bush_late',
    dead:      'plant_berry_bush_dead',
  },
};

export const berryBushSpawnConfig: PlantSpawnConfig = {
  speciesId: 'berry_bush',
  biomes: ['forest', 'grassland', 'coastal', 'mountain'],
  spawnChance: 0.2,
  maxPerZone: 25,
  minDistanceBetween: 6,
  clusterSize: { min: 1, max: 3 },
  clusterRadius: 8,
};
