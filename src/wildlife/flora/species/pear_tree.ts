/**
 * Pear Tree - Slender fruit tree, slightly rarer than apple
 */

import type { PlantSpecies, PlantSpawnConfig } from '../types';

export const pearTree: PlantSpecies = {
  id: 'pear_tree',
  name: 'Pear Tree',
  description: 'A tall slender tree with white spring blossom. Produces sweet, gritty fruit in autumn.',
  plantType: 'tree',

  growthStages: [
    { stage: 'seed',      durationSeconds: 100,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'sprout',    durationSeconds: 300,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'growing',   durationSeconds: 800,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'mature',    durationSeconds: 200,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'flowering', durationSeconds: 600,  canHarvest: true,  yieldMultiplier: 1.0 },
    { stage: 'withering', durationSeconds: 400,  canHarvest: true,  yieldMultiplier: 0.3 },
  ],
  totalGrowthTime: 2000,

  biomePreferences: [
    { biome: 'forest',    growthMultiplier: 1.2, spawnWeight: 3 },
    { biome: 'grassland', growthMultiplier: 1.0, spawnWeight: 2 },
  ],
  requiresWater: false,
  lightRequirement: 'full_sun',

  harvestItems: [
    { itemId: 'pear', baseQuantity: { min: 2, max: 6 }, chance: 1.0, requiresStage: 'flowering' },
    { itemId: 'pear', baseQuantity: { min: 1, max: 2 }, chance: 0.5, requiresStage: 'withering' },
  ],
  harvestTime: 5,
  regrowsAfterHarvest: true,
  regrowthTime: 600,
  destroyedOnHarvest: false,

  isWildlifeFood: true,
  foodValue: 30,

  modelId: 'plant_pear_tree',
  stageModels: {
    seed:      'plant_pear_sapling_tiny',
    sprout:    'plant_pear_sapling',
    growing:   'plant_pear_young',
    mature:    'plant_pear_tree',
    flowering: 'plant_pear_tree_fruiting',
    withering: 'plant_pear_tree_late',
    dead:      'plant_pear_tree_dead',
  },
};

export const pearTreeSpawnConfig: PlantSpawnConfig = {
  speciesId: 'pear_tree',
  biomes: ['forest', 'grassland'],
  spawnChance: 0.06,
  maxPerZone: 5,
  minDistanceBetween: 25,
  clusterSize: { min: 1, max: 2 },
  clusterRadius: 20,
};
