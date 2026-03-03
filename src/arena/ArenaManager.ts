/**
 * ArenaManager
 *
 * Manages instanced dueling arenas. Each instance is an in-memory overlay on top
 * of the ARENA_DUEL_TEMPLATE zone. The database zone provides the geometry and
 * spawn points; ArenaManager provides the phase state machine and combat gating.
 *
 * Phase state machine:
 *
 *   SETUP → COUNTDOWN → ACTIVE → ENDED
 *     │                            │
 *     └────────────────────────────┘  (reset loops back to SETUP)
 *
 * SETUP:
 *   - Entities enter, get placed at spawn points
 *   - Mobs/companions are inert (no AI, no aggro)
 *   - PvP targeting is locked (combat_enabled = false)
 *   - Owner can invite combatants, spawn dummy, open to spectators
 *
 * COUNTDOWN:
 *   - 3 second countdown broadcast to all in instance
 *   - No new entries during countdown
 *   - Entities locked in place (movement disabled for combatants)
 *
 * ACTIVE:
 *   - combat_enabled flips true
 *   - Mobs/companions come online (AI activates)
 *   - PvP targeting unlocked between consenting combatants
 *   - Full combat logging begins
 *
 * ENDED:
 *   - Combat stops, entities returned to inert
 *   - Summary broadcast (damage dealt, hits landed, etc.)
 *   - Owner can reset or disband
 */

import { logger } from '@/utils/logger';
import { randomUUID } from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ArenaPhase = 'SETUP' | 'COUNTDOWN' | 'ACTIVE' | 'ENDED';

export type ArenaRole = 'owner' | 'combatant' | 'spectator' | 'dummy';

export interface ArenaParticipant {
  characterId: string;
  name: string;
  role: ArenaRole;
  /** For combatants: spawn position they were placed at */
  spawnPosition: { x: number; y: number; z: number };
  /** True if this participant is an AI entity (companion/mob) */
  isAI: boolean;
}

export interface ArenaInstance {
  instanceId: string;
  /** Character ID of the player who created this instance */
  ownerId: string;
  phase: ArenaPhase;
  /** Whether the instance is visible/joinable as spectator */
  isOpen: boolean;
  participants: Map<string, ArenaParticipant>;
  /** Countdown interval reference — cleared when countdown ends */
  countdownTimer: NodeJS.Timeout | null;
  /** Remaining countdown seconds */
  countdownRemaining: number;
  /** Timestamp when ACTIVE phase began */
  combatStartedAt: number | null;
  /** Running combat log for end-of-round summary */
  combatLog: CombatLogEntry[];
  createdAt: number;
}

export interface CombatLogEntry {
  timestamp: number;
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  abilityId: string;
  damage: number;
  hit: boolean;
}

export interface ArenaSummary {
  instanceId: string;
  duration: number; // seconds
  participants: Array<{
    characterId: string;
    name: string;
    role: ArenaRole;
    damageDealt: number;
    hitsLanded: number;
    hitsTaken: number;
    damageTaken: number;
  }>;
}

// ─── Spawn positions (mirrors seed-arena.ts) ─────────────────────────────────

const SPAWN_POSITIONS = {
  player:    { x:  0, y: 0, z: -8 },
  companion: { x: -3, y: 0, z: -8 },
  dummy:     { x:  0, y: 0, z:  0 },
  spectators: [
    { x: -12, y: 0, z: 40 },
    { x:  -4, y: 0, z: 40 },
    { x:   4, y: 0, z: 40 },
    { x:  12, y: 0, z: 40 },
  ],
} as const;

const COUNTDOWN_SECONDS = 3;
const DUMMY_TAG = 'mob.dummy';

// ─── Broadcast callback type ──────────────────────────────────────────────────

/**
 * ArenaManager calls this whenever it needs to broadcast a message
 * to participants. The caller (DistributedWorldManager) wires this up
 * to the actual socket broadcast mechanism.
 */
export type ArenaBroadcastFn = (
  instanceId: string,
  recipientIds: string[],
  event: string,
  data: Record<string, unknown>
) => void;

/**
 * Called when ArenaManager needs to flip combat gating on entities.
 * DistributedWorldManager uses this to set/clear the combatEnabled flag
 * on the CombatManager for specific entity pairs.
 */
export type ArenaSetCombatEnabledFn = (
  instanceId: string,
  combatantIds: string[],
  enabled: boolean
) => void;

/**
 * Called when ArenaManager needs to activate or deactivate AI for a mob/companion.
 */
export type ArenaSetAIActiveFn = (
  entityId: string,
  active: boolean
) => void;

