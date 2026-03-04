import { prisma } from '@/database/DatabaseService';
import type { ScriptedObject } from '@prisma/client';

interface ScriptedObjectCreateInput {
  name: string;
  ownerCharacterId: string;
  zoneId: string;
  positionX: number;
  positionY: number;
  positionZ: number;
  description?: string;
  scriptSource?: string;
}

export class ScriptedObjectService {
  static async create(data: ScriptedObjectCreateInput): Promise<ScriptedObject> {
    return prisma.scriptedObject.create({
      data: {
        name: data.name,
        description: data.description,
        ownerCharacterId: data.ownerCharacterId,
        zoneId: data.zoneId,
        positionX: data.positionX,
        positionY: data.positionY,
        positionZ: data.positionZ,
        scriptSource: data.scriptSource ?? '',
        stateData: {},
      },
    });
  }

  static async findById(id: string): Promise<ScriptedObject | null> {
    return prisma.scriptedObject.findUnique({ where: { id } });
  }

  static async findByZone(zoneId: string): Promise<ScriptedObject[]> {
    return prisma.scriptedObject.findMany({ where: { zoneId } });
  }

  static async findByOwner(characterId: string): Promise<ScriptedObject[]> {
    return prisma.scriptedObject.findMany({
      where: { ownerCharacterId: characterId },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async countByOwner(characterId: string): Promise<number> {
    return prisma.scriptedObject.count({
      where: { ownerCharacterId: characterId },
    });
  }

  static async updateScript(id: string, scriptSource: string): Promise<ScriptedObject> {
    return prisma.scriptedObject.update({
      where: { id },
      data: { scriptSource, errorCount: 0, lastErrorMsg: null, lastErrorAt: null },
    });
  }

  static async updateState(id: string, stateData: Record<string, unknown>): Promise<void> {
    await prisma.scriptedObject.update({
      where: { id },
      data: { stateData: stateData as any },
    });
  }

  static async activate(id: string): Promise<void> {
    await prisma.scriptedObject.update({
      where: { id },
      data: { isActive: true, errorCount: 0, lastErrorMsg: null, lastErrorAt: null },
    });
  }

  static async deactivate(id: string): Promise<void> {
    await prisma.scriptedObject.update({
      where: { id },
      data: { isActive: false },
    });
  }

  static async recordError(id: string, errorMsg: string): Promise<void> {
    await prisma.scriptedObject.update({
      where: { id },
      data: {
        errorCount: { increment: 1 },
        lastErrorMsg: errorMsg.substring(0, 512),
        lastErrorAt: new Date(),
      },
    });
  }

  static async delete(id: string): Promise<void> {
    await prisma.scriptedObject.delete({ where: { id } });
  }
}
