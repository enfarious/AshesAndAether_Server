/**
 * Mob Combat Profiles — static behavior descriptors keyed by mob tag.
 *
 * Each profile defines how a mob type moves, targets, and selects abilities.
 * Boss mobs have HP-threshold phases that unlock abilities and shift weights
 * without ever scripting a fixed rotation.
 *
 * Architecture parallel:
 *   Companion:  CompanionCombatSettings  (LLM-adjustable)
 *   Mob:        MobCombatProfile         (static per mob tag)
 */

import type { PreferredRange, TargetPriority } from './CompanionCombatSettings';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MovementMode = 'chase' | 'stationary' | 'kite';

/** Weight categories for stochastic ability selection. */
export interface AbilityWeights {
  damage: number;
  cc: number;
  heal: number;
  buff: number;
  debuff: number;
}

/** HP-threshold boss phase — active when hpFloor < hp% <= hpCeiling. */
export interface BossPhase {
  name: string;
  /** Phase is active when current HP% is at or below this ceiling. */
  hpCeiling: number;
  /** Phase is active when current HP% is strictly above this floor (0 for final phase). */
  hpFloor: number;
  /** Abilities available during this phase. */
  abilityIds: string[];
  preferredRange: PreferredRange;
  movementMode?: MovementMode;
  abilityWeights: AbilityWeights;
  globalCooldownSec?: number;
}

export interface MobCombatProfile {
  mobTag: string;
  movementMode: MovementMode;
  preferredRange: PreferredRange;
  targetPriority: TargetPriority;
  /** Base ability IDs (phase 1 / non-boss). */
  abilityIds: string[];
  abilityWeights: AbilityWeights;
  /** Minimum seconds between any two ability uses (global cooldown). */
  globalCooldownSec: number;
  /** Multiplier on all threat this mob generates. Default 1.0. */
  threatMultiplier?: number;
  /** Boss phases — evaluated top-down by HP%. First matching phase wins. */
  phases?: BossPhase[];
}

// ─── Weight presets ───────────────────────────────────────────────────────────

const DAMAGE_HEAVY:  AbilityWeights = { damage: 0.7, cc: 0.1, heal: 0.0, buff: 0.0, debuff: 0.2 };
const CC_HEAVY:      AbilityWeights = { damage: 0.3, cc: 0.5, heal: 0.0, buff: 0.0, debuff: 0.2 };
const HEAL_HEAVY:    AbilityWeights = { damage: 0.1, cc: 0.0, heal: 0.6, buff: 0.0, debuff: 0.3 };
const AGGRESSIVE:    AbilityWeights = { damage: 0.8, cc: 0.1, heal: 0.0, buff: 0.0, debuff: 0.1 };
const BALANCED:      AbilityWeights = { damage: 0.4, cc: 0.2, heal: 0.0, buff: 0.0, debuff: 0.4 };

// ─── Profile Registry ─────────────────────────────────────────────────────────

