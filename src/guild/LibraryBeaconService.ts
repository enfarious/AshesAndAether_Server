/**
 * LibraryBeaconService — Static class for library beacon CRUD and state management.
 * Libraries are public NPC fixtures, not guild-owned.
 */

import { prisma } from '../database/DatabaseService';
import { distance2D } from './geometry';
import type { LibraryBeacon, LibraryAssaultLog } from '@prisma/client';

// ── Types ──

export type AssaultType =
  | 'WANDERING_WAVE'
  | 'FERAL_SURGE'
  | 'COORDINATED_ASSAULT'
  | 'UNOPPOSED_CORRUPTION';

export interface LibraryInfo {
  id: string;
  name: string;
  description: string | null;
  position: { x: number; y: number; z: number };
  zoneId: string;
  catchmentRadius: number;
  isOnline: boolean;
  offlineUntil: Date | null;
  offlineReason: string | null;
  assaultCount: number;
  failedDefenseCount: number;
  guildBeaconsInCatchment: number;
}

/** Offline durations by assault type (in hours). */
const OFFLINE_DURATIONS: Record<AssaultType, { min: number; max: number }> = {
  WANDERING_WAVE: { min: 0.5, max: 2 },
  FERAL_SURGE: { min: 2, max: 6 },
  COORDINATED_ASSAULT: { min: 6, max: 24 },
  UNOPPOSED_CORRUPTION: { min: 24, max: 48 },
};

// ── Service ──

export class LibraryBeaconService {
  static readonly OFFLINE_DURATIONS = OFFLINE_DURATIONS;

  // ── Lookups ──

  static async findById(libraryId: string): Promise<LibraryBeacon | null> {
    return prisma.libraryBeacon.findUnique({ where: { id: libraryId } });
  }

  static async findAllOnline(): Promise<LibraryBeacon[]> {
    return prisma.libraryBeacon.findMany({ where: { isOnline: true } });
  }

  static async findAll(): Promise<LibraryBeacon[]> {
    return prisma.libraryBeacon.findMany({ orderBy: { name: 'asc' } });
  }

  static async findByZoneId(zoneId: string): Promise<LibraryBeacon[]> {
    return prisma.libraryBeacon.findMany({ where: { zoneId } });
  }

  /**
   * Find any library whose catchment radius covers the given position.
   */
  static async findInCatchmentRadius(
    position: { x: number; z: number },
    zoneId: string,
  ): Promise<LibraryBeacon | null> {
    const libraries = await prisma.libraryBeacon.findMany({ where: { zoneId } });

    for (const lib of libraries) {
      const dist = distance2D(
        { x: position.x, z: position.z },
        { x: lib.worldX, z: lib.worldZ },
      );
      if (dist <= lib.catchmentRadius) return lib;
    }

    return null;
  }

  // ── State Management ──

  /**
   * Take a library offline after a failed assault defense.
   */
  static async setOffline(
    libraryId: string,
    reason: string,
    durationHours: number,
  ): Promise<void> {
    const offlineUntil = new Date(Date.now() + durationHours * 60 * 60 * 1000);

    await prisma.libraryBeacon.update({
      where: { id: libraryId },
      data: {
        isOnline: false,
        offlineUntil,
        offlineReason: reason,
        failedDefenseCount: { increment: 1 },
      },
    });
  }

  /**
   * Bring a library back online.
   */
  static async setOnline(libraryId: string): Promise<void> {
    await prisma.libraryBeacon.update({
      where: { id: libraryId },
      data: {
        isOnline: true,
        offlineUntil: null,
        offlineReason: null,
      },
    });
  }

  /**
   * Check all offline libraries and restore any whose offlineUntil has passed.
   * Returns IDs of restored libraries.
   */
  static async checkAndRestoreExpired(): Promise<string[]> {
    const now = new Date();
    const expired = await prisma.libraryBeacon.findMany({
      where: {
        isOnline: false,
        offlineUntil: { not: null, lte: now },
      },
    });

    if (expired.length === 0) return [];

    const ids = expired.map((lib) => lib.id);

    await prisma.libraryBeacon.updateMany({
      where: { id: { in: ids } },
      data: {
        isOnline: true,
        offlineUntil: null,
        offlineReason: null,
      },
    });

    return ids;
  }

  // ── Activity Tracking ──

  /**
   * Record player activity near a library — delays assault triggers.
   */
  static async recordPlayerActivity(libraryId: string): Promise<void> {
    await prisma.libraryBeacon.update({
      where: { id: libraryId },
      data: { lastActivityCheckAt: new Date() },
    });
  }

  // ── Assault Logs ──

  static async logAssault(
    libraryId: string,
    assaultType: AssaultType,
    wasDefended: boolean,
    participantCount: number,
    offlineDuration?: number,
  ): Promise<LibraryAssaultLog> {
    const log = await prisma.libraryAssaultLog.create({
      data: {
        libraryId,
        assaultType,
        wasDefended,
        participantCount,
        offlineDuration: offlineDuration ?? null,
        resolvedAt: new Date(),
      },
    });

    await prisma.libraryBeacon.update({
      where: { id: libraryId },
      data: {
        assaultCount: { increment: 1 },
        lastAssaultAt: new Date(),
      },
    });

    return log;
  }

  /**
   * Get recent assault logs for a library.
   */
  static async getRecentAssaults(
    libraryId: string,
    limit: number = 10,
  ): Promise<LibraryAssaultLog[]> {
    return prisma.libraryAssaultLog.findMany({
      where: { libraryId },
      orderBy: { triggeredAt: 'desc' },
      take: limit,
    });
  }

  // ── Beacon Interaction ──

  /**
   * Find lit guild beacons within a library's catchment radius.
   * Active guild beacons reduce assault trigger frequency.
   */
  static async getGuildBeaconsInCatchment(libraryId: string): Promise<number> {
    const library = await prisma.libraryBeacon.findUnique({ where: { id: libraryId } });
    if (!library) return 0;

    const litBeacons = await prisma.guildBeacon.findMany({
      where: { zoneId: library.zoneId, isLit: true },
    });

    let count = 0;
    for (const beacon of litBeacons) {
      const dist = distance2D(
        { x: library.worldX, z: library.worldZ },
        { x: beacon.worldX, z: beacon.worldZ },
      );
      if (dist <= library.catchmentRadius) count++;
    }

    return count;
  }

  /**
   * Get full library info including guild beacon count in catchment.
   */
  static async getLibraryInfo(libraryId: string): Promise<LibraryInfo | null> {
    const library = await prisma.libraryBeacon.findUnique({ where: { id: libraryId } });
    if (!library) return null;

    const guildBeaconsInCatchment = await LibraryBeaconService.getGuildBeaconsInCatchment(libraryId);

    return {
      id: library.id,
      name: library.name,
      description: library.description,
      position: { x: library.worldX, y: library.worldY, z: library.worldZ },
      zoneId: library.zoneId,
      catchmentRadius: library.catchmentRadius,
      isOnline: library.isOnline,
      offlineUntil: library.offlineUntil,
      offlineReason: library.offlineReason,
      assaultCount: library.assaultCount,
      failedDefenseCount: library.failedDefenseCount,
      guildBeaconsInCatchment,
    };
  }

  // Compute offline duration for an assault type (random within range)
  static computeOfflineDuration(assaultType: AssaultType): number {
    const range = OFFLINE_DURATIONS[assaultType];
    return range.min + Math.random() * (range.max - range.min);
  }
}
