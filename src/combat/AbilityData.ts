/**
 * T1 Ability Definitions
 *
 * One active + one passive per archetype (6 archetypes = 12 total).
 * Active abilities are CombatAbilityDefinition objects registered in AbilitySystem.
 * Passive abilities are stat-bonus descriptors applied via the ability tree loadout.
 */

import type { CombatAbilityDefinition } from './types';

// ═══════════════════════════════════════════════════════════
// ACTIVE ABILITIES — 6 total, one per archetype
// ═══════════════════════════════════════════════════════════

export const T1_ABILITIES: CombatAbilityDefinition[] = [

  // ── TANK: Provoke ──────────────────────────────────────
  {
    id: 'provoke',
    name: 'Provoke',
    description: 'Taunt a single enemy, forcing them to target you for a short duration. Dramatically increases your threat against the target.',
    targetType: 'enemy',
    range: 20,
    cooldown: 12,
    atbCost: 1,
    isFree: true,
    staminaCost: 15,
    // No damage — taunt-only. Mechanic handled in DWM.
    // Duration: 4s. Threat multiplier applies even on miss.
    tags: ['taunt'],
    threatModifier: { multiplier: 1.0, flatBonus: 2000 },
  },

  // ── HEALER: Mend ───────────────────────────────────────
  {
    id: 'mend',
    name: 'Mend',
    description: 'Restore HP to a single ally. Scales with Wisdom. The foundation of all healing builds.',
    targetType: 'ally',
    range: 20,
    cooldown: 4,
    atbCost: 0,
    isFree: true,
    manaCost: 20,
    healing: {
      amount: 18,
      scalingStat: 'wisdom',
      scalingMultiplier: 0.6,
    },
    tags: ['healing'],
  },

  // ── MAGIC DD: Shadow Bolt ──────────────────────────────
  {
    id: 'shadow_bolt',
    name: 'Shadow Bolt',
    description: 'Launch a bolt of dark magic at an enemy. Reliable ranged damage that scales with Intelligence.',
    targetType: 'enemy',
    range: 30,
    cooldown: 3,
    atbCost: 0,
    isFree: true,
    manaCost: 18,
    damage: {
      type: 'dark',
      amount: 14,
      scalingStat: 'intelligence',
      scalingMultiplier: 0.7,
    },
  },

  // ── SUPPORT: Embolden ──────────────────────────────────
  {
    id: 'embolden',
    name: 'Embolden',
    description: 'Bolster an ally\'s resolve, increasing their attack and magic rating for a short duration.',
    targetType: 'ally',
    range: 20,
    cooldown: 16,
    atbCost: 0,
    isFree: true,
    manaCost: 22,
    // No damage/healing — buff-only. +10 attackRating, +8 magicAttack for 10s.
    effectDuration: 10,
    tags: ['buff'],
  },

  // ── CONTROL: Ensnare ───────────────────────────────────
  {
    id: 'ensnare',
    name: 'Ensnare',
    description: 'Root an enemy in place, preventing movement for a short duration. Does not prevent attacking or ability use.',
    targetType: 'enemy',
    range: 25,
    cooldown: 14,
    atbCost: 0,
    isFree: true,
    manaCost: 20,
    // No damage — root mechanic. Duration: 3s. Breaks on 20+ single-hit damage.
    effectDuration: 3,
    tags: ['cc', 'root'],
  },

  // ── PHYSICAL DD: Power Strike ──────────────────────────
  {
    id: 'power_strike',
    name: 'Power Strike',
    description: 'Prime your next attack to deal bonus damage. The strike\'s damage type and range are determined by the equipped weapon.',
    targetType: 'self',
    range: 0,
    cooldown: 8,
    atbCost: 0,
    isFree: true,
    staminaCost: 12,
    // Self-buff: next weapon attack gets +10 flat + STR*0.5 bonus.
    // Expires after 1 attack or 10s.
    effectDuration: 10,
    tags: ['buff', 'next_attack'],
  },
];

// ═══════════════════════════════════════════════════════════
// PASSIVE ABILITIES — 6 total, one per archetype
// Applied via ability tree passive loadout slots as stat bonuses.
// ═══════════════════════════════════════════════════════════

export interface PassiveAbilityDef {
  id: string;
  name: string;
  description: string;
  archetype: string;
  /** Simple stat bonuses applied when slotted */
  statBonuses?: Record<string, number>;
  /** Non-stat mechanic key for complex passives (stub until system support) */
  special?: string;
}

