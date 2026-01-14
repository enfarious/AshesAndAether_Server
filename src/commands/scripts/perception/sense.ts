/**
 * /sense command - Supernatural sense (vampires, psionics, etc.)
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

export const senseCommand: CommandDefinition = {
  name: 'sense',
  aliases: ['detect'],
  description: 'Use supernatural senses to detect presences',
  category: 'world',
  usage: '/sense',
  examples: ['/sense'],

  cooldown: 10000,  // 10 second cooldown (powerful ability)

  handler: async (context: CommandContext, _args: ParsedCommand): Promise<CommandResult> => {
    // Create perception event for narrator with Changed type context
    return {
      success: true,
      message: 'You extend your supernatural senses...',
      events: [
        {
          type: 'perception',
          data: {
            characterId: context.characterId,
            perceptionType: 'sense',
            position: context.position,
            zoneId: context.zoneId,
            // Narrator knows character Changed type and adjusts response
            requiresNarrator: true,
            activePerception: true,
          },
        },
      ],
    };
  },
};
