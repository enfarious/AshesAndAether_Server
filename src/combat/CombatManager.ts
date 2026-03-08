import { CombatantState, CombatAbilityDefinition, ATB_DEFAULT_MAX, ATB_ABSOLUTE_MAX, SPECIAL_CHARGE_MAX, QueuedCombatAction, ActiveBuff, CombatStats, CombatUpdateResult } from './types';
import { EnmityTable, EnmityConfig } from './EnmityTable';

const DEFAULT_ATB_BASE_RATE = 10; // gauge per second
const DEFAULT_COMBAT_TIMEOUT_MS = 15000;
const DEFAULT_WEAPON_SPEED = 3.0; // seconds between auto-attacks (default unarmed)

export class CombatManager {
  private combatants: Map<string, CombatantState> = new Map();
  private queuedActions: QueuedCombatAction[] = [];
  private readonly baseRate: number;
  private readonly timeoutMs: number;
  private readonly enmityTable: EnmityTable;

  constructor(options?: { baseRate?: number; timeoutMs?: number; enmityConfig?: Partial<EnmityConfig> }) {
    this.baseRate = options?.baseRate ?? DEFAULT_ATB_BASE_RATE;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_COMBAT_TIMEOUT_MS;
    this.enmityTable = new EnmityTable(options?.enmityConfig);
  }

  ensureCombatant(entityId: string, now: number): CombatantState {
    let state = this.combatants.get(entityId);
    if (!state) {
      state = {
        entityId,
        atbGauge: 0,
        atbMax: ATB_DEFAULT_MAX, // Default 200 (2 charges), can be increased to 500 via gear
        lastHostileAt: now,
        inCombat: false,
        cooldowns: new Map(),
        autoAttackTimer: 0,
        weaponSpeed: DEFAULT_WEAPON_SPEED,
        specialCharges: new Map(),
        activeBuffs: [],
        threatMultiplier: 1.0,
        threatShedRate: 1.0,
        healPotencyMult: 1.0,
      };
      this.combatants.set(entityId, state);
    }
    return state;
  }

  startCombat(entityId: string, now: number): boolean {
    const state = this.ensureCombatant(entityId, now);
    const wasInCombat = state.inCombat;
    state.inCombat = true;
    state.lastHostileAt = now;
    return !wasInCombat;
  }

  recordHostileAction(entityId: string, now: number): void {
    const state = this.ensureCombatant(entityId, now);
    state.lastHostileAt = now;
  }

