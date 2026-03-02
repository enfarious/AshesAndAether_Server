/**
 * Ability Tree Validator
 *
 * Enforces all unlock rules:
 *   1. Adjacency  — at least one already-unlocked neighbor, OR the node is T1
 *                   (T1 nodes are always reachable — they form the inner ring).
 *   2. Depth gate — global previous-tier count (see requiredPreviousTierCount).
 *   3. Quest gate — T4 capstones require a specific feat in the character's
 *                   unlockedFeats array.
 *   4. AP budget  — character must have enough remaining ability points.
 *   5. Already unlocked — cannot unlock the same node twice.
 *   6. Slot rules — T4 nodes only allowed in CAPSTONE_SLOT (slot index 7).
 *                   T4 nodes can only exist in the active web (no T4 passives).
 */

import type { AbilityNode, UnlockResult, UnlockedAbilities } from './types';
import { requiredPreviousTierCount, CAPSTONE_SLOT, ACTIVE_SLOTS, PASSIVE_SLOTS } from './types';
import { ACTIVE_WEB_MAP } from './ActiveWeb';
import { PASSIVE_WEB_MAP } from './PassiveWeb';

/** Unified lookup across both webs. */
export function getNode(nodeId: string): AbilityNode | undefined {
  return ACTIVE_WEB_MAP.get(nodeId) ?? PASSIVE_WEB_MAP.get(nodeId);
}

// ─────────────────────────────────────────
// Unlock validation
// ─────────────────────────────────────────

export interface UnlockContext {
  /** The node the character wants to unlock. */
  nodeId:          string;
  /** Current unlocked state from DB. */
  unlocked:        UnlockedAbilities;
  /** How many ability points the character currently has (unspent). */
  availableAp:     number;
  /** Character's completed feats / quests (for capstone gate). */
  completedFeats?: string[];
}

export function canUnlock(ctx: UnlockContext): UnlockResult {
  const { nodeId, unlocked, availableAp, completedFeats = [] } = ctx;

  const node = getNode(nodeId);
  if (!node) {
    return { ok: false, reason: `Unknown ability node: ${nodeId}` };
  }

  // 1. Already unlocked?
  const unlockedList = node.web === 'active' ? unlocked.activeNodes : unlocked.passiveNodes;
  if (unlockedList.includes(nodeId)) {
    return { ok: false, reason: `You have already unlocked ${node.name}.` };
  }

  // 2. T4 only exists in the active web.
  if (node.tier === 4 && node.web !== 'active') {
    return { ok: false, reason: 'Capstone abilities only exist in the active web.' };
  }

  // 3. AP budget.
  if (availableAp < node.cost) {
    return {
      ok: false,
      reason: `Not enough ability points — ${node.name} costs ${node.cost} AP but you only have ${availableAp}.`,
    };
  }

  // 4. Quest / feat gate (T4 capstones).
  if (node.questGate && !completedFeats.includes(node.questGate)) {
    return {
      ok: false,
      reason: `${node.name} requires the feat "${node.questGate}" before it can be unlocked.`,
    };
  }

  // 5. Adjacency check.
  //    T1 nodes are always reachable (inner ring — no prior nodes needed).
  if (node.tier > 1) {
    const hasUnlockedNeighbor = node.adjacentTo.some(adjId => {
      // Only count neighbors from the same web.
      return unlockedList.includes(adjId);
    });
    if (!hasUnlockedNeighbor) {
      return {
        ok: false,
        reason: `${node.name} is not reachable yet — unlock an adjacent node first.`,
      };
    }
  }

  // 6. Depth gate (global previous-tier count, per web).
  if (node.tier > 1) {
    const prevTier = (node.tier - 1) as 1 | 2 | 3;
    const prevTierNodes = unlockedList.filter(id => {
      const n = getNode(id);
      return n && n.web === node.web && n.tier === prevTier;
    });
    const alreadyInThisTier = unlockedList.filter(id => {
      const n = getNode(id);
      return n && n.web === node.web && n.tier === node.tier;
    });
    const required = requiredPreviousTierCount(alreadyInThisTier.length);
    if (prevTierNodes.length < required) {
      return {
        ok: false,
        reason:
          `You need at least ${required} unlocked Tier ${prevTier} ability${required > 1 ? 'ies' : ''} ` +
          `to unlock a Tier ${node.tier} ability (you have ${prevTierNodes.length}).`,
      };
    }
  }

  return { ok: true };
}

// ─────────────────────────────────────────
// Slot validation
// ─────────────────────────────────────────

export interface SlotActiveContext {
  nodeId:    string;
  slotIndex: number;    // 0-based
  unlocked:  UnlockedAbilities;
}

export function canSlotActive(ctx: SlotActiveContext): UnlockResult {
  const { nodeId, slotIndex, unlocked } = ctx;

  if (slotIndex < 0 || slotIndex >= ACTIVE_SLOTS) {
    return { ok: false, reason: `Invalid active slot — must be 1–${ACTIVE_SLOTS}.` };
  }

  // null / empty means clear slot
  if (!nodeId) return { ok: true };

  const node = getNode(nodeId);
  if (!node) return { ok: false, reason: `Unknown ability: ${nodeId}` };

  if (node.web !== 'active') {
    return { ok: false, reason: `${node.name} is a passive ability — use a passive slot.` };
  }

  if (!unlocked.activeNodes.includes(nodeId)) {
    return { ok: false, reason: `You haven't unlocked ${node.name} yet.` };
  }

  // T4 capstones may ONLY go in the capstone slot.
  if (node.tier === 4 && slotIndex !== CAPSTONE_SLOT) {
    return {
      ok: false,
      reason: `${node.name} is a capstone ability and can only be placed in slot ${CAPSTONE_SLOT + 1}.`,
    };
  }

  // Non-capstone abilities may NOT go in the capstone slot… unless they choose to (design allows it).
  // The spec says slot 8 "also allows T1–T3 so you can choose to run without an ult."
  // No restriction needed here — any T1–T3 active can go in any slot including the capstone slot.

  return { ok: true };
}

export interface SlotPassiveContext {
  nodeId:    string;
  slotIndex: number;   // 0-based
  unlocked:  UnlockedAbilities;
}

export function canSlotPassive(ctx: SlotPassiveContext): UnlockResult {
  const { nodeId, slotIndex, unlocked } = ctx;

  if (slotIndex < 0 || slotIndex >= PASSIVE_SLOTS) {
    return { ok: false, reason: `Invalid passive slot — must be 1–${PASSIVE_SLOTS}.` };
  }

  if (!nodeId) return { ok: true };

  const node = getNode(nodeId);
  if (!node) return { ok: false, reason: `Unknown ability: ${nodeId}` };

  if (node.web !== 'passive') {
    return { ok: false, reason: `${node.name} is an active ability — use an active slot.` };
  }

  if (!unlocked.passiveNodes.includes(nodeId)) {
    return { ok: false, reason: `You haven't unlocked ${node.name} yet.` };
  }

  return { ok: true };
}
