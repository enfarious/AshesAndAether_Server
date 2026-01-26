import {
  getCorruptionConfig,
  getZoneCorruptionRate,
  getZoneCorruptionRateWithTime,
  getIsolationCorruptionRate,
  getWealthCorruptionRate,
  getCorruptionState,
  clampCorruption,
  getPartyFieldReductionMultiplier,
  isNightTime,
  type CorruptionState,
} from './CorruptionConfig';
import { CorruptionService, type CorruptionUpdate, type CorruptionResult } from './CorruptionService';

/**
 * Callback for broadcasting corruption updates to clients
 */
export type CorruptionBroadcastCallback = (
  characterId: string,
  corruption: number,
  state: CorruptionState,
  previousState: CorruptionState | null,
  delta: number
) => void;

/**
 * Callback for checking if a character is in community
 * Returns true if character is near other players, in settlement, or near community objects
 */
export type CommunityCheckCallback = (characterId: string, zoneId: string) => boolean;

/**
 * Callback for getting party size for a character
 * Returns number of members (1 = solo, 5 = full party)
 */
export type PartySizeCallback = (characterId: string) => Promise<number>;

/**
 * Interface for zone data needed for corruption processing
 */
export interface ZoneCorruptionData {
  zoneId: string;
  corruptionTag: string;
  characterIds: string[];
}

/**
 * CorruptionSystem - Manages corruption tick processing across zones
 *
 * This system runs on its own tick interval (default 60 seconds) independent
 * of the main game tick rate. It processes all characters in all zones and
 * applies corruption deltas based on zone, isolation, and wealth factors.
 */
export class CorruptionSystem {
  private lastTickAt: number = 0;
  private tickIntervalMs: number;
  private broadcastCallback: CorruptionBroadcastCallback | null = null;
  private communityCheckCallback: CommunityCheckCallback | null = null;
  private partySizeCallback: PartySizeCallback | null = null;

  // Cache for character isolation tracking (characterId -> isInCommunity)
  private communityCache: Map<string, boolean> = new Map();

  // Cache for party size (updated each tick)
  private partySizeCache: Map<string, number> = new Map();

  constructor() {
    const config = getCorruptionConfig();
    this.tickIntervalMs = config.system.tick_interval_seconds * 1000;
    this.lastTickAt = Date.now();

    console.log(`[CorruptionSystem] Initialized with ${config.system.tick_interval_seconds}s tick interval`);
  }

  /**
   * Set callback for broadcasting corruption updates to clients
   */
  setBroadcastCallback(callback: CorruptionBroadcastCallback): void {
    this.broadcastCallback = callback;
  }

  /**
   * Set callback for checking if character is in community
   */
  setCommunityCheckCallback(callback: CommunityCheckCallback): void {
    this.communityCheckCallback = callback;
  }

  /**
   * Set callback for getting party size
   */
  setPartySizeCallback(callback: PartySizeCallback): void {
    this.partySizeCallback = callback;
  }

  /**
   * Called every game tick - only processes when interval has elapsed
   */
  update(zones: ZoneCorruptionData[]): void {
    const now = Date.now();
    const elapsed = now - this.lastTickAt;

    if (elapsed < this.tickIntervalMs) {
      return; // Not time for corruption tick yet
    }

    // Time to process corruption
    this.lastTickAt = now;
    void this.processTick(zones);
  }

  /**
   * Force a corruption tick (for testing or manual triggers)
   */
  async forceTick(zones: ZoneCorruptionData[]): Promise<void> {
    this.lastTickAt = Date.now();
    await this.processTick(zones);
  }

  /**
   * Process corruption tick for all zones
   */
  private async processTick(zones: ZoneCorruptionData[]): Promise<void> {
    const config = getCorruptionConfig();
    const tickMinutes = config.system.tick_interval_seconds / 60;

    const allUpdates: CorruptionUpdate[] = [];
    let totalProcessed = 0;
    let totalStateChanges = 0;

    for (const zone of zones) {
      const zoneUpdates = await this.processZone(zone, tickMinutes);
      allUpdates.push(...zoneUpdates);
      totalProcessed += zone.characterIds.length;
    }

    if (allUpdates.length === 0) {
      return;
    }

    // Apply all updates in batch
    const results = await CorruptionService.batchUpdateCorruption(allUpdates);

    // Broadcast state changes
    for (const result of results) {
      if (result.stateChanged) {
        totalStateChanges++;
      }

      // Always broadcast on tick so clients stay synced
      if (this.broadcastCallback) {
        const delta = result.newCorruption - result.previousCorruption;
        this.broadcastCallback(
          result.characterId,
          result.newCorruption,
          result.newState,
          result.stateChanged ? result.previousState : null,
          delta
        );
      }
    }

    if (config.debug.log_zone_changes || totalStateChanges > 0) {
      console.log(
        `[CorruptionSystem] Tick complete: ${totalProcessed} characters, ` +
        `${allUpdates.length} updates, ${totalStateChanges} state changes`
      );
    }
  }

