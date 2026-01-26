import { prisma } from '../database/DatabaseService';
import type { Character, CorruptionEvent, Zone } from '@prisma/client';
import {
  clampCorruption,
  getCorruptionState,
  getCorruptionConfig,
  type CorruptionState,
} from './CorruptionConfig';

// Types for corruption updates
export interface CorruptionUpdate {
  characterId: string;
  delta: number;
  eventType: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface CorruptionResult {
  characterId: string;
  previousCorruption: number;
  newCorruption: number;
  previousState: CorruptionState;
  newState: CorruptionState;
  stateChanged: boolean;
}

export interface CharacterCorruptionData {
  id: string;
  corruption: number;
  corruptionState: CorruptionState;
  lastCorruptionTickAt: Date;
  isolationSeconds: number;
  communitySeconds: number;
  wealthScoreCached: number;
  wealthScoreCachedAt: Date;
  contributionPoints: number;
  contributionBuffExpires: Date | null;
  zoneId: string;
}

export class CorruptionService {
  /**
   * Get corruption data for a character
   */
  static async getCorruptionData(characterId: string): Promise<CharacterCorruptionData | null> {
    const character = await prisma.character.findUnique({
      where: { id: characterId },
      select: {
        id: true,
        corruption: true,
        lastCorruptionTickAt: true,
        isolationSeconds: true,
        communitySeconds: true,
        wealthScoreCached: true,
        wealthScoreCachedAt: true,
        contributionPoints: true,
        contributionBuffExpires: true,
        zoneId: true,
      },
    });

    if (!character) return null;

    return {
      ...character,
      corruptionState: getCorruptionState(character.corruption),
    };
  }

  /**
   * Update corruption for a single character
   * Returns the result with state change info
   */
  static async updateCorruption(
    characterId: string,
    delta: number,
    eventType: string,
    reason?: string,
    metadata?: Record<string, unknown>
  ): Promise<CorruptionResult | null> {
    const config = getCorruptionConfig();

    // Get current corruption
    const character = await prisma.character.findUnique({
      where: { id: characterId },
      select: { corruption: true },
    });

    if (!character) return null;

    const previousCorruption = character.corruption;
    const newCorruption = clampCorruption(previousCorruption + delta);
    const previousState = getCorruptionState(previousCorruption);
    const newState = getCorruptionState(newCorruption);
    const stateChanged = previousState !== newState;

    // Update character corruption
    await prisma.character.update({
      where: { id: characterId },
      data: {
        corruption: newCorruption,
        lastCorruptionTickAt: new Date(),
      },
    });

    // Log event if audit enabled
    if (config.debug.audit_events_enabled) {
      const shouldLog = Math.random() < config.debug.audit_sample_rate;
      if (shouldLog) {
        await prisma.corruptionEvent.create({
          data: {
            characterId,
            eventType,
            delta,
            corruptionBefore: previousCorruption,
            corruptionAfter: newCorruption,
            reason,
            metadata: metadata ?? null,
          },
        });
      }
    }

    return {
      characterId,
      previousCorruption,
      newCorruption,
      previousState,
      newState,
      stateChanged,
    };
  }

  /**
   * Batch update corruption for multiple characters
   * More efficient for zone-wide tick processing
   */
  static async batchUpdateCorruption(updates: CorruptionUpdate[]): Promise<CorruptionResult[]> {
    const config = getCorruptionConfig();
    const results: CorruptionResult[] = [];

    // Get all current corruption values in one query
    const characterIds = updates.map(u => u.characterId);
    const characters = await prisma.character.findMany({
      where: { id: { in: characterIds } },
      select: { id: true, corruption: true },
    });

    const corruptionMap = new Map(characters.map(c => [c.id, c.corruption]));

    // Process updates and prepare batch operations
    const characterUpdates: { id: string; corruption: number }[] = [];
    const eventCreates: {
      characterId: string;
      eventType: string;
      delta: number;
      corruptionBefore: number;
      corruptionAfter: number;
      reason?: string;
      metadata?: Record<string, unknown>;
    }[] = [];

    for (const update of updates) {
      const previousCorruption = corruptionMap.get(update.characterId);
      if (previousCorruption === undefined) continue;

      const newCorruption = clampCorruption(previousCorruption + update.delta);
      const previousState = getCorruptionState(previousCorruption);
      const newState = getCorruptionState(newCorruption);

      characterUpdates.push({ id: update.characterId, corruption: newCorruption });

      results.push({
        characterId: update.characterId,
        previousCorruption,
        newCorruption,
        previousState,
        newState,
        stateChanged: previousState !== newState,
      });

      // Prepare audit event
      if (config.debug.audit_events_enabled) {
        const shouldLog = Math.random() < config.debug.audit_sample_rate;
        if (shouldLog) {
          eventCreates.push({
            characterId: update.characterId,
            eventType: update.eventType,
            delta: update.delta,
            corruptionBefore: previousCorruption,
            corruptionAfter: newCorruption,
            reason: update.reason,
            metadata: update.metadata,
          });
        }
      }
    }

    // Execute batch updates in a transaction
    await prisma.$transaction([
      // Update all characters
      ...characterUpdates.map(u =>
        prisma.character.update({
          where: { id: u.id },
          data: {
            corruption: u.corruption,
            lastCorruptionTickAt: new Date(),
          },
        })
      ),
      // Create audit events
      ...eventCreates.map(e =>
        prisma.corruptionEvent.create({
          data: {
            characterId: e.characterId,
            eventType: e.eventType,
            delta: e.delta,
            corruptionBefore: e.corruptionBefore,
            corruptionAfter: e.corruptionAfter,
            reason: e.reason,
            metadata: e.metadata ?? null,
          },
        })
      ),
    ]);

    return results;
  }

