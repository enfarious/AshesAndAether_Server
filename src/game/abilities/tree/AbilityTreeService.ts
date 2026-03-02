/**
 * Ability Tree Service
 *
 * Handles unlock and slot operations, persisting results back to the DB.
 *
 * All mutation methods return a result object (never throw) so the caller
 * can forward the message directly to the client.
 */

import { prisma } from '@/database/DatabaseService';
import type { Prisma } from '@prisma/client';
import type {
  AbilityNodeId,
  UnlockedAbilities,
  ActiveLoadout,
  PassiveLoadout,
} from './types';
import {
  parseUnlockedAbilities,
  parseActiveLoadout,
  parsePassiveLoadout,
  ACTIVE_SLOTS,
  PASSIVE_SLOTS,
  CAPSTONE_SLOT,
} from './types';
import { canUnlock, canSlotActive, canSlotPassive, getNode } from './AbilityTreeValidator';
import { ACTIVE_WEB } from './ActiveWeb';
import { PASSIVE_WEB } from './PassiveWeb';

// ─────────────────────────────────────────
// Read helpers
// ─────────────────────────────────────────

export interface AbilityState {
  unlocked:       UnlockedAbilities;
  activeLoadout:  ActiveLoadout;
  passiveLoadout: PassiveLoadout;
  availableAp:    number;
  completedFeats: string[];
}

export async function loadAbilityState(characterId: string): Promise<AbilityState | null> {
  const char = await prisma.character.findUnique({
    where: { id: characterId },
    select: {
      abilityPoints:    true,
      unlockedAbilities: true,
      activeLoadout:    true,
      passiveLoadout:   true,
      unlockedFeats:    true,
    },
  });
  if (!char) return null;

  return {
    availableAp:    char.abilityPoints,
    unlocked:       parseUnlockedAbilities(char.unlockedAbilities),
    activeLoadout:  parseActiveLoadout(char.activeLoadout),
    passiveLoadout: parsePassiveLoadout(char.passiveLoadout),
    completedFeats: Array.isArray(char.unlockedFeats)
      ? (char.unlockedFeats as string[])
      : [],
  };
}

// ─────────────────────────────────────────
// Unlock
// ─────────────────────────────────────────

export interface UnlockAbilityResult {
  success: boolean;
  message: string;
  /** Updated AP remaining (only present on success). */
  remainingAp?: number;
}

export async function unlockAbility(
  characterId: string,
  nodeId:       AbilityNodeId,
): Promise<UnlockAbilityResult> {
  const state = await loadAbilityState(characterId);
  if (!state) {
    return { success: false, message: 'Character not found.' };
  }

  const node = getNode(nodeId);
  if (!node) {
    return { success: false, message: `Unknown ability: ${nodeId}` };
  }

  const validation = canUnlock({
    nodeId,
    unlocked:       state.unlocked,
    availableAp:    state.availableAp,
    completedFeats: state.completedFeats,
  });

  if (!validation.ok) {
    return { success: false, message: validation.reason! };
  }

  // Apply the unlock.
  const nextUnlocked: UnlockedAbilities = {
    activeNodes:  [...state.unlocked.activeNodes],
    passiveNodes: [...state.unlocked.passiveNodes],
    apSpent:      state.unlocked.apSpent + node.cost,
  };

  if (node.web === 'active') {
    nextUnlocked.activeNodes.push(nodeId);
  } else {
    nextUnlocked.passiveNodes.push(nodeId);
  }

  const remainingAp = state.availableAp - node.cost;

  await prisma.character.update({
    where: { id: characterId },
    data: {
      abilityPoints:     remainingAp,
      unlockedAbilities: nextUnlocked as unknown as Prisma.InputJsonObject,
    },
  });

  return {
    success:     true,
    message:     `Unlocked: ${node.name} (${node.cost} AP spent — ${remainingAp} AP remaining).`,
    remainingAp,
  };
}

// ─────────────────────────────────────────
// Slot: active
// ─────────────────────────────────────────

export interface SlotResult {
  success: boolean;
  message: string;
}

export async function slotActiveAbility(
  characterId: string,
  /** 1-based slot number as the player types it. */
  slotNumber:  number,
  /** Node ID to place, or empty string to clear. */
  nodeId:      AbilityNodeId | '',
): Promise<SlotResult> {
  const slotIndex = slotNumber - 1;  // convert to 0-based

  const state = await loadAbilityState(characterId);
  if (!state) return { success: false, message: 'Character not found.' };

  if (slotIndex < 0 || slotIndex >= ACTIVE_SLOTS) {
    return { success: false, message: `Active slots are 1–${ACTIVE_SLOTS}.` };
  }

  // Allow clearing a slot.
  if (!nodeId) {
    const nextSlots = [...state.activeLoadout.slots];
    nextSlots[slotIndex] = null;
    await prisma.character.update({
      where: { id: characterId },
      data: { activeLoadout: { slots: nextSlots } as unknown as Prisma.InputJsonObject },
    });
    return { success: true, message: `Active slot ${slotNumber} cleared.` };
  }

  const validation = canSlotActive({ nodeId, slotIndex, unlocked: state.unlocked });
  if (!validation.ok) return { success: false, message: validation.reason! };

  const node = getNode(nodeId)!;
  const nextSlots = [...state.activeLoadout.slots];
  nextSlots[slotIndex] = nodeId;

  await prisma.character.update({
    where: { id: characterId },
    data: { activeLoadout: { slots: nextSlots } as unknown as Prisma.InputJsonObject },
  });

  const slotLabel = slotIndex === CAPSTONE_SLOT ? 'capstone slot' : `slot ${slotNumber}`;
  return { success: true, message: `${node.name} placed in active ${slotLabel}.` };
}

