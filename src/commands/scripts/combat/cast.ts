/**
 * /cast command - Cast a named ability on a target
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

export const castCommand: CommandDefinition = {
  name: 'cast',
  aliases: ['ability', 'magic'],
  description: 'Cast a named ability on a target',
  category: 'combat',
  usage: '/cast "<ability>" <target>',
  examples: [
    '/cast "Basic Attack" Old Merchant',
    '/cast "shadow bolt" bandit.1',
  ],

  parameters: {
    positional: [
      {
        type: 'string',
        required: true,
        description: 'Ability name (quote multi-word names)',
      },
      {
        type: 'string',
        required: true,
        description: 'Target name or ID',
      },
    ],
  },

  handler: async (_context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    const abilityName = args.positionalArgs[0]?.trim();
    const target = args.positionalArgs.slice(1).join(' ').trim();

    if (!abilityName) {
      return {
        success: false,
        error: 'You must provide an ability name. Use /cast "<ability>" <target>.',
      };
    }

    if (!target) {
      return {
        success: false,
        error: 'You must provide a target.',
      };
    }

    return {
      success: true,
      events: [
        {
          type: 'combat_action',
          data: {
            abilityName,
            target,
          },
        },
      ],
    };
  },
};
