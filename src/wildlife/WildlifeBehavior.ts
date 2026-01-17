/**
 * Wildlife Behavior System
 *
 * Handles AI decision-making for wildlife entities.
 * Evaluates needs, threats, opportunities and selects appropriate behavior.
 */

import type {
  WildlifeEntity,
  WildlifeSpecies,
  WildlifeBehaviorState,
  BiomeType,
  SizeClass,
} from './types';
import {
  SIZE_CLASS_VALUES,
  NEED_THRESHOLDS,
} from './types';
import type { Vector3 } from '@/network/protocol/types';

// ========== Perception Results ==========

export interface PerceivedEntity {
  id: string;
  position: Vector3;
  distance: number;
  entityType: 'player' | 'wildlife' | 'plant' | 'water';
  sizeClass?: SizeClass;
  dietType?: 'predator' | 'prey' | 'hybrid';
  speciesId?: string;
  isAlive: boolean;
  isThreat: boolean;
  isPrey: boolean;
  isFood: boolean;
  isMate: boolean;
}

export interface EnvironmentContext {
  currentBiome: BiomeType;
  biomeComfort: number;
  timeOfDay: number;           // 0-24 hours
  isNight: boolean;
  nearbyEntities: PerceivedEntity[];
  nearestThreat?: PerceivedEntity;
  nearestPrey?: PerceivedEntity;
  nearestFood?: PerceivedEntity;
  nearestWater?: PerceivedEntity;
  nearestMate?: PerceivedEntity;
}

// ========== Behavior Selection ==========

export interface BehaviorDecision {
  behavior: WildlifeBehaviorState;
  targetId?: string;
  targetPosition?: Vector3;
  priority: number;
  reason: string;
}

/**
 * Evaluate what behavior an entity should adopt based on its needs and environment
 */
export function selectBehavior(
  entity: WildlifeEntity,
  species: WildlifeSpecies,
  context: EnvironmentContext
): BehaviorDecision {
  const candidates: BehaviorDecision[] = [];

  // Dead entities stay dead
  if (!entity.isAlive) {
    return { behavior: 'dead', priority: 100, reason: 'Entity is dead' };
  }

  // Check for immediate threats (flee behavior)
  const fleeDecision = evaluateFlee(entity, species, context);
  if (fleeDecision) candidates.push(fleeDecision);

  // Check for hunting opportunities (predators/hybrids)
  const huntDecision = evaluateHunt(entity, species, context);
  if (huntDecision) candidates.push(huntDecision);

  // Check critical needs
  const drinkDecision = evaluateDrink(entity, species, context);
  if (drinkDecision) candidates.push(drinkDecision);

  const eatDecision = evaluateEat(entity, species, context);
  if (eatDecision) candidates.push(eatDecision);

  const forageDecision = evaluateForage(entity, species, context);
  if (forageDecision) candidates.push(forageDecision);

  // Check rest need
  const restDecision = evaluateRest(entity, species, context);
  if (restDecision) candidates.push(restDecision);

  // Check reproduction
  const mateDecision = evaluateMate(entity, species, context);
  if (mateDecision) candidates.push(mateDecision);

  // Check biome comfort (migration)
  const migrateDecision = evaluateMigrate(entity, species, context);
  if (migrateDecision) candidates.push(migrateDecision);

  // Default behaviors
  candidates.push({ behavior: 'wandering', priority: 20, reason: 'Default wandering' });
  candidates.push({ behavior: 'idle', priority: 10, reason: 'Nothing to do' });

  // Select highest priority behavior
  candidates.sort((a, b) => b.priority - a.priority);
  return candidates[0];
}

// ========== Behavior Evaluators ==========

