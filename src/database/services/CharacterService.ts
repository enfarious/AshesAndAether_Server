import { prisma } from '../DatabaseService';
import { StatCalculator } from '@/game/stats/StatCalculator';
import type { Character, Zone, Prisma } from '@prisma/client';

export class CharacterService {
  /**
   * Find character by ID
   */
  static async findById(characterId: string): Promise<Character | null> {
    return prisma.character.findUnique({
      where: { id: characterId },
    });
  }

  /**
   * Find character by name (case-insensitive)
   */
  static async findByName(name: string): Promise<Character | null> {
    return prisma.character.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
  }

  /**
   * Find character by ID with zone data
   */
  static async findByIdWithZone(characterId: string): Promise<(Character & { zone: Zone }) | null> {
    return prisma.character.findUnique({
      where: { id: characterId },
      include: { zone: true },
    });
  }

  /**
   * Get all characters for an account
   */
  static async findByAccountId(accountId: string): Promise<Character[]> {
    return prisma.character.findMany({
      where: { accountId },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  /**
   * Create a new character
   */
  static async createCharacter(data: {
    accountId: string;
    name: string;
    zoneId: string;
    positionX: number;
    positionY: number;
    positionZ: number;
    cosmetics?: Record<string, unknown>;
  }): Promise<Character> {
    // Calculate derived stats from default core stats (all 10)
    const coreStats = {
      strength: 10,
      vitality: 10,
      dexterity: 10,
      agility: 10,
      intelligence: 10,
      wisdom: 10,
    };

    const derivedStats = StatCalculator.calculateDerivedStats(coreStats, 1);

    return prisma.character.create({
      data: {
        accountId: data.accountId,
        name: data.name,
        level: 1,
        experience: 0,
        abilityPoints: 0,

        // Core stats
        ...coreStats,

        // Derived stats
        maxHp: derivedStats.maxHp,
        maxStamina: derivedStats.maxStamina,
        maxMana: derivedStats.maxMana,
        attackRating: derivedStats.attackRating,
        defenseRating: derivedStats.defenseRating,
        magicAttack: derivedStats.magicAttack,
        magicDefense: derivedStats.magicDefense,

        // Current resources (full)
        currentHp: derivedStats.maxHp,
        currentStamina: derivedStats.maxStamina,
        currentMana: derivedStats.maxMana,
        isAlive: true,

        // Position
        zoneId: data.zoneId,
        positionX: data.positionX,
        positionY: data.positionY,
        positionZ: data.positionZ,
        heading: 0, // Facing north

        // Progression (empty)
        unlockedFeats: [],
        unlockedAbilities: [],
        activeLoadout: [],
        passiveLoadout: [],
        specialLoadout: [],

        // Cosmetics (stored in supernaturalData until a dedicated profile schema exists)
        supernaturalData: data.cosmetics ? ({ cosmetics: data.cosmetics } as any) : undefined,
      },
    });
  }

  /**
   * Update character name and cosmetics
   */
  static async updateCharacter(
    characterId: string,
    data: { name?: string; cosmetics?: Record<string, unknown> | null }
  ): Promise<Character> {
    const existing = await prisma.character.findUnique({
      where: { id: characterId },
      select: { supernaturalData: true },
    });

    let nextSupernaturalData: Record<string, unknown> | null | undefined = undefined;
    if (data.cosmetics !== undefined) {
      const base = (existing?.supernaturalData &&
        typeof existing.supernaturalData === 'object' &&
        !Array.isArray(existing.supernaturalData))
        ? (existing.supernaturalData as Record<string, unknown>)
        : {};

      if (data.cosmetics === null) {
        const { cosmetics, ...rest } = base;
        nextSupernaturalData = Object.keys(rest).length > 0 ? rest : null;
      } else {
        nextSupernaturalData = { ...base, cosmetics: data.cosmetics };
      }
    }

    return prisma.character.update({
      where: { id: characterId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(nextSupernaturalData !== undefined && { supernaturalData: nextSupernaturalData as Prisma.InputJsonObject }),
      },
    });
  }

  /**
   * Delete a character by ID
   */
  static async deleteCharacter(characterId: string): Promise<void> {
    await prisma.character.delete({
      where: { id: characterId },
    });
  }

  /**
   * Update character position
   */
  static async updatePosition(
    characterId: string,
    position: { x: number; y: number; z: number; heading?: number }
  ): Promise<void> {
    await prisma.character.update({
      where: { id: characterId },
      data: {
        positionX: position.x,
        positionY: position.y,
        positionZ: position.z,
        ...(position.heading !== undefined && { heading: position.heading }),
        lastSeenAt: new Date(),
      },
    });
  }

  /**
   * Update character resources (HP, stamina, mana)
   */
  static async updateResources(
    characterId: string,
    resources: {
      currentHp?: number;
      currentStamina?: number;
      currentMana?: number;
      isAlive?: boolean;
    }
  ): Promise<void> {
    await prisma.character.update({
      where: { id: characterId },
      data: resources,
    });
  }

  /**
   * Get all characters in a zone
   */
  static async findByZoneId(zoneId: string): Promise<Character[]> {
    return prisma.character.findMany({
      where: { zoneId },
    });
  }

  /**
   * Get equipped items for a character (hand slots).
   */
  static async findEquippedHandItems(characterId: string): Promise<Array<{
    id: string;
    equipSlot: string | null;
    template: { id: string; name: string; properties: unknown };
  }>> {
    return prisma.inventoryItem.findMany({
      where: {
        characterId,
        equipped: true,
        equipSlot: { in: ['right_hand', 'left_hand'] },
      },
      select: {
        id: true,
        equipSlot: true,
        template: {
          select: {
            id: true,
            name: true,
            properties: true,
          },
        },
      },
    });
  }

  /**
   * Get all equipped items for a character.
   */
  static async findEquippedItems(characterId: string): Promise<Array<{
    id: string;
    equipSlot: string | null;
    template: { id: string; name: string; properties: unknown };
  }>> {
    return prisma.inventoryItem.findMany({
      where: {
        characterId,
        equipped: true,
      },
      select: {
        id: true,
        equipSlot: true,
        template: {
          select: {
            id: true,
            name: true,
            properties: true,
          },
        },
      },
    });
  }

  /**
   * Update last seen timestamp
   */
  static async updateLastSeen(characterId: string): Promise<void> {
    await prisma.character.update({
      where: { id: characterId },
      data: { lastSeenAt: new Date() },
    });
  }
}
