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
/** Callback signature for BYOLLM trigger emission — DWM provides this for companions. */
export type OnTriggerCallback = (type: 'combat' | 'social', triggerReason: string, snapshot: unknown) => void;

export class NPCAIController {
  private companion: Companion;
  private llmService: LLMService | null;
  private onTrigger: OnTriggerCallback | null;

  // ── Social layer ─────────────────────────────────────────────────────────
  private lastSocialAction: number = 0;
  private socialCooldown: number = 5000; // 5 seconds between social actions
  /** Social idle trigger — configurable, default 5 min since last social trigger. */
  private lastSocialTriggerAt: number = 0;
  private static readonly SOCIAL_IDLE_MS = 5 * 60 * 1000;

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

  /** Set of entity IDs currently attacking the owner or this companion.
   *  Populated by DWM before calling shouldEngage() — used for 'defensive' mode. */
  private _attackerIds = new Set<string>();

  /** True while an LLM settings update call is in flight. */
  private _llmPending = false;

  /** Last ability the companion used — drives casting bar on the HUD. */
  private _lastAbilityUsed: { abilityId: string; abilityName: string; timestamp: number } | null = null;

  /** Weapon info for LLM context — set by DWM when equipping/registering. */
  private _weaponRangeBand: 'close' | 'mid' | 'long' = 'close';
  private _weaponName: string | null = null;

  /** Track last zone ID for zone_change social triggers. */
  private _lastZoneId: string | null = null;

