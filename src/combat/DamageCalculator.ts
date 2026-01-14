import { StatCalculator } from '@/game/stats/StatCalculator';
import type { DamageType } from '@/game/abilities/AbilityTypes';
import { CombatAbilityDefinition, CombatStats, DamageResult } from './types';

const BASE_CRIT_CHANCE = 5;
const BASE_PENETRATING_CHANCE = 5;
const BASE_DEFLECTED_CHANCE = 5;

// Maps all damage types to their mitigation category
// Physical: uses defense rating and damage absorption
// Magic: uses magic defense and magic absorption
const MITIGATION_CATEGORY: Record<DamageType, 'physical' | 'magic'> = {
  physical: 'physical',
  magic: 'magic',
  fire: 'magic',
  ice: 'magic',
  lightning: 'magic',
  poison: 'magic',
  holy: 'magic',
  dark: 'magic',
};

export class DamageCalculator {
  calculate(
    ability: CombatAbilityDefinition,
    attacker: CombatStats,
    defender: CombatStats,
    scalingValue: number
  ): DamageResult {
    const damageType = ability.damage?.type || 'physical';
    const mitigationCategory = MITIGATION_CATEGORY[damageType];
    const baseDamage = this.calculateBaseDamage(ability, attacker, scalingValue);

    const hitChance = mitigationCategory === 'magic'
      ? StatCalculator.calculateHitChance(attacker.magicAccuracy, defender.magicEvasion)
      : StatCalculator.calculateHitChance(attacker.physicalAccuracy, defender.evasion);

    const hitRoll = Math.random() * 100;
    if (hitRoll > hitChance) {
      return {
        hit: false,
        outcome: 'miss',
        amount: 0,
        baseDamage,
        mitigatedDamage: 0,
      };
    }

    const outcome = this.rollOutcome(attacker);
    let damage = baseDamage;
    let mitigatedDamage = baseDamage;

    if (outcome === 'crit') {
      damage = StatCalculator.calculateCriticalDamage(baseDamage, 1.5);
      mitigatedDamage = this.applyMitigation(damage, defender, mitigationCategory, false);
    } else if (outcome === 'glance') {
      mitigatedDamage = this.applyMitigation(baseDamage, defender, mitigationCategory, true);
      damage = mitigatedDamage;
    } else if (outcome === 'penetrating') {
      mitigatedDamage = this.applyPenetrating(baseDamage, defender, mitigationCategory);
      damage = mitigatedDamage;
    } else if (outcome === 'deflected') {
      mitigatedDamage = Math.max(
        1,
        Math.floor(this.applyMitigation(baseDamage, defender, mitigationCategory, false) * 0.5)
      );
      damage = mitigatedDamage;
    } else {
      mitigatedDamage = this.applyMitigation(baseDamage, defender, mitigationCategory, false);
      damage = mitigatedDamage;
    }

    return {
      hit: true,
      outcome,
      amount: damage,
      baseDamage,
      mitigatedDamage,
    };
  }

  private calculateBaseDamage(
    ability: CombatAbilityDefinition,
    attacker: CombatStats,
    scalingValue: number
  ): number {
    if (!ability.damage) {
      return Math.max(1, Math.floor(attacker.attackRating * 0.5));
    }

    const scaling = ability.damage.scalingMultiplier
      ? scalingValue * ability.damage.scalingMultiplier
      : 0;

    return Math.max(1, Math.floor(ability.damage.amount + scaling));
  }

  private applyMitigation(
    baseDamage: number,
    defender: CombatStats,
    damageType: 'physical' | 'magic',
    isGlancing: boolean
  ): number {
    if (damageType === 'magic') {
      const afterAbsorb = baseDamage - defender.magicAbsorption;
      const defenseReduction = defender.magicDefense / (defender.magicDefense + 100);
      let damage = afterAbsorb * (1 - defenseReduction);
      if (isGlancing) damage *= 0.5;
      return Math.max(1, Math.floor(damage));
    }

    return StatCalculator.calculateFinalDamage(
      baseDamage,
      defender.damageAbsorption,
      defender.defenseRating,
      isGlancing
    );
  }

  private applyPenetrating(
    baseDamage: number,
    defender: CombatStats,
    damageType: 'physical' | 'magic'
  ): number {
    if (damageType === 'magic') {
      const damage = baseDamage - defender.magicAbsorption;
      return Math.max(1, Math.floor(damage));
    }

    const damage = baseDamage - defender.damageAbsorption;
    return Math.max(1, Math.floor(damage));
  }

  private rollOutcome(attacker: CombatStats): DamageResult['outcome'] {
    const crit = this.clampChance(attacker.criticalHitChance, BASE_CRIT_CHANCE);
    const glance = this.clampChance(attacker.glancingBlowChance, 0);
    const penetrating = this.clampChance(attacker.penetratingBlowChance, BASE_PENETRATING_CHANCE);
    const deflected = this.clampChance(attacker.deflectedBlowChance, BASE_DEFLECTED_CHANCE);

    const roll = Math.random() * 100;

    if (roll < crit) return 'crit';
    if (roll < crit + glance) return 'glance';
    if (roll < crit + glance + penetrating) return 'penetrating';
    if (roll < crit + glance + penetrating + deflected) return 'deflected';
    return 'hit';
  }

  private clampChance(value: number, fallback: number): number {
    const use = Number.isFinite(value) ? value : fallback;
    return Math.max(0, Math.min(100, use));
  }
}
