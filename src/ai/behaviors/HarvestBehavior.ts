/**
 * Default Harvest Behavior — the intentionally-inefficient baseline tree.
 *
 * This tree is deliberately dumb:
 * - Moves to NEAREST plant (not best yield)
 * - Ignores yield multiplier (doesn't prefer flowering over mature)
 * - No inventory check (wastes a harvest if full)
 * - No path optimization (no TSP)
 * - No tool check
 *
 * Players write better trees via `/companion task`.
 *
 * Available conditions:
 *   nearHarvestable  — Any harvestable plant within range
 *   inventoryNotFull — Inventory has room
 *   hasItem          — Check inventory for item by tag
 *   healthAbove      — HP ratio above threshold
 *
 * Available actions:
 *   /harvest — Harvest the nearest harvestable plant
 *   /move    — Move to a target (args: { target: 'nearestHarvestablePlant' })
 *   /tell    — Say something (args: { message: string })
 *   /stop    — Stop current task
 */

import type { BehaviorNode } from './BehaviorTreeExecutor';

/**
 * The default harvest tree. Assigned by `/companion harvest`.
 *
 * Loop: check for plants → move to nearest → harvest → repeat.
 * Wraps in a top-level sequence that re-runs each tick.
 */
export const DEFAULT_HARVEST_TREE: BehaviorNode = {
  type: 'sequence',
  children: [
    { type: 'condition', condition: 'nearHarvestable' },
    { type: 'action', action: '/move', args: { target: 'nearestHarvestablePlant' } },
    { type: 'action', action: '/harvest' },
  ],
};

/** Allowed actions for TASKED mode (no combat commands). */
export const ALLOWED_ACTIONS = ['/harvest', '/move', '/tell', '/stop'];

/** Allowed conditions for behavior trees. */
export const ALLOWED_CONDITIONS = ['nearHarvestable', 'inventoryNotFull', 'hasItem', 'healthAbove'];