// ─── ArenaManager ─────────────────────────────────────────────────────────────

export class ArenaManager {
  /** instanceId → ArenaInstance */
  private instances: Map<string, ArenaInstance> = new Map();

  /** characterId → instanceId (quick reverse lookup) */
  private characterToInstance: Map<string, string> = new Map();

  private broadcast: ArenaBroadcastFn;
  private setCombatEnabled: ArenaSetCombatEnabledFn;
  private setAIActive: ArenaSetAIActiveFn;

  constructor(
    broadcast: ArenaBroadcastFn,
    setCombatEnabled: ArenaSetCombatEnabledFn,
    setAIActive: ArenaSetAIActiveFn,
  ) {
    this.broadcast = broadcast;
    this.setCombatEnabled = setCombatEnabled;
    this.setAIActive = setAIActive;
  }

  // ── Instance lifecycle ─────────────────────────────────────────────────────

  /**
   * Create a new arena instance owned by `ownerId`.
   * Returns the instanceId.
   */
  create(ownerId: string, ownerName: string): string {
    // One active instance per player
    const existingId = this.characterToInstance.get(ownerId);
    if (existingId) {
      const existing = this.instances.get(existingId);
      if (existing && existing.phase !== 'ENDED') {
        throw new Error('You already have an active arena instance. Use /arena disband to close it.');
      }
      // Clean up ended instance
      this.cleanup(existingId);
    }

    const instanceId = randomUUID();
    const instance: ArenaInstance = {
      instanceId,
      ownerId,
      phase: 'SETUP',
      isOpen: false,
      participants: new Map(),
      countdownTimer: null,
      countdownRemaining: COUNTDOWN_SECONDS,
      combatStartedAt: null,
      combatLog: [],
      createdAt: Date.now(),
    };

    // Owner is first combatant
    instance.participants.set(ownerId, {
      characterId: ownerId,
      name: ownerName,
      role: 'owner',
      spawnPosition: SPAWN_POSITIONS.player,
      isAI: false,
    });

    this.instances.set(instanceId, instance);
    this.characterToInstance.set(ownerId, instanceId);

    logger.info({ instanceId, ownerId }, 'Arena instance created');
    return instanceId;
  }

  /**
   * Open the instance to spectators.
   */
  open(ownerId: string): void {
    const instance = this.getInstanceForOwner(ownerId);
    this.assertPhase(instance, 'SETUP');
    instance.isOpen = true;
    logger.info({ instanceId: instance.instanceId }, 'Arena opened to spectators');
  }

  /**
   * Add a training dummy to the ring.
   * The dummy is inert in SETUP; ArenaManager activates its "AI" (really just
   * the mob.dummy tag — no actual LLM) when ACTIVE begins.
   */
  spawnDummy(ownerId: string, dummyId: string, dummyName: string): void {
    const instance = this.getInstanceForOwner(ownerId);
    this.assertPhase(instance, 'SETUP');

    instance.participants.set(dummyId, {
      characterId: dummyId,
      name:         dummyName,
      role:         'dummy',
      spawnPosition: SPAWN_POSITIONS.dummy,
      isAI:         true,
    });

    this.characterToInstance.set(dummyId, instance.instanceId);

    // Ensure AI is off during setup
    this.setAIActive(dummyId, false);

    logger.info({ instanceId: instance.instanceId, dummyId }, 'Training dummy placed in ring');
  }

  /**
   * Add a companion to the instance as a combatant.
   */
  addCompanion(ownerId: string, companionId: string, companionName: string): void {
    const instance = this.getInstanceForOwner(ownerId);
    this.assertPhase(instance, 'SETUP');

    instance.participants.set(companionId, {
      characterId:  companionId,
      name:         companionName,
      role:         'combatant',
      spawnPosition: SPAWN_POSITIONS.companion,
      isAI:         true,
    });

    this.characterToInstance.set(companionId, instance.instanceId);
    this.setAIActive(companionId, false); // Inert until ACTIVE
    logger.info({ instanceId: instance.instanceId, companionId }, 'Companion added to arena');
  }

  /**
   * Add a player as spectator (requires instance.isOpen).
   */
  joinAsSpectator(characterId: string, characterName: string, instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error('Arena instance not found.');
    if (!instance.isOpen) throw new Error('This arena is not open to spectators.');
    if (instance.phase === 'ENDED') throw new Error('This arena has ended.');

    const spectatorIndex = this.spectatorCount(instance);
    if (spectatorIndex >= SPAWN_POSITIONS.spectators.length) {
      throw new Error('Spectator area is full.');
    }

    instance.participants.set(characterId, {
      characterId,
      name:         characterName,
      role:         'spectator',
      spawnPosition: SPAWN_POSITIONS.spectators[spectatorIndex],
      isAI:         false,
    });

    this.characterToInstance.set(characterId, instanceId);
    logger.info({ instanceId, characterId }, 'Spectator joined arena');
  }

