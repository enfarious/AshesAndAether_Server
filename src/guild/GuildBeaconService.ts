/**
 * GuildBeaconService — Static class for beacon operations, fuel management,
 * world point queries, spatial checks, and polygon computation.
 */

import { prisma } from '../database/DatabaseService';
import { GuildService } from './GuildService';
import { Prisma } from '@prisma/client';
import {
  computeConvexHull,
  computePolygonArea,
  polygonsOverlap,
  distance2D,
  type Point2D,
} from './geometry';
import type { GuildBeacon, GuildWorldPoint, GuildPolygon } from '@prisma/client';

// ── Result Types ──

export interface BeaconLightResult {
  success: boolean;
  beacon?: GuildBeacon;
  error?: string;
}

export interface BeaconFuelResult {
  success: boolean;
  fuelAdded: number;
  fuelRemaining: number;
  error?: string;
}

export interface BeaconInfo {
  id: string;
  worldPointName: string;
  tier: number;
  isLit: boolean;
  fuelRemaining: number;
  fuelCapacity: number;
  emberClockStartedAt: Date | null;
  position: { x: number; y: number; z: number };
  zoneId: string;
  guildId: string;
  guildTag: string;
}

export interface BeaconStateChange {
  beaconId: string;
  guildId: string;
  previousState: 'LIT' | 'DARK';
  newState: 'LIT' | 'DARK';
  fuelRemaining: number;
}

// ── Constants ──

const EFFECT_RADIUS_METERS = 100;
const FUEL_CAPACITY_HOURS = 48;
const EMBER_CLOCK_HOURS = 48;
const POLYGON_MAX_DISTANCE_METERS = 10_000; // 10km

/** Corruption resist bonus per beacon tier (percentage, applied server-wide to guild members). */
const CORRUPTION_RESIST_BY_TIER: Record<number, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
};

/** XP bonus per beacon tier (percentage, applied server-wide to guild members). */
const XP_BONUS_BY_TIER: Record<number, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
};

/** Valid fuel wood item template names by minimum tier. */
const FUEL_TIERS: Record<string, number> = {
  common_wood: 1,
  seasoned_wood: 2,
  darkwood: 3,
  embered_wood: 4,
  void_timber: 5,
};

/** Hours of burn time per fuel type. Higher tier = longer burn. */
const FUEL_BURN_HOURS: Record<string, number> = {
  common_wood: 4,
  seasoned_wood: 6,
  darkwood: 8,
  embered_wood: 12,
  void_timber: 16,
};

// ── Service ──

export class GuildBeaconService {
  // ── Exported constants ──
  static readonly EFFECT_RADIUS_METERS = EFFECT_RADIUS_METERS;
  static readonly FUEL_CAPACITY_HOURS = FUEL_CAPACITY_HOURS;
  static readonly EMBER_CLOCK_HOURS = EMBER_CLOCK_HOURS;
  static readonly POLYGON_MAX_DISTANCE_METERS = POLYGON_MAX_DISTANCE_METERS;
  static readonly CORRUPTION_RESIST_BY_TIER = CORRUPTION_RESIST_BY_TIER;
  static readonly XP_BONUS_BY_TIER = XP_BONUS_BY_TIER;
  static readonly FUEL_TIERS = FUEL_TIERS;
  static readonly FUEL_BURN_HOURS = FUEL_BURN_HOURS;

  // ══════════════════════════════════════════════════════════════
  // WORLD POINTS
  // ══════════════════════════════════════════════════════════════

  static async findWorldPointById(pointId: string): Promise<GuildWorldPoint | null> {
    return prisma.guildWorldPoint.findUnique({ where: { id: pointId } });
  }

  static async findWorldPointsInZone(zoneId: string): Promise<GuildWorldPoint[]> {
    return prisma.guildWorldPoint.findMany({
      where: { zoneId, isActive: true },
      include: { beacon: { select: { id: true, guildId: true, isLit: true } } },
    });
  }

  /**
   * Find the nearest unclaimed world point within maxRange meters of the given position.
   */
  static async findNearestWorldPoint(
    zoneId: string,
    position: { x: number; y: number; z: number },
    maxRange: number,
  ): Promise<GuildWorldPoint | null> {
    const points = await prisma.guildWorldPoint.findMany({
      where: { zoneId, isActive: true },
      include: { beacon: { select: { id: true } } },
    });

    let closest: GuildWorldPoint | null = null;
    let closestDist = Infinity;

    for (const point of points) {
      // Skip points that already have a beacon
      if ((point as any).beacon) continue;

      const dist = distance2D(
        { x: position.x, z: position.z },
        { x: point.worldX, z: point.worldZ },
      );
      if (dist <= maxRange && dist < closestDist) {
        closest = point;
        closestDist = dist;
      }
    }

    return closest;
  }

