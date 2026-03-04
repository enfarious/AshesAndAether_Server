/**
 * EmberClockSystem — Independent tick system for guild beacon fuel management.
 * Follows the CorruptionSystem pattern: interval-gated ticks, callbacks, singleton.
 *
 * Responsibilities:
 * - Decrement fuel for all lit beacons every tick
 * - Start ember clock when fuel hits 0
 * - Extinguish beacons when ember clock (48h) expires
 * - Fire announcement callbacks at defined thresholds
 * - Fire state change callbacks when beacons go dark or relight
 */

import { GuildBeaconService, type BeaconStateChange } from './GuildBeaconService';
import { prisma } from '../database/DatabaseService';

// ── Callback Types ──

export type BeaconStateChangeCallback = (change: BeaconStateChange) => void;

export type EmberClockAnnouncementCallback = (announcement: {
  beaconId: string;
  guildId: string;
  hoursRemaining: number;
  message: string;
  scope: 'guild' | 'zone' | 'zone_wide' | 'server_wide';
}) => void;

// ── Announcement Thresholds ──

interface AnnouncementThreshold {
  hours: number;
  message: string;
  scope: 'guild' | 'zone' | 'zone_wide' | 'server_wide';
}

const ANNOUNCEMENT_THRESHOLDS: AnnouncementThreshold[] = [
  { hours: 48, message: 'Beacon fuel exhausted — embers are dying. The beacon will go dark in 48 hours.', scope: 'guild' },
  { hours: 24, message: "Warning: the beacon's embers have burned for a full day. 24 hours remain.", scope: 'guild' },
  { hours: 12, message: 'Warning: 12 hours remain before the beacon goes dark.', scope: 'guild' },
  { hours: 6, message: 'Warning: 6 hours remain. The beacon light grows dim.', scope: 'guild' },
  { hours: 2, message: 'Urgent: 2 hours remain. The beacon flickers.', scope: 'zone' },
  { hours: 1, message: 'Urgent: 1 hour remains.', scope: 'zone' },
  { hours: 0.5, message: 'Final warning: 30 minutes. The beacon is nearly dark.', scope: 'zone_wide' },
  { hours: 0.25, message: 'Final warning: 15 minutes.', scope: 'zone_wide' },
  { hours: 1 / 12, message: 'FINAL: 5 minutes.', scope: 'zone_wide' },
  { hours: 1 / 60, message: 'FINAL: 1 minute.', scope: 'zone_wide' },
];

// ── System ──

export class EmberClockSystem {
  private lastTickAt: number;
  private tickIntervalMs: number;
  private stateChangeCallback: BeaconStateChangeCallback | null = null;
  private announcementCallback: EmberClockAnnouncementCallback | null = null;

  // Track which announcement thresholds have fired per beacon (beaconId -> Set of threshold hours)
  private firedAnnouncements: Map<string, Set<number>> = new Map();

  constructor(tickIntervalSeconds: number = 60) {
    this.tickIntervalMs = tickIntervalSeconds * 1000;
    this.lastTickAt = Date.now();
  }

  setStateChangeCallback(callback: BeaconStateChangeCallback): void {
    this.stateChangeCallback = callback;
  }

  setAnnouncementCallback(callback: EmberClockAnnouncementCallback): void {
    this.announcementCallback = callback;
  }

  /**
   * Called every game frame. Only processes when tick interval has elapsed.
   */
  update(): void {
    const now = Date.now();
    const elapsed = now - this.lastTickAt;

    if (elapsed < this.tickIntervalMs) return;

    this.lastTickAt = now;
    void this.processTick(elapsed);
  }

  /**
   * Force a tick for testing.
   */
  async forceTick(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastTickAt;
    this.lastTickAt = now;
    await this.processTick(elapsed);
  }

  /**
   * Clear all tracking state.
   */
  clear(): void {
    this.firedAnnouncements.clear();
  }

  // ── Internal ──

  private async processTick(elapsedMs: number): Promise<void> {
    const elapsedHours = elapsedMs / (1000 * 60 * 60);

    try {
      // 1. Tick all beacons (fuel decrement + ember clock check)
      const stateChanges = await GuildBeaconService.tickAllBeacons(elapsedHours);

      // 2. Fire state change callbacks
      for (const change of stateChanges) {
        // Clean up fired announcements for extinguished beacons
        if (change.newState === 'DARK') {
          this.firedAnnouncements.delete(change.beaconId);
        }
        this.stateChangeCallback?.(change);
      }

      // 3. Check ember clock announcements for beacons in ember state
      await this.checkAnnouncements();
    } catch (err) {
      console.error('[EmberClockSystem] Tick error:', err);
    }
  }

  /**
   * Check all beacons with active ember clocks and fire announcements at thresholds.
   */
  private async checkAnnouncements(): Promise<void> {
    if (!this.announcementCallback) return;

    const beaconsInEmber = await prisma.guildBeacon.findMany({
      where: {
        isLit: true,
        fuelRemaining: 0,
        emberClockStartedAt: { not: null },
      },
    });

    const now = Date.now();

    for (const beacon of beaconsInEmber) {
      if (!beacon.emberClockStartedAt) continue;

      const emberElapsedMs = now - beacon.emberClockStartedAt.getTime();
      const emberElapsedHours = emberElapsedMs / (1000 * 60 * 60);
      const hoursRemaining = GuildBeaconService.EMBER_CLOCK_HOURS - emberElapsedHours;

      // Get or create fired set for this beacon
      let fired = this.firedAnnouncements.get(beacon.id);
      if (!fired) {
        fired = new Set();
        this.firedAnnouncements.set(beacon.id, fired);
      }

      // Check each threshold
      for (const threshold of ANNOUNCEMENT_THRESHOLDS) {
        if (hoursRemaining <= threshold.hours && !fired.has(threshold.hours)) {
          fired.add(threshold.hours);
          this.announcementCallback({
            beaconId: beacon.id,
            guildId: beacon.guildId,
            hoursRemaining: Math.max(0, hoursRemaining),
            message: threshold.message,
            scope: threshold.scope,
          });
        }
      }
    }
  }
}

// ── Singleton ──

let emberClockInstance: EmberClockSystem | null = null;

export function getEmberClockSystem(): EmberClockSystem {
  if (!emberClockInstance) {
    emberClockInstance = new EmberClockSystem();
  }
  return emberClockInstance;
}

export function resetEmberClockSystem(): void {
  if (emberClockInstance) {
    emberClockInstance.clear();
  }
  emberClockInstance = null;
}