function evaluateFlee(
  entity: WildlifeEntity,
  species: WildlifeSpecies,
  context: EnvironmentContext
): BehaviorDecision | null {
  if (!context.nearestThreat) return null;

  const threat = context.nearestThreat;
  const distance = threat.distance;

  // Calculate threat level based on distance and size difference
  let urgency = 0;

  // Prey always flee from threats
  if (species.dietType === 'prey') {
    urgency = 90;
  } else if (species.dietType === 'hybrid') {
    // Hybrids only flee from larger threats
    urgency = 70;
  } else {
    // Predators only flee from much larger threats or if hurt
    if (entity.currentHealth < entity.maxHealth * 0.3) {
      urgency = 60;
    } else {
      return null; // Predators don't flee easily
    }
  }

  // Closer threats are more urgent
  if (distance < species.sightRange * 0.3) {
    urgency += 15; // Very close!
  } else if (distance < species.sightRange * 0.6) {
    urgency += 5;
  }

  // Already fleeing? Maintain that behavior
  if (entity.currentBehavior === 'fleeing') {
    urgency += 10;
  }

  return {
    behavior: 'fleeing',
    targetId: threat.id,
    targetPosition: threat.position,
    priority: urgency,
    reason: `Fleeing from ${threat.id} at distance ${distance.toFixed(1)}m`,
  };
}

function evaluateHunt(
  entity: WildlifeEntity,
  species: WildlifeSpecies,
  context: EnvironmentContext
): BehaviorDecision | null {
  // Only predators and hybrids hunt
  if (species.dietType === 'prey') return null;

  // Need to be hungry to hunt
  if (entity.needs.hunger > NEED_THRESHOLDS.comfortable) return null;

  // Don't hunt if there's an active threat
  if (context.nearestThreat && context.nearestThreat.distance < species.sightRange * 0.5) {
    return null;
  }

  if (!context.nearestPrey) return null;

  const prey = context.nearestPrey;
  let priority = 55; // Base hunting priority

  // Hungrier = more motivated to hunt
  if (entity.needs.hunger < NEED_THRESHOLDS.critical) {
    priority += 25;
  } else if (entity.needs.hunger < NEED_THRESHOLDS.low) {
    priority += 15;
  }

  // Close prey is more attractive
  if (prey.distance < species.sightRange * 0.3) {
    priority += 10;
  }

  // Determine hunting phase
  const behavior: WildlifeBehaviorState = prey.distance > species.attackRange * 3
    ? 'stalking'
    : 'hunting';

  return {
    behavior,
    targetId: prey.id,
    targetPosition: prey.position,
    priority,
    reason: `Hunting ${prey.speciesId} at distance ${prey.distance.toFixed(1)}m`,
  };
}

function evaluateDrink(
  entity: WildlifeEntity,
  _species: WildlifeSpecies,
  context: EnvironmentContext
): BehaviorDecision | null {
  // Check if thirsty
  if (entity.needs.thirst > NEED_THRESHOLDS.low) return null;

  let priority = 50;

  if (entity.needs.thirst < NEED_THRESHOLDS.critical) {
    priority = 85; // Critical thirst overrides most things
  }

  if (!context.nearestWater) {
    // No water nearby, wander to find some
    return {
      behavior: 'wandering',
      priority: priority - 20,
      reason: 'Seeking water (none nearby)',
    };
  }

  const water = context.nearestWater;

  // At water source?
  if (water.distance < 2) {
    return {
      behavior: 'drinking',
      targetPosition: water.position,
      priority,
      reason: 'Drinking at water source',
    };
  }

  // Move toward water
  return {
    behavior: 'wandering',
    targetPosition: water.position,
    priority: priority - 5,
    reason: `Moving to water at ${water.distance.toFixed(1)}m`,
  };
}

function evaluateEat(
  entity: WildlifeEntity,
  _species: WildlifeSpecies,
  context: EnvironmentContext
): BehaviorDecision | null {
  // Check if hungry
  if (entity.needs.hunger > NEED_THRESHOLDS.low) return null;

  // Only eat if food is RIGHT THERE
  if (!context.nearestFood || context.nearestFood.distance > 2) return null;

  let priority = 65;
  if (entity.needs.hunger < NEED_THRESHOLDS.critical) {
    priority = 80;
  }

  return {
    behavior: 'eating',
    targetId: context.nearestFood.id,
    targetPosition: context.nearestFood.position,
    priority,
    reason: 'Eating nearby food',
  };
}

