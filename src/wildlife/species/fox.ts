/**
 * Fox - Small hybrid predator/prey
 *
 * Behavior: Hunts smaller creatures (rabbits, mice), flees from larger (wolves, humans)
 * Diet: Carnivore/Omnivore - primarily hunts but can scavenge
 * Social: Mostly solitary, pairs during mating season
 */

import type { WildlifeSpecies, WildlifeSpawnConfig } from '../types';

export const fox: WildlifeSpecies = {
  id: 'fox',
  name: 'Fox',
  description: 'A cunning small predator with russet fur and a bushy tail. Hunts rabbits and other small prey.',

  // Classification
  dietType: 'hybrid',          // Hunts smaller, flees from larger
  sizeClass: 'small',          // Same size class as rabbit, but predator behavior

  // Movement
  baseSpeed: 2.5,              // Slightly faster than rabbits normally
  fleeSpeedMultiplier: 2.0,    // Fast but not as explosive as rabbit
  swimCapable: true,           // Can swim if needed
  climbCapable: false,

  // Combat
  attackDamage: 8,             // Decent bite
  attackRange: 1.0,
  attackCooldown: 1.5,
  maxHealth: 35,

  // Perception - excellent all-around senses
  sightRange: 35,
  hearingRange: 45,
  smellRange: 50,              // Great nose for tracking prey

  // Needs
  needDecayRates: {
    hunger: 0.08,              // Can go longer between meals than rabbit
    thirst: 0.10,
    energy: 0.06,
    reproduction: -0.015,      // Slower reproduction than rabbits
  },
  preferredFood: ['rabbit_meat', 'raw_meat', 'fish', 'bird_meat', 'berries'],
  isHerbivore: false,
  isCarnivore: true,

  // Habitat
  biomePreferences: [
    { biome: 'forest', comfort: 95 },
    { biome: 'grassland', comfort: 85 },
    { biome: 'mountain', comfort: 60 },
    { biome: 'tundra', comfort: 50 },      // Arctic foxes exist but this is red fox
    { biome: 'urban', comfort: 55 },       // Adapts to suburbs
    { biome: 'coastal', comfort: 45 },
    { biome: 'swamp', comfort: 35 },
    { biome: 'desert', comfort: 20 },
  ],
  nocturnal: true,             // More active at night
  socialBehavior: 'solitary',  // Mostly alone
  packSize: undefined,

  // Reproduction
  gestationTime: 600,          // 10 minutes
  offspringCount: { min: 2, max: 5 },
  maturityTime: 900,           // 15 minutes to maturity

  // Loot
  lootTable: [
    { itemId: 'fox_pelt', chance: 1.0, quantity: { min: 1, max: 1 } },
    { itemId: 'raw_meat', chance: 0.9, quantity: { min: 1, max: 2 } },
    { itemId: 'fox_tail', chance: 0.3, quantity: { min: 1, max: 1 } },
  ],

  // Visual
  modelId: 'wildlife_fox',
  animations: {
    idle: 'fox_idle',
    walk: 'fox_trot',
    run: 'fox_run',
    eat: 'fox_eat',
    attack: 'fox_bite',
    death: 'fox_death',
  },
};

export const foxSpawnConfig: WildlifeSpawnConfig = {
  speciesId: 'fox',
  biomes: ['forest', 'grassland', 'mountain'],
  spawnChance: 0.15,           // Less common than rabbits
  maxPerZone: 4,               // Predators are fewer
  minDistanceFromPlayers: 40,  // More wary of humans
  minDistanceBetween: 30,      // Territorial, keep distance from each other
  spawnTime: {
    startHour: 18,             // Active from 6 PM
    endHour: 6,                // Until 6 AM (nocturnal)
  },
};
