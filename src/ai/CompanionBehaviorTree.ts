import type { CombatAbilityDefinition } from '@/combat/types';
import type { CompanionCombatSettings } from './CompanionCombatSettings';
import { RANGE_DISTANCES } from './CompanionCombatSettings';

/**
 * Companion Behavior Tree — the "motor cortex".
 *
 * Executes movement, attacks, and ability usage every tick based on current
 * settings. Does NOT call the LLM. The LLM adjusts settings separately;
 * this tree just reads them.
 *
 * Outputs position deltas and combat actions for the caller to apply.
 */

// ── Output types ─────────────────────────────────────────────────────────────

export interface BehaviorTickResult {
  /**
   * Continuous movement intent: null = stop, non-null = keep moving at this heading + speed.
   * The caller computes the actual position step as `speed * deltaTime` so the same intent
   * produces smooth motion regardless of tick rate.
   */
  movement: { heading: number; speed: number } | null;
  /**
   * Facing direction when standing still (e.g. "face the target while in range").
   * When movement is non-null, movement.heading already implies facing — this is
   * only used for the stopped-but-facing case.
   */
  heading: number | null;
  /** Ability to use this tick (null = no ability). Caller validates ATB/cooldowns. */
  abilityAction: {
    abilityId: string;
    targetId: string;
  } | null;
  /** Current AI state for debugging/logging. */
  state: CompanionAIState;
}

export type CompanionAIState =
  | 'idle'
  | 'engaging'
  | 'retreating'
  | 'supporting'
  | 'following_player';

// ── Entity info the tree needs (minimal interface, no coupling to ZoneManager) ──

export interface CombatEntity {
  id: string;
  name: string;
  type: 'player' | 'npc' | 'companion' | 'mob' | 'wildlife';
  position: { x: number; y: number; z: number };
  isAlive: boolean;
  inCombat?: boolean;
  currentHealth?: number;
  maxHealth?: number;
  level?: number;
  tag?: string;      // e.g. "mob.rat.1" — stable identifier for mob instance
  family?: string;   // e.g. "hare", "canine" — broad taxonomy
  species?: string;  // e.g. "snow_hare", "spiral_fox" — specific variant
  faction?: string;  // e.g. "hostile", "neutral"
}

export interface CompanionSelf {
  id: string;
  position: { x: number; y: number; z: number };
  currentHealth: number;
  maxHealth: number;
}

export interface CombatContext {
  self: CompanionSelf;
  /** The player this companion is following (may be null if solo NPC). */
  owner: CombatEntity | null;
  /** Hostile entities in perception range. */
  enemies: CombatEntity[];
  /** Friendly entities (other companions, allied players). */
  allies: CombatEntity[];
  /** Available abilities for this companion. */
  abilities: CombatAbilityDefinition[];
  /** Which abilities are currently on cooldown (abilityId → remaining ms). */
  cooldowns: Map<string, number>;
  /** Current ATB gauge value. */
  atbCurrent: number;
  /** Whether companion has an auto-attack target already set. */
  hasAutoAttackTarget: boolean;
}

// ── Movement speed ───────────────────────────────────────────────────────────

const COMPANION_MOVE_SPEED = 5.0;    // m/s in combat (match player pace)
const COMPANION_RETREAT_SPEED = 5.5; // m/s when retreating (slight speed boost)
const FOLLOW_DISTANCE = 4.0;         // Stop following when this close
const FOLLOW_RESUME_DISTANCE = 6.0;  // Start following when this far (hysteresis prevents stutter)

// ── The behavior tree ────────────────────────────────────────────────────────

export class CompanionBehaviorTree {
  private state: CompanionAIState = 'idle';
  private currentTargetId: string | null = null;
  private isFollowing = false; // hysteresis flag for follow behavior

