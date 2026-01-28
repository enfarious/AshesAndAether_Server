/**
 * TileState - State machine for micro tile lifecycle.
 *
 * Tiles transition through COLD → WARM → HOT based on player proximity,
 * then cool down through HOT → WARM → COLD when players leave.
 */

import { TileStateTimings } from './TileConstants';
import type { TileAddress } from './TileAddress';
import { tileAddressToId } from './TileAddress';

/**
 * Tile simulation states
 */
export enum TileState {
  /**
   * COLD - No simulation loaded.
   * The tile exists only as a manifest reference.
   * No NPCs, no spawns, no ticking.
   */
  COLD = 'COLD',

  /**
   * WARM - Simulation loaded, low-frequency tick.
   * NPCs exist but run simplified behavior.
   * Spawns are tracked but not actively spawning.
   * Tick rate: once per minute.
   */
  WARM = 'WARM',

  /**
   * HOT - Full simulation active.
   * All game systems running at full fidelity.
   * Active combat, spawning, NPC behaviors.
   * Tick rate: once per second.
   */
  HOT = 'HOT',
}

/**
 * Reasons for state transitions
 */
export enum TransitionReason {
  /** Player entered the tile */
  PLAYER_ENTERED = 'PLAYER_ENTERED',
  /** Player is within prefetch radius */
  PLAYER_NEARBY = 'PLAYER_NEARBY',
  /** No players in tile for cooldown period */
  NO_PLAYERS_IN_TILE = 'NO_PLAYERS_IN_TILE',
  /** No players nearby for extended period */
  NO_PLAYERS_NEARBY = 'NO_PLAYERS_NEARBY',
  /** Manual/administrative state change */
  MANUAL = 'MANUAL',
  /** Initial load from database */
  INITIAL_LOAD = 'INITIAL_LOAD',
}

/**
 * Tracking data for a tile's state
 */
export interface TileStateData {
  /** Current state */
  state: TileState;
  /** When this state was entered */
  stateEnteredAt: Date;
  /** Last time any player was in this tile */
  lastPlayerPresenceAt: Date | null;
  /** Last time any player was nearby (within prefetch radius) */
  lastPlayerNearbyAt: Date | null;
  /** Number of players currently in this tile */
  playerCount: number;
  /** Number of players in nearby tiles */
  nearbyPlayerCount: number;
}

/**
 * Create initial state data for a new tile
 */
export function createInitialStateData(): TileStateData {
  return {
    state: TileState.COLD,
    stateEnteredAt: new Date(),
    lastPlayerPresenceAt: null,
    lastPlayerNearbyAt: null,
    playerCount: 0,
    nearbyPlayerCount: 0,
  };
}

/**
 * Result of evaluating a state transition
 */
export interface TransitionResult {
  /** Whether a transition should occur */
  shouldTransition: boolean;
  /** The new state (if transitioning) */
  newState?: TileState;
  /** Reason for transition (if transitioning) */
  reason?: TransitionReason;
}

/**
 * Evaluate whether a tile should transition to a different state.
 *
 * @param data Current state data
 * @param now Current time
 * @returns TransitionResult indicating if/how to transition
 */
