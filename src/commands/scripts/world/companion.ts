/**
 * /companion command — Player companion control.
 *
 * Subcommands:
 *   status     — Show companion mode, task, and harvest stats
 *   follow     — Enter ACTIVE mode, companion follows player
 *   detach     — Enter DETACHED mode, companion idles
 *   task <d>   — Enter TASKED mode, LLM generates behavior tree from description
 *   harvest    — Enter TASKED mode with the default harvest tree (no LLM call)
 *   recall     — Navigate to player and enter ACTIVE mode
 *   report     — LLM summarizes recent activity
 *   archetype  — Set companion archetype
 *   configure  — Adjust combat settings
 *   abilities  — View/manage active ability loadout
 *   passives   — View/manage passive ability loadout
 *   config     — View current companion config
 *   next/prev  — Cycle companions (legacy)
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

const VALID_ARCHETYPES = new Set(['scrappy_fighter', 'cautious_healer', 'opportunist', 'tank']);

const SUBCOMMANDS = new Set([
  'status', 'follow', 'detach', 'task', 'harvest', 'recall', 'report', 'next', 'prev',
  'archetype', 'configure', 'abilities', 'passives', 'config',
]);

export const companionCommand: CommandDefinition = {
  name: 'companion',
  aliases: ['comp'],
  description: 'Control your companion — follow, detach, task, harvest, recall, report, status, abilities, passives',
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
    '/companion abilities',
    '/companion abilities slot 0 active_tank_t1',
    '/companion abilities unslot 3',
    '/companion passives',
    '/companion passives slot 0 passive_tank_t1',
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
        error: 'Usage: /companion <status|follow|detach|task|harvest|recall|report|abilities|passives>',
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
            case 'range':
              if (['close', 'mid', 'long'].includes(val)) {
                settings.preferredRange = val;
              }
              break;
            case 'priority': settings.priority = val; break;
            case 'retreat':  settings.retreatThreshold = parseFloat(val); break;
            case 'engagementmode': settings.engagementMode = val; break;
            case 'damage': case 'cc': case 'heal':
              weights[key] = parseFloat(val);
              break;
            // Healing / recovery
            case 'healallyth':     settings.healAllyThreshold = parseFloat(val); break;
            case 'minhealtarget':  settings.minHealTarget = parseFloat(val); break;
            case 'healprio':       settings.healPriorityMode = val; break;
            case 'defensiveth':    settings.defensiveThreshold = parseFloat(val); break;
            // Buff / cooldown
            case 'savecds':        settings.saveCooldownsForElites = val === 'true'; break;
            case 'minenemyhp':     settings.minEnemyHpForBuffs = parseFloat(val); break;
            // Resource
            case 'reserve':        settings.resourceReservePercent = parseFloat(val); break;
            // Engagement lists (comma-separated)
            case 'ignorefamily':        settings.ignoreFamily = val.split(',').filter(Boolean); break;
            case 'alwaysengagefamily':  settings.alwaysEngageFamily = val.split(',').filter(Boolean); break;
            case 'ignorespecies':       settings.ignoreSpecies = val.split(',').filter(Boolean); break;
            case 'alwaysengagespecies': settings.alwaysEngageSpecies = val.split(',').filter(Boolean); break;
          }
        }
        if (Object.keys(weights).length > 0) settings.abilityWeights = weights;
        return {
          success: true,
          message: 'Updating companion combat settings...',
          events: [{ type: 'companion_configure', data: { settings } }],
        };
      }

      // ── Active ability loadout management ────────────────────────────────

      case 'abilities': {
        if (!rest) {
          // No args — view current active loadout
          return {
            success: true,
            message: 'Viewing companion active loadout...',
            events: [{ type: 'companion_view_active_loadout', data: {} }],
          };
        }

        const parts = rest.split(/\s+/);
        const action = parts[0]?.toLowerCase();

        if (action === 'slot') {
          const slotIndex = parseInt(parts[1] ?? '', 10);
          const nodeId = parts[2];
          if (isNaN(slotIndex) || !nodeId) {
            return {
              success: false,
              error: 'Usage: /companion abilities slot <index 0-7> <nodeId>',
            };
          }
          return {
            success: true,
            message: `Slotting ${nodeId} into active slot ${slotIndex}...`,
            events: [{ type: 'companion_slot_active', data: { slotIndex, nodeId } }],
          };
        }

        if (action === 'unslot') {
          const slotIndex = parseInt(parts[1] ?? '', 10);
          if (isNaN(slotIndex)) {
            return {
              success: false,
              error: 'Usage: /companion abilities unslot <index 0-7>',
            };
          }
          return {
            success: true,
            message: `Clearing active slot ${slotIndex}...`,
            events: [{ type: 'companion_unslot_active', data: { slotIndex } }],
          };
        }

        // Legacy: comma-separated ability IDs
        const abilityIds = rest.split(',').map(s => s.trim()).filter(Boolean);
        return {
          success: true,
          message: 'Updating companion abilities...',
          events: [{ type: 'companion_set_abilities', data: { abilityIds } }],
        };
      }

      // ── Passive ability loadout management ──────────────────────────────

      case 'passives': {
        if (!rest) {
          // No args — view current passive loadout
          return {
            success: true,
            message: 'Viewing companion passive loadout...',
            events: [{ type: 'companion_view_passive_loadout', data: {} }],
          };
        }

        const parts = rest.split(/\s+/);
        const action = parts[0]?.toLowerCase();

        if (action === 'slot') {
          const slotIndex = parseInt(parts[1] ?? '', 10);
          const nodeId = parts[2];
          if (isNaN(slotIndex) || !nodeId) {
            return {
              success: false,
              error: 'Usage: /companion passives slot <index 0-7> <nodeId>',
            };
          }
          return {
            success: true,
            message: `Slotting ${nodeId} into passive slot ${slotIndex}...`,
            events: [{ type: 'companion_slot_passive', data: { slotIndex, nodeId } }],
          };
        }

        if (action === 'unslot') {
          const slotIndex = parseInt(parts[1] ?? '', 10);
          if (isNaN(slotIndex)) {
            return {
              success: false,
              error: 'Usage: /companion passives unslot <index 0-7>',
            };
          }
          return {
            success: true,
            message: `Clearing passive slot ${slotIndex}...`,
            events: [{ type: 'companion_unslot_passive', data: { slotIndex } }],
          };
        }

        return {
          success: false,
          error: 'Usage: /companion passives [slot <index> <nodeId> | unslot <index>]',
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
