import { logger } from '@/utils/logger';
import type { Companion } from '@prisma/client';
import type { ProximityRosterMessage } from '@/network/protocol/types';

/**
 * Controls NPC/Companion AI behavior using LLM
 *
 * Each NPC has:
 * - Personality (from database personalityType + systemPrompt)
 * - Memory (conversation history, relationships)
 * - Perception (proximity roster, nearby entities)
 * - Actions (movement, chat, emotes)
 */
export class NPCAIController {
  private companion: Companion;
  private lastAction: number = 0;
  private actionCooldown: number = 5000; // 5 seconds between actions

  constructor(companion: Companion) {
    this.companion = companion;
  }

  /**
   * Update NPC AI based on current perception
   * Called periodically by ZoneManager
   */
  async update(
    proximityRoster: ProximityRosterMessage['payload'],
    nearbyPlayerMessages: { sender: string; channel: string; message: string }[] = []
  ): Promise<void> {
    const now = Date.now();

    // Cooldown check
    if (now - this.lastAction < this.actionCooldown) {
      return;
    }

    // Check if anyone is nearby and talking
    const shouldRespond = this.shouldRespondToSituation(proximityRoster, nearbyPlayerMessages);

    if (!shouldRespond) {
      return;
    }

    // TODO: Generate LLM response based on:
    // 1. Companion personality (personalityType, systemPrompt)
    // 2. Proximity roster (who's nearby)
    // 3. Recent messages (conversation context)
    // 4. Memory (conversationHistory, memoryData)

    this.lastAction = now;

    logger.debug({
      companionId: this.companion.id,
      companionName: this.companion.name
    }, 'NPC AI update triggered');
  }

  /**
   * Determine if NPC should take action based on situation
   */
  private shouldRespondToSituation(
    proximityRoster: ProximityRosterMessage['payload'],
    recentMessages: { sender: string; channel: string; message: string }[]
  ): boolean {
    // Respond if someone is talking nearby
    if (recentMessages.length > 0) {
      return true;
    }

    // Respond if multiple people are within say range (social NPCs)
    if (proximityRoster.channels.say.count >= 2) {
      // Random chance to greet (10%)
      return Math.random() < 0.1;
    }

    return false;
  }

  /**
   * Get companion ID
   */
  getCompanionId(): string {
    return this.companion.id;
  }

  /**
   * Get companion info
   */
  getCompanion(): Companion {
    return this.companion;
  }
}
