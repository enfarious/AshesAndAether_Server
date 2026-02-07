/**
 * MovementSystem - Handles tick-based entity movement
 *
 * Processes movement events from commands and updates positions each tick.
 * Supports:
 *   - Heading-based movement (cardinal directions)
 *   - Target-tracking movement (move toward entity)
 *   - Distance-limited movement (stop after X meters)
 *   - Speed modes (walk/jog/run)
 */

import { logger } from '@/utils/logger';
import { StatCalculator } from '@/game/stats/StatCalculator';
import { CharacterService } from '@/database';
import { SPEED_MULTIPLIERS } from '@/network/protocol/types';
import type { MovementSpeed, Vector3, AnimationAction } from '@/network/protocol/types';
import type { ZoneManager } from './ZoneManager';
import { NavmeshService } from './navmesh/NavmeshService';

// Conversion: 1 foot = 0.3048 meters
const FEET_TO_METERS = 0.3048;
const MAX_TARGET_DISTANCE_METERS = 500;

export interface MovementState {
  characterId: string;
  zoneId: string;
  startPosition: Vector3;
  currentPosition: Vector3;
  heading: number;              // 0-360 degrees
  speed: MovementSpeed;
  baseSpeed: number;            // meters per second (from stats)
  distanceLimit?: number;       // stop after this many meters (undefined = indefinite)
  distanceTraveled: number;     // meters traveled so far
  target?: string;              // entity ID to move toward
  targetPosition?: Vector3;     // fixed coordinates to move toward
  targetRange: number;          // stop when this close to target (feet)
  path?: Vector3[];             // navmesh waypoints
  pathIndex?: number;           // current waypoint index
  pathTarget?: Vector3;         // final target for navmesh path
  startTime: number;
}

export interface MovementStartEvent {
  characterId: string;
  zoneId: string;
  startPosition: Vector3;
  heading?: number;
  speed: MovementSpeed;
  distance?: number;
  target?: string;
  targetPosition?: { x: number; y?: number; z: number };
  targetRange: number;
}

export interface MovementStopEvent {
  characterId: string;
  zoneId: string;
}

type MovementStopReason = 'command' | 'distance_reached' | 'target_reached' | 'target_lost' | 'boundary';

export type MovementCompleteCallback = Function;

export class MovementSystem {
  private activeMovements: Map<string, MovementState> = new Map();
  private zoneManagers: Map<string, ZoneManager> = new Map();
  private onMovementComplete?: MovementCompleteCallback;
  private underwaterSeconds: Map<string, number> = new Map();
  private navmeshService: NavmeshService = new NavmeshService();

  // How often to persist positions to DB (in seconds)
  private readonly DB_PERSIST_INTERVAL = 1.0;
  private pendingPersists: Map<string, { position: Vector3; lastPersist: number }> = new Map();

  /**
   * Register zone managers for entity lookups
   */
  registerZoneManager(zoneId: string, manager: ZoneManager): void {
    this.zoneManagers.set(zoneId, manager);
  }

  unregisterZoneManager(zoneId: string): void {
    this.zoneManagers.delete(zoneId);
  }

  /**
   * Set callback for when movement completes
   */
  setMovementCompleteCallback(callback: MovementCompleteCallback): void {
    this.onMovementComplete = callback;
  }

