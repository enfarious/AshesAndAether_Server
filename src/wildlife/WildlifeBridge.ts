/**
 * Bridge between the game server and the Rust wildlife simulation service.
 *
 * Responsibilities:
 *   - Publish zone info and player positions to the Rust wildlife sim
 *   - Subscribe to wildlife events from the Rust sim and forward them to the
 *     game world (spawn / move / death / attack / birth / plant_grow / plant_eaten)
 *
 * The bridge accepts a minimal IWildlifeWorld facade so it can be unit-tested
 * and so DistributedWorldManager avoids a hard circular import.
 */

import { logger } from '@/utils/logger';
import type { MessageBus, MessageEnvelope } from '@/messaging/MessageBus';
import type { Vector3 } from '@/network/protocol/types';

// ── Event types published by the Rust wildlife sim ─────────────────────────
// Rust uses #[serde(tag = "type", rename_all = "snake_case")] so all type
// discriminators arrive as snake_case strings: "spawn", "move", "death", etc.

export interface WildlifeSpawnEvent {
  type: 'spawn';
  entity_id: string;
  species_id: string;
  position: Vector3;
  zone_id: string;
}

export interface WildlifeMoveEvent {
  type: 'move';
  entity_id: string;
  position: Vector3;
  heading: number;
  behavior: string;
  speed?: number;
}

export interface WildlifeDeathEvent {
  type: 'death';
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
  type: 'attack';
  attacker_id: string;
  target_id: string;
  damage: number;
  position: Vector3;
}

export interface WildlifeBirthEvent {
  type: 'birth';
  parent_id: string;
  offspring_ids: string[];
  position: Vector3;
  zone_id: string;
}

export interface PlantGrowEvent {
  type: 'plant_grow';
  plant_id: string;
  new_stage: string;
}

export interface PlantEatenEvent {
  type: 'plant_eaten';
  plant_id: string;
  wildlife_id: string;
  food_value: number;
}

export type WildlifeEvent =
  | WildlifeSpawnEvent
  | WildlifeMoveEvent
  | WildlifeDeathEvent
  | WildlifeAttackEvent
  | WildlifeBirthEvent
  | PlantGrowEvent
  | PlantEatenEvent;

// ── Outbound message types sent to the Rust sim ────────────────────────────

export interface ZoneInfoMessage {
  id: string;
  biome: string;
  bounds_min: Vector3;
  bounds_max: Vector3;
  time_of_day: number;
}

export interface PlayerPositionMessage {
  id: string;
  zone_id: string;
  position: Vector3;
}

// ── Facade interface — DistributedWorldManager implements this ─────────────

export interface IWildlifeWorld {
  /** Add a freshly-spawned wildlife entity to the named zone. */
  addWildlifeToZone(
    zoneId: string,
    data: { id: string; name: string; speciesId: string; position: Vector3; sprite: string; heading?: number }
  ): void;

  /** Update position / heading / behavior of an existing wildlife entity. */
  updateWildlifeInZone(
    zoneId: string,
    entityId: string,
    position: Vector3,
    heading: number,
    behavior: string,
    speed: number,
  ): void;

  /** Remove a wildlife entity from the zone (death / despawn). */
  removeWildlifeFromZone(zoneId: string, entityId: string): void;

  /** Notify the FloraManager that the Rust sim advanced a plant's growth stage. */
  notifyPlantStageChange(plantId: string, newStage: string): void;

  /** Notify the FloraManager that a wildlife entity ate a plant. */
  notifyPlantEaten(plantId: string, wildlifeId: string, foodValue: number): void;

  /** Returns all active zone IDs managed by this server. */
  getAllActiveZoneIds(): string[];

  /**
   * Returns all players currently in the given zone as position records so
   * the Rust sim can calculate flee distances.
   */
  getZonePlayerPositions(zoneId: string): PlayerPositionMessage[];

  /** Returns the biome identifier for a zone (e.g. 'forest', 'grassland'). */
  getZoneBiome(zoneId: string): string;

