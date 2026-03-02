/**
 * /harvest command — Pick plants within arm's reach
 *
 * Usage:
 *   /harvest                       — harvests the nearest harvestable plant within 3 m
 *   /harvest <plant_id>            — harvests a specific plant by ID (used by 3D client)
 *
 * The actual harvesting logic lives in DistributedWorldManager.processHarvestCommand.
 * This command just packages the intent as an event.
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

export const harvestCommand: CommandDefinition = {
  name: 'harvest',
  aliases: ['pick', 'gather'],
  description: 'Harvest a nearby plant for crafting and cooking materials.',
  category: 'world',
  usage: '/harvest [plant_id]',
  examples: [
    '/harvest',
    '/harvest plant_carrot_1719000000_abc123',
  ],

  parameters: {
    positional: [
      {
        type: 'string',
        required: false,
        description: 'Plant entity ID (optional — omit to auto-target nearest)',
      },
    ],
  },

  handler: (_context: CommandContext, args: ParsedCommand): CommandResult => {
    const plantId = args.positionalArgs[0]?.trim() || undefined;

    return {
      success: true,
      message: plantId ? `Harvesting ${plantId}…` : 'You reach for the nearest plant…',
      broadcast: false,
      events: [
        {
          type: 'harvest',
          data: { plantId },
        },
      ],
    };
  },
};
