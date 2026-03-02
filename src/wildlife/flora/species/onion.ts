/**
 * Wild Onion - Pungent bulb, grows in open ground
 */

import type { PlantSpecies, PlantSpawnConfig } from '../types';

export const onion: PlantSpecies = {
  id: 'onion',
  name: 'Wild Onion',
  description: 'Thin green shoots betray this pungent bulb. Strong enough to ward off more than vampires.',
  plantType: 'crop',

  growthStages: [
    { stage: 'seed',     durationSeconds: 30,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'sprout',   durationSeconds: 75,  canHarvest: false, yieldMultiplier: 0   },
    { stage: 'growing',  durationSeconds: 120, canHarvest: false, yieldMultiplier: 0   },
    { stage: 'mature',   durationSeconds: 480, canHarvest: true,  yieldMultiplier: 1.0 },
    { stage: 'withering',durationSeconds: 180, canHarvest: true,  yieldMultiplier: 0.5 },
  ],
  totalGrowthTime: 350,

  biomePreferences: [
    { biome: 'grassland', growthMultiplier: 1.2, spawnWeight: 5 },
    { biome: 'forest',    growthMultiplier: 0.9, spawnWeight: 3 },
    { biome: 'mountain',  growthMultiplier: 1.0, spawnWeight: 4 },
    { biome: 'coastal',   growthMultiplier: 0.8, spawnWeight: 2 },
  ],
  requiresWater: false,
  lightRequirement: 'full_sun',

  harvestItems: [
    { itemId: 'onion', baseQuantity: { min: 1, max: 2 }, chance: 1.0 },
    { itemId: 'onion_seed', baseQuantity: { min: 0, max: 3 }, chance: 0.4 },
  ],
  harvestTime: 3,
  regrowsAfterHarvest: true,
  regrowthTime: 300, // 5 minutes
  destroyedOnHarvest: false,

  isWildlifeFood: true,
  foodValue: 20,

  modelId: 'plant_onion',
};

export const onionSpawnConfig: PlantSpawnConfig = {
  speciesId: 'onion',
  biomes: ['grassland', 'forest', 'mountain'],
  spawnChance: 0.2,
  maxPerZone: 25,
  minDistanceBetween: 4,
  clusterSize: { min: 3, max: 6 },
  clusterRadius: 5,
};
