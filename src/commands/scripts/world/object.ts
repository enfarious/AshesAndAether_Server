/**
 * /object command — MOO-style scripted object management.
 * /edit command — Opens the in-game script editor for a verb.
 * /undo command — Rolls back a verb script to the previous version.
 *
 * Subcommands for /object:
 *   place <name>         — Place a new scripted object at your position
 *   edit <id|name>       — Show current Lua source (legacy, text dump)
 *   script <id> <lua>    — Update script source inline
 *   pickup <id|name>     — Remove object from world
 *   inspect <id|name>    — Show object details
 *   list                 — List all objects you own
 *   activate <id|name>   — Re-enable a deactivated object
 *   deactivate <id|name> — Pause script execution
 *   verbs <id|name>      — List all verbs on an object
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

const SUBCOMMANDS = new Set([
  'place', 'edit', 'script', 'pickup', 'inspect', 'list', 'activate', 'deactivate', 'verbs',
]);

export const objectCommand: CommandDefinition = {
  name: 'object',
  aliases: ['obj'],
  description: 'Manage scripted objects — place, edit, script, pickup, inspect, list, activate, deactivate, verbs',
  category: 'world',
  usage: '/object <subcommand> [args]',
  examples: [
    '/object place Bouncy Ball',
    '/object edit <id>',
    '/object script <id> function onTouch(e) object.say("boop!") end',
    '/object pickup <id>',
    '/object inspect <id>',
    '/object list',
    '/object activate <id>',
    '/object deactivate <id>',
    '/object verbs <id>',
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
        error: 'Usage: /object <place|edit|script|pickup|inspect|list|activate|deactivate|verbs>',
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
      case 'place': {
        if (!rest) {
          return { success: false, error: 'Usage: /object place <name>' };
        }
        return {
          success: true,
          message: `Placing scripted object "${rest}"...`,
          events: [{ type: 'scripted_object_place', data: { name: rest } }],
        };
      }

      case 'edit': {
        if (!rest) {
          return { success: false, error: 'Usage: /object edit <id or name>' };
        }
        return {
          success: true,
          message: 'Retrieving script source...',
          events: [{ type: 'scripted_object_edit', data: { target: rest } }],
        };
      }

      case 'script': {
        // /object script <id> <lua code>
        const scriptSpaceIdx = rest.indexOf(' ');
        if (!rest || scriptSpaceIdx === -1) {
          return { success: false, error: 'Usage: /object script <id> <lua code>' };
        }
        const objectId = rest.substring(0, scriptSpaceIdx).trim();
        const luaSource = rest.substring(scriptSpaceIdx + 1).trim();
        if (!luaSource) {
          return { success: false, error: 'No Lua source provided.' };
        }
        return {
          success: true,
          message: 'Updating script...',
          events: [{ type: 'scripted_object_script', data: { objectId, scriptSource: luaSource } }],
        };
      }

      case 'pickup': {
        if (!rest) {
          return { success: false, error: 'Usage: /object pickup <id or name>' };
        }
        return {
          success: true,
          message: `Picking up "${rest}"...`,
          events: [{ type: 'scripted_object_pickup', data: { target: rest } }],
        };
      }

      case 'inspect': {
        if (!rest) {
          return { success: false, error: 'Usage: /object inspect <id or name>' };
        }
        return {
          success: true,
          message: 'Inspecting object...',
          events: [{ type: 'scripted_object_inspect', data: { target: rest } }],
        };
      }

      case 'list':
        return {
          success: true,
          message: 'Listing your scripted objects...',
          events: [{ type: 'scripted_object_list', data: {} }],
        };

      case 'activate': {
        if (!rest) {
          return { success: false, error: 'Usage: /object activate <id or name>' };
        }
        return {
          success: true,
          message: `Activating "${rest}"...`,
          events: [{ type: 'scripted_object_activate', data: { target: rest } }],
        };
      }

      case 'deactivate': {
        if (!rest) {
          return { success: false, error: 'Usage: /object deactivate <id or name>' };
        }
        return {
          success: true,
          message: `Deactivating "${rest}"...`,
          events: [{ type: 'scripted_object_deactivate', data: { target: rest } }],
        };
      }

      case 'verbs': {
        if (!rest) {
          return { success: false, error: 'Usage: /object verbs <id or name>' };
        }
        return {
          success: true,
          message: 'Listing verbs...',
          events: [{ type: 'scripted_object_verbs', data: { target: rest } }],
        };
      }

      default:
        return { success: false, error: `Unknown subcommand: ${subcommand}` };
    }
  },
};

/**
 * /edit <object>:<verb> — Opens the in-game script editor.
 *
 * Examples:
 *   /edit torch:light
 *   /edit chest:open
 *   /edit beacon:onHeartbeat
 *
 * If the verb doesn't exist, offers to create it from a blank template.
 */
