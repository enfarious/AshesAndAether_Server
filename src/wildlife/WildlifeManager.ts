/**
 * Wildlife Manager
 *
 * Manages all wildlife entities in a zone:
 * - Spawning based on biome and time
 * - Updating needs and behaviors
 * - Processing movement and combat
 * - Handling death and respawning
 */

import type {
  WildlifeEntity,
  WildlifeSpecies,
  BiomeType,
  WildlifeEvent,
} from './types';
import {
  selectBehavior,
  isThreat,
  isPrey,
  calculateFleeDirection,
  calculateApproachDirection,
  calculateWanderDirection,
  type PerceivedEntity,
  type EnvironmentContext,
} from './WildlifeBehavior';
import { getSpecies, getAllSpawnConfigs } from './species';
import type { Vector3 } from '@/network/protocol/types';

// ========== Configuration ==========

const WILDLIFE_UPDATE_INTERVAL_MS = 500;  // Update wildlife every 500ms
const BEHAVIOR_UPDATE_INTERVAL_MS = 2000; // Re-evaluate behavior every 2s
const SPAWN_CHECK_INTERVAL_MS = 30000;    // Check for spawns every 30s
const NEED_UPDATE_INTERVAL_MS = 1000;     // Update needs every 1s

// ========== Wildlife Manager ==========

export class WildlifeManager {
  private entities: Map<string, WildlifeEntity> = new Map();
  private species: Map<string, WildlifeSpecies> = new Map();
  private zoneId: string;
  private zoneBiome: BiomeType;

  // Timing
  private lastUpdateAt = 0;
  private lastBehaviorUpdateAt = 0;
  private lastSpawnCheckAt = 0;
  private lastNeedUpdateAt = 0;

  // Callbacks for integration with world
  private onEntityUpdate?: (entity: WildlifeEntity) => void;
  private onEntitySpawn?: (entity: WildlifeEntity) => void;
  private onEntityDeath?: (entity: WildlifeEntity, killerId?: string) => void;
  private onEvent?: (event: WildlifeEvent) => void;

  // External data providers
  private getPlayersInRange?: (position: Vector3, range: number) => Array<{ id: string; position: Vector3 }>;
  private getTimeOfDay?: () => number;
  private getWaterSources?: () => Array<{ id: string; position: Vector3 }>;
  private getPlants?: () => Array<{ id: string; position: Vector3; plantType: string }>;

  constructor(zoneId: string, zoneBiome: BiomeType) {
    this.zoneId = zoneId;
    this.zoneBiome = zoneBiome;
  }

  // ========== Configuration ==========

  setCallbacks(callbacks: {
    onEntityUpdate?: (entity: WildlifeEntity) => void;
    onEntitySpawn?: (entity: WildlifeEntity) => void;
    onEntityDeath?: (entity: WildlifeEntity, killerId?: string) => void;
    onEvent?: (event: WildlifeEvent) => void;
  }): void {
    this.onEntityUpdate = callbacks.onEntityUpdate;
    this.onEntitySpawn = callbacks.onEntitySpawn;
    this.onEntityDeath = callbacks.onEntityDeath;
    this.onEvent = callbacks.onEvent;
  }

  setDataProviders(providers: {
    getPlayersInRange?: (position: Vector3, range: number) => Array<{ id: string; position: Vector3 }>;
    getTimeOfDay?: () => number;
    getWaterSources?: () => Array<{ id: string; position: Vector3 }>;
    getPlants?: () => Array<{ id: string; position: Vector3; plantType: string }>;
  }): void {
    this.getPlayersInRange = providers.getPlayersInRange;
    this.getTimeOfDay = providers.getTimeOfDay;
    this.getWaterSources = providers.getWaterSources;
    this.getPlants = providers.getPlants;
  }

  // ========== Main Update Loop ==========

