import { prisma } from '../DatabaseService';
import type { Companion } from '@prisma/client';

export class CompanionService {
  static async findById(companionId: string): Promise<Companion | null> {
    return prisma.companion.findUnique({
      where: { id: companionId },
    });
  }

  static async findByTag(tag: string): Promise<Companion[]> {
    return prisma.companion.findMany({
      where: { tag },
      orderBy: { name: 'asc' },
    });
  }

  static async updateHealth(companionId: string, currentHealth: number): Promise<void> {
    await prisma.companion.update({
      where: { id: companionId },
      data: { currentHealth },
    });
  }

  static async updateStatus(
    companionId: string,
    data: { currentHealth?: number; isAlive?: boolean }
  ): Promise<void> {
    await prisma.companion.update({
      where: { id: companionId },
      data,
    });
  }
}
