/**
 * GuildService — Static class for guild CRUD, membership, and validation.
 * Follows the CharacterService / WalletService pattern.
 */

import { prisma } from '../database/DatabaseService';
import { WalletService } from '../database/services/WalletService';
import type { Guild, GuildMembership } from '@prisma/client';

// ── Result Types ──

export interface GuildCreateResult {
  success: boolean;
  guild?: Guild;
  error?: string;
}

export interface GuildMemberResult {
  success: boolean;
  membership?: GuildMembership;
  error?: string;
}

export interface GuildInfoResult {
  guild: Guild;
  members: Array<{
    characterId: string;
    characterName: string;
    joinedAt: Date;
    isGuildmaster: boolean;
  }>;
  beaconCount: number;
  maxBeacons: number;
}

// ── Service ──

export class GuildService {
  // ── Constants ──
  static readonly FOUNDING_COST = 1000;
  static readonly FOUNDING_MEMBERS = 3;
  static readonly NAME_MAX_LENGTH = 48;
  static readonly TAG_MIN_LENGTH = 3;
  static readonly TAG_MAX_LENGTH = 5;
  static readonly DESCRIPTION_MAX_LENGTH = 500;
  static readonly MOTTO_MAX_LENGTH = 120;
  static readonly CHARTER_MAX_LENGTH = 2000;

  // ── Lookup ──

  static async findById(guildId: string): Promise<Guild | null> {
    return prisma.guild.findUnique({ where: { id: guildId } });
  }

  static async findByTag(tag: string): Promise<Guild | null> {
    return prisma.guild.findUnique({ where: { tag: tag.toUpperCase() } });
  }

  static async findByName(name: string): Promise<Guild | null> {
    return prisma.guild.findUnique({ where: { name } });
  }

  static async findByCharacterId(characterId: string): Promise<Guild | null> {
    const membership = await prisma.guildMembership.findUnique({
      where: { characterId },
      include: { guild: true },
    });
    return membership?.guild ?? null;
  }

  static async getMembership(characterId: string): Promise<GuildMembership | null> {
    return prisma.guildMembership.findUnique({ where: { characterId } });
  }

  static async getGuildInfo(guildId: string): Promise<GuildInfoResult | null> {
    const guild = await prisma.guild.findUnique({
      where: { id: guildId },
      include: {
        members: {
          include: { character: { select: { id: true, name: true } } },
        },
        beacons: { where: { isLit: true } },
      },
    });
    if (!guild) return null;

    return {
      guild,
      members: guild.members.map((m) => ({
        characterId: m.characterId,
        characterName: m.character.name,
        joinedAt: m.joinedAt,
        isGuildmaster: m.characterId === guild.guildmasterId,
      })),
      beaconCount: guild.beacons.length,
      maxBeacons: GuildService.getMaxBeacons(guild.memberCount),
    };
  }

