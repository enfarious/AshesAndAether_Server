/**
 * /unstuck command — Nudge yourself free of building geometry.
 *
 * Uses PhysicsSystem.nudgeToUnstuck() to push the player away from any nearby
 * wall colliders, then lifts them 1 m so terrain-snap drops them cleanly to
 * the ground surface.
 *
 * 5-minute cooldown enforced server-side so it can't be used as fast travel.
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

export const unstuckCommand: CommandDefinition = {
  name: 'unstuck',
  aliases: ['stuck'],
  description: 'Nudge yourself to a nearby open spot if you are stuck inside geometry.',
  category: 'world',
  usage: '/unstuck',
  examples: ['/unstuck'],

  parameters: {},

  handler: (_context: CommandContext, _args: ParsedCommand): CommandResult => ({
    success: true,
    message: 'Requesting position reset…',
    broadcast: false,
    events: [
      {
        type: 'unstuck',
        data: {},
      },
    ],
  }),
};
