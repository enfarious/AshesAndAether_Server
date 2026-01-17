/**
 * Bridge between the game server and the Rust wildlife simulation service
 *
 * Responsibilities:
 * - Publish zone info and player positions to wildlife sim
 * - Subscribe to wildlife events and update game world accordingly
 */

import { logger } from '@/utils/logger';
import type { MessageBus } from '@/messaging/MessageBus';
import type { WorldManager } from '@/world/WorldManager';
import type { Vector3 } from '@/network/protocol/types';

// Wildlife event types from the Rust sim
export interface WildlifeSpawnEvent {
  type: 'Spawn';
  entity_id: string;
  species_id: string;
  position: Vector3;
  zone_id: string;
}

export interface WildlifeMoveEvent {
  type: 'Move';
  entity_id: string;
  position: Vector3;
  heading: number;
  behavior: string;
}

export interface WildlifeDeathEvent {
  type: 'Death';
  entity_id: string;
  species_id: string;
  name: string;
  position: Vector3;
  zone_id: string;
  killer_id: string | null;
  killer_species: string | null;
  cause: string;
  age: number;
  health_at_death: number;
}

export interface WildlifeAttackEvent {
  type: 'Attack';
  attacker_id: string;
  target_id: string;
  damage: number;
  position: Vector3;
}

export interface WildlifeBirthEvent {
  type: 'Birth';
  parent_id: string;
  offspring_ids: string[];
  position: Vector3;
  zone_id: string;
}

export type WildlifeEvent =
  | WildlifeSpawnEvent
  | WildlifeMoveEvent
  | WildlifeDeathEvent
  | WildlifeAttackEvent
  | WildlifeBirthEvent;

// Zone info sent to wildlife sim
export interface ZoneInfoMessage {
  id: string;
  biome: string;
  bounds_min: Vector3;
  bounds_max: Vector3;
  time_of_day: number;
}

// Player position sent to wildlife sim
export interface PlayerPositionMessage {
  id: string;
  zone_id: string;
  position: Vector3;
}

// Redis channels
const CHANNELS = {
  WILDLIFE_EVENTS: 'wildlife:events',
  WILDLIFE_PLAYERS: 'wildlife:players',
  WILDLIFE_ZONES: 'wildlife:zones',
  WILDLIFE_COMBAT: 'wildlife:combat',
};

/**
 * Species display info for client rendering
 */
const SPECIES_INFO: Record<string, { name: string; sprite: string }> = {
  rabbit: { name: 'Rabbit', sprite: 'wildlife/rabbit' },
  fox: { name: 'Fox', sprite: 'wildlife/fox' },
};

export class WildlifeBridge {
  private messageBus: MessageBus;
  private worldManager: WorldManager;
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private connected = false;

  constructor(messageBus: MessageBus, worldManager: WorldManager) {
    this.messageBus = messageBus;
    this.worldManager = worldManager;
  }

  /**
   * Start the wildlife bridge
   */
  async start(): Promise<void> {
    if (!this.messageBus.isConnected()) {
      logger.warn('MessageBus not connected, wildlife bridge cannot start');
      return;
    }

    // Subscribe to wildlife events from Rust sim
    await this.messageBus.subscribe(CHANNELS.WILDLIFE_EVENTS, (envelope) => {
      this.handleWildlifeEvent(envelope.payload as WildlifeEvent);
    });

    // Start periodic updates to wildlife sim
    this.updateInterval = setInterval(() => {
      this.publishPlayerPositions();
    }, 1000); // Every second

    this.connected = true;
    logger.info('Wildlife bridge started');
  }

  /**
   * Stop the wildlife bridge
   */
  async stop(): Promise<void> {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    if (this.connected) {
      await this.messageBus.unsubscribe(CHANNELS.WILDLIFE_EVENTS);
      this.connected = false;
    }

    logger.info('Wildlife bridge stopped');
  }

  /**
   * Publish zone info to wildlife sim (call when zone loads or time changes)
   */
  async publishZoneInfo(zoneInfo: ZoneInfoMessage): Promise<void> {
    await this.messageBus.publish(CHANNELS.WILDLIFE_ZONES, {
      type: 'ZoneInfo' as never,
      payload: { zone: zoneInfo },
      timestamp: Date.now(),
    });
  }

  /**
   * Publish all player positions to wildlife sim
   */
  private async publishPlayerPositions(): Promise<void> {
    const players: PlayerPositionMessage[] = [];

    // Gather all player positions from all zones
    // TODO: This needs WorldManager to expose a method for getting all players
    // For now, we'll implement this when we have the interface

    if (players.length > 0) {
      await this.messageBus.publish(CHANNELS.WILDLIFE_PLAYERS, {
        type: 'PlayersUpdate' as never,
        payload: { players },
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Report a player attack on wildlife
   */
  async reportPlayerAttack(playerId: string, targetId: string, damage: number): Promise<void> {
    await this.messageBus.publish(CHANNELS.WILDLIFE_COMBAT, {
      type: 'PlayerAttack' as never,
      payload: {
        player_id: playerId,
        target_id: targetId,
        damage,
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Handle events from the wildlife sim
   */
  private handleWildlifeEvent(event: WildlifeEvent): void {
    switch (event.type) {
      case 'Spawn':
        this.handleSpawn(event);
        break;
      case 'Move':
        this.handleMove(event);
        break;
      case 'Death':
        this.handleDeath(event);
        break;
      case 'Attack':
        this.handleAttack(event);
        break;
      case 'Birth':
        this.handleBirth(event);
        break;
      default:
        logger.warn({ event }, 'Unknown wildlife event type');
    }
  }

  private async handleSpawn(event: WildlifeSpawnEvent): Promise<void> {
    logger.debug({ event }, 'Wildlife spawn');

    const zoneManager = await this.worldManager.getZoneManager(event.zone_id);
    if (!zoneManager) {
      logger.warn({ zoneId: event.zone_id }, 'Zone not found for wildlife spawn');
      return;
    }

    const speciesInfo = SPECIES_INFO[event.species_id] || { name: event.species_id, sprite: 'wildlife/unknown' };

    // Add wildlife entity to zone
    zoneManager.addWildlife({
      id: event.entity_id,
      name: speciesInfo.name,
      speciesId: event.species_id,
      position: event.position,
      sprite: speciesInfo.sprite,
    });
  }

  private async handleMove(event: WildlifeMoveEvent): Promise<void> {
    // Update wildlife position in the appropriate zone
    // We don't have zone_id in move events, so we need to find it
    // For efficiency, wildlife entities should track their zone

    // TODO: Implement position update
    // This will need ZoneManager.updateWildlifePosition()
  }

  private async handleDeath(event: WildlifeDeathEvent): Promise<void> {
    logger.debug({ event }, 'Wildlife death');

    const zoneManager = await this.worldManager.getZoneManager(event.zone_id);
    if (!zoneManager) return;

    zoneManager.removeWildlife(event.entity_id);

    // If killed by a player, they might get loot/xp
    if (event.killer_id && event.cause === 'player') {
      // TODO: Award loot/xp to player
    }
  }

  private handleAttack(event: WildlifeAttackEvent): void {
    // Wildlife attacking something - could be another wildlife or a player
    logger.debug({ event }, 'Wildlife attack');

    // TODO: If target is a player, apply damage
  }

  private async handleBirth(event: WildlifeBirthEvent): Promise<void> {
    logger.debug({ event }, 'Wildlife birth');

    // Offspring will be sent as individual spawn events from the sim
    // This is just for logging/tracking purposes
  }
}