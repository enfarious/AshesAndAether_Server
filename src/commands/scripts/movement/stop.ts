/**
 * /stop command - Stop moving (does not affect combat/auto-attack)
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

export const stopCommand: CommandDefinition = {
  name: 'stop',
  aliases: ['halt'],
  description: 'Stop moving',
  category: 'movement',
  usage: '/stop',
  examples: ['/stop'],

  handler: async (context: CommandContext, _args: ParsedCommand): Promise<CommandResult> => {
    return {
      success: true,
      message: 'You stop moving.',
      events: [
        {
          type: 'movement_stop',
          data: {
            characterId: context.characterId,
            position: context.position,
            zoneId: context.zoneId,
          },
        },
      ],
    };
  },
};
