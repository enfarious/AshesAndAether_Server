/**
 * Companion Combat Settings — the "settings object" that the behavior tree reads.
 *
 * The LLM (prefrontal cortex) adjusts these settings on meaningful state changes.
 * The behavior tree (motor cortex) polls them every tick.
 * The tree doesn't know or care whether settings came from an LLM call or a config file.
 */

// ── Range bands (meters from target) ────────────────────────────────────────

export type PreferredRange = 'melee' | 'close' | 'mid' | 'far';

export const RANGE_DISTANCES: Record<PreferredRange, { min: number; ideal: number; max: number }> = {
  melee: { min: 0, ideal: 2.5, max: 3.5 },
  close: { min: 3, ideal: 5, max: 8 },
  mid:   { min: 8, ideal: 15, max: 20 },
  far:   { min: 20, ideal: 30, max: 40 },
};

// ── Target priority ─────────────────────────────────────────────────────────

export type TargetPriority = 'weakest' | 'nearest' | 'threatening_player';

// ── Stance ──────────────────────────────────────────────────────────────────

export type CombatStance = 'aggressive' | 'cautious' | 'support';

// ── Engagement mode ─────────────────────────────────────────────────────────

/** Three-state engagement gate:
 *  - aggressive: charge any hostile mob within detection range
 *  - defensive:  only fight mobs attacking the owner or companion (uses enmity tracker)
 *  - passive:    never auto-engage; only fight when player explicitly commands
 */
export type EngagementMode = 'aggressive' | 'defensive' | 'passive';

// ── Heal priority ─────────────────────────────────────────────────────────

export type HealPriorityMode = 'lowest_hp' | 'most_damage_taken' | 'tank_first';

// ── The settings object ─────────────────────────────────────────────────────

export interface CompanionCombatSettings {
  preferredRange: PreferredRange;
  priority: TargetPriority;
  stance: CombatStance;
  /** Ability category weights (0–1). Keys are ability categories: 'heal', 'damage', 'cc', etc. */
  abilityWeights: Record<string, number>;
  /** Pull back if HP ratio drops below this (0–1). e.g. 0.25 = retreat at 25% HP. */
  retreatThreshold: number;

  /** Three-state engagement mode — controls when the companion auto-engages. */
  engagementMode: EngagementMode;

  // ── Engagement overrides (applied on top of engagementMode) ────────────
  // Species-level overrides trump family-level.

  /** Mob families to never initiate combat against. */
  ignoreFamily: string[];
  /** Mob families to always engage (overrides engagementMode). */
  alwaysEngageFamily: string[];
  /** Mob species to never initiate combat against (overrides family rules). */
  ignoreSpecies: string[];
  /** Mob species to always engage (overrides family rules and engagementMode). */
  alwaysEngageSpecies: string[];

  // ── Healing rules ──────────────────────────────────────────────────────

  /** Switch focus to healing allies when their HP ratio drops below this (0–1). */
  healAllyThreshold: number;
  /** Don't heal targets above this HP ratio (0–1). Prevents overhealing. */
  minHealTarget: number;
  /** How to prioritize multiple injured allies. */
  healPriorityMode: HealPriorityMode;

  // ── Buff / cooldown rules ──────────────────────────────────────────────

  /** Hold long-cooldown abilities for elites/bosses. */
  saveCooldownsForElites: boolean;
  /** Don't use buffs/CDs if target mob below this HP ratio (0–1). */
  minEnemyHpForBuffs: number;

  // ── Resource management ────────────────────────────────────────────────

  /** Keep this % of mana/stamina reserved for emergencies (0–100). */
  resourceReservePercent: number;

  // ── Recovery ───────────────────────────────────────────────────────────

  /** Use defensive abilities when own HP drops below this ratio (0–1). */
  defensiveThreshold: number;
}

// ── Archetypes ──────────────────────────────────────────────────────────────

export type CompanionArchetype = 'scrappy_fighter' | 'cautious_healer' | 'opportunist' | 'tank';

/**
 * Baseline settings per archetype. Each companion starts from their archetype
 * baseline. The LLM nudges from this rather than redefining behavior from scratch.
 */