export const T1_PASSIVES: PassiveAbilityDef[] = [
  {
    id: 'fortified',
    name: 'Fortified',
    archetype: 'tank',
    description: 'Hardened physique from relentless combat training. Passively increases maximum HP and reduces incoming physical damage.',
    statBonuses: { maxHp: 15, damageAbsorption: 3 },
  },
  {
    id: 'steady_hand',
    name: 'Steady Hand',
    archetype: 'healer',
    description: 'Practiced calm under pressure reduces the drain of sustained healing and sharpens recovery timing.',
    statBonuses: { manaRegen: 2 },
    special: 'heal_cd_reduction_8pct', // TODO: Wire when cooldown modifier system exists
  },
  {
    id: 'spell_power',
    name: 'Spell Power',
    archetype: 'magic',
    description: 'Raw arcane attunement. Increases magic attack rating, making all spells hit harder.',
    statBonuses: { magicAttack: 12 },
  },
  {
    id: 'attunement',
    name: 'Attunement',
    archetype: 'support',
    description: 'Deep resonance with aetheric flows amplifies the potency of buffs and debuffs you apply.',
    special: 'buff_potency_10pct', // TODO: Wire when buff potency multiplier system exists (Day 8)
  },
  {
    id: 'opportunist',
    name: 'Opportunist',
    archetype: 'control',
    description: 'Trained instinct to exploit moments of vulnerability. Deals bonus damage to enemies that are rooted, stunned, or slowed.',
    special: 'cc_damage_bonus_15pct', // TODO: Wire when StatusEffectManager exists (Day 8)
  },
  {
    id: 'weapon_mastery',
    name: 'Weapon Mastery',
    archetype: 'phys',
    description: 'Years of focused weapon training sharpens accuracy and opens up critical strike windows more reliably.',
    statBonuses: { attackRating: 8, criticalHitChance: 2 },
  },
];

// ═══════════════════════════════════════════════════════════
// ABILITY RESOLUTION — maps node IDs to CombatAbilityDefinitions
// ═══════════════════════════════════════════════════════════

/** Lookup map: ability id → CombatAbilityDefinition */
const ABILITY_MAP = new Map<string, CombatAbilityDefinition>(
  T1_ABILITIES.map(a => [a.id, a]),
  // Future: spread T2_ABILITIES, T3_ABILITIES here as they're added
);

/**
 * Resolve a companion's active loadout into CombatAbilityDefinitions.
 *
 * Takes the companion's slotted node IDs and returns the corresponding
 * ability definitions. Node IDs follow the convention `active_{sector}_t{tier}`
 * — the ability id is extracted from the node's activeEffect or looked up
 * by matching the sector+tier to the known ability table.
 *
 * For T1 nodes, the ability id is the same as the T1_ABILITIES entries
 * (e.g., active_tank_t1 → provoke, active_healer_t1 → mend).
 *
 * @param slottedNodeIds Array of (nodeId | null) from the companion's loadout
 * @returns Array of resolved CombatAbilityDefinition (skips nulls / unknown IDs)
 */
export function resolveAbilitiesFromLoadout(
  slottedNodeIds: (string | null)[],
): CombatAbilityDefinition[] {
  const resolved: CombatAbilityDefinition[] = [];

  // Map from active web node IDs to ability IDs
  const nodeToAbilityId: Record<string, string> = {
    active_tank_t1:    'provoke',
    active_healer_t1:  'mend',
    active_magic_t1:   'shadow_bolt',
    active_support_t1: 'embolden',
    active_control_t1: 'ensnare',
    active_phys_t1:    'power_strike',
    // Future T2/T3 mappings will be added here as abilities are defined
  };

  for (const nodeId of slottedNodeIds) {
    if (!nodeId) continue;

    // Try direct lookup (ability ID matches node ID in some cases)
    let def = ABILITY_MAP.get(nodeId);
    if (def) {
      resolved.push(def);
      continue;
    }

    // Try mapping from node ID to ability ID
    const abilityId = nodeToAbilityId[nodeId];
    if (abilityId) {
      def = ABILITY_MAP.get(abilityId);
      if (def) resolved.push(def);
    }
    // Unknown node IDs are silently skipped (future T2/T3 abilities)
  }

  return resolved;
}