  /**
   * Start movement for an entity
   */
  async startMovement(event: MovementStartEvent): Promise<boolean> {
    const { characterId, zoneId, startPosition, heading, speed, distance, target, targetPosition, targetRange } = event;

    // Check animation locks
    const zoneManager = this.zoneManagers.get(zoneId);
    if (zoneManager) {
      const animationLockSystem = zoneManager.getAnimationLockSystem();
      if (animationLockSystem) {
        // Check if movement is allowed
        if (!animationLockSystem.canMove(characterId)) {
          logger.debug({ characterId }, 'Movement blocked by animation lock');
          return false;
        }

        // If this is a soft lock (movement cancels), interrupt the action
        const lockState = animationLockSystem.getState(characterId);
        if (lockState && lockState.isInterruptible && lockState.currentAction !== 'idle') {
          animationLockSystem.interruptAction(characterId, 'Movement started');
        }
      }
    }

    // Cancel any existing movement
    if (this.activeMovements.has(characterId)) {
      this.stopMovement({ characterId, zoneId }, 'command');
    }

    // Get character's base movement speed from stats
    let baseSpeed = 5.0; // Default fallback
    try {
      const character = await CharacterService.findById(characterId);
      if (character) {
        const coreStats = {
          strength: character.strength,
          vitality: character.vitality,
          dexterity: character.dexterity,
          agility: character.agility,
          intelligence: character.intelligence,
          wisdom: character.wisdom,
        };
        const derived = StatCalculator.calculateDerivedStats(coreStats, character.level);
        baseSpeed = derived.movementSpeed;
      }
    } catch (error) {
      logger.warn({ error, characterId }, 'Failed to get character stats for movement, using default speed');
    }

    // Convert targetPosition to Vector3 (default y to startPosition.y if not specified)
    let resolvedTargetPosition: Vector3 | undefined;
    if (targetPosition) {
      resolvedTargetPosition = {
        x: targetPosition.x,
        y: targetPosition.y ?? startPosition.y,
        z: targetPosition.z,
      };
    }

    // Resolve heading based on target priority: targetPosition > target entity > explicit heading
    let finalHeading = heading;
    let targetEntityPosition: Vector3 | undefined;

    if (resolvedTargetPosition && finalHeading === undefined) {
      // Moving to coordinates
      finalHeading = this.calculateHeadingToTarget(startPosition, resolvedTargetPosition);
    } else if (target && finalHeading === undefined) {
      // Moving to entity
      const zoneManager = this.zoneManagers.get(zoneId);
      if (zoneManager) {
        const targetEntity = zoneManager.findEntityByName(target) || zoneManager.getEntity(target);
        if (targetEntity) {
          targetEntityPosition = targetEntity.position;
          finalHeading = this.calculateHeadingToTarget(startPosition, targetEntity.position);
        } else {
          logger.warn({ characterId, target }, 'Target entity not found for movement');
          return false;
        }
      }
    }

    if (finalHeading === undefined) {
      logger.warn({ characterId }, 'No heading or target specified for movement');
      return false;
    }

    const pathTarget = resolvedTargetPosition ?? targetEntityPosition;
    let pathWaypoints: Vector3[] | undefined;

    if (pathTarget) {
      const dx = pathTarget.x - startPosition.x;
      const dz = pathTarget.z - startPosition.z;
      const planarDistance = Math.sqrt(dx * dx + dz * dz);
      if (planarDistance > MAX_TARGET_DISTANCE_METERS) {
        logger.warn({ characterId, distance: planarDistance }, 'Movement target too far');
        return false;
      }
      const navmeshPath = await this.navmeshService.findPath(startPosition, pathTarget);
      if (navmeshPath?.waypoints?.length) {
        pathWaypoints = navmeshPath.waypoints;
        resolvedTargetPosition = pathWaypoints[0];
      }
    }

    const state: MovementState = {
      characterId,
      zoneId,
      startPosition: { ...startPosition },
      currentPosition: { ...startPosition },
      heading: finalHeading,
      speed,
      baseSpeed,
      distanceLimit: distance,
      distanceTraveled: 0,
      target,
      targetPosition: resolvedTargetPosition,
      targetRange,
      path: pathWaypoints,
      pathIndex: pathWaypoints ? 0 : undefined,
      pathTarget,
      startTime: Date.now(),
    };

    this.activeMovements.set(characterId, state);
    logger.debug({ characterId, heading: finalHeading, speed, distance, target, targetPosition: resolvedTargetPosition }, 'Movement started');

    // Set animation state based on speed
    if (zoneManager) {
      const animationLockSystem = zoneManager.getAnimationLockSystem();
      if (animationLockSystem) {
        let animationAction: AnimationAction = 'idle';
        if (speed === 'run') {
          animationAction = 'running';
        } else if (speed === 'walk' || speed === 'jog') {
          animationAction = 'walking';
        }
        // No lock config - movement is always interruptible
        animationLockSystem.setState(characterId, animationAction);
      }
    }

    return true;
  }

