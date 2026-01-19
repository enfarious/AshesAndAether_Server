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
    scalingValue: number,
    options?: { damageMultiplier?: number }
  ): DamageResult {
    const damageType = ability.damage?.type || 'physical';
    const mitigationCategory = MITIGATION_CATEGORY[damageType];
    const damageMultiplier = options?.damageMultiplier ?? 1;
    const baseDamage = this.calculateBaseDamage(ability, attacker, scalingValue) * damageMultiplier;

    const hitChance = mitigationCategory === 'magic'
      ? StatCalculator.calculateHitChance(attacker.magicAccuracy, defender.magicEvasion)
      : StatCalculator.calculateHitChance(attacker.physicalAccuracy, defender.evasion);

    const hitRoll = Math.random() * 100;
    if (hitRoll > hitChance) {
      return {
        hit: false,
        outcome: 'miss',
        critical: false,
        deflected: false,
        penetrating: false,
        glancing: false,
        amount: 0,
        baseDamage,
        mitigatedDamage: 0,
      };
    }

    const outcome = this.rollOutcome(attacker);
    let damage = baseDamage;
    let mitigatedDamage = baseDamage;

    if (outcome.critical) {
      damage = StatCalculator.calculateCriticalDamage(baseDamage, 1.5);
    }

    if (outcome.penetrating) {
      mitigatedDamage = this.applyPenetrating(damage, defender, mitigationCategory);
    } else {
      mitigatedDamage = this.applyMitigation(damage, defender, mitigationCategory, outcome.glancing);
    }

    if (outcome.deflected) {
      mitigatedDamage = Math.max(1, Math.floor(mitigatedDamage * 0.5));
    }

    damage = mitigatedDamage;

    return {
      hit: true,
      outcome: outcome.outcome,
      critical: outcome.critical,
      deflected: outcome.deflected,
      penetrating: outcome.penetrating,
      glancing: outcome.glancing,
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

  private rollOutcome(attacker: CombatStats): {
    outcome: DamageResult['outcome'];
    critical: boolean;
    deflected: boolean;
    penetrating: boolean;
    glancing: boolean;
  } {
    const crit = this.clampChance(attacker.criticalHitChance, BASE_CRIT_CHANCE);
    const glance = this.clampChance(attacker.glancingBlowChance, 0);
    const penetrating = this.clampChance(attacker.penetratingBlowChance, BASE_PENETRATING_CHANCE);
    const deflected = this.clampChance(attacker.deflectedBlowChance, BASE_DEFLECTED_CHANCE);

    const outcome: {
      outcome: DamageResult['outcome'];
      critical: boolean;
      deflected: boolean;
      penetrating: boolean;
      glancing: boolean;
    } = {
      outcome: 'hit',
      critical: false,
      deflected: false,
      penetrating: false,
      glancing: false,
    };

    // Crit vs deflected (mutually exclusive)
    const rollPrimary = Math.random() * 100;
    if (rollPrimary < crit) {
      outcome.critical = true;
    } else if (rollPrimary < crit + deflected) {
      outcome.deflected = true;
    }

    // Penetrating vs glancing (mutually exclusive); glancing allowed with deflected
    const rollSecondary = Math.random() * 100;
    const canPenetrate = !outcome.deflected;
    const canGlance = !outcome.critical;

    if (canPenetrate && rollSecondary < penetrating) {
      outcome.penetrating = true;
    } else if (canGlance) {
      const glanceThreshold = canPenetrate ? penetrating + glance : glance;
      if (rollSecondary < glanceThreshold) {
        outcome.glancing = true;
      }
    }

    if (outcome.critical) {
      outcome.outcome = 'crit';
    } else if (outcome.deflected) {
      outcome.outcome = 'deflected';
    } else if (outcome.penetrating) {
      outcome.outcome = 'penetrating';
    } else if (outcome.glancing) {
      outcome.outcome = 'glance';
    }

    return outcome;
  }

  private clampChance(value: number, fallback: number): number {
    const use = Number.isFinite(value) ? value : fallback;
    return Math.max(0, Math.min(100, use));
  }
}
