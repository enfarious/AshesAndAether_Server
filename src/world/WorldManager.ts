import { logger } from '@/utils/logger';
import { ZoneService } from '@/database';
import { ZoneManager } from './ZoneManager';
import { MovementSystem } from './MovementSystem';
import type { Server as SocketIOServer } from 'socket.io';
import type { Character } from '@prisma/client';
import type { Vector3, MovementSpeed } from '@/network/protocol/types';

/**
 * Manages the entire game world - all zones and their entities
 */
export class WorldManager {
  private zones: Map<string, ZoneManager> = new Map();
  private io: SocketIOServer | null = null;
  private characterToZone: Map<string, string> = new Map(); // characterId -> zoneId for quick lookups
  private movementSystem: MovementSystem = new MovementSystem();

  /**
   * Set Socket.IO server for broadcasting
   */
  setIO(io: SocketIOServer): void {
    this.io = io;
  }

  /**
   * Initialize world manager - load all zones from database
   */
  async initialize(): Promise<void> {
    logger.info('Initializing world manager...');

    // Load all zones from database
    const allZones = await ZoneService.findAll();

    for (const zone of allZones) {
      const zoneManager = new ZoneManager(zone);
      await zoneManager.initialize();
      this.zones.set(zone.id, zoneManager);
      this.movementSystem.registerZoneManager(zone.id, zoneManager);
    }

    // Set up movement completion callback
    this.movementSystem.setMovementCompleteCallback((characterId, reason, finalPosition) => {
      logger.debug({ characterId, reason, position: finalPosition }, 'Movement completed');
      // Position is already updated in ZoneManager by update() - just send final roster
      this.sendProximityRosterToPlayer(characterId);
    });

    logger.info(`World manager initialized with ${this.zones.size} zones`);
  }

  /**
   * Get or create zone manager for a zone
   */
  async getZoneManager(zoneId: string): Promise<ZoneManager | null> {
    // Return existing zone manager
    if (this.zones.has(zoneId)) {
      return this.zones.get(zoneId)!;
    }

    // Load zone from database if not in memory
    const zone = await ZoneService.findById(zoneId);
    if (!zone) {
      logger.warn({ zoneId }, 'Zone not found in database');
      return null;
    }

    // Create and initialize new zone manager
    const zoneManager = new ZoneManager(zone);
    await zoneManager.initialize();
    this.zones.set(zoneId, zoneManager);

    logger.info({ zoneId, zoneName: zone.name }, 'Loaded zone on demand');
    return zoneManager;
  }

  /**
   * Add a player to a zone
   */
  async addPlayerToZone(character: Character, socketId: string, isMachine: boolean = false): Promise<void> {
    const zoneManager = await this.getZoneManager(character.zoneId);
    if (!zoneManager) {
      logger.error({ characterId: character.id, zoneId: character.zoneId }, 'Cannot add player to zone - zone not found');
      return;
    }

    zoneManager.addPlayer(character, socketId, isMachine);
    this.characterToZone.set(character.id, character.zoneId);

    // Send proximity roster to the player
    this.sendProximityRosterToPlayer(character.id);

    // Broadcast to nearby players that someone entered
    this.broadcastNearbyUpdate(character.zoneId);
  }

  /**
   * Remove a player from a zone
   */
  async removePlayerFromZone(characterId: string, zoneId: string): Promise<void> {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    zoneManager.removePlayer(characterId);
    this.characterToZone.delete(characterId);

    // Broadcast to nearby players that someone left
    this.broadcastNearbyUpdate(zoneId);
  }

  /**
   * Update player position (teleport) and broadcast updates
   * This is for direct position updates (teleport), not tick-based movement
   */
  async updatePlayerPosition(
    characterId: string,
    zoneId: string,
    position: { x: number; y: number; z: number }
  ): Promise<void> {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    zoneManager.updatePlayerPosition(characterId, position);

    // Broadcast state_update to nearby players
    this.broadcastPositionUpdate(characterId, zoneId, position);

    // Send updated proximity roster to the player
    this.sendProximityRosterToPlayer(characterId);

    // Broadcast to nearby players about position change
    this.broadcastNearbyUpdate(zoneId);
  }

