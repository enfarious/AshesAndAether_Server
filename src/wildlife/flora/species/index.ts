/**
 * Plant Species Registry
 */

import type { PlantSpecies, PlantSpawnConfig } from '../types';
import { grass, grassSpawnConfig } from './grass';
import { clover, cloverSpawnConfig } from './clover';
import { sage, sageSpawnConfig } from './sage';

const PLANT_REGISTRY: Map<string, PlantSpecies> = new Map();
const PLANT_SPAWN_CONFIGS: Map<string, PlantSpawnConfig> = new Map();

function registerPlant(species: PlantSpecies, spawnConfig: PlantSpawnConfig): void {
  PLANT_REGISTRY.set(species.id, species);
  PLANT_SPAWN_CONFIGS.set(species.id, spawnConfig);
}

// Register all plants
registerPlant(grass, grassSpawnConfig);
registerPlant(clover, cloverSpawnConfig);
registerPlant(sage, sageSpawnConfig);

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