function evaluateForage(
  entity: WildlifeEntity,
  species: WildlifeSpecies,
  context: EnvironmentContext
): BehaviorDecision | null {
  // Herbivores forage, carnivores hunt
  if (!species.isHerbivore) return null;

  // Not hungry enough to forage
  if (entity.needs.hunger > NEED_THRESHOLDS.comfortable) return null;

  let priority = 45;
  if (entity.needs.hunger < NEED_THRESHOLDS.low) {
    priority = 60;
  }
  if (entity.needs.hunger < NEED_THRESHOLDS.critical) {
    priority = 75;
  }

  // If food nearby, move to it
  if (context.nearestFood) {
    return {
      behavior: 'foraging',
      targetPosition: context.nearestFood.position,
      priority,
      reason: `Foraging toward food at ${context.nearestFood.distance.toFixed(1)}m`,
    };
  }

  // Wander looking for food
  return {
    behavior: 'foraging',
    priority: priority - 10,
    reason: 'Foraging (searching for food)',
  };
}

function evaluateRest(
  entity: WildlifeEntity,
  species: WildlifeSpecies,
  context: EnvironmentContext
): BehaviorDecision | null {
  // Check energy level
  if (entity.needs.energy > NEED_THRESHOLDS.low) return null;

  // Don't rest if threatened
  if (context.nearestThreat && context.nearestThreat.distance < species.sightRange) {
    return null;
  }

  let priority = 30;
  if (entity.needs.energy < NEED_THRESHOLDS.critical) {
    priority = 50;
  }

  // Nocturnal creatures rest during day
  if (species.nocturnal && !context.isNight) {
    priority += 20;
  }
  // Diurnal creatures rest at night
  if (!species.nocturnal && context.isNight) {
    priority += 20;
  }

  return {
    behavior: 'resting',
    priority,
    reason: 'Resting to recover energy',
  };
}

function evaluateMate(
  entity: WildlifeEntity,
  species: WildlifeSpecies,
  context: EnvironmentContext
): BehaviorDecision | null {
  // Can't mate if not mature
  if (!entity.isMature) return null;

  // Can't mate if already pregnant
  if (entity.isPregnant) return null;

  // Need high reproduction urge
  if (entity.needs.reproduction < NEED_THRESHOLDS.comfortable) return null;

  // Basic needs must be met
  if (entity.needs.hunger < NEED_THRESHOLDS.low) return null;
  if (entity.needs.thirst < NEED_THRESHOLDS.low) return null;

  // Don't mate if threatened
  if (context.nearestThreat && context.nearestThreat.distance < species.sightRange) {
    return null;
  }

  const priority = 40 + (entity.needs.reproduction - 60) * 0.3;

  if (!context.nearestMate) {
    return {
      behavior: 'seeking_mate',
      priority: priority - 10,
      reason: 'Looking for mate',
    };
  }

  if (context.nearestMate.distance < 2) {
    return {
      behavior: 'mating',
      targetId: context.nearestMate.id,
      priority,
      reason: 'Mating with nearby partner',
    };
  }

  return {
    behavior: 'seeking_mate',
    targetId: context.nearestMate.id,
    targetPosition: context.nearestMate.position,
    priority: priority - 5,
    reason: `Moving toward mate at ${context.nearestMate.distance.toFixed(1)}m`,
  };
}

function evaluateMigrate(
  _entity: WildlifeEntity,
  _species: WildlifeSpecies,
  context: EnvironmentContext
): BehaviorDecision | null {
  // Check biome comfort
  if (context.biomeComfort >= 50) return null; // Comfortable enough

  // Very uncomfortable biome - consider leaving
  let priority = 25;

  if (context.biomeComfort < 20) {
    priority = 45; // Really need to leave
  }

  return {
    behavior: 'wandering',
    priority,
    reason: `Uncomfortable in ${context.currentBiome} (comfort: ${context.biomeComfort})`,
  };
}

// ========== Threat/Prey Evaluation ==========

/**
 * Determine if another entity is a threat to this wildlife
 */
