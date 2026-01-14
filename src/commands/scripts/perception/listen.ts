/**
 * /listen command - Actively listen for sounds (uses narrator)
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

export const listenCommand: CommandDefinition = {
  name: 'listen',
  aliases: ['hear'],
  description: 'Actively listen for sounds in your surroundings',
  category: 'world',
  usage: '/listen',
  examples: ['/listen'],

  cooldown: 5000,  // 5 second cooldown (prevent spam)

  handler: async (context: CommandContext, _args: ParsedCommand): Promise<CommandResult> => {
    // Create perception event for narrator with dice roll
    return {
      success: true,
      message: 'You listen carefully...',
      events: [
        {
          type: 'perception',
          data: {
            characterId: context.characterId,
            perceptionType: 'listen',
            position: context.position,
            zoneId: context.zoneId,
            // Narrator will roll and respond (always responds, accuracy varies)
            requiresNarrator: true,
            activePerception: true,  // Always get response
          },
        },
      ],
    };
  },
};
