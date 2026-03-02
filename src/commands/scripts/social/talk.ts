/**
 * /talk command - Address a specific target using local speech
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

export const talkCommand: CommandDefinition = {
  name: 'talk',
  aliases: ['ta'],
  description: 'Talk to a specific target within local range',
  category: 'social',
  usage: '/talk <target> [message]',
  examples: [
    '/talk Old Merchant Hello there.',
    '/talk Rat 1 Go on, shoo.',
  ],

  parameters: {
    positional: [
      {
        type: 'string',
        required: true,
        description: 'Target name',
      },
      {
        type: 'string',
        required: false,
        description: 'Message to say (defaults to "Hello.")',
      },
    ],
    named: {
      id: {
        type: 'string',
        required: false,
        description: 'Target entity ID (passed by 3D client for directed LLM lookup)',
      },
    },
  },

  handler: async (context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    const target = args.positionalArgs[0]?.trim();
    if (!target) {
      return {
        success: false,
        error: 'You must provide a target to talk to.',
      };
    }

    // Named --id flag lets the 3D client pass the entity UUID without it
    // appearing in the visible message text.
    const npcId: string | undefined = args.namedArgs['id']?.trim() || undefined;

    const messageText = args.positionalArgs.slice(1).join(' ').trim() || 'Hello.';
    if (messageText.length > 500) {
      return {
        success: false,
        error: 'Message too long (max 500 characters).',
      };
    }

    const message = `${target}, ${messageText}`;

    return {
      success: true,
      message: `You talk to ${target}.`,
      broadcast: true,
      events: [
        {
          type: 'speech',
          data: {
            speakerId: context.characterId,
            speakerName: context.characterName,
            message,
            channel: 'say',
            range: 20,
            position: context.position,
            npcId,   // undefined for freeform /talk; set when client provides --id
          },
        },
      ],
    };
  },
};