  /**
   * Update isolation/community time tracking
   */
  static async updateTimeTracking(
    characterId: string,
    isolationDeltaSeconds: number,
    communityDeltaSeconds: number
  ): Promise<void> {
    // If in community, reset isolation; if isolated, reset community
    if (communityDeltaSeconds > 0) {
      await prisma.character.update({
        where: { id: characterId },
        data: {
          communitySeconds: { increment: communityDeltaSeconds },
          isolationSeconds: 0, // Reset isolation when in community
        },
      });
    } else if (isolationDeltaSeconds > 0) {
      await prisma.character.update({
        where: { id: characterId },
        data: {
          isolationSeconds: { increment: isolationDeltaSeconds },
          communitySeconds: 0, // Reset community when isolated
        },
      });
    }
  }

  /**
   * Update cached wealth score
   */
  static async updateWealthScore(characterId: string, wealthScore: number): Promise<void> {
    await prisma.character.update({
      where: { id: characterId },
      data: {
        wealthScoreCached: wealthScore,
        wealthScoreCachedAt: new Date(),
      },
    });
  }

  /**
   * Add contribution points and optionally apply corruption reduction
   */
  static async addContribution(
    characterId: string,
    points: number,
    source: string
  ): Promise<{ pointsAdded: number; corruptionReduced: number; buffApplied: boolean }> {
    const config = getCorruptionConfig();

    if (!config.contribution.enabled) {
      return { pointsAdded: 0, corruptionReduced: 0, buffApplied: false };
    }

    const character = await prisma.character.findUnique({
      where: { id: characterId },
      select: { contributionPoints: true, corruption: true },
    });

    if (!character) {
      return { pointsAdded: 0, corruptionReduced: 0, buffApplied: false };
    }

    const newPoints = character.contributionPoints + points;
    const conversion = config.contribution.points_to_corruption_reduction;

    // Calculate corruption reduction from points
    const reductionCount = Math.floor(newPoints / conversion.points);
    const remainingPoints = newPoints % conversion.points;
    const corruptionDelta = reductionCount * conversion.corruption_delta;

    // Apply buff if enabled
    let buffExpires: Date | null = null;
    const buffConfig = config.contribution.wealth_gain_multiplier_buff;
    if (buffConfig.enabled && reductionCount > 0) {
      buffExpires = new Date(Date.now() + buffConfig.duration_seconds * 1000);
    }

    // Update character
    const newCorruption = clampCorruption(character.corruption + corruptionDelta);

    await prisma.character.update({
      where: { id: characterId },
      data: {
        contributionPoints: remainingPoints,
        corruption: newCorruption,
        ...(buffExpires && { contributionBuffExpires: buffExpires }),
      },
    });

    // Log event if there was corruption reduction
    if (corruptionDelta !== 0 && config.debug.audit_events_enabled) {
      await prisma.corruptionEvent.create({
        data: {
          characterId,
          eventType: 'CONTRIBUTION',
          delta: corruptionDelta,
          corruptionBefore: character.corruption,
          corruptionAfter: newCorruption,
          reason: `${reductionCount}x conversion from ${source}`,
          metadata: { source, pointsAdded: points, reductionCount },
        },
      });
    }

    return {
      pointsAdded: points,
      corruptionReduced: Math.abs(corruptionDelta),
      buffApplied: buffExpires !== null,
    };
  }

  /**
   * Apply a forbidden action corruption spike
   */
  static async applyForbiddenAction(
    characterId: string,
    eventType: string,
    reason?: string
  ): Promise<CorruptionResult | null> {
    const config = getCorruptionConfig();

    if (!config.forbidden_actions.enabled) {
      return null;
    }

    const event = config.forbidden_actions.events.find(e => e.event_type === eventType);
    if (!event) {
      console.warn(`[CorruptionService] Unknown forbidden action: ${eventType}`);
      return null;
    }

    return this.updateCorruption(
      characterId,
      event.corruption_add,
      `FORBIDDEN_${eventType}`,
      reason ?? `Forbidden action: ${eventType}`,
      { forbiddenEventType: eventType }
    );
  }

  /**
   * Get corruption events for a character (for audit/debug UI)
   */
  static async getCorruptionEvents(
    characterId: string,
    limit = 50,
    offset = 0
  ): Promise<CorruptionEvent[]> {
    return prisma.corruptionEvent.findMany({
      where: { characterId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }

  /**
   * Get characters in a zone with their corruption data
   * Used for batch zone tick processing
   */
  static async getZoneCharactersForTick(zoneId: string): Promise<
    Array<{
      id: string;
      corruption: number;
      isolationSeconds: number;
      wealthScoreCached: number;
      contributionBuffExpires: Date | null;
    }>
  > {
    return prisma.character.findMany({
      where: { zoneId },
      select: {
        id: true,
        corruption: true,
        isolationSeconds: true,
        wealthScoreCached: true,
        contributionBuffExpires: true,
      },
    });
  }

  /**
   * Get zone corruption tag
   */
  static async getZoneCorruptionTag(zoneId: string): Promise<string | null> {
    const zone = await prisma.zone.findUnique({
      where: { id: zoneId },
      select: { corruptionTag: true },
    });

    return zone?.corruptionTag ?? null;
  }

  /**
   * Set zone corruption tag
   */
  static async setZoneCorruptionTag(zoneId: string, tag: string): Promise<void> {
    await prisma.zone.update({
      where: { id: zoneId },
      data: { corruptionTag: tag },
    });
  }
}
