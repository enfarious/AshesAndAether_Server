/**
 * /beacon command — Guild beacon management.
 *
 * Subcommands:
 *   light      — Light a beacon at the nearest unclaimed world point
 *   fuel       — Add fuel to the nearest guild beacon
 *   info       — Show info about the nearest beacon
 *   list       — List all guild beacons
 *   extinguish — Voluntarily extinguish a beacon (Guildmaster only)
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

const SUBCOMMANDS = new Set(['light', 'fuel', 'info', 'list', 'extinguish']);

export const beaconCommand: CommandDefinition = {
  name: 'beacon',
  aliases: ['b'],
  description: 'Guild beacon management — light, fuel, info, list, extinguish',
  category: 'world',
  usage: '/beacon <subcommand>',
  examples: [
    '/beacon light',
    '/beacon fuel',
    '/beacon info',
    '/beacon list',
    '/beacon extinguish',
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
        error: 'Usage: /beacon <light|fuel|info|list|extinguish>',
      };
    }

    const spaceIdx = rawInput.indexOf(' ');
    const subcommand = spaceIdx === -1 ? rawInput.toLowerCase() : rawInput.substring(0, spaceIdx).toLowerCase();

    if (!SUBCOMMANDS.has(subcommand)) {
      return {
        success: false,
        error: `Unknown subcommand "${subcommand}". Available: ${Array.from(SUBCOMMANDS).join(', ')}`,
      };
    }

    switch (subcommand) {
      case 'light':
        return {
          success: true,
          message: 'Attempting to light a beacon at the nearest world point...',
          events: [{ type: 'beacon_light', data: {} }],
        };

      case 'fuel':
        return {
          success: true,
          message: 'Adding fuel to the nearest guild beacon...',
          events: [{ type: 'beacon_fuel', data: {} }],
        };

      case 'info':
        return {
          success: true,
          message: 'Checking beacon info...',
          events: [{ type: 'beacon_info', data: {} }],
        };

      case 'list':
        return {
          success: true,
          message: 'Listing guild beacons...',
          events: [{ type: 'beacon_list', data: {} }],
        };

      case 'extinguish':
        return {
          success: true,
          message: 'Extinguishing beacon... This cannot be undone.',
          events: [{ type: 'beacon_extinguish', data: {} }],
        };

      default:
        return { success: false, error: `Unknown beacon subcommand: ${subcommand}` };
    }
  },
};
