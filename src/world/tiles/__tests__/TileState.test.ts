/**
 * Tests for TileState machine
 */

// Jest globals (describe, it, expect) available automatically
import {
  TileState,
  TransitionReason,
  createInitialStateData,
  evaluateTransition,
  applyTransition,
  playerEntered,
  playerLeft,
  updateNearbyPlayers,
  getTickInterval,
} from '../TileState';
import { TileStateTimings } from '../TileConstants';

describe('TileState', () => {
  describe('createInitialStateData', () => {
    it('creates COLD state with zero counts', () => {
      const data = createInitialStateData();
      expect(data.state).toBe(TileState.COLD);
      expect(data.playerCount).toBe(0);
      expect(data.nearbyPlayerCount).toBe(0);
      expect(data.lastPlayerPresenceAt).toBeNull();
      expect(data.lastPlayerNearbyAt).toBeNull();
    });
  });

  describe('evaluateTransition - COLD state', () => {
    it('transitions to WARM when nearby players > 0', () => {
      const data = {
        ...createInitialStateData(),
        nearbyPlayerCount: 1,
      };

      const result = evaluateTransition(data);
      expect(result.shouldTransition).toBe(true);
      expect(result.newState).toBe(TileState.WARM);
      expect(result.reason).toBe(TransitionReason.PLAYER_NEARBY);
    });

    it('transitions to HOT when player directly enters', () => {
      const data = {
        ...createInitialStateData(),
        playerCount: 1,
      };

      const result = evaluateTransition(data);
      expect(result.shouldTransition).toBe(true);
      expect(result.newState).toBe(TileState.HOT);
      expect(result.reason).toBe(TransitionReason.PLAYER_ENTERED);
    });

    it('stays COLD when no players nearby', () => {
      const data = createInitialStateData();
      const result = evaluateTransition(data);
      expect(result.shouldTransition).toBe(false);
    });
  });

  describe('evaluateTransition - WARM state', () => {
    it('transitions to HOT when player enters', () => {
      const data = {
        ...createInitialStateData(),
        state: TileState.WARM,
        playerCount: 1,
      };

      const result = evaluateTransition(data);
      expect(result.shouldTransition).toBe(true);
      expect(result.newState).toBe(TileState.HOT);
      expect(result.reason).toBe(TransitionReason.PLAYER_ENTERED);
    });

    it('transitions to COLD after timeout with no nearby players', () => {
      const now = new Date();
      const oldTime = new Date(now.getTime() - (TileStateTimings.WARM_TO_COLD_MINUTES + 1) * 60 * 1000);

      const data = {
        ...createInitialStateData(),
        state: TileState.WARM,
        stateEnteredAt: oldTime,
        nearbyPlayerCount: 0,
        lastPlayerNearbyAt: oldTime,
      };

      const result = evaluateTransition(data, now);
      expect(result.shouldTransition).toBe(true);
      expect(result.newState).toBe(TileState.COLD);
      expect(result.reason).toBe(TransitionReason.NO_PLAYERS_NEARBY);
    });

    it('stays WARM when nearby players present', () => {
      const data = {
        ...createInitialStateData(),
        state: TileState.WARM,
        nearbyPlayerCount: 1,
      };

      const result = evaluateTransition(data);
      expect(result.shouldTransition).toBe(false);
    });

    it('stays WARM during cooldown period', () => {
      const now = new Date();
      const recentTime = new Date(now.getTime() - 5 * 60 * 1000); // 5 minutes ago

      const data = {
        ...createInitialStateData(),
        state: TileState.WARM,
        stateEnteredAt: recentTime,
        nearbyPlayerCount: 0,
        lastPlayerNearbyAt: recentTime,
      };

      const result = evaluateTransition(data, now);
      expect(result.shouldTransition).toBe(false);
    });
  });

  describe('evaluateTransition - HOT state', () => {
    it('transitions to WARM after timeout with no players', () => {
      const now = new Date();
      const oldTime = new Date(now.getTime() - (TileStateTimings.HOT_TO_WARM_MINUTES + 1) * 60 * 1000);

      const data = {
        ...createInitialStateData(),
        state: TileState.HOT,
        stateEnteredAt: oldTime,
        playerCount: 0,
        lastPlayerPresenceAt: oldTime,
      };

      const result = evaluateTransition(data, now);
      expect(result.shouldTransition).toBe(true);
      expect(result.newState).toBe(TileState.WARM);
      expect(result.reason).toBe(TransitionReason.NO_PLAYERS_IN_TILE);
    });

    it('stays HOT when players present', () => {
      const data = {
        ...createInitialStateData(),
        state: TileState.HOT,
        playerCount: 1,
      };

      const result = evaluateTransition(data);
      expect(result.shouldTransition).toBe(false);
    });

    it('stays HOT during cooldown period', () => {
      const now = new Date();
      const recentTime = new Date(now.getTime() - 1 * 60 * 1000); // 1 minute ago

      const data = {
        ...createInitialStateData(),
        state: TileState.HOT,
        stateEnteredAt: recentTime,
        playerCount: 0,
        lastPlayerPresenceAt: recentTime,
      };

      const result = evaluateTransition(data, now);
      expect(result.shouldTransition).toBe(false);
    });
  });

  describe('applyTransition', () => {
    it('updates state and timestamp', () => {
      const data = createInitialStateData();
      const now = new Date();
      const newData = applyTransition(data, TileState.WARM, now);

      expect(newData.state).toBe(TileState.WARM);
      expect(newData.stateEnteredAt).toBe(now);
      expect(newData.playerCount).toBe(data.playerCount); // Unchanged
    });
  });

  describe('playerEntered', () => {
    it('increments player count', () => {
      const data = createInitialStateData();
      const newData = playerEntered(data);

      expect(newData.playerCount).toBe(1);
      expect(newData.lastPlayerPresenceAt).not.toBeNull();
      expect(newData.lastPlayerNearbyAt).not.toBeNull();
    });

    it('increments existing count', () => {
      let data = createInitialStateData();
      data = playerEntered(data);
      data = playerEntered(data);

      expect(data.playerCount).toBe(2);
    });
  });

  describe('playerLeft', () => {
    it('decrements player count', () => {
      let data = createInitialStateData();
      data = playerEntered(data);
      data = playerEntered(data);
      data = playerLeft(data);

      expect(data.playerCount).toBe(1);
    });

    it('does not go below zero', () => {
      const data = createInitialStateData();
      const newData = playerLeft(data);

      expect(newData.playerCount).toBe(0);
    });

    it('updates lastPlayerPresenceAt when count reaches zero', () => {
      const now = new Date();
      let data = createInitialStateData();
      data = playerEntered(data);
      data = playerLeft(data, now);

      expect(data.playerCount).toBe(0);
      expect(data.lastPlayerPresenceAt).toBe(now);
    });
  });

  describe('updateNearbyPlayers', () => {
    it('updates nearby count', () => {
      const data = createInitialStateData();
      const newData = updateNearbyPlayers(data, 5);

      expect(newData.nearbyPlayerCount).toBe(5);
      expect(newData.lastPlayerNearbyAt).not.toBeNull();
    });

    it('updates timestamp only when count > 0', () => {
      const data = createInitialStateData();
      const newData = updateNearbyPlayers(data, 0);

      expect(newData.nearbyPlayerCount).toBe(0);
      expect(newData.lastPlayerNearbyAt).toBeNull();
    });
  });

  describe('getTickInterval', () => {
    it('returns 1000ms for HOT state', () => {
      expect(getTickInterval(TileState.HOT)).toBe(TileStateTimings.HOT_TICK_MS);
    });

    it('returns 60000ms for WARM state', () => {
      expect(getTickInterval(TileState.WARM)).toBe(TileStateTimings.WARM_TICK_MS);
    });

    it('returns null for COLD state', () => {
      expect(getTickInterval(TileState.COLD)).toBeNull();
    });
  });

  describe('full state lifecycle', () => {
    it('follows COLD → WARM → HOT → WARM → COLD cycle', () => {
      let data = createInitialStateData();
      expect(data.state).toBe(TileState.COLD);

      // Player approaches (within prefetch)
      data = updateNearbyPlayers(data, 1);
      let result = evaluateTransition(data);
      expect(result.newState).toBe(TileState.WARM);
      data = applyTransition(data, TileState.WARM);

      // Player enters tile
      data = playerEntered(data);
      result = evaluateTransition(data);
      expect(result.newState).toBe(TileState.HOT);
      data = applyTransition(data, TileState.HOT);

      // Player leaves tile
      const now = new Date();
      data = playerLeft(data, now);

      // Right after leaving - should stay HOT (cooldown)
      result = evaluateTransition(data, now);
      expect(result.shouldTransition).toBe(false);

      // After HOT_TO_WARM cooldown
      const laterTime = new Date(now.getTime() + (TileStateTimings.HOT_TO_WARM_MINUTES + 1) * 60 * 1000);
      data = updateNearbyPlayers(data, 0);
      data = {
        ...data,
        lastPlayerNearbyAt: now,
      };
      result = evaluateTransition(data, laterTime);
      expect(result.newState).toBe(TileState.WARM);
      data = applyTransition(data, TileState.WARM, laterTime);

      // After WARM_TO_COLD cooldown
      const muchLaterTime = new Date(laterTime.getTime() + (TileStateTimings.WARM_TO_COLD_MINUTES + 1) * 60 * 1000);
      result = evaluateTransition(data, muchLaterTime);
      expect(result.newState).toBe(TileState.COLD);
    });
  });
});