  /**
   * Stop movement for an entity
   */
  stopMovement(event: MovementStopEvent, reason: MovementStopReason = 'command'): void {
    const state = this.activeMovements.get(event.characterId);
    if (!state) return;

    this.activeMovements.delete(event.characterId);

    // Persist final position immediately
    this.persistPosition(event.characterId, state.currentPosition);

    // Set animation to idle
    const zoneManager = this.zoneManagers.get(state.zoneId);
    if (zoneManager) {
      const animationLockSystem = zoneManager.getAnimationLockSystem();
      if (animationLockSystem) {
        const lockState = animationLockSystem.getState(event.characterId);
        // Only set idle if not in a different action (like attacking)
        if (!lockState || lockState.isInterruptible) {
          animationLockSystem.setState(event.characterId, 'idle');
        }
      }
    }

    logger.debug({ characterId: event.characterId, reason, position: state.currentPosition }, 'Movement stopped');

    if (this.onMovementComplete) {
      this.onMovementComplete(
        event.characterId,
        reason,
        state.currentPosition
      );
    }
  }

  /**
   * Check if an entity is currently moving
   */
  isMoving(characterId: string): boolean {
    return this.activeMovements.has(characterId);
  }

  /**
   * Get current movement state for an entity
   */
  getMovementState(characterId: string): MovementState | undefined {
    return this.activeMovements.get(characterId);
  }

  /**
   * Update all active movements - called each tick
   */
  update(deltaTime: number): Map<string, Vector3> {
    const positionUpdates = new Map<string, Vector3>();

    for (const [characterId, state] of this.activeMovements) {
      const newPosition = this.updateMovement(state, deltaTime);

      if (newPosition) {
        positionUpdates.set(characterId, newPosition);

        // Track for periodic DB persistence
        const pending = this.pendingPersists.get(characterId);
        const now = Date.now() / 1000;
        if (!pending || (now - pending.lastPersist) >= this.DB_PERSIST_INTERVAL) {
          this.persistPosition(characterId, newPosition);
          this.pendingPersists.set(characterId, { position: newPosition, lastPersist: now });
        }
      }
    }

    return positionUpdates;
  }

