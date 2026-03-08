/**
 * Command scripts index - auto-loads all command definitions
 */

import { CommandRegistry } from '../CommandRegistry';

// Import all command scripts
import { sayCommand } from './social/say';
import { tellCommand } from './social/tell';
import { emoteCommand } from './social/emote';
import { shoutCommand } from './social/shout';
import { talkCommand } from './social/talk';
import { partyCommand } from './social/party';
import { attackCommand } from './combat/attack';
import { castCommand } from './combat/cast';
import { disengageCommand } from './combat/disengage';
import { useCommand } from './inventory/use';
import { equipCommand } from './inventory/equip';
import { unequipCommand } from './inventory/unequip';

import { lookCommand } from './perception/look';
import { listenCommand } from './perception/listen';
import { senseCommand } from './perception/sense';

import { helpCommand } from './system/help';
import { statsCommand } from './system/stats';
import { inventoryCommand } from './system/inventory';
import { abilitiesCommand } from './system/abilities';

import { moveCommand } from './movement/move';
import { stopCommand } from './movement/stop';
import { companionCommand } from './world/companion';
import { harvestCommand } from './world/harvest';
import { unstuckCommand } from './world/unstuck';
import { returnCommand } from './world/return';
import { villageCommand } from './world/village';
import { arenaCommand, setArenaManager } from './world/arena-command';
export { setArenaManager };
import { vaultCommand, setVaultManager } from './world/vault-command';
export { setVaultManager };
import { objectCommand, editCommand, undoCommand, doVerbCommand } from './world/object';
import { marketCommand } from './market/market';
import { guildCommand } from './social/guild';
import { beaconCommand } from './world/beacon';
import { libraryCommand } from './world/library';
import { gmCommand } from './admin/gm';

/**
 * Register all Phase 1 commands
 */
export function registerAllCommands(registry: CommandRegistry): void {
  // Social commands
  registry.register(sayCommand);
  registry.register(tellCommand);
  registry.register(emoteCommand);
  registry.register(shoutCommand);
  registry.register(talkCommand);
  registry.register(partyCommand);

  // Perception commands
  registry.register(lookCommand);
  registry.register(listenCommand);
  registry.register(senseCommand);

  // System commands
  registry.register(helpCommand);
  registry.register(statsCommand);
  registry.register(inventoryCommand);
  registry.register(abilitiesCommand);
  registry.register(useCommand);
  registry.register(equipCommand);
  registry.register(unequipCommand);

  // Movement commands
  registry.register(moveCommand);
  registry.register(stopCommand);

  // World commands
  registry.register(companionCommand);
  registry.register(harvestCommand);
  registry.register(unstuckCommand);
  registry.register(returnCommand);
  registry.register(villageCommand);
  registry.register(arenaCommand);
  registry.register(vaultCommand);
  registry.register(objectCommand);
  registry.register(editCommand);
  registry.register(undoCommand);
  registry.register(doVerbCommand);

  // Market commands
  registry.register(marketCommand);

  // Guild commands
  registry.register(guildCommand);
  registry.register(beaconCommand);
  registry.register(libraryCommand);

  // Combat commands
  registry.register(attackCommand);
  registry.register(castCommand);
  registry.register(disengageCommand);

  // Admin commands
  registry.register(gmCommand);
}

/**
 * Get list of all registered command names (for documentation)
 */
export function getAllCommandNames(): string[] {
  return [
    // Social
    'say', 'tell', 'emote', 'shout', 'talk', 'party',
    // Perception
    'look', 'listen', 'sense',
    // System
    'help', 'stats', 'inventory', 'use',
    'equip', 'unequip',
    // Movement
    'move', 'stop',
    // World
    'companion', 'beacon', 'library',
    // Guild
    'guild',
    // Market
    'market',
    // Combat
    'attack', 'cast', 'disengage',
  ];
}