  update(deltaTime: number, getAttackSpeedBonus: (entityId: string) => number): CombatUpdateResult {
    const now = Date.now();
    const expiredCombatants: string[] = [];
    const expiredBuffs: Array<{ entityId: string; buff: ActiveBuff }> = [];
    const buffTicks: Array<{ entityId: string; buff: ActiveBuff }> = [];

    for (const state of this.combatants.values()) {
      // Update auto-attack timer (separate from ATB)
      if (state.autoAttackTarget) {
        state.autoAttackTimer += deltaTime;
      }

      if (state.inCombat) {
        // Update ATB gauge (for abilities/spells/items)
        // Caps at entity's atbMax (default 200, can be up to 500 with gear)
        const bonus = getAttackSpeedBonus(state.entityId);
        const rate = this.baseRate + bonus;
        state.atbGauge = Math.min(state.atbMax, state.atbGauge + rate * deltaTime);

        // Check combat timeout
        if (now - state.lastHostileAt >= this.timeoutMs) {
          state.inCombat = false;
          state.autoAttackTimer = 0;
          expiredCombatants.push(state.entityId);
        }
      }

      // Process DoT/HoT ticks on active buffs
      for (const buff of state.activeBuffs) {
        if (buff.expiresAt <= now) continue;
        if (!buff.tickDamage && !buff.tickHeal) continue;
        const interval = buff.tickIntervalMs ?? 1000;
        if (buff.lastTickAt && now - buff.lastTickAt >= interval) {
          buff.lastTickAt = now;
          buffTicks.push({ entityId: state.entityId, buff });
        }
      }

      // Expire buffs — collect expired ones before filtering
      if (state.activeBuffs.length > 0) {
        const stillActive: ActiveBuff[] = [];
        for (const b of state.activeBuffs) {
          if (b.expiresAt > now) {
            stillActive.push(b);
          } else {
            expiredBuffs.push({ entityId: state.entityId, buff: b });
          }
        }
        state.activeBuffs = stillActive;
      }

      // Expire taunt
      if (state.tauntedBy && state.tauntExpiresAt && now >= state.tauntExpiresAt) {
        state.tauntedBy = undefined;
        state.tauntExpiresAt = undefined;
      }

      // Enforce taunt: override auto-attack target
      if (state.tauntedBy && state.autoAttackTarget !== state.tauntedBy) {
        state.autoAttackTarget = state.tauntedBy;
      }

      // Expire root
      if (state.rooted && state.rootExpiresAt && now >= state.rootExpiresAt) {
        state.rooted = false;
        state.rootExpiresAt = undefined;
        state.rootBreakThreshold = undefined;
      }
    }

    // ── Enmity: decay all threat tables ──
    this.enmityTable.decayAll(deltaTime, (entityId) => {
      const s = this.combatants.get(entityId);
      return s?.threatShedRate ?? 1.0;
    });

    // ── Enmity: evaluate target switches for mobs with threat tables ──
    const targetSwitches: Array<{ mobId: string; newTargetId: string; previousTargetId?: string }> = [];
    for (const mobId of this.enmityTable.getAllMobIds()) {
      const mobState = this.combatants.get(mobId);
      if (!mobState?.inCombat) continue;
      // Taunt overrides threat-based targeting
      if (mobState.tauntedBy) continue;

      const currentTarget = mobState.autoAttackTarget;
      const newTarget = this.enmityTable.evaluateTarget(mobId, currentTarget);
      if (newTarget && newTarget !== currentTarget) {
        mobState.autoAttackTarget = newTarget;
        targetSwitches.push({ mobId, newTargetId: newTarget, previousTargetId: currentTarget });
      }
    }

    return { expiredCombatants, expiredBuffs, buffTicks, targetSwitches };
  }

  canSpendAtb(entityId: string, cost: number): boolean {
    if (cost <= 0) return true;
    const state = this.ensureCombatant(entityId, Date.now());
    return state.atbGauge >= cost;
  }

  spendAtb(entityId: string, cost: number): void {
    if (cost <= 0) return;
    const state = this.ensureCombatant(entityId, Date.now());
    state.atbGauge = Math.max(0, state.atbGauge - cost);
  }

  addAtb(entityId: string, amount: number): void {
    const state = this.ensureCombatant(entityId, Date.now());
    state.atbGauge = Math.min(state.atbMax, state.atbGauge + amount);
  }

  /**
   * Set ATB max for an entity (from gear/abilities/buffs)
   * Clamped to absolute max of 500
   */
  setAtbMax(entityId: string, max: number): void {
    const state = this.ensureCombatant(entityId, Date.now());
    state.atbMax = Math.min(ATB_ABSOLUTE_MAX, Math.max(ATB_DEFAULT_MAX, max));
  }

  /**
   * Get ATB max for an entity
   */
  getAtbMax(entityId: string): number {
    const state = this.combatants.get(entityId);
    return state?.atbMax ?? ATB_DEFAULT_MAX;
  }

  // ========== Special Charge Methods (Builder/Consumer System) ==========

  /**
   * Add special charges to an entity (from builder abilities)
   * @param chargeType - The type of charge (e.g., "combo_point", "holy_power")
   * @param amount - Number of charges to add
   * @returns The new charge count after adding
   */
  addSpecialCharge(entityId: string, chargeType: string, amount: number): number {
    const state = this.ensureCombatant(entityId, Date.now());
    const current = state.specialCharges.get(chargeType) ?? 0;
    const newCount = Math.min(SPECIAL_CHARGE_MAX, current + amount);
    state.specialCharges.set(chargeType, newCount);
    return newCount;
  }

