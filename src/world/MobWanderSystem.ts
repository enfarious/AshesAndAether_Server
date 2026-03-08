import type { Vector3 } from '@/network/protocol/types';

// ── Tuning constants ──────────────────────────────────────────────────────────

/** Walking speed while wandering (m/s). Deliberately slow — a casual amble. */
const WANDER_SPEED     = 1.4;

/** Sprint speed when chasing a target or returning home (m/s). */
const CHASE_SPEED      = 3.5;
const RETURN_SPEED     = 3.5;

/**
 * If the mob is more than this many metres from its chase target (the entity
 * it's attacking), drop the target.  Separate from LEASH_RADIUS which limits
 * distance from home.
 */
const CHASE_TARGET_MAX_DISTANCE = 100;

/** How far from the home position a mob is allowed to roam while idle (metres). */
const WANDER_RADIUS    = 50;

/**
 * How far from home a mob may chase before the leash snaps (metres).
 * Once the leash breaks the mob immediately transitions to 'returning'.
 */
const LEASH_RADIUS     = 1_000;

/**
 * How close a mob must get to its wander target before it is considered
 * "arrived" and begins its next pause.
 */
const ARRIVE_DIST      = 0.5;

/**
 * How close a mob must get to its home position before it stops returning
 * and resumes idle wandering.
 */
const HOME_ARRIVE_DIST = 5;

/** Minimum idle pause between wander moves (milliseconds). */
const PAUSE_MIN_MS     = 3_000;

/** Maximum idle pause between wander moves (milliseconds). */
const PAUSE_MAX_MS     = 9_000;

// ── Stuck detection ───────────────────────────────────────────────────────────

/**
 * How long (ms) a mob may walk toward a target before we check if it has made
 * meaningful progress.  Set long enough that short obstacles (corners, slight
 * inclines) don't trigger a false positive.
 */
const STUCK_CHECK_AFTER_MS   = 3_000;

/**
 * Minimum displacement (metres) a mob must achieve in STUCK_CHECK_AFTER_MS
 * while walking toward a target.  If it hasn't moved this far it's considered
 * stuck by geometry.
 */
const STUCK_THRESHOLD_METERS = 0.5;

/**
 * How many times we let a mob pick a fresh random target before we give up and
 * ask the caller to physically nudge it clear of whatever is trapping it.
 */
const MAX_STUCK_PICKS = 3;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Mob AI phase. */
type AIState = 'idle' | 'chasing' | 'returning';

/** Returned by update() for every mob that moved this tick. */
export interface WanderUpdate {
  id:      string;
  /** Candidate XZ position — Y is the mob's current Y; caller snaps to terrain. */
  position: Vector3;
  /** Facing direction in degrees. Server convention: 0° = North (+Z), 90° = East (+X). */
  heading: number;
}

/** Full result returned by update(). */
export interface WanderTick {
  moves: WanderUpdate[];
  /**
   * Mob IDs whose chase distance exceeded LEASH_RADIUS this tick.
   * The caller should end their combat and let the wander system carry them home.
   */
  leashBroken: string[];
  /**
   * Mob IDs that are geometrically stuck (tried MAX_STUCK_PICKS targets without
   * making STUCK_THRESHOLD_METERS of progress).  The caller should apply a physics
   * nudge to move them clear of the blocking geometry.
   */
  stuckRequests: string[];
}

interface MobState {
  /** Spawn / respawn position — used as wander origin and return destination. */
  homeX: number;
  homeZ: number;

  wanderRadius: number;

  /**
   * When true the mob ignores LEASH_RADIUS and CHASE_TARGET_MAX_DISTANCE —
   * it will chase its target indefinitely and never transition to 'returning'.
   * Used for vault mobs that should fight to the death.
   */
  noLeash: boolean;

  /** Current world position (X and Z managed here; Y supplied by terrain snap). */
  currentX: number;
  currentY: number;
  currentZ: number;

  /** Wander target in XZ.  null while the mob is pausing or not in idle state. */
  targetX: number | null;
  targetZ: number | null;

  /** Timestamp (ms) after which an idle mob may pick a new wander target. */
  pauseUntil: number;

  // ── Stuck detection ──────────────────────────────────────────────────────
  /** Position snapshot taken when the current wander target was picked. */
  targetStartX: number;
  targetStartZ: number;
  /** Timestamp (ms) when the current target was picked — used for the stuck check. */
  targetPickedAt: number;
  /** How many consecutive targets the mob has failed to reach due to geometry. */
  stuckPickCount: number;

  /** Current facing in degrees. */
  heading: number;