  /**
   * Process corruption for a single zone
   */
  private async processZone(zone: ZoneCorruptionData, tickMinutes: number): Promise<CorruptionUpdate[]> {
    const config = getCorruptionConfig();
    const updates: CorruptionUpdate[] = [];

    // Get zone corruption rate with time-of-day modifier
    const currentHour = new Date().getHours();
    const zoneRate = getZoneCorruptionRateWithTime(zone.corruptionTag, currentHour);
    const isNight = isNightTime(currentHour);

    // Get character data for this zone
    const characters = await CorruptionService.getZoneCharactersForTick(zone.zoneId);

    // Fetch party sizes for all characters if callback is set
    const partySizes = new Map<string, number>();
    if (this.partySizeCallback) {
      for (const character of characters) {
        const partySize = await this.partySizeCallback(character.id);
        partySizes.set(character.id, partySize);
        this.partySizeCache.set(character.id, partySize);
      }
    }

    for (const character of characters) {
      const partySize = partySizes.get(character.id) ?? 1;

      const update = this.calculateCharacterDelta(
        character.id,
        zone.zoneId,
        zone.corruptionTag,
        zoneRate,
        character.isolationSeconds,
        character.wealthScoreCached,
        character.contributionBuffExpires,
        tickMinutes,
        partySize,
        isNight
      );

      if (update) {
        updates.push(update);
      }

      // Update isolation/community tracking
      await this.updateTimeTracking(character.id, zone.zoneId, config.system.tick_interval_seconds);
    }

    return updates;
  }

  /**
   * Calculate corruption delta for a single character
   */
  private calculateCharacterDelta(
    characterId: string,
    zoneId: string,
    zoneTag: string,
    zoneRate: number,
    isolationSeconds: number,
    wealthScore: number,
    contributionBuffExpires: Date | null,
    tickMinutes: number,
    partySize: number = 1,
    isNight: boolean = false
  ): CorruptionUpdate | null {
    const config = getCorruptionConfig();
    const reasons: string[] = [];

    // Get party field reduction multiplier (1.0 = no reduction, 0.3 = 70% reduction)
    const partyMultiplier = getPartyFieldReductionMultiplier(partySize);
    const hasPartyReduction = partyMultiplier < 1.0;

    // 1. Zone corruption gain (affected by party reduction)
    let zoneGain = zoneRate * tickMinutes;
    if (hasPartyReduction && zoneGain > 0) {
      zoneGain *= partyMultiplier;
    }
    if (zoneGain !== 0) {
      const nightStr = isNight ? ', night' : '';
      const partyStr = hasPartyReduction ? `, party:${partySize}` : '';
      reasons.push(`zone(${zoneTag}${nightStr}${partyStr}): ${zoneGain > 0 ? '+' : ''}${zoneGain.toFixed(3)}`);
    }

    // 2. Isolation gain (affected by party reduction)
    const isolationMinutes = isolationSeconds / 60;
    let isolationGain = getIsolationCorruptionRate(isolationMinutes) * tickMinutes;
    if (hasPartyReduction && isolationGain > 0) {
      isolationGain *= partyMultiplier;
    }
    if (isolationGain > 0) {
      const partyStr = hasPartyReduction ? `, party:${partySize}` : '';
      reasons.push(`isolation(${Math.round(isolationMinutes)}min${partyStr}): +${isolationGain.toFixed(3)}`);
    }

    // 3. Wealth gain (NOT affected by party reduction - per design)
    let wealthGain = getWealthCorruptionRate(wealthScore) * tickMinutes;
    if (wealthGain > 0) {
      // Check for contribution buff
      if (contributionBuffExpires && contributionBuffExpires > new Date()) {
        const buffMultiplier = config.contribution.wealth_gain_multiplier_buff.per_award_multiplier;
        wealthGain *= buffMultiplier;
        reasons.push(`wealth(${wealthScore}, buffed): +${wealthGain.toFixed(3)}`);
      } else {
        reasons.push(`wealth(${wealthScore}): +${wealthGain.toFixed(3)}`);
      }
    }

    // Total delta
    const totalDelta = zoneGain + isolationGain + wealthGain;

    // Skip if no change (common for characters in WILDS with low isolation/wealth)
    if (Math.abs(totalDelta) < 0.0001) {
      return null;
    }

    return {
      characterId,
      delta: totalDelta,
      eventType: 'TICK',
      reason: reasons.join('; '),
      metadata: {
        zoneId,
        zoneTag,
        zoneGain,
        isolationGain,
        isolationMinutes,
        wealthGain,
        wealthScore,
        tickMinutes,
        partySize,
        partyReductionApplied: partyMultiplier < 1.0,
        partyReductionPercent: Math.round((1 - partyMultiplier) * 100),
        isNight,
      },
    };
  }