  /**
   * Check if entity has enough special charges
   */
  canSpendSpecialCharge(entityId: string, chargeType: string, amount: number): boolean {
    const state = this.combatants.get(entityId);
    if (!state) return false;
    const current = state.specialCharges.get(chargeType) ?? 0;
    return current >= amount;
  }

  /**
   * Spend special charges (for consumer abilities)
   * @returns true if charges were spent, false if not enough charges
   */
  spendSpecialCharge(entityId: string, chargeType: string, amount: number): boolean {
    const state = this.combatants.get(entityId);
    if (!state) return false;
    const current = state.specialCharges.get(chargeType) ?? 0;
    if (current < amount) return false;
    state.specialCharges.set(chargeType, current - amount);
    return true;
  }

  /**
   * Get current charge count for a specific type
   */
  getSpecialCharges(entityId: string, chargeType: string): number {
    const state = this.combatants.get(entityId);
    return state?.specialCharges.get(chargeType) ?? 0;
  }

  /**
   * Get all special charges for an entity (for client broadcast)
   */
  getAllSpecialCharges(entityId: string): Record<string, number> {
    const state = this.combatants.get(entityId);
    if (!state) return {};
    const charges: Record<string, number> = {};
    for (const [type, count] of state.specialCharges) {
      charges[type] = count;
    }
    return charges;
  }

  /**
   * Clear all special charges of a type (e.g., on death or combat end)
   */
  clearSpecialCharges(entityId: string, chargeType?: string): void {
    const state = this.combatants.get(entityId);
    if (!state) return;
    if (chargeType) {
      state.specialCharges.delete(chargeType);
    } else {
      state.specialCharges.clear();
    }
  }

  getCooldownRemaining(entityId: string, abilityId: string, now: number): number {
    const state = this.ensureCombatant(entityId, now);
    const expiresAt = state.cooldowns.get(abilityId);
    if (!expiresAt) return 0;
    return Math.max(0, expiresAt - now);
  }

  setCooldown(entityId: string, abilityId: string, cooldownMs: number, now: number): void {
    const state = this.ensureCombatant(entityId, now);
    if (cooldownMs <= 0) return;
    state.cooldowns.set(abilityId, now + cooldownMs);
  }

  // ========== Auto-Attack Methods ==========

  /**
   * Set auto-attack target for an entity
   */
  setAutoAttackTarget(entityId: string, targetId: string): void {
    const state = this.ensureCombatant(entityId, Date.now());
    state.autoAttackTarget = targetId;
  }

  /**
   * Clear auto-attack target for an entity
   */
  clearAutoAttackTarget(entityId: string): void {
    const state = this.combatants.get(entityId);
    if (state) {
      state.autoAttackTarget = undefined;
    }
  }

  /**
   * Get current auto-attack target for an entity
   */
  getAutoAttackTarget(entityId: string): string | undefined {
    const state = this.combatants.get(entityId);
    return state?.autoAttackTarget;
  }

  /**
   * Check if entity has an auto-attack target
   */
  hasAutoAttackTarget(entityId: string): boolean {
    return !!this.getAutoAttackTarget(entityId);
  }

  /**
   * Get all entities whose auto-attack timer has reached weapon speed
   * Returns array of { attackerId, targetId } pairs ready to execute
   */
  getAutoAttackersReady(): Array<{ attackerId: string; targetId: string }> {
    const ready: Array<{ attackerId: string; targetId: string }> = [];

    for (const state of this.combatants.values()) {
      if (state.autoAttackTarget && state.autoAttackTimer >= state.weaponSpeed) {
        ready.push({
          attackerId: state.entityId,
          targetId: state.autoAttackTarget,
        });
      }
    }

    return ready;
  }

