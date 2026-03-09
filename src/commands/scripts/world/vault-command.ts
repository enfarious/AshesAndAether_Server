/**
 * /vault command
 *
 * Manages vault dungeon instances — key assembly, entry, status, and exit.
 *
 * Usage:
 *   /vault enter              — consume key, create instance, enter the vault
 *   /vault assemble           — assemble a vault key from fragments (near workbench)
 *   /vault status             — show current room, enemies, party status
 *   /vault leave              — exit vault early (or after completion)
 *   /vault fragments          — check fragment count in inventory
 */

import type { CommandDefinition } from '@/commands/types';
import type { VaultManager } from '@/vault/VaultManager';

// VaultManager is injected at registration time via a factory.
let _vaultManager: VaultManager | null = null;

export function setVaultManager(manager: VaultManager): void {
  _vaultManager = manager;
}

export function getVaultManager(): VaultManager {
  if (!_vaultManager) {
    throw new Error('VaultManager not initialized. Call setVaultManager() at startup.');
  }
  return _vaultManager;
}

export const vaultCommand: CommandDefinition = {
  name: 'vault',
  aliases: ['dungeon'],
  description: 'Enter and manage instanced vault dungeons.',
  category: 'world',
  usage: '/vault <subcommand>',
  examples: [
    '/vault enter',
    '/vault assemble',
    '/vault status',
    '/vault leave',
    '/vault fragments',
  ],
  parameters: {
    positional: [
      {
        type: 'string',
        required: true,
        description: 'Subcommand: enter | assemble | status | leave | fragments',
      },
    ],
  },

  handler: async (context, args) => {
    const manager = getVaultManager();
    const sub = (args.positionalArgs[0] ?? '').toLowerCase();

    try {
      switch (sub) {

        // ── enter ──────────────────────────────────────────────────────────
        case 'enter': {
          // Check player is not already in a vault
          if (manager.isInVault(context.characterId)) {
            return {
              success: false,
              error: 'You are already inside a vault. Use /vault leave to exit.',
            };
          }

          // The actual key consumption, party lookup, instance creation, and
          // zone transfer are handled by DWM via the vault_enter event.
          return {
            success: true,
            message: 'Preparing vault entry...',
            events: [{
              type: 'vault_enter',
              data: { leaderId: context.characterId },
            }],
          };
        }

        // ── assemble ───────────────────────────────────────────────────────
        case 'assemble': {
          // The actual civic anchor proximity check, fragment consumption,
          // and key creation are handled by DWM via the vault_assemble event.
          return {
            success: true,
            message: 'Attempting to assemble vault key...',
            events: [{
              type: 'vault_assemble',
              data: {},
            }],
          };
        }

        // ── status ─────────────────────────────────────────────────────────
        case 'status': {
          const instance = manager.getInstanceForCharacter(context.characterId);
          if (!instance) {
            return {
              success: true,
              message: 'You are not currently in a vault.',
            };
          }

          const currentRoom = instance.rooms[instance.currentRoom];
          const roomsCleared = instance.rooms.filter(r => r.cleared).length;
          const onlinePlayers = Array.from(instance.participants.values())
            .filter(p => p.isOnline);

          const lines = [
            `--- Vault Status ---`,
            `Phase: ${instance.phase}`,
            `Room: ${currentRoom?.name ?? 'N/A'} (${instance.currentRoom + 1}/${instance.rooms.length})`,
            `Rooms cleared: ${roomsCleared}/${instance.rooms.length}`,
            `Enemies remaining: ${currentRoom?.activeMobIds.size ?? 0}`,
            `Scaling: ${instance.scalingTier} (${instance.groupSize} player${instance.groupSize !== 1 ? 's' : ''})`,
            `Party online: ${onlinePlayers.map(p => p.name).join(', ') || 'none'}`,
          ];

          if (currentRoom?.isBossRoom) {
            lines.push('** BOSS ROOM **');
          }

          return {
            success: true,
            message: lines.join('\n'),
            data: {
              instanceId: instance.instanceId,
              phase: instance.phase,
              currentRoom: instance.currentRoom,
              roomsCleared,
              totalRooms: instance.rooms.length,
              enemiesRemaining: currentRoom?.activeMobIds.size ?? 0,
              scalingTier: instance.scalingTier,
            },
          };
        }

        // ── leave ──────────────────────────────────────────────────────────
        case 'leave': {
          if (!manager.isInVault(context.characterId)) {
            return {
              success: false,
              error: 'You are not in a vault.',
            };
          }

          // DWM handles the zone transfer back to overworld
          return {
            success: true,
            message: 'Leaving vault...',
            events: [{
              type: 'vault_leave',
              data: {},
            }],
          };
        }

        // ── fragments ──────────────────────────────────────────────────────
        case 'fragments': {
          // DWM handles the inventory query via vault_fragments event
          return {
            success: true,
            message: 'Checking fragments...',
            events: [{
              type: 'vault_fragments',
              data: {},
            }],
          };
        }

        // ── unknown ────────────────────────────────────────────────────────
        default: {
          return {
            success: false,
            error:
              `Unknown subcommand '${sub}'. ` +
              `Use: enter | assemble | status | leave | fragments`,
          };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  },
};
