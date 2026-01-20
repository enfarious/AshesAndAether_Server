import { logger } from '@/utils/logger';
import { ZoneService } from '@/database';
import { COMMUNICATION_RANGES } from '@/network/protocol/types';
import type {
  ProximityRosterMessage,
  ProximityChannel,
  ProximityRosterDeltaMessage,
  ProximityChannelDelta,
  ProximityEntity,
  ProximityEntityDelta
} from '@/network/protocol/types';
import type { Character, Zone } from '@prisma/client';

interface Vector3 {
  x: number;
  y: number;
  z: number;
}

interface Entity {
  id: string;
  name: string;
  type: 'player' | 'npc' | 'companion' | 'mob' | 'wildlife';
  position: Vector3;
  socketId?: string; // For players only
  inCombat?: boolean;
  isMachine: boolean;
  isAlive: boolean;
  // Wildlife-specific fields
  speciesId?: string;
  sprite?: string;
  heading?: number;
  behavior?: string;
}

export interface WildlifeEntityData {
  id: string;
  name: string;
  speciesId: string;
  position: Vector3;
  sprite: string;
  heading?: number;
}

/**
 * Manages a single zone - tracks entities, calculates proximity, broadcasts updates
 */
export class ZoneManager {
  private zone: Zone;
  private entities: Map<string, Entity> = new Map();
  private lastSpeaker: Map<string, { speaker: string; timestamp: number }> = new Map(); // entityId -> lastSpeaker info

  constructor(zone: Zone) {
    this.zone = zone;
  }

  /**
   * Initialize zone with entities from database
   */
  async initialize(): Promise<void> {
    logger.info({ zoneId: this.zone.id, zoneName: this.zone.name }, 'Initializing zone');

    // Load companions (NPCs) in this zone
    const companions = await ZoneService.getCompanionsInZone(this.zone.id);

    for (const companion of companions) {
      const isMob = companion.tag?.startsWith('mob.') === true;
      this.entities.set(companion.id, {
        id: companion.id,
        name: companion.name,
        type: isMob ? 'mob' : 'companion',
        position: {
          x: companion.positionX,
          y: companion.positionY,
          z: companion.positionZ,
        },
        inCombat: false,
        isMachine: true,
        isAlive: companion.isAlive ?? true,
      });
    }

    logger.info(
      { zoneId: this.zone.id, entityCount: this.entities.size },
      'Zone initialized with entities'
    );
  }

  /**
   * Add a player to the zone
   */
  addPlayer(character: Character, socketId: string, isMachine: boolean = false): void {
    const entity: Entity = {
      id: character.id,
      name: character.name,
      type: 'player',
      position: {
        x: character.positionX,
        y: character.positionY,
        z: character.positionZ,
      },
      socketId,
      inCombat: false,
      isMachine,
      isAlive: character.isAlive ?? true,
    };

    this.entities.set(character.id, entity);
    logger.info({ characterId: character.id, characterName: character.name, zoneId: this.zone.id }, 'Player entered zone');
  }

  /**
   * Remove a player from the zone
   */
  removePlayer(characterId: string): void {
    const entity = this.entities.get(characterId);
    if (entity) {
      this.entities.delete(characterId);
      logger.info({ characterId, characterName: entity.name, zoneId: this.zone.id }, 'Player left zone');
    }
  }

  /**
   * Update player position
   */
  updatePlayerPosition(characterId: string, position: Vector3): void {
    const entity = this.entities.get(characterId);
    if (entity) {
      entity.position = position;
    }
  }

  setCompanionSocketId(companionId: string, socketId: string | null): void {
    const entity = this.entities.get(companionId);
    if (entity && entity.type === 'companion') {
      entity.socketId = socketId || undefined;
    }
  }

  /**
   * Set combat state for an entity
   */
  setEntityCombatState(entityId: string, inCombat: boolean): void {
    const entity = this.entities.get(entityId);
    if (entity) {
      entity.inCombat = inCombat;
    }
  }

  setEntityAlive(entityId: string, isAlive: boolean): void {
    const entity = this.entities.get(entityId);
    if (entity) {
      entity.isAlive = isAlive;
    }
  }

  getEntity(entityId: string): Entity | null {
    return this.entities.get(entityId) || null;
  }

