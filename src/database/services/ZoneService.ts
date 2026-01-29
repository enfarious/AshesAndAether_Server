import { prisma } from '../DatabaseService';
import type { Zone, Character, Companion } from '@prisma/client';

export class ZoneService {
  /**
   * Find zone by ID
   */
  static async findById(zoneId: string): Promise<Zone | null> {
    return prisma.zone.findUnique({
      where: { id: zoneId },
    });
  }

  /**
   * Find zone with all entities (characters and companions)
   */
  static async findByIdWithEntities(
    zoneId: string
  ): Promise<(Zone & { characters: Character[]; companions: Companion[] }) | null> {
    return prisma.zone.findUnique({
      where: { id: zoneId },
      include: {
        characters: true,
        // Note: Companions table doesn't have relation to Zone in schema yet
        // Will need to add this when we implement companion system
      },
    }) as Promise<(Zone & { characters: Character[]; companions: Companion[] }) | null>;
  }

  /**
   * Get all zones
   */
  static async findAll(): Promise<Zone[]> {
    return prisma.zone.findMany({
      orderBy: [{ worldX: 'asc' }, { worldY: 'asc' }],
    });
  }

  /**
   * Get zones by world coordinates
   */
  static async findByWorldCoordinates(worldX: number, worldY: number): Promise<Zone | null> {
    return prisma.zone.findUnique({
      where: {
        worldX_worldY: { worldX, worldY },
      },
    });
  }

  /**
   * Get character count in zone
   */
  static async getCharacterCount(zoneId: string): Promise<number> {
    return prisma.character.count({
      where: { zoneId },
    });
  }

  /**
   * Get companions in zone (NPCs only, not mobs)
   */
  static async getCompanionsInZone(zoneId: string): Promise<Companion[]> {
    return prisma.companion.findMany({
      where: { zoneId },
    });
  }

  /**
   * Get mobs in zone
   */
  static async getMobsInZone(zoneId: string) {
    return prisma.mob.findMany({
      where: { zoneId },
    });
  }
}
