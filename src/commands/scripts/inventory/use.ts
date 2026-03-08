/**
 * /use command - Use an item (consumable or interactable)
 */

import { prisma } from '@/database';
import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

type ItemEffect =
  | { type: 'heal'; amount: number }
  | { type: 'stamina'; amount: number }
  | { type: 'mana'; amount: number };

// ── Potion cooldown tracking ───────────────────────────────────────────────
// Key: "characterId:consumableType" → timestamp of last use (ms)
const potionCooldowns = new Map<string, number>();
const DEFAULT_POTION_COOLDOWN_S = 15;

export const useCommand: CommandDefinition = {
  name: 'use',
  aliases: ['item'],
  description: 'Use an item, optionally targeting an entity',
  category: 'inventory',
  usage: '/use "<item>" [target]',
  examples: [
    '/use "Health Potion"',
    '/item lockpick door.1',
  ],

  parameters: {
    positional: [
      {
        type: 'string',
        required: true,
        description: 'Item name (quote multi-word names)',
      },
      {
        type: 'string',
        required: false,
        description: 'Optional target name or ID',
      },
    ],
  },

  handler: async (context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    const itemName = args.positionalArgs[0]?.trim();
    const target = args.positionalArgs.slice(1).join(' ').trim();

    if (!itemName) {
      return {
        success: false,
        error: 'You must provide an item name. Use /use "<item>" [target].',
      };
    }

    if (target && target.toLowerCase() !== 'self') {
      return {
        success: false,
        error: 'Targeted item use is not implemented yet.',
      };
    }

    const inventoryItem = await prisma.inventoryItem.findFirst({
      where: {
        characterId: context.characterId,
        OR: [
          { id: itemName },
          { template: { name: { equals: itemName, mode: 'insensitive' } } },
        ],
      },
      include: { template: true },
    });

    if (!inventoryItem) {
      return {
        success: false,
        error: `Item '${itemName}' not found in your inventory.`,
      };
    }

    if (inventoryItem.quantity <= 0) {
      return {
        success: false,
        error: `Item '${inventoryItem.template.name}' has no remaining charges.`,
      };
    }

    const properties = inventoryItem.template.properties as {
      effect?: ItemEffect;
      consumableType?: string;
      cooldown?: number;
    } | null;
    const effect = properties?.effect;
    if (!effect || typeof effect.amount !== 'number' || effect.amount <= 0) {
      return {
        success: false,
        error: `Item '${inventoryItem.template.name}' cannot be used yet.`,
      };
    }

    // ── Cooldown check ───────────────────────────────────────────────────
    const consumableType = properties?.consumableType ?? inventoryItem.template.itemType;
    const cooldownSeconds = properties?.cooldown ?? DEFAULT_POTION_COOLDOWN_S;
    const cdKey = `${context.characterId}:${consumableType}`;
    const lastUsed = potionCooldowns.get(cdKey);
    if (lastUsed !== undefined) {
      const elapsedMs = Date.now() - lastUsed;
      const cooldownMs = cooldownSeconds * 1000;
      if (elapsedMs < cooldownMs) {
        const remainingS = Math.ceil((cooldownMs - elapsedMs) / 1000);
        return {
          success: false,
          error: `${inventoryItem.template.name} is on cooldown (${remainingS}s remaining).`,
        };
      }
    }

    const character = await prisma.character.findUnique({
      where: { id: context.characterId },
    });

    if (!character) {
      return {
        success: false,
        error: 'Character not found.',
      };
    }

    let updatedValue = 0;
    let resourceLabel = '';
    let newValues: { currentHp?: number; currentStamina?: number; currentMana?: number } = {};

    if (effect.type === 'heal') {
      if (character.currentHp >= character.maxHp) {
        return { success: false, error: 'You are already at full health.' };
      }
      updatedValue = Math.min(character.maxHp, character.currentHp + effect.amount);
      newValues = { currentHp: updatedValue };
      resourceLabel = 'health';
    } else if (effect.type === 'stamina') {
      if (character.currentStamina >= character.maxStamina) {
        return { success: false, error: 'You are already at full stamina.' };
      }
      updatedValue = Math.min(character.maxStamina, character.currentStamina + effect.amount);
      newValues = { currentStamina: updatedValue };
      resourceLabel = 'stamina';
    } else if (effect.type === 'mana') {
      if (character.currentMana >= character.maxMana) {
        return { success: false, error: 'You are already at full mana.' };
      }
      updatedValue = Math.min(character.maxMana, character.currentMana + effect.amount);
      newValues = { currentMana: updatedValue };
      resourceLabel = 'mana';
    } else {
      return {
        success: false,
        error: `Item '${inventoryItem.template.name}' has an unknown effect.`,
      };
    }

    await prisma.$transaction(async (tx) => {
      await tx.character.update({
        where: { id: context.characterId },
        data: newValues,
      });

      if (inventoryItem.quantity > 1) {
        await tx.inventoryItem.update({
          where: { id: inventoryItem.id },
          data: { quantity: inventoryItem.quantity - 1 },
        });
      } else {
        await tx.inventoryItem.delete({
          where: { id: inventoryItem.id },
        });
      }
    });

    // Record cooldown timestamp after successful use
    potionCooldowns.set(cdKey, Date.now());

    return {
      success: true,
      message: `Used ${inventoryItem.template.name}. ${resourceLabel} is now ${updatedValue}.`,
      data: {
        itemId: inventoryItem.id,
        itemName: inventoryItem.template.name,
        quantityRemaining: Math.max(0, inventoryItem.quantity - 1),
        resource: resourceLabel,
        value: updatedValue,
      },
      events: [{
        type: 'use_item',
        data: {
          characterId: context.characterId,
          resource: resourceLabel,
          value: updatedValue,
          maxHp: character.maxHp,
          maxStamina: character.maxStamina,
          maxMana: character.maxMana,
        },
      }],
    };
  },
};
