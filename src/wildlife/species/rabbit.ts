/**
 * Rabbit - Small prey animal
 *
 * Behavior: Flees from anything medium or larger, very skittish
 * Diet: Herbivore - eats grasses, herbs, vegetables
 * Social: Forms loose groups, not true herds
 */

import type { WildlifeSpecies, WildlifeSpawnConfig } from '../types';

export const rabbit: WildlifeSpecies = {
  id: 'rabbit',
  name: 'Rabbit',
  description: 'A small, fluffy herbivore with long ears. Quick to flee at the first sign of danger.',

  // Classification
  dietType: 'prey',
  sizeClass: 'small',

  // Movement
  baseSpeed: 2.0,              // 2 m/s walk
  fleeSpeedMultiplier: 2.5,    // Very fast when fleeing (5 m/s)
  swimCapable: false,          // Can't really swim well
  climbCapable: false,

  // Combat (only if truly cornered)
  attackDamage: 2,             // Weak kick/bite
  attackRange: 0.5,
  attackCooldown: 2.0,
  maxHealth: 15,

  // Perception - excellent hearing, good smell, decent sight
  sightRange: 20,
  hearingRange: 40,            // Those big ears work!
  smellRange: 15,

  // Needs - small body = faster metabolism
  needDecayRates: {
    hunger: 0.15,              // Needs to eat often
    thirst: 0.12,
    energy: 0.08,
    reproduction: -0.03,       // Breeds like... rabbits
  },
  preferredFood: ['grass', 'clover', 'carrot', 'lettuce', 'herb_sage', 'herb_thyme'],
  isHerbivore: true,
  isCarnivore: false,

  // Habitat
  biomePreferences: [
    { biome: 'grassland', comfort: 95 },
    { biome: 'forest', comfort: 80 },
    { biome: 'urban', comfort: 60 },      // Can adapt to gardens
    { biome: 'mountain', comfort: 40 },
    { biome: 'swamp', comfort: 30 },
    { biome: 'desert', comfort: 15 },     // Would leave quickly
    { biome: 'tundra', comfort: 20 },
    { biome: 'coastal', comfort: 50 },
  ],
  nocturnal: false,            // Crepuscular really (dawn/dusk)
  socialBehavior: 'herd',      // Loose groups
  packSize: { min: 3, max: 8 },

  // Reproduction - famously prolific
  gestationTime: 300,          // 5 minutes game time
  offspringCount: { min: 2, max: 6 },
  maturityTime: 600,           // 10 minutes to maturity

  // Loot
  lootTable: [
    { itemId: 'rabbit_meat', chance: 1.0, quantity: { min: 1, max: 2 } },
    { itemId: 'rabbit_hide', chance: 0.8, quantity: { min: 1, max: 1 } },
    { itemId: 'rabbit_foot', chance: 0.1, quantity: { min: 1, max: 1 } }, // Lucky!
  ],

  // Visual
  modelId: 'wildlife_rabbit',
  animations: {
    idle: 'rabbit_idle',
    walk: 'rabbit_hop',
    run: 'rabbit_sprint',
    eat: 'rabbit_nibble',
    attack: 'rabbit_kick',
    death: 'rabbit_death',
  },
};

export const rabbitSpawnConfig: WildlifeSpawnConfig = {
  speciesId: 'rabbit',
  biomes: ['grassland', 'forest', 'urban'],
  spawnChance: 0.3,            // 30% chance per spawn attempt
  maxPerZone: 12,              // Up to 12 rabbits per zone
  minDistanceFromPlayers: 30,  // Don't pop in right next to players
  minDistanceBetween: 5,       // Rabbits can be fairly close together
  spawnTime: {
    startHour: 5,              // Active from 5 AM
    endHour: 21,               // Until 9 PM
  },
};
