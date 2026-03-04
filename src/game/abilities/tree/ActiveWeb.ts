/**
 * Active Web — 36 ability nodes
 *
 * Layout per sector (6 sectors × 60°):
 *   T1  : 1 node  — prefix `active_{sector}_t1`
 *   T2  : 2 nodes — prefix `active_{sector}_t2a` / `…t2b`
 *   T3  : 2 nodes — prefix `active_{sector}_t3a` / `…t3b`
 *   T4  : 1 capstone — prefix `active_{sector}_t4`  (quest-gated, 15-min CD)
 *
 * Adjacency convention
 *   The `_a` variant of a multi-node tier leans toward the *previous* sector
 *   (counter-clockwise); `_b` leans toward the *next* sector (clockwise).
 *
 *   T2a[i] ↔ T1[i], T2b[i], T2b[(i-1+6)%6], T3a[i]
 *   T2b[i] ↔ T1[i], T2a[i], T2a[(i+1)%6],   T3b[i]
 *   T3a[i] ↔ T2a[i], T3b[i], T3b[(i-1+6)%6], T4[i]
 *   T3b[i] ↔ T2b[i], T3a[i], T3a[(i+1)%6],   T4[i]
 *   T4[i]  ↔ T3a[i], T3b[i]
 *
 * Sectors and their indices:
 *   0 = tank | 1 = phys | 2 = control | 3 = magic | 4 = healer | 5 = support
 */

import type { AbilityNode } from './types';
import { TIER_COST } from './types';

const SECTORS = ['tank', 'phys', 'control', 'magic', 'healer', 'support'] as const;
type S = typeof SECTORS[number];

function id(web: 'active' | 'passive', sector: S, tier: string): string {
  return `${web}_${sector}_${tier}`;
}
const a = (sector: S, tier: string) => id('active', sector, tier);

