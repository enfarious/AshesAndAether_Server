import { logger } from '@/utils/logger';
import { ZoneService, MobService } from '@/database';
import { COMMUNICATION_RANGES } from '@/network/protocol/types';
import { PhysicsSystem } from '@/physics/PhysicsSystem';
import { CollisionLayer } from '@/physics/types';
import { AnimationLockSystem } from './AnimationLockSystem';
import { BuildingCollisionLoader } from './BuildingCollisionLoader';
import type {
  ProximityRosterMessage,
  ProximityChannel,
  ProximityRosterDeltaMessage,
  ProximityChannelDelta,
  ProximityEntity,
  ProximityEntityDelta
} from '@/network/protocol/types';
import type { Character, Zone, Mob, Companion } from '@prisma/client';

interface Vector3 {
  x: number;
  y: number;
  z: number;
}

type MovementProfile = 'terrestrial' | 'amphibious' | 'aquatic';

interface Entity {
  id: string;
  name: string;
  type: 'player' | 'npc' | 'companion' | 'mob' | 'wildlife' | 'structure' | 'scripted_object';
  description?: string; // Displayed when a player examines this entity
  position: Vector3;
  socketId?: string; // For players only
  inCombat?: boolean;
  isMachine: boolean;
  isAlive: boolean;
  movementProfile?: MovementProfile;
  freediveSkill?: number;
  freediveMaxDepth?: number;
  freediveMaxSeconds?: number;
  // Mob-specific fields (used by client for display and color coding)
  tag?: string;          // e.g. "mob.rat.1" — stable identifier for mob type
  level?: number;
  family?: string;       // e.g. "hare", "canine" — broad taxonomy for engagement rules + wiki
  species?: string;      // e.g. "snow_hare", "spiral_fox" — specific variant
  faction?: string;      // e.g. "hostile", "neutral" — drives client nameplate color
  aiType?: string;       // e.g. "passive", "aggressive" — server-side AI behaviour
  notorious?: boolean;   // Notorious Monster: client shows "??" for level + special marker
  currentHealth?: number;
  maxHealth?: number;
  // Wildlife-specific fields
  speciesId?: string;
  sprite?: string;
  heading?: number;
  behavior?: string;
  modelAsset?: string;  // GLB asset path for 3D clients (e.g. "village/building_market.glb")
  modelScale?: number;  // Uniform scale multiplier for the GLB model (default 1)
  interactive?: boolean; // Override default interactive logic (e.g. dungeon entrances)
}

export interface WildlifeEntityData {
  id: string;
  name: string;
  speciesId: string;
  position: Vector3;
  sprite: string;
  heading?: number;
}

// ── Environment constants ──────────────────────────────────────────────────

/** Real seconds for one full in-game day (24 game-hours = 24 real minutes). */
const DAY_CYCLE_SECS = 1440;

/** Time-of-day bucket thresholds (0–1 normalised, 0 = midnight). */
const TOD_DAWN_START  = 0.167; // ~4 am
const TOD_DAY_START   = 0.25;  // ~6 am
const TOD_DUSK_START  = 0.75;  // ~6 pm
const TOD_NIGHT_START = 0.833; // ~8 pm

type Weather = 'clear' | 'cloudy' | 'fog' | 'mist' | 'rain' | 'storm';

/** Allowed transitions from each weather state (weighted). */
const WEATHER_TRANSITIONS: Record<Weather, Weather[]> = {
  clear:  ['cloudy', 'cloudy', 'fog', 'mist'],
  cloudy: ['clear', 'rain', 'rain', 'fog', 'storm'],
  fog:    ['clear', 'mist', 'mist', 'cloudy'],
  mist:   ['fog', 'clear', 'clear', 'cloudy'],
  rain:   ['cloudy', 'cloudy', 'storm', 'clear'],
  storm:  ['rain', 'rain', 'cloudy'],
};

/** Duration range [min, max] in real seconds before weather may change. */
const WEATHER_DURATION: Record<Weather, [number, number]> = {
  clear:  [300, 900],
  cloudy: [180, 600],
  fog:    [ 90, 360],
  mist:   [ 90, 300],
  rain:   [120, 480],
  storm:  [ 60, 240],
};