  /** Current AI phase. */
  aiState: AIState;

  /**
   * Latest XZ position of the combat target.
   * Updated every tick by the caller via setChaseTarget() while in combat.
   */
  chaseX: number;
  chaseZ: number;
}

/**
 * Optional steering callback passed to update().  Given a position and desired
 * heading, returns an adjusted heading that avoids obstacles, or null if every
 * direction is blocked.
 */
export type SteerFn = (position: Vector3, heading: number) => number | null;

// ── System ────────────────────────────────────────────────────────────────────

/**
 * MobWanderSystem — lightweight, fully synchronous AI for mob movement.
 *
 * Each mob cycles through three phases:
 *
 *   idle      Pauses 3–9 s then walks to a random point within wanderRadius
 *             of its home position.  Repeats.
 *
 *   chasing   Sprints toward the combat target (supplied by the caller each
 *             tick via setChaseTarget).  If the mob strays > LEASH_RADIUS
 *             from home the leash snaps — the mob's ID is added to
 *             WanderTick.leashBroken and it transitions to 'returning'.
 *
 *   returning Sprints back to the home position.  On arrival transitions
 *             back to idle.
 *
 * The system operates entirely in XZ.  Y is set by the caller (terrain snap)
 * via updateCurrentPosition() after each tick.
 *
 * The caller (DistributedWorldManager) is responsible for:
 *   • Calling setChaseTarget(id, pos) every tick for mobs in combat.
 *   • Calling endChase(id) when mob combat ends / target dies.
 *   • Handling leashBroken entries (clearing combat state in ZoneManager /
 *     CombatManager).
 */
