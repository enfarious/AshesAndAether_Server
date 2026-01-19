/**
 * /look command - Examine surroundings or specific entity
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

export const lookCommand: CommandDefinition = {
  name: 'look',
  aliases: ['l', 'examine', 'exam'],
  description: 'Examine your surroundings or a specific target',
  category: 'world',
  usage: '/look [target]',
  examples: [
    '/look',
    '/look ant.worker.1',
    '/l building.abandoned.1',
  ],

  parameters: {
    positional: [
      {
        type: 'entity',
        required: false,
        description: 'Optional target to examine',
      },
    ],
  },

  handler: async (context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    const target = args.positionalArgs.length > 0
      ? args.positionalArgs.join(' ').trim()
      : null;

    // Create perception event for narrator
    return {
      success: true,
      events: [
        {
          type: 'perception',
          data: {
            characterId: context.characterId,
            perceptionType: 'look',
            target,
            position: context.position,
            zoneId: context.zoneId,
            // Narrator will provide description based on zone/target
            requiresNarrator: true,
          },
        },
      ],
    };
  },
};