  update(deltaTime: number, now: number): void {
    // Update needs (every 1s)
    if (now - this.lastNeedUpdateAt >= NEED_UPDATE_INTERVAL_MS) {
      this.updateAllNeeds(deltaTime);
      this.lastNeedUpdateAt = now;
    }

    // Update behaviors (every 2s)
    if (now - this.lastBehaviorUpdateAt >= BEHAVIOR_UPDATE_INTERVAL_MS) {
      this.updateAllBehaviors(now);
      this.lastBehaviorUpdateAt = now;
    }

    // Update positions/actions (every 500ms)
    if (now - this.lastUpdateAt >= WILDLIFE_UPDATE_INTERVAL_MS) {
      this.updateAllEntities(deltaTime, now);
      this.lastUpdateAt = now;
    }

    // Check for spawns (every 30s)
    if (now - this.lastSpawnCheckAt >= SPAWN_CHECK_INTERVAL_MS) {
      this.checkSpawns(now);
      this.lastSpawnCheckAt = now;
    }
  }

  // ========== Need Updates ==========

  private updateAllNeeds(deltaTime: number): void {
    for (const entity of this.entities.values()) {
      if (!entity.isAlive) continue;

      const species = this.getSpeciesForEntity(entity);
      if (!species) continue;

      this.updateEntityNeeds(entity, species, deltaTime);
    }
  }

  private updateEntityNeeds(entity: WildlifeEntity, species: WildlifeSpecies, deltaTime: number): void {
    const rates = species.needDecayRates;
    const dt = deltaTime;

    // Decay needs over time
    entity.needs.hunger = Math.max(0, entity.needs.hunger - rates.hunger * dt);
    entity.needs.thirst = Math.max(0, entity.needs.thirst - rates.thirst * dt);

    // Energy depends on activity
    let energyDrain = rates.energy;
    if (entity.currentBehavior === 'fleeing' || entity.currentBehavior === 'hunting') {
      energyDrain *= 3; // High activity drains more
    } else if (entity.currentBehavior === 'resting') {
      energyDrain = -0.2; // Resting recovers energy
    }
    entity.needs.energy = Math.max(0, Math.min(100, entity.needs.energy - energyDrain * dt));

    // Reproduction urge increases when needs are met
    if (entity.needs.hunger > 50 && entity.needs.thirst > 50 && entity.needs.energy > 40) {
      entity.needs.reproduction = Math.min(100, entity.needs.reproduction - rates.reproduction * dt);
    }

    // Starvation/dehydration damage
    if (entity.needs.hunger <= 0) {
      entity.currentHealth -= 1; // Starving
    }
    if (entity.needs.thirst <= 0) {
      entity.currentHealth -= 2; // Dehydration is faster
    }

    // Check for death
    if (entity.currentHealth <= 0) {
      this.killEntity(entity.id, undefined, 'starvation');
    }
  }

  // ========== Behavior Updates ==========

  private updateAllBehaviors(now: number): void {
    for (const entity of this.entities.values()) {
      if (!entity.isAlive) continue;

      const species = this.getSpeciesForEntity(entity);
      if (!species) continue;

      this.updateEntityBehavior(entity, species, now);
    }
  }

  private updateEntityBehavior(entity: WildlifeEntity, species: WildlifeSpecies, now: number): void {
    const context = this.buildEnvironmentContext(entity, species);
    const decision = selectBehavior(entity, species, context);

    entity.currentBehavior = decision.behavior;
    entity.targetEntityId = decision.targetId;
    entity.lastUpdateAt = now;
  }

