/**
 * Flora Manager
 *
 * Manages all plant entities in a zone:
 * - Spawning based on biome
 * - Growth stage progression
 * - Harvesting by players
 * - Being eaten by wildlife
 * - Respawning after harvest/death
 */

import type {
  PlantEntity,
  PlantSpecies,
  PlantSpawnConfig,
  PlantEvent,
} from './types';
import type { BiomeType } from '../types';
import type { Vector3 } from '@/network/protocol/types';
import { getPlantSpecies, getAllPlantSpawnConfigs } from './species';

// ========== Configuration ==========

const GROWTH_UPDATE_INTERVAL_MS = 5000;   // Update growth every 5s
const SPAWN_CHECK_INTERVAL_MS = 60000;    // Check for spawns every 60s

// ========== Flora Manager ==========

export class FloraManager {
  private plants: Map<string, PlantEntity> = new Map();
  private species: Map<string, PlantSpecies> = new Map();
  private zoneId: string;
  private zoneBiome: BiomeType;

  // Timing
  private lastGrowthUpdateAt = 0;
  private lastSpawnCheckAt = 0;

  // Callbacks
  private onPlantUpdate?: (plant: PlantEntity) => void;
  private onPlantSpawn?: (plant: PlantEntity) => void;
  private onPlantHarvest?: (plant: PlantEntity, harvesterId: string, items: Array<{ itemId: string; quantity: number }>) => void;
  private onEvent?: (event: PlantEvent) => void;

  constructor(zoneId: string, zoneBiome: BiomeType) {
    this.zoneId = zoneId;
    this.zoneBiome = zoneBiome;
  }

  // ========== Configuration ==========

  setCallbacks(callbacks: {
    onPlantUpdate?: (plant: PlantEntity) => void;
    onPlantSpawn?: (plant: PlantEntity) => void;
    onPlantHarvest?: (plant: PlantEntity, harvesterId: string, items: Array<{ itemId: string; quantity: number }>) => void;
    onEvent?: (event: PlantEvent) => void;
  }): void {
    this.onPlantUpdate = callbacks.onPlantUpdate;
    this.onPlantSpawn = callbacks.onPlantSpawn;
    this.onPlantHarvest = callbacks.onPlantHarvest;
    this.onEvent = callbacks.onEvent;
  }

  // ========== Main Update Loop ==========

  update(_deltaTime: number, now: number): void {
    // Update growth stages
    if (now - this.lastGrowthUpdateAt >= GROWTH_UPDATE_INTERVAL_MS) {
      this.updateGrowth(now);
      this.lastGrowthUpdateAt = now;
    }

    // Check for spawns
    if (now - this.lastSpawnCheckAt >= SPAWN_CHECK_INTERVAL_MS) {
      this.checkSpawns(now);
      this.lastSpawnCheckAt = now;
    }
  }

  // ========== Growth Updates ==========

  private updateGrowth(now: number): void {
    for (const plant of this.plants.values()) {
      if (!plant.isAlive) continue;

      const species = this.getSpeciesForPlant(plant);
      if (!species) continue;

      this.updatePlantGrowth(plant, species, now);
    }
  }

  private updatePlantGrowth(plant: PlantEntity, species: PlantSpecies, now: number): void {
    const currentStageIndex = species.growthStages.findIndex(s => s.stage === plant.currentStage);
    if (currentStageIndex === -1) return;

    const currentStageConfig = species.growthStages[currentStageIndex];
    const timeInStage = (now - plant.stageStartedAt) / 1000;

    // Calculate growth multiplier from biome
    const biomePref = species.biomePreferences.find(p => p.biome === this.zoneBiome);
    const growthMultiplier = biomePref?.growthMultiplier ?? 1.0;

    // Adjust duration by growth multiplier
    const adjustedDuration = currentStageConfig.durationSeconds / growthMultiplier;

    // Update progress
    plant.growthProgress = Math.min(100, (timeInStage / adjustedDuration) * 100);

    // Check for stage transition
    if (timeInStage >= adjustedDuration) {
      const nextStageIndex = currentStageIndex + 1;

      if (nextStageIndex < species.growthStages.length) {
        // Advance to next stage
        const nextStage = species.growthStages[nextStageIndex];
        plant.currentStage = nextStage.stage;
        plant.stageStartedAt = now;
        plant.growthProgress = 0;

        this.onEvent?.({
          type: 'plant_grow',
          plantId: plant.id,
          speciesId: plant.speciesId,
          position: plant.position,
          zoneId: this.zoneId,
          timestamp: now,
          data: { newStage: nextStage.stage },
        });

        this.onPlantUpdate?.(plant);
      } else {
        // Plant has reached end of lifecycle (withering -> dead)
        if (plant.currentStage === 'withering') {
          plant.currentStage = 'dead';
          plant.isAlive = false;

          this.onEvent?.({
            type: 'plant_death',
            plantId: plant.id,
            speciesId: plant.speciesId,
            position: plant.position,
            zoneId: this.zoneId,
            timestamp: now,
          });

          // Schedule removal and potential respawn
          setTimeout(() => {
            this.plants.delete(plant.id);
          }, 30000); // Remove after 30 seconds
        }
      }
    }
  }

