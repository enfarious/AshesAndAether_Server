import { prisma } from '../DatabaseService';
import { Prisma } from '@prisma/client';
import type { Companion } from '@prisma/client';

interface CompanionCreateInput {
  name: string;
  ownerAccountId: string;
  ownerCharacterId: string;
  zoneId: string;
  positionX: number;
  positionY: number;
  positionZ: number;
  personalityType?: string;
  archetype?: string;
  traits?: string[];
  goals?: string[];
  description?: string;
  systemPrompt?: string;
}

export class CompanionService {
  static async create(data: CompanionCreateInput): Promise<Companion> {
    const personalityType = data.personalityType || 'loyal_companion';
    const archetype = data.archetype || 'opportunist';
    const traits = data.traits?.length ? data.traits : ['loyal', 'curious'];
    const goals = data.goals?.length ? data.goals : ['protect owner', 'explore'];
    const description = data.description || `A loyal companion named ${data.name}.`;

    const systemPrompt = data.systemPrompt ||
      `You are ${data.name}, a ${personalityType} companion. ` +
      `Archetype: ${archetype}. Traits: ${traits.join(', ')}. ` +
      `Goals: ${goals.join(', ')}. ` +
      `You follow and protect your owner. Respond in character.`;

    return prisma.companion.create({
      data: {
        name: data.name,
        description,
        personalityType,
        archetype,
        traits,
        goals,
        memoryData: {
          background: `Created as a player companion.`,
          relationships: [],
          recentEvents: [],
        },
        level: 1,
        stats: { strength: 8, vitality: 10, dexterity: 10, agility: 10, intelligence: 8, wisdom: 8 },
        currentHealth: 100,
        maxHealth: 100,
        isAlive: true,
        zoneId: data.zoneId,
        positionX: data.positionX,
        positionY: data.positionY,
        positionZ: data.positionZ,
        systemPrompt,
        conversationHistory: [],
        relationships: {},
        abilityIds: [],
        questIds: [],
        ownerAccountId: data.ownerAccountId,
        ownerCharacterId: data.ownerCharacterId,
        behaviorState: 'active',
      },
    });
  }

  static async deleteByOwnerCharacter(characterId: string): Promise<void> {
    await prisma.companion.deleteMany({
      where: { ownerCharacterId: characterId },
    });
  }

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

  static async updatePosition(
    companionId: string,
    data: { zoneId?: string; positionX?: number; positionY?: number; positionZ?: number },
  ): Promise<void> {
    await prisma.companion.update({
      where: { id: companionId },
      data,
    });
  }

  static async findByOwnerCharacter(characterId: string): Promise<Companion | null> {
    return prisma.companion.findFirst({
      where: { ownerCharacterId: characterId },
    });
  }

  static async updateCombatConfig(
    companionId: string,
    data: { archetype?: string; combatSettings?: Prisma.InputJsonValue; abilityIds?: string[] },
  ): Promise<void> {
    await prisma.companion.update({
      where: { id: companionId },
      data,
    });
  }

  static async updateBehaviorState(
    companionId: string,
    data: {
      behaviorState?: string;
      behaviorTree?: Prisma.InputJsonValue | null;
      taskDescription?: string | null;
      taskAssignedAt?: Date | null;
      harvestsCompleted?: { increment: number };
      itemsGathered?: { increment: number };
      lastHarvestAt?: Date;
    },
  ): Promise<void> {
    const updateData: Prisma.CompanionUncheckedUpdateInput = {};

    if (data.behaviorState !== undefined) updateData.behaviorState = data.behaviorState;
    if (data.taskDescription !== undefined) updateData.taskDescription = data.taskDescription;
    if (data.taskAssignedAt !== undefined) updateData.taskAssignedAt = data.taskAssignedAt;
    if (data.lastHarvestAt !== undefined) updateData.lastHarvestAt = data.lastHarvestAt;

    if (data.behaviorTree === null) {
      updateData.behaviorTree = Prisma.DbNull;
    } else if (data.behaviorTree !== undefined) {
      updateData.behaviorTree = data.behaviorTree;
    }

    if (data.harvestsCompleted !== undefined) updateData.harvestsCompleted = data.harvestsCompleted;
    if (data.itemsGathered !== undefined) updateData.itemsGathered = data.itemsGathered;

    await prisma.companion.update({
      where: { id: companionId },
      data: updateData,
    });
  }
}
