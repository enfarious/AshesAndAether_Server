/**
 * Companion Archetype Modifiers
 *
 * Each archetype receives permanent stat buffs and debuffs that shape their
 * combat identity. Applied when the companion registers in a zone and
 * recalculated on level sync.
 *
 * - cautious_healer: +15% heal potency, +1 mana regen/tick
 * - opportunist:     +5% crit chance, −4 defense
 * - scrappy_fighter:  +6 attack, +15 max HP, −20% heal potency received
 * - tank:            +8 def, +20 max HP, +50% threat, −4 atk, −15% heal potency
 *
 * Stat Growth (per level, 5 total — matches player stat points per level):
 * - tank:            STR+1, VIT+2, AGI+1, WIS+1
 * - scrappy_fighter: STR+2, VIT+1, DEX+1, AGI+1
 * - cautious_healer: VIT+1, AGI+1, INT+1, WIS+2
 * - opportunist:     STR+1, VIT+1, DEX+1, AGI+2
 */

import type { CompanionArchetype } from './CompanionCombatSettings';
import type { CoreStats } from '../game/stats/StatCalculator';

export interface ArchetypeModifier {
  archetype: CompanionArchetype;
  /** Display name for the buff/debuff set */
  label: string;
  /** Core stat growth per level — values should sum to STAT_POINTS_PER_LEVEL (5) */
  statGrowth: CoreStats;
  /** Stat modifications — additive for flat stats, multiplied for *Mult fields */
  statMods: {
    // Flat combat stats (additive)
    attackRating?: number;
    defenseRating?: number;
    maxHp?: number;
    criticalHitChance?: number;
    manaRegen?: number;
    // Multipliers (applied as factors, not additions)
    healPotencyMult?: number;   // 1.0 = no change, 1.15 = +15%, 0.80 = −20%
    threatMultiplier?: number;  // Overrides CombatantState.threatMultiplier
  };
}

export const ARCHETYPE_MODIFIERS: Record<CompanionArchetype, ArchetypeModifier> = {
  cautious_healer: {
    archetype: 'cautious_healer',
    label: "Healer's Attunement",
    statGrowth: { strength: 0, vitality: 1, dexterity: 0, agility: 1, intelligence: 1, wisdom: 2 },
    statMods: {
      healPotencyMult: 1.15,
      manaRegen: 1,
    },
  },
  opportunist: {
    archetype: 'opportunist',
    label: "Exploiter's Edge",
    statGrowth: { strength: 1, vitality: 1, dexterity: 1, agility: 2, intelligence: 0, wisdom: 0 },
    statMods: {
      criticalHitChance: 5,
      defenseRating: -4,
    },
  },
  scrappy_fighter: {
    archetype: 'scrappy_fighter',
    label: "Brawler's Tenacity",
    statGrowth: { strength: 2, vitality: 1, dexterity: 1, agility: 1, intelligence: 0, wisdom: 0 },
    statMods: {
      attackRating: 6,
      maxHp: 15,
      healPotencyMult: 0.80,
    },
  },
  tank: {
    archetype: 'tank',
    label: "Guardian's Resolve",
    statGrowth: { strength: 1, vitality: 2, dexterity: 0, agility: 1, intelligence: 0, wisdom: 1 },
    statMods: {
      defenseRating: 8,
      maxHp: 20,
      threatMultiplier: 1.5,
      attackRating: -4,
      healPotencyMult: 0.85,
    },
  },
};
