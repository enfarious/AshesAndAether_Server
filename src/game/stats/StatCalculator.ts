/**
 * Stat Calculator - Computes derived stats from core stats
 */

export interface CoreStats {
  strength: number;
  vitality: number;
  dexterity: number;
  agility: number;
  intelligence: number;
  wisdom: number;
}

export interface DerivedStats {
  // Resources
  maxHp: number;
  maxStamina: number;
  maxMana: number;
  carryingCapacity: number;

  // Physical Combat
  attackRating: number;
  defenseRating: number;
  physicalAccuracy: number;
  evasion: number;
  damageAbsorption: number;
  glancingBlowChance: number;
  criticalHitChance: number;
  penetratingBlowChance: number;
  deflectedBlowChance: number;

  // Magic Combat
  magicAttack: number;
  magicDefense: number;
  magicAccuracy: number;
  magicEvasion: number;
  magicAbsorption: number;

  // Speed & Timing
  initiative: number;
  movementSpeed: number;
  attackSpeedBonus: number;
}

export interface EquipmentBonuses {
  attackRating?: number;
  defenseRating?: number;
  physicalAccuracy?: number;
  evasion?: number;
  damageAbsorption?: number;
  magicDefense?: number;
  magicAccuracy?: number;
  magicEvasion?: number;
  magicAbsorption?: number;
  maxHp?: number;
  maxStamina?: number;
  maxMana?: number;
  criticalHitChance?: number;
  penetratingBlowChance?: number;
  deflectedBlowChance?: number;
}

export class StatCalculator {
  /**
   * Calculate all derived stats from core stats
   */
  static calculateDerivedStats(
    core: CoreStats,
    level: number = 1,
    equipment: EquipmentBonuses = {}
  ): DerivedStats {
    return {
      // Resources
      maxHp: this.calculateMaxHp(core.vitality, level, equipment.maxHp),
      maxStamina: this.calculateMaxStamina(core.vitality, core.agility, equipment.maxStamina),
      maxMana: this.calculateMaxMana(core.intelligence, core.wisdom, equipment.maxMana),
      carryingCapacity: this.calculateCarryingCapacity(core.strength),

      // Physical Combat
      attackRating: this.calculateAttackRating(core.strength, equipment.attackRating),
      defenseRating: this.calculateDefenseRating(core.vitality, equipment.defenseRating),
      physicalAccuracy: this.calculatePhysicalAccuracy(core.dexterity, equipment.physicalAccuracy),
      evasion: this.calculateEvasion(core.agility, equipment.evasion),
      damageAbsorption: this.calculateDamageAbsorption(core.vitality, equipment.damageAbsorption),
      glancingBlowChance: this.calculateGlancingBlowChance(core.agility),
      criticalHitChance: this.calculateCriticalHitChance(core.dexterity, equipment.criticalHitChance),
      penetratingBlowChance: this.calculatePenetratingBlowChance(core.strength, equipment.penetratingBlowChance),
      deflectedBlowChance: this.calculateDeflectedBlowChance(core.dexterity, equipment.deflectedBlowChance),

      // Magic Combat
      magicAttack: this.calculateMagicAttack(core.intelligence, equipment.attackRating),
      magicDefense: this.calculateMagicDefense(core.wisdom, equipment.magicDefense),
      magicAccuracy: this.calculateMagicAccuracy(core.intelligence, equipment.magicAccuracy),
      magicEvasion: this.calculateMagicEvasion(core.wisdom, equipment.magicEvasion),
      magicAbsorption: this.calculateMagicAbsorption(core.wisdom, equipment.magicAbsorption),

      // Speed & Timing
      initiative: this.calculateInitiative(core.agility),
      movementSpeed: this.calculateMovementSpeed(core.agility),
      attackSpeedBonus: this.calculateAttackSpeedBonus(core.agility),
    };
  }

  // ========== Resource Calculations ==========

  private static calculateMaxHp(vitality: number, level: number, bonus: number = 0): number {
    return 100 + vitality * 10 + level * 5 + bonus;
  }

  private static calculateMaxStamina(
    vitality: number,
    agility: number,
    bonus: number = 0
  ): number {
    return 100 + vitality * 5 + agility * 3 + bonus;
  }

  private static calculateMaxMana(
    intelligence: number,
    wisdom: number,
    bonus: number = 0
  ): number {
    return 100 + intelligence * 5 + wisdom * 5 + bonus;
  }

  private static calculateCarryingCapacity(strength: number): number {
    return strength * 10; // kg
  }

  // ========== Physical Combat Calculations ==========

  private static calculateAttackRating(strength: number, bonus: number = 0): number {
    // Base attack from strength (before weapon modifiers)
    return 10 + strength * 2 + bonus;
  }

  private static calculateDefenseRating(vitality: number, bonus: number = 0): number {
    return vitality * 0.5 + bonus;
  }

  private static calculatePhysicalAccuracy(dexterity: number, bonus: number = 0): number {
    return 75 + dexterity * 2 + bonus;
  }

  private static calculateEvasion(agility: number, bonus: number = 0): number {
    return 5 + agility * 2 + bonus;
  }

  private static calculateDamageAbsorption(vitality: number, bonus: number = 0): number {
    return vitality * 0.3 + bonus;
  }

  private static calculateGlancingBlowChance(agility: number): number {
    return agility * 0.5; // Percentage
  }

  private static calculateCriticalHitChance(dexterity: number, bonus: number = 0): number {
    return 5 + dexterity * 0.2 + bonus;
  }

  private static calculatePenetratingBlowChance(strength: number, bonus: number = 0): number {
    return 5 + strength * 0.1 + bonus;
  }

