/**
 * /use command - Use an item (consumable or interactable)
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

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

  handler: async (_context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    const itemName = args.positionalArgs[0]?.trim();
    const target = args.positionalArgs.slice(1).join(' ').trim();

    if (!itemName) {
      return {
        success: false,
        error: 'You must provide an item name. Use /use "<item>" [target].',
      };
    }

    return {
      success: true,
      message: target
        ? `Using ${itemName} on ${target}...`
        : `Using ${itemName}...`,
      events: [
        {
          type: 'item_use',
          data: {
            itemName,
            target: target || undefined,
          },
        },
      ],
    };
  },
};
