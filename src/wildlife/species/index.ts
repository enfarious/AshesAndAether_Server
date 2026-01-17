/**
 * Wildlife Species Definitions
 *
 * Modular species registry - each species is defined separately
 * and registered here for lookup.
 */

import type { WildlifeSpecies, WildlifeSpawnConfig } from '../types';
import { rabbit, rabbitSpawnConfig } from './rabbit';
import { fox, foxSpawnConfig } from './fox';

// Species registry - add new species here
const SPECIES_REGISTRY: Map<string, WildlifeSpecies> = new Map();
const SPAWN_CONFIGS: Map<string, WildlifeSpawnConfig> = new Map();

// Register all species
function registerSpecies(species: WildlifeSpecies, spawnConfig: WildlifeSpawnConfig): void {
  SPECIES_REGISTRY.set(species.id, species);
  SPAWN_CONFIGS.set(species.id, spawnConfig);
}

// Initialize registry
registerSpecies(rabbit, rabbitSpawnConfig);
registerSpecies(fox, foxSpawnConfig);

/**
 * Get a species definition by ID
 */
export function getSpecies(speciesId: string): WildlifeSpecies | undefined {
  return SPECIES_REGISTRY.get(speciesId);
}

/**
 * Get spawn config for a species
 */
export function getSpawnConfig(speciesId: string): WildlifeSpawnConfig | undefined {
  return SPAWN_CONFIGS.get(speciesId);
}

/**
 * Get all registered species
 */
export function getAllSpecies(): WildlifeSpecies[] {
  return Array.from(SPECIES_REGISTRY.values());
}

/**
 * Get all spawn configs
 */
export function getAllSpawnConfigs(): WildlifeSpawnConfig[] {
  return Array.from(SPAWN_CONFIGS.values());
}

/**
 * Get species that can spawn in a given biome
 */
export function getSpeciesForBiome(biome: string): WildlifeSpecies[] {
  const result: WildlifeSpecies[] = [];
  for (const [speciesId, config] of SPAWN_CONFIGS) {
    if (config.biomes.includes(biome as never)) {
      const species = SPECIES_REGISTRY.get(speciesId);
      if (species) result.push(species);
    }
  }
  return result;
}

// Re-export individual species for direct import
export { rabbit, rabbitSpawnConfig } from './rabbit';
export { fox, foxSpawnConfig } from './fox';