  findEntityByName(name: string): Entity | null {
    const needle = name.trim().toLowerCase();
    if (!needle) return null;

    for (const entity of this.entities.values()) {
      if (entity.name.toLowerCase() === needle) {
        return entity;
      }
    }

    return null;
  }

  /**
   * Record who last spoke to a specific entity
   */
  recordLastSpeaker(listenerId: string, speakerName: string): void {
    this.lastSpeaker.set(listenerId, {
      speaker: speakerName,
      timestamp: Date.now(),
    });

    // Clear after 30 seconds
    setTimeout(() => {
      const record = this.lastSpeaker.get(listenerId);
      if (record && record.speaker === speakerName) {
        this.lastSpeaker.delete(listenerId);
      }
    }, 30000);
  }

  /**
   * Calculate 3D distance between two positions
   */
  private calculateDistance(pos1: Vector3, pos2: Vector3): number {
    const dx = pos2.x - pos1.x;
    const dy = pos2.y - pos1.y;
    const dz = pos2.z - pos1.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Calculate bearing from origin to target (0-360 degrees)
   * 0 = North, 90 = East, 180 = South, 270 = West
   */
  private calculateBearing(origin: Vector3, target: Vector3): number {
    const dx = target.x - origin.x;
    const dz = target.z - origin.z;

    // Calculate angle in radians, then convert to degrees
    let bearing = Math.atan2(dx, dz) * (180 / Math.PI);

    // Normalize to 0-360 range
    if (bearing < 0) {
      bearing += 360;
    }

    return Math.round(bearing);
  }

  /**
   * Calculate elevation angle from origin to target (-90 to 90 degrees)
   * Negative = target is below, Positive = target is above
   */
  private calculateElevation(origin: Vector3, target: Vector3): number {
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const dz = target.z - origin.z;

    // Calculate horizontal distance
    const horizontalDistance = Math.sqrt(dx * dx + dz * dz);

    // Calculate elevation angle in radians, then convert to degrees
    const elevation = Math.atan2(dy, horizontalDistance) * (180 / Math.PI);

    return Math.round(elevation);
  }

  /**
   * Get entities within a specific range of a position
   */
  private getEntitiesInRange(origin: Vector3, range: number, excludeId?: string): Entity[] {
    const nearbyEntities: Entity[] = [];

    for (const entity of this.entities.values()) {
      if (entity.id === excludeId) continue;
      if (!entity.isAlive && entity.id !== excludeId) continue;

      const distance = this.calculateDistance(origin, entity.position);
      if (distance <= range) {
        nearbyEntities.push(entity);
      }
    }

    // Sort by distance (closest first)
    nearbyEntities.sort((a, b) => {
      const distA = this.calculateDistance(origin, a.position);
      const distB = this.calculateDistance(origin, b.position);
      return distA - distB;
    });

    return nearbyEntities;
  }

  /**
   * Build proximity channel data
   */
  private buildProximityChannel(
    entities: Entity[],
    listenerId: string,
    listenerPosition: Vector3
  ): ProximityChannel {
    const count = entities.length;

    // ALWAYS include spatial navigation data for all entities (combat targeting, movement)
    const entitiesWithSpatialData = entities.map(entity => {
      const range = this.calculateDistance(listenerPosition, entity.position);
      const bearing = this.calculateBearing(listenerPosition, entity.position);
      const elevation = this.calculateElevation(listenerPosition, entity.position);

      return {
        id: entity.id,
        name: entity.name,
        type: entity.type,
        isMachine: entity.isMachine,
        isAlive: entity.isAlive,
        bearing,
        elevation,
        range: Math.round(range * 100) / 100, // Round to 2 decimal places
      };
    });

    const channel: ProximityChannel = {
      count,
      entities: entitiesWithSpatialData,
    };

    // Add sample names ONLY if 1-3 entities (for social context/LLM chat)
    if (count > 0 && count <= 3) {
      channel.sample = entities.map(e => e.name);

      // Add lastSpeaker if available
      const lastSpeakerRecord = this.lastSpeaker.get(listenerId);
      if (lastSpeakerRecord && channel.sample.includes(lastSpeakerRecord.speaker)) {
        channel.lastSpeaker = lastSpeakerRecord.speaker;
      }
    }

    return channel;
  }

  /**
   * Generate a hash of the proximity roster for dirty checking
   */
  private hashProximityRoster(roster: ProximityRosterMessage['payload']): string {
    // Create a simple hash from entity IDs and danger state
    const parts: string[] = [];

    for (const channel of ['touch', 'say', 'shout', 'emote', 'see', 'hear', 'cfh'] as const) {
      const ch = roster.channels[channel];
      const entityIds = ch.entities.map(e => `${e.id}:${e.range.toFixed(1)}`).sort().join(',');
      parts.push(`${channel}:${entityIds}`);
    }

    parts.push(`danger:${roster.dangerState}`);

    return parts.join('|');
  }

  /**
   * Calculate proximity roster for a specific entity
   * Returns null if roster hasn't changed (for optimization)
   */
  calculateProximityRoster(entityId: string, previousHash?: string): { roster: ProximityRosterMessage['payload']; hash: string } | null {
    const entity = this.entities.get(entityId);
    if (!entity) return null;

    const position = entity.position;

    // Get entities in each range
    const inTouch = this.getEntitiesInRange(position, COMMUNICATION_RANGES.touch, entityId);
    const inSay = this.getEntitiesInRange(position, COMMUNICATION_RANGES.say, entityId);
    const inShout = this.getEntitiesInRange(position, COMMUNICATION_RANGES.shout, entityId);
    const inEmote = this.getEntitiesInRange(position, COMMUNICATION_RANGES.emote, entityId);
    const inSee = this.getEntitiesInRange(position, COMMUNICATION_RANGES.see, entityId);
    const inHear = this.getEntitiesInRange(position, COMMUNICATION_RANGES.hear, entityId);
    const inCFH = this.getEntitiesInRange(position, COMMUNICATION_RANGES.cfh, entityId);

    // Build proximity channels with spatial data
    const roster: ProximityRosterMessage['payload'] = {
      channels: {
        touch: this.buildProximityChannel(inTouch, entityId, position),
        say: this.buildProximityChannel(inSay, entityId, position),
        shout: this.buildProximityChannel(inShout, entityId, position),
        emote: this.buildProximityChannel(inEmote, entityId, position),
        see: this.buildProximityChannel(inSee, entityId, position),
        hear: this.buildProximityChannel(inHear, entityId, position),
        cfh: this.buildProximityChannel(inCFH, entityId, position),
      },
      dangerState: entity.inCombat || false,
    };

    // Generate hash for dirty checking
    const hash = this.hashProximityRoster(roster);

    // If hash matches previous, roster hasn't changed
    if (previousHash && hash === previousHash) {
      return null;
    }

    return { roster, hash };
  }

  /**
   * Calculate proximity roster delta (only changes)
   * Returns null if roster hasn't changed
   */
  calculateProximityRosterDelta(
    entityId: string,
    previousRoster?: ProximityRosterMessage['payload']
  ): { delta: ProximityRosterDeltaMessage['payload']; roster: ProximityRosterMessage['payload'] } | null {
    const entity = this.entities.get(entityId);
    if (!entity) return null;

    const position = entity.position;

    // Get entities in each range
    const inTouch = this.getEntitiesInRange(position, COMMUNICATION_RANGES.touch, entityId);
    const inSay = this.getEntitiesInRange(position, COMMUNICATION_RANGES.say, entityId);
    const inShout = this.getEntitiesInRange(position, COMMUNICATION_RANGES.shout, entityId);
    const inEmote = this.getEntitiesInRange(position, COMMUNICATION_RANGES.emote, entityId);
    const inSee = this.getEntitiesInRange(position, COMMUNICATION_RANGES.see, entityId);
    const inHear = this.getEntitiesInRange(position, COMMUNICATION_RANGES.hear, entityId);
    const inCFH = this.getEntitiesInRange(position, COMMUNICATION_RANGES.cfh, entityId);

    // Build new roster
    const newRoster: ProximityRosterMessage['payload'] = {
      channels: {
        touch: this.buildProximityChannel(inTouch, entityId, position),
        say: this.buildProximityChannel(inSay, entityId, position),
        shout: this.buildProximityChannel(inShout, entityId, position),
        emote: this.buildProximityChannel(inEmote, entityId, position),
        see: this.buildProximityChannel(inSee, entityId, position),
        hear: this.buildProximityChannel(inHear, entityId, position),
        cfh: this.buildProximityChannel(inCFH, entityId, position),
      },
      dangerState: entity.inCombat || false,
    };

    // If no previous roster, return full roster as delta (first time)
    if (!previousRoster) {
      return {
        delta: {
          channels: {
            touch: this.channelToDelta(newRoster.channels.touch, null),
            say: this.channelToDelta(newRoster.channels.say, null),
            shout: this.channelToDelta(newRoster.channels.shout, null),
            emote: this.channelToDelta(newRoster.channels.emote, null),
            see: this.channelToDelta(newRoster.channels.see, null),
            hear: this.channelToDelta(newRoster.channels.hear, null),
            cfh: this.channelToDelta(newRoster.channels.cfh, null),
          },
          dangerState: newRoster.dangerState,
        },
        roster: newRoster,
      };
    }

    // Calculate delta for each channel
    const delta: ProximityRosterDeltaMessage['payload'] = {
      channels: {},
    };

    let hasChanges = false;

    for (const channel of ['touch', 'say', 'shout', 'emote', 'see', 'hear', 'cfh'] as const) {
      const channelDelta = this.calculateChannelDelta(
        newRoster.channels[channel],
        previousRoster.channels[channel]
      );

      if (channelDelta) {
        delta.channels![channel] = channelDelta;
        hasChanges = true;
      }
    }

    // Check danger state change
    if (newRoster.dangerState !== previousRoster.dangerState) {
      delta.dangerState = newRoster.dangerState;
      hasChanges = true;
    }

    // If nothing changed, return null
    if (!hasChanges) {
      return null;
    }

    return { delta, roster: newRoster };
  }

  /**
   * Convert full channel to delta (for first-time send)
   */
  private channelToDelta(channel: ProximityChannel, _previous: null): ProximityChannelDelta {
    return {
      added: channel.entities,
      count: channel.count,
      sample: channel.sample,
      lastSpeaker: channel.lastSpeaker,
    };
  }

  /**
   * Calculate delta between two proximity channels
   */
  private calculateChannelDelta(
    newChannel: ProximityChannel,
    oldChannel: ProximityChannel
  ): ProximityChannelDelta | null {
    const delta: ProximityChannelDelta = {};
    let hasChanges = false;

    // Create entity maps for quick lookup
    const oldEntitiesMap = new Map(oldChannel.entities.map(e => [e.id, e]));
    const newEntitiesMap = new Map(newChannel.entities.map(e => [e.id, e]));

    // Find added entities
    const added: ProximityEntity[] = [];
    for (const entity of newChannel.entities) {
      if (!oldEntitiesMap.has(entity.id)) {
        added.push(entity);
      }
    }

    // Find removed entities
    const removed: string[] = [];
    for (const entity of oldChannel.entities) {
      if (!newEntitiesMap.has(entity.id)) {
        removed.push(entity.id);
      }
    }

    // Find updated entities (position changed)
    const updated: ProximityEntityDelta[] = [];
    for (const entity of newChannel.entities) {
      const oldEntity = oldEntitiesMap.get(entity.id);
      if (oldEntity) {
        const entityDelta: ProximityEntityDelta = { id: entity.id };
        let entityChanged = false;

        if (entity.bearing !== oldEntity.bearing) {
          entityDelta.bearing = entity.bearing;
          entityChanged = true;
        }

        if (entity.elevation !== oldEntity.elevation) {
          entityDelta.elevation = entity.elevation;
          entityChanged = true;
        }

        if (entity.range !== oldEntity.range) {
          entityDelta.range = entity.range;
          entityChanged = true;
        }

        if (entityChanged) {
          updated.push(entityDelta);
        }
      }
    }

    // Add to delta if there are changes
    if (added.length > 0) {
      delta.added = added;
      hasChanges = true;
    }

    if (removed.length > 0) {
      delta.removed = removed;
      hasChanges = true;
    }

    if (updated.length > 0) {
      delta.updated = updated;
      hasChanges = true;
    }

    // Check count change
    if (newChannel.count !== oldChannel.count) {
      delta.count = newChannel.count;
      hasChanges = true;
    }

    // Check sample array change
    const oldSampleStr = JSON.stringify(oldChannel.sample || []);
    const newSampleStr = JSON.stringify(newChannel.sample || []);
    if (oldSampleStr !== newSampleStr) {
      delta.sample = newChannel.sample;
      hasChanges = true;
    }

    // Check lastSpeaker change
    if (newChannel.lastSpeaker !== oldChannel.lastSpeaker) {
      delta.lastSpeaker = newChannel.lastSpeaker || null;
      hasChanges = true;
    }

    return hasChanges ? delta : null;
  }

  /**
   * Get all player socket IDs in the zone
   */
  getPlayerSocketIds(): string[] {
    const socketIds: string[] = [];
    for (const entity of this.entities.values()) {
      if (entity.type === 'player' && entity.socketId) {
        socketIds.push(entity.socketId);
      }
    }
    return socketIds;
  }

  /**
   * Get socket ID for a specific character
   */
  getSocketIdForCharacter(characterId: string): string | null {
    const entity = this.entities.get(characterId);
    return entity?.socketId || null;
  }

  getSocketIdForEntity(entityId: string): string | null {
    const entity = this.entities.get(entityId);
    return entity?.socketId || null;
  }

  getCompanionSocketIdsInRange(origin: Vector3, range: number, excludeId?: string): string[] {
    const nearbyEntities = this.getEntitiesInRange(origin, range, excludeId);
    const socketIds: string[] = [];

    for (const entity of nearbyEntities) {
      if (entity.type === 'companion' && entity.socketId) {
        socketIds.push(entity.socketId);
      }
    }

    return socketIds;
  }

  /**
   * Get all player socket IDs within a specific range of a position
   */
  getPlayerSocketIdsInRange(origin: Vector3, range: number, excludeId?: string): string[] {
    const nearbyEntities = this.getEntitiesInRange(origin, range, excludeId);
    const socketIds: string[] = [];

    for (const entity of nearbyEntities) {
      if (entity.type === 'player' && entity.socketId) {
        socketIds.push(entity.socketId);
      }
    }

    return socketIds;
  }

  getEntitiesInRangeForCombat(origin: Vector3, range: number, excludeId?: string): Entity[] {
    return this.getEntitiesInRange(origin, range, excludeId);
  }

  /**
   * Get zone info
   */
  getZone(): Zone {
    return this.zone;
  }

  /**
   * Get entity count
   */
  getEntityCount(): number {
    return this.entities.size;
  }

  /**
   * Get player count
   */
  getPlayerCount(): number {
    let count = 0;
    for (const entity of this.entities.values()) {
      if (entity.type === 'player') count++;
    }
    return count;
  }

  // ========== Wildlife Management ==========

  /**
   * Add a wildlife entity to the zone
   */
  addWildlife(data: WildlifeEntityData): void {
    const entity: Entity = {
      id: data.id,
      name: data.name,
      type: 'wildlife',
      position: data.position,
      isMachine: true,
      isAlive: true,
      speciesId: data.speciesId,
      sprite: data.sprite,
      heading: data.heading ?? 0,
    };

    this.entities.set(data.id, entity);
    logger.debug({ entityId: data.id, species: data.speciesId, zoneId: this.zone.id }, 'Wildlife spawned');
  }

  /**
   * Remove a wildlife entity from the zone
   */
  removeWildlife(entityId: string): void {
    const entity = this.entities.get(entityId);
    if (entity && entity.type === 'wildlife') {
      this.entities.delete(entityId);
      logger.debug({ entityId, zoneId: this.zone.id }, 'Wildlife removed');
    }
  }

  /**
   * Update wildlife position and behavior
   */
  updateWildlife(entityId: string, position: Vector3, heading: number, behavior?: string): void {
    const entity = this.entities.get(entityId);
    if (entity && entity.type === 'wildlife') {
      entity.position = position;
      entity.heading = heading;
      if (behavior !== undefined) {
        entity.behavior = behavior;
      }
    }
  }

  /**
   * Get all player positions in the zone (for wildlife sim)
   */
  getPlayerPositions(): Array<{ id: string; position: Vector3 }> {
    const positions: Array<{ id: string; position: Vector3 }> = [];
    for (const entity of this.entities.values()) {
      if (entity.type === 'player' && entity.isAlive) {
        positions.push({ id: entity.id, position: entity.position });
      }
    }
    return positions;
  }
}
