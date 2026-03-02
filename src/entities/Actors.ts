/**
 * Entity type stubs — thin wrappers around Living for now.
 * Expand each class as systems need more specific data.
 */

import { Living } from './Living';
import type { Vector3 } from './PhysicsObject';
import type { MovementProfile } from './Living';

// ── Player ────────────────────────────────────────────────────────────────────

export class Player extends Living {
  socketId: string;
  accountId: string;
  zoneId: string;
  isMachine: boolean;

  constructor(id: string, name: string, position: Vector3, opts: {
    socketId: string;
    accountId: string;
    zoneId: string;
    isMachine?: boolean;
    isAlive?: boolean;
    currentHealth?: number;
    maxHealth?: number;
    heading?: number;
    movementProfile?: MovementProfile;
  }) {
    super(id, name, position, opts);
    this.socketId  = opts.socketId;
    this.accountId = opts.accountId;
    this.zoneId    = opts.zoneId;
    this.isMachine = opts.isMachine ?? false;
  }
}

// ── Companion (friendly NPC with optional socket for AI clients) ──────────────

export class Companion extends Living {
  tag?: string;
  socketId?: string;
  description: string;

  constructor(id: string, name: string, position: Vector3, opts: {
    tag?: string;
    socketId?: string;
    description?: string;
    isAlive?: boolean;
    currentHealth?: number;
    maxHealth?: number;
    heading?: number;
    movementProfile?: MovementProfile;
  } = {}) {
    super(id, name, position, opts);
    this.tag         = opts.tag;
    this.socketId    = opts.socketId;
    this.description = opts.description ?? '';
  }
}

// ── Mob (hostile or neutral AI creature) ─────────────────────────────────────

export class Mob extends Living {
  tag?: string;
  level: number;
  faction?: string;
  description: string;

  constructor(id: string, name: string, position: Vector3, opts: {
    tag?: string;
    level?: number;
    faction?: string;
    description?: string;
    isAlive?: boolean;
    currentHealth?: number;
    maxHealth?: number;
    heading?: number;
    movementProfile?: MovementProfile;
  } = {}) {
    super(id, name, position, opts);
    this.tag         = opts.tag;
    this.level       = opts.level   ?? 1;
    this.faction     = opts.faction;
    this.description = opts.description ?? '';
  }
}

// ── NPC (non-hostile interactive character) ───────────────────────────────────

export class NPC extends Living {
  description: string;
  interactive: boolean;

  constructor(id: string, name: string, position: Vector3, opts: {
    description?: string;
    interactive?: boolean;
    isAlive?: boolean;
    currentHealth?: number;
    maxHealth?: number;
    heading?: number;
    movementProfile?: MovementProfile;
  } = {}) {
    super(id, name, position, opts);
    this.description = opts.description ?? '';
    this.interactive = opts.interactive ?? true;
  }
}
