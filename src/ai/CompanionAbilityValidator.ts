/**
 * Companion Ability Validator
 *
 * Validates companion loadout operations. Similar to AbilityTreeValidator
 * but scoped to companion-specific rules:
 *  - Companions share the owner's unlocked ability pool
 *  - No T4 capstones (companions don't get ULTs)
 *  - 8 active + 8 passive slots (all T1-T3)
 */

import type { UnlockedAbilities, UnlockResult } from '@/game/abilities/tree/types';
import { ACTIVE_SLOTS, PASSIVE_SLOTS } from '@/game/abilities/tree/types';
import { getNode } from '@/game/abilities/tree/AbilityTreeValidator';

/**
 * Validate slotting an active ability for a companion.
 * @param nodeId    The ability node to slot
 * @param slotIndex 0-based slot index (0-7)
 * @param ownerUnlocked The owner player's unlocked abilities
 */
export function canCompanionSlotActive(
  nodeId: string,
  slotIndex: number,
  ownerUnlocked: UnlockedAbilities,
): UnlockResult {
  if (slotIndex < 0 || slotIndex >= ACTIVE_SLOTS) {
    return { ok: false, reason: `Invalid slot — must be 1–${ACTIVE_SLOTS}.` };
  }

  const node = getNode(nodeId);
  if (!node) {
    return { ok: false, reason: `Unknown ability node: ${nodeId}` };
  }

  if (node.web !== 'active') {
    return { ok: false, reason: `${node.name} is not an active ability.` };
  }

  if (node.tier >= 4) {
    return { ok: false, reason: `Companions cannot use capstone abilities (T4).` };
  }

  if (!ownerUnlocked.activeNodes.includes(nodeId)) {
    return { ok: false, reason: `${node.name} is not unlocked by the owner.` };
  }

  return { ok: true };
}

/**
 * Validate slotting a passive ability for a companion.
 * @param nodeId    The passive node to slot
 * @param slotIndex 0-based slot index (0-7)
 * @param ownerUnlocked The owner player's unlocked abilities
 */
export function canCompanionSlotPassive(
  nodeId: string,
  slotIndex: number,
  ownerUnlocked: UnlockedAbilities,
): UnlockResult {
  if (slotIndex < 0 || slotIndex >= PASSIVE_SLOTS) {
    return { ok: false, reason: `Invalid slot — must be 1–${PASSIVE_SLOTS}.` };
  }

  const node = getNode(nodeId);
  if (!node) {
    return { ok: false, reason: `Unknown ability node: ${nodeId}` };
  }

  if (node.web !== 'passive') {
    return { ok: false, reason: `${node.name} is not a passive ability.` };
  }

  // Passive web only goes to T3, but guard anyway
  if (node.tier >= 4) {
    return { ok: false, reason: `Companions cannot use T4 passives.` };
  }

  if (!ownerUnlocked.passiveNodes.includes(nodeId)) {
    return { ok: false, reason: `${node.name} is not unlocked by the owner.` };
  }

  return { ok: true };
}
