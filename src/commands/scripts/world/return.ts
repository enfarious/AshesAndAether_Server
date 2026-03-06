/**
 * /return command — Teleport back to your home spawn point.
 *
 * Uses SpawnPointService.getCitySpawn() to find the zone's home/city spawn,
 * falling back to the starter spawn (e.g. Town Hall).
 *
 * 30-minute cooldown enforced server-side so it can't be used as fast travel.
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

export const returnCommand: CommandDefinition = {
  name: 'return',
  aliases: ['home'],
  description: 'Return to your home spawn point.',
  category: 'world',
  usage: '/return',
  examples: ['/return', '/home'],

  parameters: {},

  handler: (_context: CommandContext, _args: ParsedCommand): CommandResult => ({
    success: true,
    message: 'Returning home…',
    broadcast: false,
    events: [
      {
        type: 'return_home',
        data: {},
      },
    ],
  }),
};
