import { logger } from '@/utils/logger';
import type { MessageBus } from './MessageBus';

export interface ZoneAssignment {
  zoneId: string;
  serverId: string;
  serverHost: string;
  assignedAt: number;
}

export interface PlayerLocation {
  characterId: string;
  zoneId: string;
  socketId: string;
  serverId: string;
  lastUpdate: number;
}

/**
 * Zone Registry - tracks which zones are hosted on which servers
 *
 * Uses Redis for shared state between Gateway and Zone servers
 */
export class ZoneRegistry {
  private readonly ZONE_ASSIGNMENT_PREFIX = 'zone:assignment:';
  private readonly PLAYER_LOCATION_PREFIX = 'player:location:';
  private readonly SERVER_HEARTBEAT_PREFIX = 'server:heartbeat:';
  private readonly HEARTBEAT_INTERVAL = 5000; // 5 seconds
  private readonly HEARTBEAT_TIMEOUT = 15000; // 15 seconds

  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(
    private messageBus: MessageBus,
    private serverId: string
  ) {}

  /**
   * Start heartbeat for this server
   */
  startHeartbeat(): void {
    this.heartbeatInterval = setInterval(async () => {
      await this.sendHeartbeat();
    }, this.HEARTBEAT_INTERVAL);

    logger.info({ serverId: this.serverId }, 'Zone registry heartbeat started');
  }

  /**
   * Stop heartbeat
   */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Send heartbeat to indicate server is alive
   */
  private async sendHeartbeat(): Promise<void> {
    const client = this.messageBus.getClient();
    const key = `${this.SERVER_HEARTBEAT_PREFIX}${this.serverId}`;

    await client.setEx(key, Math.floor(this.HEARTBEAT_TIMEOUT / 1000), Date.now().toString());
  }

  /**
   * Register that this server is hosting a zone
   */
  async assignZone(zoneId: string, serverHost: string): Promise<void> {
    const client = this.messageBus.getClient();
    const key = `${this.ZONE_ASSIGNMENT_PREFIX}${zoneId}`;

    const assignment: ZoneAssignment = {
      zoneId,
      serverId: this.serverId,
      serverHost,
      assignedAt: Date.now(),
    };

    await client.set(key, JSON.stringify(assignment));

    logger.info({ zoneId, serverId: this.serverId }, 'Zone assigned to server');
  }

  /**
   * Unregister a zone from this server
   */
  async unassignZone(zoneId: string): Promise<void> {
    const client = this.messageBus.getClient();
    const key = `${this.ZONE_ASSIGNMENT_PREFIX}${zoneId}`;

    await client.del(key);

    logger.info({ zoneId, serverId: this.serverId }, 'Zone unassigned from server');
  }

  /**
   * Get which server is hosting a zone
   */
  async getZoneAssignment(zoneId: string): Promise<ZoneAssignment | null> {
    const client = this.messageBus.getClient();
    const key = `${this.ZONE_ASSIGNMENT_PREFIX}${zoneId}`;

    const data = await client.get(key);
    if (!data) return null;

    return JSON.parse(data) as ZoneAssignment;
  }

  /**
   * Update player location in registry
   */
  async updatePlayerLocation(characterId: string, zoneId: string, socketId: string): Promise<void> {
    const client = this.messageBus.getClient();
    const key = `${this.PLAYER_LOCATION_PREFIX}${characterId}`;

    const location: PlayerLocation = {
      characterId,
      zoneId,
      socketId,
      serverId: this.serverId,
      lastUpdate: Date.now(),
    };

    // Set with 1 hour expiration (auto-cleanup for disconnected players)
    await client.setEx(key, 3600, JSON.stringify(location));
  }

  /**
   * Get player location from registry
   */
  async getPlayerLocation(characterId: string): Promise<PlayerLocation | null> {
    const client = this.messageBus.getClient();
    const key = `${this.PLAYER_LOCATION_PREFIX}${characterId}`;

    const data = await client.get(key);
    if (!data) return null;

    return JSON.parse(data) as PlayerLocation;
  }

  /**
   * Remove player from registry (on disconnect)
   */
  async removePlayer(characterId: string): Promise<void> {
    const client = this.messageBus.getClient();
    const key = `${this.PLAYER_LOCATION_PREFIX}${characterId}`;

    await client.del(key);

    logger.debug({ characterId }, 'Player removed from registry');
  }