  /**
   * Reset auto-attack timer after an attack fires
   */
  resetAutoAttackTimer(entityId: string): void {
    const state = this.combatants.get(entityId);
    if (state) {
      state.autoAttackTimer = 0;
    }
  }

  /**
   * Set weapon speed for an entity (from equipped weapon)
   */
  setWeaponSpeed(entityId: string, speed: number): void {
    const state = this.ensureCombatant(entityId, Date.now());
    state.weaponSpeed = speed;
  }

  /**
   * Reset weapon speed to default (unarmed)
   */
  resetWeaponSpeed(entityId: string): void {
    const state = this.ensureCombatant(entityId, Date.now());
    state.weaponSpeed = DEFAULT_WEAPON_SPEED;
  }

  /**
   * Get weapon speed for an entity
   */
  getWeaponSpeed(entityId: string): number {
    const state = this.combatants.get(entityId);
    return state?.weaponSpeed ?? DEFAULT_WEAPON_SPEED;
  }

  /**
   * Check if entity is in combat
   */
  isInCombat(entityId: string): boolean {
    const state = this.combatants.get(entityId);
    return state?.inCombat ?? false;
  }

  /**
   * Get all entity IDs whose auto-attack target is `targetId`.
   * (Used for enmity list — who is attacking this entity?)
   */
  getAttackersOf(targetId: string): string[] {
    const attackers: string[] = [];
    for (const state of this.combatants.values()) {
      if (state.autoAttackTarget === targetId && state.inCombat) {
        attackers.push(state.entityId);
      }
    }
    return attackers;
  }

  /**
   * Clear auto-attack for all entities targeting a specific entity
   * (Used when target dies or leaves)
   */
  clearAutoAttacksOnTarget(targetId: string): string[] {
    const cleared: string[] = [];
    for (const state of this.combatants.values()) {
      if (state.autoAttackTarget === targetId) {
        state.autoAttackTarget = undefined;
        cleared.push(state.entityId);
      }
    }
    return cleared;
  }

  /**
   * Get combat state for an entity (for client broadcast)
   * Returns null if entity has no combat state
   */
  getCombatState(entityId: string): {
    atb: { current: number; max: number };
    autoAttack: { current: number; max: number };
    inCombat: boolean;
    autoAttackTarget?: string;
    specialCharges: Record<string, number>;
  } | null {
    const state = this.combatants.get(entityId);
    if (!state) return null;

    return {
      atb: { current: Math.floor(state.atbGauge), max: state.atbMax },
      autoAttack: { current: state.autoAttackTimer, max: state.weaponSpeed },
      inCombat: state.inCombat,
      autoAttackTarget: state.autoAttackTarget,
      specialCharges: this.getAllSpecialCharges(entityId),
    };
  }

  /**
   * Get ATB state only for an entity (for allied broadcast - no auto-attack info)
   */
  getAtbState(entityId: string): { current: number; max: number } | null {
    const state = this.combatants.get(entityId);
    if (!state || !state.inCombat) return null;

    return { current: Math.floor(state.atbGauge), max: state.atbMax };
  }

  /**
   * Get all entities currently in combat (for broadcasting)
   */
  getEntitiesInCombat(): string[] {
    const entities: string[] = [];
    for (const state of this.combatants.values()) {
      if (state.inCombat) {
        entities.push(state.entityId);
      }
    }
    return entities;
  }

  enqueueAction(action: QueuedCombatAction): void {
    this.queuedActions.push(action);
  }

  getReadyActions(now: number): QueuedCombatAction[] {
    const ready: QueuedCombatAction[] = [];
    const pending: QueuedCombatAction[] = [];

    for (const action of this.queuedActions) {
      if (action.readyAt <= now) {
        ready.push(action);
      } else {
        pending.push(action);
      }
    }

    this.queuedActions = pending;
    return ready;
  }

