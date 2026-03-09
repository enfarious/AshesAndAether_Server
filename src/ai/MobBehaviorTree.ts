/**
 * Mob Behavior Tree — the "motor cortex" for vault mobs.
 *
 * Mirrors CompanionBehaviorTree's output shape (BehaviorTickResult) so the
 * caller (DWM) applies movement + ability actions through the same pipeline.
 *
 * Key differences from companion:
 *   - No LLM adjustments — settings come from static MobCombatProfile
 *   - No follow/retreat/support states — mobs are always engaging or idle
 *   - Movement modes: chase / stationary / kite
 *   - Target priority: nearest / weakest / threatening_player
 *   - Ability selection uses weighted categories + random jitter (never scripted)
 *   - Global cooldown (GCD) prevents ability spam on top of per-ability CDs
 */

import type { CombatAbilityDefinition } from '@/combat/types';
import type { EnmityTable } from '@/combat/EnmityTable';
import { RANGE_DISTANCES, type PreferredRange, type TargetPriority } from './CompanionCombatSettings';
import type { AbilityWeights, MovementMode } from './MobCombatProfile';

// ── Output types (matches companion shape) ──────────────────────────────────

export type MobAIState = 'idle' | 'engaging';

export interface MobBehaviorTickResult {
  /** Movement intent (null = stop). Caller applies speed * deltaTime. */
  movement: { heading: number; speed: number } | null;
  /** Facing direction when stopped. */
  heading: number | null;
  /** Ability to fire this tick (null = no ability). */
  abilityAction: { abilityId: string; targetId: string } | null;
  /** Current AI state. */
  state: MobAIState;
}

// ── Context the tree needs ──────────────────────────────────────────────────

export interface MobCombatEntity {
  id: string;
  position: { x: number; y: number; z: number };
  isAlive: boolean;
  currentHealth?: number;
  maxHealth?: number;
  type: 'player' | 'npc' | 'companion' | 'mob' | 'wildlife';
}

export interface MobCombatContext {
  self: {
    id: string;
    position: { x: number; y: number; z: number };
    currentHealth: number;
    maxHealth: number;
  };
  /** Players + companions (targets for damage-dealing mobs). */
  enemies: MobCombatEntity[];
  /** Allied mobs in the same room (targets for healing mobs like overseer). */
  allies: MobCombatEntity[];
  /** Available abilities (pre-resolved by MobAIController). */
  abilities: CombatAbilityDefinition[];
  /** Per-ability cooldown remaining (abilityId → remaining ms). */
  cooldowns: Map<string, number>;
  /** Current ATB gauge. */
  atbCurrent: number;
  /** Current mana. */
  currentMana: number;
  /** Current stamina. */
  currentStamina: number;
  /** Enmity table for threat-aware targeting. */
  enmityTable?: EnmityTable;
}

// ── Effective settings (resolved by MobAIController from profile + phase) ───

export interface MobEffectiveSettings {
  movementMode: MovementMode;
  preferredRange: PreferredRange;
  targetPriority: TargetPriority;
  abilityIds: string[];
  abilityWeights: AbilityWeights;
  globalCooldownSec: number;
}

// ── Movement speed ──────────────────────────────────────────────────────────

const MOB_CHASE_SPEED = 3.5;  // m/s — matches MobWanderSystem chase speed
const MOB_KITE_SPEED  = 3.0;  // m/s — slightly slower when kiting

// ── The behavior tree ───────────────────────────────────────────────────────

export class MobBehaviorTree {
  private state: MobAIState = 'idle';
  private currentTargetId: string | null = null;

  /** Timestamp of last ability use (Date.now() ms). */
  private lastAbilityUsedAt = 0;

  /**
   * Tick the behavior tree.
   *
   * @param settings  Effective settings from profile + active boss phase
   * @param context   Combat context (self, enemies, allies, abilities, ATB)
   * @param _deltaTime Seconds since last tick (unused for now but available)
   */
  tick(
    settings: MobEffectiveSettings,
    context: MobCombatContext,
    _deltaTime: number,
  ): MobBehaviorTickResult {
    const result: MobBehaviorTickResult = {
      movement: null,
      heading: null,
      abilityAction: null,
      state: this.state,
    };

    // ── No enemies → idle ────────────────────────────────────────────────
    const aliveEnemies = context.enemies.filter(e => e.isAlive);
    if (aliveEnemies.length === 0) {
      this.state = 'idle';
      this.currentTargetId = null;
      result.state = this.state;
      return result;
    }

    this.state = 'engaging';

    // ── Select target ────────────────────────────────────────────────────
    const target = this.selectTarget(settings.targetPriority, context, aliveEnemies);
    if (!target) {
      result.state = this.state;
      return result;
    }
    this.currentTargetId = target.id;
    const dist = distance2D(context.self.position, target.position);

    // ── Movement by mode ─────────────────────────────────────────────────
    switch (settings.movementMode) {
      case 'chase':
        this.tickChase(context, target, dist, settings.preferredRange, result);
        break;
      case 'stationary':
        this.tickStationary(context, target, result);
        break;
      case 'kite':
        this.tickKite(context, target, dist, settings.preferredRange, result);
        break;
    }

    // ── Ability selection ─────────────────────────────────────────────────
    // Check global cooldown
    const now = Date.now();
    const gcdMs = settings.globalCooldownSec * 1000;
    if (now - this.lastAbilityUsedAt >= gcdMs) {
      const action = this.selectAbility(settings, context, target, dist);
      if (action) {
        result.abilityAction = action;
        this.lastAbilityUsedAt = now;
      }
    }

    result.state = this.state;
    return result;
  }