  /**
   * Update a single movement state
   */
  private updateMovement(state: MovementState, deltaTime: number): Vector3 | null {
    // Calculate actual speed (base * multiplier)
    const speedMultiplier = SPEED_MULTIPLIERS[state.speed] || 1.0;
    const actualSpeed = state.baseSpeed * speedMultiplier;

    // Calculate distance to move this tick
    const distanceThisTick = actualSpeed * deltaTime;

    // Stopping tolerance: at least the distance we'd travel this tick, with a minimum of 0.5m
    // This prevents rubberbanding where we overshoot and constantly reverse direction
    const stoppingTolerance = Math.max(0.5, distanceThisTick * 1.1);

    // If following a navmesh path, advance waypoints
    if (state.path && state.pathIndex !== undefined) {
      const waypoint = state.path[state.pathIndex];
      const distanceToWaypoint = this.calculateDistance(state.currentPosition, waypoint);

      if (distanceToWaypoint <= stoppingTolerance) {
        const nextIndex = state.pathIndex + 1;
        if (nextIndex < state.path.length) {
          state.pathIndex = nextIndex;
          state.targetPosition = state.path[nextIndex];
        } else {
          state.path = undefined;
          state.pathIndex = undefined;
          state.targetPosition = state.target ? undefined : state.pathTarget;
        }
      } else {
        state.targetPosition = waypoint;
      }
    }

    // If targeting a fixed position, check arrival and update heading
    if (state.targetPosition) {
      const distanceToTarget = this.calculateDistance(state.currentPosition, state.targetPosition);

      // Arrived at target position (within speed-adjusted tolerance)
      if (distanceToTarget <= stoppingTolerance) {
        state.currentPosition = { ...state.targetPosition };
        this.stopMovement({ characterId: state.characterId, zoneId: state.zoneId }, 'target_reached');
        return state.currentPosition;
      }

      // Update heading toward target position
      state.heading = this.calculateHeadingToTarget(state.currentPosition, state.targetPosition);
    }

    // If targeting an entity, update heading toward it
    if (state.target) {
      const zoneManager = this.zoneManagers.get(state.zoneId);
      if (zoneManager) {
        const targetEntity = zoneManager.findEntityByName(state.target) || zoneManager.getEntity(state.target);
        if (targetEntity) {
          // Update heading to track target
          state.heading = this.calculateHeadingToTarget(state.currentPosition, targetEntity.position);

          // Check if we're within target range (convert feet to meters)
          // Use at least stoppingTolerance to prevent rubberbanding when chasing
          const distanceToTarget = this.calculateDistance(state.currentPosition, targetEntity.position);
          const targetRangeMeters = state.targetRange * FEET_TO_METERS;
          const effectiveRange = Math.max(targetRangeMeters, stoppingTolerance);

          if (distanceToTarget <= effectiveRange) {
            this.stopMovement({ characterId: state.characterId, zoneId: state.zoneId }, 'target_reached');
            return state.currentPosition;
          }
        } else {
          // Target lost
          this.stopMovement({ characterId: state.characterId, zoneId: state.zoneId }, 'target_lost');
          return state.currentPosition;
        }
      }
    }

    // Calculate new position based on heading
    const headingRad = (state.heading * Math.PI) / 180;

    // Heading: 0 = North (+Z), 90 = East (+X), 180 = South (-Z), 270 = West (-X)
    const dx = Math.sin(headingRad) * distanceThisTick;
    const dz = Math.cos(headingRad) * distanceThisTick;

    const newPosition: Vector3 = {
      x: state.currentPosition.x + dx,
      y: state.currentPosition.y, // Y will be adjusted by physics if needed
      z: state.currentPosition.z + dz,
    };

    let finalPosition = newPosition;

    const zoneManager = this.zoneManagers.get(state.zoneId);
    const physicsSystem = zoneManager?.getPhysicsSystem?.();
    const entity = zoneManager?.getEntity?.(state.characterId) as
      | { movementProfile?: string; freediveMaxDepth?: number; freediveMaxSeconds?: number }
      | null
      | undefined;
    const movementProfile = entity?.movementProfile;
    const canFreedive = movementProfile === 'aquatic' || movementProfile === 'amphibious' || (entity?.freediveMaxSeconds ?? 0) > 0;
    const currentUnderwaterSeconds = this.underwaterSeconds.get(state.characterId) ?? 0;

    if (physicsSystem) {
      // Validate movement with physics system
      const validation = physicsSystem.validateMovement(
        state.characterId,
        state.currentPosition,
        newPosition,
        0.5,
        {
          allowUnderwater: canFreedive,
          maxUnderwaterDepth: movementProfile === 'terrestrial' ? entity?.freediveMaxDepth : undefined,
          maxUnderwaterSeconds: movementProfile === 'terrestrial' ? entity?.freediveMaxSeconds : undefined,
          currentUnderwaterSeconds: movementProfile === 'terrestrial' ? currentUnderwaterSeconds : undefined,
        }
      );

      if (!validation.valid) {
        if (validation.adjustedPosition) {
          // Physics adjusted the position (e.g., terrain collision)
          finalPosition = validation.adjustedPosition;
          logger.info({
            characterId: state.characterId,
            reason: validation.reason,
            original: newPosition,
            adjusted: finalPosition
          }, 'Movement adjusted by physics');
          console.log(`[PHYSICS] Movement adjusted: ${validation.reason}`, { original: newPosition.y, adjusted: finalPosition.y });
        } else {
          // Movement blocked by physics
          logger.info({
            characterId: state.characterId,
            reason: validation.reason,
            blockedPosition: newPosition
          }, 'Movement blocked by physics');
          console.log(`[PHYSICS] Movement blocked: ${validation.reason}`);
          return null; // Don't update position
        }
      }

      // Apply gravity - pull entities to ground level
      finalPosition = physicsSystem.applyGravity(finalPosition);
    }

    // Update underwater timer
    if (physicsSystem && canFreedive) {
      const terrain = physicsSystem.getTerrainCollision(finalPosition);
      const surface = terrain.isWater ? terrain.elevation : 0;
      if (terrain.isWater && finalPosition.y < surface) {
        this.underwaterSeconds.set(state.characterId, currentUnderwaterSeconds + deltaTime);
      } else {
        this.underwaterSeconds.set(state.characterId, 0);
      }
    }

    // Update distance traveled (use actual distance moved, not intended)
    const actualDistance = this.calculateDistance(state.currentPosition, finalPosition);
    state.distanceTraveled += actualDistance;

    // Check distance limit
    if (state.distanceLimit !== undefined && state.distanceTraveled >= state.distanceLimit) {
      // Clamp to exact distance
      const overshoot = state.distanceTraveled - state.distanceLimit;
      const ratio = 1 - (overshoot / actualDistance);

      finalPosition = {
        x: state.currentPosition.x + (finalPosition.x - state.currentPosition.x) * ratio,
        y: finalPosition.y,
        z: state.currentPosition.z + (finalPosition.z - state.currentPosition.z) * ratio,
      };

      state.currentPosition = finalPosition;
      this.stopMovement({ characterId: state.characterId, zoneId: state.zoneId }, 'distance_reached');
      return finalPosition;
    }

    state.currentPosition = finalPosition;
    return finalPosition;
  }