  /**
   * Start tick-based movement toward a position or heading
   */
  async startMovement(
    characterId: string,
    zoneId: string,
    startPosition: Vector3,
    options: {
      heading?: number;
      speed: MovementSpeed;
      distance?: number;
      target?: string;
      targetPosition?: { x: number; y?: number; z: number };
      targetRange?: number;
    }
  ): Promise<boolean> {
    return this.movementSystem.startMovement({
      characterId,
      zoneId,
      startPosition,
      heading: options.heading,
      speed: options.speed,
      distance: options.distance,
      target: options.target,
      targetPosition: options.targetPosition,
      targetRange: options.targetRange ?? 5,
    });
  }

  /**
   * Stop movement for a character
   */
  stopMovement(characterId: string, zoneId: string): void {
    this.movementSystem.stopMovement({ characterId, zoneId });
  }

  /**
   * Check if a character is currently moving
   */
  isMoving(characterId: string): boolean {
    return this.movementSystem.isMoving(characterId);
  }

  /**
   * Send proximity roster to a specific player
   */
  private sendProximityRosterToPlayer(characterId: string): void {
    // Find which zone the character is in
    const zoneId = this.characterToZone.get(characterId);
    if (!zoneId) return;

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager || !this.io) return;

    const roster = zoneManager.calculateProximityRoster(characterId);
    if (!roster) return;

    const socketId = zoneManager.getSocketIdForCharacter(characterId);
    if (!socketId) return;

    // Send proximity roster to the player
    this.io.to(socketId).emit('proximity_roster', {
      ...roster,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast proximity roster updates to all nearby players in a zone
   */
  private broadcastNearbyUpdate(zoneId: string): void {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager || !this.io) return;

    // Send updated rosters to all players in the zone
    // For each character in the zone, calculate and send their updated roster
    for (const [characterId, charZoneId] of this.characterToZone.entries()) {
      if (charZoneId === zoneId) {
        this.sendProximityRosterToPlayer(characterId);
      }
    }
  }

  /**
   * Broadcast position update to all players in the zone (including the moving player)
   */
  private broadcastPositionUpdate(
    characterId: string,
    zoneId: string,
    position: Vector3
  ): void {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager || !this.io) return;

    const entity = zoneManager.getEntity(characterId);
    if (!entity) return;

    // Build state_update message
    const stateUpdate = {
      timestamp: Date.now(),
      entities: {
        updated: [{
          id: characterId,
          name: entity.name,
          type: entity.type,
          position,
        }],
      },
    };

    // Send to all players in the zone
    for (const [charId, charZoneId] of this.characterToZone.entries()) {
      if (charZoneId === zoneId) {
        const socketId = zoneManager.getSocketIdForCharacter(charId);
        if (socketId) {
          this.io.to(socketId).emit('state_update', stateUpdate);
        }
      }
    }
  }

  /**
   * Record last speaker for proximity tracking
   */
  recordLastSpeaker(zoneId: string, listenerId: string, speakerName: string): void {
    const zoneManager = this.zones.get(zoneId);
    if (zoneManager) {
      zoneManager.recordLastSpeaker(listenerId, speakerName);
    }
  }

  /**
   * Get socket IDs of players in range (for broadcasting messages)
   */
  getPlayersInRange(
    zoneId: string,
    position: { x: number; y: number; z: number },
    range: number,
    excludeCharacterId?: string
  ): string[] {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return [];

    return zoneManager.getPlayerSocketIdsInRange(position, range, excludeCharacterId);
  }

  /**
   * Update tick - called by game loop
   */
  update(deltaTime: number): void {
    // Update movement system and get position changes
    const positionUpdates = this.movementSystem.update(deltaTime);

    // Broadcast position updates to clients
    for (const [characterId, position] of positionUpdates) {
      const zoneId = this.characterToZone.get(characterId);
      if (!zoneId) continue;

      const zoneManager = this.zones.get(zoneId);
      if (!zoneManager) continue;

      // Update in-memory position in ZoneManager
      zoneManager.updatePlayerPosition(characterId, position);

      // Broadcast state_update to all players in the zone
      this.broadcastPositionUpdate(characterId, zoneId, position);
    }

    // TODO: Update world simulation
    // - Weather changes
    // - Time of day
    // - NPC AI
    // - Combat ticks
  }

  /**
   * Get world statistics
   */
  getStats(): { totalZones: number; loadedZones: number; totalPlayers: number } {
    let totalPlayers = 0;

    for (const zoneManager of this.zones.values()) {
      totalPlayers += zoneManager.getPlayerCount();
    }

    return {
      totalZones: this.zones.size,
      loadedZones: this.zones.size,
      totalPlayers,
    };
  }
}
