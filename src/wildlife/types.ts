/**
 * Wildlife System Types
 *
 * Animals have:
 * - Diet type (predator/prey/hybrid)
 * - Size class (determines who hunts/flees from whom)
 * - Needs (hunger, thirst, rest, reproduction)
 * - Biome preferences (with comfort scores)
 */

import type { Vector3 } from '@/network/protocol/types';

// ========== Diet & Behavior Classification ==========

export type DietType = 'predator' | 'prey' | 'hybrid';

// Size classes for determining predator/prey relationships
// A creature hunts things smaller than it and flees from larger (modified by diet)
export type SizeClass = 'tiny' | 'small' | 'medium' | 'large' | 'huge';

export const SIZE_CLASS_VALUES: Record<SizeClass, number> = {
  tiny: 1,    // mice, insects, small birds
  small: 2,   // rabbits, squirrels, foxes
  medium: 3,  // deer, wolves, humans
  large: 4,   // bears, elk, horses
  huge: 5,    // elephants, dragons
};

// ========== Biome System ==========

export type BiomeType =
  | 'forest'
  | 'grassland'
  | 'desert'
  | 'tundra'
  | 'swamp'
  | 'mountain'
  | 'coastal'
  | 'freshwater'  // rivers, lakes
  | 'ocean'
  | 'urban'
  | 'underground';

// Comfort score: 0-100, determines how well a creature thrives
// Below 20 = will actively try to leave
// Below 50 = stressed, reduced reproduction, may leave
// 50-80 = comfortable
// 80+ = thriving, increased reproduction
export interface BiomePreference {
  biome: BiomeType;
  comfort: number;  // 0-100
}

// ========== Needs System ==========

export interface WildlifeNeeds {
  hunger: number;      // 0-100, 0 = starving, 100 = full
  thirst: number;      // 0-100, 0 = dehydrated, 100 = hydrated
  energy: number;      // 0-100, 0 = exhausted, 100 = rested
  safety: number;      // 0-100, perceived safety (affects behavior)
  reproduction: number; // 0-100, urge to mate (when high + partner nearby = offspring)
}

// Rate at which needs decay per second (can be modified by activity)
export interface NeedDecayRates {
  hunger: number;      // Default ~0.1/sec = need to eat every ~15 min
  thirst: number;      // Default ~0.15/sec = need to drink every ~10 min
  energy: number;      // Default ~0.05/sec = need to rest every ~30 min
  reproduction: number; // Increases over time when needs are met
}

export const DEFAULT_NEED_DECAY: NeedDecayRates = {
  hunger: 0.1,
  thirst: 0.15,
  energy: 0.05,
  reproduction: -0.02, // Reproduction urge INCREASES over time (negative decay)
};

// ========== Wildlife Species Definition ==========

export interface WildlifeSpecies {
  id: string;
  name: string;
  description: string;

  // Classification
  dietType: DietType;
  sizeClass: SizeClass;

  // Movement
  baseSpeed: number;           // meters per second (walk)
  fleeSpeedMultiplier: number; // multiplier when fleeing (usually 1.5-2x)
  swimCapable: boolean;
  climbCapable: boolean;

  // Combat (if cornered or predator)
  attackDamage: number;
  attackRange: number;         // meters
  attackCooldown: number;      // seconds
  maxHealth: number;

  // Perception
  sightRange: number;          // meters - how far can see threats/prey
  hearingRange: number;        // meters - how far can hear
  smellRange: number;          // meters - how far can smell (food, predators)

  // Needs
  needDecayRates: NeedDecayRates;
  preferredFood: string[];     // Item/plant IDs this creature eats
  isHerbivore: boolean;        // Can eat plants
  isCarnivore: boolean;        // Can eat meat/creatures

  // Habitat
  biomePreferences: BiomePreference[];
  nocturnal: boolean;          // More active at night
  socialBehavior: 'solitary' | 'pair' | 'pack' | 'herd';
  packSize?: { min: number; max: number };

  // Reproduction
  gestationTime: number;       // seconds until offspring spawn
  offspringCount: { min: number; max: number };
  maturityTime: number;        // seconds until offspring can reproduce

  // Loot
  lootTable: WildlifeLoot[];

  // Visual
  modelId?: string;
  animations?: {
    idle: string;
    walk: string;
    run: string;
    eat: string;
    attack: string;
    death: string;
  };
}

