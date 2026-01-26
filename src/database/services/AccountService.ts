import { prisma } from '../DatabaseService';
import type { Account, Character } from '@prisma/client';
import bcrypt from 'bcryptjs';

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
        passwordHash: `guest-${timestamp}-dev`,
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

  /**
   * Create an account with username and password
   */
  static async createWithPassword(
    username: string,
    password: string,
    email?: string
  ): Promise<Account> {
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Generate email from username if not provided
    const accountEmail = email || `${username.toLowerCase()}@player.ashesandaether.com`;

    return prisma.account.create({
      data: {
        username,
        email: accountEmail,
        passwordHash,
      },
    });
  }

  /**
   * Verify password against account's stored hash
   */
  static async verifyPassword(account: Account, password: string): Promise<boolean> {
    // Guest accounts have non-bcrypt hashes, always fail verification
    if (account.passwordHash.startsWith('guest-')) {
      return false;
    }
    return bcrypt.compare(password, account.passwordHash);
  }

  /**
   * Check if username is available
   */
  static async isUsernameAvailable(username: string): Promise<boolean> {
    const existing = await prisma.account.findUnique({
      where: { username },
    });
    return existing === null;
  }

  /**
   * Delete an account by ID
   * Characters, inventory, quest progress, faction reputation, and corruption events
   * are automatically cascade-deleted by the database.
   */
  static async deleteAccount(accountId: string): Promise<void> {
    await prisma.account.delete({
      where: { id: accountId },
    });
  }
}
