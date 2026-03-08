/**
 * VaultManager
 *
 * Manages instanced vault dungeons. Each instance is an in-memory overlay
 * backed by a runtime Zone DB record (like villages). The database zone
 * provides FK compatibility (Character.zoneId); VaultManager provides the
 * phase state machine, room progression, scaling, and disconnect handling.
 *
 * Phase state machine:
 *
 *   SETUP → ACTIVE → COMPLETE | FAILED
 *
 * SETUP:
 *   - Instance created, zone record written, participants registered
 *   - Transitions to ACTIVE once first room is spawned
 *
 * ACTIVE:
 *   - Room-based progression: clear all mobs in a room → advance to next
 *   - Final room contains the boss; defeating it completes the vault
 *
 * COMPLETE:
 *   - Completion rewards broadcast, players can /vault leave at their pace
 *
 * FAILED:
 *   - Total party wipe — all participants dead
 *   - Players ejected to overworld
 *
 * Disconnect handling:
 *   - If any party member remains online, instance persists indefinitely
 *   - If ALL players disconnect, a 2-minute cleanup timer starts
 *   - Reconnecting within the window cancels the timer
 *   - On timer expiry: all players ejected to return points, instance destroyed
 */

import { logger } from '@/utils/logger';
import { randomUUID } from 'crypto';
import { buildRoomsFromTier, type VaultTemplateDefinition, type VaultRoomDef } from './VaultTemplates';
import {
  generateVaultGrid,
  getSpawnPositions,
  lerpPoint,
  Tile,
  TILE_SIZE,
  type VaultTileGridData,
} from './VaultTileGrid';

// ─── Types ────────────────────────────────────────────────────────────────────

export type VaultPhase = 'SETUP' | 'ACTIVE' | 'COMPLETE' | 'FAILED';

export type VaultScalingTier = 'solo' | 'small' | 'party';

export interface VaultScalingModifiers {
  mobHpMultiplier: number;
  mobDamageMultiplier: number;
  dropRateBonus: number;
  bossAlternatePhase: boolean;
}

export interface VaultParticipant {
  characterId: string;
  name: string;
  isOnline: boolean;
  joinedAt: number;
}

export interface VaultRoom {
  index: number;
  name: string;
  def: VaultRoomDef;
  isBossRoom: boolean;
  cleared: boolean;
  /** Entity IDs of mobs currently alive in this room */
  activeMobIds: Set<string>;
}

export interface VaultLootRecord {
  characterId: string;
  templateId: string;
  name: string;
  quantity: number;
  roomIndex: number;
}

export interface VaultCombatLogEntry {
  timestamp: number;
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  abilityId: string;
  damage: number;
  hit: boolean;
}

export interface VaultInstance {
  instanceId: string;
  templateId: string;
  leaderId: string;
  groupSize: number;
  scalingTier: VaultScalingTier;
  zoneId: string;
  participants: Map<string, VaultParticipant>;
  currentRoom: number;
  rooms: VaultRoom[];
  phase: VaultPhase;
  createdAt: number;
  /** Timestamp when last player left (null if someone is online) */
  emptyAt: number | null;
  cleanupTimer: NodeJS.Timeout | null;
  combatLog: VaultCombatLogEntry[];
  lootAwarded: VaultLootRecord[];
  /** Gold reward for completing the vault (from template). */
  completionGold: number;
  /** Procedural tile grid (null if template has no generation params). */
  tileGrid: VaultTileGridData | null;
  /** Gate states — parallel to tileGrid.gates. true = open (passable). */
  gateStates: boolean[];
}

export interface VaultSummary {
  instanceId: string;
  templateId: string;
  vaultName: string;
  duration: number;
  roomsCleared: number;
  totalRooms: number;
  completed: boolean;
  participants: Array<{
    characterId: string;
    name: string;
    damageDealt: number;
    hitsLanded: number;
    damageTaken: number;
  }>;
  lootAwarded: VaultLootRecord[];
}

// ─── Callback types ──────────────────────────────────────────────────────────

export type VaultBroadcastFn = (
  instanceId: string,
  recipientIds: string[],
  event: string,
  data: Record<string, unknown>,
) => void;

export type VaultSpawnMobFn = (
  zoneId: string,
  mobTag: string,
  position: { x: number; y: number; z: number },
  level: number,
  scalingModifiers: VaultScalingModifiers,
  wanderRadius?: number,
) => Promise<string>; // Returns spawned mob entity ID

