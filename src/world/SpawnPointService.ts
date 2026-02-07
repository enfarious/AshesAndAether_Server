/**
 * SpawnPointService - Manages spawn points for zones
 * 
 * Determines where characters/mobs/NPCs should appear when:
 * - First time login (new character spawn)
 * - Logout/login (last position or safe point)
 * - Death respawn (home/city/graveyard)
 * - Zone transfer (entry points)
 * - Mob/NPC spawning (respawn timers, leashing)
 */

import { ElevationService } from './terrain/ElevationService';
import type { Vector3 } from '@/network/protocol/types';

export type SpawnPointType = 'starter' | 'city' | 'home' | 'graveyard' | 'entry' | 'mob' | 'npc';

export interface MobSpawnConfig {
  /** List of mob IDs that can spawn here */
  mobIds: string[];
  /** Maximum total entities that can spawn from this point */
  maxTotal: number;
  /** Max count per individual mob type */
  maxPerType?: Record<string, number>;
  /** Respawn timer per mob type in seconds */
  respawnTimers?: Record<string, number>;
  /** Default respawn timer if not specified per type */
  defaultRespawnSeconds: number;
  /** Maximum distance mobs can wander from spawn point (meters) */
  leashDistance: number;
  /** Whether mobs return to spawn when leashed */
  returnOnLeash: boolean;
}

export interface SpawnPoint {
  name: string;
  zoneId: string;
  position: Vector3;
  heading?: number;
  description?: string;
  type: SpawnPointType;
  /** Only for mob/npc spawns */
  mobConfig?: MobSpawnConfig;
  /** Player-only spawns ignore mob spawning */
  playerOnly?: boolean;
}

/**
 * Zone-specific spawn point configurations
 * TODO: Move to database when zone system is expanded
 */
const ZONE_SPAWN_POINTS: Record<string, SpawnPoint[]> = {
  'USA_NY_Stephentown': [
    {
      name: 'Town Hall',
      zoneId: 'USA_NY_Stephentown',
      position: { x: 12, y: 265, z: -18 }, // Road just outside Town Hall (adjusted to terrain)
      heading: 180, // Facing south
      description: 'On the road just outside Stephentown City Hall',
      type: 'starter',
      playerOnly: true,
    },
    // Example mob spawn - corrupted creatures
    {
      name: 'Old Mill Ruins',
      zoneId: 'USA_NY_Stephentown',
      position: { x: 150, y: 265, z: -80 },
      description: 'Corrupted creatures lurk in the abandoned mill',
      type: 'mob',
      mobConfig: {
        mobIds: ['corrupted_rat', 'shadow_hound', 'broken_construct'],
        maxTotal: 6,
        maxPerType: { corrupted_rat: 3, shadow_hound: 2, broken_construct: 1 },
        respawnTimers: { corrupted_rat: 180, shadow_hound: 300, broken_construct: 900 }, // seconds
        defaultRespawnSeconds: 300,
        leashDistance: 40, // 40m leash radius
        returnOnLeash: true,
      },
    },
  ],
};

export class SpawnPointService {
  private static elevationService: ElevationService | null = null;

  /**
   * Initialize the service (call once at startup)
   */
  static initialize(): void {
    this.elevationService = ElevationService.tryLoad();
  }