  // ========== Spawning ==========

  private checkSpawns(now: number): void {
    const spawnConfigs = getAllPlantSpawnConfigs();

    for (const config of spawnConfigs) {
      if (!config.biomes.includes(this.zoneBiome)) continue;

      // Check current count
      const currentCount = this.countSpecies(config.speciesId);
      if (currentCount >= config.maxPerZone) continue;

      // Roll for spawn
      if (Math.random() > config.spawnChance) continue;

      // Spawn cluster or single
      if (config.clusterSize) {
        this.spawnCluster(config, now);
      } else {
        const position = this.findSpawnPosition(config);
        if (position) {
          this.spawnPlant(config.speciesId, position, now);
        }
      }
    }
  }

  private spawnCluster(config: PlantSpawnConfig, now: number): void {
    if (!config.clusterSize || !config.clusterRadius) return;

    const centerPosition = this.findSpawnPosition(config);
    if (!centerPosition) return;

    const clusterCount = Math.floor(
      Math.random() * (config.clusterSize.max - config.clusterSize.min + 1) +
      config.clusterSize.min
    );

    // Spawn center plant
    this.spawnPlant(config.speciesId, centerPosition, now);

    // Spawn surrounding plants
    for (let i = 1; i < clusterCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.random() * config.clusterRadius;

      const position: Vector3 = {
        x: centerPosition.x + Math.cos(angle) * distance,
        y: centerPosition.y,
        z: centerPosition.z + Math.sin(angle) * distance,
      };

      // Check minimum distance
      let tooClose = false;
      for (const plant of this.plants.values()) {
        if (this.calculateDistance(position, plant.position) < config.minDistanceBetween) {
          tooClose = true;
          break;
        }
      }

      if (!tooClose) {
        this.spawnPlant(config.speciesId, position, now);
      }
    }
  }

  spawnPlant(speciesId: string, position: Vector3, now: number, startMature = false): PlantEntity | null {
    const species = getPlantSpecies(speciesId);
    if (!species) return null;

    const id = `plant_${speciesId}_${now}_${Math.random().toString(36).substr(2, 9)}`;

    const startStage = startMature ? 'mature' : 'seed';

    const plant: PlantEntity = {
      id,
      speciesId,
      position,
      zoneId: this.zoneId,
      currentStage: startStage,
      stageStartedAt: now,
      growthProgress: 0,
      isAlive: true,
      timesHarvested: 0,
      spawnedAt: now,
    };

    this.plants.set(id, plant);
    this.onPlantSpawn?.(plant);

    this.onEvent?.({
      type: 'plant_spawn',
      plantId: id,
      speciesId,
      position,
      zoneId: this.zoneId,
      timestamp: now,
    });

    return plant;
  }

  private findSpawnPosition(config: PlantSpawnConfig): Vector3 | null {
    const attempts = 10;

    for (let i = 0; i < attempts; i++) {
      const position: Vector3 = {
        x: (Math.random() - 0.5) * 200,
        y: 0,
        z: (Math.random() - 0.5) * 200,
      };

      // Check minimum distance from same species
      let tooClose = false;
      for (const plant of this.plants.values()) {
        if (plant.speciesId !== config.speciesId) continue;
        if (this.calculateDistance(position, plant.position) < config.minDistanceBetween) {
          tooClose = true;
          break;
        }
      }

      if (!tooClose) return position;
    }

    return null;
  }

  // ========== Harvesting ==========

  harvest(plantId: string, harvesterId: string): Array<{ itemId: string; quantity: number }> | null {
    const plant = this.plants.get(plantId);
    if (!plant || !plant.isAlive) return null;

    const species = this.getSpeciesForPlant(plant);
    if (!species) return null;

    // Check if harvestable at current stage
    const stageConfig = species.growthStages.find(s => s.stage === plant.currentStage);
    if (!stageConfig || !stageConfig.canHarvest) return null;

    const now = Date.now();

    // Calculate items to yield
    const items: Array<{ itemId: string; quantity: number }> = [];

    for (const harvestItem of species.harvestItems) {
      // Check stage requirement
      if (harvestItem.requiresStage && harvestItem.requiresStage !== plant.currentStage) {
        continue;
      }

      // Roll for chance
      if (Math.random() > harvestItem.chance) continue;

      // Calculate quantity with yield multiplier
      const baseQty = Math.floor(
        Math.random() * (harvestItem.baseQuantity.max - harvestItem.baseQuantity.min + 1) +
        harvestItem.baseQuantity.min
      );
      const quantity = Math.max(1, Math.floor(baseQty * stageConfig.yieldMultiplier));

      if (quantity > 0) {
        items.push({ itemId: harvestItem.itemId, quantity });
      }
    }

    // Update plant state
    plant.timesHarvested++;
    plant.lastHarvestedAt = now;
    plant.lastHarvestedBy = harvesterId;

    if (species.destroyedOnHarvest) {
      plant.isAlive = false;
      plant.currentStage = 'dead';
    } else if (species.regrowsAfterHarvest) {
      // Reset to growing stage
      plant.currentStage = 'growing';
      plant.stageStartedAt = now;
      plant.growthProgress = 0;
    }

    this.onEvent?.({
      type: 'plant_harvest',
      plantId: plant.id,
      speciesId: plant.speciesId,
      position: plant.position,
      zoneId: this.zoneId,
      timestamp: now,
      data: { harvesterId, items },
    });

    this.onPlantHarvest?.(plant, harvesterId, items);
    this.onPlantUpdate?.(plant);

    return items;
  }