  /**
   * Returns the normalised time-of-day (0–1) for a zone.
   * Caller multiplies by 24 when the Rust protocol expects a 0–24 clock value.
   */
  getZoneTimeOfDayNormalized(zoneId: string): number;

  /**
   * Broadcast a wildlife position update to every player in the zone as a
   * batched state_update entity packet.
   */
  broadcastWildlifeMoveToClients(
    zoneId: string,
    entityId: string,
    name: string,
    position: Vector3,
    heading: number,
    animation: string,
    speed: number,
  ): Promise<void>;
}

// ── Species display info (name + client sprite path) ─────────────────────

const SPECIES_INFO: Record<string, { name: string; sprite: string }> = {
  rabbit: { name: 'Rabbit',    sprite: 'wildlife/rabbit' },
  fox:    { name: 'Fox',       sprite: 'wildlife/fox'    },
  deer:   { name: 'Deer',      sprite: 'wildlife/deer'   },
  wolf:   { name: 'Wolf',      sprite: 'wildlife/wolf'   },
  boar:   { name: 'Wild Boar', sprite: 'wildlife/boar'   },
};

// ── Redis channels ──────────────────────────────────────────────────────────

const CH = {
  EVENTS:  'wildlife:events',
  PLAYERS: 'wildlife:players',
  ZONES:   'wildlife:zones',
  COMBAT:  'wildlife:combat',
  SYNC:    'wildlife:sync',
};

// ── Bridge implementation ───────────────────────────────────────────────────

export class WildlifeBridge {
  private readonly messageBus: MessageBus;
  private readonly world:      IWildlifeWorld;

  /** entity_id → { zoneId, speciesId } — populated on Spawn, used for Move / Attack events */
  private readonly entityMeta = new Map<string, { zoneId: string; speciesId: string }>();

  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private zoneInfoInterval: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private zoneInfoPublishCount = 0;

  /** Timestamp of the last event received from the Rust sim. */
  private lastEventReceivedAt = 0;
  /** If no event arrives within this window, consider the external sim dead. */
  private static readonly STALE_THRESHOLD_MS = 10_000;

  constructor(messageBus: MessageBus, world: IWildlifeWorld) {
    this.messageBus = messageBus;
    this.world      = world;
    logger.info('[WildlifeBridge] created');
  }

  /**
   * Whether the external Rust wildlife sim is actively sending data.
   * Returns true only when the bridge is subscribed, has populated entities
   * (received at least one Spawn), and has received an event recently.
   */
  isExternalSimActive(): boolean {
    if (!this.connected) return false;
    if (this.entityMeta.size === 0) return false;
    return (Date.now() - this.lastEventReceivedAt) < WildlifeBridge.STALE_THRESHOLD_MS;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.messageBus.isConnected()) {
      logger.warn('[WildlifeBridge] MessageBus not connected — bridge cannot start');
      return;
    }

    await this.messageBus.subscribe(CH.EVENTS, (envelope) => {
      // The Rust sim publishes raw event JSON directly to Redis (not wrapped
      // in a MessageEnvelope), so the parsed object IS the event — not .payload.
      this.handleWildlifeEvent(envelope as unknown as WildlifeEvent);
    });

    // Publish zone info immediately and then every 10 seconds so late-connecting
    // Rust sims discover all zones within a few seconds of connecting.
    await this._publishAllZoneInfo();
    this.zoneInfoInterval = setInterval(() => {
      void this._publishAllZoneInfo();
    }, 10_000);

    // Keep the Rust sim updated with player positions every second
    this.updateInterval = setInterval(() => {
      void this._publishPlayerPositions();
    }, 1_000);