  private buildEnvironmentContext(entity: WildlifeEntity, species: WildlifeSpecies): EnvironmentContext {
    const nearbyEntities = this.perceiveNearbyEntities(entity, species);
    const timeOfDay = this.getTimeOfDay?.() ?? 12;

    // Find biome comfort
    const biomePref = species.biomePreferences.find(p => p.biome === this.zoneBiome);
    const biomeComfort = biomePref?.comfort ?? 30;

    // Categorize perceived entities
    let nearestThreat: PerceivedEntity | undefined;
    let nearestPrey: PerceivedEntity | undefined;
    let nearestFood: PerceivedEntity | undefined;
    let nearestWater: PerceivedEntity | undefined;
    let nearestMate: PerceivedEntity | undefined;

    for (const perceived of nearbyEntities) {
      if (perceived.isThreat && (!nearestThreat || perceived.distance < nearestThreat.distance)) {
        nearestThreat = perceived;
      }
      if (perceived.isPrey && (!nearestPrey || perceived.distance < nearestPrey.distance)) {
        nearestPrey = perceived;
      }
      if (perceived.isFood && (!nearestFood || perceived.distance < nearestFood.distance)) {
        nearestFood = perceived;
      }
      if (perceived.entityType === 'water' && (!nearestWater || perceived.distance < nearestWater.distance)) {
        nearestWater = perceived;
      }
      if (perceived.isMate && (!nearestMate || perceived.distance < nearestMate.distance)) {
        nearestMate = perceived;
      }
    }

    return {
      currentBiome: this.zoneBiome,
      biomeComfort,
      timeOfDay,
      isNight: timeOfDay < 6 || timeOfDay > 20,
      nearbyEntities,
      nearestThreat,
      nearestPrey,
      nearestFood,
      nearestWater,
      nearestMate,
    };
  }

  private perceiveNearbyEntities(entity: WildlifeEntity, species: WildlifeSpecies): PerceivedEntity[] {
    const perceived: PerceivedEntity[] = [];
    const maxRange = Math.max(species.sightRange, species.hearingRange, species.smellRange);

    // Perceive other wildlife
    for (const other of this.entities.values()) {
      if (other.id === entity.id) continue;
      if (!other.isAlive) continue;

      const distance = this.calculateDistance(entity.position, other.position);
      if (distance > maxRange) continue;

      const otherSpecies = this.getSpeciesForEntity(other);
      if (!otherSpecies) continue;

      const threatCheck = isThreat(species, otherSpecies.sizeClass, otherSpecies.dietType);
      const preyCheck = isPrey(species, otherSpecies.sizeClass, otherSpecies.dietType);
      const mateCheck = other.speciesId === entity.speciesId && other.isMature && !other.isPregnant;

      perceived.push({
        id: other.id,
        position: other.position,
        distance,
        entityType: 'wildlife',
        sizeClass: otherSpecies.sizeClass,
        dietType: otherSpecies.dietType,
        speciesId: other.speciesId,
        isAlive: true,
        isThreat: threatCheck,
        isPrey: preyCheck,
        isFood: false, // Dead wildlife would be food for carnivores
        isMate: mateCheck,
      });
    }

    // Perceive players (always potential threats)
    const players = this.getPlayersInRange?.(entity.position, maxRange) ?? [];
    for (const player of players) {
      const distance = this.calculateDistance(entity.position, player.position);
      perceived.push({
        id: player.id,
        position: player.position,
        distance,
        entityType: 'player',
        sizeClass: 'medium',
        isAlive: true,
        isThreat: isThreat(species, 'medium', 'player'),
        isPrey: false,
        isFood: false,
        isMate: false,
      });
    }

    // Perceive water sources
    const waterSources = this.getWaterSources?.() ?? [];
    for (const water of waterSources) {
      const distance = this.calculateDistance(entity.position, water.position);
      if (distance > species.smellRange) continue;

      perceived.push({
        id: water.id,
        position: water.position,
        distance,
        entityType: 'water',
        isAlive: true,
        isThreat: false,
        isPrey: false,
        isFood: false,
        isMate: false,
      });
    }

    // Perceive plants (food for herbivores)
    if (species.isHerbivore) {
      const plants = this.getPlants?.() ?? [];
      for (const plant of plants) {
        const distance = this.calculateDistance(entity.position, plant.position);
        if (distance > species.smellRange) continue;

        const isEdible = species.preferredFood.includes(plant.plantType);
        perceived.push({
          id: plant.id,
          position: plant.position,
          distance,
          entityType: 'plant',
          isAlive: true,
          isThreat: false,
          isPrey: false,
          isFood: isEdible,
          isMate: false,
        });
      }
    }

    return perceived;
  }

