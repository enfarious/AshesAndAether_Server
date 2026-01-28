/**
 * TileStateManager - Manages state for all active tiles.
 *
 * Handles:
 * - Tracking player positions and tile occupancy
 * - Evaluating and executing state transitions
 * - Coordinating tile loading/unloading
 * - Broadcasting state change events
 */

import { EventEmitter } from 'events';
import { TileStateTimings } from './TileConstants';
import {
  type TileAddress,
  tileAddressToId,
  tileAddressFromId,
  tilesEqual,
} from './TileAddress';
import { getTilesInRadius, getMicroTile } from './TileUtils';
import {
  TileState,
  TransitionReason,
  type TileStateData,
  type TileTransitionEvent,
  createInitialStateData,
  evaluateTransition,
  applyTransition,
  playerEntered,
  playerLeft,
  updateNearbyPlayers,
  createTransitionEvent,
} from './TileState';
import { logger } from '@/utils/logger';

/**
 * Player position tracking
 */
interface TrackedPlayer {
  characterId: string;
  lat: number;
  lon: number;
  currentTileId: string | null;
}

/**
 * Events emitted by TileStateManager
 */
export interface TileStateManagerEvents {
  /** Tile transitioned to a new state */
  transition: (event: TileTransitionEvent) => void;
  /** Tile needs to be loaded (COLD → WARM/HOT) */
  tileLoad: (tileId: string, tile: TileAddress) => void;
  /** Tile can be unloaded (→ COLD) */
  tileUnload: (tileId: string, tile: TileAddress) => void;
  /** HOT tile tick */
  hotTick: (tiles: TileAddress[]) => void;
  /** WARM tile tick */
  warmTick: (tiles: TileAddress[]) => void;
}

/**
 * TileStateManager - Central coordinator for tile states
 */
export class TileStateManager extends EventEmitter {
  /** State data for all tracked tiles */
  private tileStates: Map<string, TileStateData> = new Map();

  /** Player positions */
  private players: Map<string, TrackedPlayer> = new Map();

  /** Timer for state evaluation */
  private evaluationTimer: NodeJS.Timeout | null = null;

  /** Timer for HOT tile ticks */
  private hotTickTimer: NodeJS.Timeout | null = null;

  /** Timer for WARM tile ticks */
  private warmTickTimer: NodeJS.Timeout | null = null;

  /** Whether the manager is running */
  private running = false;

  constructor() {
    super();
  }

  /**
   * Start the tile state manager
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Evaluate state transitions every 10 seconds
    this.evaluationTimer = setInterval(() => this.evaluateAllTransitions(), 10000);

    // HOT tile tick (1 second)
    this.hotTickTimer = setInterval(() => this.tickHotTiles(), TileStateTimings.HOT_TICK_MS);

    // WARM tile tick (1 minute)
    this.warmTickTimer = setInterval(() => this.tickWarmTiles(), TileStateTimings.WARM_TICK_MS);

    logger.info('[TileStateManager] Started');
  }

  /**
   * Stop the tile state manager
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = null;
    }

    if (this.hotTickTimer) {
      clearInterval(this.hotTickTimer);
      this.hotTickTimer = null;
    }

    if (this.warmTickTimer) {
      clearInterval(this.warmTickTimer);
      this.warmTickTimer = null;
    }

    logger.info('[TileStateManager] Stopped');
  }

  /**
   * Update a player's position
   */
  updatePlayerPosition(characterId: string, lat: number, lon: number): void {
    const microTile = getMicroTile(lat, lon);
    if (!microTile) {
      logger.warn(`[TileStateManager] Invalid position for player ${characterId}: ${lat}, ${lon}`);
      return;
    }

    const newTileId = tileAddressToId(microTile);
    const player = this.players.get(characterId);
    const previousTileId = player?.currentTileId;

    // Update player record
    this.players.set(characterId, {
      characterId,
      lat,
      lon,
      currentTileId: newTileId,
    });

    // Handle tile changes
    if (previousTileId !== newTileId) {
      // Player left previous tile
      if (previousTileId) {
        this.handlePlayerLeftTile(characterId, previousTileId);
      }

      // Player entered new tile
      this.handlePlayerEnteredTile(characterId, newTileId, microTile);
    }

    // Update nearby tile counts
    this.updateNearbyTiles(microTile);
  }

  /**
   * Remove a player from tracking
   */
  removePlayer(characterId: string): void {
    const player = this.players.get(characterId);
    if (!player) return;

    if (player.currentTileId) {
      this.handlePlayerLeftTile(characterId, player.currentTileId);
    }

    this.players.delete(characterId);
  }

  /**
   * Get the current state of a tile
   */
  getTileState(tileId: string): TileState {
    return this.tileStates.get(tileId)?.state ?? TileState.COLD;
  }

  /**
   * Get full state data for a tile
   */
  getTileStateData(tileId: string): TileStateData | null {
    return this.tileStates.get(tileId) ?? null;
  }

  /**
   * Get all tiles in a specific state
   */
  getTilesInState(state: TileState): TileAddress[] {
    const tiles: TileAddress[] = [];
    for (const [tileId, data] of this.tileStates) {
      if (data.state === state) {
        const tile = tileAddressFromId(tileId);
        if (tile) tiles.push(tile);
      }
    }
    return tiles;
  }

  /**
   * Get counts by state
   */
  getStateCounts(): Record<TileState, number> {
    const counts = {
      [TileState.COLD]: 0,
      [TileState.WARM]: 0,
      [TileState.HOT]: 0,
    };

    for (const data of this.tileStates.values()) {
      counts[data.state]++;
    }

    return counts;
  }