// ─────────────────────────────────────────
// Slot: passive
// ─────────────────────────────────────────

export async function slotPassiveAbility(
  characterId: string,
  slotNumber:  number,
  nodeId:      AbilityNodeId | '',
): Promise<SlotResult> {
  const slotIndex = slotNumber - 1;

  const state = await loadAbilityState(characterId);
  if (!state) return { success: false, message: 'Character not found.' };

  if (slotIndex < 0 || slotIndex >= PASSIVE_SLOTS) {
    return { success: false, message: `Passive slots are 1–${PASSIVE_SLOTS}.` };
  }

  if (!nodeId) {
    const nextSlots = [...state.passiveLoadout.slots];
    nextSlots[slotIndex] = null;
    await prisma.character.update({
      where: { id: characterId },
      data: { passiveLoadout: { slots: nextSlots } as unknown as Prisma.InputJsonObject },
    });
    return { success: true, message: `Passive slot ${slotNumber} cleared.` };
  }

  const validation = canSlotPassive({ nodeId, slotIndex, unlocked: state.unlocked });
  if (!validation.ok) return { success: false, message: validation.reason! };

  const node = getNode(nodeId)!;
  const nextSlots = [...state.passiveLoadout.slots];
  nextSlots[slotIndex] = nodeId;

  await prisma.character.update({
    where: { id: characterId },
    data: { passiveLoadout: { slots: nextSlots } as unknown as Prisma.InputJsonObject },
  });

  return { success: true, message: `${node.name} placed in passive slot ${slotNumber}.` };
}

// ─────────────────────────────────────────
// View helpers (for the /abilities command)
// ─────────────────────────────────────────

export interface AbilitySummary {
  availableAp:      number;
  apSpent:          number;
  unlockedActive:   number;
  unlockedPassive:  number;
  activeLoadout:    (string | null)[];  // node names (or null)
  passiveLoadout:   (string | null)[];
}

export async function getAbilitySummary(characterId: string): Promise<AbilitySummary | null> {
  const state = await loadAbilityState(characterId);
  if (!state) return null;

  const resolveName = (id: AbilityNodeId | null): string | null => {
    if (!id) return null;
    return getNode(id)?.name ?? id;
  };

  return {
    availableAp:     state.availableAp,
    apSpent:         state.unlocked.apSpent,
    unlockedActive:  state.unlocked.activeNodes.length,
    unlockedPassive: state.unlocked.passiveNodes.length,
    activeLoadout:   state.activeLoadout.slots.map(resolveName),
    passiveLoadout:  state.passiveLoadout.slots.map(resolveName),
  };
}

export interface NodeInfo {
  id:          string;
  name:        string;
  description: string;
  web:         string;
  sector:      string;
  tier:        number;
  cost:        number;
  unlocked:    boolean;
  adjacentTo:  string[];   // names
  effect?:     string;     // one-liner effect description
  questGate?:  string;
}

export async function getNodeInfo(
  characterId: string,
  nodeId:      string,
): Promise<NodeInfo | null> {
  const node = getNode(nodeId);
  if (!node) return null;

  const state = await loadAbilityState(characterId);
  const unlockedList = node.web === 'active'
    ? (state?.unlocked.activeNodes ?? [])
    : (state?.unlocked.passiveNodes ?? []);

  return {
    id:          node.id,
    name:        node.name,
    description: node.description,
    web:         node.web,
    sector:      node.sector,
    tier:        node.tier,
    cost:        node.cost,
    unlocked:    unlockedList.includes(nodeId),
    adjacentTo:  node.adjacentTo.map(adjId => getNode(adjId)?.name ?? adjId),
    effect:      node.activeEffect?.description,
    questGate:   node.questGate,
  };
}

/** Return all nodes in a given web as info records. */
export async function listWebNodes(
  characterId: string,
  web: 'active' | 'passive',
): Promise<NodeInfo[]> {
  const nodes = web === 'active' ? ACTIVE_WEB : PASSIVE_WEB;
  const state = await loadAbilityState(characterId);
  const unlockedList = web === 'active'
    ? (state?.unlocked.activeNodes ?? [])
    : (state?.unlocked.passiveNodes ?? []);

  return nodes.map(node => ({
    id:          node.id,
    name:        node.name,
    description: node.description,
    web:         node.web,
    sector:      node.sector,
    tier:        node.tier,
    cost:        node.cost,
    unlocked:    unlockedList.includes(node.id),
    adjacentTo:  node.adjacentTo.map(adjId => getNode(adjId)?.name ?? adjId),
    effect:      node.activeEffect?.description,
    questGate:   node.questGate,
  }));
}
