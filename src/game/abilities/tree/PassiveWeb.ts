/**
 * Passive Web — 30 ability nodes
 *
 * Layout per sector (6 sectors × 60°):
 *   T1  : 1 node  — prefix `passive_{sector}_t1`
 *   T2  : 2 nodes — prefix `passive_{sector}_t2a` / `…t2b`
 *   T3  : 2 nodes — prefix `passive_{sector}_t3a` / `…t3b`
 *
 * No T4 tier in the passive web.
 *
 * Adjacency convention (same as active web but no T4 links):
 *   T2a[i] ↔ T1[i], T2b[i], T2b[(i-1+6)%6], T3a[i]
 *   T2b[i] ↔ T1[i], T2a[i], T2a[(i+1)%6],   T3b[i]
 *   T3a[i] ↔ T2a[i], T3b[i], T3b[(i-1+6)%6]
 *   T3b[i] ↔ T2b[i], T3a[i], T3a[(i+1)%6]
 *
 * Sectors: 0=tank | 1=phys | 2=control | 3=magic | 4=healer | 5=support
 */

import type { AbilityNode } from './types';
import { TIER_COST } from './types';

const SECTORS = ['tank', 'phys', 'control', 'magic', 'healer', 'support'] as const;
type S = typeof SECTORS[number];

function p(sector: S, tier: string): string {
  return `passive_${sector}_${tier}`;
}