export const editCommand: CommandDefinition = {
  name: 'edit',
  aliases: [],
  description: 'Open the in-game script editor for an object verb',
  category: 'world',
  usage: '/edit <object>:<verb>',
  examples: [
    '/edit torch:light',
    '/edit chest:open',
    '/edit beacon:onHeartbeat',
  ],

  parameters: {
    positional: [
      {
        type: 'string',
        required: true,
        description: 'Object reference and verb name separated by colon',
      },
    ],
  },

  handler: async (_context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    const rawInput = args.positionalArgs.join(' ').trim();
    if (!rawInput) {
      return { success: false, error: 'Usage: /edit <object>:<verb>' };
    }

    const colonIdx = rawInput.lastIndexOf(':');
    if (colonIdx === -1 || colonIdx === 0 || colonIdx === rawInput.length - 1) {
      return { success: false, error: 'Usage: /edit <object>:<verb>  (e.g. /edit torch:light)' };
    }

    const objectRef = rawInput.substring(0, colonIdx).trim();
    const verb = rawInput.substring(colonIdx + 1).trim();

    if (!verb.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/)) {
      return { success: false, error: `Invalid verb name "${verb}". Must be a valid Lua identifier.` };
    }

    return {
      success: true,
      message: 'Opening editor...',
      events: [{ type: 'editor_open_request', data: { objectRef, verb } }],
    };
  },
};

/**
 * /undo <object>:<verb> — Roll back a verb script to the previous saved version.
 *
 * Examples:
 *   /undo torch:light
 *   /undo chest:open
 */
export const undoCommand: CommandDefinition = {
  name: 'undo',
  aliases: [],
  description: 'Roll back a verb script to the previous version',
  category: 'world',
  usage: '/undo <object>:<verb>',
  examples: [
    '/undo torch:light',
    '/undo chest:open',
  ],

  parameters: {
    positional: [
      {
        type: 'string',
        required: true,
        description: 'Object reference and verb name separated by colon',
      },
    ],
  },

  handler: async (_context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    const rawInput = args.positionalArgs.join(' ').trim();
    if (!rawInput) {
      return { success: false, error: 'Usage: /undo <object>:<verb>' };
    }

    const colonIdx = rawInput.lastIndexOf(':');
    if (colonIdx === -1 || colonIdx === 0 || colonIdx === rawInput.length - 1) {
      return { success: false, error: 'Usage: /undo <object>:<verb>  (e.g. /undo torch:light)' };
    }

    const objectRef = rawInput.substring(0, colonIdx).trim();
    const verb = rawInput.substring(colonIdx + 1).trim();

    return {
      success: true,
      message: 'Rolling back...',
      events: [{ type: 'editor_undo_request', data: { objectRef, verb } }],
    };
  },
};

/**
 * /do <object> <verb> — Invoke a custom verb on a nearby scripted object.
 *
 * Examples:
 *   /do torch light
 *   /do shovel dig
 *   /do guestbook sign
 */
export const doVerbCommand: CommandDefinition = {
  name: 'do',
  aliases: [],
  description: 'Invoke a custom verb on a nearby scripted object',
  category: 'world',
  usage: '/do <object> <verb>',
  examples: [
    '/do torch light',
    '/do shovel dig',
    '/do guestbook sign',
  ],

  parameters: {
    positional: [
      {
        type: 'string',
        required: true,
        description: 'Object name or ID',
      },
      {
        type: 'string',
        required: true,
        description: 'Verb to invoke',
      },
    ],
  },

  handler: async (_context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    const rawInput = args.positionalArgs.join(' ').trim();
    if (!rawInput) {
      return { success: false, error: 'Usage: /do <object> <verb>' };
    }

    const parts = rawInput.split(/\s+/);
    if (parts.length < 2) {
      return { success: false, error: 'Usage: /do <object> <verb>' };
    }

    const verb = parts[parts.length - 1];
    const objectRef = parts.slice(0, -1).join(' ');

    if (!verb.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/)) {
      return { success: false, error: `Invalid verb name "${verb}". Must be a valid Lua identifier.` };
    }

    return {
      success: true,
      message: '',
      events: [{ type: 'scripted_object_do_verb', data: { target: objectRef, verb } }],
    };
  },
};
