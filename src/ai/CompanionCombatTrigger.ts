/**
 * Companion Combat Trigger — decides when to query the LLM for a settings update.
 *
 * Between triggers, the companion runs on the last decision. This keeps token
 * usage bounded: a handful of LLM calls per dungeon fight, not per tick.
 *
 * Triggers:
 * - combat_start                — first tick in combat (bypasses debounce)
 * - player_command              — player issues a directive (bypasses debounce)
 * - companion_health_threshold  — companion HP crosses 75/50/25% bands
 * - ally_health_threshold       — any ally HP crosses 50/25% bands
 * - status_effect_change        — buff/debuff applied or expired (placeholder)
 *
 * Removed (noisy/pointless):
 * - combat_end      — just reset to baseline, no LLM needed
 * - new_enemy_type  — handled by engagement gate before combat entry
 */

export interface CombatSnapshot {
  /** Ally entity IDs mapped to their HP ratio (0–1). */
  allyHealthRatios: Map<string, number>;
  /** This companion's HP ratio (0–1). */
  companionHealthRatio: number;
  /** Whether a player has issued a direct command this tick. */
  playerCommand: string | null;
  /** Whether combat just started this tick. */
  combatJustStarted: boolean;
  /** Whether a status effect changed this tick (placeholder — always false for now). */
  statusEffectsChanged: boolean;
}

/** Describes why the trigger fired, for logging/debugging. */
export type TriggerReason =
  | 'combat_start'
  | 'ally_health_threshold'
  | 'companion_health_threshold'
  | 'player_command'
  | 'status_effect_change';

const DEBOUNCE_MS = 10_000;       // Minimum 10s between LLM calls
const MAX_CALLS_PER_FIGHT = 6;    // Hard cap on LLM calls per fight

// HP bands that trigger a settings update when crossed downward
const COMPANION_HP_BANDS = [0.75, 0.50, 0.25];
const ALLY_HP_BANDS = [0.50, 0.25];

export class CompanionCombatTrigger {
  private lastTriggerAt = 0;
  private callsThisFight = 0;

  /** Companion HP bands already crossed (e.g. 75, 50). */
  private companionBandsCrossed = new Set<number>();
  /** Per-ally HP bands already crossed. Map<allyId, Set<band>>. */
  private allyBandsCrossed = new Map<string, Set<number>>();

  /**
   * Reset state for a new fight.
   */
  startFight(): void {
    this.lastTriggerAt = 0;
    this.callsThisFight = 0;
    this.companionBandsCrossed.clear();
    this.allyBandsCrossed.clear();
  }

  /**
   * Check whether the LLM should be queried right now.
   * Returns the trigger reason, or null if no trigger.
   */
  evaluate(snapshot: CombatSnapshot, now: number): TriggerReason | null {
    // Hard cap
    if (this.callsThisFight >= MAX_CALLS_PER_FIGHT) return null;

    // Combat start always triggers (bypass debounce)
    if (snapshot.combatJustStarted) {
      return this.fire('combat_start', now);
    }

    // Player command always triggers (bypass debounce)
    if (snapshot.playerCommand) {
      return this.fire('player_command', now);
    }

    // Debounce check for remaining triggers
    if (now - this.lastTriggerAt < DEBOUNCE_MS) return null;

    // Companion HP band crossings (edge-triggered — each band fires once)
    for (const band of COMPANION_HP_BANDS) {
      if (!this.companionBandsCrossed.has(band) && snapshot.companionHealthRatio < band) {
        this.companionBandsCrossed.add(band);
        return this.fire('companion_health_threshold', now);
      }
    }

    // Ally HP band crossings (edge-triggered per ally)
    for (const [allyId, ratio] of snapshot.allyHealthRatios) {
      let allyBands = this.allyBandsCrossed.get(allyId);
      if (!allyBands) {
        allyBands = new Set<number>();
        this.allyBandsCrossed.set(allyId, allyBands);
      }

      for (const band of ALLY_HP_BANDS) {
        if (!allyBands.has(band) && ratio < band) {
          allyBands.add(band);
          return this.fire('ally_health_threshold', now);
        }
      }
    }

    // Status effect changes (placeholder — wired when status system exists)
    if (snapshot.statusEffectsChanged) {
      return this.fire('status_effect_change', now);
    }

    return null;
  }

  private fire(reason: TriggerReason, now: number): TriggerReason {
    this.lastTriggerAt = now;
    this.callsThisFight++;
    return reason;
  }

  /** How many LLM calls have been made this fight. */
  get callCount(): number {
    return this.callsThisFight;
  }
}
