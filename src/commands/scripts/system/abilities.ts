/**
 * /abilities command — View and manage ability web nodes
 *
 * Subcommands
 *   /abilities                             — show loadout summary
 *   /abilities list active|passive         — list all nodes in a web
 *   /abilities info <node_id>              — details for a specific node
 *   /abilities unlock <node_id>            — unlock a node
 *   /abilities slot active  <slot> <id>    — place active node in slot 1–8
 *   /abilities slot passive <slot> <id>    — place passive node in slot 1–8
 *   /abilities slot active  <slot>         — clear an active slot
 *   /abilities slot passive <slot>         — clear a passive slot
 */

import type {
  CommandDefinition,
  CommandContext,
  CommandResult,
  ParsedCommand,
} from '@/commands/types';

export const abilitiesCommand: CommandDefinition = {
  name: 'abilities',
  aliases: ['ab'],
  description: 'View and manage your ability web: unlock nodes and arrange your loadout.',
  category: 'system',
  usage: '/abilities [list active|passive] [info <id>] [unlock <id>] [slot active|passive <num> [<id>]]',
  examples: [
    '/abilities',
    '/abilities list active',
    '/abilities list passive',
    '/abilities info active_tank_t1',
    '/abilities unlock active_tank_t1',
    '/abilities slot active 1 active_tank_t1',
    '/abilities slot active 8 active_tank_t4',
    '/abilities slot active 1',
    '/abilities slot passive 3 passive_phys_t2a',
  ],

  parameters: {
    positional: [
      { type: 'string', required: false, description: 'Subcommand' },
      { type: 'string', required: false, description: 'Subcommand argument 1' },
      { type: 'string', required: false, description: 'Subcommand argument 2' },
      { type: 'string', required: false, description: 'Subcommand argument 3' },
    ],
  },

  handler: (_context: CommandContext, args: ParsedCommand): CommandResult => {
    const [sub, arg1, arg2, arg3] = args.positionalArgs.map(a => a?.trim().toLowerCase());

    // /abilities → summary
    if (!sub || sub === 'show' || sub === 'summary') {
      return {
        success: true,
        message: 'Fetching ability summary…',
        broadcast: false,
        events: [{ type: 'ability_view', data: { view: 'summary' } }],
      };
    }

    // /abilities list active|passive
    if (sub === 'list') {
      const web = arg1 === 'passive' ? 'passive' : 'active';
      return {
        success: true,
        message: `Fetching ${web} web nodes…`,
        broadcast: false,
        events: [{ type: 'ability_view', data: { view: 'list', web } }],
      };
    }

    // /abilities info <node_id>
    if (sub === 'info') {
      if (!arg1) {
        return { success: false, error: 'Usage: /abilities info <node_id>' };
      }
      return {
        success: true,
        message: `Fetching info for ${arg1}…`,
        broadcast: false,
        events: [{ type: 'ability_view', data: { view: 'info', nodeId: arg1 } }],
      };
    }

    // /abilities unlock <node_id>
    if (sub === 'unlock') {
      if (!arg1) {
        return { success: false, error: 'Usage: /abilities unlock <node_id>' };
      }
      return {
        success: true,
        message: `Attempting to unlock ${arg1}…`,
        broadcast: false,
        events: [{ type: 'ability_unlock', data: { nodeId: arg1 } }],
      };
    }

    // /abilities slot active|passive <slot_number> [<node_id>]
    if (sub === 'slot') {
      const webRaw = arg1 === 'passive' ? 'passive' : 'active';
      const slotNum = parseInt(arg2 ?? '', 10);
      if (isNaN(slotNum) || slotNum < 1) {
        return { success: false, error: `Usage: /abilities slot ${webRaw} <slot 1-8> [<node_id>]` };
      }
      const nodeId = arg3 ?? '';  // empty = clear slot
      return {
        success: true,
        message: nodeId
          ? `Slotting ${nodeId} into ${webRaw} slot ${slotNum}…`
          : `Clearing ${webRaw} slot ${slotNum}…`,
        broadcast: false,
        events: [{
          type: 'ability_slot',
          data: { web: webRaw, slotNumber: slotNum, nodeId },
        }],
      };
    }

    return {
      success: false,
      error: `Unknown subcommand '${sub}'. Try: /abilities, /abilities list, /abilities unlock, /abilities slot`,
    };
  },
};
