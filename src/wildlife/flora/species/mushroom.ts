/**
 * Forest Mushroom - Shade-growing fungus, valuable harvest
 *
 * Grows fastest in forest shade and swamp.
 * Boar and deer will eat them. Some are medicinal.
 */

import type { PlantSpecies, PlantSpawnConfig } from '../types';

export const mushroom: PlantSpecies = {
  id: 'mushroom',
  name: 'Forest Mushroom',
  description: 'A broad-capped fungus that sprouts from rich soil and rotting wood. Valued in cooking and alchemy.',
  plantType: 'mushroom',

  growthStages: [
    { stage: 'sprout',   durationSeconds: 60,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'growing',  durationSeconds: 120, canHarvest: false, yieldMultiplier: 0   },
    { stage: 'mature',   durationSeconds: 300, canHarvest: true,  yieldMultiplier: 1.0 },
    { stage: 'withering',durationSeconds: 180, canHarvest: true,  yieldMultiplier: 0.5 },
  ],
  totalGrowthTime: 180,

  biomePreferences: [
    { biome: 'forest',    growthMultiplier: 1.5, spawnWeight: 8 },
    { biome: 'swamp',     growthMultiplier: 1.3, spawnWeight: 6 },
    { biome: 'mountain',  growthMultiplier: 0.8, spawnWeight: 3 },
    { biome: 'underground', growthMultiplier: 1.8, spawnWeight: 10 },
  ],
  requiresWater: false,
  lightRequirement: 'shade',

  harvestItems: [
    { itemId: 'mushroom',          baseQuantity: { min: 1, max: 3 }, chance: 1.0 },
    { itemId: 'mushroom_spores',   baseQuantity: { min: 0, max: 1 }, chance: 0.2 },
    { itemId: 'rare_mushroom',     baseQuantity: { min: 1, max: 1 }, chance: 0.05 }, // Valuable!
  ],
  harvestTime: 2,
  regrowsAfterHarvest: true,
  regrowthTime: 240, // 4 minutes
  destroyedOnHarvest: false,

  isWildlifeFood: true,
  foodValue: 25,

  modelId: 'plant_mushroom',
  stageModels: {
    seed:      'plant_mushroom_tiny',
    sprout:    'plant_mushroom_tiny',
    growing:   'plant_mushroom_small',
    mature:    'plant_mushroom',
    flowering: 'plant_mushroom',
    withering: 'plant_mushroom_old',
    dead:      'plant_mushroom_dead',
  },
};

export const mushroomSpawnConfig: PlantSpawnConfig = {
  speciesId: 'mushroom',
  biomes: ['forest', 'swamp', 'underground'],
  spawnChance: 0.35,
  maxPerZone: 40,
  minDistanceBetween: 3,
  clusterSize: { min: 2, max: 6 },
  clusterRadius: 4,
};
