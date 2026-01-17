/**
 * /disengage command - Stop auto-attacking (keeps target selected, does not affect movement)
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

export const disengageCommand: CommandDefinition = {
  name: 'disengage',
  aliases: ['dis'],
  description: 'Stop auto-attacking (keeps target selected)',
  category: 'combat',
  usage: '/disengage',
  examples: ['/disengage', '/dis'],

  handler: async (context: CommandContext, _args: ParsedCommand): Promise<CommandResult> => {
    if (!context.inCombat) {
      return {
        success: true,
        message: 'You are not in combat.',
      };
    }

    // Note: This only stops auto-attack, target remains selected
    // Player can re-engage with /attack or ability use
    return {
      success: true,
      message: 'You stop attacking but keep your target.',
      events: [
        {
          type: 'auto_attack_stop',
          data: {
            characterId: context.characterId,
            keepTarget: true, // Signal to keep target selected
          },
        },
      ],
    };
  },
};