export const PASSIVE_WEB: AbilityNode[] = [

  // ═══════════════════════════════════════════════════════════
  // TANK passives  (sector 0)
  // ═══════════════════════════════════════════════════════════

  {
    id: p('tank', 't1'),
    web: 'passive', sector: 'tank', tier: 1,
    name: 'Iron Hide',
    description: 'Toughen your body — increased defense and hit points.',
    cost: TIER_COST[1],
    adjacentTo: [p('support', 't1'), p('phys', 't1'), p('tank', 't2a'), p('tank', 't2b')],
    statBonus: { defenseRating: 15, maxHp: 50 },
  },

  {
    id: p('tank', 't2a'),
    web: 'passive', sector: 'tank', tier: 2,
    name: 'Thick Skin',
    description: 'Further hardened flesh — significant defense and health gains.',
    cost: TIER_COST[2],
    adjacentTo: [p('tank', 't1'), p('tank', 't2b'), p('support', 't2b'), p('tank', 't3a')],
    statBonus: { defenseRating: 25, maxHp: 75 },
  },

  {
    id: p('tank', 't2b'),
    web: 'passive', sector: 'tank', tier: 2,
    name: 'Bulwark Stance',
    description: 'Natural guard posture — passive defense and evasion improvement.',
    cost: TIER_COST[2],
    adjacentTo: [p('tank', 't1'), p('tank', 't2a'), p('phys', 't2a'), p('tank', 't3b')],
    statBonus: { defenseRating: 10, maxHp: 20, evasion: 5 },
  },

  {
    id: p('tank', 't3a'),
    web: 'passive', sector: 'tank', tier: 3,
    name: 'Stone Fortress',
    description: 'An imposing defensive profile — substantial defense and a large health pool.',
    cost: TIER_COST[3],
    adjacentTo: [p('tank', 't2a'), p('tank', 't3b'), p('support', 't3b')],
    statBonus: { defenseRating: 40, maxHp: 100 },
  },

  {
    id: p('tank', 't3b'),
    web: 'passive', sector: 'tank', tier: 3,
    name: 'Warden\'s Resolve',
    description: 'Unyielding conviction — heavy defense, a large health pool, and notable evasion.',
    cost: TIER_COST[3],
    adjacentTo: [p('tank', 't2b'), p('tank', 't3a'), p('phys', 't3a')],
    statBonus: { defenseRating: 30, maxHp: 150, evasion: 10 },
  },

  // ═══════════════════════════════════════════════════════════
  // PHYS passives  (sector 1)
  // ═══════════════════════════════════════════════════════════

  {
    id: p('phys', 't1'),
    web: 'passive', sector: 'phys', tier: 1,
    name: 'Savage Strength',
    description: 'Raw power that feeds directly into your attack rating.',
    cost: TIER_COST[1],
    adjacentTo: [p('tank', 't1'), p('control', 't1'), p('phys', 't2a'), p('phys', 't2b')],
    statBonus: { attackRating: 10 },
  },

  {
    id: p('phys', 't2a'),
    web: 'passive', sector: 'phys', tier: 2,
    name: 'Battle Hardened',
    description: 'Combat experience sharpens both striking power and the chance of critical hits.',
    cost: TIER_COST[2],
    adjacentTo: [p('phys', 't1'), p('phys', 't2b'), p('tank', 't2b'), p('phys', 't3a')],
    statBonus: { attackRating: 15, criticalHitChance: 5 },
  },

  {
    id: p('phys', 't2b'),
    web: 'passive', sector: 'phys', tier: 2,
    name: 'Precision Strikes',
    description: 'Methodical form — improved attack rating and physical accuracy.',
    cost: TIER_COST[2],
    adjacentTo: [p('phys', 't1'), p('phys', 't2a'), p('control', 't2a'), p('phys', 't3b')],
    statBonus: { attackRating: 10, physicalAccuracy: 10 },
  },

  {
    id: p('phys', 't3a'),
    web: 'passive', sector: 'phys', tier: 3,
    name: 'Berserker\'s Edge',
    description: 'Embrace fury — major attack gains and a high critical hit chance.',
    cost: TIER_COST[3],
    adjacentTo: [p('phys', 't2a'), p('phys', 't3b'), p('tank', 't3b')],
    statBonus: { attackRating: 25, criticalHitChance: 10 },
  },

  {
    id: p('phys', 't3b'),
    web: 'passive', sector: 'phys', tier: 3,
    name: 'Executioner',
    description: 'Lethal precision — balanced gains to attack, crit, and accuracy.',
    cost: TIER_COST[3],
    adjacentTo: [p('phys', 't2b'), p('phys', 't3a'), p('control', 't3a')],
    statBonus: { attackRating: 20, criticalHitChance: 5, physicalAccuracy: 5 },
  },

  // ═══════════════════════════════════════════════════════════
  // CONTROL passives  (sector 2)
  // ═══════════════════════════════════════════════════════════

  {
    id: p('control', 't1'),
    web: 'passive', sector: 'control', tier: 1,
    name: 'Focused Mind',
    description: 'A disciplined mind improves accuracy and intelligence.',
    cost: TIER_COST[1],
    adjacentTo: [p('phys', 't1'), p('magic', 't1'), p('control', 't2a'), p('control', 't2b')],
    statBonus: { physicalAccuracy: 10, intelligence: 5 },
  },

  {
    id: p('control', 't2a'),
    web: 'passive', sector: 'control', tier: 2,
    name: 'Crippling Strikes',
    description: 'Your attacks are designed to exploit weaknesses — accuracy and intelligence grow.',
    cost: TIER_COST[2],
    adjacentTo: [p('control', 't1'), p('control', 't2b'), p('phys', 't2b'), p('control', 't3a')],
    statBonus: { physicalAccuracy: 5, intelligence: 10 },
  },

  {
    id: p('control', 't2b'),
    web: 'passive', sector: 'control', tier: 2,
    name: 'Lingering Malice',
    description: 'Debuffs you apply persist longer — improved accuracy and wisdom.',
    cost: TIER_COST[2],
    adjacentTo: [p('control', 't1'), p('control', 't2a'), p('magic', 't2a'), p('control', 't3b')],
    statBonus: { physicalAccuracy: 10, wisdom: 10 },
  },

  {
    id: p('control', 't3a'),
    web: 'passive', sector: 'control', tier: 3,
    name: 'Mastermind',
    description: 'Strategic mastery — notable gains to accuracy, intelligence, and wisdom.',
    cost: TIER_COST[3],
    adjacentTo: [p('control', 't2a'), p('control', 't3b'), p('phys', 't3b')],
    statBonus: { physicalAccuracy: 10, intelligence: 20, wisdom: 10 },
  },

  {
    id: p('control', 't3b'),
    web: 'passive', sector: 'control', tier: 3,
    name: 'Iron Will',
    description: 'Unshakeable resolve — high accuracy and strong intelligence.',
    cost: TIER_COST[3],
    adjacentTo: [p('control', 't2b'), p('control', 't3a'), p('magic', 't3a')],
    statBonus: { physicalAccuracy: 20, intelligence: 15 },
  },

  // ═══════════════════════════════════════════════════════════
  // MAGIC passives  (sector 3)
  // ═══════════════════════════════════════════════════════════

  {
    id: p('magic', 't1'),
    web: 'passive', sector: 'magic', tier: 1,
    name: 'Arcane Aptitude',
    description: 'Innate magical talent — improved intelligence and mana pool.',
    cost: TIER_COST[1],
    adjacentTo: [p('control', 't1'), p('healer', 't1'), p('magic', 't2a'), p('magic', 't2b')],
    statBonus: { intelligence: 10, maxMana: 25 },
  },

  {
    id: p('magic', 't2a'),
    web: 'passive', sector: 'magic', tier: 2,
    name: 'Elemental Mastery',
    description: 'Command over elemental forces — strong intelligence and a larger mana pool.',
    cost: TIER_COST[2],
    adjacentTo: [p('magic', 't1'), p('magic', 't2b'), p('control', 't2b'), p('magic', 't3a')],
    statBonus: { intelligence: 15, maxMana: 50 },
  },

  {
    id: p('magic', 't2b'),
    web: 'passive', sector: 'magic', tier: 2,
    name: 'Spell Weaving',
    description: 'Intertwining spell and mind — intelligence, wisdom, and mana all rise.',
    cost: TIER_COST[2],
    adjacentTo: [p('magic', 't1'), p('magic', 't2a'), p('healer', 't2a'), p('magic', 't3b')],
    statBonus: { intelligence: 10, wisdom: 10, maxMana: 25 },
  },

  {
    id: p('magic', 't3a'),
    web: 'passive', sector: 'magic', tier: 3,
    name: 'Archmage\'s Insight',
    description: 'Deep arcane wisdom — major intelligence and a vast mana reserve.',
    cost: TIER_COST[3],
    adjacentTo: [p('magic', 't2a'), p('magic', 't3b'), p('control', 't3b')],
    statBonus: { intelligence: 25, maxMana: 100 },
  },

  {
    id: p('magic', 't3b'),
    web: 'passive', sector: 'magic', tier: 3,
    name: 'Mana Torrent',
    description: 'A firehose of magical power — large intelligence, mana, and wisdom gains.',
    cost: TIER_COST[3],
    adjacentTo: [p('magic', 't2b'), p('magic', 't3a'), p('healer', 't3a')],
    statBonus: { intelligence: 20, maxMana: 50, wisdom: 10 },
  },

  // ═══════════════════════════════════════════════════════════
  // HEALER passives  (sector 4)
  // ═══════════════════════════════════════════════════════════

  {
    id: p('healer', 't1'),
    web: 'passive', sector: 'healer', tier: 1,
    name: 'Gentle Touch',
    description: 'A healer\'s disposition — improved wisdom and mana.',
    cost: TIER_COST[1],
    adjacentTo: [p('magic', 't1'), p('support', 't1'), p('healer', 't2a'), p('healer', 't2b')],
    statBonus: { wisdom: 10, maxMana: 25 },
  },

  {
    id: p('healer', 't2a'),
    web: 'passive', sector: 'healer', tier: 2,
    name: 'Restorative Grace',
    description: 'The art of restoration deepens — strong wisdom and more mana.',
    cost: TIER_COST[2],
    adjacentTo: [p('healer', 't1'), p('healer', 't2b'), p('magic', 't2b'), p('healer', 't3a')],
    statBonus: { wisdom: 15, maxMana: 50 },
  },

  {
    id: p('healer', 't2b'),
    web: 'passive', sector: 'healer', tier: 2,
    name: 'Empathic Link',
    description: 'Caring deeply for allies improves your wisdom and bolsters their constitution.',
    cost: TIER_COST[2],
    adjacentTo: [p('healer', 't1'), p('healer', 't2a'), p('support', 't2a'), p('healer', 't3b')],
    statBonus: { wisdom: 10, maxHp: 50 },
  },

  {
    id: p('healer', 't3a'),
    web: 'passive', sector: 'healer', tier: 3,
    name: 'Sacred Healing',
    description: 'Divine healing arts mastered — major wisdom and a massive mana pool.',
    cost: TIER_COST[3],
    adjacentTo: [p('healer', 't2a'), p('healer', 't3b'), p('magic', 't3b')],
    statBonus: { wisdom: 25, maxMana: 100 },
  },

  {
    id: p('healer', 't3b'),
    web: 'passive', sector: 'healer', tier: 3,
    name: 'Life Warden',
    description: 'Guardian of life — strong wisdom, large mana pool, and increased vitality.',
    cost: TIER_COST[3],
    adjacentTo: [p('healer', 't2b'), p('healer', 't3a'), p('support', 't3a')],
    statBonus: { wisdom: 20, maxMana: 50, maxHp: 100 },
  },

  // ═══════════════════════════════════════════════════════════
  // SUPPORT passives  (sector 5)
  // ═══════════════════════════════════════════════════════════

  {
    id: p('support', 't1'),
    web: 'passive', sector: 'support', tier: 1,
    name: 'Inspiring Presence',
    description: 'A natural leader — balanced strength and wisdom to back every ally.',
    cost: TIER_COST[1],
    adjacentTo: [p('healer', 't1'), p('tank', 't1'), p('support', 't2a'), p('support', 't2b')],
    statBonus: { strength: 5, wisdom: 5 },
  },

  {
    id: p('support', 't2a'),
    web: 'passive', sector: 'support', tier: 2,
    name: 'Tactical Command',
    description: 'Strategic positioning and awareness — attack and defense both improve.',
    cost: TIER_COST[2],
    adjacentTo: [p('support', 't1'), p('support', 't2b'), p('healer', 't2b'), p('support', 't3a')],
    statBonus: { attackRating: 5, defenseRating: 5 },
  },

  {
    id: p('support', 't2b'),
    web: 'passive', sector: 'support', tier: 2,
    name: 'Rapid Tempo',
    description: 'Quick on your feet — improved agility and a larger stamina reserve.',
    cost: TIER_COST[2],
    adjacentTo: [p('support', 't1'), p('support', 't2a'), p('tank', 't2a'), p('support', 't3b')],
    statBonus: { agility: 10, maxStamina: 25 },
  },

  {
    id: p('support', 't3a'),
    web: 'passive', sector: 'support', tier: 3,
    name: 'Leader\'s Aura',
    description: 'Your presence strengthens allies — notable attack, defense, and agility.',
    cost: TIER_COST[3],
    adjacentTo: [p('support', 't2a'), p('support', 't3b'), p('healer', 't3b')],
    statBonus: { attackRating: 10, defenseRating: 10, agility: 10 },
  },

  {
    id: p('support', 't3b'),
    web: 'passive', sector: 'support', tier: 3,
    name: 'Battle Veteran',
    description: 'A lifetime of support across every role — small gains to all core stats.',
    cost: TIER_COST[3],
    adjacentTo: [p('support', 't2b'), p('support', 't3a'), p('tank', 't3a')],
    statBonus: {
      strength: 5, vitality: 5, dexterity: 5,
      agility: 5, intelligence: 5, wisdom: 5,
    },
  },
];

/** Look up a passive node by ID. */
export const PASSIVE_WEB_MAP: ReadonlyMap<string, AbilityNode> = new Map(
  PASSIVE_WEB.map(n => [n.id, n]),
);
