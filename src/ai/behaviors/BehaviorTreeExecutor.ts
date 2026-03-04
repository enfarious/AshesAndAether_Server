/**
 * Behavior Tree Executor — general-purpose JSON tree runner for TASKED mode.
 *
 * Ticked by DWM's update loop at ~20 TPS, but internally throttles to one
 * evaluation per second. Returns BehaviorAction outputs for DWM to execute
 * via the command system. Zero LLM calls.
 *
 * Node types:
 * - sequence: runs children in order, fails if any child fails (AND)
 * - selector: tries children in order, succeeds on first success (OR)
 * - condition: evaluates a predicate, returns success/failure
 * - action: returns a BehaviorAction for DWM, returns 'running' until complete
 */

import { evaluateCondition, type ConditionContext } from './ConditionEvaluator';

// ── Node schema (stored as JSON in Companion.behaviorTree) ──────────────────

export interface BehaviorNode {
  type: 'sequence' | 'selector' | 'action' | 'condition';
  children?: BehaviorNode[];
  action?: string;                   // e.g. "/harvest", "/move", "/tell"
  condition?: string;                // e.g. "nearHarvestable", "inventoryNotFull"
  args?: Record<string, unknown>;
}

// ── Tick result ─────────────────────────────────────────────────────────────

export type NodeStatus = 'success' | 'failure' | 'running';

export interface TaskTickResult {
  status: NodeStatus;
  action?: BehaviorAction | null;
}

export interface BehaviorAction {
  command: string;                   // "/harvest", "/move", "/tell", "/stop"
  args: Record<string, unknown>;
}

// ── Action cooldowns (how long an action node stays 'running') ──────────────

const ACTION_COOLDOWNS_MS: Record<string, number> = {
  '/harvest': 3000,
  '/move': 5000,    // timeout — DWM can resolve earlier on arrival
  '/tell': 500,
  '/stop': 0,
};
const DEFAULT_ACTION_COOLDOWN_MS = 2000;

// ── Tick throttle ───────────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 1000; // One tree evaluation per second

// ── Max tree depth (safety) ─────────────────────────────────────────────────

const MAX_DEPTH = 10;

// ── Executor ────────────────────────────────────────────────────────────────

/** Per-node runtime state. Keyed by a stable path string like "0.1.2". */
interface NodeState {
  /** For sequence/selector — index of the child we're currently on. */
  childIndex: number;
  /** For action nodes — when the action was emitted. */
  actionStartedAt: number;
  /** Whether this action has already emitted its command this cycle. */
  actionEmitted: boolean;
}

export class BehaviorTreeExecutor {
  private tree: BehaviorNode;
  private nodeStates = new Map<string, NodeState>();
  private lastTickAt = 0;

  constructor(tree: BehaviorNode) {
    this.tree = tree;
  }

  /**
   * Tick the tree. Called every game tick (~50ms) but only evaluates once
   * per TICK_INTERVAL_MS. Returns the result for DWM to process.
   */
  tick(ctx: ConditionContext, now: number): TaskTickResult {
    // Throttle: if we ticked recently, return running with no action
    if (now - this.lastTickAt < TICK_INTERVAL_MS) {
      return { status: 'running', action: null };
    }
    this.lastTickAt = now;

    const result = this.evaluate(this.tree, ctx, now, '0', 0);
    return result;
  }

  /** Replace the tree (e.g. when player assigns a new task). */
  setTree(tree: BehaviorNode): void {
    this.tree = tree;
    this.nodeStates.clear();
    this.lastTickAt = 0;
  }

  /** Reset all runtime state. */
  reset(): void {
    this.nodeStates.clear();
    this.lastTickAt = 0;
  }

  // ── Recursive evaluator ─────────────────────────────────────────────────

  private evaluate(
    node: BehaviorNode,
    ctx: ConditionContext,
    now: number,
    path: string,
    depth: number,
  ): TaskTickResult {
    if (depth > MAX_DEPTH) {
      return { status: 'failure', action: null };
    }

    switch (node.type) {
      case 'sequence':
        return this.evalSequence(node, ctx, now, path, depth);
      case 'selector':
        return this.evalSelector(node, ctx, now, path, depth);
      case 'condition':
        return this.evalCondition(node, ctx);
      case 'action':
        return this.evalAction(node, now, path);
      default:
        return { status: 'failure', action: null };
    }
  }

  private evalSequence(
    node: BehaviorNode,
    ctx: ConditionContext,
    now: number,
    path: string,
    depth: number,
  ): TaskTickResult {
    const children = node.children ?? [];
    if (children.length === 0) return { status: 'success', action: null };

    const state = this.getNodeState(path);

    for (let i = state.childIndex; i < children.length; i++) {
      const childPath = `${path}.${i}`;
      const result = this.evaluate(children[i], ctx, now, childPath, depth + 1);

      if (result.status === 'failure') {
        // Sequence fails — reset to first child for next top-level tick
        state.childIndex = 0;
        return { status: 'failure', action: result.action };
      }

      if (result.status === 'running') {
        state.childIndex = i;
        return { status: 'running', action: result.action };
      }

      // success — continue to next child
    }

    // All children succeeded — reset for potential re-run (looping trees)
    state.childIndex = 0;
    return { status: 'success', action: null };
  }

  private evalSelector(
    node: BehaviorNode,
    ctx: ConditionContext,
    now: number,
    path: string,
    depth: number,
  ): TaskTickResult {
    const children = node.children ?? [];
    if (children.length === 0) return { status: 'failure', action: null };

    const state = this.getNodeState(path);

    for (let i = state.childIndex; i < children.length; i++) {
      const childPath = `${path}.${i}`;
      const result = this.evaluate(children[i], ctx, now, childPath, depth + 1);

      if (result.status === 'success') {
        state.childIndex = 0;
        return { status: 'success', action: result.action };
      }

      if (result.status === 'running') {
        state.childIndex = i;
        return { status: 'running', action: result.action };
      }

      // failure — try next child
    }

    // All children failed
    state.childIndex = 0;
    return { status: 'failure', action: null };
  }

  private evalCondition(
    node: BehaviorNode,
    ctx: ConditionContext,
  ): TaskTickResult {
    const conditionName = node.condition ?? '';
    const args = (node.args ?? {}) as Record<string, unknown>;
    const passed = evaluateCondition(conditionName, args, ctx);
    return { status: passed ? 'success' : 'failure', action: null };
  }

  private evalAction(
    node: BehaviorNode,
    now: number,
    path: string,
  ): TaskTickResult {
    const state = this.getNodeState(path);
    const command = node.action ?? '/stop';
    const cooldown = ACTION_COOLDOWNS_MS[command] ?? DEFAULT_ACTION_COOLDOWN_MS;

    // If we already emitted this action and it's still cooling down → running
    if (state.actionEmitted && now - state.actionStartedAt < cooldown) {
      return { status: 'running', action: null };
    }

    // If cooldown expired → success (action completed)
    if (state.actionEmitted) {
      state.actionEmitted = false;
      return { status: 'success', action: null };
    }

    // First time hitting this node → emit the action
    state.actionStartedAt = now;
    state.actionEmitted = true;

    return {
      status: 'running',
      action: {
        command,
        args: (node.args ?? {}) as Record<string, unknown>,
      },
    };
  }

  // ── State management ──────────────────────────────────────────────────────

  private getNodeState(path: string): NodeState {
    let state = this.nodeStates.get(path);
    if (!state) {
      state = { childIndex: 0, actionStartedAt: 0, actionEmitted: false };
      this.nodeStates.set(path, state);
    }
    return state;
  }
}