function randomWeatherDuration(wx: Weather): number {
  const [min, max] = WEATHER_DURATION[wx];
  return min + Math.random() * (max - min);
}

/**
 * Manages a single zone - tracks entities, calculates proximity, broadcasts updates
 */
export class ZoneManager {
  private zone: Zone;
  private entities: Map<string, Entity> = new Map();

  // ── Environment ───────────────────────────────────────────────────────────
  /** Normalised time-of-day: 0.0 = midnight, 0.25 = 6 am, 0.5 = noon, 0.75 = 6 pm. */
  private timeOfDay: number = 0.33;  // start ~8 am
  private weather: Weather = 'clear';
  private weatherTimer: number = 0;
  private nextWeatherChangeSecs: number = randomWeatherDuration('clear');
  private lastSpeaker: Map<string, { speaker: string; timestamp: number }> = new Map(); // entityId -> lastSpeaker info
  private physicsSystem: PhysicsSystem;
  private animationLockSystem: AnimationLockSystem;
  private underwaterSeconds: Map<string, { seconds: number; lastUpdate: number }> = new Map();
  /** Vertical velocity (m/s) for entities currently in freefall. */
  private fallingVelocity: Map<string, number> = new Map();

  constructor(zone: Zone) {
    this.zone = zone;
    const isFlat = zone.id.startsWith('village:') || zone.id.startsWith('vault:');
    this.physicsSystem = new PhysicsSystem(isFlat);
    this.animationLockSystem = new AnimationLockSystem();

    // Register building footprints as static collision geometry so players
    // cannot walk through them.  Uses the OSM polygon data for this zone.
    for (const building of BuildingCollisionLoader.load(zone.id)) {
      this.physicsSystem.registerEntity(building);
    }
  }

  getPhysicsSystem(): PhysicsSystem {
    return this.physicsSystem;
  }

  getAnimationLockSystem(): AnimationLockSystem {
    return this.animationLockSystem;
  }

  private resolveNumberField(input: unknown): number | null {
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input === 'string') {
      const parsed = Number(input);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private resolveMovementProfile(raw?: string | null): MovementProfile | null {
    if (!raw) return null;
    const normalized = raw.toLowerCase();
    if (normalized.includes('aquatic') || normalized.includes('underwater') || normalized.includes('ocean') || normalized.includes('sea') || normalized.includes('crustacean')) {
      return 'aquatic';
    }
    if (normalized.includes('amphib')) {
      return 'amphibious';
    }
    return null;
  }

  private resolveMovementProfileFromCharacter(character: Character): MovementProfile {
    const direct = this.resolveMovementProfile(character.supernaturalType);
    if (direct) return direct;

    const data = character.supernaturalData;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const dataRecord = data as Record<string, unknown>;
      const movementProfile = typeof dataRecord.movementProfile === 'string'
        ? this.resolveMovementProfile(dataRecord.movementProfile)
        : null;
      if (movementProfile) return movementProfile;

      const cosmetics = dataRecord.cosmetics;
      if (cosmetics && typeof cosmetics === 'object' && !Array.isArray(cosmetics)) {
        const appearance = (cosmetics as Record<string, unknown>).appearance;
        if (appearance && typeof appearance === 'object' && !Array.isArray(appearance)) {
          const appearanceProfile = typeof (appearance as Record<string, unknown>).movementProfile === 'string'
            ? this.resolveMovementProfile((appearance as Record<string, unknown>).movementProfile as string)
            : null;
          if (appearanceProfile) return appearanceProfile;
          const appearanceSpecies = typeof (appearance as Record<string, unknown>).speciesId === 'string'
            ? this.resolveMovementProfile((appearance as Record<string, unknown>).speciesId as string)
            : null;
          if (appearanceSpecies) return appearanceSpecies;
        }
      }
    }

    return 'terrestrial';
  }

