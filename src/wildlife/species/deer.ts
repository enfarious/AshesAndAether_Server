/**
 * Deer - Medium prey animal
 *
 * Behavior: Flees from predators, grazes in open areas, cautious near players
 * Diet: Herbivore - grasses, leaves, bark, berries
 * Social: Small herds, vigilant
 */

import type { WildlifeSpecies, WildlifeSpawnConfig } from '../types';

export const deer: WildlifeSpecies = {
  id: 'deer',
  name: 'Deer',
  description: 'A graceful herbivore with large brown eyes. Timid but capable of bounding away at great speed.',

  // Classification
  dietType: 'prey',
  sizeClass: 'medium',

  // Movement
  baseSpeed: 3.0,              // 3 m/s walk
  fleeSpeedMultiplier: 2.8,    // Very fast when startled (~8.5 m/s sprint)
  swimCapable: true,
  climbCapable: false,

  // Combat (only bucks with antlers, and only if cornered)
  attackDamage: 12,
  attackRange: 1.5,
  attackCooldown: 2.5,
  maxHealth: 60,

  // Perception - wide field of view, good hearing and smell
  sightRange: 40,
  hearingRange: 50,
  smellRange: 35,

  // Needs
  needDecayRates: {
    hunger: 0.07,
    thirst: 0.09,
    energy: 0.05,
    reproduction: -0.012,
  },
  preferredFood: ['grass', 'clover', 'berry', 'onion', 'carrot', 'apple', 'pear'],
  isHerbivore: true,
  isCarnivore: false,

  // Habitat
  biomePreferences: [
    { biome: 'forest',    comfort: 95, spawnWeight: 9 },
    { biome: 'grassland', comfort: 85, spawnWeight: 7 },
    { biome: 'mountain',  comfort: 60, spawnWeight: 2 },
    { biome: 'swamp',     comfort: 40, spawnWeight: 1 },
    { biome: 'coastal',   comfort: 45, spawnWeight: 2 },
    { biome: 'tundra',    comfort: 35, spawnWeight: 1 },
    { biome: 'urban',     comfort: 20, spawnWeight: 0 },
  ],
  nocturnal: false,
  crepuscular: true,           // Most active at dawn and dusk
  socialBehavior: 'herd',
  packSize: { min: 2, max: 6 },

  // Reproduction
  gestationTime: 900,          // 15 minutes game time
  offspringCount: { min: 1, max: 2 },
  maturityTime: 1200,          // 20 minutes to maturity

  // Loot
  lootTable: [
    { itemId: 'venison',       chance: 1.0,  quantity: { min: 3, max: 6 } },
    { itemId: 'deer_hide',     chance: 0.9,  quantity: { min: 1, max: 2 } },
    { itemId: 'deer_antler',   chance: 0.4,  quantity: { min: 1, max: 2 } }, // Bucks only, roughly
    { itemId: 'deer_sinew',    chance: 0.6,  quantity: { min: 1, max: 3 } },
  ],

  // Visual
  modelId: 'wildlife_deer',
  animations: {
    idle: 'deer_idle',
    walk: 'deer_walk',
    run:  'deer_gallop',
    eat:  'deer_graze',
    attack: 'deer_kick',
    death: 'deer_death',
  },
};

export const deerSpawnConfig: WildlifeSpawnConfig = {
  speciesId: 'deer',
  biomes: ['forest', 'grassland', 'mountain'],
  spawnChance: 0.2,
  maxPerZone: 8,
  minDistanceFromPlayers: 45,  // Very wary of players
  minDistanceBetween: 15,
  spawnTime: {
    startHour: 4,              // Active from 4 AM (crepuscular — dawn peak)
    endHour: 22,               // Until 10 PM (dusk peak)
  },
};
