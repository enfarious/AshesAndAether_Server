/**
 * /attack command - Basic attack (auto-attack starter)
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

export const attackCommand: CommandDefinition = {
  name: 'attack',
  aliases: ['atk'],
  description: 'Attack a target using basic attack (defaults to current target)',
  category: 'combat',
  usage: '/attack [target]',
  examples: [
    '/attack Old Merchant',
    '/atk bandit.1',
    '/attack',          // defaults to current target (<t>)
    '/attack <bt>',     // battle target
  ],

  parameters: {
    positional: [
      {
        type: 'string',
        required: false,
        description: 'Target name, ID, or token (<t>, <ft>, <bt>, <tt>, <me>). Defaults to <t>.',
      },
    ],
  },

  handler: async (_context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    // Default to <t> (current target) when no target is specified
    const target = args.positionalArgs.join(' ').trim() || '<t>';

    return {
      success: true,
      events: [
        {
          type: 'combat_action',
          data: {
            abilityId: 'basic_attack',
            target,
          },
        },
      ],
    };
  },
};
