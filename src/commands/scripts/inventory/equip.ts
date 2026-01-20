/**
 * /equip command - Equip an item to a slot
 */

import { prisma } from '@/database';
import type { CommandContext, CommandDefinition, CommandResult, ParsedCommand } from '@/commands/types';

type ItemProperties = {
  equipSlots?: string[];
  weapon?: Record<string, unknown>;
};

export const equipCommand: CommandDefinition = {
  name: 'equip',
  aliases: ['wear', 'wield'],
  description: 'Equip an item to a slot',
  category: 'inventory',
  usage: '/equip "<item>" [slot]',
  examples: [
    '/equip "Rusty Sword"',
    '/equip "Rusty Sword" right_hand',
    '/equip "Buckler" left_hand',
  ],
  parameters: {
    positional: [
      { type: 'string', required: true, description: 'Item name (quote multi-word names)' },
      { type: 'string', required: false, description: 'Optional slot (right_hand, left_hand)' },
    ],
  },

  handler: async (context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    if (context.inCombat) {
      return { success: false, error: 'You cannot change equipment during combat.' };
    }

    const itemName = args.positionalArgs[0]?.trim();
    const slotArg = args.positionalArgs[1]?.trim();
    if (!itemName) {
      return { success: false, error: 'You must provide an item name. Use /equip "<item>" [slot].' };
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
      return { success: false, error: `Item '${itemName}' not found in your inventory.` };
    }

    const properties = inventoryItem.template.properties as ItemProperties | null;
    const equipSlots = Array.isArray(properties?.equipSlots) ? properties?.equipSlots : undefined;
    const isWeapon = Boolean(properties?.weapon) || inventoryItem.template.itemType === 'weapon';
    const slot = resolveEquipSlot(slotArg, equipSlots, isWeapon);

    if (!slot) {
      return { success: false, error: 'You must specify a valid slot for that item.' };
    }

    const existing = await prisma.inventoryItem.findFirst({
      where: {
        characterId: context.characterId,
        equipped: true,
        equipSlot: slot,
      },
      include: { template: true },
    });

    if (inventoryItem.equipped && inventoryItem.equipSlot === slot) {
      return { success: true, message: `${inventoryItem.template.name} is already equipped in ${slot}.` };
    }

    await prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.inventoryItem.update({
          where: { id: existing.id },
          data: { equipped: false, equipSlot: null },
        });
      }

      await tx.inventoryItem.update({
        where: { id: inventoryItem.id },
        data: { equipped: true, equipSlot: slot },
      });
    });

    const unequippedText = existing ? ` Unequipped ${existing.template.name}.` : '';
    return {
      success: true,
      message: `Equipped ${inventoryItem.template.name} in ${slot}.${unequippedText}`,
      events: [{ type: 'equipment_changed', data: { characterId: context.characterId } }],
    };
  },
};

function resolveEquipSlot(
  slotArg: string | undefined,
  equipSlots: string[] | undefined,
  isWeapon: boolean
): string | null {
  const normalized = slotArg ? normalizeSlot(slotArg) : null;
  if (normalized) {
    if (equipSlots && equipSlots.length > 0) {
      const matched = equipSlots.find(slot => normalizeSlot(slot) === normalized);
      return matched ? normalizeSlot(matched) : null;
    }
    if (isWeapon) {
      return isHandSlot(normalized) ? normalized : null;
    }
    return null;
  }

  if (equipSlots && equipSlots.length > 0) {
    const preferred = equipSlots.find(slot => normalizeSlot(slot) === 'right_hand') ?? equipSlots[0];
    return normalizeSlot(preferred);
  }

  if (isWeapon) {
    return 'right_hand';
  }

  return null;
}

function normalizeSlot(value: string): string | null {
  const lower = value.toLowerCase();
  if (lower === 'right' || lower === 'right_hand') return 'right_hand';
  if (lower === 'left' || lower === 'left_hand') return 'left_hand';
  return lower;
}

function isHandSlot(value: string): boolean {
  return value === 'right_hand' || value === 'left_hand';
}