  /**
   * Calculate heading from one position to another
   */
  private calculateHeadingToTarget(from: Vector3, to: Vector3): number {
    const dx = to.x - from.x;
    const dz = to.z - from.z;

    // atan2 gives angle in radians, convert to degrees
    // Adjust so 0 = North (+Z), 90 = East (+X)
    let heading = Math.atan2(dx, dz) * (180 / Math.PI);

    // Normalize to 0-360
    if (heading < 0) heading += 360;

    return heading;
  }

  /**
   * Calculate distance between two positions
   */
  private calculateDistance(from: Vector3, to: Vector3): number {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Persist position to database (fire and forget)
   */
  private persistPosition(characterId: string, position: Vector3): void {
    CharacterService.updatePosition(characterId, { x: position.x, y: position.y, z: position.z })
      .catch(error => {
        logger.error({ error, characterId, position }, 'Failed to persist position to database');
      });
  }

  /**
   * Calculate movement duration in milliseconds for client interpolation
   */
  getMovementDuration(characterId: string): number | undefined {
    const state = this.activeMovements.get(characterId);
    if (!state) return undefined;

    // Calculate actual speed
    const speedMultiplier = SPEED_MULTIPLIERS[state.speed] || 1.0;
    const actualSpeed = state.baseSpeed * speedMultiplier;

    // Estimate time to next position update (assume 100ms tick rate)
    const tickInterval = 0.1; // 100ms
    const distancePerTick = actualSpeed * tickInterval;
    const durationMs = (distancePerTick / actualSpeed) * 1000;

    return durationMs;
  }

  /**
   * Get current movement speed in m/s
   */
  getMovementSpeed(characterId: string): number | undefined {
    const state = this.activeMovements.get(characterId);
    if (!state) return undefined;

    const speedMultiplier = SPEED_MULTIPLIERS[state.speed] || 1.0;
    return state.baseSpeed * speedMultiplier;
  }

  /**
   * Get current heading (0-360 degrees)
   */
  getHeading(characterId: string): number | undefined {
    const state = this.activeMovements.get(characterId);
    return state?.heading;
  }

  /**
   * Get count of active movements
   */
  getActiveCount(): number {
    return this.activeMovements.size;
  }

  /**
   * Clear all active movements (for shutdown)
   */
  clearAll(): void {
    // Persist all current positions before clearing
    for (const [characterId, state] of this.activeMovements) {
      this.persistPosition(characterId, state.currentPosition);
    }
    this.activeMovements.clear();
    this.pendingPersists.clear();
  }
}