  /**
   * Get the default spawn point for a zone (new character spawn)
   */
  /**
   * Get respawn position for character - checks last position first, falls back to city/starter spawn
   * Used when character logs back in (not death respawn)
   */
  static getRespawnPosition(
    zoneId: string,
    lastPositionX?: number,
    lastPositionY?: number,
    lastPositionZ?: number
  ): Vector3 {
    // If character has a last position, use it (with slight collision avoidance)
    if (lastPositionX !== undefined && lastPositionY !== undefined && lastPositionZ !== undefined) {
      const adjustedPos = this.adjustSpawnToTerrain({
        name: 'last_position',
        zoneId,
        position: { x: lastPositionX, y: lastPositionY, z: lastPositionZ },
        type: 'entry',
      });
      
      // Add small random offset to avoid collisions (0.5-1.5m away)
      const angle = Math.random() * Math.PI * 2;
      const distance = 0.5 + Math.random() * 1;
      adjustedPos.position.x += Math.cos(angle) * distance;
      adjustedPos.position.z += Math.sin(angle) * distance;
      
      return adjustedPos.position;
    }

    // Fall back to city/starter spawn
    const citySpawn = this.getCitySpawn(zoneId);
    return (citySpawn?.position || this.getStarterSpawn(zoneId)?.position) || { x: 0, y: 265, z: 0 };
  }

  static getStarterSpawn(zoneId: string): SpawnPoint | null {
    const spawnPoints = ZONE_SPAWN_POINTS[zoneId];
    if (!spawnPoints) return null;

    const starter = spawnPoints.find(sp => sp.type === 'starter');
    if (!starter) return spawnPoints[0]; // Fallback to first spawn

    // Adjust Y position to terrain elevation
    return this.adjustSpawnToTerrain(starter);
  }

  /**
   * Get a city spawn point (for respawn after death)
   */
  static getCitySpawn(zoneId: string): SpawnPoint | null {
    const spawnPoints = ZONE_SPAWN_POINTS[zoneId];
    if (!spawnPoints) return null;

    const city = spawnPoints.find(sp => sp.type === 'city');
    if (city) return this.adjustSpawnToTerrain(city);

    // Fallback to starter spawn
    return this.getStarterSpawn(zoneId);
  }

  /**
   * Get mob spawn points for a zone
   */
  static getMobSpawns(zoneId: string): SpawnPoint[] {
    const spawnPoints = ZONE_SPAWN_POINTS[zoneId] || [];
    return spawnPoints
      .filter(sp => sp.type === 'mob' || sp.type === 'npc')
      .map(sp => this.adjustSpawnToTerrain(sp));
  }

  /**
   * Get a specific spawn point by name
   */
  static getSpawnByName(zoneId: string, name: string): SpawnPoint | null {
    const spawnPoints = ZONE_SPAWN_POINTS[zoneId] || [];
    const spawn = spawnPoints.find(sp => sp.name === name);
    return spawn ? this.adjustSpawnToTerrain(spawn) : null;
  }

  /**
   * Adjust spawn point Y coordinate to match terrain elevation
   */
  private static adjustSpawnToTerrain(spawn: SpawnPoint): SpawnPoint {
    if (!this.elevationService) {
      return spawn; // Return as-is if no elevation data
    }

    const metadata = this.elevationService.getMetadata();
    const centerLat = metadata.center?.lat ?? metadata.originLat;
    const centerLon = metadata.center?.lon ?? metadata.originLon;

    // Convert world coords to lat/lon
    const latOffset = spawn.position.z / 111320;
    const lonOffset = spawn.position.x / (111320 * Math.cos((centerLat * Math.PI) / 180));
    const spawnLat = centerLat + latOffset;
    const spawnLon = centerLon + lonOffset;

    const elevation = this.elevationService.getElevationMeters(spawnLat, spawnLon);
    if (elevation === null) {
      return spawn; // Return as-is if no elevation at this point
    }

    // Return new spawn with adjusted elevation (+ 1.7m for character height)
    return {
      ...spawn,
      position: {
        x: spawn.position.x,
        y: elevation + 1.7,
        z: spawn.position.z,
      },
    };
  }

  /**
   * Register a new spawn point (for future use with player housing)
   */
  static registerSpawn(spawn: SpawnPoint): void {
    const zoneSpawns = ZONE_SPAWN_POINTS[spawn.zoneId] || [];
    zoneSpawns.push(spawn);
    ZONE_SPAWN_POINTS[spawn.zoneId] = zoneSpawns;
  }
}