  /**
   * Tick the behavior tree. Called every game tick when companion is in combat
   * (or near combat). Returns actions for the caller to execute.
   */
  tick(
    settings: CompanionCombatSettings,
    context: CombatContext,
    deltaTime: number,
  ): BehaviorTickResult {
    const result: BehaviorTickResult = {
      movement: null,
      heading: null,
      abilityAction: null,
      state: this.state,
    };

    const hpRatio = context.self.maxHealth > 0
      ? context.self.currentHealth / context.self.maxHealth
      : 1;

    // ── State transitions ──────────────────────────────────────────────────

    const hasEnemies = context.enemies.length > 0;

    if (!hasEnemies) {
      // No enemies — follow player or idle
      this.state = context.owner ? 'following_player' : 'idle';
      this.currentTargetId = null;
    } else if (hpRatio < settings.retreatThreshold) {
      this.state = 'retreating';
    } else if (settings.stance === 'support') {
      this.state = 'supporting';
    } else {
      this.state = 'engaging';
    }

    // ── Execute based on state ─────────────────────────────────────────────

    switch (this.state) {
      case 'idle':
        // Do nothing
        break;

      case 'following_player':
        this.tickFollowPlayer(context, deltaTime, result);
        break;

      case 'engaging':
        this.tickEngaging(settings, context, deltaTime, result);
        break;

      case 'retreating':
        this.tickRetreating(settings, context, deltaTime, result);
        break;

      case 'supporting':
        this.tickSupporting(settings, context, deltaTime, result);
        break;
    }

    result.state = this.state;
    return result;
  }

  // ── State handlers ───────────────────────────────────────────────────────

  private tickFollowPlayer(
    context: CombatContext,
    _deltaTime: number,
    result: BehaviorTickResult,
  ): void {
    if (!context.owner) return;

    const dist = distance2D(context.self.position, context.owner.position);

    // Hysteresis: start following at FOLLOW_RESUME_DISTANCE, stop at FOLLOW_DISTANCE.
    // Prevents start/stop stutter when hovering near the threshold.
    if (!this.isFollowing && dist > FOLLOW_RESUME_DISTANCE) {
      this.isFollowing = true;
    } else if (this.isFollowing && dist <= FOLLOW_DISTANCE) {
      this.isFollowing = false;
    }

    if (this.isFollowing) {
      const heading = headingTo(context.self.position, context.owner.position);
      result.movement = { heading, speed: COMPANION_MOVE_SPEED };
      result.heading = heading;
    }
  }

  private tickEngaging(
    settings: CompanionCombatSettings,
    context: CombatContext,
    _deltaTime: number,
    result: BehaviorTickResult,
  ): void {
    // 1. Select target
    const target = this.selectTarget(settings, context);
    if (!target) return;

    this.currentTargetId = target.id;
    const dist = distance2D(context.self.position, target.position);

    // 2. Range management — move to ideal range
    const rangeBand = RANGE_DISTANCES[settings.preferredRange];
    const m = this.manageRange(
      context.self.position,
      target.position,
      dist,
      rangeBand,
      COMPANION_MOVE_SPEED,
    );
    result.heading = m.heading;
    if (m.speed > 0) {
      result.movement = { heading: m.heading, speed: m.speed };
    }

    // 3. Try to use an ability (if in range and ATB available)
    result.abilityAction = this.selectAbility(settings, context, target, dist);
  }

  private tickRetreating(
    _settings: CompanionCombatSettings,
    context: CombatContext,
    _deltaTime: number,
    result: BehaviorTickResult,
  ): void {
    // Find nearest enemy and move away from them
    const nearestEnemy = this.findNearest(context.self.position, context.enemies);
    if (!nearestEnemy) return;

    const dx = context.self.position.x - nearestEnemy.position.x;
    const dz = context.self.position.z - nearestEnemy.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 0.1) {
      // On top of enemy — pick arbitrary escape direction
      result.movement = { heading: 90, speed: COMPANION_RETREAT_SPEED };
      result.heading = 90;
      return;
    }

    // Move directly away
    const nx = dx / dist;
    const nz = dz / dist;
    const escapeHeading = Math.atan2(nx, nz) * (180 / Math.PI);
    result.movement = { heading: escapeHeading, speed: COMPANION_RETREAT_SPEED };
    result.heading = escapeHeading;