  /**
   * Force a tile to a specific state (for testing/admin)
   */
  forceState(tileId: string, newState: TileState): void {
    const tile = tileAddressFromId(tileId);
    if (!tile) {
      logger.warn(`[TileStateManager] Invalid tile ID: ${tileId}`);
      return;
    }

    let data = this.tileStates.get(tileId);
    const previousState = data?.state ?? TileState.COLD;

    if (!data) {
      data = createInitialStateData();
      this.tileStates.set(tileId, data);
    }

    if (previousState !== newState) {
      this.tileStates.set(tileId, applyTransition(data, newState));
      this.emitTransition(tile, previousState, newState, TransitionReason.MANUAL);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private methods
  // ─────────────────────────────────────────────────────────────────────────────

  private handlePlayerEnteredTile(
    characterId: string,
    tileId: string,
    tile: TileAddress
  ): void {
    let data = this.tileStates.get(tileId);

    if (!data) {
      data = createInitialStateData();
      this.tileStates.set(tileId, data);
    }

    // Update player count
    data = playerEntered(data);
    this.tileStates.set(tileId, data);

    // Evaluate transition
    this.evaluateTileTransition(tileId, tile);

    logger.debug(`[TileStateManager] Player ${characterId} entered tile ${tileId}`);
  }

  private handlePlayerLeftTile(characterId: string, tileId: string): void {
    const data = this.tileStates.get(tileId);
    if (!data) return;

    // Update player count
    const newData = playerLeft(data);
    this.tileStates.set(tileId, newData);

    logger.debug(`[TileStateManager] Player ${characterId} left tile ${tileId}`);
  }

  private updateNearbyTiles(centerTile: TileAddress): void {
    const nearbyTiles = getTilesInRadius(centerTile, TileStateTimings.PREFETCH_RADIUS_TILES);

    for (const tile of nearbyTiles) {
      const tileId = tileAddressToId(tile);

      // Count players in this tile and nearby
      let nearbyCount = 0;
      for (const player of this.players.values()) {
        if (!player.currentTileId) continue;
        const playerTile = tileAddressFromId(player.currentTileId);
        if (!playerTile) continue;

        // Check if player is within prefetch radius of this tile
        const playerNearby = getTilesInRadius(playerTile, TileStateTimings.PREFETCH_RADIUS_TILES);
        if (playerNearby.some((t) => tilesEqual(t, tile))) {
          nearbyCount++;
        }
      }

      let data = this.tileStates.get(tileId);
      if (!data && nearbyCount > 0) {
        data = createInitialStateData();
      }

      if (data) {
        const newData = updateNearbyPlayers(data, nearbyCount);
        this.tileStates.set(tileId, newData);
        this.evaluateTileTransition(tileId, tile);
      }
    }
  }

  private evaluateTileTransition(tileId: string, tile: TileAddress): void {
    const data = this.tileStates.get(tileId);
    if (!data) return;

    const result = evaluateTransition(data);

    if (result.shouldTransition && result.newState && result.reason) {
      const previousState = data.state;
      const newData = applyTransition(data, result.newState);
      this.tileStates.set(tileId, newData);

      this.emitTransition(tile, previousState, result.newState, result.reason);
    }
  }

  private evaluateAllTransitions(): void {
    for (const [tileId, data] of this.tileStates) {
      const tile = tileAddressFromId(tileId);
      if (!tile) continue;

      const result = evaluateTransition(data);

      if (result.shouldTransition && result.newState && result.reason) {
        const previousState = data.state;
        const newData = applyTransition(data, result.newState);
        this.tileStates.set(tileId, newData);

        this.emitTransition(tile, previousState, result.newState, result.reason);
      }
    }

    // Clean up COLD tiles with no activity
    for (const [tileId, data] of this.tileStates) {
      if (
        data.state === TileState.COLD &&
        data.playerCount === 0 &&
        data.nearbyPlayerCount === 0
      ) {
        this.tileStates.delete(tileId);
      }
    }
  }

  private emitTransition(
    tile: TileAddress,
    previousState: TileState,
    newState: TileState,
    reason: TransitionReason
  ): void {
    const event = createTransitionEvent(tile, previousState, newState, reason);
    const tileId = tileAddressToId(tile);

    logger.info(
      `[TileStateManager] Tile ${tileId}: ${previousState} → ${newState} (${reason})`
    );

    this.emit('transition', event);

    // Emit load/unload events
    if (previousState === TileState.COLD && newState !== TileState.COLD) {
      this.emit('tileLoad', tileId, tile);
    } else if (newState === TileState.COLD && previousState !== TileState.COLD) {
      this.emit('tileUnload', tileId, tile);
    }
  }

  private tickHotTiles(): void {
    const hotTiles = this.getTilesInState(TileState.HOT);
    if (hotTiles.length > 0) {
      this.emit('hotTick', hotTiles);
    }
  }

  private tickWarmTiles(): void {
    const warmTiles = this.getTilesInState(TileState.WARM);
    if (warmTiles.length > 0) {
      this.emit('warmTick', warmTiles);
    }
  }
}

// Type augmentation for EventEmitter
export declare interface TileStateManager {
  on<K extends keyof TileStateManagerEvents>(
    event: K,
    listener: TileStateManagerEvents[K]
  ): this;
  emit<K extends keyof TileStateManagerEvents>(
    event: K,
    ...args: Parameters<TileStateManagerEvents[K]>
  ): boolean;
}