  static async isWorldPointAvailable(pointId: string): Promise<boolean> {
    const point = await prisma.guildWorldPoint.findUnique({
      where: { id: pointId },
      include: { beacon: { select: { id: true } } },
    });
    return !!point && point.isActive && !(point as any).beacon;
  }

  // ══════════════════════════════════════════════════════════════
  // BEACON OPERATIONS
  // ══════════════════════════════════════════════════════════════

  /**
   * Light a beacon at a world point.
   * Validates: guild exists, beacon allotment not exceeded, world point available.
   */
  static async lightBeacon(data: {
    guildId: string;
    worldPointId: string;
    lightedByCharacterId: string;
    initialFuelHours: number;
  }): Promise<BeaconLightResult> {
    const { guildId, worldPointId, lightedByCharacterId, initialFuelHours } = data;

    const guild = await prisma.guild.findUnique({ where: { id: guildId } });
    if (!guild || guild.disbandedAt) {
      return { success: false, error: 'Guild not found or has been disbanded.' };
    }

    // Check beacon allotment
    const currentCount = await prisma.guildBeacon.count({
      where: { guildId, isLit: true },
    });
    const maxBeacons = GuildService.getMaxBeacons(guild.memberCount);
    if (currentCount >= maxBeacons) {
      return {
        success: false,
        error: `Your guild can only maintain ${maxBeacons} beacon(s) with ${guild.memberCount} members.`,
      };
    }

    // Check world point
    const worldPoint = await prisma.guildWorldPoint.findUnique({
      where: { id: worldPointId },
      include: { beacon: { select: { id: true } } },
    });
    if (!worldPoint || !worldPoint.isActive) {
      return { success: false, error: 'Beacon point not found or inactive.' };
    }
    if ((worldPoint as any).beacon) {
      return { success: false, error: 'This beacon point is already claimed.' };
    }

    const fuelHours = Math.min(initialFuelHours, FUEL_CAPACITY_HOURS);

    try {
      const beacon = await prisma.guildBeacon.create({
        data: {
          guildId,
          worldPointId,
          isLit: true,
          tier: worldPoint.tierHint,
          fuelRemaining: fuelHours,
          fuelCapacity: FUEL_CAPACITY_HOURS,
          lastFuelTickAt: new Date(),
          effectRadius: EFFECT_RADIUS_METERS,
          worldX: worldPoint.worldX,
          worldY: worldPoint.worldY,
          worldZ: worldPoint.worldZ,
          zoneId: worldPoint.zoneId,
          litAt: new Date(),
        },
      });

      // Log the initial fuel
      await prisma.guildBeaconFuelLog.create({
        data: {
          beaconId: beacon.id,
          characterId: lightedByCharacterId,
          fuelType: 'initial_lighting',
          fuelHours,
        },
      });

      return { success: true, beacon };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to light beacon.' };
    }
  }

  /**
   * Add fuel to a lit beacon. Fuel type must match or exceed beacon tier.
   */
  static async fuelBeacon(data: {
    beaconId: string;
    characterId: string;
    fuelType: string;
    quantity: number;
  }): Promise<BeaconFuelResult> {
    const { beaconId, characterId, fuelType, quantity } = data;

    const beacon = await prisma.guildBeacon.findUnique({ where: { id: beaconId } });
    if (!beacon) return { success: false, fuelAdded: 0, fuelRemaining: 0, error: 'Beacon not found.' };

    // Validate fuel tier
    const fuelTier = FUEL_TIERS[fuelType];
    if (fuelTier === undefined) {
      return { success: false, fuelAdded: 0, fuelRemaining: beacon.fuelRemaining, error: `Unknown fuel type: ${fuelType}` };
    }
    if (fuelTier < beacon.tier) {
      return {
        success: false,
        fuelAdded: 0,
        fuelRemaining: beacon.fuelRemaining,
        error: `This beacon requires tier ${beacon.tier} fuel or higher. ${fuelType} is only tier ${fuelTier}.`,
      };
    }

    const burnHours = FUEL_BURN_HOURS[fuelType] ?? 4;
    const totalFuelToAdd = burnHours * quantity;
    const newFuel = Math.min(beacon.fuelRemaining + totalFuelToAdd, FUEL_CAPACITY_HOURS);
    const actualAdded = newFuel - beacon.fuelRemaining;

    // If beacon was in ember clock (fuel was 0), reset the clock
    const wasEmberClock = beacon.fuelRemaining <= 0 && beacon.emberClockStartedAt !== null;

    await prisma.$transaction([
      prisma.guildBeacon.update({
        where: { id: beaconId },
        data: {
          fuelRemaining: newFuel,
          isLit: true,
          emberClockStartedAt: wasEmberClock ? null : beacon.emberClockStartedAt,
          lastFuelTickAt: new Date(),
        },
      }),
      prisma.guildBeaconFuelLog.create({
        data: {
          beaconId,
          characterId,
          fuelType,
          fuelHours: actualAdded,
        },
      }),
    ]);

    return { success: true, fuelAdded: actualAdded, fuelRemaining: newFuel };
  }

