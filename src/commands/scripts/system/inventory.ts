/**
 * /inventory command - Show character inventory
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

export const inventoryCommand: CommandDefinition = {
  name: 'inventory',
  aliases: ['inv', 'i'],
  description: 'Show your inventory',
  category: 'inventory',
  usage: '/inventory',
  examples: ['/inventory', '/inv'],

  handler: async (context: CommandContext, _args: ParsedCommand): Promise<CommandResult> => {
    // Request inventory from database
    return {
      success: true,
      events: [
        {
          type: 'inventory_request',
          data: {
            characterId: context.characterId,
          },
        },
      ],
    };
  },
};