  private resolveFreediveProfileFromCharacter(character: Character): { skill: number; maxDepth: number; maxSeconds: number } {
    const data = character.supernaturalData && typeof character.supernaturalData === 'object' && !Array.isArray(character.supernaturalData)
      ? (character.supernaturalData as Record<string, unknown>)
      : null;

    const cosmetics = data && typeof data.cosmetics === 'object' && data.cosmetics !== null && !Array.isArray(data.cosmetics)
      ? (data.cosmetics as Record<string, unknown>)
      : null;

    const appearance = cosmetics && typeof cosmetics.appearance === 'object' && cosmetics.appearance !== null && !Array.isArray(cosmetics.appearance)
      ? (cosmetics.appearance as Record<string, unknown>)
      : null;

    const skill =
      this.resolveNumberField(appearance?.freediveSkill) ??
      this.resolveNumberField(data?.freediveSkill) ??
      0;

    const clampedSkill = Math.max(0, Math.min(100, skill));

    const maxDepthOverride = this.resolveNumberField(appearance?.freediveMaxDepth) ?? this.resolveNumberField(data?.freediveMaxDepth);
    const maxSecondsOverride = this.resolveNumberField(appearance?.freediveMaxSeconds) ?? this.resolveNumberField(data?.freediveMaxSeconds);

    if (maxDepthOverride !== null || maxSecondsOverride !== null) {
      return {
        skill: clampedSkill,
        maxDepth: maxDepthOverride ?? 10,
        maxSeconds: maxSecondsOverride ?? 60,
      };
    }

    // Scale: skill 0 -> 5m/30s, skill 100 -> 100m/600s
    const maxDepth = 5 + (95 * (clampedSkill / 100));
    const maxSeconds = 30 + (570 * (clampedSkill / 100));
    return { skill: clampedSkill, maxDepth, maxSeconds };
  }

  private updateUnderwaterSeconds(entityId: string, position: Vector3, allowUnderwater: boolean): number {
    const terrain = this.physicsSystem.getTerrainCollision(position);
    const surface = terrain.isWater ? terrain.elevation : 0;
    const now = Date.now();
    const existing = this.underwaterSeconds.get(entityId);
    const deltaSeconds = existing ? Math.max(0, (now - existing.lastUpdate) / 1000) : 0;

    const isUnderwater = allowUnderwater && terrain.isWater && position.y < surface;
    const nextSeconds = isUnderwater ? (existing?.seconds ?? 0) + deltaSeconds : 0;
    this.underwaterSeconds.set(entityId, { seconds: nextSeconds, lastUpdate: now });
    return nextSeconds;
  }

  private resolveMovementProfileFromTag(tag?: string | null): MovementProfile {
    const profile = this.resolveMovementProfile(tag ?? undefined);
    return profile ?? 'terrestrial';
  }

  private resolveMovementProfileFromSpeciesId(speciesId?: string | null): MovementProfile {
    const profile = this.resolveMovementProfile(speciesId ?? undefined);
    return profile ?? 'terrestrial';
  }

  // ── Environment API ───────────────────────────────────────────────────────

  /**
   * Advance the day/night cycle and weather system.
   * Returns true when the environment string changed (TOD bucket or weather),
   * signalling the caller to broadcast a zone update.
   */
  tickEnvironment(deltaTime: number): boolean {
    // Time progression
    const prevTodStr = this._todString();
    this.timeOfDay += deltaTime / DAY_CYCLE_SECS;
    if (this.timeOfDay >= 1.0) this.timeOfDay -= 1.0;
    const newTodStr = this._todString();

    // Weather progression
    this.weatherTimer += deltaTime;
    let weatherChanged = false;
    if (this.weatherTimer >= this.nextWeatherChangeSecs) {
      this.weatherTimer = 0;
      const next = this._nextWeather();
      if (next !== this.weather) {
        this.weather = next;
        weatherChanged = true;
      }
      this.nextWeatherChangeSecs = randomWeatherDuration(this.weather);
    }

    return newTodStr !== prevTodStr || weatherChanged;
  }

  /** Human-readable time-of-day bucket sent to clients. */
  getTimeOfDayString(): string {
    return this._todString();
  }

  /** Normalised 0–1 time-of-day value; clients use this to derive the clock display. */
  getTimeOfDayNormalized(): number {
    return this.timeOfDay;
  }

  /** Current weather identifier sent to clients. */
  getWeather(): string {
    return this.weather;
  }

