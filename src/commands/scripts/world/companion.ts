/**
 * /companion command — Player companion control.
 *
 * Subcommands:
 *   status   — Show companion mode, task, and harvest stats
 *   follow   — Enter ACTIVE mode, companion follows player
 *   detach   — Enter DETACHED mode, companion idles
 *   task <d> — Enter TASKED mode, LLM generates behavior tree from description
 *   harvest  — Enter TASKED mode with the default harvest tree (no LLM call)
 *   recall   — Navigate to player and enter ACTIVE mode
 *   report   — LLM summarizes recent activity
 *   next     — Cycle to next companion (legacy)
 *   prev     — Cycle to previous companion (legacy)
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

const VALID_ARCHETYPES = new Set(['scrappy_fighter', 'cautious_healer', 'opportunist', 'tank']);

const SUBCOMMANDS = new Set([
  'status', 'follow', 'detach', 'task', 'harvest', 'recall', 'report', 'next', 'prev',
  'archetype', 'configure', 'abilities', 'config',
]);

export const companionCommand: CommandDefinition = {
  name: 'companion',
  aliases: ['comp'],
  description: 'Control your companion — follow, detach, task, harvest, recall, report, status',
  category: 'world',
  usage: '/companion <subcommand> [args]',
  examples: [
    '/companion status',
    '/companion follow',
    '/companion detach',
    '/companion task gather herbs near the river',
    '/companion harvest',
    '/companion recall',
    '/companion report',
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
    // Rejoin all positional args into a single string so "task gather herbs" works
    const rawInput = args.positionalArgs.join(' ').trim();
    if (!rawInput) {
      return {
        success: false,
        error: 'Usage: /companion <status|follow|detach|task|harvest|recall|report>',
      };
    }

    // Split into subcommand + remaining text
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
      case 'status':
        return {
          success: true,
          message: 'Checking companion status...',
          events: [{ type: 'companion_status', data: {} }],
        };

      case 'follow':
        return {
          success: true,
          message: 'Your companion begins following you.',
          events: [{ type: 'companion_follow', data: {} }],
        };

      case 'detach':
        return {
          success: true,
          message: 'Your companion idles in place.',
          events: [{ type: 'companion_detach', data: {} }],
        };

      case 'task': {
        if (!rest) {
          return {
            success: false,
            error: 'Usage: /companion task <description>. Example: /companion task gather herbs',
          };
        }
        return {
          success: true,
          message: `Assigning task: "${rest}"...`,
          events: [{ type: 'companion_task', data: { description: rest } }],
        };
      }

      case 'harvest':
        return {
          success: true,
          message: 'Your companion begins harvesting nearby plants.',
          events: [{ type: 'companion_harvest', data: {} }],
        };

      case 'recall':
        return {
          success: true,
          message: 'Your companion is returning to you.',
          events: [{ type: 'companion_recall', data: {} }],
        };

      case 'report':
        return {
          success: true,
          message: 'Requesting companion report...',
          events: [{ type: 'companion_report', data: {} }],
        };

      // ── Manual management (for when LLM is unavailable) ─────────────────

      case 'archetype': {
        if (!rest || !VALID_ARCHETYPES.has(rest.toLowerCase())) {
          return {
            success: false,
            error: `Usage: /companion archetype <${Array.from(VALID_ARCHETYPES).join('|')}>`,
          };
        }
        return {
          success: true,
          message: `Changing companion archetype to ${rest.toLowerCase()}...`,
          events: [{ type: 'companion_set_archetype', data: { archetype: rest.toLowerCase() } }],
        };
      }

      case 'configure': {
        if (!rest) {
          return {
            success: false,
            error: 'Usage: /companion configure <key=value ...>  Keys: stance, range, priority, retreat, damage, cc, heal',
          };
        }
        // Parse key=value pairs into a partial settings object
        const settings: Record<string, unknown> = {};
        const weights: Record<string, number> = {};
        for (const token of rest.split(/\s+/)) {
          const eq = token.indexOf('=');
          if (eq === -1) continue;
          const key = token.substring(0, eq).toLowerCase();
          const val = token.substring(eq + 1);
          switch (key) {
            case 'stance':   settings.stance = val; break;
            case 'range':    settings.preferredRange = val; break;
            case 'priority': settings.priority = val; break;
            case 'retreat':  settings.retreatThreshold = parseFloat(val); break;
            case 'damage': case 'cc': case 'heal':
              weights[key] = parseFloat(val);
              break;
          }
        }
        if (Object.keys(weights).length > 0) settings.abilityWeights = weights;
        return {
          success: true,
          message: 'Updating companion combat settings...',
          events: [{ type: 'companion_configure', data: { settings } }],
        };
      }

      case 'abilities': {
        if (!rest) {
          return {
            success: false,
            error: 'Usage: /companion abilities <id,id,...>  e.g. /companion abilities provoke,mend',
          };
        }
        const abilityIds = rest.split(',').map(s => s.trim()).filter(Boolean);
        return {
          success: true,
          message: 'Updating companion abilities...',
          events: [{ type: 'companion_set_abilities', data: { abilityIds } }],
        };
      }

      case 'config':
        return {
          success: true,
          message: 'Requesting companion config...',
          events: [{ type: 'companion_get_config', data: {} }],
        };

      // Legacy cycle commands
      case 'next':
      case 'prev':
        return {
          success: true,
          message: `Companion cycle ${subcommand}...`,
          events: [{ type: 'companion_command', data: { mode: subcommand } }],
        };

      default:
        return { success: false, error: `Unknown subcommand: ${subcommand}` };
    }
  },
};