    // While retreating, still try to use any instant heal if available
    const healAbility = this.findBestHealAbility(context, context.self.id);
    if (healAbility) {
      result.abilityAction = { abilityId: healAbility.id, targetId: context.self.id };
    }
  }

  private tickSupporting(
    settings: CompanionCombatSettings,
    context: CombatContext,
    _deltaTime: number,
    result: BehaviorTickResult,
  ): void {
    // Support priority: heal injured allies > CC enemies > damage

    // 1. Check if any ally needs healing
    const injuredAlly = this.findMostInjuredAlly(context);
    if (injuredAlly) {
      const healAbility = this.findBestHealAbility(context, injuredAlly.id);
      if (healAbility) {
        // Move within range of ally
        const dist = distance2D(context.self.position, injuredAlly.position);
        if (dist > healAbility.range) {
          const heading = headingTo(context.self.position, injuredAlly.position);
          result.movement = { heading, speed: COMPANION_MOVE_SPEED };
          result.heading = heading;
        }
        result.abilityAction = { abilityId: healAbility.id, targetId: injuredAlly.id };
        return;
      }
    }

    // 2. Fall back to cautious damage dealing (mid range, prefer CC)
    const target = this.selectTarget(settings, context);
    if (!target) return;

    this.currentTargetId = target.id;
    const dist = distance2D(context.self.position, target.position);

    // Support stance uses mid range regardless of settings
    const rangeBand = RANGE_DISTANCES.mid;
    const m = this.manageRange(
      context.self.position,
      target.position,
      dist,
      rangeBand,
      COMPANION_MOVE_SPEED,
    );
    result.heading = m.heading;
    if (m.speed > 0) {
      result.movement = { heading: m.heading, speed: m.speed };
    }

    // Prefer CC abilities when supporting
    result.abilityAction = this.selectAbility(
      { ...settings, abilityWeights: { ...settings.abilityWeights, cc: Math.max(settings.abilityWeights.cc ?? 0, 0.8) } },
      context,
      target,
      dist,
    );
  }

  // ── Target selection ─────────────────────────────────────────────────────

  private selectTarget(
    settings: CompanionCombatSettings,
    context: CombatContext,
  ): CombatEntity | null {
    const alive = context.enemies.filter(e => e.isAlive);
    if (alive.length === 0) return null;

    switch (settings.priority) {
      case 'nearest':
        return this.findNearest(context.self.position, alive) ?? alive[0];

      case 'weakest': {
        let weakest = alive[0];
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
        if (!context.owner) return this.findNearest(context.self.position, alive) ?? alive[0];
        // Find enemy closest to the player (most threatening)
        return this.findNearest(context.owner.position, alive) ?? alive[0];
      }

      default:
        return alive[0];
    }
  }

  // ── Range management ─────────────────────────────────────────────────────

  /**
   * Returns the movement intent needed to reach/maintain the ideal range band.
   * `speed = 0` means "stopped at ideal range, but face the target heading."
   * `speed > 0` means "keep moving at this heading and speed."
   * The caller applies `speed * deltaTime` to compute the actual step.
   */
  private manageRange(
    selfPos: { x: number; y: number; z: number },
    targetPos: { x: number; y: number; z: number },
    currentDist: number,
    rangeBand: { min: number; ideal: number; max: number },
    speed: number,
  ): { heading: number; speed: number } {
    // Tighter tolerance for melee (ideal ≤ 3.5m) to stay reliably in range
    const tolerance = rangeBand.ideal <= 3.5 ? 0.5 : 1.0;
    const facing = headingTo(selfPos, targetPos);

    if (Math.abs(currentDist - rangeBand.ideal) <= tolerance) {
      // Already at ideal range — face target, no movement
      return { heading: facing, speed: 0 };
    }

    if (currentDist > rangeBand.ideal + tolerance) {
      // Too far — approach
      return { heading: facing, speed };
    }

    // Too close — back away
    const dx = selfPos.x - targetPos.x;
    const dz = selfPos.z - targetPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.1) {
      return { heading: 90, speed };
    }
    const nx = dx / dist;
    const nz = dz / dist;
    return { heading: Math.atan2(nx, nz) * (180 / Math.PI), speed };
  }

  // ── Ability selection ────────────────────────────────────────────────────

  private selectAbility(
    settings: CompanionCombatSettings,
    context: CombatContext,
    target: CombatEntity,
    distToTarget: number,
  ): { abilityId: string; targetId: string } | null {
    // Filter to usable abilities: in range, off cooldown, enough ATB
    const usable = context.abilities.filter(ability => {
      if (distToTarget > ability.range) return false;
      const cdRemaining = context.cooldowns.get(ability.id) ?? 0;
      if (cdRemaining > 0) return false;
      if (!ability.isFree && context.atbCurrent < ability.atbCost) return false;
      return true;
    });

    if (usable.length === 0) return null;

    // Score each ability by its category weight
    const scored = usable.map(ability => {
      const category = this.categorizeAbility(ability);
      const weight = settings.abilityWeights[category] ?? 0.3;
      // Add small random jitter to prevent deterministic rotation
      const score = weight + (Math.random() * 0.15);
      return { ability, score };
    });

    // Sort by score descending and pick the best
    scored.sort((a, b) => b.score - a.score);
    const chosen = scored[0].ability;

    // Determine target (healing targets self/ally, damage targets enemy)
    const targetId = chosen.healing
      ? this.findMostInjuredAlly(context)?.id ?? context.self.id
      : target.id;

    return { abilityId: chosen.id, targetId };
  }

  private categorizeAbility(ability: CombatAbilityDefinition): string {
    if (ability.healing) return 'heal';
    if (ability.damage) return 'damage';
    // TODO: detect CC abilities (stun, root, slow) from status effects when implemented
    return 'cc';
  }

  // ── Healing helpers ──────────────────────────────────────────────────────

  private findMostInjuredAlly(context: CombatContext): CombatEntity | null {
    const candidates: CombatEntity[] = [];

    // Check owner
    if (context.owner?.isAlive) {
      const ownerHpRatio = (context.owner.currentHealth ?? 1) / (context.owner.maxHealth ?? 1);
      if (ownerHpRatio < 0.8) candidates.push(context.owner);
    }

    // Check other allies
    for (const ally of context.allies) {
      if (!ally.isAlive) continue;
      const hpRatio = (ally.currentHealth ?? 1) / (ally.maxHealth ?? 1);
      if (hpRatio < 0.8) candidates.push(ally);
    }

    // Check self
    const selfRatio = context.self.currentHealth / context.self.maxHealth;
    if (selfRatio < 0.8) {
      candidates.push({
        id: context.self.id,
        name: '',
        type: 'companion',
        position: context.self.position,
        isAlive: true,
        currentHealth: context.self.currentHealth,
        maxHealth: context.self.maxHealth,
      });
    }

    if (candidates.length === 0) return null;

    // Return most injured
    let most = candidates[0];
    let lowestRatio = (most.currentHealth ?? 1) / (most.maxHealth ?? 1);
    for (let i = 1; i < candidates.length; i++) {
      const ratio = (candidates[i].currentHealth ?? 1) / (candidates[i].maxHealth ?? 1);
      if (ratio < lowestRatio) {
        lowestRatio = ratio;
        most = candidates[i];
      }
    }
    return most;
  }

  private findBestHealAbility(
    context: CombatContext,
    _targetId: string,
  ): CombatAbilityDefinition | null {
    const heals = context.abilities.filter(a => {
      if (!a.healing) return false;
      const cdRemaining = context.cooldowns.get(a.id) ?? 0;
      if (cdRemaining > 0) return false;
      if (!a.isFree && context.atbCurrent < a.atbCost) return false;
      return true;
    });

    if (heals.length === 0) return null;

    // Pick highest healing amount
    heals.sort((a, b) => (b.healing?.amount ?? 0) - (a.healing?.amount ?? 0));
    return heals[0];
  }

  // ── Utility ──────────────────────────────────────────────────────────────

  private findNearest(
    from: { x: number; y: number; z: number },
    entities: CombatEntity[],
  ): CombatEntity | null {
    let nearest: CombatEntity | null = null;
    let nearestDist = Infinity;

    for (const entity of entities) {
      const dist = distance2D(from, entity.position);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = entity;
      }
    }

    return nearest;
  }

  /** Get the current target entity ID. */
  getCurrentTargetId(): string | null {
    return this.currentTargetId;
  }

  /** Get the current AI state. */
  getState(): CompanionAIState {
    return this.state;
  }

  /** Reset state (e.g., when combat ends). */
  reset(): void {
    this.state = 'idle';
    this.currentTargetId = null;
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