export type VaultCreateZoneFn = (
  instanceId: string,
  template: VaultTemplateDefinition,
) => Promise<string>; // Returns zoneId

export type VaultDestroyZoneFn = (
  zoneId: string,
) => Promise<void>;

export type VaultEjectPlayerFn = (
  characterId: string,
) => Promise<void>;

export type VaultAwardGoldFn = (
  characterId: string,
  amount: number,
) => Promise<void>;

// ─── Constants ────────────────────────────────────────────────────────────────

const EMPTY_TIMEOUT_MS = 120_000; // 2 minutes

const SCALING: Record<VaultScalingTier, VaultScalingModifiers> = {
  solo:  { mobHpMultiplier: 1.0,  mobDamageMultiplier: 1.0,  dropRateBonus: 0.00, bossAlternatePhase: false },
  small: { mobHpMultiplier: 1.2,  mobDamageMultiplier: 1.15, dropRateBonus: 0.25, bossAlternatePhase: false },
  party: { mobHpMultiplier: 1.5,  mobDamageMultiplier: 1.30, dropRateBonus: 0.50, bossAlternatePhase: true },
};

// ─── VaultManager ─────────────────────────────────────────────────────────────

export class VaultManager {
  /** instanceId → VaultInstance */
  private instances = new Map<string, VaultInstance>();

  /** characterId → instanceId (quick reverse lookup) */
  private characterToInstance = new Map<string, string>();

  /** zoneId → instanceId (vault zone ID lookup) */
  private zoneToInstance = new Map<string, string>();

  constructor(
    private broadcast: VaultBroadcastFn,
    private spawnMob: VaultSpawnMobFn,
    private createZone: VaultCreateZoneFn,
    private destroyZone: VaultDestroyZoneFn,
    private ejectPlayer: VaultEjectPlayerFn,
    private awardGold: VaultAwardGoldFn,
  ) {}

  // ── Instance lifecycle ─────────────────────────────────────────────────────

  /**
   * Create a new vault instance. Spins up the zone and registers all participants.
   * Returns the instanceId. Call spawnRoom(instanceId, 0) after transferring players.
   */
  async createInstance(
    leaderId: string,
    _leaderName: string,
    partyMembers: Array<{ id: string; name: string }>,
    template: VaultTemplateDefinition,
  ): Promise<string> {
    // Prevent double-entry
    if (this.characterToInstance.has(leaderId)) {
      throw new Error('You are already in a vault instance.');
    }

    const instanceId = randomUUID();
    const groupSize = partyMembers.length;
    const scalingTier = VaultManager.getScalingTier(groupSize);

    // Create the zone DB record
    const zoneId = await this.createZone(instanceId, template);

    // Build room state — use tier-based generation when available, else static template
    const roomDefs: VaultRoomDef[] =
      template.tierMobDefs && template.generation?.tier != null
        ? buildRoomsFromTier(template.generation.tier, template.tierMobDefs)
        : template.rooms;

    const rooms: VaultRoom[] = roomDefs.map((def, i) => ({
      index: i,
      name: def.name,
      def,
      isBossRoom: def.isBossRoom,
      cleared: false,
      activeMobIds: new Set(),
    }));

    // Build participant map
    const participants = new Map<string, VaultParticipant>();
    for (const member of partyMembers) {
      participants.set(member.id, {
        characterId: member.id,
        name: member.name,
        isOnline: true,
        joinedAt: Date.now(),
      });
    }

    // ── Generate tile grid if template has generation params ──────────────
    let tileGrid: VaultTileGridData | null = null;
    if (template.generation) {
      const widthTiles  = Math.floor(template.zoneDimensions.sizeX / TILE_SIZE);
      const heightTiles = Math.floor(template.zoneDimensions.sizeZ / TILE_SIZE);
      tileGrid = generateVaultGrid(widthTiles, heightTiles, template.generation, instanceId);

      // Attach 3D geometry metadata so the client can build walls + ceiling
      if (template.geometry) {
        tileGrid.geometry = template.geometry;
      }

      logger.info(
        { instanceId, widthTiles, heightTiles, entrance: tileGrid.entrance, exit: tileGrid.exit },
        'Vault tile grid generated',
      );
    }

    const instance: VaultInstance = {
      instanceId,
      templateId: template.templateId,
      leaderId,
      groupSize,
      scalingTier,
      zoneId,
      participants,
      currentRoom: 0,
      rooms,
      phase: 'SETUP',
      createdAt: Date.now(),
      emptyAt: null,
      cleanupTimer: null,
      combatLog: [],
      lootAwarded: [],
      completionGold: template.completionGold,
      tileGrid,
      gateStates: new Array(tileGrid?.gates?.length ?? 0).fill(false),
    };

    this.instances.set(instanceId, instance);
    this.zoneToInstance.set(zoneId, instanceId);
    for (const member of partyMembers) {
      this.characterToInstance.set(member.id, instanceId);
    }

    logger.info(
      { instanceId, leaderId, groupSize, scalingTier, zoneId },
      'Vault instance created',
    );

    return instanceId;
  }

