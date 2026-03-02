/**
 * Plant Species Registry
 */

import type { PlantSpecies, PlantSpawnConfig } from '../types';
import { grass,      grassSpawnConfig      } from './grass';
import { clover,     cloverSpawnConfig     } from './clover';
import { sage,       sageSpawnConfig       } from './sage';
import { carrot,     carrotSpawnConfig     } from './carrot';
import { potato,     potatoSpawnConfig     } from './potato';
import { onion,      onionSpawnConfig      } from './onion';
import { garlic,     garlicSpawnConfig     } from './garlic';
import { appleTree,  appleTreeSpawnConfig  } from './apple_tree';
import { pearTree,   pearTreeSpawnConfig   } from './pear_tree';
import { mushroom,   mushroomSpawnConfig   } from './mushroom';
import { berryBush,  berryBushSpawnConfig  } from './berry_bush';

const PLANT_REGISTRY: Map<string, PlantSpecies> = new Map();
const PLANT_SPAWN_CONFIGS: Map<string, PlantSpawnConfig> = new Map();

function registerPlant(species: PlantSpecies, spawnConfig: PlantSpawnConfig): void {
  PLANT_REGISTRY.set(species.id, species);
  PLANT_SPAWN_CONFIGS.set(species.id, spawnConfig);
}

// Register all plants
registerPlant(grass,     grassSpawnConfig);
registerPlant(clover,    cloverSpawnConfig);
registerPlant(sage,      sageSpawnConfig);
registerPlant(carrot,    carrotSpawnConfig);
registerPlant(potato,    potatoSpawnConfig);
registerPlant(onion,     onionSpawnConfig);
registerPlant(garlic,    garlicSpawnConfig);
registerPlant(appleTree, appleTreeSpawnConfig);
registerPlant(pearTree,  pearTreeSpawnConfig);
registerPlant(mushroom,  mushroomSpawnConfig);
registerPlant(berryBush, berryBushSpawnConfig);

export function getPlantSpecies(speciesId: string): PlantSpecies | undefined {
  return PLANT_REGISTRY.get(speciesId);
}

export function getPlantSpawnConfig(speciesId: string): PlantSpawnConfig | undefined {
  return PLANT_SPAWN_CONFIGS.get(speciesId);
}

export function getAllPlantSpecies(): PlantSpecies[] {
  return Array.from(PLANT_REGISTRY.values());
}

export function getAllPlantSpawnConfigs(): PlantSpawnConfig[] {
  return Array.from(PLANT_SPAWN_CONFIGS.values());
}

export function getPlantsForBiome(biome: string): PlantSpecies[] {
  const result: PlantSpecies[] = [];
  for (const [speciesId, config] of PLANT_SPAWN_CONFIGS) {
    if (config.biomes.includes(biome as never)) {
      const species = PLANT_REGISTRY.get(speciesId);
      if (species) result.push(species);
    }
  }
  return result;
}

export { grass, grassSpawnConfig } from './grass';
export { clover, cloverSpawnConfig } from './clover';
export { sage, sageSpawnConfig } from './sage';
export { carrot, carrotSpawnConfig } from './carrot';
export { potato, potatoSpawnConfig } from './potato';
export { onion, onionSpawnConfig } from './onion';
export { garlic, garlicSpawnConfig } from './garlic';
export { appleTree, appleTreeSpawnConfig } from './apple_tree';
export { pearTree, pearTreeSpawnConfig } from './pear_tree';
export { mushroom, mushroomSpawnConfig } from './mushroom';
export { berryBush, berryBushSpawnConfig } from './berry_bush';
