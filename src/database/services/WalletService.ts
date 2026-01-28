import { prisma } from '../DatabaseService';
import { logger } from '@/utils/logger';
import type { CharacterWallet } from '@prisma/client';

export interface WalletTransferResult {
  success: boolean;
  fromBalance?: number;
  toBalance?: number;
  error?: string;
}

export interface WalletUpdateResult {
  success: boolean;
  previousBalance: number;
  newBalance: number;
  delta: number;
}

export class WalletService {
  /**
   * Get or create a wallet for a character
   */
  static async getOrCreateWallet(characterId: string): Promise<CharacterWallet> {
    const existing = await prisma.characterWallet.findUnique({
      where: { characterId },
    });

    if (existing) {
      return existing;
    }

    return prisma.characterWallet.create({
      data: { characterId, gold: 0 },
    });
  }

  /**
   * Get wallet balance (returns 0 if wallet doesn't exist)
   */
  static async getBalance(characterId: string): Promise<number> {
    const wallet = await prisma.characterWallet.findUnique({
      where: { characterId },
      select: { gold: true },
    });

    return wallet?.gold ?? 0;
  }

  /**
   * Add currency to a character's wallet
   * Creates wallet if it doesn't exist
   */
  static async addGold(
    characterId: string,
    amount: number,
    reason: string
  ): Promise<WalletUpdateResult> {
    if (amount < 0) {
      throw new Error('Cannot add negative amount. Use removeGold instead.');
    }

    const wallet = await WalletService.getOrCreateWallet(characterId);
    const previousBalance = wallet.gold;

    const updated = await prisma.characterWallet.update({
      where: { characterId },
      data: { gold: { increment: amount } },
    });

    logger.info(
      { characterId, amount, previousBalance, newBalance: updated.gold, reason },
      'Gold added to wallet'
    );

    return {
      success: true,
      previousBalance,
      newBalance: updated.gold,
      delta: amount,
    };
  }

  /**
   * Remove currency from a character's wallet
   * Returns false if insufficient funds
   */
  static async removeGold(
    characterId: string,
    amount: number,
    reason: string
  ): Promise<WalletUpdateResult & { insufficientFunds?: boolean }> {
    if (amount < 0) {
      throw new Error('Cannot remove negative amount. Use addGold instead.');
    }

    const wallet = await prisma.characterWallet.findUnique({
      where: { characterId },
      select: { gold: true },
    });

    const previousBalance = wallet?.gold ?? 0;

    if (previousBalance < amount) {
      logger.warn(
        { characterId, amount, balance: previousBalance, reason },
        'Insufficient funds for withdrawal'
      );
      return {
        success: false,
        previousBalance,
        newBalance: previousBalance,
        delta: 0,
        insufficientFunds: true,
      };
    }

    const updated = await prisma.characterWallet.update({
      where: { characterId },
      data: { gold: { decrement: amount } },
    });

    logger.info(
      { characterId, amount, previousBalance, newBalance: updated.gold, reason },
      'Gold removed from wallet'
    );

    return {
      success: true,
      previousBalance,
      newBalance: updated.gold,
      delta: -amount,
    };
  }

  /**
   * Transfer gold between two characters atomically
   */
  static async transfer(
    fromCharacterId: string,
    toCharacterId: string,
    amount: number,
    reason: string
  ): Promise<WalletTransferResult> {
    if (amount <= 0) {
      return { success: false, error: 'Transfer amount must be positive' };
    }

    if (fromCharacterId === toCharacterId) {
      return { success: false, error: 'Cannot transfer to self' };
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        // Get sender's wallet
        const fromWallet = await tx.characterWallet.findUnique({
          where: { characterId: fromCharacterId },
        });

        if (!fromWallet || fromWallet.gold < amount) {
          throw new Error('INSUFFICIENT_FUNDS');
        }

        // Ensure recipient wallet exists
        await tx.characterWallet.upsert({
          where: { characterId: toCharacterId },
          create: { characterId: toCharacterId, gold: 0 },
          update: {},
        });

        // Deduct from sender
        const updatedFrom = await tx.characterWallet.update({
          where: { characterId: fromCharacterId },
          data: { gold: { decrement: amount } },
        });

        // Add to recipient
        const updatedTo = await tx.characterWallet.update({
          where: { characterId: toCharacterId },
          data: { gold: { increment: amount } },
        });

        return {
          fromBalance: updatedFrom.gold,
          toBalance: updatedTo.gold,
        };
      });

      logger.info(
        { fromCharacterId, toCharacterId, amount, reason },
        'Gold transferred between characters'
      );

      return {
        success: true,
        fromBalance: result.fromBalance,
        toBalance: result.toBalance,
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'INSUFFICIENT_FUNDS') {
        return { success: false, error: 'Insufficient funds' };
      }
      logger.error({ error, fromCharacterId, toCharacterId, amount }, 'Transfer failed');
      return { success: false, error: 'Transfer failed' };
    }
  }

  /**
   * Check if character has sufficient funds
   */
  static async hasSufficientFunds(characterId: string, amount: number): Promise<boolean> {
    const balance = await WalletService.getBalance(characterId);
    return balance >= amount;
  }

  /**
   * Set wallet balance directly (admin use, testing)
   */
  static async setBalance(characterId: string, amount: number): Promise<CharacterWallet> {
    if (amount < 0) {
      throw new Error('Balance cannot be negative');
    }

    return prisma.characterWallet.upsert({
      where: { characterId },
      create: { characterId, gold: amount },
      update: { gold: amount },
    });
  }
}
