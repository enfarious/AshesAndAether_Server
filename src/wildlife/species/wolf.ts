/**
 * Wolf - Medium pack predator
 *
 * Behavior: Hunts in coordinated packs, targets deer and rabbits, territorial
 * Diet: Carnivore - primarily hunts but will scavenge
 * Social: Pack hunters — highly social and coordinated
 */

import type { WildlifeSpecies, WildlifeSpawnConfig } from '../types';

export const wolf: WildlifeSpecies = {
  id: 'wolf',
  name: 'Wolf',
  description: 'A powerful pack hunter with grey fur and piercing yellow eyes. Intelligent and tenacious.',

  // Classification
  dietType: 'predator',
  sizeClass: 'medium',

  // Movement
  baseSpeed: 3.5,              // Fast trot
  fleeSpeedMultiplier: 1.6,    // Will flee from overwhelming threats but not often
  swimCapable: true,
  climbCapable: false,

  // Combat — strong bite, pack coordination
  attackDamage: 18,
  attackRange: 1.2,
  attackCooldown: 1.2,
  maxHealth: 75,

  // Perception — best nose in the forest, good hearing, reasonable sight
  sightRange: 40,
  hearingRange: 60,
  smellRange: 80,              // Can track prey by scent across the zone

  // Needs — efficient hunters, can last between meals
  needDecayRates: {
    hunger: 0.055,
    thirst: 0.07,
    energy: 0.045,
    reproduction: -0.01,
  },
  preferredFood: ['venison', 'rabbit_meat', 'raw_meat', 'deer_meat'],
  isHerbivore: false,
  isCarnivore: true,

  // Habitat
  biomePreferences: [
    { biome: 'forest',    comfort: 95, spawnWeight: 8 },
    { biome: 'mountain',  comfort: 80, spawnWeight: 5 },
    { biome: 'tundra',    comfort: 70, spawnWeight: 4 },
    { biome: 'grassland', comfort: 65, spawnWeight: 3 },
    { biome: 'swamp',     comfort: 40, spawnWeight: 1 },
    { biome: 'coastal',   comfort: 35, spawnWeight: 0 },
    { biome: 'urban',     comfort: 10, spawnWeight: 0 },
  ],
  nocturnal: false,            // Hunts day and night depending on prey availability
  socialBehavior: 'pack',
  packSize: { min: 3, max: 7 },

  // Wolves are territorial and will approach intruders
  aggressionRadius: 20,        // Will investigate / stalk players within 20m

  // Reproduction
  gestationTime: 1200,         // 20 minutes game time
  offspringCount: { min: 2, max: 6 },
  maturityTime: 1500,          // 25 minutes to maturity

  // Loot
  lootTable: [
    { itemId: 'wolf_pelt',  chance: 1.0, quantity: { min: 1, max: 1 } },
    { itemId: 'raw_meat',   chance: 0.9, quantity: { min: 2, max: 4 } },
    { itemId: 'wolf_fang',  chance: 0.4, quantity: { min: 1, max: 2 } },
    { itemId: 'wolf_claw',  chance: 0.3, quantity: { min: 1, max: 2 } },
  ],

  // Visual
  modelId: 'wildlife_wolf',
  animations: {
    idle:   'wolf_idle',
    walk:   'wolf_trot',
    run:    'wolf_run',
    eat:    'wolf_eat',
    attack: 'wolf_bite',
    death:  'wolf_death',
  },
};

export const wolfSpawnConfig: WildlifeSpawnConfig = {
  speciesId: 'wolf',
  biomes: ['forest', 'mountain', 'tundra'],
  spawnChance: 0.1,
  maxPerZone: 5,               // Packs are rare, apex predators
  minDistanceFromPlayers: 50,
  minDistanceBetween: 40,      // Each pack claims territory
  spawnTime: {
    startHour: 18,             // Primarily active dusk to dawn
    endHour: 8,
  },
};
