/**
 * Companion Combat Trigger — decides when to query the LLM for a settings update.
 *
 * Between triggers, the companion runs on the last decision. This keeps token
 * usage bounded: a handful of LLM calls per dungeon fight, not per tick.
 * A typical fight might produce 3–6 setting updates.
 */

export interface CombatSnapshot {
  /** Enemy entity IDs currently engaged, mapped to their tag/type string. */
  enemyTypes: Map<string, string>;
  /** Ally entity IDs mapped to their HP ratio (0–1). */
  allyHealthRatios: Map<string, number>;
  /** This companion's HP ratio (0–1). */
  companionHealthRatio: number;
  /** Whether a player has issued a direct command this tick. */
  playerCommand: string | null;
  /** Whether combat just started this tick. */
  combatJustStarted: boolean;
  /** Whether combat just ended this tick. */
  combatJustEnded: boolean;
}

/** Describes why the trigger fired, for logging/debugging. */
export type TriggerReason =
  | 'combat_start'
  | 'combat_end'
  | 'new_enemy_type'
  | 'ally_health_critical'
  | 'companion_health_threshold'
  | 'player_command'
  | 'enemy_phase_shift';

const DEBOUNCE_MS = 3_000;        // Minimum 3s between LLM calls
const ALLY_CRITICAL_RATIO = 0.3;  // Trigger if any ally drops below 30%
const MAX_CALLS_PER_FIGHT = 12;   // Hard cap on LLM calls per fight

export class CompanionCombatTrigger {
  private lastTriggerAt = 0;
  private callsThisFight = 0;
  private knownEnemyTypes = new Set<string>();
  private previousAllyHealthAboveCritical = new Map<string, boolean>();
  private previousCompanionAboveThreshold = true;
  private retreatThreshold = 0.25;

  /**
   * Reset state for a new fight.
   */
  startFight(retreatThreshold: number): void {
    this.lastTriggerAt = 0;
    this.callsThisFight = 0;
    this.knownEnemyTypes.clear();
    this.previousAllyHealthAboveCritical.clear();
    this.previousCompanionAboveThreshold = true;
    this.retreatThreshold = retreatThreshold;
  }

  /**
   * Check whether the LLM should be queried right now.
   * Returns the trigger reason, or null if no trigger.
   */
  evaluate(snapshot: CombatSnapshot, now: number): TriggerReason | null {
    // Hard cap
    if (this.callsThisFight >= MAX_CALLS_PER_FIGHT) return null;

    // Combat start/end always trigger (bypass debounce)
    if (snapshot.combatJustStarted) {
      return this.fire('combat_start', now);
    }
    if (snapshot.combatJustEnded) {
      return this.fire('combat_end', now);
    }

    // Player command always triggers (bypass debounce)
    if (snapshot.playerCommand) {
      return this.fire('player_command', now);
    }

    // Debounce check for remaining triggers
    if (now - this.lastTriggerAt < DEBOUNCE_MS) return null;

    // New enemy type enters combat
    for (const [_id, enemyType] of snapshot.enemyTypes) {
      if (!this.knownEnemyTypes.has(enemyType)) {
        this.knownEnemyTypes.add(enemyType);
        return this.fire('new_enemy_type', now);
      }
    }

    // Ally health drops below critical threshold (edge trigger — only fires once per ally crossing)
    for (const [allyId, ratio] of snapshot.allyHealthRatios) {
      const wasAbove = this.previousAllyHealthAboveCritical.get(allyId) ?? true;
      const isAbove = ratio >= ALLY_CRITICAL_RATIO;
      this.previousAllyHealthAboveCritical.set(allyId, isAbove);

      if (wasAbove && !isAbove) {
        return this.fire('ally_health_critical', now);
      }
    }

    // Companion's own health crosses retreat threshold (edge trigger)
    const companionAboveThreshold = snapshot.companionHealthRatio >= this.retreatThreshold;
    if (this.previousCompanionAboveThreshold && !companionAboveThreshold) {
      this.previousCompanionAboveThreshold = companionAboveThreshold;
      return this.fire('companion_health_threshold', now);
    }
    this.previousCompanionAboveThreshold = companionAboveThreshold;

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