  /**
   * Spawn mobs for a specific room in the vault.
   * Transitions phase to ACTIVE if still in SETUP.
   */
  async spawnRoom(instanceId: string, roomIndex: number): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error('Vault instance not found.');

    const room = instance.rooms[roomIndex];
    if (!room) throw new Error(`Room ${roomIndex} does not exist.`);

    if (room.cleared) {
      logger.warn({ instanceId, roomIndex }, 'Attempted to spawn already-cleared room');
      return;
    }

    const scaling = VaultManager.getScalingModifiers(instance.scalingTier);
    const baseLevel = 5; // From template; hardcoded for now

    // ── Derive mob positions from tile grid when available ───────────
    const totalMobs = room.def.mobs.reduce((sum, m) => sum + m.count, 0);
    let mobPositions: Array<{ x: number; y: number; z: number }>;

    // Compute room-aware radius from stored room dimensions
    const roomSize = instance.tileGrid?.roomSizes?.[roomIndex];
    const roomRadius = roomSize
      ? Math.max(roomSize.width, roomSize.height) / 2
      : 18;

    if (instance.tileGrid?.roomCenters?.[roomIndex]) {
      // Multi-room: each room has its own center anchor.
      // maxDistance keeps spawns inside the room.
      const anchor = instance.tileGrid.roomCenters[roomIndex]!;
      mobPositions = getSpawnPositions(instance.tileGrid, anchor, totalMobs, 3, roomRadius);
    } else if (instance.tileGrid) {
      // Single-room fallback: distribute mobs along entrance→exit axis
      const totalRooms = instance.rooms.length;
      const t = (roomIndex + 0.5) / totalRooms;
      const anchor = lerpPoint(instance.tileGrid.entrance, instance.tileGrid.exit, t);
      mobPositions = getSpawnPositions(instance.tileGrid, anchor, totalMobs, 3);
    } else {
      // No tile grid: use hardcoded template positions
      mobPositions = room.def.spawnPositions.mob.slice();
    }

    let mobSpawnIndex = 0;

    for (const mobDef of room.def.mobs) {
      for (let i = 0; i < mobDef.count; i++) {
        const pos = mobPositions[mobSpawnIndex % mobPositions.length]
          ?? { x: 0, y: 0, z: 0 };
        const level = baseLevel + mobDef.levelOffset;

        try {
          const entityId = await this.spawnMob(
            instance.zoneId,
            mobDef.mobTag,
            pos,
            level,
            scaling,
            roomRadius,
          );
          room.activeMobIds.add(entityId);
        } catch (err) {
          logger.error({ instanceId, roomIndex, mobTag: mobDef.mobTag, err }, 'Failed to spawn vault mob');
        }

        mobSpawnIndex++;
      }
    }

    // Transition to ACTIVE on first room spawn
    if (instance.phase === 'SETUP') {
      instance.phase = 'ACTIVE';
    }

    instance.currentRoom = roomIndex;

    const allIds = this.getOnlineParticipantIds(instance);
    this.broadcast(instanceId, allIds, 'vault_room_enter', {
      instanceId,
      roomIndex,
      roomName: room.name,
      isBossRoom: room.isBossRoom,
      mobCount: room.activeMobIds.size,
      message: room.isBossRoom
        ? `Entering ${room.name}... The boss awaits.`
        : `Entering ${room.name}...`,
    });

