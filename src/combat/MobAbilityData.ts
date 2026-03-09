/**
 * Mob Ability Definitions
 *
 * ATB-gated abilities for vault mobs. Each mob type gets 1-2 thematic
 * abilities; bosses unlock extra abilities via phase transitions.
 *
 * Anti-spam is enforced by three layers:
 *   1. Per-ability cooldowns (6-30s)
 *   2. ATB cost (40-150, charges at 10/sec)
 *   3. Global cooldown per mob (3-5s, enforced in MobBehaviorTree)
 */

import type { CombatAbilityDefinition } from './types';

// ═══════════════════════════════════════════════════════════
// DRONE — melee swarm unit, gap-closer + heavy strike
// ═══════════════════════════════════════════════════════════

const MOB_LUNGE: CombatAbilityDefinition = {
  id: 'mob_lunge',
  name: 'Lunge',
  description: 'Surge forward and slash the target. Closes distance quickly.',
  targetType: 'enemy',
  range: 6,
  cooldown: 8,
  atbCost: 50,
  staminaCost: 10,
  damage: {
    type: 'physical',
    amount: 10,
    scalingStat: 'strength',
    scalingMultiplier: 0.3,
    physicalType: 'slash',
  },
  tags: ['gap_closer'],
};

const MOB_OVERCHARGE_STRIKE: CombatAbilityDefinition = {
  id: 'mob_overcharge_strike',
  name: 'Overcharge Strike',
  description: 'Channel stored energy into a devastating melee blow.',
  targetType: 'enemy',
  range: 3,
  cooldown: 12,
  atbCost: 80,
  staminaCost: 15,
  damage: {
    type: 'physical',
    amount: 18,
    scalingStat: 'strength',
    scalingMultiplier: 0.5,
    physicalType: 'blunt',
  },
};

// ═══════════════════════════════════════════════════════════
// TURRET — stationary ranged unit, single-target + AoE root
// ═══════════════════════════════════════════════════════════

const MOB_ENERGY_BOLT: CombatAbilityDefinition = {
  id: 'mob_energy_bolt',
  name: 'Energy Bolt',
  description: 'Fire a focused energy projectile at long range.',
  targetType: 'enemy',
  range: 30,
  cooldown: 6,
  atbCost: 40,
  manaCost: 10,
  damage: {
    type: 'magic',
    amount: 12,
    scalingStat: 'intelligence',
    scalingMultiplier: 0.4,
  },
};

const MOB_SUPPRESSION_BURST: CombatAbilityDefinition = {
  id: 'mob_suppression_burst',
  name: 'Suppression Burst',
  description: 'Emit a pulse that roots all nearby enemies in place.',
  targetType: 'enemy',
  range: 25,
  cooldown: 18,
  atbCost: 100,
  manaCost: 20,
  aoeRadius: 6,
  effectDuration: 2.5,
  tags: ['cc', 'root', 'aoe'],
};

// ═══════════════════════════════════════════════════════════
// SENTINEL — tanky melee, threat generation + pull
// ═══════════════════════════════════════════════════════════

const MOB_SHIELD_SLAM: CombatAbilityDefinition = {
  id: 'mob_shield_slam',
  name: 'Shield Slam',
  description: 'Bash the target with a reinforced shield. Generates significant threat.',
  targetType: 'enemy',
  range: 3,
  cooldown: 10,
  atbCost: 60,
  staminaCost: 12,
  damage: {
    type: 'physical',
    amount: 8,
    scalingStat: 'strength',
    scalingMultiplier: 0.3,
    physicalType: 'blunt',
  },
  threatModifier: { multiplier: 2.0, flatBonus: 500 },
  tags: ['threat'],
};

const MOB_MAGNETIC_PULL: CombatAbilityDefinition = {
  id: 'mob_magnetic_pull',
  name: 'Magnetic Pull',
  description: 'Yank a distant target into melee range with a magnetic grapple.',
  targetType: 'enemy',
  range: 20,
  cooldown: 15,
  atbCost: 70,
  manaCost: 15,
  damage: {
    type: 'magic',
    amount: 5,
    scalingStat: 'intelligence',
    scalingMultiplier: 0.2,
  },
  tags: ['displacement', 'pull'],
};

// ═══════════════════════════════════════════════════════════
// OVERSEER (sub-boss) — support caster, heals + debuffs
// ═══════════════════════════════════════════════════════════

const MOB_REPAIR_PULSE: CombatAbilityDefinition = {
  id: 'mob_repair_pulse',
  name: 'Repair Pulse',
  description: 'Emit a nanite burst that repairs all nearby allied constructs.',
  targetType: 'ally',
  range: 15,
  cooldown: 10,
  atbCost: 60,
  manaCost: 18,
  aoeRadius: 10,
  healing: {
    amount: 15,
    scalingStat: 'wisdom',
    scalingMultiplier: 0.4,
  },
  tags: ['healing', 'aoe'],
};