  // ── Movement modes ────────────────────────────────────────────────────

  private tickChase(
    context: MobCombatContext,
    target: MobCombatEntity,
    dist: number,
    preferredRange: PreferredRange,
    result: MobBehaviorTickResult,
  ): void {
    const rangeBand = RANGE_DISTANCES[preferredRange];
    const m = this.manageRange(context.self.position, target.position, dist, rangeBand, MOB_CHASE_SPEED);
    result.heading = m.heading;
    if (m.speed > 0) {
      result.movement = { heading: m.heading, speed: m.speed };
    }
  }

  private tickStationary(
    context: MobCombatContext,
    target: MobCombatEntity,
    result: MobBehaviorTickResult,
  ): void {
    // Face target but never move
    result.heading = headingTo(context.self.position, target.position);
  }

  private tickKite(
    context: MobCombatContext,
    target: MobCombatEntity,
    dist: number,
    preferredRange: PreferredRange,
    result: MobBehaviorTickResult,
  ): void {
    const rangeBand = RANGE_DISTANCES[preferredRange];
    const m = this.manageRange(context.self.position, target.position, dist, rangeBand, MOB_KITE_SPEED);
    result.heading = m.heading;
    if (m.speed > 0) {
      result.movement = { heading: m.heading, speed: m.speed };
    }
  }

  // ── Range management (same algorithm as CompanionBehaviorTree) ─────────

