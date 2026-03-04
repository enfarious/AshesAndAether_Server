import { logger } from '@/utils/logger';
import type { Companion } from '@prisma/client';
import type { ProximityRosterMessage } from '@/network/protocol/types';
import type { CombatAbilityDefinition } from '@/combat/types';
import { CompanionBehaviorTree, type BehaviorTickResult, type CombatContext } from './CompanionBehaviorTree';
import { CompanionCombatTrigger, type CombatSnapshot, type TriggerReason } from './CompanionCombatTrigger';
import { CompanionCombatMetrics, type FightMetrics } from './CompanionCombatMetrics';
import { type CompanionCombatSettings, getBaselineForArchetype, mergePartialSettings, cloneSettings } from './CompanionCombatSettings';
import { LLMService, type CombatSettingsContext } from './LLMService';

/** Minimal info needed for the engagement gate. */
export interface EngagementTarget {
  name: string;
  family?: string | null;
  species?: string | null;
  level?: number;
}

/**
 * Controls NPC/Companion AI behavior — social + combat.
 *
 * Social layer: responds to nearby conversations using LLM (existing behavior).
 * Combat layer: behavior tree (motor cortex) + LLM (prefrontal cortex).
 *
 * When not in combat, the social layer runs.
 * When in combat, the behavior tree ticks every frame and the LLM
 * adjusts settings on meaningful state changes.
 */
export class NPCAIController {
  private companion: Companion;
  private llmService: LLMService;

  // ── Social layer ─────────────────────────────────────────────────────────
  private lastSocialAction: number = 0;
  private socialCooldown: number = 5000; // 5 seconds between social actions

  // ── Combat layer ─────────────────────────────────────────────────────────
  private behaviorTree: CompanionBehaviorTree;
  private combatTrigger: CompanionCombatTrigger;
  private combatMetrics: CompanionCombatMetrics;
  private currentSettings: CompanionCombatSettings;

  private _inCombat = false;
  private fightStartedAt = 0;
  private pendingPlayerCommand: string | null = null;
  /** Global LLM throttle — no more than one call per 15s across all call types. */
  private lastLlmCallAt = 0;
  private static readonly LLM_GLOBAL_COOLDOWN_MS = 15_000;

  /** Abilities available to this companion (curated per archetype). */
  private abilities: CombatAbilityDefinition[] = [];

  // ── Engagement gate ────────────────────────────────────────────────────
  /** Cached engage/ignore decisions keyed by species (or family if no species). */
  private engagementCache = new Map<string, 'engage' | 'ignore'>();

