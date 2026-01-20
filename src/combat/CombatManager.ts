import { CombatantState, ATB_DEFAULT_MAX, ATB_ABSOLUTE_MAX, SPECIAL_CHARGE_MAX, QueuedCombatAction } from './types';

const DEFAULT_ATB_BASE_RATE = 10; // gauge per second
const DEFAULT_COMBAT_TIMEOUT_MS = 15000;
const DEFAULT_WEAPON_SPEED = 3.0; // seconds between auto-attacks (default unarmed)

export class CombatManager {
  private combatants: Map<string, CombatantState> = new Map();
  private queuedActions: QueuedCombatAction[] = [];
  private readonly baseRate: number;
  private readonly timeoutMs: number;

  constructor(options?: { baseRate?: number; timeoutMs?: number }) {
    this.baseRate = options?.baseRate ?? DEFAULT_ATB_BASE_RATE;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_COMBAT_TIMEOUT_MS;
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

  update(deltaTime: number, getAttackSpeedBonus: (entityId: string) => number): string[] {
    const now = Date.now();
    const expired: string[] = [];

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
          expired.push(state.entityId);
        }
      }
    }

    return expired;
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
}
