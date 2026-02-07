/**
 * Animation Lock System
 * 
 * Manages character animation states and action locks.
 * Prevents unrealistic behavior like canceling mid-swing attacks or moving during heavy abilities.
 */

import type { AnimationAction } from '@/network/protocol/types';

export type LockType = 'hard' | 'soft';

export interface AbilityLockConfig {
  lockDuration: number;           // ms character is locked in animation
  lockType: LockType;             // hard = can't be interrupted, soft = movement cancels
  windupDuration?: number;        // ms before damage applies (can be interrupted during this)
  recoveryDuration?: number;      // ms after damage before next action
  allowMovementDuring: boolean;   // Can move while performing (e.g., ranged auto-attack)
  rootDuration?: number;          // ms character is rooted in place
}

export interface CharacterAnimationState {
  currentAction: AnimationAction;
  lockExpiresAt?: number;         // Timestamp when lock ends
  lockType?: LockType;            // Type of current lock
  isInterruptible: boolean;       // Can be interrupted right now
  windupEndsAt?: number;          // When windup phase ends (becomes uninterruptible)
}

/**
 * Default ability lock configurations
 */
export const ABILITY_LOCKS: Record<string, AbilityLockConfig> = {
  // Auto-attack - short soft lock
  'basic_attack': {
    lockDuration: 600,              // 0.6s swing
    lockType: 'soft',               // Movement cancels
    windupDuration: 200,            // 0.2s windup (can interrupt)
    allowMovementDuring: false,
  },
  
  // Heavy melee ability - hard lock with longer windup
  'crushing_blow': {
    lockDuration: 1200,             // 1.2s total
    lockType: 'hard',               // Can't cancel mid-swing
    windupDuration: 400,            // 0.4s windup (can interrupt during this)
    allowMovementDuring: false,
  },
  
  // Channeled spell - interruptible by movement
  'fireball': {
    lockDuration: 2000,             // 2s channel
    lockType: 'soft',               // Movement interrupts
    allowMovementDuring: false,
  },
  
  // Instant cast - no lock
  'shield_bash': {
    lockDuration: 0,                // Instant
    lockType: 'soft',
    allowMovementDuring: true,      // Can move immediately after
  },
  
  // Ranged attack - can move while attacking
  'shoot_arrow': {
    lockDuration: 800,              // 0.8s draw + release
    lockType: 'soft',
    windupDuration: 500,            // 0.5s draw (can interrupt)
    allowMovementDuring: true,      // Can move while shooting
  },
};

/**
 * Animation Lock Manager
 */
export class AnimationLockSystem {
  private animationStates: Map<string, CharacterAnimationState> = new Map();

  /**
   * Get character's current animation state
   */
  getState(characterId: string): CharacterAnimationState {
    return this.animationStates.get(characterId) || {
      currentAction: 'idle',
      isInterruptible: true,
    };
  }

  /**
   * Set character's animation state with lock
   */
  setState(
    characterId: string,
    action: AnimationAction,
    lockConfig?: AbilityLockConfig
  ): void {
    const now = Date.now();
    
    if (!lockConfig) {
      // No lock - just set the action
      this.animationStates.set(characterId, {
        currentAction: action,
        isInterruptible: true,
      });
      return;
    }

    const state: CharacterAnimationState = {
      currentAction: action,
      lockExpiresAt: now + lockConfig.lockDuration,
      lockType: lockConfig.lockType,
      isInterruptible: lockConfig.windupDuration ? true : false,
      windupEndsAt: lockConfig.windupDuration ? now + lockConfig.windupDuration : undefined,
    };

    this.animationStates.set(characterId, state);
  }

  /**
   * Check if character can perform a new action
   */
  canPerformAction(characterId: string): { allowed: boolean; reason?: string } {
    const state = this.getState(characterId);
    const now = Date.now();

    // No active lock
    if (!state.lockExpiresAt || now >= state.lockExpiresAt) {
      return { allowed: true };
    }

    // Check if still in interruptible windup phase
    if (state.isInterruptible && state.windupEndsAt && now < state.windupEndsAt) {
      return { allowed: true }; // Can interrupt during windup
    }

    // Hard lock - can't interrupt
    if (state.lockType === 'hard') {
      return { allowed: false, reason: 'Locked in current action' };
    }

    // Soft lock - can interrupt but at a cost
    return { allowed: true }; // Soft locks can be interrupted
  }

  /**
   * Check if character can move
   */
  canMove(characterId: string): { allowed: boolean; reason?: string } {
    const state = this.getState(characterId);
    const now = Date.now();

    // No active lock
    if (!state.lockExpiresAt || now >= state.lockExpiresAt) {
      return { allowed: true };
    }

    // Hard lock - can't move
    if (state.lockType === 'hard') {
      // Check if still in windup (can interrupt)
      if (state.isInterruptible && state.windupEndsAt && now < state.windupEndsAt) {
        return { allowed: true }; // Can move during windup
      }
      return { allowed: false, reason: 'Locked in current action' };
    }

    // Soft lock - movement interrupts action
    return { allowed: true }; // Will cancel current action
  }

  /**
   * Interrupt current action (e.g., by movement)
   */
  interruptAction(characterId: string, _reason: string = 'interrupted'): boolean {
    const state = this.getState(characterId);
    const now = Date.now();

    // No active lock
    if (!state.lockExpiresAt || now >= state.lockExpiresAt) {
      return false; // Nothing to interrupt
    }

    // Can't interrupt hard locks outside windup
    if (state.lockType === 'hard') {
      if (!state.isInterruptible || !state.windupEndsAt || now >= state.windupEndsAt) {
        return false; // Can't interrupt
      }
    }

    // Cancel the action
    this.animationStates.set(characterId, {
      currentAction: 'idle',
      isInterruptible: true,
    });

    return true; // Action was interrupted
  }

  /**
   * Update animation state (call each tick to check for lock expiry)
   */
  update(): void {
    const now = Date.now();

    for (const [characterId, state] of this.animationStates) {
      // Check if lock expired
      if (state.lockExpiresAt && now >= state.lockExpiresAt) {
        this.animationStates.set(characterId, {
          currentAction: 'idle',
          isInterruptible: true,
        });
      }
      // Check if windup ended (becomes uninterruptible)
      else if (state.windupEndsAt && now >= state.windupEndsAt) {
        state.isInterruptible = false;
      }
    }
  }

  /**
   * Get ability lock configuration by ability ID
   */
  getAbilityLockConfig(abilityId: string): AbilityLockConfig | undefined {
    return ABILITY_LOCKS[abilityId];
  }

  /**
   * Clear state when character logs out
   */
  clearState(characterId: string): void {
    this.animationStates.delete(characterId);
  }

  /**
   * Get all animation states (for debugging)
   */
  getAllStates(): Map<string, CharacterAnimationState> {
    return new Map(this.animationStates);
  }
}
