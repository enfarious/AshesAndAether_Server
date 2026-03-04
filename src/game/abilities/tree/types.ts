/**
 * Ability Tree — Core Types
 *
 * Two independent webs (Active / Passive) sharing one AP pool.
 *
 * ACTIVE WEB  — 4 tiers, 36 nodes total
 *   T1: 6 nodes (1/sector) — 1 AP each
 *   T2: 12 nodes (2/sector) — 2 AP each
 *   T3: 12 nodes (2/sector) — 3 AP each
 *   T4: 6 capstone nodes (1/sector) — 5 AP each, quest-gated, 15-min CD
 *
 * PASSIVE WEB — 3 tiers, 30 nodes total
 *   T1: 6 nodes (1/sector) — 1 AP each
 *   T2: 12 nodes (2/sector) — 2 AP each
 *   T3: 12 nodes (2/sector) — 3 AP each
 *
 * SECTORS (60° each, clockwise from top)
 *   tank | phys | control | magic | healer | support
 *
 * Node ID convention
 *   T1 / T4 : `{web}_{sector}_t{tier}`          e.g. active_tank_t1
 *   T2 / T3 : `{web}_{sector}_t{tier}a` / `…b`  e.g. active_tank_t2a
 */

// ─────────────────────────────────────────
// Primitive enums
// ─────────────────────────────────────────

export type SectorId = 'tank' | 'phys' | 'control' | 'magic' | 'healer' | 'support';
export type WebId    = 'active' | 'passive';
export type NodeTier = 1 | 2 | 3 | 4;

export type AbilityNodeId = string;

// ─────────────────────────────────────────
// AP costs
// ─────────────────────────────────────────

export const TIER_COST: Record<NodeTier, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 5,
};

// ─────────────────────────────────────────
// Loadout constants
// ─────────────────────────────────────────

/** Total active slots (0-indexed: 0–7). */
export const ACTIVE_SLOTS  = 8;

/** Total passive slots (0-indexed: 0–7). */
export const PASSIVE_SLOTS = 8;

/**
 * Slot index (0-based) that may hold a T4 capstone in the active loadout.
 * All other slots (0–6) only accept T1–T3.
 */
export const CAPSTONE_SLOT = 7;

// ─────────────────────────────────────────
// Depth-gate rule
// ─────────────────────────────────────────

/**
 * How many nodes of the PREVIOUS tier must already be globally unlocked
 * (across all sectors / both webs for that tier) before a node in the
 * CURRENT tier can be purchased.
 *
 *   already unlocked in this tier → required count in previous tier
 *   0                             → 1
 *   1 – 2                         → 2
 *   3 – 5                         → 3
 *   (6+ should not happen for T1, guard as 3)
 *
 * @param alreadyUnlockedInTier  Count of nodes already unlocked in the
 *                               same tier (same web) at time of purchase.
 */
export function requiredPreviousTierCount(alreadyUnlockedInTier: number): number {
  if (alreadyUnlockedInTier === 0) return 1;
  if (alreadyUnlockedInTier <= 2)  return 2;
  return 3;
}

// ─────────────────────────────────────────
// Effect types
// ─────────────────────────────────────────

export interface StatBonus {
  strength?:              number;
  vitality?:              number;
  dexterity?:             number;
  agility?:               number;
  intelligence?:          number;
  wisdom?:                number;
  maxHp?:                 number;
  maxStamina?:            number;
  maxMana?:               number;
  attackRating?:          number;
  defenseRating?:         number;
  physicalAccuracy?:      number;
  evasion?:               number;
  criticalHitChance?:     number;
  // T1+ passive support
  damageAbsorption?:      number;
  magicAttack?:           number;
  magicDefense?:          number;
  magicAccuracy?:         number;
  magicEvasion?:          number;
  magicAbsorption?:       number;
  manaRegen?:             number;
  glancingBlowChance?:    number;
  penetratingBlowChance?: number;
  deflectedBlowChance?:   number;
}

