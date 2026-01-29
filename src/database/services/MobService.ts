import { prisma } from '../DatabaseService';
import type { Mob } from '@prisma/client';

export class MobService {
  static async findById(mobId: string): Promise<Mob | null> {
    return prisma.mob.findUnique({
      where: { id: mobId },
    });
  }

  static async findByTag(tag: string): Promise<Mob[]> {
    return prisma.mob.findMany({
      where: { tag },
    });
  }

  static async updateStatus(
    mobId: string,
    status: { currentHealth?: number; isAlive?: boolean }
  ): Promise<void> {
    await prisma.mob.update({
      where: { id: mobId },
      data: status,
    });
  }

  static async updatePosition(
    mobId: string,
    position: { positionX: number; positionY: number; positionZ: number }
  ): Promise<void> {
    await prisma.mob.update({
      where: { id: mobId },
      data: position,
    });
  }

  static async markDeath(mobId: string): Promise<void> {
    await prisma.mob.update({
      where: { id: mobId },
      data: {
        isAlive: false,
        lastDeathAt: new Date(),
      },
    });
  }

  static async respawn(mobId: string): Promise<Mob> {
    const mob = await prisma.mob.findUnique({
      where: { id: mobId },
    });

    if (!mob) {
      throw new Error(`Mob ${mobId} not found`);
    }

    return prisma.mob.update({
      where: { id: mobId },
      data: {
        isAlive: true,
        currentHealth: mob.maxHealth,
        lastDeathAt: null,
      },
    });
  }

  static async findAliveInZone(zoneId: string): Promise<Mob[]> {
    return prisma.mob.findMany({
      where: {
        zoneId,
        isAlive: true,
      },
    });
  }

  static async findAllInZone(zoneId: string): Promise<Mob[]> {
    return prisma.mob.findMany({
      where: { zoneId },
    });
  }

  static async createMob(data: {
    name: string;
    tag: string;
    description?: string;
    templateId?: string;
    level: number;
    stats: any;
    currentHealth: number;
    maxHealth: number;
    zoneId: string;
    positionX: number;
    positionY: number;
    positionZ: number;
    aiType?: string;
    aggroRadius?: number;
    respawnTime?: number;
    lootTableId?: string;
    spawnedFromTable?: boolean;
    spawnTileId?: string;
  }): Promise<Mob> {
    return prisma.mob.create({
      data,
    });
  }

  static async deleteMob(mobId: string): Promise<void> {
    await prisma.mob.delete({
      where: { id: mobId },
    });
  }

  static async findPendingRespawns(): Promise<Mob[]> {
    return prisma.mob.findMany({
      where: {
        isAlive: false,
        lastDeathAt: {
          not: null,
        },
      },
    });
  }
}