  /**
   * Extinguish a beacon (voluntary or from ember clock expiration).
   */
  static async extinguishBeacon(beaconId: string): Promise<void> {
    await prisma.guildBeacon.update({
      where: { id: beaconId },
      data: {
        isLit: false,
        fuelRemaining: 0,
        emberClockStartedAt: null,
        darkAt: new Date(),
      },
    });
  }

  // ══════════════════════════════════════════════════════════════
  // QUERIES
  // ══════════════════════════════════════════════════════════════

  static async findBeaconById(beaconId: string): Promise<GuildBeacon | null> {
    return prisma.guildBeacon.findUnique({ where: { id: beaconId } });
  }

  static async findBeaconsByGuild(guildId: string): Promise<GuildBeacon[]> {
    return prisma.guildBeacon.findMany({ where: { guildId }, orderBy: { tier: 'asc' } });
  }

  static async findLitBeaconsInZone(zoneId: string): Promise<GuildBeacon[]> {
    return prisma.guildBeacon.findMany({ where: { zoneId, isLit: true } });
  }

  static async findAllLitBeacons(): Promise<GuildBeacon[]> {
    return prisma.guildBeacon.findMany({ where: { isLit: true } });
  }

  static async getBeaconInfo(beaconId: string): Promise<BeaconInfo | null> {
    const beacon = await prisma.guildBeacon.findUnique({
      where: { id: beaconId },
      include: {
        worldPoint: { select: { name: true } },
        guild: { select: { tag: true } },
      },
    });
    if (!beacon) return null;

    return {
      id: beacon.id,
      worldPointName: beacon.worldPoint.name,
      tier: beacon.tier,
      isLit: beacon.isLit,
      fuelRemaining: beacon.fuelRemaining,
      fuelCapacity: beacon.fuelCapacity,
      emberClockStartedAt: beacon.emberClockStartedAt,
      position: { x: beacon.worldX, y: beacon.worldY, z: beacon.worldZ },
      zoneId: beacon.zoneId,
      guildId: beacon.guildId,
      guildTag: beacon.guild.tag,
    };
  }

  static async getGuildBeaconCount(guildId: string): Promise<number> {
    return prisma.guildBeacon.count({ where: { guildId, isLit: true } });
  }

  // ══════════════════════════════════════════════════════════════
  // EMBER CLOCK TICK
  // ══════════════════════════════════════════════════════════════

  /**
   * Tick all lit beacons: decrement fuel, start ember clock if fuel hits 0,
   * extinguish if ember clock expires. Returns state changes.
   */
  static async tickAllBeacons(elapsedHours: number): Promise<BeaconStateChange[]> {
    const litBeacons = await prisma.guildBeacon.findMany({
      where: { isLit: true },
    });

    const stateChanges: BeaconStateChange[] = [];
    const now = new Date();

    for (const beacon of litBeacons) {
      if (beacon.fuelRemaining > 0) {
        // Decrement fuel
        const newFuel = Math.max(0, beacon.fuelRemaining - elapsedHours);

        if (newFuel <= 0 && beacon.fuelRemaining > 0) {
          // Fuel just ran out — start ember clock
          await prisma.guildBeacon.update({
            where: { id: beacon.id },
            data: {
              fuelRemaining: 0,
              emberClockStartedAt: now,
              lastFuelTickAt: now,
            },
          });
          // No state change yet — beacon is still lit during ember clock
        } else {
          await prisma.guildBeacon.update({
            where: { id: beacon.id },
            data: { fuelRemaining: newFuel, lastFuelTickAt: now },
          });
        }
      } else if (beacon.emberClockStartedAt) {
        // Ember clock is running — check if 48h have elapsed
        const emberElapsedMs = now.getTime() - beacon.emberClockStartedAt.getTime();
        const emberElapsedHours = emberElapsedMs / (1000 * 60 * 60);

        if (emberElapsedHours >= EMBER_CLOCK_HOURS) {
          // Beacon goes dark
          await GuildBeaconService.extinguishBeacon(beacon.id);
          stateChanges.push({
            beaconId: beacon.id,
            guildId: beacon.guildId,
            previousState: 'LIT',
            newState: 'DARK',
            fuelRemaining: 0,
          });
        }
      }
    }

    return stateChanges;
  }