  clearQueuedActionsForEntity(entityId: string): void {
    this.queuedActions = this.queuedActions.filter(action => action.attackerId !== entityId);
  }

  // ========== Buff / Debuff Methods ==========

  addBuff(entityId: string, buff: ActiveBuff): void {
    const state = this.ensureCombatant(entityId, Date.now());
    // Initialize tick timer for DoT/HoT buffs so first tick fires after one interval
    if ((buff.tickDamage || buff.tickHeal) && buff.lastTickAt == null) {
      buff.lastTickAt = Date.now();
    }
    state.activeBuffs.push(buff);
  }

  removeBuff(entityId: string, buffId: string): void {
    const state = this.combatants.get(entityId);
    if (!state) return;
    state.activeBuffs = state.activeBuffs.filter(b => b.id !== buffId);
  }

  getBuffs(entityId: string): ActiveBuff[] {
    const state = this.combatants.get(entityId);
    return state?.activeBuffs ?? [];
  }

  hasBuff(entityId: string, buffId: string): boolean {
    const state = this.combatants.get(entityId);
    if (!state) return false;
    return state.activeBuffs.some(b => b.id === buffId);
  }

  /**
   * Sum all active buff stat modifications for an entity.
   * Used to overlay temporary buffs on combat stat snapshots.
   */
  getBuffStatMods(entityId: string): Partial<CombatStats> {
    const state = this.combatants.get(entityId);
    if (!state) return {};
    const mods: Record<string, number> = {};
    const now = Date.now();
    for (const buff of state.activeBuffs) {
      if (buff.expiresAt <= now || !buff.statMods) continue;
      for (const [key, value] of Object.entries(buff.statMods)) {
        if (typeof value === 'number') {
          mods[key] = (mods[key] ?? 0) + value;
        }
      }
    }
    return mods as Partial<CombatStats>;
  }

  /**
   * Consume and return a "next attack" buff (Power Strike pattern).
   * Returns the buff if found and removes it, or undefined if none exists.
   */
  consumeNextAttackBuff(entityId: string): ActiveBuff | undefined {
    const state = this.combatants.get(entityId);
    if (!state) return undefined;
    const now = Date.now();
    const idx = state.activeBuffs.findIndex(
      b => b.consumeOnHit && b.expiresAt > now
    );
    if (idx === -1) return undefined;
    const [buff] = state.activeBuffs.splice(idx, 1);
    return buff;
  }

  // ========== Taunt Methods ==========

  setTaunt(entityId: string, taunterId: string, durationMs: number, now: number): void {
    const state = this.ensureCombatant(entityId, now);
    state.tauntedBy = taunterId;
    state.tauntExpiresAt = now + durationMs;
    // Force auto-attack to taunter immediately
    state.autoAttackTarget = taunterId;
  }

  clearTaunt(entityId: string): void {
    const state = this.combatants.get(entityId);
    if (!state) return;
    state.tauntedBy = undefined;
    state.tauntExpiresAt = undefined;
  }

  /** Get active CC state with expiry timestamps (for effect serialization). */
  getCCState(entityId: string): { tauntExpiresAt?: number; rootExpiresAt?: number } {
    const state = this.combatants.get(entityId);
    if (!state) return {};
    const now = Date.now();
    return {
      tauntExpiresAt: (state.tauntedBy && state.tauntExpiresAt && state.tauntExpiresAt > now)
        ? state.tauntExpiresAt : undefined,
      rootExpiresAt: (state.rooted && state.rootExpiresAt && state.rootExpiresAt > now)
        ? state.rootExpiresAt : undefined,
    };
  }

  getTauntedBy(entityId: string): string | undefined {
    const state = this.combatants.get(entityId);
    if (!state || !state.tauntedBy) return undefined;
    if (state.tauntExpiresAt && Date.now() >= state.tauntExpiresAt) {
      state.tauntedBy = undefined;
      state.tauntExpiresAt = undefined;
      return undefined;
    }
    return state.tauntedBy;
  }