  // ========== Wildlife Eating ==========

  eatPlant(plantId: string, wildlifeId: string): number {
    const plant = this.plants.get(plantId);
    if (!plant || !plant.isAlive) return 0;

    const species = this.getSpeciesForPlant(plant);
    if (!species || !species.isWildlifeFood) return 0;

    // Check if edible at current stage
    const stageConfig = species.growthStages.find(s => s.stage === plant.currentStage);
    if (!stageConfig || !stageConfig.canHarvest) return 0;

    const now = Date.now();
    const foodValue = species.foodValue * stageConfig.yieldMultiplier;

    // Eating damages the plant more than harvesting
    if (species.destroyedOnHarvest || Math.random() < 0.3) {
      plant.isAlive = false;
      plant.currentStage = 'dead';
    } else {
      // Set back growth
      const previousStageIndex = species.growthStages.findIndex(s => s.stage === plant.currentStage) - 1;
      if (previousStageIndex >= 0) {
        plant.currentStage = species.growthStages[previousStageIndex].stage;
        plant.stageStartedAt = now;
        plant.growthProgress = 0;
      }
    }

    this.onEvent?.({
      type: 'plant_eaten',
      plantId: plant.id,
      speciesId: plant.speciesId,
      position: plant.position,
      zoneId: this.zoneId,
      timestamp: now,
      data: { wildlifeId, foodValue },
    });

    this.onPlantUpdate?.(plant);

    return foodValue;
  }

  // ========== Helpers ==========

  private getSpeciesForPlant(plant: PlantEntity): PlantSpecies | undefined {
    let species = this.species.get(plant.speciesId);
    if (!species) {
      species = getPlantSpecies(plant.speciesId);
      if (species) this.species.set(plant.speciesId, species);
    }
    return species;
  }

  private calculateDistance(a: Vector3, b: Vector3): number {
    return Math.sqrt(
      Math.pow(a.x - b.x, 2) +
      Math.pow(a.y - b.y, 2) +
      Math.pow(a.z - b.z, 2)
    );
  }

  private countSpecies(speciesId: string): number {
    let count = 0;
    for (const plant of this.plants.values()) {
      if (plant.speciesId === speciesId && plant.isAlive) count++;
    }
    return count;
  }

  // ========== Public API ==========

  getPlant(plantId: string): PlantEntity | undefined {
    return this.plants.get(plantId);
  }

  getAllPlants(): PlantEntity[] {
    return Array.from(this.plants.values());
  }

  getAlivePlants(): PlantEntity[] {
    return Array.from(this.plants.values()).filter(p => p.isAlive);
  }

  getPlantsNear(position: Vector3, range: number): PlantEntity[] {
    const result: PlantEntity[] = [];
    for (const plant of this.plants.values()) {
      if (!plant.isAlive) continue;
      if (this.calculateDistance(position, plant.position) <= range) {
        result.push(plant);
      }
    }
    return result;
  }

  getHarvestablePlantsNear(position: Vector3, range: number): PlantEntity[] {
    const result: PlantEntity[] = [];
    for (const plant of this.plants.values()) {
      if (!plant.isAlive) continue;
      if (this.calculateDistance(position, plant.position) > range) continue;

      const species = this.getSpeciesForPlant(plant);
      if (!species) continue;

      const stageConfig = species.growthStages.find(s => s.stage === plant.currentStage);
      if (stageConfig?.canHarvest) {
        result.push(plant);
      }
    }
    return result;
  }

  /**
   * Get plants that wildlife can eat
   */
  getEdiblePlantsForWildlife(): Array<{ id: string; position: Vector3; plantType: string }> {
    const result: Array<{ id: string; position: Vector3; plantType: string }> = [];

    for (const plant of this.plants.values()) {
      if (!plant.isAlive) continue;

      const species = this.getSpeciesForPlant(plant);
      if (!species || !species.isWildlifeFood) continue;

      const stageConfig = species.growthStages.find(s => s.stage === plant.currentStage);
      if (!stageConfig?.canHarvest) continue;

      result.push({
        id: plant.id,
        position: plant.position,
        plantType: plant.speciesId,
      });
    }

    return result;
  }
}
