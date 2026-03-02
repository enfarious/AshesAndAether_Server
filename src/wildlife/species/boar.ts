/**
 * Boar - Medium aggressive omnivore
 *
 * Behavior: Roots around for food, will CHARGE players who get too close.
 *   Unlike deer, a boar doesn't wait to be attacked — it's territorial and mean.
 * Diet: Omnivore — roots, tubers, berries, carrion, insects
 * Social: Solitary adults; sows travel with piglets
 */

import type { WildlifeSpecies, WildlifeSpawnConfig } from '../types';

export const boar: WildlifeSpecies = {
  id: 'boar',
  name: 'Wild Boar',
  description: 'A stocky, bristle-haired omnivore with curved tusks. Bad-tempered and surprisingly fast.',

  // Classification
  dietType: 'hybrid',
  sizeClass: 'medium',

  // Movement — slow walk but explosive charge
  baseSpeed: 2.2,
  fleeSpeedMultiplier: 2.2,    // Their "flee" speed is also their charge speed
  swimCapable: true,
  climbCapable: false,

  // Combat — tusks hit hard, short cooldown on a charge
  attackDamage: 22,
  attackRange: 1.5,
  attackCooldown: 1.8,
  maxHealth: 90,

  // Perception — decent smell, poor sight, okay hearing
  sightRange: 18,              // Boars have bad eyesight
  hearingRange: 35,
  smellRange: 55,              // Excellent nose (they root with it)

  // Needs
  needDecayRates: {
    hunger: 0.09,
    thirst: 0.08,
    energy: 0.06,
    reproduction: -0.01,
  },
  preferredFood: ['potato', 'carrot', 'onion', 'garlic', 'apple', 'pear', 'mushroom', 'raw_meat'],
  isHerbivore: false,
  isCarnivore: false,          // Omnivore — handled by having both in preferredFood

  // Habitat
  biomePreferences: [
    { biome: 'forest',    comfort: 95, spawnWeight: 9 },
    { biome: 'swamp',     comfort: 75, spawnWeight: 5 },
    { biome: 'grassland', comfort: 65, spawnWeight: 4 },
    { biome: 'mountain',  comfort: 50, spawnWeight: 2 },
    { biome: 'urban',     comfort: 30, spawnWeight: 1 }, // Farmland raider
    { biome: 'coastal',   comfort: 40, spawnWeight: 1 },
    { biome: 'tundra',    comfort: 20, spawnWeight: 0 },
  ],
  nocturnal: false,
  crepuscular: true,           // Peak activity at dawn/dusk but active all day
  socialBehavior: 'solitary',  // Adults solitary, mothers with piglets travel as pair
  packSize: undefined,

  // Boars will charge players who enter their space unprovoked
  aggressionRadius: 12,        // Within 12m a boar will consider you a threat

  // Reproduction
  gestationTime: 600,
  offspringCount: { min: 2, max: 5 }, // Piglets!
  maturityTime: 900,

  // Loot
  lootTable: [
    { itemId: 'pork',        chance: 1.0, quantity: { min: 2, max: 5 } },
    { itemId: 'boar_hide',   chance: 0.85, quantity: { min: 1, max: 2 } },
    { itemId: 'boar_tusk',   chance: 0.45, quantity: { min: 1, max: 2 } },
    { itemId: 'boar_bristle', chance: 0.6, quantity: { min: 1, max: 4 } },
  ],

  // Visual
  modelId: 'wildlife_boar',
  animations: {
    idle:   'boar_idle',
    walk:   'boar_trot',
    run:    'boar_charge',
    eat:    'boar_root',
    attack: 'boar_gore',
    death:  'boar_death',
  },
};

export const boarSpawnConfig: WildlifeSpawnConfig = {
  speciesId: 'boar',
  biomes: ['forest', 'swamp', 'grassland'],
  spawnChance: 0.12,
  maxPerZone: 5,
  minDistanceFromPlayers: 25,  // Less skittish than deer — they stand their ground
  minDistanceBetween: 25,
  spawnTime: {
    startHour: 5,
    endHour: 22,
  },
};
