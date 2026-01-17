import { prisma } from '../DatabaseService';
import type { Account, Character } from '@prisma/client';

export class AccountService {
  /**
   * Find account by email
   */
  static async findByEmail(email: string): Promise<Account | null> {
    return prisma.account.findUnique({
      where: { email },
    });
  }

  /**
   * Find account by username
   */
  static async findByUsername(username: string): Promise<Account | null> {
    return prisma.account.findUnique({
      where: { username },
    });
  }

  /**
   * Find account by Replit ID
   */
  static async findByReplitId(replitId: string): Promise<Account | null> {
    return prisma.account.findUnique({
      where: { replitId },
    });
  }

  /**
   * Find account by ID with characters
   */
  static async findByIdWithCharacters(accountId: string): Promise<(Account & { characters: Character[] }) | null> {
    return prisma.account.findUnique({
      where: { id: accountId },
      include: { characters: true },
    });
  }

  /**
   * Create a guest account
   */
  static async createGuestAccount(guestName: string): Promise<Account> {
    const timestamp = Date.now();
    const uniqueUsername = guestName ? `${guestName}-${timestamp}` : `Guest${timestamp}`;

    return prisma.account.create({
      data: {
        email: `guest-${timestamp}@temp.worldofdarkness.com`,
        username: uniqueUsername,
        passwordHash: null,
      },
    });
  }

  /**
   * Update last login time
   */
  static async updateLastLogin(accountId: string): Promise<void> {
    await prisma.account.update({
      where: { id: accountId },
      data: { lastLoginAt: new Date() },
    });
  }
}
