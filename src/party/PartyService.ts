import { randomUUID } from 'crypto';
import type { RedisClientType } from 'redis';

export interface PartyInfo {
  partyId: string;
  leaderId: string;
  members: string[];
}

export interface PartyInvite {
  fromId: string;
  partyId: string;
  expiresAt: number;
}

const PARTY_PREFIX = 'party:';
const PARTY_MEMBER_PREFIX = 'party:member:';
const PARTY_INVITE_PREFIX = 'party:invite:';
const PARTY_INVITE_TTL_SECONDS = 300;

export class PartyService {
  constructor(private redis: RedisClientType) {}

  private getPartyKey(partyId: string) {
    return `${PARTY_PREFIX}${partyId}`;
  }

  private getMembersKey(partyId: string) {
    return `${PARTY_PREFIX}${partyId}:members`;
  }

  private getMemberKey(characterId: string) {
    return `${PARTY_MEMBER_PREFIX}${characterId}`;
  }

  private getInviteKey(characterId: string) {
    return `${PARTY_INVITE_PREFIX}${characterId}`;
  }

  async getPartyIdForMember(characterId: string): Promise<string | null> {
    return (await this.redis.get(this.getMemberKey(characterId))) || null;
  }

  async getPartyInfo(partyId: string): Promise<PartyInfo | null> {
    const leaderId = await this.redis.hGet(this.getPartyKey(partyId), 'leaderId');
    if (!leaderId) return null;
    const members = await this.redis.sMembers(this.getMembersKey(partyId));
    return { partyId, leaderId, members };
  }

  async ensurePartyForLeader(leaderId: string): Promise<PartyInfo> {
    const existing = await this.getPartyIdForMember(leaderId);
    if (existing) {
      const info = await this.getPartyInfo(existing);
      if (info) return info;
    }

    const partyId = randomUUID();
    await this.redis.hSet(this.getPartyKey(partyId), {
      leaderId,
      createdAt: Date.now().toString(),
    });
    await this.redis.sAdd(this.getMembersKey(partyId), leaderId);
    await this.redis.set(this.getMemberKey(leaderId), partyId);
    return {
      partyId,
      leaderId,
      members: [leaderId],
    };
  }

  async createInvite(fromId: string, targetId: string): Promise<PartyInvite> {
    const party = await this.ensurePartyForLeader(fromId);
    const invite: PartyInvite = {
      fromId,
      partyId: party.partyId,
      expiresAt: Date.now() + PARTY_INVITE_TTL_SECONDS * 1000,
    };
    await this.redis.setEx(this.getInviteKey(targetId), PARTY_INVITE_TTL_SECONDS, JSON.stringify(invite));
    return invite;
  }

  async getInvite(targetId: string): Promise<PartyInvite | null> {
    const raw = await this.redis.get(this.getInviteKey(targetId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PartyInvite;
    } catch {
      return null;
    }
  }

  async clearInvite(targetId: string): Promise<void> {
    await this.redis.del(this.getInviteKey(targetId));
  }

  async addMember(partyId: string, characterId: string): Promise<PartyInfo | null> {
    const info = await this.getPartyInfo(partyId);
    if (!info) return null;
    await this.redis.sAdd(this.getMembersKey(partyId), characterId);
    await this.redis.set(this.getMemberKey(characterId), partyId);
    return this.getPartyInfo(partyId);
  }

  async removeMember(partyId: string, characterId: string): Promise<PartyInfo | null> {
    await this.redis.sRem(this.getMembersKey(partyId), characterId);
    await this.redis.del(this.getMemberKey(characterId));
    const info = await this.getPartyInfo(partyId);
    if (!info) return null;
    if (info.members.length === 0) {
      await this.redis.del(this.getPartyKey(partyId));
      await this.redis.del(this.getMembersKey(partyId));
      return null;
    }
    return info;
  }

  async setLeader(partyId: string, leaderId: string): Promise<void> {
    await this.redis.hSet(this.getPartyKey(partyId), { leaderId });
  }

  async disband(partyId: string): Promise<void> {
    const members = await this.redis.sMembers(this.getMembersKey(partyId));
    for (const member of members) {
      await this.redis.del(this.getMemberKey(member));
    }
    await this.redis.del(this.getMembersKey(partyId));
    await this.redis.del(this.getPartyKey(partyId));
  }
}
