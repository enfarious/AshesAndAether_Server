import type { DamageType, TargetType } from '@/game/abilities/AbilityTypes';

export type CombatEventType =
  | 'combat_start'
  | 'combat_action'
  | 'combat_hit'
  | 'combat_miss'
  | 'combat_effect'
  | 'combat_death'
  | 'combat_end'
  | 'combat_error';

export interface CombatAbilityDefinition {
  id: string;
  name: string;
  description?: string;
  targetType: TargetType;
  range: number; // meters
  cooldown: number; // seconds
  atbCost: number;
  isFree?: boolean;
  staminaCost?: number;
  manaCost?: number;
  healthCost?: number;
  castTime?: number; // seconds
  aoeRadius?: number; // meters
  damage?: {
    type: DamageType;
    amount: number;
    scalingStat?: 'strength' | 'dexterity' | 'agility' | 'intelligence' | 'wisdom';
    scalingMultiplier?: number;
  };
  healing?: {
    amount: number;
    scalingStat?: 'wisdom' | 'intelligence';
    scalingMultiplier?: number;
  };
  // Builder/Consumer system
  // Builders: trade ATB for base effect + special charges
  // Consumers: spend special charges, operate outside ATB, typically have long cooldowns
  buildsCharge?: {
    chargeType: string;  // e.g., "combo_point", "holy_power", "chi"
    amount: number;      // How many charges this ability generates (1-5)
  };
  consumesCharge?: {
    chargeType: string;  // Must match a builder's chargeType
    amount: number;      // How many charges required to use
  };
  // For DoTs/buffs/debuffs: cooldown triggers AFTER effect duration ends
  effectDuration?: number; // seconds - if set, cooldown starts after this duration
}

export interface CombatantState {
  entityId: string;
  atbGauge: number;            // Current ATB (0 to atbMax)
  atbMax: number;              // Max ATB capacity (default 200, can be increased up to 500 via gear/abilities)
  lastHostileAt: number;
  inCombat: boolean;
  cooldowns: Map<string, number>;
  autoAttackTarget?: string;   // Entity ID of current auto-attack target
  autoAttackTimer: number;     // Time accumulated toward next auto-attack (seconds)
  weaponSpeed: number;         // Seconds between auto-attacks (lower = faster)
  specialCharges: Map<string, number>; // [chargeType] -> count (max 5 per type)
}

// ATB costs are ability-dependent (defined per ability in DB/definitions)
// Default max is 200, can be increased to 500 via gear/abilities/buffs
// Higher max = more ability charges stored = more chaining potential
export const ATB_DEFAULT_MAX = 200;
export const ATB_ABSOLUTE_MAX = 500;

// Special charges (builder/consumer system)
// Builders generate charges, consumers spend them
export const SPECIAL_CHARGE_MAX = 5;

export interface CombatStats {
  attackRating: number;
  defenseRating: number;
  physicalAccuracy: number;
  evasion: number;
  damageAbsorption: number;
  glancingBlowChance: number;
  magicAttack: number;
  magicDefense: number;
  magicAccuracy: number;
  magicEvasion: number;
  magicAbsorption: number;
  criticalHitChance: number;
  penetratingBlowChance: number;
  deflectedBlowChance: number;
}

export interface DamageResult {
  hit: boolean;
  outcome: 'hit' | 'crit' | 'glance' | 'penetrating' | 'deflected' | 'miss';
  amount: number;
  baseDamage: number;
  mitigatedDamage: number;
}