export interface WildlifeLoot {
  itemId: string;
  chance: number;              // 0-1 probability
  quantity: { min: number; max: number };
}

// ========== Wildlife Instance (Runtime State) ==========

export interface WildlifeEntity {
  id: string;
  speciesId: string;
  name: string;                // Instance name (e.g., "a rabbit", "a large fox")

  // Position
  position: Vector3;
  heading: number;             // 0-360 degrees
  zoneId: string;
  currentBiome: BiomeType;

  // State
  isAlive: boolean;
  currentHealth: number;
  maxHealth: number;
  attackDamage: number;
  needs: WildlifeNeeds;

  // Behavior
  currentBehavior: WildlifeBehaviorState;
  targetEntityId?: string;     // Current target (prey, threat, mate)
  homePosition?: Vector3;      // Where this creature considers "home"
  lastPosition?: Vector3;      // For movement delta calculations

  // Timers
  lastUpdateAt: number;        // Timestamp of last behavior update
  attackCooldownUntil: number; // Timestamp when can attack again
  fleeingUntil: number;        // Timestamp when will stop fleeing
  restingUntil: number;        // Timestamp when will stop resting

  // Reproduction
  isPregnant: boolean;
  pregnancyEndsAt?: number;
  age: number;                 // seconds since spawn
  isMature: boolean;
  ageStage: WildlifeAgeStage;
  level: number;
  experience: number;
  experienceToNext: number;

  // Combat integration
  inCombat: boolean;
  lastHostileAt: number;
}

export type WildlifeAgeStage = 'juvenile' | 'adult' | 'elder';

// ========== Behavior States ==========

export type WildlifeBehaviorState =
  | 'idle'
  | 'wandering'
  | 'foraging'           // Looking for food (plants for herbivores)
  | 'hunting'            // Actively pursuing prey
  | 'stalking'           // Moving toward prey stealthily
  | 'fleeing'            // Running from threat
  | 'drinking'           // At water source
  | 'eating'             // Consuming food
  | 'resting'            // Sleeping/resting
  | 'seeking_mate'       // Looking for reproduction partner
  | 'mating'             // In reproduction act
  | 'defending'          // Defending territory/offspring
  | 'attacking'          // In combat
  | 'dying'              // Death animation
  | 'dead';

// Priority order for behavior selection (higher = more urgent)
export const BEHAVIOR_PRIORITIES: Record<WildlifeBehaviorState, number> = {
  dead: 100,
  dying: 99,
  fleeing: 90,           // Survival first
  attacking: 85,         // Fight if cornered
  defending: 80,
  drinking: 70,          // Critical needs
  eating: 65,
  foraging: 60,
  hunting: 55,
  stalking: 50,
  seeking_mate: 40,
  mating: 35,
  resting: 30,
  wandering: 20,
  idle: 10,
};

// ========== Behavior Decision Thresholds ==========

export const NEED_THRESHOLDS = {
  critical: 15,          // Below this = desperate (override most behaviors)
  low: 30,               // Below this = actively seek to fulfill
  comfortable: 60,       // Above this = not a priority
  full: 90,              // Above this = completely satisfied
};

export const SAFETY_THRESHOLDS = {
  panic: 20,             // Below this = flee immediately
  nervous: 40,           // Below this = very cautious, may flee
  alert: 60,             // Below this = watching carefully
  relaxed: 80,           // Above this = comfortable
};

// ========== Spawning Configuration ==========

export interface WildlifeSpawnConfig {
  speciesId: string;
  biomes: BiomeType[];           // Which biomes this can spawn in
  spawnChance: number;           // 0-1 probability per spawn attempt
  maxPerZone: number;            // Maximum instances per zone
  minDistanceFromPlayers: number; // Don't spawn too close to players
  minDistanceBetween: number;    // Don't spawn too close to same species
  spawnTime?: {
    startHour: number;           // 0-23
    endHour: number;             // 0-23 (can wrap, e.g., 22-4 for night)
  };
}

// ========== Events ==========

export type WildlifeEventType =
  | 'wildlife_spawn'
  | 'wildlife_death'
  | 'wildlife_flee'
  | 'wildlife_attack'
  | 'wildlife_eat'
  | 'wildlife_birth'
  | 'wildlife_migrate';    // Moving to new biome

export interface WildlifeEvent {
  type: WildlifeEventType;
  entityId: string;
  speciesId: string;
  position: Vector3;
  zoneId: string;
  timestamp: number;
  data?: Record<string, unknown>;
}