  constructor(companion: Companion, llmService: LLMService) {
    this.companion = companion;
    this.llmService = llmService;

    // Initialize combat subsystems
    const archetype = companion.archetype ?? 'opportunist';
    this.currentSettings = getBaselineForArchetype(archetype);
    this.behaviorTree = new CompanionBehaviorTree();
    this.combatTrigger = new CompanionCombatTrigger();
    this.combatMetrics = new CompanionCombatMetrics(
      companion.id,
      companion.name,
      archetype,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Social update (out of combat)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Update NPC AI for social behavior (called when NOT in combat).
   */
  async updateSocial(
    proximityRoster: ProximityRosterMessage['payload'],
    nearbyPlayerMessages: { sender: string; channel: string; message: string }[] = []
  ): Promise<void> {
    const now = Date.now();
    if (now - this.lastSocialAction < this.socialCooldown) return;

    const shouldRespond = this.shouldRespondToSituation(proximityRoster, nearbyPlayerMessages);
    if (!shouldRespond) return;

    this.lastSocialAction = now;
    logger.debug({ companionId: this.companion.id, companionName: this.companion.name }, 'NPC social AI update triggered');
  }

  private shouldRespondToSituation(
    proximityRoster: ProximityRosterMessage['payload'],
    recentMessages: { sender: string; channel: string; message: string }[]
  ): boolean {
    if (recentMessages.length > 0) return true;
    if (proximityRoster.channels.say.count >= 2) return Math.random() < 0.1;
    return false;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Engagement gate (three-tier: ignore → always-engage → ask LLM)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Should this companion engage a nearby enemy?
   *
   * Resolution order (species overrides family):
   * 1. species in alwaysEngageSpecies → engage
   * 2. species in ignoreSpecies       → ignore
   * 3. family in alwaysEngageFamily   → engage
   * 4. family in ignoreFamily         → ignore
   * 5. cache hit                      → return cached answer
   * 6. Archetype fallback             → aggressive types engage, others ignore
   */
  async shouldEngage(enemy: EngagementTarget, _ownerNearby: boolean): Promise<boolean> {
    const { species, family } = enemy;
    const s = this.currentSettings;

    // Species-level overrides (highest priority)
    if (species) {
      if (s.alwaysEngageSpecies.includes(species)) return true;
      if (s.ignoreSpecies.includes(species)) return false;
    }

    // Family-level rules
    if (family) {
      if (s.alwaysEngageFamily.includes(family)) return true;
      if (s.ignoreFamily.includes(family)) return false;
    }

    // Cache check — keyed by species if available, else family, else mob name
    const cacheKey = species ?? family ?? enemy.name;
    const cached = this.engagementCache.get(cacheKey);
    if (cached) return cached === 'engage';

    // Default: all companions engage hostile mobs. The ignore lists above
    // handle specific exclusions. No LLM call needed.
    this.engagementCache.set(cacheKey, 'engage');
    logger.debug({
      companionId: this.companion.id,
      mob: enemy.name,
      cacheKey,
    }, '[CompanionAI] Engagement decision (default engage)');
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Combat update (in combat)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Tick the combat behavior tree. Called every game tick when in combat.
   * Returns the behavior tree result for the caller to apply (movement + ability actions).
   */
  async updateCombat(
    context: CombatContext,
    deltaTime: number,
  ): Promise<BehaviorTickResult> {
    const now = Date.now();

    // ── Check triggers for LLM settings update ─────────────────────────────
    const snapshot = this.buildCombatSnapshot(context);
    const triggerReason = this.combatTrigger.evaluate(snapshot, now);

    if (triggerReason) {
      // Fire-and-forget LLM call (don't block the tick)
      void this.requestSettingsUpdate(context, triggerReason);
    }

    // ── Tick the behavior tree ─────────────────────────────────────────────
    const result = this.behaviorTree.tick(this.currentSettings, context, deltaTime);

    // ── Record metrics ─────────────────────────────────────────────────────
    if (result.abilityAction) {
      this.combatMetrics.recordAbilityUsed();
    }

    // Clear any pending player command after this tick
    this.pendingPlayerCommand = null;

    return result;
  }

  // ── Combat lifecycle ─────────────────────────────────────────────────────

  enterCombat(): void {
    if (this._inCombat) return;

    this._inCombat = true;
    this.fightStartedAt = Date.now();
    this.combatTrigger.startFight();
    this.combatMetrics.startFight();

    logger.info({
      companionId: this.companion.id,
      companionName: this.companion.name,
      settings: this.currentSettings,
    }, '[CompanionAI] Entering combat');
  }

  exitCombat(): FightMetrics | null {
    if (!this._inCombat) return null;

    this._inCombat = false;
    this.behaviorTree.reset();
    const metrics = this.combatMetrics.endFight();

    // Reset settings to baseline (personality reasserts after combat)
    const archetype = this.companion.archetype ?? 'opportunist';
    this.currentSettings = getBaselineForArchetype(archetype);

    // Clear engagement cache — re-evaluate next time
    this.engagementCache.clear();

    logger.info({
      companionId: this.companion.id,
      companionName: this.companion.name,
    }, '[CompanionAI] Exiting combat');

    return metrics;
  }

  // ── Player commands ──────────────────────────────────────────────────────

  /**
   * Handle a direct player command like "focus healer", "retreat", "go aggressive".
   * These override current settings immediately AND trigger an LLM call.
   */
  handlePlayerCommand(command: string): void {
    this.pendingPlayerCommand = command;

    // Apply immediate overrides for common commands
    const lower = command.toLowerCase();
    if (lower.includes('retreat') || lower.includes('fall back') || lower.includes('run')) {
      this.currentSettings = mergePartialSettings(this.currentSettings, { retreatThreshold: 1.0 });
    } else if (lower.includes('aggressive') || lower.includes('attack') || lower.includes('all in')) {
      this.currentSettings = mergePartialSettings(this.currentSettings, {
        stance: 'aggressive',
        retreatThreshold: 0.05,
      });
    } else if (lower.includes('heal') || lower.includes('support')) {
      this.currentSettings = mergePartialSettings(this.currentSettings, {
        stance: 'support',
        abilityWeights: { heal: 0.9, damage: 0.1, cc: 0.2 },
      });
    } else if (lower.includes('focus') || lower.includes('target')) {
      this.currentSettings = mergePartialSettings(this.currentSettings, {
        priority: 'weakest',
      });
    }

    logger.info({
      companionId: this.companion.id,
      command,
      newSettings: this.currentSettings,
    }, '[CompanionAI] Player command processed');
  }

  // ── LLM settings request ────────────────────────────────────────────────

  private async requestSettingsUpdate(
    context: CombatContext,
    triggerReason: TriggerReason,
  ): Promise<void> {
    // Global LLM throttle — player_command bypasses, everything else respects cooldown
    const now = Date.now();
    if (triggerReason !== 'player_command' && now - this.lastLlmCallAt < NPCAIController.LLM_GLOBAL_COOLDOWN_MS) {
      return;
    }
    this.lastLlmCallAt = now;

    this.combatMetrics.recordLlmCall();

    const combatCtx: CombatSettingsContext = {
      companionName: this.companion.name,
      archetype: this.companion.archetype ?? 'opportunist',
      personalityType: this.companion.personalityType,
      companionHealthRatio: context.self.maxHealth > 0
        ? context.self.currentHealth / context.self.maxHealth
        : 1,
      currentSettings: cloneSettings(this.currentSettings),
      enemies: context.enemies.map(e => `${e.name}${e.level ? ` (level ${e.level})` : ''}`),
      allyStates: [
        ...(context.owner ? [`${context.owner.name}: ${Math.round(((context.owner.currentHealth ?? 1) / (context.owner.maxHealth ?? 1)) * 100)}%`] : []),
        ...context.allies.map(a => `${a.name}: ${Math.round(((a.currentHealth ?? 1) / (a.maxHealth ?? 1)) * 100)}%`),
      ],
      fightDurationSec: (Date.now() - this.fightStartedAt) / 1000,
      triggerReason,
      playerCommand: this.pendingPlayerCommand ?? undefined,
    };

    const partial = await this.llmService.generateCombatSettingsUpdate(this.companion, combatCtx);

    if (partial) {
      this.currentSettings = mergePartialSettings(this.currentSettings, partial);
      this.combatMetrics.recordSettingsChange();

      logger.info({
        companionId: this.companion.id,
        triggerReason,
        settingsUpdate: partial,
        newSettings: this.currentSettings,
      }, '[CompanionAI] LLM settings update applied');
    }
  }

  // ── Combat snapshot for trigger evaluation ───────────────────────────────

  private buildCombatSnapshot(context: CombatContext): CombatSnapshot {
    const allyHealthRatios = new Map<string, number>();
    if (context.owner) {
      allyHealthRatios.set(
        context.owner.id,
        (context.owner.currentHealth ?? 1) / (context.owner.maxHealth ?? 1),
      );
    }
    for (const ally of context.allies) {
      allyHealthRatios.set(
        ally.id,
        (ally.currentHealth ?? 1) / (ally.maxHealth ?? 1),
      );
    }

    return {
      allyHealthRatios,
      companionHealthRatio: context.self.maxHealth > 0
        ? context.self.currentHealth / context.self.maxHealth
        : 1,
      playerCommand: this.pendingPlayerCommand,
      combatJustStarted: false, // Set by caller when entering combat
      statusEffectsChanged: false, // Placeholder — wired when status system exists
    };
  }

  // ── Metrics forwarding (called by DWM when combat events occur) ──────────

  recordDamageDealt(amount: number, targetId: string): void {
    this.combatMetrics.recordDamageDealt(amount, targetId);
  }

  recordDamageAbsorbed(amount: number): void {
    this.combatMetrics.recordDamageAbsorbed(amount);
  }

  recordHeal(amount: number): void {
    this.combatMetrics.recordHeal(amount);
  }

  recordDeath(): void {
    this.combatMetrics.recordDeath();
  }

  recordKillContribution(): void {
    this.combatMetrics.recordKillContribution();
  }

  // ── Accessors ────────────────────────────────────────────────────────────

  get inCombat(): boolean {
    return this._inCombat;
  }

  getCompanionId(): string {
    return this.companion.id;
  }

  getCompanion(): Companion {
    return this.companion;
  }

  /** Patch the in-memory companion with updated fields (e.g. after a DB write). */
  patchCompanion(fields: Partial<Companion>): void {
    Object.assign(this.companion, fields);
  }

  /** Reset settings to a new archetype baseline. Called when player manually changes archetype. */
  resetToArchetype(archetype: string): void {
    this.currentSettings = getBaselineForArchetype(archetype);
    this.engagementCache.clear();
  }

  /** Apply manual settings override from the player's UI panel. */
  applyManualSettings(settings: CompanionCombatSettings): void {
    this.currentSettings = cloneSettings(settings);
  }

  getCurrentSettings(): CompanionCombatSettings {
    return cloneSettings(this.currentSettings);
  }

  getAbilities(): CombatAbilityDefinition[] {
    return this.abilities;
  }

  setAbilities(abilities: CombatAbilityDefinition[]): void {
    this.abilities = abilities;
  }

  getBehaviorTreeState(): string {
    return this.behaviorTree.getState();
  }

  getCurrentTargetId(): string | null {
    return this.behaviorTree.getCurrentTargetId();
  }
}