  private manageRange(
    selfPos: { x: number; z: number },
    targetPos: { x: number; z: number },
    currentDist: number,
    rangeBand: { min: number; ideal: number; max: number },
    speed: number,
  ): { heading: number; speed: number } {
    const tolerance = rangeBand.ideal <= 3.5 ? 0.5 : 1.0;
    const facing = headingTo(selfPos, targetPos);

    if (Math.abs(currentDist - rangeBand.ideal) <= tolerance) {
      return { heading: facing, speed: 0 };
    }

    if (currentDist > rangeBand.ideal + tolerance) {
      return { heading: facing, speed };
    }

    // Too close — back away (unless melee with min=0)
    if (rangeBand.min <= 0) {
      return { heading: facing, speed: 0 };
    }

    const dx = selfPos.x - (targetPos as { x: number; z: number }).x;
    const dz = selfPos.z - (targetPos as { x: number; z: number }).z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.1) {
      return { heading: 90, speed };
    }
    const nx = dx / dist;
    const nz = dz / dist;
    return { heading: Math.atan2(nx, nz) * (180 / Math.PI), speed };
  }

  // ── Target selection ──────────────────────────────────────────────────

  private selectTarget(
    priority: TargetPriority,
    context: MobCombatContext,
    alive: MobCombatEntity[],
  ): MobCombatEntity | null {
    if (alive.length === 0) return null;

    switch (priority) {
      case 'nearest':
        return this.findNearest(context.self.position, alive) ?? alive[0]!;

      case 'weakest': {
        let weakest = alive[0]!;
        let lowestHp = Infinity;
        for (const enemy of alive) {
          const hp = enemy.currentHealth ?? Infinity;
          if (hp < lowestHp) {
            lowestHp = hp;
            weakest = enemy;
          }
        }
        return weakest;
      }

      case 'threatening_player': {
        // Pick the enemy (player/companion) that poses the highest threat to us
        // For mobs, "threatening_player" means: who has the most threat on our enmity table
        if (context.enmityTable) {
          let highestThreat = 0;
          let mostThreatening: MobCombatEntity | null = null;
          for (const enemy of alive) {
            const threat = context.enmityTable.getThreat(context.self.id, enemy.id);
            if (threat > highestThreat) {
              highestThreat = threat;
              mostThreatening = enemy;
            }
          }
          if (mostThreatening) return mostThreatening;
        }
        // Fallback: nearest
        return this.findNearest(context.self.position, alive) ?? alive[0]!;
      }

      default:
        return alive[0]!;
    }
  }

  // ── Ability selection (weighted + jitter) ──────────────────────────────

  private selectAbility(
    settings: MobEffectiveSettings,
    context: MobCombatContext,
    target: MobCombatEntity,
    distToTarget: number,
  ): { abilityId: string; targetId: string } | null {
    // Filter abilities to those currently usable
    const usable = context.abilities.filter(ability => {
      // Must be in the active phase's ability list
      if (!settings.abilityIds.includes(ability.id)) return false;
      // Range check
      if (distToTarget > ability.range) return false;
      // Cooldown check
      const cdRemaining = context.cooldowns.get(ability.id) ?? 0;
      if (cdRemaining > 0) return false;
      // ATB check
      if (!ability.isFree && context.atbCurrent < ability.atbCost) return false;
      // Resource checks
      if (ability.manaCost && context.currentMana < ability.manaCost) return false;
      if (ability.staminaCost && context.currentStamina < ability.staminaCost) return false;
      return true;
    });

    if (usable.length === 0) return null;

    // Score by category weight + random jitter (never deterministic)
    const scored = usable.map(ability => {
      const category = categorizeAbility(ability);
      const weight = settings.abilityWeights[category] ?? 0.3;
      const jitter = Math.random() * 0.2;
      return { ability, score: weight + jitter };
    });

    scored.sort((a, b) => b.score - a.score);
    const chosen = scored[0]!.ability;

    // Healing abilities target injured ally (for overseer-type mobs)
    if (chosen.healing) {
      if (chosen.targetType === 'self') {
        return { abilityId: chosen.id, targetId: context.self.id };
      }
      // Find most injured ally (including self)
      const healTarget = this.findMostInjuredAlly(context);
      if (healTarget) {
        return { abilityId: chosen.id, targetId: healTarget.id };
      }
      // Nobody needs healing — try next best non-heal ability
      const nonHeal = scored.find(s => !s.ability.healing);
      if (nonHeal) return { abilityId: nonHeal.ability.id, targetId: target.id };
      return null;
    }

    return { abilityId: chosen.id, targetId: target.id };
  }

  // ── Healing helpers (for overseer/support mobs) ────────────────────────

  private findMostInjuredAlly(context: MobCombatContext): MobCombatEntity | null {
    const HEAL_THRESHOLD = 0.85; // heal allies below 85% HP

    const candidates: MobCombatEntity[] = [];

    // Check self
    const selfRatio = context.self.maxHealth > 0
      ? context.self.currentHealth / context.self.maxHealth
      : 1;
    if (selfRatio < HEAL_THRESHOLD) {
      candidates.push({
        id: context.self.id,
        position: context.self.position,
        isAlive: true,
        currentHealth: context.self.currentHealth,
        maxHealth: context.self.maxHealth,
        type: 'mob',
      });
    }

    // Check allied mobs
    for (const ally of context.allies) {
      if (!ally.isAlive) continue;
      const hpRatio = (ally.currentHealth ?? 1) / (ally.maxHealth ?? 1);
      if (hpRatio < HEAL_THRESHOLD) candidates.push(ally);
    }

    if (candidates.length === 0) return null;

    // Pick lowest HP ratio
    let most = candidates[0]!;
    let lowestRatio = (most.currentHealth ?? 1) / (most.maxHealth ?? 1);
    for (let i = 1; i < candidates.length; i++) {
      const ratio = (candidates[i]!.currentHealth ?? 1) / (candidates[i]!.maxHealth ?? 1);
      if (ratio < lowestRatio) {
        lowestRatio = ratio;
        most = candidates[i]!;
      }
    }
    return most;
  }

  // ── Utility ────────────────────────────────────────────────────────────

  private findNearest(
    from: { x: number; z: number },
    entities: MobCombatEntity[],
  ): MobCombatEntity | null {
    let nearest: MobCombatEntity | null = null;
    let nearestDist = Infinity;
    for (const e of entities) {
      const d = distance2D(from, e.position);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = e;
      }
    }
    return nearest;
  }

  getCurrentTargetId(): string | null {
    return this.currentTargetId;
  }

  getState(): MobAIState {
    return this.state;
  }

  reset(): void {
    this.state = 'idle';
    this.currentTargetId = null;
    this.lastAbilityUsedAt = 0;
  }
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

function distance2D(
  a: { x: number; z: number },
  b: { x: number; z: number },
): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function headingTo(
  from: { x: number; z: number },
  to: { x: number; z: number },
): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return Math.atan2(dx, dz) * (180 / Math.PI);
}

/** Map a CombatAbilityDefinition to its weight category. */
function categorizeAbility(ability: CombatAbilityDefinition): keyof AbilityWeights {
  if (ability.healing) return 'heal';
  if (ability.tags?.some(t => t === 'cc' || t === 'root' || t === 'stun' || t === 'pull')) return 'cc';
  if (ability.tags?.some(t => t === 'debuff')) return 'debuff';
  if (ability.tags?.some(t => t === 'buff')) return 'buff';
  return 'damage';
}