  private static calculateDeflectedBlowChance(dexterity: number, bonus: number = 0): number {
    return 5 + dexterity * 0.1 + bonus;
  }

  // ========== Magic Combat Calculations ==========

  private static calculateMagicAttack(intelligence: number, bonus: number = 0): number {
    return 10 + intelligence * 2 + bonus;
  }

  private static calculateMagicDefense(wisdom: number, bonus: number = 0): number {
    return wisdom * 0.5 + bonus;
  }

  private static calculateMagicAccuracy(intelligence: number, bonus: number = 0): number {
    return 75 + intelligence * 2 + bonus;
  }

  private static calculateMagicEvasion(wisdom: number, bonus: number = 0): number {
    return 5 + wisdom * 2 + bonus;
  }

  private static calculateMagicAbsorption(wisdom: number, bonus: number = 0): number {
    return wisdom * 0.3 + bonus;
  }

  // ========== Speed & Timing Calculations ==========

  private static calculateInitiative(agility: number): number {
    return agility; // + d20 roll when combat starts
  }

  private static calculateMovementSpeed(agility: number): number {
    return 5 + agility * 0.1; // meters per second
  }

  private static calculateAttackSpeedBonus(agility: number): number {
    return agility * 0.5; // Percentage cooldown reduction
  }

  // ========== Weapon Damage Calculation ==========

  /**
   * Calculate weapon damage with stat scaling
   */
  static calculateWeaponDamage(
    weaponBaseDamage: number,
    primaryStat: number,
    primaryScaling: number,
    secondaryStat: number = 0,
    secondaryScaling: number = 0
  ): number {
    const primaryBonus = primaryStat * primaryScaling;
    const secondaryBonus = secondaryStat * secondaryScaling * 0.5;

    return weaponBaseDamage + primaryBonus + secondaryBonus;
  }

  /**
   * Get stat scaling rank multiplier
   */
  static getScalingMultiplier(rank: 'S' | 'A' | 'B' | 'C' | 'D'): number {
    const multipliers = {
      S: 1.2,
      A: 1.0,
      B: 0.8,
      C: 0.6,
      D: 0.4,
    };
    return multipliers[rank];
  }

  // ========== XP Cost Calculations ==========

  /**
   * Calculate XP cost to raise a stat from current to next level
   */
  static calculateStatUpgradeCost(currentStatLevel: number): number {
    return 100 * currentStatLevel;
  }

  /**
   * Calculate total XP needed to reach a target level
   */
  static calculateLevelXpRequirement(level: number): number {
    // Progressive curve: 1000 * level^1.5
    return Math.floor(1000 * Math.pow(level, 1.5));
  }

  // ========== Feat Unlocking ==========

  /**
   * Get unlocked feats based on stat levels
   */
  static getUnlockedFeats(stats: CoreStats): string[] {
    const feats: string[] = [];

    // Strength feats
    if (stats.strength >= 15) feats.push('power_attack');
    if (stats.strength >= 25) feats.push('titans_grip');
    if (stats.strength >= 40) feats.push('unbreakable');

    // Vitality feats
    if (stats.vitality >= 15) feats.push('thick_skinned');
    if (stats.vitality >= 25) feats.push('iron_constitution');
    if (stats.vitality >= 40) feats.push('phoenix_rebirth');

    // Dexterity feats
    if (stats.dexterity >= 15) feats.push('precision_strike');
    if (stats.dexterity >= 25) feats.push('riposte_master');
    if (stats.dexterity >= 40) feats.push('assassins_focus');

    // Agility feats
    if (stats.agility >= 15) feats.push('fleet_footed');
    if (stats.agility >= 25) feats.push('elusive');
    if (stats.agility >= 40) feats.push('bullet_time');

    // Intelligence feats
    if (stats.intelligence >= 15) feats.push('spell_mastery');
    if (stats.intelligence >= 25) feats.push('overcharge');
    if (stats.intelligence >= 40) feats.push('archmage');

    // Wisdom feats
    if (stats.wisdom >= 15) feats.push('inner_peace');
    if (stats.wisdom >= 25) feats.push('spell_ward');
    if (stats.wisdom >= 40) feats.push('transcendence');

    return feats;
  }

  // ========== Combat Formulas ==========

  /**
   * Calculate hit chance
   */
  static calculateHitChance(attackerAccuracy: number, defenderEvasion: number): number {
    const baseChance = 75; // Base 75% hit chance
    const accuracyBonus = (attackerAccuracy - 75) * 0.5;
    const evasionPenalty = defenderEvasion * 0.5;

    const hitChance = baseChance + accuracyBonus - evasionPenalty;

    // Clamp between 5% and 95%
    return Math.max(5, Math.min(95, hitChance));
  }

  /**
   * Calculate final damage after all reductions
   */
  static calculateFinalDamage(
    baseDamage: number,
    damageAbsorption: number,
    defenseRating: number,
    isGlancingBlow: boolean = false
  ): number {
    let damage = baseDamage;

    // Apply glancing blow reduction first
    if (isGlancingBlow) {
      damage *= 0.5;
    }

    // Subtract flat absorption
    damage -= damageAbsorption;

    // Apply percentage reduction from defense
    const defenseReduction = defenseRating / (defenseRating + 100);
    damage *= 1 - defenseReduction;

    // Minimum damage is 1
    return Math.max(1, Math.floor(damage));
  }

  /**
   * Calculate critical hit damage
   */
  static calculateCriticalDamage(
    baseDamage: number,
    critMultiplier: number = 1.5
  ): number {
    return Math.floor(baseDamage * critMultiplier);
  }
}
