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
  melee: { min: 0, ideal: 2, max: 3 },
  close: { min: 3, ideal: 5, max: 8 },
  mid:   { min: 8, ideal: 15, max: 20 },
  far:   { min: 20, ideal: 30, max: 40 },
};

// ── Target priority ─────────────────────────────────────────────────────────

export type TargetPriority = 'weakest' | 'nearest' | 'threatening_player';

// ── Stance ──────────────────────────────────────────────────────────────────

export type CombatStance = 'aggressive' | 'cautious' | 'support';

// ── The settings object ─────────────────────────────────────────────────────

export interface CompanionCombatSettings {
  preferredRange: PreferredRange;
  priority: TargetPriority;
  stance: CombatStance;
  /** Ability category weights (0–1). Keys are ability categories: 'heal', 'damage', 'cc', etc. */
  abilityWeights: Record<string, number>;
  /** Pull back if HP ratio drops below this (0–1). e.g. 0.25 = retreat at 25% HP. */
  retreatThreshold: number;
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
  },
  cautious_healer: {
    preferredRange: 'mid',
    priority: 'threatening_player',
    stance: 'support',
    abilityWeights: { heal: 0.8, damage: 0.2, cc: 0.4 },
    retreatThreshold: 0.5,
  },
  opportunist: {
    preferredRange: 'mid',
    priority: 'weakest',
    stance: 'cautious',
    abilityWeights: { damage: 0.5, cc: 0.4, heal: 0.3 },
    retreatThreshold: 0.25,
  },
  tank: {
    preferredRange: 'melee',
    priority: 'threatening_player',
    stance: 'aggressive',
    abilityWeights: { cc: 0.7, damage: 0.5, heal: 0.2 },
    retreatThreshold: 0.15,
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

export function cloneSettings(settings: CompanionCombatSettings): CompanionCombatSettings {
  return {
    ...settings,
    abilityWeights: { ...settings.abilityWeights },
  };
}

/**
 * Merge a partial settings update onto existing settings.
 * Only fields present in `partial` overwrite. Missing fields keep previous value.
 */
export function mergePartialSettings(
  current: CompanionCombatSettings,
  partial: Partial<CompanionCombatSettings>,
): CompanionCombatSettings {
  const merged = cloneSettings(current);

  if (partial.preferredRange !== undefined) merged.preferredRange = partial.preferredRange;
  if (partial.priority !== undefined) merged.priority = partial.priority;
  if (partial.stance !== undefined) merged.stance = partial.stance;
  if (partial.retreatThreshold !== undefined) {
    merged.retreatThreshold = Math.max(0, Math.min(1, partial.retreatThreshold));
  }
  if (partial.abilityWeights !== undefined) {
    // Merge weight keys — new keys added, existing keys overwritten, missing keys kept
    for (const [key, value] of Object.entries(partial.abilityWeights)) {
      merged.abilityWeights[key] = Math.max(0, Math.min(1, value));
    }
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