export class MobWanderSystem {
  private states: Map<string, MobState> = new Map();

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Register a mob with the wander system.  Call this after a mob spawns
   * (initial load or respawn).  The mob starts pausing for a random interval
   * before its first move so they don't all set off simultaneously on boot.
   *
   * @param id            Mob entity ID.
   * @param position      Spawn position (becomes the home/origin for roaming).
   * @param wanderRadius  Optional override; defaults to WANDER_RADIUS (50 m).
   * @param noLeash       If true the mob ignores leash radius and chase-target
   *                      distance limits — it chases until death.
   */
  register(id: string, position: Vector3, wanderRadius: number = WANDER_RADIUS, noLeash: boolean = false): void {
    this.states.set(id, {
      homeX:      position.x,
      homeZ:      position.z,
      wanderRadius,
      noLeash,
      currentX:   position.x,
      currentY:   position.y,
      currentZ:   position.z,
      targetX:    null,
      targetZ:    null,
      // Stagger initial pauses so a fresh zone doesn't trigger a burst of moves
      pauseUntil: Date.now() + PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS),
      heading:    Math.random() * 360,
      aiState:    'idle',
      chaseX:     position.x,
      chaseZ:     position.z,
      // Stuck detection — zeroed; populated when first target is picked
      targetStartX:   position.x,
      targetStartZ:   position.z,
      targetPickedAt: 0,
      stuckPickCount: 0,
    });
  }

  /** Remove a mob from the wander system (called on despawn / permanent death). */
  unregister(id: string): void {
    this.states.delete(id);
  }

  /** Returns true if the given mob ID is currently tracked by this system. */
  has(id: string): boolean {
    return this.states.has(id);
  }

  /** Expose all tracked mob IDs so the caller can iterate to inject chase targets. */
  getMobIds(): IterableIterator<string> {
    return this.states.keys();
  }

  // ── Chase / return control ─────────────────────────────────────────────────

  /**
   * Update the XZ position the mob should chase toward and transition the
   * mob to the 'chasing' state.
   *
   * Call this every tick (before update()) for every mob that is in combat
   * so the mob tracks a moving player.  Safe to call repeatedly — it just
   * refreshes the target coordinates.
   */
  setChaseTarget(id: string, target: Vector3): void {
    const state = this.states.get(id);
    if (!state) return;
    state.chaseX  = target.x;
    state.chaseZ  = target.z;
    state.aiState = 'chasing';
    // Clear any idle wander path so we don't resume a stale waypoint later
    state.targetX = null;
    state.targetZ = null;
  }

  /**
   * End the chase and begin returning home (or idle in place for noLeash mobs).
   *
   * Call this when the mob's combat ends (timeout, target death, leash break).
   * Normal mobs sprint home then resume wandering; noLeash mobs (vault mobs)
   * simply idle where they stand — they never return home.
   */
  endChase(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    state.targetX = null;
    state.targetZ = null;

    if (state.noLeash) {
      // Vault mobs stay where they are — update home to current position
      // so future wandering orbits their new location
      state.homeX      = state.currentX;
      state.homeZ      = state.currentZ;
      state.aiState    = 'idle';
      state.pauseUntil = Date.now() + PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS);
    } else {
      state.aiState = 'returning';
    }
  }

  /** Get current AI state for a mob (undefined if not registered). */
  getAIState(id: string): AIState | undefined {
    return this.states.get(id)?.aiState;
  }

  /**
   * Force the wander system's tracked XYZ to match the mob's actual position.
   *
   * Call this after every terrain snap so the system never drifts from the
   * real ground elevation, and to sync after external teleports / combat moves.
   */
  updateCurrentPosition(id: string, position: Vector3): void {
    const state = this.states.get(id);
    if (!state) return;
    state.currentX = position.x;
    state.currentY = position.y;
    state.currentZ = position.z;
  }

  // ── Tick ──────────────────────────────────────────────────────────────────

  /**
   * Advance all registered mobs by deltaTime seconds.
   *
   * Returns:
   *   moves       — mobs that physically moved; pass each to
   *                 ZoneManager.updateMobPosition() then broadcast.
   *   leashBroken — mobs whose chase exceeded LEASH_RADIUS; the caller
   *                 should end their combat state.  The wander system has
   *                 already transitioned them to 'returning'.
   */
  update(deltaTime: number, steerFn?: SteerFn): WanderTick {
    const now           = Date.now();
    const moves:        WanderUpdate[] = [];
    const leashBroken:  string[]       = [];
    const stuckRequests: string[]      = [];

    for (const [id, state] of this.states) {
      switch (state.aiState) {
        case 'chasing':
          this._tickChase(id, state, deltaTime, leashBroken, moves, steerFn);
          break;
        case 'returning':
          this._tickReturn(id, state, deltaTime, now, moves, steerFn);
          break;
        default: // 'idle'
          this._tickIdle(id, state, deltaTime, now, moves, stuckRequests, steerFn);
          break;
      }
    }

    return { moves, leashBroken, stuckRequests };
  }

  // ── Private tick helpers ──────────────────────────────────────────────────

  private _tickChase(
    id:          string,
    state:       MobState,
    dt:          number,
    leashBroken: string[],
    moves:       WanderUpdate[],
    steerFn?:    SteerFn,
  ): void {
    // Leash check — bail out if mob has wandered too far from home
    // (skipped for noLeash mobs — they chase until death)
    if (!state.noLeash) {
      const homeDistX = state.currentX - state.homeX;
      const homeDistZ = state.currentZ - state.homeZ;
      if (Math.hypot(homeDistX, homeDistZ) > LEASH_RADIUS) {
        leashBroken.push(id);
        state.aiState = 'returning';
        state.targetX = null;
        state.targetZ = null;
        return; // No move this tick — return phase handles next tick
      }
    }

    const dx   = state.chaseX - state.currentX;
    const dz   = state.chaseZ - state.currentZ;
    const dist = Math.hypot(dx, dz);
    if (dist < ARRIVE_DIST) return; // Right on top of target — wait for it to move

    // Drop chase target if it's too far away
    // (skipped for noLeash mobs — they never give up the chase)
    if (!state.noLeash && dist > CHASE_TARGET_MAX_DISTANCE) {
      state.aiState = 'returning';
      state.targetX = null;
      state.targetZ = null;
      leashBroken.push(id); // Caller should clear combat state
      return;
    }

    let heading = Math.atan2(dx, dz) * (180 / Math.PI);
    if (heading < 0) heading += 360;

    // Steer around buildings if a steering function is provided
    if (steerFn) {
      const pos: Vector3 = { x: state.currentX, y: state.currentY, z: state.currentZ };
      const steered = steerFn(pos, heading);
      if (steered !== null) {
        heading = steered;
      }
      // If null (fully enclosed), still try the direct heading — resolveAgainstStructures
      // will catch it downstream.
    }

    const headingRad = (heading * Math.PI) / 180;
    const step       = Math.min(CHASE_SPEED * dt, dist);
    state.currentX  += Math.sin(headingRad) * step;
    state.currentZ  += Math.cos(headingRad) * step;
    state.heading    = heading;

    moves.push({
      id,
      position: { x: state.currentX, y: state.currentY, z: state.currentZ },
      heading,
    });
  }

  private _tickReturn(
    id:       string,
    state:    MobState,
    dt:       number,
    now:      number,
    moves:    WanderUpdate[],
    steerFn?: SteerFn,
  ): void {
    const dx   = state.homeX - state.currentX;
    const dz   = state.homeZ - state.currentZ;
    const dist = Math.hypot(dx, dz);

    if (dist < HOME_ARRIVE_DIST) {
      // Arrived home — transition back to idle with a short pause
      state.aiState    = 'idle';
      state.targetX    = null;
      state.targetZ    = null;
      state.pauseUntil = now + PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS);
      return;
    }

    let heading = Math.atan2(dx, dz) * (180 / Math.PI);
    if (heading < 0) heading += 360;

    if (steerFn) {
      const pos: Vector3 = { x: state.currentX, y: state.currentY, z: state.currentZ };
      const steered = steerFn(pos, heading);
      if (steered !== null) heading = steered;
    }

    const headingRad = (heading * Math.PI) / 180;
    const step       = Math.min(RETURN_SPEED * dt, dist);
    state.currentX  += Math.sin(headingRad) * step;
    state.currentZ  += Math.cos(headingRad) * step;
    state.heading    = heading;

    moves.push({
      id,
      position: { x: state.currentX, y: state.currentY, z: state.currentZ },
      heading,
    });
  }

  private _tickIdle(
    id:           string,
    state:        MobState,
    dt:           number,
    now:          number,
    moves:        WanderUpdate[],
    stuckRequests: string[],
    steerFn?:     SteerFn,
  ): void {
    // ── Pausing phase ────────────────────────────────────────────────────
    if (state.targetX === null) {
      if (now < state.pauseUntil) return; // Still waiting

      // Pick a random target inside wander radius, record the starting position
      // and timestamp so we can detect if geometry prevents us from reaching it.
      const angle   = Math.random() * Math.PI * 2;
      const radius  = Math.random() * state.wanderRadius;
      state.targetX      = state.homeX + Math.cos(angle) * radius;
      state.targetZ      = state.homeZ + Math.sin(angle) * radius;
      state.targetStartX = state.currentX;
      state.targetStartZ = state.currentZ;
      state.targetPickedAt = now;
    }

    // ── Walking phase ────────────────────────────────────────────────────
    const dx   = state.targetX - state.currentX;
    const dz   = state.targetZ! - state.currentZ;
    const dist = Math.hypot(dx, dz);

    if (dist < ARRIVE_DIST) {
      // Successfully arrived — clear stuck counter and start the next pause
      state.targetX      = null;
      state.targetZ      = null;
      state.stuckPickCount = 0;
      state.pauseUntil   = now + PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS);
      return;
    }

    // ── Stuck check ──────────────────────────────────────────────────────
    // After STUCK_CHECK_AFTER_MS, verify the mob has actually moved away from
    // where it started this target leg.  Wall resolution may have been silently
    // blocking every step without the wander system knowing.
    if (now > state.targetPickedAt + STUCK_CHECK_AFTER_MS) {
      const movedX = state.currentX - state.targetStartX;
      const movedZ = state.currentZ - state.targetStartZ;
      if (Math.hypot(movedX, movedZ) < STUCK_THRESHOLD_METERS) {
        // Not making progress — abandon this target and try a new direction.
        state.targetX      = null;
        state.targetZ      = null;
        state.stuckPickCount += 1;
        state.pauseUntil   = now; // Skip the pause so we repick immediately

        if (state.stuckPickCount >= MAX_STUCK_PICKS) {
          // All retries exhausted — ask the caller to physically nudge us clear.
          state.stuckPickCount = 0;
          stuckRequests.push(id);
        }
        return;
      }
      // Made enough progress — reset the check window so we don't fire again
      // until another STUCK_CHECK_AFTER_MS has elapsed from current position.
      state.targetStartX   = state.currentX;
      state.targetStartZ   = state.currentZ;
      state.targetPickedAt = now;
    }

    // Heading: server convention — 0° = North (+Z), 90° = East (+X)
    let heading = Math.atan2(dx, dz) * (180 / Math.PI);
    if (heading < 0) heading += 360;

    // Steer around buildings before stepping
    if (steerFn) {
      const pos: Vector3 = { x: state.currentX, y: state.currentY, z: state.currentZ };
      const steered = steerFn(pos, heading);
      if (steered !== null) heading = steered;
    }

    // Advance toward target by at most one tick's worth of movement
    const headingRad = (heading * Math.PI) / 180;
    const step       = Math.min(WANDER_SPEED * dt, dist);
    state.currentX  += Math.sin(headingRad) * step;
    state.currentZ  += Math.cos(headingRad) * step;
    state.heading    = heading;

    moves.push({
      id,
      position: { x: state.currentX, y: state.currentY, z: state.currentZ },
      heading,
    });
  }
}