  // ========== Entity Updates (Movement/Actions) ==========

  private updateAllEntities(deltaTime: number, now: number): void {
    for (const entity of this.entities.values()) {
      if (!entity.isAlive) continue;

      const species = this.getSpeciesForEntity(entity);
      if (!species) continue;

      this.updateEntityPosition(entity, species, deltaTime, now);
      this.updateEntityAge(entity, species, deltaTime, now);
    }
  }

  private updateEntityPosition(entity: WildlifeEntity, species: WildlifeSpecies, deltaTime: number, now: number): void {
    let speed = 0;
    let heading = entity.heading;

    switch (entity.currentBehavior) {
      case 'fleeing': {
        speed = species.baseSpeed * species.fleeSpeedMultiplier;
        // Flee away from target
        if (entity.targetEntityId) {
          const target = this.entities.get(entity.targetEntityId) ??
            this.findPlayerPosition(entity.targetEntityId);
          if (target) {
            heading = calculateFleeDirection(entity.position, target.position);
          }
        }
        break;
      }

      case 'hunting':
      case 'stalking': {
        speed = entity.currentBehavior === 'stalking' ? species.baseSpeed * 0.5 : species.baseSpeed;
        if (entity.targetEntityId) {
          const prey = this.entities.get(entity.targetEntityId);
          if (prey) {
            heading = calculateApproachDirection(entity.position, prey.position);
            // Check if close enough to attack
            const distance = this.calculateDistance(entity.position, prey.position);
            if (distance <= species.attackRange && now >= entity.attackCooldownUntil) {
              this.performAttack(entity, species, prey, now);
            }
          }
        }
        break;
      }

      case 'foraging':
      case 'wandering':
      case 'seeking_mate': {
        speed = species.baseSpeed * 0.7;
        heading = calculateWanderDirection(entity.position, entity.homePosition, entity.heading);
        break;
      }

      case 'drinking':
      case 'eating':
      case 'resting':
      case 'mating':
      case 'idle':
        speed = 0;
        break;
    }

    if (speed > 0) {
      // Calculate new position
      const radians = heading * (Math.PI / 180);
      const dx = Math.sin(radians) * speed * (deltaTime / 1000);
      const dz = Math.cos(radians) * speed * (deltaTime / 1000);

      entity.lastPosition = { ...entity.position };
      entity.position = {
        x: entity.position.x + dx,
        y: entity.position.y, // TODO: terrain height
        z: entity.position.z + dz,
      };
      entity.heading = heading;

      this.onEntityUpdate?.(entity);
    }

    // Handle behavior-specific updates
    if (entity.currentBehavior === 'drinking') {
      entity.needs.thirst = Math.min(100, entity.needs.thirst + 10 * (deltaTime / 1000));
    }
    if (entity.currentBehavior === 'eating') {
      entity.needs.hunger = Math.min(100, entity.needs.hunger + 5 * (deltaTime / 1000));
    }
  }

  private updateEntityAge(entity: WildlifeEntity, species: WildlifeSpecies, deltaTime: number, now: number): void {
    entity.age += deltaTime / 1000;

    // Check maturity
    if (!entity.isMature && entity.age >= species.maturityTime) {
      entity.isMature = true;
    }

    // Check pregnancy
    if (entity.isPregnant && entity.pregnancyEndsAt && now >= entity.pregnancyEndsAt) {
      this.giveBirth(entity, species, now);
    }
  }