  // ── Countdown & combat start ───────────────────────────────────────────────

  /**
   * Begin the 3-2-1 countdown. Transitions SETUP → COUNTDOWN → ACTIVE.
   */
  startCountdown(ownerId: string): void {
    const instance = this.getInstanceForOwner(ownerId);
    this.assertPhase(instance, 'SETUP');

    const combatants = this.getCombatants(instance);
    if (combatants.length < 2) {
      throw new Error(
        'Need at least 2 combatants (e.g. player + dummy or player + companion) to start.'
      );
    }

    instance.phase = 'COUNTDOWN';
    instance.countdownRemaining = COUNTDOWN_SECONDS;

    const allIds = this.getAllParticipantIds(instance);

    this.broadcast(instance.instanceId, allIds, 'arena_countdown', {
      instanceId:  instance.instanceId,
      secondsLeft: COUNTDOWN_SECONDS,
      message:     `Combat begins in ${COUNTDOWN_SECONDS}...`,
    });

    logger.info({ instanceId: instance.instanceId }, 'Arena countdown started');

    instance.countdownTimer = setInterval(() => {
      instance.countdownRemaining -= 1;

      if (instance.countdownRemaining > 0) {
        this.broadcast(instance.instanceId, allIds, 'arena_countdown', {
          instanceId:  instance.instanceId,
          secondsLeft: instance.countdownRemaining,
          message:     `${instance.countdownRemaining}...`,
        });
      } else {
        clearInterval(instance.countdownTimer!);
        instance.countdownTimer = null;
        this.activateCombat(instance);
      }
    }, 1000);
  }

  /**
   * Internal: flip all the switches when the countdown hits zero.
   */
  private activateCombat(instance: ArenaInstance): void {
    instance.phase = 'ACTIVE';
    instance.combatStartedAt = Date.now();

    const combatants = this.getCombatants(instance);
    const combatantIds = combatants.map(c => c.characterId);
    const allIds = this.getAllParticipantIds(instance);

    // Unlock targeting between all combatants
    this.setCombatEnabled(instance.instanceId, combatantIds, true);

    // Activate AI for any AI-controlled combatants (companions, dummy hit-response if any)
    for (const p of combatants) {
      if (p.isAI) {
        this.setAIActive(p.characterId, true);
      }
    }

    this.broadcast(instance.instanceId, allIds, 'arena_start', {
      instanceId: instance.instanceId,
      message:    'Fight!',
      combatants: combatantIds,
    });

    logger.info(
      { instanceId: instance.instanceId, combatantCount: combatantIds.length },
      'Arena combat activated'
    );
  }

  // ── Combat logging ────────────────────────────────────────────────────────

  /**
   * Called by combat system after each hit/miss resolves.
   * ArenaManager is combat-system-agnostic — the caller passes the resolved data.
   */
  recordCombatEvent(entry: CombatLogEntry): void {
    const instanceId = this.characterToInstance.get(entry.sourceId);
    if (!instanceId) return;
    const instance = this.instances.get(instanceId);
    if (!instance || instance.phase !== 'ACTIVE') return;
    instance.combatLog.push(entry);
  }

  // ── End & cleanup ─────────────────────────────────────────────────────────

  /**
   * End combat and broadcast the summary.
   * Can be called explicitly (/arena end) or will eventually be called
   * automatically when all combatants on one side are down.
   */
  endCombat(ownerId: string): ArenaSummary {
    const instance = this.getInstanceForOwner(ownerId);

    if (instance.phase !== 'ACTIVE' && instance.phase !== 'COUNTDOWN') {
      throw new Error('No active combat to end.');
    }

    // Cancel countdown if somehow called during countdown
    if (instance.countdownTimer) {
      clearInterval(instance.countdownTimer);
      instance.countdownTimer = null;
    }

    instance.phase = 'ENDED';

    const combatants = this.getCombatants(instance);
    const combatantIds = combatants.map(c => c.characterId);

    // Disable combat and AI
    this.setCombatEnabled(instance.instanceId, combatantIds, false);
    for (const p of combatants) {
      if (p.isAI) this.setAIActive(p.characterId, false);
    }

    const summary = this.buildSummary(instance);
    const allIds = this.getAllParticipantIds(instance);

    this.broadcast(instance.instanceId, allIds, 'arena_end', {
      instanceId: instance.instanceId,
      summary,
      message: 'Combat has ended.',
    });

    logger.info({ instanceId: instance.instanceId }, 'Arena combat ended');
    return summary;
  }