export function evaluateTransition(data: TileStateData, now: Date = new Date()): TransitionResult {
  switch (data.state) {
    case TileState.COLD: {
      // COLD → WARM: Player is nearby (within prefetch radius)
      if (data.nearbyPlayerCount > 0) {
        return {
          shouldTransition: true,
          newState: TileState.WARM,
          reason: TransitionReason.PLAYER_NEARBY,
        };
      }
      // COLD → HOT: Player entered directly (shouldn't happen often)
      if (data.playerCount > 0) {
        return {
          shouldTransition: true,
          newState: TileState.HOT,
          reason: TransitionReason.PLAYER_ENTERED,
        };
      }
      return { shouldTransition: false };
    }

    case TileState.WARM: {
      // WARM → HOT: Player entered the tile
      if (data.playerCount > 0) {
        return {
          shouldTransition: true,
          newState: TileState.HOT,
          reason: TransitionReason.PLAYER_ENTERED,
        };
      }

      // WARM → COLD: No players nearby for extended period
      if (data.nearbyPlayerCount === 0 && data.lastPlayerNearbyAt) {
        const timeSinceNearby = now.getTime() - data.lastPlayerNearbyAt.getTime();
        const timeSinceNearbyMinutes = timeSinceNearby / 1000 / 60;

        if (timeSinceNearbyMinutes >= TileStateTimings.WARM_TO_COLD_MINUTES) {
          return {
            shouldTransition: true,
            newState: TileState.COLD,
            reason: TransitionReason.NO_PLAYERS_NEARBY,
          };
        }
      }

      return { shouldTransition: false };
    }

    case TileState.HOT: {
      // HOT → WARM: No players in tile for cooldown period
      if (data.playerCount === 0 && data.lastPlayerPresenceAt) {
        const timeSincePresence = now.getTime() - data.lastPlayerPresenceAt.getTime();
        const timeSincePresenceMinutes = timeSincePresence / 1000 / 60;

        if (timeSincePresenceMinutes >= TileStateTimings.HOT_TO_WARM_MINUTES) {
          return {
            shouldTransition: true,
            newState: TileState.WARM,
            reason: TransitionReason.NO_PLAYERS_IN_TILE,
          };
        }
      }

      return { shouldTransition: false };
    }

    default:
      return { shouldTransition: false };
  }
}

/**
 * Apply a state transition to tile data
 */
export function applyTransition(
  data: TileStateData,
  newState: TileState,
  now: Date = new Date()
): TileStateData {
  return {
    ...data,
    state: newState,
    stateEnteredAt: now,
  };
}

/**
 * Update tile data when a player enters the tile
 */
export function playerEntered(data: TileStateData, now: Date = new Date()): TileStateData {
  return {
    ...data,
    playerCount: data.playerCount + 1,
    lastPlayerPresenceAt: now,
    lastPlayerNearbyAt: now,
  };
}

/**
 * Update tile data when a player leaves the tile
 */
export function playerLeft(data: TileStateData, now: Date = new Date()): TileStateData {
  const newCount = Math.max(0, data.playerCount - 1);
  return {
    ...data,
    playerCount: newCount,
    lastPlayerPresenceAt: newCount === 0 ? now : data.lastPlayerPresenceAt,
  };
}

/**
 * Update tile data when nearby player count changes
 */
export function updateNearbyPlayers(
  data: TileStateData,
  nearbyCount: number,
  now: Date = new Date()
): TileStateData {
  return {
    ...data,
    nearbyPlayerCount: nearbyCount,
    lastPlayerNearbyAt: nearbyCount > 0 ? now : data.lastPlayerNearbyAt,
  };
}

/**
 * Get the tick interval for a given state in milliseconds
 */
export function getTickInterval(state: TileState): number | null {
  switch (state) {
    case TileState.HOT:
      return TileStateTimings.HOT_TICK_MS;
    case TileState.WARM:
      return TileStateTimings.WARM_TICK_MS;
    case TileState.COLD:
      return null; // No ticking
    default:
      return null;
  }
}

/**
 * Event emitted when a tile transitions
 */
export interface TileTransitionEvent {
  tileId: string;
  tile: TileAddress;
  previousState: TileState;
  newState: TileState;
  reason: TransitionReason;
  timestamp: Date;
}

/**
 * Create a transition event
 */
export function createTransitionEvent(
  tile: TileAddress,
  previousState: TileState,
  newState: TileState,
  reason: TransitionReason
): TileTransitionEvent {
  return {
    tileId: tileAddressToId(tile),
    tile,
    previousState,
    newState,
    reason,
    timestamp: new Date(),
  };
}
