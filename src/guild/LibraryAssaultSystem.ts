/**
 * LibraryAssaultSystem — Independent tick system for world-state-driven library assaults.
 *
 * Checks assault trigger conditions periodically and spawns assault events when thresholds are met.
 * Active guild beacons in a library's catchment area reduce assault trigger frequency.
 *
 * Pattern follows CorruptionSystem / EmberClockSystem.
 */

import { LibraryBeaconService, type AssaultType } from './LibraryBeaconService';
import type { LibraryBeacon } from '@prisma/client';

// ── Callback Types ──

export type AssaultStartCallback = (data: {
  libraryId: string;
  libraryName: string;
  assaultType: AssaultType;
  zoneId: string;
  position: { x: number; y: number; z: number };
  message: string;
}) => void;

export type AssaultResolvedCallback = (data: {
  libraryId: string;
  libraryName: string;
  assaultType: AssaultType;
  wasDefended: boolean;
  offlineHours: number;
  message: string;
}) => void;

// ── Configuration ──

interface AssaultConfig {
  /** Hours of no player activity before WANDERING_WAVE triggers. */
  lowActivityThresholdHours: number;
  /** Base assault window cooldown (hours after last assault before next can trigger). */
  assaultCooldownHours: number;
  /** Each active guild beacon in catchment adds this many hours to the low-activity threshold. */
  beaconActivityBonusHours: number;
  /** Failed defenses within this window (hours) trigger COORDINATED_ASSAULT. */
  failedDefenseWindowHours: number;
  /** Number of failed defenses within the window to trigger COORDINATED_ASSAULT. */
  failedDefenseThreshold: number;
  /** Duration of an active assault before it's auto-resolved (minutes). */
  assaultDurationMinutes: number;
}

const DEFAULT_CONFIG: AssaultConfig = {
  lowActivityThresholdHours: 6,
  assaultCooldownHours: 2,
  beaconActivityBonusHours: 2,
  failedDefenseWindowHours: 24,
  failedDefenseThreshold: 3,
  assaultDurationMinutes: 15,
};

// ── Active Assault Tracking ──

interface ActiveAssault {
  libraryId: string;
  assaultType: AssaultType;
  startedAt: number;
  defenderIds: Set<string>;
}

// ── System ──

export class LibraryAssaultSystem {
  private lastTickAt: number;
  private tickIntervalMs: number;
  private config: AssaultConfig;
  private assaultStartCallback: AssaultStartCallback | null = null;
  private assaultResolvedCallback: AssaultResolvedCallback | null = null;

  // Active assaults in progress (libraryId -> ActiveAssault)
  private activeAssaults: Map<string, ActiveAssault> = new Map();

