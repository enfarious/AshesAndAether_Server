/**
 * Wildlife & Flora System
 *
 * Provides emergent ecology with:
 * - Animals (predator/prey/hybrid behaviors)
 * - Plants (harvestable resources)
 * - Needs-based AI (hunger, thirst, safety, reproduction)
 * - Biome-specific spawning and comfort
 */

// Core types
export * from './types';

// Wildlife management
export { WildlifeManager } from './WildlifeManager';
export * from './WildlifeBehavior';

// Species registry
export {
  getSpecies,
  getSpawnConfig,
  getAllSpecies,
  getAllSpawnConfigs,
  getSpeciesForBiome,
} from './species';

// Flora types
export type {
  PlantSpecies,
  PlantEntity,
  PlantGrowthStage,
  PlantSpawnConfig,
  PlantEvent,
  PlantEventType,
} from './flora/types';

// Flora management
export { FloraManager } from './flora/FloraManager';

// Plant species registry
export {
  getPlantSpecies,
  getPlantSpawnConfig,
  getAllPlantSpecies,
  getAllPlantSpawnConfigs,
  getPlantsForBiome,
} from './flora/species';