  static async getMembers(
    guildId: string,
  ): Promise<
    Array<{
      characterId: string;
      characterName: string;
      joinedAt: Date;
      isGuildmaster: boolean;
    }>
  > {
    const guild = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { guildmasterId: true },
    });
    if (!guild) return [];

    const memberships = await prisma.guildMembership.findMany({
      where: { guildId },
      include: { character: { select: { id: true, name: true } } },
      orderBy: { joinedAt: 'asc' },
    });

    return memberships.map((m) => ({
      characterId: m.characterId,
      characterName: m.character.name,
      joinedAt: m.joinedAt,
      isGuildmaster: m.characterId === guild.guildmasterId,
    }));
  }

  // ── Validation ──

  static validateName(name: string): { valid: boolean; error?: string } {
    const trimmed = name.trim();
    if (trimmed.length === 0) return { valid: false, error: 'Guild name cannot be empty.' };
    if (trimmed.length > GuildService.NAME_MAX_LENGTH) {
      return { valid: false, error: `Guild name cannot exceed ${GuildService.NAME_MAX_LENGTH} characters.` };
    }
    if (!/^[a-zA-Z0-9 '-]+$/.test(trimmed)) {
      return { valid: false, error: "Guild name can only contain letters, numbers, spaces, hyphens, and apostrophes." };
    }
    return { valid: true };
  }

  static validateTag(tag: string): { valid: boolean; error?: string } {
    const upper = tag.toUpperCase().trim();
    if (upper.length < GuildService.TAG_MIN_LENGTH || upper.length > GuildService.TAG_MAX_LENGTH) {
      return { valid: false, error: `Guild tag must be ${GuildService.TAG_MIN_LENGTH}-${GuildService.TAG_MAX_LENGTH} characters.` };
    }
    if (!/^[A-Z0-9]+$/.test(upper)) {
      return { valid: false, error: 'Guild tag can only contain letters and numbers.' };
    }
    return { valid: true };
  }

  static async isNameAvailable(name: string): Promise<boolean> {
    const existing = await prisma.guild.findUnique({
      where: { name: name.trim() },
      select: { id: true },
    });
    return !existing;
  }

  static async isTagAvailable(tag: string): Promise<boolean> {
    const existing = await prisma.guild.findUnique({
      where: { tag: tag.toUpperCase().trim() },
      select: { id: true },
    });
    return !existing;
  }

  // ── Creation ──

  /**
   * Create a guild with founding members.
   * Transaction: validate all members are unguilded, deduct gold (split evenly), create guild + memberships.
   */
  static async createGuild(data: {
    name: string;
    tag: string;
    founderId: string;
    coFounderIds: string[];
  }): Promise<GuildCreateResult> {
    const { name, tag, founderId, coFounderIds } = data;
    const allFounderIds = [founderId, ...coFounderIds];

    // Validate counts
    if (allFounderIds.length !== GuildService.FOUNDING_MEMBERS) {
      return { success: false, error: `Exactly ${GuildService.FOUNDING_MEMBERS} founding members are required.` };
    }

    // Validate name and tag
    const nameCheck = GuildService.validateName(name);
    if (!nameCheck.valid) return { success: false, error: nameCheck.error };

    const tagCheck = GuildService.validateTag(tag);
    if (!tagCheck.valid) return { success: false, error: tagCheck.error };

    const trimmedName = name.trim();
    const upperTag = tag.toUpperCase().trim();

    // Check availability
    if (!(await GuildService.isNameAvailable(trimmedName))) {
      return { success: false, error: `Guild name "${trimmedName}" is already taken.` };
    }
    if (!(await GuildService.isTagAvailable(upperTag))) {
      return { success: false, error: `Guild tag [${upperTag}] is already taken.` };
    }

    // Transaction: validate unguilded, check gold, deduct, create
    try {
      const guild = await prisma.$transaction(async (tx) => {
        // Check all founders are unguilded
        for (const charId of allFounderIds) {
          const existing = await tx.guildMembership.findUnique({ where: { characterId: charId } });
          if (existing) {
            throw new Error(`A founding member is already in a guild.`);
          }
        }

        // Check gold — split evenly (floor), founder pays remainder
        const costPerMember = Math.floor(GuildService.FOUNDING_COST / allFounderIds.length);
        const founderExtra = GuildService.FOUNDING_COST - costPerMember * allFounderIds.length;

        for (const charId of allFounderIds) {
          const cost = charId === founderId ? costPerMember + founderExtra : costPerMember;
          const hasFunds = await WalletService.hasSufficientFunds(charId, cost);
          if (!hasFunds) {
            throw new Error(`A founding member does not have enough gold (${cost}g required).`);
          }
        }

        // Deduct gold
        for (const charId of allFounderIds) {
          const cost = charId === founderId ? costPerMember + founderExtra : costPerMember;
          await WalletService.removeGold(charId, cost, 'guild_founding');
        }

        // Create guild
        const charter = `Founded by the will of ${allFounderIds.length} on this day. Name: ${trimmedName}. Tag: [${upperTag}].`;
        const newGuild = await tx.guild.create({
          data: {
            name: trimmedName,
            tag: upperTag,
            charter,
            guildmasterId: founderId,
            memberCount: allFounderIds.length,
          },
        });

        // Create memberships
        for (const charId of allFounderIds) {
          await tx.guildMembership.create({
            data: { guildId: newGuild.id, characterId: charId },
          });
        }

        return newGuild;
      });

      return { success: true, guild };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to create guild.' };
    }
  }

  // ── Membership ──

  static async addMember(guildId: string, characterId: string): Promise<GuildMemberResult> {
    // Check character isn't already in a guild
    const existing = await prisma.guildMembership.findUnique({ where: { characterId } });
    if (existing) {
      return { success: false, error: 'Character is already in a guild.' };
    }

    // Check guild exists and isn't disbanded
    const guild = await prisma.guild.findUnique({ where: { id: guildId } });
    if (!guild || guild.disbandedAt) {
      return { success: false, error: 'Guild not found or has been disbanded.' };
    }

    try {
      const [membership] = await prisma.$transaction([
        prisma.guildMembership.create({
          data: { guildId, characterId },
        }),
        prisma.guild.update({
          where: { id: guildId },
          data: { memberCount: { increment: 1 } },
        }),
      ]);

      return { success: true, membership };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to add member.' };
    }
  }

  static async removeMember(
    guildId: string,
    characterId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const membership = await prisma.guildMembership.findFirst({
      where: { guildId, characterId },
    });
    if (!membership) {
      return { success: false, error: 'Character is not a member of this guild.' };
    }

    // Can't remove the guildmaster — they must transfer GM first or disband
    const guild = await prisma.guild.findUnique({ where: { id: guildId } });
    if (guild?.guildmasterId === characterId) {
      return { success: false, error: 'The Guildmaster cannot leave. Transfer leadership first or disband the guild.' };
    }

    await prisma.$transaction([
      prisma.guildMembership.delete({ where: { id: membership.id } }),
      prisma.guild.update({
        where: { id: guildId },
        data: { memberCount: { decrement: 1 } },
      }),
    ]);

    return { success: true };
  }

  static async getMemberCount(guildId: string): Promise<number> {
    return prisma.guildMembership.count({ where: { guildId } });
  }

  // ── Guildmaster ──

  static async transferGuildmaster(
    guildId: string,
    fromId: string,
    toId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const guild = await prisma.guild.findUnique({ where: { id: guildId } });
    if (!guild) return { success: false, error: 'Guild not found.' };
    if (guild.guildmasterId !== fromId) {
      return { success: false, error: 'Only the Guildmaster can transfer leadership.' };
    }

    // Verify target is a member
    const targetMembership = await prisma.guildMembership.findFirst({
      where: { guildId, characterId: toId },
    });
    if (!targetMembership) {
      return { success: false, error: 'Target is not a member of this guild.' };
    }

    await prisma.guild.update({
      where: { id: guildId },
      data: { guildmasterId: toId },
    });

    return { success: true };
  }

  static async isGuildmaster(guildId: string, characterId: string): Promise<boolean> {
    const guild = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { guildmasterId: true },
    });
    return guild?.guildmasterId === characterId;
  }

  // ── Guild Modification ──

  static async updateDescription(
    guildId: string,
    description: string,
  ): Promise<{ success: boolean; error?: string }> {
    const trimmed = description.trim();
    if (trimmed.length > GuildService.DESCRIPTION_MAX_LENGTH) {
      return { success: false, error: `Description cannot exceed ${GuildService.DESCRIPTION_MAX_LENGTH} characters.` };
    }
    await prisma.guild.update({ where: { id: guildId }, data: { description: trimmed } });
    return { success: true };
  }

  static async updateMotto(
    guildId: string,
    motto: string,
  ): Promise<{ success: boolean; error?: string }> {
    const trimmed = motto.trim();
    if (trimmed.length > GuildService.MOTTO_MAX_LENGTH) {
      return { success: false, error: `Motto cannot exceed ${GuildService.MOTTO_MAX_LENGTH} characters.` };
    }
    await prisma.guild.update({ where: { id: guildId }, data: { motto: trimmed } });
    return { success: true };
  }

  // ── Dissolution ──

  /**
   * Disband a guild. GM only. Marks disbandedAt, removes all memberships,
   * extinguishes all beacons, deactivates polygons.
   */
  static async disbandGuild(
    guildId: string,
    guildmasterId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const guild = await prisma.guild.findUnique({ where: { id: guildId } });
    if (!guild) return { success: false, error: 'Guild not found.' };
    if (guild.guildmasterId !== guildmasterId) {
      return { success: false, error: 'Only the Guildmaster can disband the guild.' };
    }
    if (guild.disbandedAt) {
      return { success: false, error: 'Guild has already been disbanded.' };
    }

    await prisma.$transaction([
      // Mark guild as disbanded
      prisma.guild.update({
        where: { id: guildId },
        data: { disbandedAt: new Date(), memberCount: 0 },
      }),
      // Remove all memberships
      prisma.guildMembership.deleteMany({ where: { guildId } }),
      // Extinguish all beacons
      prisma.guildBeacon.updateMany({
        where: { guildId },
        data: { isLit: false, darkAt: new Date() },
      }),
      // Deactivate all polygons
      prisma.guildPolygon.updateMany({
        where: { guildId },
        data: { isActive: false },
      }),
    ]);

    return { success: true };
  }

  // ── Beacon Allotment ──

  /**
   * Returns the maximum number of beacons a guild can claim based on member count.
   * 1-50 → 1, 51-150 → 2, 151-300 → 3, 301-500 → 4, 500+ → 5
   */
  static getMaxBeacons(memberCount: number): number {
    if (memberCount <= 50) return 1;
    if (memberCount <= 150) return 2;
    if (memberCount <= 300) return 3;
    if (memberCount <= 500) return 4;
    return 5;
  }
}