  private performAttack(attacker: WildlifeEntity, attackerSpecies: WildlifeSpecies, target: WildlifeEntity, now: number): void {
    const targetSpecies = this.getSpeciesForEntity(target);
    if (!targetSpecies) return;

    // Simple damage calculation
    const damage = attackerSpecies.attackDamage;
    target.currentHealth -= damage;
    attacker.attackCooldownUntil = now + attackerSpecies.attackCooldown * 1000;

    this.onEvent?.({
      type: 'wildlife_attack',
      entityId: attacker.id,
      speciesId: attacker.speciesId,
      position: attacker.position,
      zoneId: this.zoneId,
      timestamp: now,
      data: { targetId: target.id, damage },
    });

    if (target.currentHealth <= 0) {
      this.killEntity(target.id, attacker.id, 'predation');
      // Attacker gets food
      attacker.needs.hunger = Math.min(100, attacker.needs.hunger + 40);
    }
  }

  private giveBirth(parent: WildlifeEntity, species: WildlifeSpecies, now: number): void {
    const offspringCount = Math.floor(
      Math.random() * (species.offspringCount.max - species.offspringCount.min + 1) +
      species.offspringCount.min
    );

    for (let i = 0; i < offspringCount; i++) {
      // Spawn offspring near parent
      const offset = {
        x: (Math.random() - 0.5) * 4,
        z: (Math.random() - 0.5) * 4,
      };

      const offspring = this.spawnEntity(species.id, {
        x: parent.position.x + offset.x,
        y: parent.position.y,
        z: parent.position.z + offset.z,
      }, now);

      if (offspring) {
        offspring.isMature = false;
        offspring.age = 0;

        this.onEvent?.({
          type: 'wildlife_birth',
          entityId: offspring.id,
          speciesId: offspring.speciesId,
          position: offspring.position,
          zoneId: this.zoneId,
          timestamp: now,
          data: { parentId: parent.id },
        });
      }
    }

    parent.isPregnant = false;
    parent.pregnancyEndsAt = undefined;
    parent.needs.reproduction = 0;
  }

  // ========== Spawning ==========

  private checkSpawns(now: number): void {
    const timeOfDay = this.getTimeOfDay?.() ?? 12;
    const spawnConfigs = getAllSpawnConfigs();

    for (const config of spawnConfigs) {
      if (!config.biomes.includes(this.zoneBiome)) continue;

      // Check time restrictions
      if (config.spawnTime) {
        const { startHour, endHour } = config.spawnTime;
        if (startHour < endHour) {
          if (timeOfDay < startHour || timeOfDay > endHour) continue;
        } else {
          // Wrapping time (e.g., 22-6)
          if (timeOfDay < startHour && timeOfDay > endHour) continue;
        }
      }

      // Check current count
      const currentCount = this.countSpecies(config.speciesId);
      if (currentCount >= config.maxPerZone) continue;

      // Roll for spawn
      if (Math.random() > config.spawnChance) continue;

      // Find spawn position
      const position = this.findSpawnPosition(config.speciesId, config);
      if (!position) continue;

      this.spawnEntity(config.speciesId, position, now);
    }
  }

  spawnEntity(speciesId: string, position: Vector3, now: number): WildlifeEntity | null {
    const species = getSpecies(speciesId);
    if (!species) return null;

    const id = `wildlife_${speciesId}_${now}_${Math.random().toString(36).substr(2, 9)}`;

    const entity: WildlifeEntity = {
      id,
      speciesId,
      name: `a ${species.name.toLowerCase()}`,
      position,
      heading: Math.random() * 360,
      zoneId: this.zoneId,
      currentBiome: this.zoneBiome,
      isAlive: true,
      currentHealth: species.maxHealth,
      maxHealth: species.maxHealth,
      needs: {
        hunger: 70 + Math.random() * 30,
        thirst: 70 + Math.random() * 30,
        energy: 80 + Math.random() * 20,
        safety: 70,
        reproduction: Math.random() * 30,
      },
      currentBehavior: 'idle',
      homePosition: { ...position },
      lastUpdateAt: now,
      attackCooldownUntil: 0,
      fleeingUntil: 0,
      restingUntil: 0,
      isPregnant: false,
      age: species.maturityTime, // Spawn as adult by default
      isMature: true,
      inCombat: false,
      lastHostileAt: 0,
    };

    this.entities.set(id, entity);
    this.onEntitySpawn?.(entity);

    this.onEvent?.({
      type: 'wildlife_spawn',
      entityId: id,
      speciesId,
      position,
      zoneId: this.zoneId,
      timestamp: now,
    });

    return entity;
  }