const MOB_DISRUPTION_FIELD: CombatAbilityDefinition = {
  id: 'mob_disruption_field',
  name: 'Disruption Field',
  description: 'Project a field of static that weakens enemies, reducing their attack rating.',
  targetType: 'enemy',
  range: 18,
  cooldown: 16,
  atbCost: 80,
  manaCost: 20,
  aoeRadius: 8,
  effectDuration: 6,
  tags: ['debuff', 'aoe'],
};

/** Phase 2 unlock — big AoE burst when the overseer gets desperate. */
const MOB_OVERLOAD: CombatAbilityDefinition = {
  id: 'mob_overload',
  name: 'Overload',
  description: 'Overload internal power cells, releasing a devastating energy explosion.',
  targetType: 'enemy',
  range: 12,
  cooldown: 20,
  atbCost: 120,
  manaCost: 30,
  aoeRadius: 10,
  damage: {
    type: 'lightning',
    amount: 25,
    scalingStat: 'intelligence',
    scalingMultiplier: 0.6,
  },
  tags: ['aoe', 'burst'],
};

// ═══════════════════════════════════════════════════════════
// OVERLORD (boss) — aggressive melee bruiser, multi-phase
// ═══════════════════════════════════════════════════════════

const MOB_NANOSWARM: CombatAbilityDefinition = {
  id: 'mob_nanoswarm',
  name: 'Nanoswarm',
  description: 'Release a cloud of corrosive nanites that eat away at the target over time.',
  targetType: 'enemy',
  range: 15,
  cooldown: 14,
  atbCost: 70,
  manaCost: 15,
  effectDuration: 8,
  damage: {
    type: 'poison',
    amount: 4, // Per tick — applied as DoT via buff system
    scalingStat: 'intelligence',
    scalingMultiplier: 0.15,
  },
  tags: ['dot'],
};

const MOB_SEISMIC_POUND: CombatAbilityDefinition = {
  id: 'mob_seismic_pound',
  name: 'Seismic Pound',
  description: 'Slam the ground with titanic force, damaging all nearby enemies.',
  targetType: 'enemy',
  range: 5,
  cooldown: 12,
  atbCost: 90,
  staminaCost: 20,
  aoeRadius: 8,
  damage: {
    type: 'physical',
    amount: 20,
    scalingStat: 'strength',
    scalingMultiplier: 0.5,
    physicalType: 'blunt',
  },
  tags: ['aoe', 'melee'],
};

/** Phase 2 unlock — sweeping cone attack when kiting. */
const MOB_CORRUPTION_WAVE: CombatAbilityDefinition = {
  id: 'mob_corruption_wave',
  name: 'Corruption Wave',
  description: 'Unleash a wave of corrupted energy in a wide cone.',
  targetType: 'enemy',
  range: 12,
  cooldown: 16,
  atbCost: 100,
  manaCost: 25,
  targeting: {
    shape: 'cone',
    angle: 60,
    length: 12,
  },
  damage: {
    type: 'dark',
    amount: 22,
    scalingStat: 'intelligence',
    scalingMultiplier: 0.5,
  },
  tags: ['aoe', 'cone'],
};

/** Phase 3 unlock — emergency self-heal when near death. */
const MOB_FINAL_PROTOCOL: CombatAbilityDefinition = {
  id: 'mob_final_protocol',
  name: 'Final Protocol',
  description: 'Activate emergency repair routines, rapidly restoring structural integrity.',
  targetType: 'self',
  range: 0,
  cooldown: 30,
  atbCost: 150,
  manaCost: 30,
  healing: {
    amount: 40,
    scalingStat: 'wisdom',
    scalingMultiplier: 0.6,
  },
  tags: ['healing', 'self_heal'],
};

// ═══════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════

/** All mob abilities, registered in AbilitySystem alongside player T1 abilities. */
export const MOB_ABILITIES: CombatAbilityDefinition[] = [
  // Drone
  MOB_LUNGE,
  MOB_OVERCHARGE_STRIKE,
  // Turret
  MOB_ENERGY_BOLT,
  MOB_SUPPRESSION_BURST,
  // Sentinel
  MOB_SHIELD_SLAM,
  MOB_MAGNETIC_PULL,
  // Overseer (sub-boss)
  MOB_REPAIR_PULSE,
  MOB_DISRUPTION_FIELD,
  MOB_OVERLOAD,
  // Overlord (boss)
  MOB_NANOSWARM,
  MOB_SEISMIC_POUND,
  MOB_CORRUPTION_WAVE,
  MOB_FINAL_PROTOCOL,
];

/**
 * Lookup map: mob tag suffix → ability IDs available in base phase.
 * Used by MobCombatProfile to know which abilities each mob type starts with.
 */
export const MOB_TAG_ABILITIES: Record<string, string[]> = {
  drone:    ['mob_lunge', 'mob_overcharge_strike'],
  turret:   ['mob_energy_bolt', 'mob_suppression_burst'],
  sentinel: ['mob_shield_slam', 'mob_magnetic_pull'],
  overseer: ['mob_repair_pulse', 'mob_disruption_field'],
  overlord: ['mob_nanoswarm', 'mob_seismic_pound'],
};