  constructor(tickIntervalSeconds: number = 300, config?: Partial<AssaultConfig>) {
    this.tickIntervalMs = tickIntervalSeconds * 1000;
    this.lastTickAt = Date.now();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setAssaultStartCallback(callback: AssaultStartCallback): void {
    this.assaultStartCallback = callback;
  }

  setAssaultResolvedCallback(callback: AssaultResolvedCallback): void {
    this.assaultResolvedCallback = callback;
  }

  /**
   * Called every game frame. Only processes when tick interval has elapsed.
   */
  update(): void {
    const now = Date.now();
    const elapsed = now - this.lastTickAt;

    if (elapsed < this.tickIntervalMs) return;

    this.lastTickAt = now;
    void this.processTick();
  }

  /**
   * Force a tick for testing.
   */
  async forceTick(): Promise<void> {
    this.lastTickAt = Date.now();
    await this.processTick();
  }

  /**
   * Register a player as an active defender during an assault.
   */
  registerDefender(libraryId: string, characterId: string): boolean {
    const assault = this.activeAssaults.get(libraryId);
    if (!assault) return false;

    assault.defenderIds.add(characterId);
    return true;
  }

  /**
   * Get active assault for a library (if any).
   */
  getActiveAssault(libraryId: string): ActiveAssault | null {
    return this.activeAssaults.get(libraryId) ?? null;
  }

  /**
   * Clear all state.
   */
  clear(): void {
    this.activeAssaults.clear();
  }

  // ── Internal ──

  private async processTick(): Promise<void> {
    try {
      // 1. Restore expired offline libraries
      const restored = await LibraryBeaconService.checkAndRestoreExpired();
      for (const libraryId of restored) {
        const lib = await LibraryBeaconService.findById(libraryId);
        if (lib) {
          this.assaultResolvedCallback?.({
            libraryId,
            libraryName: lib.name,
            assaultType: 'WANDERING_WAVE', // generic — actual type was logged
            wasDefended: false,
            offlineHours: 0,
            message: `The ${lib.name} has been restored and is back online.`,
          });
        }
      }

      // 2. Resolve active assaults that have timed out (defenders won or failed)
      await this.resolveTimedOutAssaults();

      // 3. Check trigger conditions for each online library
      const onlineLibraries = await LibraryBeaconService.findAllOnline();

      for (const library of onlineLibraries) {
        // Skip if already under assault
        if (this.activeAssaults.has(library.id)) continue;

        // Skip if recently assaulted (cooldown)
        if (library.lastAssaultAt) {
          const hoursSinceAssault =
            (Date.now() - library.lastAssaultAt.getTime()) / (1000 * 60 * 60);
          if (hoursSinceAssault < this.config.assaultCooldownHours) continue;
        }

        const assaultType = await this.checkTriggerConditions(library);
        if (assaultType) {
          await this.startAssault(library, assaultType);
        }
      }
    } catch (err) {
      console.error('[LibraryAssaultSystem] Tick error:', err);
    }
  }

  /**
   * Check what assault type (if any) should trigger for a library.
   */
  private async checkTriggerConditions(library: LibraryBeacon): Promise<AssaultType | null> {
    const guildBeaconCount = await LibraryBeaconService.getGuildBeaconsInCatchment(library.id);
    const activityBonus = guildBeaconCount * this.config.beaconActivityBonusHours;

    // Check low activity
    if (library.lastActivityCheckAt) {
      const hoursSinceActivity =
        (Date.now() - library.lastActivityCheckAt.getTime()) / (1000 * 60 * 60);
      const threshold = this.config.lowActivityThresholdHours + activityBonus;

      if (hoursSinceActivity >= threshold) {
        return 'WANDERING_WAVE';
      }
    } else {
      // No activity ever recorded — but libraries start online, so give grace period
      // Only trigger if library has been up for more than the threshold
      const hoursSinceCreation =
        (Date.now() - library.createdAt.getTime()) / (1000 * 60 * 60);
      const threshold = this.config.lowActivityThresholdHours + activityBonus;
      if (hoursSinceCreation >= threshold) {
        return 'WANDERING_WAVE';
      }
    }

    // Check failed defenses in window
    const recentAssaults = await LibraryBeaconService.getRecentAssaults(library.id, 10);
    const windowStart = Date.now() - this.config.failedDefenseWindowHours * 60 * 60 * 1000;
    const recentFailures = recentAssaults.filter(
      (a) => !a.wasDefended && a.triggeredAt.getTime() >= windowStart,
    );

    if (recentFailures.length >= this.config.failedDefenseThreshold) {
      return 'COORDINATED_ASSAULT';
    }

    return null;
  }

  /**
   * Start an assault on a library.
   */
  private async startAssault(library: LibraryBeacon, assaultType: AssaultType): Promise<void> {
    const assault: ActiveAssault = {
      libraryId: library.id,
      assaultType,
      startedAt: Date.now(),
      defenderIds: new Set(),
    };

    this.activeAssaults.set(library.id, assault);

    const messages: Record<AssaultType, string> = {
      WANDERING_WAVE: `Corrupted patrols are approaching ${library.name}! The perimeter is being tested.`,
      FERAL_SURGE: `A feral surge of corrupted wildlife is bearing down on ${library.name}!`,
      COORDINATED_ASSAULT: `A coordinated corruption assault has been launched against ${library.name}! Elite enemies approach.`,
      UNOPPOSED_CORRUPTION: `Corruption floods toward ${library.name} with no resistance. The library is overwhelmed.`,
    };

    this.assaultStartCallback?.({
      libraryId: library.id,
      libraryName: library.name,
      assaultType,
      zoneId: library.zoneId,
      position: { x: library.worldX, y: library.worldY, z: library.worldZ },
      message: messages[assaultType],
    });
  }

  /**
   * Resolve assaults that have exceeded their duration.
   * If defenders were present → defended. If not → library goes offline.
   */
  private async resolveTimedOutAssaults(): Promise<void> {
    const now = Date.now();
    const timeoutMs = this.config.assaultDurationMinutes * 60 * 1000;

    for (const [libraryId, assault] of this.activeAssaults.entries()) {
      if (now - assault.startedAt < timeoutMs) continue;

      // Resolve: if any defenders showed up, it's defended
      const wasDefended = assault.defenderIds.size > 0;
      const library = await LibraryBeaconService.findById(libraryId);
      if (!library) {
        this.activeAssaults.delete(libraryId);
        continue;
      }

      let offlineHours = 0;
      if (!wasDefended) {
        offlineHours = LibraryBeaconService.computeOfflineDuration(assault.assaultType);
        await LibraryBeaconService.setOffline(libraryId, assault.assaultType, offlineHours);
      }

      await LibraryBeaconService.logAssault(
        libraryId,
        assault.assaultType,
        wasDefended,
        assault.defenderIds.size,
        wasDefended ? undefined : offlineHours,
      );

      const resultMessage = wasDefended
        ? `The assault on ${library.name} has been repelled! ${assault.defenderIds.size} defender(s) held the line.`
        : `${library.name} has fallen. The library is offline for ${offlineHours.toFixed(1)} hours.`;

      this.assaultResolvedCallback?.({
        libraryId,
        libraryName: library.name,
        assaultType: assault.assaultType,
        wasDefended,
        offlineHours,
        message: resultMessage,
      });

      this.activeAssaults.delete(libraryId);
    }
  }
}

// ── Singleton ──

let libraryAssaultInstance: LibraryAssaultSystem | null = null;

export function getLibraryAssaultSystem(): LibraryAssaultSystem {
  if (!libraryAssaultInstance) {
    libraryAssaultInstance = new LibraryAssaultSystem();
  }
  return libraryAssaultInstance;
}

export function resetLibraryAssaultSystem(): void {
  if (libraryAssaultInstance) {
    libraryAssaultInstance.clear();
  }
  libraryAssaultInstance = null;
}
