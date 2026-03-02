/**
 * Apple Tree - Fruit tree, seasons-dependent harvest
 *
 * Takes a long time to mature but regrows fruit each season.
 * Deer and boar will eat fallen apples.
 */

import type { PlantSpecies, PlantSpawnConfig } from '../types';

export const appleTree: PlantSpecies = {
  id: 'apple_tree',
  name: 'Apple Tree',
  description: 'A gnarled tree with rough bark and spreading branches. Bears abundant fruit in summer and autumn.',
  plantType: 'tree',

  growthStages: [
    { stage: 'seed',      durationSeconds: 90,   canHarvest: false, yieldMultiplier: 0   },
    { stage: 'sprout',    durationSeconds: 270,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'growing',   durationSeconds: 720,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'mature',    durationSeconds: 180,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'flowering', durationSeconds: 540,  canHarvest: true,  yieldMultiplier: 1.0 },
    { stage: 'withering', durationSeconds: 360,  canHarvest: true,  yieldMultiplier: 0.4 },
  ],
  totalGrowthTime: 1800,

  biomePreferences: [
    { biome: 'forest',    growthMultiplier: 1.2, spawnWeight: 4 },
    { biome: 'grassland', growthMultiplier: 1.0, spawnWeight: 3 },
    { biome: 'mountain',  growthMultiplier: 0.7, spawnWeight: 1 },
  ],
  requiresWater: false,
  lightRequirement: 'full_sun',

  harvestItems: [
    { itemId: 'apple', baseQuantity: { min: 3, max: 8 }, chance: 1.0, requiresStage: 'flowering' },
    { itemId: 'apple', baseQuantity: { min: 1, max: 3 }, chance: 0.6, requiresStage: 'withering' },
  ],
  harvestTime: 5,
  regrowsAfterHarvest: true,
  regrowthTime: 540, // Cycles back to mature, flowers next season
  destroyedOnHarvest: false,

  isWildlifeFood: true,   // Fallen fruit
  foodValue: 35,

  modelId: 'plant_apple_tree',
  stageModels: {
    seed:      'plant_apple_sapling_tiny',
    sprout:    'plant_apple_sapling',
    growing:   'plant_apple_young',
    mature:    'plant_apple_tree',
    flowering: 'plant_apple_tree_fruiting',
    withering: 'plant_apple_tree_late',
    dead:      'plant_apple_tree_dead',
  },
};

export const appleTreeSpawnConfig: PlantSpawnConfig = {
  speciesId: 'apple_tree',
  biomes: ['forest', 'grassland'],
  spawnChance: 0.08,
  maxPerZone: 8,
  minDistanceBetween: 20, // Trees need space
  clusterSize: { min: 1, max: 3 },
  clusterRadius: 15,
};