const PROFILES: MobCombatProfile[] = [
  // ── Drone — melee swarm, charges in, hits hard ──
  {
    mobTag: 'drone',
    movementMode: 'chase',
    preferredRange: 'close',
    targetPriority: 'nearest',
    abilityIds: ['mob_lunge', 'mob_overcharge_strike'],
    abilityWeights: DAMAGE_HEAVY,
    globalCooldownSec: 4,
  },

  // ── Turret — stationary ranged, never moves ──
  {
    mobTag: 'turret',
    movementMode: 'stationary',
    preferredRange: 'long',
    targetPriority: 'nearest',
    abilityIds: ['mob_energy_bolt', 'mob_suppression_burst'],
    abilityWeights: DAMAGE_HEAVY,
    globalCooldownSec: 3.5,
  },

  // ── Sentinel — tanky melee, disrupts threatening players ──
  {
    mobTag: 'sentinel',
    movementMode: 'chase',
    preferredRange: 'close',
    targetPriority: 'threatening_player',
    abilityIds: ['mob_shield_slam', 'mob_magnetic_pull'],
    abilityWeights: CC_HEAVY,
    globalCooldownSec: 5,
    threatMultiplier: 1.5,
  },

  // ── Overseer (sub-boss) — kiting healer, panics at low HP ──
  {
    mobTag: 'overseer',
    movementMode: 'kite',
    preferredRange: 'mid',
    targetPriority: 'weakest',
    abilityIds: ['mob_repair_pulse', 'mob_disruption_field'],
    abilityWeights: HEAL_HEAVY,
    globalCooldownSec: 4.5,
    phases: [
      {
        // Phase 1: Command — stays at range, heals allies, debuffs players
        name: 'Command',
        hpCeiling: 100,
        hpFloor: 50,
        abilityIds: ['mob_repair_pulse', 'mob_disruption_field'],
        preferredRange: 'mid',
        movementMode: 'kite',
        abilityWeights: HEAL_HEAVY,
      },
      {
        // Phase 2: Desperation — switches to close range, unlocks Overload
        name: 'Desperation',
        hpCeiling: 50,
        hpFloor: 0,
        abilityIds: ['mob_repair_pulse', 'mob_disruption_field', 'mob_overload'],
        preferredRange: 'close',
        movementMode: 'chase',
        abilityWeights: AGGRESSIVE,
        globalCooldownSec: 3.5,
      },
    ],
  },

  // ── Overlord (boss) — 3-phase melee bruiser ──
  {
    mobTag: 'overlord',
    movementMode: 'chase',
    preferredRange: 'close',
    targetPriority: 'threatening_player',
    abilityIds: ['mob_nanoswarm', 'mob_seismic_pound'],
    abilityWeights: DAMAGE_HEAVY,
    globalCooldownSec: 5,
    threatMultiplier: 2.0,
    phases: [
      {
        // Phase 1: Dominant — relentless melee pressure
        name: 'Dominant',
        hpCeiling: 100,
        hpFloor: 60,
        abilityIds: ['mob_nanoswarm', 'mob_seismic_pound'],
        preferredRange: 'close',
        movementMode: 'chase',
        abilityWeights: DAMAGE_HEAVY,
      },
      {
        // Phase 2: Adaptive — backs off, uses cone attack
        name: 'Adaptive',
        hpCeiling: 60,
        hpFloor: 30,
        abilityIds: ['mob_nanoswarm', 'mob_seismic_pound', 'mob_corruption_wave'],
        preferredRange: 'mid',
        movementMode: 'kite',
        abilityWeights: BALANCED,
        globalCooldownSec: 4,
      },
      {
        // Phase 3: Meltdown — all-in aggression, can self-heal
        name: 'Meltdown',
        hpCeiling: 30,
        hpFloor: 0,
        abilityIds: ['mob_nanoswarm', 'mob_seismic_pound', 'mob_corruption_wave', 'mob_final_protocol'],
        preferredRange: 'close',
        movementMode: 'chase',
        abilityWeights: { damage: 0.6, cc: 0.05, heal: 0.25, buff: 0.0, debuff: 0.1 },
        globalCooldownSec: 3,
      },
    ],
  },
];

// ─── Lookup ───────────────────────────────────────────────────────────────────

const PROFILE_MAP = new Map<string, MobCombatProfile>(
  PROFILES.map(p => [p.mobTag, p]),
);

/**
 * Look up a mob's combat profile by its mob tag.
 *
 * Mob tags in VaultTemplates use the pattern `vault.construct.<type>`.
 * This function accepts both the full tag and the suffix after the last dot
 * (e.g. both `vault.construct.drone` and `drone` will match).
 */
export function getMobCombatProfile(mobTag: string): MobCombatProfile | undefined {
  // Try exact match first
  const direct = PROFILE_MAP.get(mobTag);
  if (direct) return direct;

  // Try suffix after last dot (e.g. 'vault.construct.drone' → 'drone')
  const dotIdx = mobTag.lastIndexOf('.');
  if (dotIdx >= 0) {
    return PROFILE_MAP.get(mobTag.substring(dotIdx + 1));
  }

  return undefined;
}

/**
 * Resolve the effective settings for a mob given its current HP ratio.
 * Returns the active boss phase if one matches, otherwise returns
 * the profile's base settings.
 */
export function resolveEffectiveSettings(
  profile: MobCombatProfile,
  hpRatio: number, // 0..1
): {
  movementMode: MovementMode;
  preferredRange: PreferredRange;
  abilityIds: string[];
  abilityWeights: AbilityWeights;
  globalCooldownSec: number;
  activePhaseName?: string;
} {
  const hpPercent = hpRatio * 100;

  if (profile.phases) {
    for (const phase of profile.phases) {
      if (hpPercent <= phase.hpCeiling && hpPercent > phase.hpFloor) {
        return {
          movementMode: phase.movementMode ?? profile.movementMode,
          preferredRange: phase.preferredRange,
          abilityIds: phase.abilityIds,
          abilityWeights: phase.abilityWeights,
          globalCooldownSec: phase.globalCooldownSec ?? profile.globalCooldownSec,
          activePhaseName: phase.name,
        };
      }
    }
  }

  // No phase matched — use profile defaults
  return {
    movementMode: profile.movementMode,
    preferredRange: profile.preferredRange,
    abilityIds: profile.abilityIds,
    abilityWeights: profile.abilityWeights,
    globalCooldownSec: profile.globalCooldownSec,
  };
}
