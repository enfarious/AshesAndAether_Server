/**
 * /party command - party management (invite, accept, decline, leave, kick, list)
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

export const partyCommand: CommandDefinition = {
  name: 'party',
  aliases: ['group'],
  description: 'Manage your party',
  category: 'social',
  usage: '/party <invite|accept|decline|leave|kick|list> [target]',
  examples: [
    '/party invite Shadowblade',
    '/party accept',
    '/party decline',
    '/party leave',
    '/party kick Shadowblade',
    '/party list',
  ],

  parameters: {
    positional: [
      { type: 'string', required: true, description: 'Action (invite/accept/decline/leave/kick/list)' },
      { type: 'string', required: false, description: 'Target name or ID' },
    ],
  },

  handler: async (_context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    const action = (args.positionalArgs[0] || '').toLowerCase();
    const target = args.positionalArgs.slice(1).join(' ').trim() || null;

    if (!action) {
      return { success: false, error: 'Usage: /party <invite|accept|decline|leave|kick|list> [target]' };
    }

    if (['invite', 'kick'].includes(action) && !target) {
      return { success: false, error: `Usage: /party ${action} <target>` };
    }

    return {
      success: true,
      events: [
        {
          type: 'party_action',
          data: { action, target },
        },
      ],
    };
  },
};
