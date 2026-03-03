/**
 * /arena command
 *
 * Manages dueling arena instances.
 *
 * Usage:
 *   /arena create              — spin up your personal instance
 *   /arena open                — open instance to spectators
 *   /arena spawn dummy         — place the training dummy in the ring
 *   /arena spawn companion     — bring your active companion in as a combatant
 *   /arena start               — begin 3..2..1 countdown
 *   /arena end                 — end combat and show summary
 *   /arena disband             — tear down your instance
 *   /arena list                — list open instances you can spectate
 *   /arena join <instanceId>   — join an open instance as spectator
 *   /arena status              — show current instance phase
 */

import type { CommandDefinition } from '@/commands/types';
import type { ArenaManager } from '@/arena/ArenaManager';

// ArenaManager is injected at registration time via a factory.
// This keeps the command definition stateless and testable.
let _arenaManager: ArenaManager | null = null;

export function setArenaManager(manager: ArenaManager): void {
  _arenaManager = manager;
}

function getManager(): ArenaManager {
  if (!_arenaManager) {
    throw new Error('ArenaManager not initialized. Call setArenaManager() at startup.');
  }
  return _arenaManager;
}

export const arenaCommand: CommandDefinition = {
  name: 'arena',
  aliases: ['duel'],
  description: 'Create and manage instanced dueling arenas.',
  category: 'world',
  usage: '/arena <subcommand> [args]',
  examples: [
    '/arena create',
    '/arena spawn dummy',
    '/arena spawn companion',
    '/arena open',
    '/arena start',
    '/arena end',
    '/arena disband',
    '/arena list',
    '/arena join <instanceId>',
    '/arena status',
  ],
  parameters: {
    positional: [
      {
        type: 'string',
        required: true,
        description: 'Subcommand: create | open | spawn | start | end | disband | list | join | status',
      },
      {
        type: 'string',
        required: false,
        description: 'Argument for subcommand (e.g. "dummy", "companion", instanceId)',
      },
    ],
  },

  handler: async (context, args) => {
    const manager = getManager();
    const sub = (args.positionalArgs[0] ?? '').toLowerCase();
    const arg = (args.positionalArgs[1] ?? '').toLowerCase();

    // context.characterName may not exist on the base type — we cast safely
    const characterName: string =
      (context as Record<string, unknown>).characterName as string ?? 'Unknown';

    try {
      switch (sub) {

        // ── create ─────────────────────────────────────────────────────────
        case 'create': {
          const instanceId = manager.create(context.characterId, characterName);
          return {
            success: true,
            message:
              `Arena instance created! (${instanceId.slice(0, 8)}...)\n` +
              `You're in SETUP phase. Commands:\n` +
              `  /arena spawn dummy      — place training dummy\n` +
              `  /arena spawn companion  — bring your companion\n` +
              `  /arena open             — allow spectators\n` +
              `  /arena start            — begin countdown`,
            data: { instanceId },
          };
        }

        // ── open ───────────────────────────────────────────────────────────
        case 'open': {
          manager.open(context.characterId);
          const instance = manager.getInstanceForCharacter(context.characterId)!;
          return {
            success: true,
            message: `Arena is now open to spectators. Instance ID: ${instance.instanceId.slice(0, 8)}...`,
            data: { instanceId: instance.instanceId },
          };
        }

        // ── spawn ──────────────────────────────────────────────────────────
        case 'spawn': {
          if (!arg) {
            return {
              success: false,
              error: 'Usage: /arena spawn dummy | /arena spawn companion',
            };
          }

          if (arg === 'dummy') {
            // Dummy entity ID and name come from the zone template.
            // For now, we use a well-known sentinel ID that DistributedWorldManager
            // resolves to the ARENA_DUEL_TEMPLATE companion at runtime.
            const dummyEntityId = `dummy:${context.characterId}`;
            manager.spawnDummy(context.characterId, dummyEntityId, 'Training Dummy');
            return {
              success: true,
              message: 'Training dummy placed at ring center. It will not fight back.',
              data: { dummyId: dummyEntityId },
            };
          }

          if (arg === 'companion') {
            // Companion ID is resolved by the caller (DistributedWorldManager)
            // which knows which companion is active for this character.
            // We signal intent here; DWM handles the actual entity lookup.
            return {
              success: true,
              message:
                'Requesting companion placement... (DistributedWorldManager will resolve active companion)',
              data: { action: 'spawn_companion', ownerId: context.characterId },
            };
          }

          return {
            success: false,
            error: `Unknown spawn target: '${arg}'. Use 'dummy' or 'companion'.`,
          };
        }

        // ── start ──────────────────────────────────────────────────────────
        case 'start': {
          manager.startCountdown(context.characterId);
          return {
            success: true,
            message: 'Countdown started. Get ready!',
          };
        }

        // ── end ────────────────────────────────────────────────────────────
        case 'end': {
          const summary = manager.endCombat(context.characterId);
          const lines = ['--- Arena Summary ---'];
          for (const p of summary.participants) {
            if (p.role === 'spectator') continue;
            lines.push(
              `${p.name}: ${p.damageDealt} dmg dealt, ` +
              `${p.hitsLanded} hits, ` +
              `${p.damageTaken} dmg taken`
            );
          }
          lines.push(`Duration: ${summary.duration}s`);
          return {
            success: true,
            message: lines.join('\n'),
            data: { summary },
          };
        }

        // ── disband ────────────────────────────────────────────────────────
        case 'disband': {
          manager.disband(context.characterId);
          return {
            success: true,
            message: 'Arena instance disbanded.',
          };
        }

        // ── list ───────────────────────────────────────────────────────────
        case 'list': {
          const open = manager.listOpenInstances();
          if (open.length === 0) {
            return {
              success: true,
              message: 'No open arena instances right now.',
            };
          }
          const lines = ['Open arenas:'];
          for (const a of open) {
            lines.push(
              `  ${a.instanceId.slice(0, 8)}...  ` +
              `Owner: ${a.ownerName}  ` +
              `Spectators: ${a.spectatorCount}`
            );
          }
          lines.push('Use /arena join <id> to spectate.');
          return {
            success: true,
            message: lines.join('\n'),
            data: { instances: open },
          };
        }

        // ── join ───────────────────────────────────────────────────────────
        case 'join': {
          const instanceId = args.positionalArgs[1];
          if (!instanceId) {
            return { success: false, error: 'Usage: /arena join <instanceId>' };
          }
          manager.joinAsSpectator(context.characterId, characterName, instanceId);
          return {
            success: true,
            message: `You've joined as a spectator. Enjoy the show.`,
            data: { instanceId },
          };
        }

        // ── status ─────────────────────────────────────────────────────────
        case 'status': {
          const instance = manager.getInstanceForCharacter(context.characterId);
          if (!instance) {
            return {
              success: true,
              message: 'You are not currently in an arena instance.',
            };
          }
          const participant = instance.participants.get(context.characterId);
          const lines = [
            `Instance: ${instance.instanceId.slice(0, 8)}...`,
            `Phase:    ${instance.phase}`,
            `Open:     ${instance.isOpen ? 'yes' : 'no'}`,
            `Your role: ${participant?.role ?? 'unknown'}`,
            `Participants: ${instance.participants.size}`,
          ];
          if (instance.phase === 'COUNTDOWN') {
            lines.push(`Countdown: ${instance.countdownRemaining}s remaining`);
          }
          return {
            success: true,
            message: lines.join('\n'),
            data: {
              instanceId: instance.instanceId,
              phase: instance.phase,
              participantCount: instance.participants.size,
            },
          };
        }

        // ── unknown ────────────────────────────────────────────────────────
        default: {
          return {
            success: false,
            error:
              `Unknown subcommand '${sub}'. ` +
              `Use: create | open | spawn | start | end | disband | list | join | status`,
          };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  },
};