  private findSpawnPosition(speciesId: string, config: { minDistanceFromPlayers: number; minDistanceBetween: number }): Vector3 | null {
    // Simple random position within zone bounds
    // TODO: Use actual zone bounds and navmesh
    const attempts = 10;

    for (let i = 0; i < attempts; i++) {
      const position = {
        x: (Math.random() - 0.5) * 200, // -100 to 100
        y: 0,
        z: (Math.random() - 0.5) * 200,
      };

      // Check player distance
      const players = this.getPlayersInRange?.(position, config.minDistanceFromPlayers) ?? [];
      if (players.length > 0) continue;

      // Check same-species distance
      let tooClose = false;
      for (const entity of this.entities.values()) {
        if (entity.speciesId !== speciesId) continue;
        const dist = this.calculateDistance(position, entity.position);
        if (dist < config.minDistanceBetween) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      return position;
    }

    return null;
  }

  // ========== Death & Cleanup ==========

  killEntity(entityId: string, killerId?: string, cause?: string): void {
    const entity = this.entities.get(entityId);
    if (!entity || !entity.isAlive) return;

    entity.isAlive = false;
    entity.currentBehavior = 'dead';

    this.onEntityDeath?.(entity, killerId);

    this.onEvent?.({
      type: 'wildlife_death',
      entityId: entity.id,
      speciesId: entity.speciesId,
      position: entity.position,
      zoneId: this.zoneId,
      timestamp: Date.now(),
      data: { killerId, cause },
    });

    // Remove after a delay (corpse decay)
    setTimeout(() => {
      this.entities.delete(entityId);
    }, 60000); // 1 minute corpse
  }

  // ========== Helpers ==========

  private getSpeciesForEntity(entity: WildlifeEntity): WildlifeSpecies | undefined {
    let species = this.species.get(entity.speciesId);
    if (!species) {
      species = getSpecies(entity.speciesId);
      if (species) this.species.set(entity.speciesId, species);
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
    for (const entity of this.entities.values()) {
      if (entity.speciesId === speciesId && entity.isAlive) count++;
    }
    return count;
  }

  private findPlayerPosition(_playerId: string): { position: Vector3 } | undefined {
    // This would need integration with the world manager
    return undefined;
  }

  // ========== Public API ==========

  getEntity(entityId: string): WildlifeEntity | undefined {
    return this.entities.get(entityId);
  }

  getAllEntities(): WildlifeEntity[] {
    return Array.from(this.entities.values());
  }

  getAliveEntities(): WildlifeEntity[] {
    return Array.from(this.entities.values()).filter(e => e.isAlive);
  }

  getEntitiesNear(position: Vector3, range: number): WildlifeEntity[] {
    const result: WildlifeEntity[] = [];
    for (const entity of this.entities.values()) {
      if (!entity.isAlive) continue;
      if (this.calculateDistance(position, entity.position) <= range) {
        result.push(entity);
      }
    }
    return result;
  }

  damageEntity(entityId: string, damage: number, attackerId?: string): boolean {
    const entity = this.entities.get(entityId);
    if (!entity || !entity.isAlive) return false;

    entity.currentHealth -= damage;
    entity.inCombat = true;
    entity.lastHostileAt = Date.now();

    // Trigger flee response
    if (attackerId) {
      entity.targetEntityId = attackerId;
      entity.currentBehavior = 'fleeing';
      entity.fleeingUntil = Date.now() + 10000; // Flee for 10 seconds
    }

    if (entity.currentHealth <= 0) {
      this.killEntity(entityId, attackerId, 'combat');
      return true; // Entity died
    }

    return false;
  }
}
