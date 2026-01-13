/**
 * /companion command - Cycle companion control
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

const VALID_MODES = new Set(['next', 'prev']);

export const companionCommand: CommandDefinition = {
  name: 'companion',
  aliases: ['comp'],
  description: 'Cycle companion control to the next or previous NPC',
  category: 'world',
  usage: '/companion <next|prev>',
  examples: [
    '/companion next',
    '/comp prev',
  ],

  parameters: {
    positional: [
      {
        type: 'enum',
        required: true,
        enumValues: ['next', 'prev'],
        description: 'Cycle mode',
      },
    ],
  },

  handler: async (_context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    const mode = args.positionalArgs[0]?.toLowerCase();
    if (!mode || !VALID_MODES.has(mode)) {
      return {
        success: false,
        error: 'Companion command requires "next" or "prev".',
      };
    }

    return {
      success: true,
      message: `Companion cycle ${mode}...`,
      events: [
        {
          type: 'companion_command',
          data: { mode },
        },
      ],
    };
  },
};
