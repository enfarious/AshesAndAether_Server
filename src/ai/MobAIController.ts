/**
 * Mob AI Controller — per-mob-instance orchestrator.
 *
 * Holds a MobBehaviorTree + MobCombatProfile reference.
 * Pre-resolves ability IDs → CombatAbilityDefinitions at construction.
 * Each tick: evaluates HP ratio → finds active boss phase → passes to BT.
 * Reports phase transitions to caller (for client broadcast).
 *
 * Architecture parallel:
 *   Companion:  NPCAIController  (LLM + BT)
 *   Mob:        MobAIController   (profile + BT, no LLM)
 */

import { logger } from '@/utils/logger';
import type { CombatAbilityDefinition } from '@/combat/types';
import type { MobCombatProfile } from './MobCombatProfile';
import { resolveEffectiveSettings } from './MobCombatProfile';
import { MobBehaviorTree, type MobBehaviorTickResult, type MobCombatContext, type MobEffectiveSettings } from './MobBehaviorTree';

// ── Phase change event ──────────────────────────────────────────────────────

export interface PhaseChangeEvent {
  mobId: string;
  previousPhase: string | undefined;
  newPhase: string;
  hpPercent: number;
}

// ── Controller ──────────────────────────────────────────────────────────────

export class MobAIController {
  private readonly bt = new MobBehaviorTree();
  private readonly profile: MobCombatProfile;
  private readonly mobId: string;

  /** All abilities this mob could ever use (across all phases). */
  private readonly allAbilities: CombatAbilityDefinition[];

  /** Currently active phase name (for change detection). */
  private currentPhaseName: string | undefined;

  /** The effective movement mode from the last tick (base or phase override). */
  private effectiveMovementMode: string;

  constructor(
    mobId: string,
    profile: MobCombatProfile,
    /** Map of ability ID → definition (from AbilitySystem). */
    abilityLookup: Map<string, CombatAbilityDefinition>,
  ) {
    this.mobId = mobId;
    this.profile = profile;
    this.effectiveMovementMode = profile.movementMode;

    // Collect every ability ID from base + all phases
    const allIds = new Set<string>(profile.abilityIds);
    if (profile.phases) {
      for (const phase of profile.phases) {
        for (const id of phase.abilityIds) allIds.add(id);
      }
    }

    // Pre-resolve to CombatAbilityDefinitions
    this.allAbilities = [];
    for (const id of allIds) {
      const def = abilityLookup.get(id);
      if (def) {
        this.allAbilities.push(def);
      } else {
        logger.warn({ mobId, abilityId: id }, 'MobAIController: ability not found in lookup');
      }
    }
  }

  /**
   * Tick the mob AI.
   *
   * @returns The BT result + an optional phase change event.
   */
  tick(
    context: MobCombatContext,
    deltaTime: number,
  ): {
    result: MobBehaviorTickResult;
    phaseChange?: PhaseChangeEvent;
  } {
    // ── Resolve effective settings from profile + HP ratio ────────────────
    const hpRatio = context.self.maxHealth > 0
      ? context.self.currentHealth / context.self.maxHealth
      : 1;

    const effective = resolveEffectiveSettings(this.profile, hpRatio);

    // ── Detect phase change ──────────────────────────────────────────────
    let phaseChange: PhaseChangeEvent | undefined;
    if (effective.activePhaseName !== this.currentPhaseName) {
      if (effective.activePhaseName) {
        phaseChange = {
          mobId: this.mobId,
          previousPhase: this.currentPhaseName,
          newPhase: effective.activePhaseName,
          hpPercent: Math.round(hpRatio * 100),
        };
        logger.info(
          { mobId: this.mobId, from: this.currentPhaseName, to: effective.activePhaseName, hpPercent: Math.round(hpRatio * 100) },
          'Boss phase transition',
        );
      }
      this.currentPhaseName = effective.activePhaseName;
    }

    // ── Build effective settings for BT ──────────────────────────────────
    const settings: MobEffectiveSettings = {
      movementMode: effective.movementMode,
      preferredRange: effective.preferredRange,
      targetPriority: this.profile.targetPriority,
      abilityIds: effective.abilityIds,
      abilityWeights: effective.abilityWeights,
      globalCooldownSec: effective.globalCooldownSec,
    };

    // Track effective movement mode for DWM to query
    this.effectiveMovementMode = effective.movementMode;

    // ── Tick behavior tree ───────────────────────────────────────────────
    const result = this.bt.tick(settings, context, deltaTime);

    return { result, phaseChange };
  }

  /** Get all pre-resolved abilities (across all phases). */
  getAllAbilities(): CombatAbilityDefinition[] {
    return this.allAbilities;
  }

  /** Get the mob's combat profile. */
  getProfile(): MobCombatProfile {
    return this.profile;
  }

  /** Get current phase name (if boss). */
  getCurrentPhaseName(): string | undefined {
    return this.currentPhaseName;
  }

  /** Get the mob's effective movement mode (reflects active phase). */
  getMovementMode(): string {
    return this.effectiveMovementMode;
  }

  /** Reset state (e.g. when combat ends). */
  reset(): void {
    this.bt.reset();
    this.currentPhaseName = undefined;
  }
}
