import { prisma } from '../DatabaseService';
import { StatCalculator, STAT_POINTS_PER_LEVEL } from '@/game/stats/StatCalculator';
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
        statPoints: 0,

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

        // Progression — all T1 abilities unlocked and slotted for testing
        unlockedFeats: [],
        unlockedAbilities: {
          activeNodes: [
            'active_tank_t1', 'active_phys_t1', 'active_control_t1',
            'active_magic_t1', 'active_healer_t1', 'active_support_t1',
          ],
          passiveNodes: [
            'passive_tank_t1', 'passive_phys_t1', 'passive_control_t1',
            'passive_magic_t1', 'passive_healer_t1', 'passive_support_t1',
          ],
          apSpent: 12, // 6 active + 6 passive, 1 AP each
        },
        activeLoadout: {
          slots: [
            'active_tank_t1', 'active_phys_t1', 'active_control_t1',
            'active_magic_t1', 'active_healer_t1', 'active_support_t1',
            null, null,
          ],
        },
        passiveLoadout: {
          slots: [
            'passive_tank_t1', 'passive_phys_t1', 'passive_control_t1',
            'passive_magic_t1', 'passive_healer_t1', 'passive_support_t1',
            null, null,
          ],
        },
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
    // Cascade handles PlayerVillage + VillageStructure, but the Zone
    // record created for the village instance needs explicit cleanup.
    const villageZoneId = `village:${characterId}`;
    await prisma.zone.deleteMany({ where: { id: villageZoneId } });

    await prisma.character.delete({
      where: { id: characterId },
    });
  }

  /**
   * Update character position (both current and last position for respawn recovery)
   */
  static async updatePosition(
    characterId: string,
    position: { x: number; y: number; z: number; heading?: number; saveLastPosition?: boolean }
  ): Promise<void> {
    const result = await prisma.character.updateMany({
      where: { id: characterId },
      data: {
        positionX: position.x,
        positionY: position.y,
        positionZ: position.z,
        ...(position.heading !== undefined && { heading: position.heading }),
        // Save lastPosition fields if saveLastPosition flag is true (for respawn recovery)
        ...(position.saveLastPosition && {
          lastPositionX: position.x,
          lastPositionY: position.y,
          lastPositionZ: position.z,
        }),
        lastSeenAt: new Date(),
      },
    });

    // Ignore missing records (e.g., ephemeral guest character already deleted)
    if (result.count === 0) {
      return;
    }
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
    template: {
      id: string;
      name: string;
      properties: unknown;
      tags: Array<{ tag: { name: string } }>;
    };
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
            tags: {
              select: {
                tag: { select: { name: true } },
              },
            },
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
   * Award XP to a character, levelling up as needed.
   *
   * @param characterId  DB id of the character
   * @param xpAmount     Raw XP to award (already scaled by the caller)
   * @returns Updated totals + how many levels were gained
   */
  static async awardXp(
    characterId: string,
    xpAmount: number,
  ): Promise<{
    newExperience: number;
    newLevel: number;
    levelsGained: number;
    abilityPoints: number;
    statPoints: number;
  }> {
    const char = await prisma.character.findUnique({
      where: { id: characterId },
      select: { level: true, experience: true, abilityPoints: true, statPoints: true },
    });
    if (!char) throw new Error(`Character not found: ${characterId}`);

    const MAX_LEVEL   = 30;
    const XP_PER_LEVEL = 1000;

    const prevLevel   = char.level;
    const newExp      = char.experience + xpAmount;
    // Level = floor(totalXP / 1000) + 1, but never exceed cap
    const rawLevel    = Math.floor(newExp / XP_PER_LEVEL) + 1;
    const newLevel    = Math.min(MAX_LEVEL, rawLevel);
    const levelsGained = Math.max(0, newLevel - prevLevel);
    const newAP       = char.abilityPoints + levelsGained;
    const newSP       = (char.statPoints ?? 0) + levelsGained * STAT_POINTS_PER_LEVEL;

    await prisma.character.update({
      where: { id: characterId },
      data: { experience: newExp, level: newLevel, abilityPoints: newAP, statPoints: newSP },
    });

    return { newExperience: newExp, newLevel, levelsGained, abilityPoints: newAP, statPoints: newSP };
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