  /**
   * Tear down the instance entirely. Removes all participant mappings.
   */
  disband(ownerId: string): void {
    const instance = this.getInstanceForOwner(ownerId);

    if (instance.phase === 'ACTIVE' || instance.phase === 'COUNTDOWN') {
      this.endCombat(ownerId);
    }

    this.cleanup(instance.instanceId);

    logger.info({ instanceId: instance.instanceId, ownerId }, 'Arena instance disbanded');
  }

  private cleanup(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    if (instance.countdownTimer) {
      clearInterval(instance.countdownTimer);
    }

    for (const participantId of instance.participants.keys()) {
      this.characterToInstance.delete(participantId);
    }

    this.instances.delete(instanceId);
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  getInstanceForCharacter(characterId: string): ArenaInstance | null {
    const instanceId = this.characterToInstance.get(characterId);
    if (!instanceId) return null;
    return this.instances.get(instanceId) ?? null;
  }

  isCombatEnabled(sourceId: string, targetId: string): boolean {
    const instance = this.getInstanceForCharacter(sourceId);
    if (!instance) return false; // Not in an arena — use normal rules
    if (instance.phase !== 'ACTIVE') return false;
    // Both must be in the same instance as combatants
    const sourceP = instance.participants.get(sourceId);
    const targetP = instance.participants.get(targetId);
    if (!sourceP || !targetP) return false;
    return sourceP.role !== 'spectator' && targetP.role !== 'spectator';
  }

  getPhase(instanceId: string): ArenaPhase | null {
    return this.instances.get(instanceId)?.phase ?? null;
  }

  listOpenInstances(): Array<{ instanceId: string; ownerName: string; spectatorCount: number }> {
    const result = [];
    for (const instance of this.instances.values()) {
      if (instance.isOpen && instance.phase !== 'ENDED') {
        const owner = instance.participants.get(instance.ownerId);
        result.push({
          instanceId:    instance.instanceId,
          ownerName:     owner?.name ?? 'Unknown',
          spectatorCount: this.spectatorCount(instance),
        });
      }
    }
    return result;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private getInstanceForOwner(ownerId: string): ArenaInstance {
    const instanceId = this.characterToInstance.get(ownerId);
    if (!instanceId) throw new Error('You do not have an active arena instance.');
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error('Arena instance not found.');
    if (instance.ownerId !== ownerId) throw new Error('You are not the owner of this arena.');
    return instance;
  }

  private assertPhase(instance: ArenaInstance, expected: ArenaPhase): void {
    if (instance.phase !== expected) {
      throw new Error(
        `Cannot perform this action during the ${instance.phase} phase.`
      );
    }
  }

  private getCombatants(instance: ArenaInstance): ArenaParticipant[] {
    return Array.from(instance.participants.values()).filter(
      p => p.role !== 'spectator'
    );
  }

  private getAllParticipantIds(instance: ArenaInstance): string[] {
    return Array.from(instance.participants.keys());
  }

  private spectatorCount(instance: ArenaInstance): number {
    let count = 0;
    for (const p of instance.participants.values()) {
      if (p.role === 'spectator') count++;
    }
    return count;
  }

  private buildSummary(instance: ArenaInstance): ArenaSummary {
    const duration = instance.combatStartedAt
      ? Math.round((Date.now() - instance.combatStartedAt) / 1000)
      : 0;

    const stats = new Map<string, {
      characterId: string;
      name: string;
      role: ArenaRole;
      damageDealt: number;
      hitsLanded: number;
      hitsTaken: number;
      damageTaken: number;
    }>();

    for (const p of instance.participants.values()) {
      stats.set(p.characterId, {
        characterId: p.characterId,
        name:        p.name,
        role:        p.role,
        damageDealt: 0,
        hitsLanded:  0,
        hitsTaken:   0,
        damageTaken: 0,
      });
    }

    for (const entry of instance.combatLog) {
      const src = stats.get(entry.sourceId);
      const tgt = stats.get(entry.targetId);
      if (src && entry.hit) {
        src.damageDealt += entry.damage;
        src.hitsLanded  += 1;
      }
      if (tgt && entry.hit) {
        tgt.damageTaken += entry.damage;
        tgt.hitsTaken   += 1;
      }
    }

    return {
      instanceId: instance.instanceId,
      duration,
      participants: Array.from(stats.values()),
    };
  }
}