  /**
   * Get all zone assignments
   */
  async getAllZoneAssignments(): Promise<ZoneAssignment[]> {
    const client = this.messageBus.getClient();
    const pattern = `${this.ZONE_ASSIGNMENT_PREFIX}*`;

    const keys = await client.keys(pattern);
    const assignments: ZoneAssignment[] = [];

    for (const key of keys) {
      const data = await client.get(key);
      if (data) {
        assignments.push(JSON.parse(data) as ZoneAssignment);
      }
    }

    return assignments;
  }

  /**
   * Check if a server is alive based on heartbeat
   */
  async isServerAlive(serverId: string): Promise<boolean> {
    const client = this.messageBus.getClient();
    const key = `${this.SERVER_HEARTBEAT_PREFIX}${serverId}`;

    const exists = await client.exists(key);
    return exists === 1;
  }

  /**
   * Get all active servers
   */
  async getActiveServers(): Promise<string[]> {
    const client = this.messageBus.getClient();
    const pattern = `${this.SERVER_HEARTBEAT_PREFIX}*`;

    const keys = await client.keys(pattern);
    return keys.map(key => key.replace(this.SERVER_HEARTBEAT_PREFIX, ''));
  }

  /**
   * Write authoritative entity positions for a zone to Redis.
   * Called by the zone server after init and after physics moves entities.
   */
  async setZoneEntities(
    zoneId: string,
    entities: Array<{
      id: string; name: string; type: string;
      position: { x: number; y: number; z: number };
      isAlive: boolean;
      description?: string;
      tag?: string; level?: number; faction?: string; aiType?: string;
      notorious?: boolean;
      health?: { current: number; max: number };
    }>
  ): Promise<void> {
    const client = this.messageBus.getClient();
    const key = `zone:entities:${zoneId}`;
    await client.set(key, JSON.stringify(entities));
  }

  /**
   * Read authoritative entity positions for a zone from Redis.
   * Called by the gateway at world_entry time.
   */
  async getZoneEntities(
    zoneId: string
  ): Promise<Array<{
    id: string; name: string; type: string;
    position: { x: number; y: number; z: number };
    isAlive: boolean;
    description?: string;
    tag?: string; level?: number; faction?: string; aiType?: string;
    notorious?: boolean;
    health?: { current: number; max: number };
    interactive?: boolean;
    modelAsset?: string;
    modelScale?: number;
  }> | null> {
    const client = this.messageBus.getClient();
    const key = `zone:entities:${zoneId}`;
    const data = await client.get(key);
    if (!data) return null;
    return JSON.parse(data);
  }

  // ── Zone environment (time / weather) ────────────────────────────────────

  /**
   * Write live zone environment (time of day, weather, lighting) to Redis.
   * Called by the zone server whenever these values change.
   */
  async setZoneEnvironment(
    zoneId: string,
    env: { timeOfDay: string; timeOfDayValue: number; weather: string; lighting: string }
  ): Promise<void> {
    const client = this.messageBus.getClient();
    await client.set(`zone:env:${zoneId}`, JSON.stringify(env));
  }

  /**
   * Read live zone environment from Redis.
   * Called by the gateway at world_entry time so the initial zone packet
   * reflects the current server-side time and weather rather than hardcoded values.
   */
  async getZoneEnvironment(
    zoneId: string
  ): Promise<{ timeOfDay: string; timeOfDayValue: number; weather: string; lighting: string } | null> {
    const client = this.messageBus.getClient();
    const data = await client.get(`zone:env:${zoneId}`);
    if (!data) return null;
    return JSON.parse(data);
  }

  // ── Vault tile grid persistence ─────────────────────────────────────────

  /** Store a vault's tile grid JSON in Redis (zone server writes this). */
  async setVaultTileGrid(instanceId: string, json: string): Promise<void> {
    const client = this.messageBus.getClient();
    await client.set(`vault:tiles:${instanceId}`, json);
  }

  /** Read a vault's tile grid JSON from Redis (gateway reads this). */
  async getVaultTileGrid(instanceId: string): Promise<string | null> {
    const client = this.messageBus.getClient();
    return client.get(`vault:tiles:${instanceId}`);
  }

  /** Remove a vault's tile grid from Redis on teardown. */
  async deleteVaultTileGrid(instanceId: string): Promise<void> {
    const client = this.messageBus.getClient();
    await client.del(`vault:tiles:${instanceId}`);
  }

  /**
   * Clean up this server's assignments on shutdown
   */
  async cleanup(): Promise<void> {
    this.stopHeartbeat();

    // Remove all zone assignments for this server
    const assignments = await this.getAllZoneAssignments();
    for (const assignment of assignments) {
      if (assignment.serverId === this.serverId) {
        await this.unassignZone(assignment.zoneId);
      }
    }

    logger.info({ serverId: this.serverId }, 'Zone registry cleaned up');
  }
}