export const BASELINE_SETTINGS: Record<CompanionArchetype, CompanionCombatSettings> = {
  scrappy_fighter: {
    preferredRange: 'melee',
    priority: 'nearest',
    stance: 'aggressive',
    abilityWeights: { damage: 0.8, cc: 0.3, heal: 0.1 },
    retreatThreshold: 0.1,
    engagementMode: 'aggressive',
    ignoreFamily: [],
    alwaysEngageFamily: ['beast', 'hare'],
    ignoreSpecies: [],
    alwaysEngageSpecies: [],
    healAllyThreshold: 0.6,
    minHealTarget: 0.85,
    healPriorityMode: 'lowest_hp',
    saveCooldownsForElites: false,
    minEnemyHpForBuffs: 0.2,
    resourceReservePercent: 10,
    defensiveThreshold: 0.2,
  },
  cautious_healer: {
    preferredRange: 'mid',
    priority: 'threatening_player',
    stance: 'support',
    abilityWeights: { heal: 0.8, damage: 0.2, cc: 0.4 },
    retreatThreshold: 0.5,
    engagementMode: 'defensive',
    ignoreFamily: ['aberration'],
    alwaysEngageFamily: [],
    ignoreSpecies: [],
    alwaysEngageSpecies: [],
    healAllyThreshold: 0.75,
    minHealTarget: 0.85,
    healPriorityMode: 'lowest_hp',
    saveCooldownsForElites: false,
    minEnemyHpForBuffs: 0.2,
    resourceReservePercent: 20,
    defensiveThreshold: 0.5,
  },
  opportunist: {
    preferredRange: 'mid',
    priority: 'weakest',
    stance: 'cautious',
    abilityWeights: { damage: 0.5, cc: 0.4, heal: 0.3 },
    retreatThreshold: 0.25,
    engagementMode: 'defensive',
    ignoreFamily: [],
    alwaysEngageFamily: [],
    ignoreSpecies: [],
    alwaysEngageSpecies: [],
    healAllyThreshold: 0.6,
    minHealTarget: 0.85,
    healPriorityMode: 'lowest_hp',
    saveCooldownsForElites: true,
    minEnemyHpForBuffs: 0.2,
    resourceReservePercent: 15,
    defensiveThreshold: 0.4,
  },
  tank: {
    preferredRange: 'melee',
    priority: 'threatening_player',
    stance: 'aggressive',
    abilityWeights: { cc: 0.7, damage: 0.5, heal: 0.2 },
    retreatThreshold: 0.15,
    engagementMode: 'aggressive',
    ignoreFamily: [],
    alwaysEngageFamily: ['beast'],
    ignoreSpecies: [],
    alwaysEngageSpecies: [],
    healAllyThreshold: 0.5,
    minHealTarget: 0.85,
    healPriorityMode: 'tank_first',
    saveCooldownsForElites: false,
    minEnemyHpForBuffs: 0.2,
    resourceReservePercent: 10,
    defensiveThreshold: 0.15,
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

export function cloneSettings(settings: CompanionCombatSettings): CompanionCombatSettings {
  return {
    ...settings,
    abilityWeights: { ...settings.abilityWeights },
    ignoreFamily: [...settings.ignoreFamily],
    alwaysEngageFamily: [...settings.alwaysEngageFamily],
    ignoreSpecies: [...settings.ignoreSpecies],
    alwaysEngageSpecies: [...settings.alwaysEngageSpecies],
  };
}

/**
 * Merge a partial settings update onto existing settings.
 * Only fields present in `partial` overwrite. Missing fields keep previous value.
 * Array fields (engagement lists) are replaced wholesale, not merged.
 */
export function mergePartialSettings(
  current: CompanionCombatSettings,
  partial: Partial<CompanionCombatSettings>,
): CompanionCombatSettings {
  const merged = cloneSettings(current);

  if (partial.preferredRange !== undefined) merged.preferredRange = partial.preferredRange;
  if (partial.priority !== undefined) merged.priority = partial.priority;
  if (partial.stance !== undefined) merged.stance = partial.stance;
  if (partial.engagementMode !== undefined) merged.engagementMode = partial.engagementMode;
  if (partial.retreatThreshold !== undefined) {
    merged.retreatThreshold = Math.max(0, Math.min(1, partial.retreatThreshold));
  }
  if (partial.abilityWeights !== undefined) {
    // Merge weight keys — new keys added, existing keys overwritten, missing keys kept
    for (const [key, value] of Object.entries(partial.abilityWeights)) {
      merged.abilityWeights[key] = Math.max(0, Math.min(1, value));
    }
  }

  // Engagement lists — replace wholesale when present
  if (partial.ignoreFamily !== undefined) merged.ignoreFamily = [...partial.ignoreFamily];
  if (partial.alwaysEngageFamily !== undefined) merged.alwaysEngageFamily = [...partial.alwaysEngageFamily];
  if (partial.ignoreSpecies !== undefined) merged.ignoreSpecies = [...partial.ignoreSpecies];
  if (partial.alwaysEngageSpecies !== undefined) merged.alwaysEngageSpecies = [...partial.alwaysEngageSpecies];

  // Healing rules
  if (partial.healAllyThreshold !== undefined) {
    merged.healAllyThreshold = Math.max(0, Math.min(1, partial.healAllyThreshold));
  }
  if (partial.minHealTarget !== undefined) {
    merged.minHealTarget = Math.max(0, Math.min(1, partial.minHealTarget));
  }
  if (partial.healPriorityMode !== undefined) merged.healPriorityMode = partial.healPriorityMode;

  // Buff / cooldown rules
  if (partial.saveCooldownsForElites !== undefined) merged.saveCooldownsForElites = partial.saveCooldownsForElites;
  if (partial.minEnemyHpForBuffs !== undefined) {
    merged.minEnemyHpForBuffs = Math.max(0, Math.min(1, partial.minEnemyHpForBuffs));
  }

  // Resource management
  if (partial.resourceReservePercent !== undefined) {
    merged.resourceReservePercent = Math.max(0, Math.min(100, partial.resourceReservePercent));
  }

  // Recovery
  if (partial.defensiveThreshold !== undefined) {
    merged.defensiveThreshold = Math.max(0, Math.min(1, partial.defensiveThreshold));
  }

  return merged;
}

/**
 * Get the baseline settings for an archetype string.
 * Falls back to 'opportunist' for unknown archetypes.
 */
export function getBaselineForArchetype(archetype: string): CompanionCombatSettings {
  const key = archetype as CompanionArchetype;
  const baseline = BASELINE_SETTINGS[key];
  return cloneSettings(baseline ?? BASELINE_SETTINGS.opportunist);
}