export function isThreat(
  selfSpecies: WildlifeSpecies,
  otherSizeClass: SizeClass,
  otherDietType: 'predator' | 'prey' | 'hybrid' | 'player'
): boolean {
  const selfSize = SIZE_CLASS_VALUES[selfSpecies.sizeClass];
  const otherSize = SIZE_CLASS_VALUES[otherSizeClass];

  // Players are always potential threats
  if (otherDietType === 'player') {
    return selfSpecies.dietType !== 'predator' || selfSize < 4; // Large predators aren't scared of humans
  }

  // Prey fears everything its size or larger
  if (selfSpecies.dietType === 'prey') {
    return otherSize >= selfSize && otherDietType !== 'prey';
  }

  // Hybrids fear larger things that could hunt them
  if (selfSpecies.dietType === 'hybrid') {
    return otherSize > selfSize && otherDietType !== 'prey';
  }

  // Predators only fear significantly larger predators
  if (selfSpecies.dietType === 'predator') {
    return otherSize > selfSize + 1 && otherDietType === 'predator';
  }

  return false;
}

/**
 * Determine if another entity is valid prey for this wildlife
 */
export function isPrey(
  selfSpecies: WildlifeSpecies,
  otherSizeClass: SizeClass,
  _otherDietType: 'predator' | 'prey' | 'hybrid'
): boolean {
  // Prey animals don't hunt
  if (selfSpecies.dietType === 'prey') return false;

  const selfSize = SIZE_CLASS_VALUES[selfSpecies.sizeClass];
  const otherSize = SIZE_CLASS_VALUES[otherSizeClass];

  // Predators hunt anything smaller
  if (selfSpecies.dietType === 'predator') {
    return otherSize < selfSize;
  }

  // Hybrids hunt things smaller than them
  if (selfSpecies.dietType === 'hybrid') {
    return otherSize < selfSize;
  }

  return false;
}

// ========== Movement Helpers ==========

/**
 * Calculate a flee direction (away from threat)
 */
export function calculateFleeDirection(
  entityPos: Vector3,
  threatPos: Vector3
): number {
  const dx = entityPos.x - threatPos.x;
  const dz = entityPos.z - threatPos.z;
  const angle = Math.atan2(dx, dz) * (180 / Math.PI);
  return (angle + 360) % 360;
}

/**
 * Calculate direction toward a target
 */
export function calculateApproachDirection(
  entityPos: Vector3,
  targetPos: Vector3
): number {
  const dx = targetPos.x - entityPos.x;
  const dz = targetPos.z - entityPos.z;
  const angle = Math.atan2(dx, dz) * (180 / Math.PI);
  return (angle + 360) % 360;
}

/**
 * Calculate a random wander direction with some bias toward home
 */
export function calculateWanderDirection(
  entityPos: Vector3,
  homePos?: Vector3,
  currentHeading?: number
): number {
  // Base: random direction with bias toward current heading
  let baseAngle = currentHeading ?? Math.random() * 360;

  // Add randomness
  const randomOffset = (Math.random() - 0.5) * 90; // ±45 degrees
  baseAngle = (baseAngle + randomOffset + 360) % 360;

  // If far from home, bias toward home
  if (homePos) {
    const distFromHome = Math.sqrt(
      Math.pow(entityPos.x - homePos.x, 2) +
      Math.pow(entityPos.z - homePos.z, 2)
    );

    if (distFromHome > 50) { // More than 50m from home
      const homeDirection = calculateApproachDirection(entityPos, homePos);
      // Blend current direction with home direction
      const homeBias = Math.min(0.5, distFromHome / 200);
      baseAngle = blendAngles(baseAngle, homeDirection, homeBias);
    }
  }

  return baseAngle;
}

function blendAngles(a: number, b: number, weight: number): number {
  // Convert to radians
  const aRad = a * (Math.PI / 180);
  const bRad = b * (Math.PI / 180);

  // Use atan2 to properly blend angles
  const x = Math.cos(aRad) * (1 - weight) + Math.cos(bRad) * weight;
  const y = Math.sin(aRad) * (1 - weight) + Math.sin(bRad) * weight;

  const result = Math.atan2(y, x) * (180 / Math.PI);
  return (result + 360) % 360;
}
