/**
 * Condition Evaluator — evaluates named predicates against world state.
 *
 * Called by the BehaviorTreeExecutor for 'condition' nodes.
 * Each condition is a pure function: (args, context) → boolean.
 */

// ── Plant info for conditions (subset of PlantEntity + species data) ────────

export interface PlantInfo {
  id: string;
  speciesId: string;
  position: { x: number; y: number; z: number };
  currentStage: string;
  canHarvest: boolean;
  yieldMultiplier: number;
  distance: number;
}

// ── Context provided by DWM each tick ───────────────────────────────────────

export interface ConditionContext {
  companionId: string;
  position: { x: number; y: number; z: number };
  zoneId: string;
  nearbyPlants: PlantInfo[];
  inventoryItemCount: number;
  inventoryCapacity: number;
  healthRatio: number;           // 0–1 current/max HP
}

// ── Condition registry ──────────────────────────────────────────────────────

type ConditionFn = (args: Record<string, unknown>, ctx: ConditionContext) => boolean;

const CONDITIONS: Record<string, ConditionFn> = {
  nearHarvestable,
  inventoryNotFull,
  hasItem,
  healthAbove,
};

/** All registered condition names (for validation). */
export const AVAILABLE_CONDITIONS = Object.keys(CONDITIONS);

/**
 * Evaluate a named condition. Returns false for unknown conditions.
 */
export function evaluateCondition(
  name: string,
  args: Record<string, unknown>,
  ctx: ConditionContext,
): boolean {
  const fn = CONDITIONS[name];
  if (!fn) return false;
  return fn(args, ctx);
}

// ── Built-in conditions ─────────────────────────────────────────────────────

/** True if any harvestable plant is within range (default 50m). */
function nearHarvestable(args: Record<string, unknown>, ctx: ConditionContext): boolean {
  const maxRange = typeof args.range === 'number' ? args.range : 50;
  return ctx.nearbyPlants.some(p => p.canHarvest && p.distance <= maxRange);
}

/** True if inventory has room for more items. */
function inventoryNotFull(_args: Record<string, unknown>, ctx: ConditionContext): boolean {
  return ctx.inventoryItemCount < ctx.inventoryCapacity;
}

/** True if inventory contains an item (placeholder — always true for MVP). */
function hasItem(_args: Record<string, unknown>, _ctx: ConditionContext): boolean {
  // TODO: wire to InventoryService.getItems() with tag/quantity check
  // For now, return true to not block tree execution
  return true;
}

/** True if companion HP ratio is above the given threshold. */
function healthAbove(args: Record<string, unknown>, ctx: ConditionContext): boolean {
  const threshold = typeof args.threshold === 'number' ? args.threshold : 0.5;
  return ctx.healthRatio > threshold;
}