  /**
   * @param companion  Companion DB record
   * @param llmService LLMService instance for NPC AI (null for BYOLLM companions)
   * @param onTrigger  Callback for BYOLLM trigger emission (null for server-side NPC AI)
   */
  constructor(companion: Companion, llmService: LLMService | null, onTrigger?: OnTriggerCallback | null) {
    this.companion = companion;
    this.llmService = llmService;
    this.onTrigger = onTrigger ?? null;

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

  /** Whether this controller uses BYOLLM (client-side LLM). */
  get isBYOLLM(): boolean {
    return this.onTrigger !== null;
  }

  /** Update weapon info so the LLM knows what range band to prefer. */
  setWeaponInfo(name: string | null, rangeBand: 'close' | 'mid' | 'long'): void {
    this._weaponName = name;
    this._weaponRangeBand = rangeBand;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Social update (out of combat)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Update NPC AI for social behavior (called when NOT in combat).
   *
   * BYOLLM companions: evaluates social trigger conditions and fires
   * the onTrigger callback when appropriate.
   * NPC instances: existing behavior (server-side LLM).
   */
  async updateSocial(
    proximityRoster: ProximityRosterMessage['payload'],
    nearbyPlayerMessages: { sender: string; channel: string; message: string }[] = [],
    zoneId?: string,
  ): Promise<void> {
    const now = Date.now();

    // ── BYOLLM companion path: evaluate social trigger conditions ──────
    if (this.onTrigger) {
      const triggerReason = this.evaluateSocialTrigger(proximityRoster, nearbyPlayerMessages, zoneId, now);
      if (triggerReason) {
        this.lastSocialTriggerAt = now;
        this.onTrigger('social', triggerReason, {
          proximityRoster,
          nearbyPlayerMessages,
        });
      }
      return;
    }

    // ── NPC path: existing server-side behavior ───────────────────────
    if (now - this.lastSocialAction < this.socialCooldown) return;

    const shouldRespond = this.shouldRespondToSituation(proximityRoster, nearbyPlayerMessages);
    if (!shouldRespond) return;

    this.lastSocialAction = now;
    logger.debug({ companionId: this.companion.id, companionName: this.companion.name }, 'NPC social AI update triggered');
  }

  /**
   * Evaluate social trigger conditions for BYOLLM companions.
   * Returns trigger reason or null if no trigger.
   */
  private evaluateSocialTrigger(
    proximityRoster: ProximityRosterMessage['payload'],
    nearbyPlayerMessages: { sender: string; channel: string; message: string }[],
    zoneId: string | undefined,
    now: number,
  ): 'player_spoke' | 'entity_nearby' | 'zone_change' | 'idle' | null {
    // Player spoke in say or companion channel
    if (nearbyPlayerMessages.length > 0) {
      return 'player_spoke';
    }

    // Zone changed (companion crossed a zone boundary)
    if (zoneId && this._lastZoneId !== null && this._lastZoneId !== zoneId) {
      this._lastZoneId = zoneId;
      return 'zone_change';
    }
    if (zoneId) this._lastZoneId = zoneId;

    // Entity entered say range (proximity roster delta — checking say count)
    // This fires when a new entity is near enough to talk; we approximate by
    // checking if say count went up recently (DWM will pass changed rosters).
    if (proximityRoster.channels.say.count >= 2) {
      // Don't fire entity_nearby more than once per social cooldown
      if (now - this.lastSocialTriggerAt >= this.socialCooldown) {
        return 'entity_nearby';
      }
    }

    // Idle timer: fire if no social trigger for SOCIAL_IDLE_MS
    if (this.lastSocialTriggerAt > 0 && now - this.lastSocialTriggerAt >= NPCAIController.SOCIAL_IDLE_MS) {
      return 'idle';
    }
    // First idle trigger after zone entry
    if (this.lastSocialTriggerAt === 0 && now - this.lastSocialAction >= NPCAIController.SOCIAL_IDLE_MS) {
      return 'idle';
    }

    return null;
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
  // Engagement gate (3-state: aggressive / defensive / passive)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Should this companion/NPC engage a nearby enemy?
   *
   * Resolution order:
   * 1. Ignore-list overrides (always respected — species trumps family)
   * 2. Always-engage overrides (always respected — species trumps family)
   * 3. Engagement mode:
   *    - aggressive → engage
   *    - defensive  → only if mob is attacking owner or self (checked via _attackerIds)
   *    - passive    → never auto-engage
   */
  shouldEngage(enemy: EngagementTarget & { id?: string }): boolean {
    const { species, family } = enemy;
    const s = this.currentSettings;

    // 1. Ignore-list overrides (always respected)
    if (species && s.ignoreSpecies.includes(species)) return false;
    if (family && s.ignoreFamily.includes(family)) return false;

    // 2. Always-engage overrides (always respected)
    if (species && s.alwaysEngageSpecies.includes(species)) return true;
    if (family && s.alwaysEngageFamily.includes(family)) return true;

    // 3. Engagement mode
    switch (s.engagementMode) {
      case 'aggressive':
        return true;
      case 'defensive':
        // Only engage if the mob is attacking the owner or companion
        return enemy.id ? this._attackerIds.has(enemy.id) : false;
      case 'passive':
        return false;
      default:
        return false;
    }
  }

  /** Update the set of entity IDs attacking owner + self. Called by DWM before shouldEngage(). */
  setAttackerIds(ids: Set<string>): void {
    this._attackerIds = ids;
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
      if (this.onTrigger) {
        // BYOLLM path: emit trigger to client, client handles LLM call
        this.onTrigger('combat', triggerReason, this.buildCombatSnapshot(context));
      } else {
        // NPC path: fire-and-forget server-side LLM call (don't block the tick)
        void this.requestSettingsUpdate(context, triggerReason);
      }
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
    // BYOLLM companions never use server-side LLM
    if (!this.llmService) return;

    // Global LLM throttle — player_command bypasses, everything else respects cooldown
    const now = Date.now();
    if (triggerReason !== 'player_command' && now - this.lastLlmCallAt < NPCAIController.LLM_GLOBAL_COOLDOWN_MS) {
      return;
    }
    this.lastLlmCallAt = now;

    this.combatMetrics.recordLlmCall();
    this._llmPending = true;

    try {
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
        weaponRangeBand: this._weaponRangeBand,
        weaponName: this._weaponName ?? undefined,
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
    } finally {
      this._llmPending = false;
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

  get fightStartTime(): number {
    return this.fightStartedAt;
  }

  get llmPending(): boolean {
    return this._llmPending;
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

  recordAbilityUse(abilityId: string, abilityName: string): void {
    this._lastAbilityUsed = { abilityId, abilityName, timestamp: Date.now() };
  }

  get lastAbilityUsed() {
    return this._lastAbilityUsed;
  }
}
