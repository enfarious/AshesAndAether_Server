/**
 * /stats command - Show character stats
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

export const statsCommand: CommandDefinition = {
  name: 'stats',
  aliases: ['attributes'],
  description: 'Show your character statistics',
  category: 'character',
  usage: '/stats',
  examples: ['/stats'],

  handler: async (context: CommandContext, _args: ParsedCommand): Promise<CommandResult> => {
    // Request character stats from database
    return {
      success: true,
      events: [
        {
          type: 'stats_request',
          data: {
            characterId: context.characterId,
          },
        },
      ],
    };
  },
};
