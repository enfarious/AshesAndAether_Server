/**
 * /library command — Library beacon information and defense.
 *
 * Libraries are public NPC fixtures. Players can check their status
 * and register as defenders during assaults.
 *
 * Subcommands:
 *   info    — Show nearest library status
 *   list    — List all libraries in the region
 *   defend  — Register as a defender during an active assault
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

const SUBCOMMANDS = new Set(['info', 'list', 'defend']);

export const libraryCommand: CommandDefinition = {
  name: 'library',
  aliases: ['lib'],
  description: 'Library beacon information — status, list, and defense',
  category: 'world',
  usage: '/library <subcommand>',
  examples: [
    '/library info',
    '/library list',
    '/library defend',
  ],

  parameters: {
    positional: [
      {
        type: 'string',
        required: true,
        description: 'Subcommand',
      },
    ],
  },

  handler: async (_context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    const rawInput = args.positionalArgs.join(' ').trim();
    if (!rawInput) {
      return {
        success: false,
        error: 'Usage: /library <info|list|defend>',
      };
    }

    const subcommand = rawInput.toLowerCase().split(/\s+/)[0];

    if (!SUBCOMMANDS.has(subcommand)) {
      return {
        success: false,
        error: `Unknown subcommand "${subcommand}". Available: ${Array.from(SUBCOMMANDS).join(', ')}`,
      };
    }

    switch (subcommand) {
      case 'info':
        return {
          success: true,
          message: 'Checking library status...',
          events: [{ type: 'library_info', data: {} }],
        };

      case 'list':
        return {
          success: true,
          message: 'Listing libraries...',
          events: [{ type: 'library_list', data: {} }],
        };

      case 'defend':
        return {
          success: true,
          message: 'Registering as library defender...',
          events: [{ type: 'library_defend', data: {} }],
        };

      default:
        return { success: false, error: `Unknown library subcommand: ${subcommand}` };
    }
  },
};