  /**
   * Zone-level lighting modifier.
   * Outdoor zones are 'normal'; dungeons or special zones could override this
   * via config in the future.  For now always returns 'normal'.
   */
  getLighting(): string {
    return 'normal';
  }

  private _todString(): string {
    const t = this.timeOfDay;
    if (t >= TOD_DAY_START  && t < TOD_DUSK_START)  return 'day';
    if (t >= TOD_DUSK_START && t < TOD_NIGHT_START) return 'dusk';
    if (t >= TOD_DAWN_START && t < TOD_DAY_START)   return 'dawn';
    return 'night';
  }

  private _nextWeather(): Weather {
    const candidates = WEATHER_TRANSITIONS[this.weather];
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // ── Entity management ─────────────────────────────────────────────────────

  /**
   * Initialize zone with entities from database
   */
  async initialize(): Promise<void> {
    logger.info({ zoneId: this.zone.id, zoneName: this.zone.name }, 'Initializing zone');

    // Load companions (NPCs) in this zone
    const companions = await ZoneService.getCompanionsInZone(this.zone.id);

    for (const companion of companions) {
      const isMob = companion.tag?.startsWith('mob.') === true;
      const rawPosition = {
        x: companion.positionX,
        y: companion.positionY,
        z: companion.positionZ,
      };
      // Apply gravity so mobs/NPCs with stale or placeholder Y values
      // (e.g. y=0 from DB seeding) land on the actual terrain surface.
      const position = this.physicsSystem.applyGravity(rawPosition);
      const entity = {
        id: companion.id,
        name: companion.name,
        type: isMob ? 'mob' : 'companion',
        description: companion.description ?? undefined,
        position,
        inCombat: false,
        isMachine: true,
        isAlive: companion.isAlive ?? true,
        movementProfile: this.resolveMovementProfileFromTag(companion.tag),
      };

      this.entities.set(companion.id, entity);

      // Register with physics system
      this.physicsSystem.registerEntity({
        id: companion.id,
        position: entity.position,
        boundingVolume: PhysicsSystem.createBoundingSphere(entity.position, 0.5),
        type: 'dynamic',
        collisionLayer: CollisionLayer.ENTITIES,
      });
    }

    // Load mobs in this zone
    const mobs = await MobService.findAllInZone(this.zone.id);

    for (const mob of mobs) {
      const rawPosition = {
        x: mob.positionX,
        y: mob.positionY,
        z: mob.positionZ,
      };
      const position = this.physicsSystem.applyGravity(rawPosition);
      const entity: Entity = {
        id: mob.id,
        name: mob.name,
        type: 'mob',
        description: mob.description ?? undefined,
        position,
        inCombat: false,
        isMachine: true,
        isAlive: mob.isAlive ?? true,
        movementProfile: 'terrestrial',
        tag:           mob.tag           ?? undefined,
        level:         mob.level         ?? undefined,
        family:        mob.family        ?? undefined,
        species:       mob.species       ?? undefined,
        faction:       mob.faction       ?? undefined,
        aiType:        mob.aiType        ?? undefined,
        notorious:     mob.notorious     ?? false,
        currentHealth: mob.currentHealth,
        maxHealth:     mob.maxHealth,
      };

      this.entities.set(mob.id, entity);
      this.physicsSystem.registerEntity({
        id: mob.id,
        position: entity.position,
        boundingVolume: PhysicsSystem.createBoundingSphere(entity.position, 0.5),
        type: 'dynamic',
        collisionLayer: CollisionLayer.ENTITIES,
      });
    }

    // Diagnostic: log each non-player entity's position vs terrain elevation
    // so we can see immediately whether physics will tick or treat them as grounded.
    for (const entity of this.entities.values()) {
      if (entity.type === 'player') continue;
      const terrain = this.physicsSystem.getTerrainCollision(entity.position);
      logger.info(
        {
          zoneId: this.zone.id,
          entityId: entity.id.slice(-8),
          name: entity.name,
          type: entity.type,
          isAlive: entity.isAlive,
          y: entity.position.y,
          terrainElevation: terrain.elevation,
          aboveGround: entity.position.y > terrain.elevation,
          elevationServiceLoaded: this.physicsSystem.hasElevationService(),
        },
        '[Physics:init] Entity spawn position'
      );
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
    // Snap to terrain on entry — DB-stored Y may be stale or placeholder.
    const rawPosition = {
      x: character.positionX,
      y: character.positionY,
      z: character.positionZ,
    };
    const position = this.physicsSystem.applyGravity(rawPosition);

    const entity: Entity = {
      id: character.id,
      name: character.name,
      type: 'player',
      description: (character as any).description ?? undefined,
      position,
      socketId,
      inCombat: false,
      isMachine,
      isAlive: character.isAlive ?? true,
      movementProfile: this.resolveMovementProfileFromCharacter(character),
    };

    const freedive = this.resolveFreediveProfileFromCharacter(character);
    entity.freediveSkill = freedive.skill;
    entity.freediveMaxDepth = freedive.maxDepth;
    entity.freediveMaxSeconds = freedive.maxSeconds;

    this.entities.set(character.id, entity);

    // Register with physics system
    this.physicsSystem.registerEntity({
      id: character.id,
      position: entity.position,
      boundingVolume: PhysicsSystem.createBoundingSphere(entity.position, 0.5),
      type: 'dynamic',
      collisionLayer: CollisionLayer.ENTITIES,
    });

    logger.info({ characterId: character.id, characterName: character.name, zoneId: this.zone.id }, 'Player entered zone');
  }

  /**
   * Remove a player from the zone
   */
  removePlayer(characterId: string): void {
    const entity = this.entities.get(characterId);
    if (entity) {
      this.entities.delete(characterId);
      this.physicsSystem.unregisterEntity(characterId);
      logger.info({ characterId, characterName: entity.name, zoneId: this.zone.id }, 'Player left zone');
    }
  }

  /**
   * Update player position
   */
  updatePlayerPosition(characterId: string, position: Vector3): void {
    const entity = this.entities.get(characterId);
    if (entity) {
      const canFreedive = entity.movementProfile === 'aquatic' || entity.movementProfile === 'amphibious' || (entity.freediveMaxSeconds ?? 0) > 0;
      const underwaterSeconds = this.updateUnderwaterSeconds(characterId, entity.position, canFreedive);

      // Validate movement with physics before updating
      const validation = this.physicsSystem.validateMovement(
        characterId,
        entity.position,
        position,
        0.5,
        {
          allowUnderwater: canFreedive,
          maxUnderwaterDepth: entity.movementProfile === 'terrestrial' ? entity.freediveMaxDepth : undefined,
          maxUnderwaterSeconds: entity.movementProfile === 'terrestrial' ? entity.freediveMaxSeconds : undefined,
          currentUnderwaterSeconds: entity.movementProfile === 'terrestrial' ? underwaterSeconds : undefined,
        }
      );

      if (!validation.valid) {
        if (validation.adjustedPosition) {
          // Physics adjusted the position (e.g., terrain collision)
          position = validation.adjustedPosition;
          logger.debug({
            characterId,
            reason: validation.reason,
            original: entity.position,
            adjusted: position
          }, 'Movement adjusted by physics');
        } else {
          // Movement blocked by physics
          logger.debug({
            characterId,
            reason: validation.reason,
            blockedPosition: position
          }, 'Movement blocked by physics');
          return; // Don't update position
        }
      }

      entity.position = position;
      // Update physics system with validated position
      this.physicsSystem.updateEntity(characterId, position);
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

  /** Keep the in-memory entity health in sync so publishZoneEntities reflects current state. */
  setEntityHealth(entityId: string, current: number, max: number): void {
    const entity = this.entities.get(entityId);
    if (!entity) return;
    entity.currentHealth = current;
    entity.maxHealth     = max;
  }

  teleportEntity(entityId: string, position: { x: number; y: number; z: number }): void {
    const entity = this.entities.get(entityId);
    if (entity) {
      entity.position = position;
      this.physicsSystem.updateEntity(entityId, position);
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

      // Get animation state
      const animationState = this.animationLockSystem.getState(entity.id);

      return {
        id: entity.id,
        name: entity.name,
        type: entity.type,
        isMachine: entity.isMachine,
        isAlive: entity.isAlive,
        bearing,
        elevation,
        range: Math.round(range * 100) / 100, // Round to 2 decimal places
        currentAction: animationState.currentAction,
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
   * Tick physics for all non-player entities with bPhysicsEnabled.
   * Applies real gravity (velocity accumulation) rather than a flat snap.
   * Entities already on the ground are skipped cheaply.
   * Returns entities that moved so the caller can broadcast updates.
   */
  tickPhysics(deltaTime: number): Array<{ id: string; position: Vector3 }> {
    const moved: Array<{ id: string; position: Vector3 }> = [];

    for (const entity of this.entities.values()) {
      if (entity.type === 'player') continue; // handled by MovementSystem
      if (!entity.isAlive) continue;

      // All living non-player entities have physics enabled by default.
      // (When these migrate to the Living class, check entity.bPhysicsEnabled.)
      const vy = this.fallingVelocity.get(entity.id) ?? 0;

      // Already grounded and no vertical velocity — skip
      if (vy === 0) {
        const terrain = this.physicsSystem.getTerrainCollision(entity.position);
        if (entity.position.y <= terrain.elevation) continue;
        // Entity is above ground — start falling
      }

      const result = this.physicsSystem.tickPhysics(
        entity.position,
        { x: 0, y: vy, z: 0 },
        deltaTime
      );

      entity.position = result.position;
      this.physicsSystem.updateEntity(entity.id, result.position);

      if (result.landed) {
        this.fallingVelocity.delete(entity.id);
      } else {
        this.fallingVelocity.set(entity.id, result.velocity.y);
      }

      moved.push({ id: entity.id, position: result.position });
    }

    return moved;
  }

  /**
   * Return a compact snapshot of all non-player entity positions + falling velocity
   * for diagnostic logging. One entry per entity.
   */
  getPhysicsSample(): Array<{ id: string; name: string; type: string; y: number; vy: number; terrainY: number }> {
    const result = [];
    for (const entity of this.entities.values()) {
      if (entity.type === 'player') continue;
      if (!entity.isAlive) continue;
      const terrain = this.physicsSystem.getTerrainCollision(entity.position);
      result.push({
        id: entity.id.slice(-8),          // last 8 chars enough to identify
        name: entity.name,
        type: entity.type,
        y: Math.round(entity.position.y * 10) / 10,
        vy: Math.round((this.fallingVelocity.get(entity.id) ?? 0) * 10) / 10,
        terrainY: Math.round(terrain.elevation * 10) / 10,
      });
    }
    return result;
  }

  /**
   * Get all entities with their current (physics-corrected) positions.
   */
  getAllEntities(): Array<{
    id: string; name: string; type: string; position: Vector3; isAlive: boolean;
    description?: string; tag?: string; level?: number; family?: string; species?: string;
    faction?: string; aiType?: string; notorious?: boolean; currentHealth?: number;
    maxHealth?: number; speciesId?: string; sprite?: string; heading?: number;
  }> {
    return Array.from(this.entities.values());
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
    // Snap to terrain on arrival — external sources (Rust sim, DB) may have y=0
    const snappedPosition = this.physicsSystem.applyGravity(data.position);

    const entity: Entity = {
      id: data.id,
      name: data.name,
      type: 'wildlife',
      position: snappedPosition,
      isMachine: true,
      isAlive: true,
      speciesId: data.speciesId,
      sprite: data.sprite,
      heading: data.heading ?? 0,
    };

    this.entities.set(data.id, entity);
    this.physicsSystem.registerEntity({
      id: data.id,
      position: entity.position,
      boundingVolume: PhysicsSystem.createBoundingSphere(entity.position, 0.5),
      type: 'dynamic',
      collisionLayer: CollisionLayer.ENTITIES,
    });
    entity.movementProfile = this.resolveMovementProfileFromSpeciesId(data.speciesId);
    logger.debug({ entityId: data.id, species: data.speciesId, zoneId: this.zone.id }, 'Wildlife spawned');
  }

  /**
   * Dynamically add a player companion to the zone at runtime.
   */
  addCompanion(companion: Companion): void {
    const position = this.physicsSystem.applyGravity({
      x: companion.positionX,
      y: companion.positionY,
      z: companion.positionZ,
    });

    const entity = {
      id: companion.id,
      name: companion.name,
      type: 'companion' as const,
      description: companion.description ?? undefined,
      position,
      inCombat: false,
      isMachine: true,
      isAlive: companion.isAlive ?? true,
      movementProfile: 'terrestrial' as MovementProfile,
    };

    this.entities.set(companion.id, entity);
    this.physicsSystem.registerEntity({
      id: companion.id,
      position: entity.position,
      boundingVolume: PhysicsSystem.createBoundingSphere(entity.position, 0.5),
      type: 'dynamic',
      collisionLayer: CollisionLayer.ENTITIES,
    });
    logger.debug({ companionId: companion.id, name: companion.name, zoneId: this.zone.id }, 'Player companion spawned');
  }

  /**
   * Remove a companion entity from the zone (called when owner disconnects).
   */
  removeCompanion(companionId: string): void {
    const entity = this.entities.get(companionId);
    if (entity && entity.type === 'companion') {
      this.entities.delete(companionId);
      this.physicsSystem.unregisterEntity(companionId);
      logger.debug({ companionId, zoneId: this.zone.id }, 'Companion despawned');
    }
  }

  /**
   * Remove a mob entity from the zone (called on death before respawn timer).
   */
  removeMob(mobId: string): void {
    const entity = this.entities.get(mobId);
    if (entity && entity.type === 'mob') {
      this.entities.delete(mobId);
      this.physicsSystem.unregisterEntity(mobId);
      logger.debug({ mobId, zoneId: this.zone.id }, 'Mob despawned');
    }
  }

  /**
   * Spawn (or re-spawn) a mob into the zone from its DB record.
   * Mirrors the initialization path so position/physics are consistent.
   */
  spawnMob(mob: Mob): void {
    const rawPosition = { x: mob.positionX, y: mob.positionY, z: mob.positionZ };
    const position = this.physicsSystem.applyGravity(rawPosition);
    const entity: Entity = {
      id: mob.id,
      name: mob.name,
      type: 'mob',
      description: mob.description ?? undefined,
      position,
      inCombat: false,
      isMachine: true,
      isAlive: true,
      movementProfile: 'terrestrial',
      tag:           mob.tag           ?? undefined,
      level:         mob.level         ?? undefined,
      family:        mob.family        ?? undefined,
      species:       mob.species       ?? undefined,
      faction:       mob.faction       ?? undefined,
      aiType:        mob.aiType        ?? undefined,
      notorious:     mob.notorious     ?? false,
      currentHealth: mob.currentHealth,
      maxHealth:     mob.maxHealth,
    };

    this.entities.set(mob.id, entity);
    this.physicsSystem.registerEntity({
      id: mob.id,
      position,
      boundingVolume: PhysicsSystem.createBoundingSphere(position, 0.5),
      type: 'dynamic',
      collisionLayer: CollisionLayer.ENTITIES,
    });
    logger.debug({ mobId: mob.id, name: mob.name, zoneId: this.zone.id }, 'Mob spawned');
  }

  // ── Structure entities (village system) ──────────────────────────────────

  /** Add a structure entity (for village instances). */
  addStructure(data: { id: string; name: string; description?: string; position: Vector3; modelAsset?: string }): void {
    const position = this.physicsSystem.applyGravity(data.position);
    const entity: Entity = {
      id: data.id,
      name: data.name,
      type: 'structure',
      description: data.description,
      position,
      isMachine: true,
      isAlive: true,
      modelAsset: data.modelAsset,
    };
    this.entities.set(data.id, entity);
    this.physicsSystem.registerEntity({
      id: data.id,
      position,
      boundingVolume: PhysicsSystem.createBoundingSphere(position, 1.0),
      type: 'static',
      collisionLayer: CollisionLayer.ENTITIES,
    });
  }

  /** Remove a structure entity. */
  removeStructure(entityId: string): void {
    const entity = this.entities.get(entityId);
    if (entity && entity.type === 'structure') {
      this.entities.delete(entityId);
      this.physicsSystem.unregisterEntity(entityId);
    }
  }

  /** Add a scripted object entity to the zone. */
  addScriptedObject(data: { id: string; name: string; description?: string; position: Vector3; interactive?: boolean; modelAsset?: string; modelScale?: number }): void {
    const position = this.physicsSystem.applyGravity(data.position);
    const entity: Entity = {
      id: data.id,
      name: data.name,
      type: 'scripted_object',
      description: data.description,
      position,
      isMachine: true,
      isAlive: true,
      interactive: data.interactive,
      modelAsset: data.modelAsset,
      modelScale: data.modelScale,
    };
    this.entities.set(data.id, entity);
    this.physicsSystem.registerEntity({
      id: data.id,
      position,
      boundingVolume: PhysicsSystem.createBoundingSphere(position, 0.5),
      type: 'static',
      collisionLayer: CollisionLayer.ENTITIES,
    });
  }

  /** Remove a scripted object entity from the zone. */
  removeScriptedObject(entityId: string): void {
    const entity = this.entities.get(entityId);
    if (entity && entity.type === 'scripted_object') {
      this.entities.delete(entityId);
      this.physicsSystem.unregisterEntity(entityId);
    }
  }

  /**
   * Remove a wildlife entity from the zone
   */
  removeWildlife(entityId: string): void {
    const entity = this.entities.get(entityId);
    if (entity && entity.type === 'wildlife') {
      this.entities.delete(entityId);
      this.physicsSystem.unregisterEntity(entityId);
      logger.debug({ entityId, zoneId: this.zone.id }, 'Wildlife removed');
    }
  }

  /**
   * Update wildlife position and behavior
   */
  updateWildlife(entityId: string, position: Vector3, heading: number, behavior?: string): void {
    const entity = this.entities.get(entityId);
    if (entity && entity.type === 'wildlife') {
      entity.position = this.physicsSystem.applyGravity(position);
      entity.heading = heading;
      if (behavior !== undefined) {
        entity.behavior = behavior;
      }
      this.physicsSystem.updateEntity(entityId, position);
    }
  }

  /**
   * Move a mob to a new XZ position, snapping Y to the terrain surface.
   *
   * Called by DistributedWorldManager after each MobWanderSystem tick.
   * Returns the terrain-snapped position so the caller can broadcast it.
   *
   * NOTE: Unlike applyGravity() (which only snaps upward for player-authored
   * positions), this method snaps the mob to the terrain in BOTH directions —
   * the server is fully authoritative on mob Y, so we always want the mob to
   * walk directly on the surface whether it's going uphill or downhill.
   */
  updateMobPosition(entityId: string, position: Vector3, heading: number): Vector3 {
    const entity = this.entities.get(entityId);
    if (!entity || entity.type !== 'mob') return position;

    // Snap directly to terrain elevation (up or down) — bidirectional snap.
    const terrain  = this.physicsSystem.getTerrainCollision(position);
    const snapped  = { ...position, y: terrain.elevation };

    entity.position    = snapped;
    entity.heading     = heading;
    this.physicsSystem.updateEntity(entityId, snapped);
    return snapped;
  }

  /**
   * Move a companion to a new XZ position, snapping Y to terrain.
   * Same pattern as updateMobPosition but for companion entities.
   */
  updateCompanionPosition(entityId: string, position: Vector3, heading: number): Vector3 {
    const entity = this.entities.get(entityId);
    if (!entity || entity.type !== 'companion') return position;

    const terrain = this.physicsSystem.getTerrainCollision(position);
    const snapped = { ...position, y: terrain.elevation };

    entity.position = snapped;
    entity.heading = heading;
    this.physicsSystem.updateEntity(entityId, snapped);
    return snapped;
  }

  /**
   * Get all companion entities in this zone.
   */
  getCompanions(): Array<{ id: string; position: Vector3; isAlive: boolean; inCombat: boolean; currentHealth?: number; maxHealth?: number }> {
    const companions: Array<{ id: string; position: Vector3; isAlive: boolean; inCombat: boolean; currentHealth?: number; maxHealth?: number }> = [];
    for (const entity of this.entities.values()) {
      if (entity.type === 'companion') {
        companions.push({
          id: entity.id,
          position: entity.position,
          isAlive: entity.isAlive,
          inCombat: entity.inCombat ?? false,
          currentHealth: entity.currentHealth,
          maxHealth: entity.maxHealth,
        });
      }
    }
    return companions;
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
