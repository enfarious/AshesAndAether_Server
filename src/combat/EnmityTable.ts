/** A single entry in a mob's threat table */
export interface ThreatEntry {
  entityId: string;
  threat: number;
  lastUpdatedAt: number;
}

/** Tuning knobs for the enmity system */
export interface EnmityConfig {
  /** Absolute threat decay per second (applied per-entry). Default: 5 */
  baseDecayPerSecond: number;
  /** New target must exceed current target's threat by this fraction to switch. Default: 0.10 (10%) */
  switchThresholdPct: number;
  /** Threat generated per point of damage dealt. Default: 1.0 */
  damageThreatRatio: number;
  /** Threat generated per point of healing done. Default: 0.5 */
  healingThreatRatio: number;
  /** Flat threat generated on buff application. Default: 20 */
  buffBaseThreat: number;
  /** Flat threat from proximity aggro (initial pull). Default: 50 */
  proximityThreat: number;
  /** Flat threat bonus applied by taunt abilities. Default: 2000 */
  tauntThreatBonus: number;
}

export const DEFAULT_ENMITY_CONFIG: EnmityConfig = {
  baseDecayPerSecond: 5,
  switchThresholdPct: 0.10,
  damageThreatRatio: 1.0,
  healingThreatRatio: 0.5,
  buffBaseThreat: 20,
  proximityThreat: 50,
  tauntThreatBonus: 2000,
};

export class EnmityTable {
  /** Map<mobEntityId, Map<threatSourceId, ThreatEntry>> */
  private tables: Map<string, Map<string, ThreatEntry>> = new Map();
  readonly config: EnmityConfig;

  constructor(config?: Partial<EnmityConfig>) {
    this.config = { ...DEFAULT_ENMITY_CONFIG, ...config };
  }

  // ── Threat Generation ──

  addDamageThreat(mobId: string, sourceId: string, damageAmount: number, threatMultiplier: number): void {
    const threat = damageAmount * this.config.damageThreatRatio * threatMultiplier;
    this.addRawThreat(mobId, sourceId, threat);
  }

  addHealingThreat(mobId: string, sourceId: string, healAmount: number, threatMultiplier: number): void {
    const threat = healAmount * this.config.healingThreatRatio * threatMultiplier;
    this.addRawThreat(mobId, sourceId, threat);
  }

  addFlatThreat(mobId: string, sourceId: string, amount: number, threatMultiplier: number): void {
    this.addRawThreat(mobId, sourceId, amount * threatMultiplier);
  }

  addRawThreat(mobId: string, sourceId: string, amount: number): void {
    if (amount <= 0) return;
    let table = this.tables.get(mobId);
    if (!table) {
      table = new Map();
      this.tables.set(mobId, table);
    }
    const existing = table.get(sourceId);
    if (existing) {
      existing.threat += amount;
      existing.lastUpdatedAt = Date.now();
    } else {
      table.set(sourceId, { entityId: sourceId, threat: amount, lastUpdatedAt: Date.now() });
    }
  }

  // ── Threat Reduction ──

  /** Reduce a specific entity's threat on a specific mob by a flat amount. */
  reduceThreat(mobId: string, sourceId: string, amount: number): void {
    const table = this.tables.get(mobId);
    if (!table) return;
    const entry = table.get(sourceId);
    if (!entry) return;
    entry.threat = Math.max(0, entry.threat - amount);
    if (entry.threat <= 0) table.delete(sourceId);
    if (table.size === 0) this.tables.delete(mobId);
  }

  /** Reduce a specific entity's threat by percentage across ALL mob tables. */
  reduceThreatPercent(sourceId: string, percent: number): void {
    const factor = Math.max(0, Math.min(1, percent));
    for (const [mobId, table] of this.tables) {
      const entry = table.get(sourceId);
      if (!entry) continue;
      entry.threat *= (1 - factor);
      if (entry.threat <= 0) table.delete(sourceId);
      if (table.size === 0) this.tables.delete(mobId);
    }
  }

  // ── Decay ──

  /**
   * Tick-based decay for all threat entries.
   * @param deltaTime seconds since last tick
   * @param getShedRate callback returning an entity's threatShedRate (default 1.0)
   */
  decayAll(deltaTime: number, getShedRate: (entityId: string) => number): void {
    for (const [mobId, table] of this.tables) {
      const toRemove: string[] = [];
      for (const [entityId, entry] of table) {
        const shedRate = getShedRate(entityId);
        const decay = this.config.baseDecayPerSecond * shedRate * deltaTime;
        entry.threat = Math.max(0, entry.threat - decay);
        if (entry.threat <= 0) toRemove.push(entityId);
      }
      for (const id of toRemove) table.delete(id);
      if (table.size === 0) this.tables.delete(mobId);
    }
  }

  // ── Cleanup ──

  removeEntry(mobId: string, sourceId: string): void {
    const table = this.tables.get(mobId);
    if (!table) return;
    table.delete(sourceId);
    if (table.size === 0) this.tables.delete(mobId);
  }

  clearTable(mobId: string): void {
    this.tables.delete(mobId);
  }

  removeEntityFromAllTables(entityId: string): void {
    for (const [mobId, table] of this.tables) {
      table.delete(entityId);
      if (table.size === 0) this.tables.delete(mobId);
    }
  }

  // ── Queries ──

  getTopThreat(mobId: string): ThreatEntry | null {
    const table = this.tables.get(mobId);
    if (!table || table.size === 0) return null;
    let top: ThreatEntry | null = null;
    for (const entry of table.values()) {
      if (!top || entry.threat > top.threat) top = entry;
    }
    return top;
  }

  getSortedThreats(mobId: string): ThreatEntry[] {
    const table = this.tables.get(mobId);
    if (!table) return [];
    return Array.from(table.values()).sort((a, b) => b.threat - a.threat);
  }

  getThreat(mobId: string, entityId: string): number {
    return this.tables.get(mobId)?.get(entityId)?.threat ?? 0;
  }

  hasTable(mobId: string): boolean {
    const table = this.tables.get(mobId);
    return !!table && table.size > 0;
  }

  /** Get all mob IDs that have a given entity on their threat table. */
  getMobsThreatenedBy(entityId: string): string[] {
    const mobs: string[] = [];
    for (const [mobId, table] of this.tables) {
      if (table.has(entityId)) mobs.push(mobId);
    }
    return mobs;
  }

  /** Get all mob IDs that have threat tables. */
  getAllMobIds(): string[] {
    return Array.from(this.tables.keys());
  }

  // ── Target Evaluation ──

  /**
   * Determine who a mob should attack based on threat table with hysteresis.
   * Returns undefined if table is empty.
   * Taunt overrides are handled externally by CombatManager.
   */
  evaluateTarget(mobId: string, currentTargetId: string | undefined): string | undefined {
    const table = this.tables.get(mobId);
    if (!table || table.size === 0) return undefined;

    let topEntry: ThreatEntry | null = null;
    for (const entry of table.values()) {
      if (!topEntry || entry.threat > topEntry.threat) topEntry = entry;
    }
    if (!topEntry) return undefined;

    // No current target — take whoever is on top
    if (!currentTargetId) return topEntry.entityId;

    // Current target is already top threat — keep it
    if (topEntry.entityId === currentTargetId) return currentTargetId;

    // Check if top threat exceeds current target by threshold
    const currentThreat = this.getThreat(mobId, currentTargetId);
    if (currentThreat <= 0) return topEntry.entityId;

    const threshold = currentThreat * (1 + this.config.switchThresholdPct);
    return topEntry.threat >= threshold ? topEntry.entityId : currentTargetId;
  }
}
