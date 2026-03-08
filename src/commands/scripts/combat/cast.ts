/**
 * /cast command - Cast a named ability on a target
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

export const castCommand: CommandDefinition = {
  name: 'cast',
  aliases: ['ability', 'magic'],
  description: 'Cast a named ability on a target (defaults to current target)',
  category: 'combat',
  usage: '/cast "<ability>" [target]',
  examples: [
    '/cast "Basic Attack" Old Merchant',
    '/cast "shadow bolt" bandit.1',
    '/cast mend',             // defaults to current target (<t>)
    '/cast mend <ft>',        // focus target
    '/cast mend <bt>',        // battle target (auto-attack target)
    '/cast mend <tt>',        // target\'s target
    '/cast mend <me>',        // self-target
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
        required: false,
        description: 'Target name, ID, or token (<t>, <ft>, <bt>, <tt>, <me>). Defaults to <t>.',
      },
    ],
  },

  handler: async (_context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    const abilityName = args.positionalArgs[0]?.trim();
    // Default to <t> (current target) when no target is specified
    const target = args.positionalArgs.slice(1).join(' ').trim() || '<t>';

    if (!abilityName) {
      return {
        success: false,
        error: 'You must provide an ability name. Use /cast "<ability>" [target].',
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