    logger.info(
      { instanceId, roomIndex, roomName: room.name, mobCount: room.activeMobIds.size },
      'Vault room spawned',
    );
  }

  // ── Room progression ────────────────────────────────────────────────────────

  /**
   * Called by DWM when a mob dies inside a vault zone.
   * Removes the mob from the active set, checks if the room is cleared,
   * and advances to the next room or completes the vault.
   */
  reportMobDeath(mobEntityId: string, zoneId: string): void {
    const instanceId = this.zoneToInstance.get(zoneId);
    if (!instanceId) return;

    const instance = this.instances.get(instanceId);
    if (!instance || instance.phase !== 'ACTIVE') return;

    const room = instance.rooms[instance.currentRoom];
    if (!room) return;

    const removed = room.activeMobIds.delete(mobEntityId);
    if (!removed) return;

    const allIds = this.getOnlineParticipantIds(instance);

    // Broadcast remaining enemy count
    this.broadcast(instanceId, allIds, 'vault_mob_killed', {
      instanceId,
      roomIndex: instance.currentRoom,
      remainingMobs: room.activeMobIds.size,
    });

    // Check if room is cleared
    if (room.activeMobIds.size === 0) {
      room.cleared = true;

      this.broadcast(instanceId, allIds, 'vault_room_cleared', {
        instanceId,
        roomIndex: instance.currentRoom,
        roomName: room.name,
        message: `${room.name} cleared!`,
      });

      logger.info({ instanceId, roomIndex: instance.currentRoom }, 'Vault room cleared');

      // ── Open any gates unlocked by clearing this room ─────────────
      // Gate at corridor i opens when room i is cleared.
      this.tryOpenGate(instance, instance.currentRoom, allIds);

      // Advance to next room or complete
      const nextRoomIndex = instance.currentRoom + 1;
      if (nextRoomIndex < instance.rooms.length) {
        // Spawn next room asynchronously
        void this.spawnRoom(instanceId, nextRoomIndex);
      } else {
        // All rooms cleared — vault complete
        void this.completeVault(instanceId);
      }
    }
  }

  // ── Gate management ─────────────────────────────────────────────────────────

  /**
   * Open the gate at corridor `corridorIndex` if one exists.
   * Swaps gate WALL tiles back to FLOOR in the live tile grid and
   * broadcasts `vault_gate_opened` so clients can update.
   */
  private tryOpenGate(
    instance: VaultInstance,
    corridorIndex: number,
    recipientIds: string[],
  ): void {
    if (!instance.tileGrid?.gates) return;

    const gateIdx = instance.tileGrid.gates.findIndex(
      g => g.corridorIndex === corridorIndex,
    );
    if (gateIdx === -1) return;
    if (instance.gateStates[gateIdx]) return; // already open

    const gate = instance.tileGrid.gates[gateIdx]!;

    // Swap gate tiles from WALL → FLOOR in the live grid
    for (const { row, col } of gate.tiles) {
      const idx = row * instance.tileGrid.width + col;
      instance.tileGrid.tiles[idx] = Tile.FLOOR;
    }

    instance.gateStates[gateIdx] = true;

    this.broadcast(instance.instanceId, recipientIds, 'vault_gate_opened', {
      instanceId: instance.instanceId,
      corridorIndex,
      gateIndex: gateIdx,
      position: gate.position,
      orientation: gate.orientation,
      tiles: gate.tiles,
      message: 'A gate has opened ahead!',
    });

    logger.info(
      { instanceId: instance.instanceId, corridorIndex, gateIndex: gateIdx },
      'Vault gate opened',
    );
  }

  /**
   * Check if a specific gate is open.
   */
  isGateOpen(instanceId: string, gateIndex: number): boolean {
    const instance = this.instances.get(instanceId);
    if (!instance) return false;
    return instance.gateStates[gateIndex] ?? false;
  }

  // ── Completion / Failure ────────────────────────────────────────────────────

  /**
   * Called when all rooms are cleared. Awards completion rewards and
   * transitions to COMPLETE phase. Players remain in the vault zone
   * and can /vault leave when ready.
   */
  private async completeVault(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    instance.phase = 'COMPLETE';

    // ── Distribute completion gold to all online participants ────────────
    const onlineParticipants = Array.from(instance.participants.values()).filter(p => p.isOnline);
    const participantCount = Math.max(1, onlineParticipants.length);
    const goldPerPlayer = Math.floor(instance.completionGold / participantCount);

    if (goldPerPlayer > 0) {
      for (const participant of onlineParticipants) {
        try {
          await this.awardGold(participant.characterId, goldPerPlayer);
        } catch (err) {
          logger.error({ characterId: participant.characterId, gold: goldPerPlayer, err }, 'Failed to award vault completion gold');
        }
      }
      logger.info(
        { instanceId, totalGold: instance.completionGold, perPlayer: goldPerPlayer, players: participantCount },
        'Vault completion gold distributed',
      );
    }

    const summary = this.buildSummary(instance);
    const allIds = this.getOnlineParticipantIds(instance);

    this.broadcast(instanceId, allIds, 'vault_complete', {
      instanceId,
      summary,
      goldAwarded: goldPerPlayer,
      message: `Vault complete! Each participant receives ${goldPerPlayer} gold. Use /vault leave to return to the overworld.`,
    });

    logger.info(
      { instanceId, duration: summary.duration, roomsCleared: summary.roomsCleared },
      'Vault completed',
    );
  }

  /**
   * Called on total party wipe. Ejects all players and cleans up.
   */
  async failVault(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance || instance.phase === 'FAILED' || instance.phase === 'COMPLETE') return;

    instance.phase = 'FAILED';

    const allIds = this.getOnlineParticipantIds(instance);
    this.broadcast(instanceId, allIds, 'vault_failed', {
      instanceId,
      message: 'Your party has been defeated. You are ejected from the vault.',
    });

    // Eject all participants
    for (const participant of instance.participants.values()) {
      try {
        await this.ejectPlayer(participant.characterId);
      } catch (err) {
        logger.error({ characterId: participant.characterId, err }, 'Failed to eject player from vault');
      }
    }

    await this.cleanup(instanceId);
    logger.info({ instanceId }, 'Vault failed — all players ejected');
  }

  // ── Player entry/exit ──────────────────────────────────────────────────────

  /**
   * Mark a player as online in the vault. Called when they zone into the vault.
   */
  handlePlayerJoin(characterId: string): void {
    const instanceId = this.characterToInstance.get(characterId);
    if (!instanceId) return;

    const instance = this.instances.get(instanceId);
    if (!instance) return;

    const participant = instance.participants.get(characterId);
    if (participant) {
      participant.isOnline = true;
    }

    // Cancel cleanup timer if someone reconnected
    if (instance.cleanupTimer) {
      clearTimeout(instance.cleanupTimer);
      instance.cleanupTimer = null;
      instance.emptyAt = null;
      logger.info({ instanceId, characterId }, 'Vault cleanup timer cancelled — player rejoined');
    }
  }

  /**
   * Mark a player as offline. If all participants are offline, start the
   * cleanup timer.
   */
  handleDisconnect(characterId: string): void {
    const instanceId = this.characterToInstance.get(characterId);
    if (!instanceId) return;

    const instance = this.instances.get(instanceId);
    if (!instance) return;

    const participant = instance.participants.get(characterId);
    if (participant) {
      participant.isOnline = false;
    }

    // Check if anyone is still online
    const anyOnline = Array.from(instance.participants.values()).some(p => p.isOnline);

    if (!anyOnline) {
      instance.emptyAt = Date.now();

      instance.cleanupTimer = setTimeout(async () => {
        logger.info({ instanceId }, 'Vault cleanup timer expired — ejecting all players');

        // Eject all participants back to overworld
        for (const p of instance.participants.values()) {
          try {
            await this.ejectPlayer(p.characterId);
          } catch (err) {
            logger.error({ characterId: p.characterId, err }, 'Failed to eject player on vault timeout');
          }
        }

        await this.cleanup(instanceId);
      }, EMPTY_TIMEOUT_MS);

      logger.info(
        { instanceId, timeoutMs: EMPTY_TIMEOUT_MS },
        'All players offline — vault cleanup timer started',
      );
    }
  }

  /**
   * Remove a single player from the vault (they chose to leave via /vault leave).
   */
  removeParticipant(characterId: string): void {
    const instanceId = this.characterToInstance.get(characterId);
    if (!instanceId) return;

    const instance = this.instances.get(instanceId);
    if (!instance) return;

    instance.participants.delete(characterId);
    this.characterToInstance.delete(characterId);

    // Notify remaining players
    const remainingIds = this.getOnlineParticipantIds(instance);
    if (remainingIds.length > 0) {
      this.broadcast(instanceId, remainingIds, 'vault_player_left', {
        instanceId,
        characterId,
        remainingPlayers: remainingIds.length,
      });
    }

    // If no participants left, clean up
    if (instance.participants.size === 0) {
      void this.cleanup(instanceId);
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────────

  private async cleanup(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    if (instance.cleanupTimer) {
      clearTimeout(instance.cleanupTimer);
    }

    // Remove all participant mappings
    for (const participantId of instance.participants.keys()) {
      this.characterToInstance.delete(participantId);
    }

    // Destroy the zone
    try {
      await this.destroyZone(instance.zoneId);
    } catch (err) {
      logger.error({ instanceId, zoneId: instance.zoneId, err }, 'Failed to destroy vault zone');
    }

    this.zoneToInstance.delete(instance.zoneId);
    this.instances.delete(instanceId);

    logger.info({ instanceId }, 'Vault instance cleaned up');
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  getInstanceForCharacter(characterId: string): VaultInstance | null {
    const instanceId = this.characterToInstance.get(characterId);
    if (!instanceId) return null;
    return this.instances.get(instanceId) ?? null;
  }

  getInstanceByZone(zoneId: string): VaultInstance | null {
    const instanceId = this.zoneToInstance.get(zoneId);
    if (!instanceId) return null;
    return this.instances.get(instanceId) ?? null;
  }

  isInVault(characterId: string): boolean {
    return this.characterToInstance.has(characterId);
  }

  /** Return the tile grid for a vault instance (used by HTTP endpoint). */
  getTileGrid(instanceId: string): VaultTileGridData | null {
    return this.instances.get(instanceId)?.tileGrid ?? null;
  }

  // ── Combat logging ──────────────────────────────────────────────────────────

  recordCombatEvent(entry: VaultCombatLogEntry): void {
    const instanceId = this.characterToInstance.get(entry.sourceId);
    if (!instanceId) return;
    const instance = this.instances.get(instanceId);
    if (!instance || instance.phase !== 'ACTIVE') return;
    instance.combatLog.push(entry);
  }

  // ── Static helpers ──────────────────────────────────────────────────────────

  static vaultZoneId(instanceId: string): string {
    return `vault:${instanceId}`;
  }

  static isVaultZone(zoneId: string): boolean {
    return zoneId.startsWith('vault:');
  }

  static extractInstanceId(zoneId: string): string | null {
    if (!zoneId.startsWith('vault:')) return null;
    return zoneId.slice('vault:'.length);
  }

  static getScalingTier(groupSize: number): VaultScalingTier {
    if (groupSize <= 1) return 'solo';
    if (groupSize <= 3) return 'small';
    return 'party';
  }

  static getScalingModifiers(tier: VaultScalingTier): VaultScalingModifiers {
    return SCALING[tier];
  }

  /**
   * Generate unique negative world coordinates for a vault Zone record,
   * avoiding collision with village zones (which use offset 1_000_000).
   */
  static vaultWorldCoords(instanceId: string): { worldX: number; worldY: number } {
    const clean = instanceId.replace(/-/g, '');
    const worldX = -(parseInt(clean.substring(0, 8), 16) % 1_000_000 + 2_000_001);
    const worldY = -(parseInt(clean.substring(8, 16), 16) % 1_000_000 + 2_000_001);
    return { worldX, worldY };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private getOnlineParticipantIds(instance: VaultInstance): string[] {
    return Array.from(instance.participants.values())
      .filter(p => p.isOnline)
      .map(p => p.characterId);
  }

  private buildSummary(instance: VaultInstance): VaultSummary {
    const duration = Math.round((Date.now() - instance.createdAt) / 1000);
    const roomsCleared = instance.rooms.filter(r => r.cleared).length;

    // Aggregate combat stats
    const stats = new Map<string, {
      characterId: string;
      name: string;
      damageDealt: number;
      hitsLanded: number;
      damageTaken: number;
    }>();

    for (const p of instance.participants.values()) {
      stats.set(p.characterId, {
        characterId: p.characterId,
        name: p.name,
        damageDealt: 0,
        hitsLanded: 0,
        damageTaken: 0,
      });
    }

    for (const entry of instance.combatLog) {
      const src = stats.get(entry.sourceId);
      if (src && entry.hit) {
        src.damageDealt += entry.damage;
        src.hitsLanded += 1;
      }
      const tgt = stats.get(entry.targetId);
      if (tgt && entry.hit) {
        tgt.damageTaken += entry.damage;
      }
    }

    return {
      instanceId: instance.instanceId,
      templateId: instance.templateId,
      vaultName: instance.rooms[0]?.name ?? 'Unknown',
      duration,
      roomsCleared,
      totalRooms: instance.rooms.length,
      completed: instance.phase === 'COMPLETE',
      participants: Array.from(stats.values()),
      lootAwarded: instance.lootAwarded,
    };
  }
}