    this.connected = true;
    logger.info('[WildlifeBridge] started — subscribed to wildlife:events');
  }

  async stop(): Promise<void> {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    if (this.zoneInfoInterval) {
      clearInterval(this.zoneInfoInterval);
      this.zoneInfoInterval = null;
    }
    if (this.connected) {
      await this.messageBus.unsubscribe(CH.EVENTS);
      this.connected = false;
    }
    logger.info('[WildlifeBridge] stopped');
  }

  // ── Outbound: zone info ────────────────────────────────────────────────────
  //
  // Rust uses #[serde(tag = "type", rename_all = "snake_case")] on GameServerMessage,
  // which is an **internally-tagged enum**.  All variant fields must be siblings of
  // "type" at the top level — NOT nested inside a "payload" wrapper.

  async publishZoneInfo(zoneInfo: ZoneInfoMessage): Promise<void> {
    await this.messageBus.publish(CH.ZONES, {
      type: 'zone_info',
      zone: zoneInfo,           // flat — Rust: ZoneInfo { zone: ZoneInfo }
    } as unknown as MessageEnvelope);
  }

  // ── Outbound: player attack on wildlife ────────────────────────────────────

  async reportPlayerAttack(playerId: string, targetId: string, damage: number): Promise<void> {
    await this.messageBus.publish(CH.COMBAT, {
      type:      'player_attack',
      player_id: playerId,      // flat — Rust: PlayerAttack { player_id, target_id, damage }
      target_id: targetId,
      damage,
    } as unknown as MessageEnvelope);
  }

  // ── Outbound: player harvested a plant ────────────────────────────────────

  async reportPlantHarvest(plantId: string, playerId: string): Promise<void> {
    await this.messageBus.publish(CH.SYNC, {
      type:      'plant_harvest',
      plant_id:  plantId,       // flat — Rust: PlantHarvest { plant_id, player_id }
      player_id: playerId,
    } as unknown as MessageEnvelope);
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private async _publishAllZoneInfo(): Promise<void> {
    const zoneIds = this.world.getAllActiveZoneIds();
    if (zoneIds.length === 0) return;

    for (const zoneId of zoneIds) {
      const info: ZoneInfoMessage = {
        id:          zoneId,
        biome:       this.world.getZoneBiome(zoneId) as ZoneInfoMessage['biome'],
        bounds_min:  { x: -500, y: 0, z: -500 },
        bounds_max:  { x:  500, y: 50, z:  500 },
        time_of_day: this.world.getZoneTimeOfDayNormalized(zoneId) * 24,
      };
      await this.publishZoneInfo(info);

      // Also store a snapshot key so late-connecting sims can prime their cache
      // (same pattern as WeatherBridge / ClimateBridge).
      try {
        const snapshotPayload = JSON.stringify({ type: 'zone_info', zone: info });
        await this.messageBus.getClient().set(`wildlife:zone_snapshot:${zoneId}`, snapshotPayload);
      } catch (err) {
        logger.warn({ err, zoneId }, '[WildlifeBridge] failed to set zone snapshot key');
      }
    }

    this.zoneInfoPublishCount++;
    if (this.zoneInfoPublishCount === 1) {
      logger.info({ zones: zoneIds }, '[WildlifeBridge] first zone info published for %d zone(s)', zoneIds.length);
    }
  }

  private async _publishPlayerPositions(): Promise<void> {
    const players: PlayerPositionMessage[] = [];
    for (const zoneId of this.world.getAllActiveZoneIds()) {
      players.push(...this.world.getZonePlayerPositions(zoneId));
    }
    if (players.length === 0) return;
    await this.messageBus.publish(CH.PLAYERS, {
      type: 'players_update',
      players,                  // flat — Rust: PlayersUpdate { players: Vec<PlayerPosition> }
    } as unknown as MessageEnvelope);
  }

  // ── Inbound: Rust sim events ───────────────────────────────────────────────

  private handleWildlifeEvent(event: WildlifeEvent): void {
    const wasActive = this.isExternalSimActive();
    this.lastEventReceivedAt = Date.now();
    if (!wasActive && this.isExternalSimActive()) {
      logger.info({ knownEntities: this.entityMeta.size },
        '[WildlifeBridge] external Rust wildlife sim active — local managers deferred');
    }

    switch (event.type) {
      case 'spawn':       void this._handleSpawn(event);  break;
      case 'move':        void this._handleMove(event);   break;
      case 'death':       void this._handleDeath(event);  break;
      case 'attack':      this._handleAttack(event);      break;
      case 'birth':       this._handleBirth(event);       break;
      case 'plant_grow':  this._handlePlantGrow(event);   break;
      case 'plant_eaten': this._handlePlantEaten(event);  break;
      default:
        logger.warn({ event }, '[WildlifeBridge] unknown event type');
    }
  }

  private async _handleSpawn(event: WildlifeSpawnEvent): Promise<void> {
    logger.debug({ entity_id: event.entity_id, species: event.species_id, zone: event.zone_id },
      '[WildlifeBridge] spawn');
    this.entityMeta.set(event.entity_id, { zoneId: event.zone_id, speciesId: event.species_id });

    const info = SPECIES_INFO[event.species_id] ?? { name: event.species_id, sprite: 'wildlife/unknown' };
    this.world.addWildlifeToZone(event.zone_id, {
      id:        event.entity_id,
      name:      info.name,
      speciesId: event.species_id,
      position:  event.position,
      sprite:    info.sprite,
    });
  }

  private async _handleMove(event: WildlifeMoveEvent): Promise<void> {
    const meta = this.entityMeta.get(event.entity_id);
    if (!meta) return; // entity not yet known (arrived before spawn event)

    const animation = _behaviorToAnimation(event.behavior);
    const speed     = event.speed ?? 2.0;
    const info      = SPECIES_INFO[meta.speciesId] ?? { name: meta.speciesId, sprite: 'wildlife/unknown' };

    this.world.updateWildlifeInZone(
      meta.zoneId, event.entity_id, event.position, event.heading, event.behavior, speed,
    );
    await this.world.broadcastWildlifeMoveToClients(
      meta.zoneId, event.entity_id,
      info.name,
      event.position, event.heading, animation, speed,
    );
  }

  private async _handleDeath(event: WildlifeDeathEvent): Promise<void> {
    logger.debug({ entity_id: event.entity_id, cause: event.cause }, '[WildlifeBridge] death');
    this.entityMeta.delete(event.entity_id);
    this.world.removeWildlifeFromZone(event.zone_id, event.entity_id);
  }

  private _handleAttack(event: WildlifeAttackEvent): void {
    // Wildlife-vs-wildlife attacks are handled entirely inside the Rust sim.
    // Wildlife-vs-player damage would surface here; left as a future extension.
    logger.debug({ event }, '[WildlifeBridge] attack');
  }

  private _handleBirth(event: WildlifeBirthEvent): void {
    // Individual offspring arrive as Spawn events; this is informational only.
    logger.debug({ parent: event.parent_id, count: event.offspring_ids.length },
      '[WildlifeBridge] birth');
  }

  private _handlePlantGrow(event: PlantGrowEvent): void {
    logger.debug({ plant_id: event.plant_id, new_stage: event.new_stage }, '[WildlifeBridge] plant grow');
    this.world.notifyPlantStageChange(event.plant_id, event.new_stage);
  }

  private _handlePlantEaten(event: PlantEatenEvent): void {
    logger.debug({ plant_id: event.plant_id, wildlife_id: event.wildlife_id }, '[WildlifeBridge] plant eaten');
    this.world.notifyPlantEaten(event.plant_id, event.wildlife_id, event.food_value);
  }
}

// ── Shared animation helper ────────────────────────────────────────────────

function _behaviorToAnimation(behavior: string): string {
  // Rust BehaviorState uses #[serde(rename_all = "snake_case")]
  switch (behavior) {
    case 'fleeing':
    case 'hunting':
      return 'running';
    case 'wandering':
    case 'foraging':
    case 'stalking':
    case 'seeking_mate':
    case 'migrating':
      return 'walking';
    case 'dead':
    case 'dying':
      return 'dead';
    default:
      return 'idle';
  }
}