/** Descriptor for what an active node does when activated. */
export interface ActiveEffect {
  /** One-liner shown in UI / chat. */
  description:  string;
  targetType?:  'self' | 'enemy' | 'ally' | 'aoe';
  damageType?:  'physical' | 'magic' | 'fire' | 'ice' | 'lightning' | 'poison' | 'holy' | 'dark';
  range?:       number;  // metres
  aoeRadius?:   number;  // metres
  staminaCost?: number;
  manaCost?:    number;
  /** Base cooldown in seconds (0 = no cooldown). */
  cooldown?:    number;
  castTime?:    number;  // seconds, 0 = instant
  /** Status-effect IDs applied by this ability (resolved at runtime). */
  statusEffects?: string[];
  /**
   * T4 capstone descriptor.  Server matches `mechanicKey` to execute
   * the special mechanic; `flavour` surfaces in UI.
   */
  capstone?: {
    flavour:      string;
    mechanicKey:  string;
    /** Duration/buff window in seconds. */
    duration?:    number;
  };
}

// ─────────────────────────────────────────
// Node definition
// ─────────────────────────────────────────

export interface AbilityNode {
  id:           AbilityNodeId;
  web:          WebId;
  sector:       SectorId;
  tier:         NodeTier;
  name:         string;
  description:  string;
  /** AP cost to unlock. */
  cost:         number;
  /** IDs of directly adjacent nodes in the web graph. */
  adjacentTo:   AbilityNodeId[];
  /** Active-web nodes have an active effect; passive nodes omit this. */
  activeEffect?: ActiveEffect;
  /** Passive-web nodes (and some active utility nodes) may grant stat bonuses. */
  statBonus?:   StatBonus;
  /**
   * T4 capstones only — must appear in `character.unlockedFeats` (or `questProgress`)
   * before this node can be purchased.
   */
  questGate?:   string;
}

// ─────────────────────────────────────────
// Unlock / slot validation result
// ─────────────────────────────────────────

export interface UnlockResult {
  ok:       boolean;
  reason?:  string;
}

// ─────────────────────────────────────────
// DB-persisted shapes (stored as Json fields)
// ─────────────────────────────────────────

/**
 * Stored in `Character.unlockedAbilities` JSON field.
 * Replaces the legacy `[]` default on first unlock.
 */
export interface UnlockedAbilities {
  /** Unlocked node IDs from the active web. */
  activeNodes:  AbilityNodeId[];
  /** Unlocked node IDs from the passive web. */
  passiveNodes: AbilityNodeId[];
  /** Total AP spent across both webs (redundant but convenient). */
  apSpent:      number;
}

/**
 * Stored in `Character.activeLoadout` JSON field.
 * 8 slots (index 0–7).  Slot 7 is the capstone slot (accepts T1–T4).
 * Others accept T1–T3 only.
 */
export interface ActiveLoadout {
  slots: (AbilityNodeId | null)[];
}

/**
 * Stored in `Character.passiveLoadout` JSON field.
 * 8 slots (index 0–7).  All slots accept T1–T3 passive nodes.
 */
export interface PassiveLoadout {
  slots: (AbilityNodeId | null)[];
}

// ─────────────────────────────────────────
// Helpers for loading legacy [] defaults
// ─────────────────────────────────────────

/** Parse raw Json field into UnlockedAbilities (handles legacy `[]`). */
export function parseUnlockedAbilities(raw: unknown): UnlockedAbilities {
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    'activeNodes' in raw
  ) {
    return raw as UnlockedAbilities;
  }
  return { activeNodes: [], passiveNodes: [], apSpent: 0 };
}

/** Parse raw Json field into an ActiveLoadout (handles legacy `[]`). */
export function parseActiveLoadout(raw: unknown): ActiveLoadout {
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    'slots' in raw
  ) {
    return raw as ActiveLoadout;
  }
  return { slots: Array(ACTIVE_SLOTS).fill(null) };
}

/** Parse raw Json field into a PassiveLoadout (handles legacy `[]`). */
export function parsePassiveLoadout(raw: unknown): PassiveLoadout {
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    'slots' in raw
  ) {
    return raw as PassiveLoadout;
  }
  return { slots: Array(PASSIVE_SLOTS).fill(null) };
}