  // ========== Root Methods ==========

  setRoot(entityId: string, durationMs: number, breakThreshold: number, now: number): void {
    const state = this.ensureCombatant(entityId, now);
    state.rooted = true;
    state.rootExpiresAt = now + durationMs;
    state.rootBreakThreshold = breakThreshold;
  }

  clearRoot(entityId: string): void {
    const state = this.combatants.get(entityId);
    if (!state) return;
    state.rooted = false;
    state.rootExpiresAt = undefined;
    state.rootBreakThreshold = undefined;
  }

  isRooted(entityId: string): boolean {
    const state = this.combatants.get(entityId);
    if (!state?.rooted) return false;
    if (state.rootExpiresAt && Date.now() >= state.rootExpiresAt) {
      state.rooted = false;
      state.rootExpiresAt = undefined;
      state.rootBreakThreshold = undefined;
      return false;
    }
    return true;
  }

  /**
   * Check if incoming damage breaks a root. Returns true if root was broken.
   */
  checkRootBreak(entityId: string, damageAmount: number): boolean {
    const state = this.combatants.get(entityId);
    if (!state?.rooted) return false;
    if (state.rootBreakThreshold && damageAmount >= state.rootBreakThreshold) {
      this.clearRoot(entityId);
      return true;
    }
    return false;
  }

  // ========== Enmity / Threat Methods ==========

  getEnmityTable(): EnmityTable {
    return this.enmityTable;
  }

  /** Generate threat from damage dealt. Applies the source entity's threatMultiplier. */
  generateDamageThreat(mobId: string, sourceId: string, damageAmount: number): void {
    const source = this.combatants.get(sourceId);
    const multiplier = source?.threatMultiplier ?? 1.0;
    this.enmityTable.addDamageThreat(mobId, sourceId, damageAmount, multiplier);
  }

  /** Generate threat from healing done. Applies the healer's threatMultiplier. */
  generateHealingThreat(mobId: string, healerId: string, healAmount: number): void {
    const healer = this.combatants.get(healerId);
    const multiplier = healer?.threatMultiplier ?? 1.0;
    this.enmityTable.addHealingThreat(mobId, healerId, healAmount, multiplier);
  }

  /** Generate flat threat (buffs, proximity, misc). Applies source's threatMultiplier. */
  generateFlatThreat(mobId: string, sourceId: string, amount: number): void {
    const source = this.combatants.get(sourceId);
    const multiplier = source?.threatMultiplier ?? 1.0;
    this.enmityTable.addFlatThreat(mobId, sourceId, amount, multiplier);
  }

  /** Generate ability-specific threat using the ability's threatModifier on top of entity multiplier. */
  generateAbilityThreat(mobId: string, sourceId: string, ability: CombatAbilityDefinition, baseThreat: number): void {
    const source = this.combatants.get(sourceId);
    const entityMultiplier = source?.threatMultiplier ?? 1.0;
    const abilityMultiplier = ability.threatModifier?.multiplier ?? 1.0;
    const flatBonus = ability.threatModifier?.flatBonus ?? 0;
    const totalThreat = (baseThreat * abilityMultiplier + flatBonus) * entityMultiplier;
    this.enmityTable.addRawThreat(mobId, sourceId, totalThreat);
  }

  setThreatMultiplier(entityId: string, multiplier: number): void {
    const state = this.ensureCombatant(entityId, Date.now());
    state.threatMultiplier = multiplier;
  }

  setThreatShedRate(entityId: string, rate: number): void {
    const state = this.ensureCombatant(entityId, Date.now());
    state.threatShedRate = rate;
  }

  setHealPotencyMult(entityId: string, mult: number): void {
    const state = this.ensureCombatant(entityId, Date.now());
    state.healPotencyMult = mult;
  }

  getHealPotencyMult(entityId: string): number {
    const state = this.combatants.get(entityId);
    return state?.healPotencyMult ?? 1.0;
  }
}
