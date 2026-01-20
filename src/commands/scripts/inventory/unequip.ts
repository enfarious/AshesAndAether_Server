/**
 * /unequip command - Unequip an item or slot
 */

import { prisma } from '@/database';
import type { CommandContext, CommandDefinition, CommandResult, ParsedCommand } from '@/commands/types';

export const unequipCommand: CommandDefinition = {
  name: 'unequip',
  aliases: ['remove', 'unwield'],
  description: 'Unequip an item or slot',
  category: 'inventory',
  usage: '/unequip <slot|item>',
  examples: [
    '/unequip right_hand',
    '/unequip "Rusty Sword"',
  ],
  parameters: {
    positional: [
      { type: 'string', required: true, description: 'Slot name or item name' },
    ],
  },

  handler: async (context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    if (context.inCombat) {
      return { success: false, error: 'You cannot change equipment during combat.' };
    }

    const target = args.positionalArgs[0]?.trim();
    if (!target) {
      return { success: false, error: 'You must specify a slot or item name. Use /unequip <slot|item>.' };
    }

    const slot = normalizeSlot(target);
    let equippedItem = null as Awaited<ReturnType<typeof prisma.inventoryItem.findFirst>> | null;

    equippedItem = await prisma.inventoryItem.findFirst({
      where: { characterId: context.characterId, equipped: true, equipSlot: slot },
      include: { template: true },
    });

    if (!equippedItem) {
      equippedItem = await prisma.inventoryItem.findFirst({
        where: {
          characterId: context.characterId,
          equipped: true,
          OR: [
            { id: target },
            { template: { name: { equals: target, mode: 'insensitive' } } },
          ],
        },
        include: { template: true },
      });
    }

    if (!equippedItem) {
      return { success: false, error: `No equipped item found for '${target}'.` };
    }

    await prisma.inventoryItem.update({
      where: { id: equippedItem.id },
      data: { equipped: false, equipSlot: null },
    });

    return {
      success: true,
      message: `Unequipped ${equippedItem.template.name}.`,
      events: [{ type: 'equipment_changed', data: { characterId: context.characterId } }],
    };
  },
};

function normalizeSlot(value: string): string | null {
  const lower = value.toLowerCase();
  if (lower === 'right' || lower === 'right_hand') return 'right_hand';
  if (lower === 'left' || lower === 'left_hand') return 'left_hand';
  return lower;
}
