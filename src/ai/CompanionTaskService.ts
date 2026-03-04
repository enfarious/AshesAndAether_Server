/**
 * Companion Task Service — handles `/companion task <description>`.
 *
 * Asks the LLM to generate a behavior tree from a natural-language description,
 * validates the output, and returns it for storage on the Companion model.
 *
 * LLM budget: 1 call per task assignment, 0 during execution.
 */

import { logger } from '@/utils/logger';
import type { Companion } from '@prisma/client';
import type { LLMService } from './LLMService';
import type { BehaviorNode } from './behaviors/BehaviorTreeExecutor';
import { ALLOWED_ACTIONS, ALLOWED_CONDITIONS } from './behaviors/HarvestBehavior';

const MAX_TREE_DEPTH = 10;
const VALID_NODE_TYPES = ['sequence', 'selector', 'action', 'condition'];

export class CompanionTaskService {
  /**
   * Generate a behavior tree from a natural-language task description.
   * Returns the tree on success, or a rejection reason on failure.
   */
  async generateTaskTree(
    companion: Companion,
    taskDescription: string,
    llmService: LLMService,
  ): Promise<{ tree: BehaviorNode; rejection?: string } | { tree: null; rejection: string }> {
    try {
      const result = await llmService.generateBehaviorTree(companion, taskDescription);

      if (!result) {
        return { tree: null, rejection: 'LLM failed to generate a response.' };
      }

      // Check for explicit rejection
      if (typeof result === 'string') {
        return { tree: null, rejection: result };
      }

      // Validate the tree
      const validation = this.validateTree(result);
      if (!validation.valid) {
        logger.warn({
          companionId: companion.id,
          errors: validation.errors,
        }, '[CompanionTaskService] LLM tree failed validation');
        return { tree: null, rejection: `Invalid tree: ${validation.errors.join(', ')}` };
      }

      return { tree: result };
    } catch (error) {
      logger.error({ error, companionId: companion.id }, '[CompanionTaskService] Tree generation failed');
      return { tree: null, rejection: 'Internal error generating behavior tree.' };
    }
  }

  /**
   * Validate a behavior tree for safety and correctness.
   */
  validateTree(tree: BehaviorNode): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    this.validateNode(tree, errors, 0);
    return { valid: errors.length === 0, errors };
  }

  private validateNode(node: BehaviorNode, errors: string[], depth: number): void {
    if (depth > MAX_TREE_DEPTH) {
      errors.push(`Tree exceeds max depth of ${MAX_TREE_DEPTH}`);
      return;
    }

    if (!VALID_NODE_TYPES.includes(node.type)) {
      errors.push(`Unknown node type: ${node.type}`);
      return;
    }

    if (node.type === 'action') {
      const action = node.action ?? '';
      if (!ALLOWED_ACTIONS.includes(action)) {
        errors.push(`Disallowed action: ${action}. Allowed: ${ALLOWED_ACTIONS.join(', ')}`);
      }
    }

    if (node.type === 'condition') {
      const condition = node.condition ?? '';
      if (!ALLOWED_CONDITIONS.includes(condition)) {
        errors.push(`Unknown condition: ${condition}. Allowed: ${ALLOWED_CONDITIONS.join(', ')}`);
      }
    }

    if (node.children) {
      for (const child of node.children) {
        this.validateNode(child, errors, depth + 1);
      }
    }
  }
}
