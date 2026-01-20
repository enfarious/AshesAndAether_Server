import { StatCalculator } from '@/game/stats/StatCalculator';
import type { DamageType } from '@/game/abilities/AbilityTypes';
import { CombatAbilityDefinition, CombatStats, DamageProfileSegment, DamageResult } from './types';

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
    options?: {
      damageMultiplier?: number;
      damageProfiles?: DamageProfileSegment[];
      baseDamageOverride?: number;
      qualityBiasMultipliers?: Record<string, number>;
    }
  ): DamageResult {
    const damageType = ability.damage?.type || 'physical';
    const mitigationCategory = MITIGATION_CATEGORY[damageType];
    const damageMultiplier = options?.damageMultiplier ?? 1;
    const baseDamage = this.calculateBaseDamage(ability, attacker, scalingValue, options?.baseDamageOverride) * damageMultiplier;

    const hitChance = mitigationCategory === 'magic'
      ? StatCalculator.calculateHitChance(attacker.magicAccuracy, defender.magicEvasion)
      : StatCalculator.calculateHitChance(attacker.physicalAccuracy, defender.evasion);

    const hitRoll = Math.random() * 100;
    if (hitRoll > hitChance) {
      const quality = { quality: 'normal' as const, multiplier: 1 };
      return {
        hit: false,
        outcome: 'miss',
        critical: false,
        deflected: false,
        penetrating: false,
        glancing: false,
        quality: quality.quality,
        qualityMultiplier: quality.multiplier,
        amount: 0,
        baseDamage: Math.max(1, Math.floor(baseDamage)),
        mitigatedDamage: 0,
      };
    }

    const outcome = this.rollOutcome(attacker);
    const profiles = this.normalizeProfiles(options?.damageProfiles, damageType, ability.damage?.physicalType);
    const hasPhysical = profiles.some(profile => profile.damageType === 'physical');
    const physicalType = ability.damage?.type === 'physical' ? ability.damage?.physicalType : undefined;
    const biasMultiplier = physicalType
      ? (options?.qualityBiasMultipliers?.[physicalType] ?? 1)
      : 1;
    const quality = hasPhysical ? this.rollPhysicalQuality('physical', outcome, biasMultiplier) : { quality: 'normal' as const, multiplier: 1 };
    const breakdown: DamageResult['damageBreakdown'] = [];

    let baseTotal = 0;
    let mitigatedTotal = 0;
    let amountTotal = 0;

    const minSegmentDamage = profiles.length > 1 ? 0 : 1;

    for (const profile of profiles) {
      const baseSegment = Math.max(0, baseDamage * profile.ratio);
      const qualityMultiplier = profile.damageType === 'physical' ? quality.multiplier : 1;
      const adjustedBase = Math.max(0, baseSegment * qualityMultiplier);
      let segmentDamage = adjustedBase;
      let segmentMitigated = adjustedBase;

      if (outcome.critical) {
        segmentDamage = StatCalculator.calculateCriticalDamage(adjustedBase, 1.5);
      }

      if (outcome.penetrating) {
        segmentMitigated = this.applyPenetrating(segmentDamage, defender, MITIGATION_CATEGORY[profile.damageType], minSegmentDamage);
      } else {
        segmentMitigated = this.applyMitigation(
          segmentDamage,
          defender,
          MITIGATION_CATEGORY[profile.damageType],
          outcome.glancing,
          minSegmentDamage
        );
      }

      if (outcome.deflected) {
        segmentMitigated = Math.max(minSegmentDamage, Math.floor(segmentMitigated * 0.5));
      }

      breakdown.push({
        damageType: profile.damageType,
        physicalType: profile.physicalType,
        amount: segmentMitigated,
        baseDamage: Math.floor(adjustedBase),
        mitigatedDamage: segmentMitigated,
      });

      baseTotal += Math.floor(adjustedBase);
      mitigatedTotal += segmentMitigated;
      amountTotal += segmentMitigated;
    }

    if (amountTotal <= 0) {
      amountTotal = 1;
      mitigatedTotal = Math.max(mitigatedTotal, 1);
      if (breakdown.length > 0) {
        breakdown[0].amount = Math.max(breakdown[0].amount, 1);
        breakdown[0].mitigatedDamage = breakdown[0].amount;
      }
    }

    return {
      hit: true,
      outcome: outcome.outcome,
      critical: outcome.critical,
      deflected: outcome.deflected,
      penetrating: outcome.penetrating,
      glancing: outcome.glancing,
      quality: quality.quality,
      qualityMultiplier: quality.multiplier,
      amount: amountTotal,
      baseDamage: baseTotal,
      mitigatedDamage: mitigatedTotal,
      damageBreakdown: breakdown,
    };
  }

  private calculateBaseDamage(
    ability: CombatAbilityDefinition,
    attacker: CombatStats,
    scalingValue: number,
    baseDamageOverride?: number
  ): number {
    if (!ability.damage) {
      return Math.max(1, Math.floor(attacker.attackRating * 0.5));
    }

    const scaling = ability.damage.scalingMultiplier
      ? scalingValue * ability.damage.scalingMultiplier
      : 0;

    const base = Number.isFinite(baseDamageOverride) ? baseDamageOverride : ability.damage.amount;
    return Math.max(1, Math.floor(base + scaling));
  }

  private applyMitigation(
    baseDamage: number,
    defender: CombatStats,
    damageType: 'physical' | 'magic',
    isGlancing: boolean,
    minDamage: number = 1
  ): number {
    if (damageType === 'magic') {
      const afterAbsorb = baseDamage - defender.magicAbsorption;
      const defenseReduction = defender.magicDefense / (defender.magicDefense + 100);
      let damage = afterAbsorb * (1 - defenseReduction);
      if (isGlancing) damage *= 0.5;
      return Math.max(minDamage, Math.floor(damage));
    }

    const damage = StatCalculator.calculateFinalDamage(
      baseDamage,
      defender.damageAbsorption,
      defender.defenseRating,
      isGlancing
    );
    return Math.max(minDamage, damage);
  }

  private applyPenetrating(
    baseDamage: number,
    defender: CombatStats,
    damageType: 'physical' | 'magic',
    minDamage: number = 1
  ): number {
    if (damageType === 'magic') {
      const damage = baseDamage - defender.magicAbsorption;
      return Math.max(minDamage, Math.floor(damage));
    }

    const damage = baseDamage - defender.damageAbsorption;
    return Math.max(minDamage, Math.floor(damage));
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

  private rollPhysicalQuality(
    damageType: DamageType,
    outcome?: { critical: boolean; deflected: boolean; glancing: boolean },
    biasMultiplier: number = 1
  ): { quality: 'poor' | 'normal' | 'good'; multiplier: number } {
    if (damageType !== 'physical') {
      return { quality: 'normal', multiplier: 1 };
    }

    const roll = Math.random() * 100;
    const bias = this.normalizeBiasMultiplier(biasMultiplier);
    const { poorChance, goodChance } = this.calculateQualityChances(bias);
    const isNearMiss = outcome?.deflected || outcome?.glancing;
    const isCrit = outcome?.critical;

    if (isCrit) {
      if (roll > 100 - goodChance) {
        return { quality: 'good', multiplier: 1.1 };
      }
      return { quality: 'normal', multiplier: 1 };
    }

    if (isNearMiss) {
      if (roll < poorChance) {
        return { quality: 'poor', multiplier: 0.9 };
      }
      return { quality: 'normal', multiplier: 1 };
    }

    if (roll < poorChance) {
      return { quality: 'poor', multiplier: 0.9 };
    }
    if (roll > 100 - goodChance) {
      return { quality: 'good', multiplier: 1.1 };
    }
    return { quality: 'normal', multiplier: 1 };
  }

  private normalizeBiasMultiplier(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.max(0.1, Math.min(3, value));
  }

  private calculateQualityChances(multiplier: number): { poorChance: number; goodChance: number } {
    const basePoor = 15;
    const baseGood = 15;

    let good = baseGood * multiplier;
    let poor = basePoor / multiplier;

    const total = good + poor;
    if (total > 95) {
      const scale = 95 / total;
      good *= scale;
      poor *= scale;
    }

    good = Math.max(1, Math.min(95, good));
    poor = Math.max(1, Math.min(95, poor));

    return { poorChance: poor, goodChance: good };
  }

  private normalizeProfiles(
    profiles: DamageProfileSegment[] | undefined,
    fallbackType: DamageType,
    fallbackPhysical?: DamageProfileSegment['physicalType']
  ): DamageProfileSegment[] {
    if (!profiles || profiles.length === 0) {
      return [{ damageType: fallbackType, physicalType: fallbackPhysical, ratio: 1 }];
    }

    const total = profiles.reduce((sum, profile) => sum + profile.ratio, 0);
    if (total <= 0) {
      return [{ damageType: fallbackType, physicalType: fallbackPhysical, ratio: 1 }];
    }

    return profiles.map(profile => ({
      damageType: profile.damageType,
      physicalType: profile.physicalType,
      ratio: profile.ratio / total,
    }));
  }
}
