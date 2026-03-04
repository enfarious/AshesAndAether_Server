/**
 * /guild command — Guild management.
 *
 * Subcommands:
 *   create <name> <tag> — Begin guild founding ceremony
 *   accept              — Consent to a pending founding ceremony
 *   invite <player>     — Invite a player to the guild
 *   leave               — Leave your guild
 *   kick <player>       — Kick a member (Guildmaster only)
 *   info [guild]        — Show guild details
 *   members             — List all guild members
 *   promote <player>    — Transfer Guildmaster to another member
 *   disband             — Disband the guild (Guildmaster only)
 *   motto <text>        — Set the guild motto
 *   description <text>  — Set the guild description
 *   chat <message>      — Send a guild-wide chat message
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

const SUBCOMMANDS = new Set([
  'create', 'accept', 'invite', 'leave', 'kick', 'info', 'members',
  'promote', 'disband', 'motto', 'description', 'chat',
]);

export const guildCommand: CommandDefinition = {
  name: 'guild',
  aliases: ['g'],
  description: 'Guild management — create, invite, leave, kick, info, chat, and more',
  category: 'social',
  usage: '/guild <subcommand> [args]',
  examples: [
    '/guild create "Iron Wolves" IW',
    '/guild accept',
    '/guild invite Shadowblade',
    '/guild leave',
    '/guild kick Shadowblade',
    '/guild info',
    '/guild members',
    '/guild promote Shadowblade',
    '/guild disband',
    '/guild motto Strength through unity',
    '/guild description A guild of warriors',
    '/guild chat Hello everyone!',
  ],

  parameters: {
    positional: [
      {
        type: 'string',
        required: true,
        description: 'Subcommand and optional arguments',
      },
    ],
  },

  handler: async (_context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    const rawInput = args.positionalArgs.join(' ').trim();
    if (!rawInput) {
      return {
        success: false,
        error: 'Usage: /guild <create|accept|invite|leave|kick|info|members|promote|disband|motto|description|chat>',
      };
    }

    const spaceIdx = rawInput.indexOf(' ');
    const subcommand = spaceIdx === -1 ? rawInput.toLowerCase() : rawInput.substring(0, spaceIdx).toLowerCase();
    const rest = spaceIdx === -1 ? '' : rawInput.substring(spaceIdx + 1).trim();

    if (!SUBCOMMANDS.has(subcommand)) {
      return {
        success: false,
        error: `Unknown subcommand "${subcommand}". Available: ${Array.from(SUBCOMMANDS).join(', ')}`,
      };
    }

    switch (subcommand) {
      case 'create': {
        // Parse: /guild create "Guild Name" TAG
        // or: /guild create Guild Name TAG (last word is tag)
        if (!rest) {
          return { success: false, error: 'Usage: /guild create <name> <tag>. Example: /guild create "Iron Wolves" IW' };
        }

        let guildName: string;
        let guildTag: string;

        // Check for quoted name
        const quoteMatch = rest.match(/^"([^"]+)"\s+(\S+)$/);
        if (quoteMatch) {
          guildName = quoteMatch[1];
          guildTag = quoteMatch[2];
        } else {
          // Last word is tag, everything before is name
          const parts = rest.split(/\s+/);
          if (parts.length < 2) {
            return { success: false, error: 'Usage: /guild create <name> <tag>. Example: /guild create "Iron Wolves" IW' };
          }
          guildTag = parts[parts.length - 1];
          guildName = parts.slice(0, -1).join(' ');
        }

        return {
          success: true,
          message: `Initiating founding of guild "${guildName}" [${guildTag.toUpperCase()}]...`,
          events: [{ type: 'guild_create_init', data: { name: guildName, tag: guildTag } }],
        };
      }

      case 'accept':
        return {
          success: true,
          message: 'Consenting to guild founding...',
          events: [{ type: 'guild_accept_founding', data: {} }],
        };

      case 'invite': {
        if (!rest) {
          return { success: false, error: 'Usage: /guild invite <player name>' };
        }
        return {
          success: true,
          message: `Inviting ${rest} to the guild...`,
          events: [{ type: 'guild_invite', data: { targetName: rest } }],
        };
      }

      case 'leave':
        return {
          success: true,
          message: 'Leaving guild...',
          events: [{ type: 'guild_leave', data: {} }],
        };

      case 'kick': {
        if (!rest) {
          return { success: false, error: 'Usage: /guild kick <player name>' };
        }
        return {
          success: true,
          message: `Kicking ${rest} from the guild...`,
          events: [{ type: 'guild_kick', data: { targetName: rest } }],
        };
      }

      case 'info': {
        return {
          success: true,
          message: 'Fetching guild info...',
          events: [{ type: 'guild_info', data: { targetGuild: rest || null } }],
        };
      }

      case 'members':
        return {
          success: true,
          message: 'Fetching member list...',
          events: [{ type: 'guild_members', data: {} }],
        };

      case 'promote': {
        if (!rest) {
          return { success: false, error: 'Usage: /guild promote <player name>' };
        }
        return {
          success: true,
          message: `Transferring Guildmaster to ${rest}...`,
          events: [{ type: 'guild_transfer_gm', data: { targetName: rest } }],
        };
      }

      case 'disband':
        return {
          success: true,
          message: 'Disbanding guild... This cannot be undone.',
          events: [{ type: 'guild_disband', data: {} }],
        };

      case 'motto': {
        if (!rest) {
          return { success: false, error: 'Usage: /guild motto <text>' };
        }
        return {
          success: true,
          message: `Setting guild motto: "${rest}"`,
          events: [{ type: 'guild_motto', data: { text: rest } }],
        };
      }

      case 'description': {
        if (!rest) {
          return { success: false, error: 'Usage: /guild description <text>' };
        }
        return {
          success: true,
          message: 'Updating guild description...',
          events: [{ type: 'guild_description', data: { text: rest } }],
        };
      }

      case 'chat': {
        if (!rest) {
          return { success: false, error: 'Usage: /guild chat <message>' };
        }
        return {
          success: true,
          events: [{ type: 'guild_chat', data: { message: rest } }],
        };
      }

      default:
        return { success: false, error: `Unknown guild subcommand: ${subcommand}` };
    }
  },
};