export const ACTIVE_WEB: AbilityNode[] = [

  // ═══════════════════════════════════════════════════════════
  // TANK  (sector 0)
  // ═══════════════════════════════════════════════════════════

  {
    id: a('tank', 't1'),
    web: 'active', sector: 'tank', tier: 1,
    name: 'Provoke',
    description: 'Taunt a single enemy, forcing them to target you for a short duration.',
    cost: TIER_COST[1],
    adjacentTo: [a('support', 't1'), a('phys', 't1'), a('tank', 't2a'), a('tank', 't2b')],
    activeEffect: {
      description: 'Taunt single target — forces attention for 4 s. Threat applies even on miss.',
      targetType: 'enemy', range: 10,
      staminaCost: 15, cooldown: 12,
    },
  },

  {
    id: a('tank', 't2a'),
    web: 'active', sector: 'tank', tier: 2,
    name: 'Shield Bash',
    description: 'A crushing blow that stuns the target and deals physical damage.',
    cost: TIER_COST[2],
    adjacentTo: [a('tank', 't1'), a('tank', 't2b'), a('support', 't2b'), a('tank', 't3a')],
    activeEffect: {
      description: 'Stun + physical damage — stun lasts 3 s.',
      targetType: 'enemy', range: 3, damageType: 'physical',
      staminaCost: 25, cooldown: 18, castTime: 0,
      statusEffects: ['stun'],
    },
  },

  {
    id: a('tank', 't2b'),
    web: 'active', sector: 'tank', tier: 2,
    name: 'Guard Stance',
    description: 'Enter a defensive posture: reduce incoming damage but slow your movement.',
    cost: TIER_COST[2],
    adjacentTo: [a('tank', 't1'), a('tank', 't2a'), a('phys', 't2a'), a('tank', 't3b')],
    activeEffect: {
      description: 'Self-buff: +40% damage reduction, −30% move speed for 12 s.',
      targetType: 'self', range: 0,
      staminaCost: 20, cooldown: 30,
      statusEffects: ['guard_stance'],
    },
  },

  {
    id: a('tank', 't3a'),
    web: 'active', sector: 'tank', tier: 3,
    name: 'Iron Bulwark',
    description: 'A rallying cry that briefly grants your entire party increased defense.',
    cost: TIER_COST[3],
    adjacentTo: [a('tank', 't2a'), a('tank', 't3b'), a('support', 't3b'), a('tank', 't4')],
    activeEffect: {
      description: 'Party-wide def+60 for 15 s (range 20 m).',
      targetType: 'aoe', range: 20, aoeRadius: 20,
      staminaCost: 40, cooldown: 45,
      statusEffects: ['def_up_major'],
    },
  },

  {
    id: a('tank', 't3b'),
    web: 'active', sector: 'tank', tier: 3,
    name: 'Howl',
    description: 'A fearsome shout that forces nearby enemies to target you.',
    cost: TIER_COST[3],
    adjacentTo: [a('tank', 't2b'), a('tank', 't3a'), a('phys', 't3a'), a('tank', 't4')],
    activeEffect: {
      description: 'AoE taunt — all enemies within 10 m attack you for 12 s.',
      targetType: 'aoe', range: 0, aoeRadius: 10,
      staminaCost: 35, cooldown: 40,
      statusEffects: ['taunt_aoe'],
    },
  },

  {
    id: a('tank', 't4'),
    web: 'active', sector: 'tank', tier: 4,
    name: 'Colossus Roar',
    description:
      'An earth-shaking roar that forces all nearby enemies to attack you and briefly renders you invulnerable.',
    cost: TIER_COST[4],
    adjacentTo: [a('tank', 't3a'), a('tank', 't3b')],
    questGate: 'feat_tank_colossus',
    activeEffect: {
      description: 'Massive AoE taunt (30 m) + 5 s invulnerability.',
      targetType: 'aoe', range: 0, aoeRadius: 30,
      staminaCost: 80, cooldown: 900,   // 15 minutes
      statusEffects: ['taunt_aoe', 'invulnerable'],
      capstone: {
        flavour: 'Forces all enemies within 30 m to attack you and makes you invulnerable for 5 seconds.',
        mechanicKey: 'mass_taunt_invuln',
        duration: 5,
      },
    },
  },

  // ═══════════════════════════════════════════════════════════
  // PHYS — Physical Damage Dealer  (sector 1)
  // ═══════════════════════════════════════════════════════════

  {
    id: a('phys', 't1'),
    web: 'active', sector: 'phys', tier: 1,
    name: 'Power Strike',
    description: 'Prime your next attack to deal bonus damage. Weapon determines damage type and range.',
    cost: TIER_COST[1],
    adjacentTo: [a('tank', 't1'), a('control', 't1'), a('phys', 't2a'), a('phys', 't2b')],
    activeEffect: {
      description: 'Self-buff — next weapon attack: +10 flat + STR×0.5 bonus. Expires after 1 hit or 10 s.',
      targetType: 'self', range: 0,
      staminaCost: 12, cooldown: 8,
    },
  },

  {
    id: a('phys', 't2a'),
    web: 'active', sector: 'phys', tier: 2,
    name: 'Rend',
    description: 'A tearing strike that shreds the target\'s armor temporarily.',
    cost: TIER_COST[2],
    adjacentTo: [a('phys', 't1'), a('phys', 't2b'), a('tank', 't2b'), a('phys', 't3a')],
    activeEffect: {
      description: 'Physical hit + apply def-down debuff for 10 s.',
      targetType: 'enemy', range: 3, damageType: 'physical',
      staminaCost: 25, cooldown: 14,
      statusEffects: ['def_down'],
    },
  },

  {
    id: a('phys', 't2b'),
    web: 'active', sector: 'phys', tier: 2,
    name: 'Flurry',
    description: 'A rapid series of light hits that overwhelms a single target.',
    cost: TIER_COST[2],
    adjacentTo: [a('phys', 't1'), a('phys', 't2a'), a('control', 't2a'), a('phys', 't3b')],
    activeEffect: {
      description: '4-hit physical combo — each hit at 60% base attack rating.',
      targetType: 'enemy', range: 3, damageType: 'physical',
      staminaCost: 30, cooldown: 12,
    },
  },

  {
    id: a('phys', 't3a'),
    web: 'active', sector: 'phys', tier: 3,
    name: 'Shatter',
    description: 'A single catastrophic blow — trades speed for devastating impact.',
    cost: TIER_COST[3],
    adjacentTo: [a('phys', 't2a'), a('phys', 't3b'), a('tank', 't3b'), a('phys', 't4')],
    activeEffect: {
      description: 'Massive physical hit — 300% base attack rating, 1 s cast.',
      targetType: 'enemy', range: 3, damageType: 'physical',
      staminaCost: 50, cooldown: 22, castTime: 1.0,
    },
  },

  {
    id: a('phys', 't3b'),
    web: 'active', sector: 'phys', tier: 3,
    name: 'Blade Storm',
    description: 'Spin through nearby enemies in a whirlwind of strikes.',
    cost: TIER_COST[3],
    adjacentTo: [a('phys', 't2b'), a('phys', 't3a'), a('control', 't3a'), a('phys', 't4')],
    activeEffect: {
      description: 'AoE physical — hits all enemies within 5 m.',
      targetType: 'aoe', range: 0, aoeRadius: 5, damageType: 'physical',
      staminaCost: 45, cooldown: 28,
    },
  },

  {
    id: a('phys', 't4'),
    web: 'active', sector: 'phys', tier: 4,
    name: 'Killing Edge',
    description:
      'Channel absolute focus — your next damage ability deals twice its final result, after all modifiers.',
    cost: TIER_COST[4],
    adjacentTo: [a('phys', 't3a'), a('phys', 't3b')],
    questGate: 'feat_phys_killing_edge',
    activeEffect: {
      description: 'Next damage ability deals ×2 final damage (post-crit, post-pen).',
      targetType: 'self', range: 0,
      staminaCost: 60, cooldown: 900,
      capstone: {
        flavour: 'Your next damage ability deals twice the final calculated damage.',
        mechanicKey: 'double_next_damage',
        duration: 30,   // buff window: must use within 30 s or wasted
      },
    },
  },

  // ═══════════════════════════════════════════════════════════
  // CONTROL  (sector 2)
  // ═══════════════════════════════════════════════════════════

  {
    id: a('control', 't1'),
    web: 'active', sector: 'control', tier: 1,
    name: 'Ensnare',
    description: 'Root an enemy in place. Does not prevent attacking or ability use. Breaks on heavy damage.',
    cost: TIER_COST[1],
    adjacentTo: [a('phys', 't1'), a('magic', 't1'), a('control', 't2a'), a('control', 't2b')],
    activeEffect: {
      description: 'Root single target for 3 s. Breaks on 20+ damage.',
      targetType: 'enemy', range: 25,
      manaCost: 20, cooldown: 14,
      statusEffects: ['root'],
    },
  },

  {
    id: a('control', 't2a'),
    web: 'active', sector: 'control', tier: 2,
    name: 'Blind',
    description: 'Hurl dust or a flash that reduces a target\'s accuracy.',
    cost: TIER_COST[2],
    adjacentTo: [a('control', 't1'), a('control', 't2b'), a('phys', 't2b'), a('control', 't3a')],
    activeEffect: {
      description: 'Apply acc-down debuff to single target for 12 s.',
      targetType: 'enemy', range: 15,
      manaCost: 22, cooldown: 18,
      statusEffects: ['acc_down'],
    },
  },

  {
    id: a('control', 't2b'),
    web: 'active', sector: 'control', tier: 2,
    name: 'Weaken',
    description: 'Sap a target\'s strength, reducing their attack power.',
    cost: TIER_COST[2],
    adjacentTo: [a('control', 't1'), a('control', 't2a'), a('magic', 't2a'), a('control', 't3b')],
    activeEffect: {
      description: 'Apply atk-down debuff to single target for 12 s.',
      targetType: 'enemy', range: 15,
      manaCost: 22, cooldown: 18,
      statusEffects: ['atk_down'],
    },
  },

  {
    id: a('control', 't3a'),
    web: 'active', sector: 'control', tier: 3,
    name: 'Shackle',
    description: 'Bind a target with powerful chains — heavily slowed and defense lowered.',
    cost: TIER_COST[3],
    adjacentTo: [a('control', 't2a'), a('control', 't3b'), a('phys', 't3b'), a('control', 't4')],
    activeEffect: {
      description: 'Heavy slow + def-down on single target for 15 s.',
      targetType: 'enemy', range: 20,
      manaCost: 35, cooldown: 28,
      statusEffects: ['slow_heavy', 'def_down_major'],
    },
  },

  {
    id: a('control', 't3b'),
    web: 'active', sector: 'control', tier: 3,
    name: 'Enfeeble',
    description: 'A comprehensive weakening hex that degrades attack, defense, and accuracy.',
    cost: TIER_COST[3],
    adjacentTo: [a('control', 't2b'), a('control', 't3a'), a('magic', 't3a'), a('control', 't4')],
    activeEffect: {
      description: 'Apply atk-down + def-down + acc-down to single target for 12 s.',
      targetType: 'enemy', range: 15,
      manaCost: 40, cooldown: 35,
      statusEffects: ['atk_down', 'def_down', 'acc_down'],
    },
  },

  {
    id: a('control', 't4'),
    web: 'active', sector: 'control', tier: 4,
    name: 'Crushing Malaise',
    description:
      'Afflict a single target with catastrophic status penalties: massive defense, attack, and accuracy reduction plus a powerful slow.',
    cost: TIER_COST[4],
    adjacentTo: [a('control', 't3a'), a('control', 't3b')],
    questGate: 'feat_control_crushing_malaise',
    activeEffect: {
      description: 'Single target: massive atk/acc/def down + heavy slow for 20 s.',
      targetType: 'enemy', range: 20,
      manaCost: 80, cooldown: 900,
      statusEffects: ['atk_down_major', 'def_down_major', 'acc_down_major', 'slow_heavy'],
      capstone: {
        flavour: 'Crushes a single target with massive attack, defense, and accuracy reductions alongside a powerful slow.',
        mechanicKey: 'crushing_malaise',
        duration: 20,
      },
    },
  },

  // ═══════════════════════════════════════════════════════════
  // MAGIC — Magic Damage Dealer  (sector 3)
  // ═══════════════════════════════════════════════════════════

  {
    id: a('magic', 't1'),
    web: 'active', sector: 'magic', tier: 1,
    name: 'Shadow Bolt',
    description: 'Launch a bolt of dark magic at an enemy. Reliable ranged damage that scales with Intelligence.',
    cost: TIER_COST[1],
    adjacentTo: [a('control', 't1'), a('healer', 't1'), a('magic', 't2a'), a('magic', 't2b')],
    activeEffect: {
      description: 'Dark damage single target — 14 base + INT×0.7.',
      targetType: 'enemy', range: 30, damageType: 'dark',
      manaCost: 18, cooldown: 3,
    },
  },

  {
    id: a('magic', 't2a'),
    web: 'active', sector: 'magic', tier: 2,
    name: 'Searing Ray',
    description: 'A sustained beam of fire that burns the target over time.',
    cost: TIER_COST[2],
    adjacentTo: [a('magic', 't1'), a('magic', 't2b'), a('control', 't2b'), a('magic', 't3a')],
    activeEffect: {
      description: 'Fire damage + burn DoT (8 s) on single target.',
      targetType: 'enemy', range: 20, damageType: 'fire',
      manaCost: 28, cooldown: 16,
      statusEffects: ['burn'],
    },
  },

  {
    id: a('magic', 't2b'),
    web: 'active', sector: 'magic', tier: 2,
    name: 'Frost Lance',
    description: 'A spike of ice that chills the target, slowing their movements.',
    cost: TIER_COST[2],
    adjacentTo: [a('magic', 't1'), a('magic', 't2a'), a('healer', 't2a'), a('magic', 't3b')],
    activeEffect: {
      description: 'Ice damage + slow (10 s) on single target.',
      targetType: 'enemy', range: 25, damageType: 'ice',
      manaCost: 28, cooldown: 14,
      statusEffects: ['slow'],
    },
  },

  {
    id: a('magic', 't3a'),
    web: 'active', sector: 'magic', tier: 3,
    name: 'Void Surge',
    description: 'Dark energy that tears through magical and physical resistance alike.',
    cost: TIER_COST[3],
    adjacentTo: [a('magic', 't2a'), a('magic', 't3b'), a('control', 't3b'), a('magic', 't4')],
    activeEffect: {
      description: 'Dark magic — ignores a portion of magic defense.',
      targetType: 'enemy', range: 20, damageType: 'dark',
      manaCost: 45, cooldown: 24, castTime: 0.5,
    },
  },

  {
    id: a('magic', 't3b'),
    web: 'active', sector: 'magic', tier: 3,
    name: 'Tempest',
    description: 'Call a localized electrical storm that strikes all nearby enemies.',
    cost: TIER_COST[3],
    adjacentTo: [a('magic', 't2b'), a('magic', 't3a'), a('healer', 't3a'), a('magic', 't4')],
    activeEffect: {
      description: 'Lightning AoE — hits all enemies within 8 m.',
      targetType: 'aoe', range: 30, aoeRadius: 8, damageType: 'lightning',
      manaCost: 50, cooldown: 30, castTime: 0.8,
    },
  },

  {
    id: a('magic', 't4'),
    web: 'active', sector: 'magic', tier: 4,
    name: 'Arcane Cataclysm',
    description:
      'Tap into a wellspring of raw magic — your next damage ability detonates for twice its final calculated result.',
    cost: TIER_COST[4],
    adjacentTo: [a('magic', 't3a'), a('magic', 't3b')],
    questGate: 'feat_magic_arcane_cataclysm',
    activeEffect: {
      description: 'Next damage ability deals ×2 final damage (post-crit, post-pen).',
      targetType: 'self', range: 0,
      manaCost: 80, cooldown: 900,
      capstone: {
        flavour: 'Your next damage ability deals twice the final calculated damage.',
        mechanicKey: 'double_next_damage',
        duration: 30,
      },
    },
  },

  // ═══════════════════════════════════════════════════════════
  // HEALER  (sector 4)
  // ═══════════════════════════════════════════════════════════

  {
    id: a('healer', 't1'),
    web: 'active', sector: 'healer', tier: 1,
    name: 'Mend',
    description: 'Restore HP to a single ally. Scales with Wisdom. The foundation of all healing builds.',
    cost: TIER_COST[1],
    adjacentTo: [a('magic', 't1'), a('support', 't1'), a('healer', 't2a'), a('healer', 't2b')],
    activeEffect: {
      description: 'Heal single target — 18 base + WIS×0.6. Instant cast.',
      targetType: 'ally', range: 20,
      manaCost: 20, cooldown: 4,
    },
  },

  {
    id: a('healer', 't2a'),
    web: 'active', sector: 'healer', tier: 2,
    name: 'Purify',
    description: 'Cleanse a debuff from an ally and restore a small amount of health.',
    cost: TIER_COST[2],
    adjacentTo: [a('healer', 't1'), a('healer', 't2b'), a('magic', 't2b'), a('healer', 't3a')],
    activeEffect: {
      description: 'Remove 1 debuff + minor heal on single ally.',
      targetType: 'ally', range: 20,
      manaCost: 25, cooldown: 15,
      statusEffects: ['cleanse_debuff'],
    },
  },

  {
    id: a('healer', 't2b'),
    web: 'active', sector: 'healer', tier: 2,
    name: 'Barrier',
    description: 'Wrap an ally in a protective shell that absorbs incoming damage.',
    cost: TIER_COST[2],
    adjacentTo: [a('healer', 't1'), a('healer', 't2a'), a('support', 't2a'), a('healer', 't3b')],
    activeEffect: {
      description: 'Absorb shield on single ally (absorbs ~200% wisdom) for 20 s.',
      targetType: 'ally', range: 20,
      manaCost: 30, cooldown: 25,
      statusEffects: ['barrier'],
    },
  },

  {
    id: a('healer', 't3a'),
    web: 'active', sector: 'healer', tier: 3,
    name: 'Rejuvenate',
    description: 'Infuse an ally with healing energy that restores health continuously.',
    cost: TIER_COST[3],
    adjacentTo: [a('healer', 't2a'), a('healer', 't3b'), a('magic', 't3b'), a('healer', 't4')],
    activeEffect: {
      description: 'HoT on single ally — heals every 2 s for 18 s.',
      targetType: 'ally', range: 25,
      manaCost: 40, cooldown: 30,
      statusEffects: ['regen_major'],
    },
  },

  {
    id: a('healer', 't3b'),
    web: 'active', sector: 'healer', tier: 3,
    name: 'Triage',
    description: 'Channel a wave of healing energy that restores health to all nearby allies.',
    cost: TIER_COST[3],
    adjacentTo: [a('healer', 't2b'), a('healer', 't3a'), a('support', 't3a'), a('healer', 't4')],
    activeEffect: {
      description: 'AoE heal — all allies within 15 m receive a moderate heal.',
      targetType: 'aoe', range: 0, aoeRadius: 15,
      manaCost: 50, cooldown: 35, castTime: 0.8,
    },
  },

  {
    id: a('healer', 't4'),
    web: 'active', sector: 'healer', tier: 4,
    name: 'Miracle',
    description:
      'Channel divine power to revive all fallen party members and restore their health.',
    cost: TIER_COST[4],
    adjacentTo: [a('healer', 't3a'), a('healer', 't3b')],
    questGate: 'feat_healer_miracle',
    activeEffect: {
      description: 'Revive all fallen allies within 30 m and restore 50% HP to all surviving allies.',
      targetType: 'aoe', range: 0, aoeRadius: 30,
      manaCost: 100, cooldown: 900, castTime: 2.0,
      capstone: {
        flavour: 'Revives all fallen party members and restores health to all surviving allies.',
        mechanicKey: 'mass_revive_heal',
        duration: 0,
      },
    },
  },

  // ═══════════════════════════════════════════════════════════
  // SUPPORT  (sector 5)
  // ═══════════════════════════════════════════════════════════

  {
    id: a('support', 't1'),
    web: 'active', sector: 'support', tier: 1,
    name: 'Embolden',
    description: 'Bolster an ally\'s resolve, increasing their attack and magic rating for a short duration.',
    cost: TIER_COST[1],
    adjacentTo: [a('healer', 't1'), a('tank', 't1'), a('support', 't2a'), a('support', 't2b')],
    activeEffect: {
      description: '+10 attackRating, +8 magicAttack for 10 s. Does not stack with itself.',
      targetType: 'ally', range: 20,
      manaCost: 22, cooldown: 16,
      statusEffects: ['embolden'],
    },
  },

  {
    id: a('support', 't2a'),
    web: 'active', sector: 'support', tier: 2,
    name: 'Quicken',
    description: 'Imbue an ally with speed, letting them act and move faster.',
    cost: TIER_COST[2],
    adjacentTo: [a('support', 't1'), a('support', 't2b'), a('healer', 't2b'), a('support', 't3a')],
    activeEffect: {
      description: 'Apply haste buff to single ally for 15 s.',
      targetType: 'ally', range: 20,
      manaCost: 25, cooldown: 25,
      statusEffects: ['haste'],
    },
  },

  {
    id: a('support', 't2b'),
    web: 'active', sector: 'support', tier: 2,
    name: 'Fortify',
    description: 'Reinforce an ally\'s defenses against physical and magical threats.',
    cost: TIER_COST[2],
    adjacentTo: [a('support', 't1'), a('support', 't2a'), a('tank', 't2a'), a('support', 't3b')],
    activeEffect: {
      description: 'Apply def-up buff to single ally for 15 s.',
      targetType: 'ally', range: 20,
      manaCost: 22, cooldown: 22,
      statusEffects: ['def_up'],
    },
  },

  {
    id: a('support', 't3a'),
    web: 'active', sector: 'support', tier: 3,
    name: 'Sharpen',
    description: 'Fine-tune an ally\'s form — improving both accuracy and attack power.',
    cost: TIER_COST[3],
    adjacentTo: [a('support', 't2a'), a('support', 't3b'), a('healer', 't3b'), a('support', 't4')],
    activeEffect: {
      description: 'Apply acc-up + atk-up buffs to single ally for 20 s.',
      targetType: 'ally', range: 20,
      manaCost: 35, cooldown: 32,
      statusEffects: ['acc_up', 'atk_up'],
    },
  },

  {
    id: a('support', 't3b'),
    web: 'active', sector: 'support', tier: 3,
    name: 'Aegis',
    description: 'Raise a shimmering barrier around your entire party, boosting defense and evasion.',
    cost: TIER_COST[3],
    adjacentTo: [a('support', 't2b'), a('support', 't3a'), a('tank', 't3a'), a('support', 't4')],
    activeEffect: {
      description: 'Party-wide def-up + evasion-up for 20 s (range 20 m).',
      targetType: 'aoe', range: 20, aoeRadius: 20,
      manaCost: 45, cooldown: 40,
      statusEffects: ['def_up_major', 'evasion_up'],
    },
  },

  {
    id: a('support', 't4'),
    web: 'active', sector: 'support', tier: 4,
    name: 'Rally Cry',
    description:
      'A legendary battle cry that floods your entire party with haste, attack power, defense, and accuracy simultaneously.',
    cost: TIER_COST[4],
    adjacentTo: [a('support', 't3a'), a('support', 't3b')],
    questGate: 'feat_support_rally_cry',
    activeEffect: {
      description: 'Party-wide haste + atk-up + def-up + acc-up for 25 s (range 25 m).',
      targetType: 'aoe', range: 25, aoeRadius: 25,
      manaCost: 100, cooldown: 900,
      statusEffects: ['haste', 'atk_up_major', 'def_up_major', 'acc_up_major'],
      capstone: {
        flavour: 'Grants haste, major attack-up, major defense-up, and major accuracy-up to your entire party.',
        mechanicKey: 'rally_cry',
        duration: 25,
      },
    },
  },
];

/** Look up an active node by ID. */
export const ACTIVE_WEB_MAP: ReadonlyMap<string, AbilityNode> = new Map(
  ACTIVE_WEB.map(n => [n.id, n]),
);
