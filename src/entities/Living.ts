/**
 * Living — a Container that is alive (or was once alive).
 * Base for Player, Companion, NPC, Mob, Wildlife.
 */

import { Container } from './Container';
import type { Vector3 } from './PhysicsObject';

export type MovementProfile = 'terrestrial' | 'amphibious' | 'aquatic';

export class Living extends Container {
  isAlive: boolean;
  currentHealth: number;
  maxHealth: number;
  heading: number;                        // 0-360°
  movementProfile: MovementProfile;

  constructor(
    id: string,
    name: string,
    position: Vector3,
    opts: {
      isAlive?: boolean;
      currentHealth?: number;
      maxHealth?: number;
      heading?: number;
      movementProfile?: MovementProfile;
      bPhysicsEnabled?: boolean;
    } = {}
  ) {
    super(id, name, position, opts.bPhysicsEnabled ?? true);
    this.isAlive        = opts.isAlive        ?? true;
    this.maxHealth      = opts.maxHealth      ?? 100;
    this.currentHealth  = opts.currentHealth  ?? this.maxHealth;
    this.heading        = opts.heading        ?? 0;
    this.movementProfile = opts.movementProfile ?? 'terrestrial';
  }
}