  // ══════════════════════════════════════════════════════════════
  // SPATIAL
  // ══════════════════════════════════════════════════════════════

  /**
   * Check if a point is within a lit beacon's effect radius.
   */
  static isPointInBeaconRadius(
    point: { x: number; z: number },
    beacon: { worldX: number; worldZ: number; effectRadius: number },
  ): boolean {
    const dist = distance2D(
      { x: point.x, z: point.z },
      { x: beacon.worldX, z: beacon.worldZ },
    );
    return dist <= beacon.effectRadius;
  }

  // ══════════════════════════════════════════════════════════════
  // GUILD BONUSES
  // ══════════════════════════════════════════════════════════════

  /**
   * Compute total corruption resist % and XP bonus % from all lit beacons for a guild.
   * Bonuses stack from multiple beacons (capped at sum of all tiers).
   */
  static async getGuildBeaconBonuses(guildId: string): Promise<{
    corruptionResistPercent: number;
    xpBonusPercent: number;
  }> {
    const litBeacons = await prisma.guildBeacon.findMany({
      where: { guildId, isLit: true },
      select: { tier: true },
    });

    let corruptionResist = 0;
    let xpBonus = 0;

    for (const beacon of litBeacons) {
      corruptionResist += CORRUPTION_RESIST_BY_TIER[beacon.tier] ?? 0;
      xpBonus += XP_BONUS_BY_TIER[beacon.tier] ?? 0;
    }

    return {
      corruptionResistPercent: corruptionResist,
      xpBonusPercent: xpBonus,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // POLYGON COMPUTATION
  // ══════════════════════════════════════════════════════════════

  /**
   * Recompute polygons for a guild based on its lit beacons.
   * Rules:
   * - Min 3 lit beacons within 10km of each other
   * - Convex hull forms the polygon
   * - Cannot overlap with any existing active polygon from another guild
   */
  static async recomputePolygons(guildId: string): Promise<GuildPolygon[]> {
    // Delete existing polygons for this guild
    await prisma.guildPolygon.deleteMany({ where: { guildId } });

    // Get all lit beacons
    const litBeacons = await prisma.guildBeacon.findMany({
      where: { guildId, isLit: true },
      orderBy: { tier: 'asc' },
    });

    if (litBeacons.length < 3) return [];

    // Check all beacons are within 10km of each other
    for (let i = 0; i < litBeacons.length; i++) {
      for (let j = i + 1; j < litBeacons.length; j++) {
        const dist = distance2D(
          { x: litBeacons[i].worldX, z: litBeacons[i].worldZ },
          { x: litBeacons[j].worldX, z: litBeacons[j].worldZ },
        );
        if (dist > POLYGON_MAX_DISTANCE_METERS) {
          // Beacons too far apart — no polygon
          return [];
        }
      }
    }

    // Compute convex hull
    const points: Point2D[] = litBeacons.map((b) => ({ x: b.worldX, z: b.worldZ }));
    const hull = computeConvexHull(points);

    if (hull.length < 3) return [];

    // Check overlap with existing active polygons from other guilds
    const existingPolygons = await prisma.guildPolygon.findMany({
      where: { isActive: true, guildId: { not: guildId } },
    });

    for (const existing of existingPolygons) {
      const existingVerts = (existing.vertices as unknown) as Point2D[];
      if (polygonsOverlap(hull, existingVerts)) {
        // Overlap detected — polygon suppressed
        return [];
      }
    }

    // Build beacon tier data for gradient computation
    const beaconTiers = litBeacons.map((b) => ({
      beaconId: b.id,
      tier: b.tier,
      x: b.worldX,
      z: b.worldZ,
    }));

    const area = computePolygonArea(hull);

    const polygon = await prisma.guildPolygon.create({
      data: {
        guildId,
        vertices: hull as unknown as Prisma.InputJsonValue,
        beaconIds: litBeacons.map((b) => b.id),
        beaconTiers: beaconTiers as unknown as Prisma.InputJsonValue,
        areaSqMeters: area,
        isActive: true,
      },
    });

    return [polygon];
  }

  /**
   * Get all active guild polygons with their tier data.
   */
  static async getActivePolygons(): Promise<
    Array<{
      guildId: string;
      vertices: Point2D[];
      beaconTiers: Array<{ beaconId: string; tier: number; x: number; z: number }>;
    }>
  > {
    const polygons = await prisma.guildPolygon.findMany({
      where: { isActive: true },
    });

    return polygons.map((p) => ({
      guildId: p.guildId,
      vertices: (p.vertices as unknown) as Point2D[],
      beaconTiers: (p.beaconTiers as unknown) as Array<{
        beaconId: string;
        tier: number;
        x: number;
        z: number;
      }>,
    }));
  }
}