  /**
   * Update time tracking for isolation vs community
   */
  private async updateTimeTracking(
    characterId: string,
    zoneId: string,
    tickSeconds: number
  ): Promise<void> {
    // Check if character is in community
    let isInCommunity = false;

    if (this.communityCheckCallback) {
      isInCommunity = this.communityCheckCallback(characterId, zoneId);
    }

    // Update cache
    const wasInCommunity = this.communityCache.get(characterId) ?? false;
    this.communityCache.set(characterId, isInCommunity);

    // Update time tracking in database
    if (isInCommunity) {
      await CorruptionService.updateTimeTracking(characterId, 0, tickSeconds);
    } else {
      await CorruptionService.updateTimeTracking(characterId, tickSeconds, 0);
    }
  }

  /**
   * Handle forbidden action (immediate corruption spike)
   * Call this from game logic when a forbidden action occurs
   */
  async applyForbiddenAction(
    characterId: string,
    eventType: string,
    reason?: string
  ): Promise<CorruptionResult | null> {
    const result = await CorruptionService.applyForbiddenAction(characterId, eventType, reason);

    if (result && this.broadcastCallback) {
      const delta = result.newCorruption - result.previousCorruption;
      this.broadcastCallback(
        characterId,
        result.newCorruption,
        result.newState,
        result.stateChanged ? result.previousState : null,
        delta
      );
    }

    return result;
  }

  /**
   * Add contribution points (from community actions)
   * Call this from game logic when player contributes
   */
  async addContribution(
    characterId: string,
    points: number,
    source: string
  ): Promise<{ pointsAdded: number; corruptionReduced: number; buffApplied: boolean }> {
    const result = await CorruptionService.addContribution(characterId, points, source);

    if (result.corruptionReduced > 0 && this.broadcastCallback) {
      // Fetch updated corruption to broadcast
      const data = await CorruptionService.getCorruptionData(characterId);
      if (data) {
        this.broadcastCallback(
          characterId,
          data.corruption,
          data.corruptionState,
          null, // Don't know previous state here
          -result.corruptionReduced
        );
      }
    }

    return result;
  }

  /**
   * Get current corruption state for a character
   */
  async getCharacterCorruption(characterId: string): Promise<{
    corruption: number;
    state: CorruptionState;
    isolationMinutes: number;
    wealthScore: number;
    contributionPoints: number;
  } | null> {
    const data = await CorruptionService.getCorruptionData(characterId);
    if (!data) return null;

    return {
      corruption: data.corruption,
      state: data.corruptionState,
      isolationMinutes: data.isolationSeconds / 60,
      wealthScore: data.wealthScoreCached,
      contributionPoints: data.contributionPoints,
    };
  }

  /**
   * Remove character from tracking (on disconnect)
   */
  removeCharacter(characterId: string): void {
    this.communityCache.delete(characterId);
  }

  /**
   * Clear all tracking (for shutdown)
   */
  clear(): void {
    this.communityCache.clear();
  }
}

// Export singleton for convenience
let corruptionSystemInstance: CorruptionSystem | null = null;

export function getCorruptionSystem(): CorruptionSystem {
  if (!corruptionSystemInstance) {
    corruptionSystemInstance = new CorruptionSystem();
  }
  return corruptionSystemInstance;
}

export function resetCorruptionSystem(): void {
  if (corruptionSystemInstance) {
    corruptionSystemInstance.clear();
  }
  corruptionSystemInstance = null;
}
