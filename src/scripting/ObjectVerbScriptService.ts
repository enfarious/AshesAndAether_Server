/**
 * ObjectVerbScriptService — Database operations for per-verb scripts.
 *
 * Each scripted object can have multiple named verb scripts (e.g. "light",
 * "dig", "onHeartbeat"). This service manages CRUD, compilation metadata,
 * and the version history stack used by /undo.
 */

import { prisma } from '@/database/DatabaseService';
import type { ObjectVerbScript } from '@prisma/client';

const MAX_HISTORY_ENTRIES = 3;

export class ObjectVerbScriptService {

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /** Create a new verb script for an object. */
  static async create(data: {
    objectId: string;
    verb: string;
    source: string;
    authorId: string;
  }): Promise<ObjectVerbScript> {
    return prisma.objectVerbScript.create({
      data: {
        objectId: data.objectId,
        verb: data.verb,
        source: data.source,
        authorId: data.authorId,
        version: 1,
        scriptHistory: '[]',
        compiledAt: new Date(),
      },
    });
  }

  /** Find a specific verb script by object + verb name. */
  static async findByObjectAndVerb(objectId: string, verb: string): Promise<ObjectVerbScript | null> {
    return prisma.objectVerbScript.findUnique({
      where: { objectId_verb: { objectId, verb } },
    });
  }

  /** Find all verb scripts for an object. */
  static async findByObject(objectId: string): Promise<ObjectVerbScript[]> {
    return prisma.objectVerbScript.findMany({
      where: { objectId },
      orderBy: { verb: 'asc' },
    });
  }

  /** Find a verb script by ID. */
  static async findById(id: string): Promise<ObjectVerbScript | null> {
    return prisma.objectVerbScript.findUnique({ where: { id } });
  }

  /** Delete a specific verb script. */
  static async delete(id: string): Promise<void> {
    await prisma.objectVerbScript.delete({ where: { id } });
  }

  /** Delete all verb scripts for an object (used when object is picked up). */
  static async deleteByObject(objectId: string): Promise<void> {
    await prisma.objectVerbScript.deleteMany({ where: { objectId } });
  }

  // ── Save with versioning ──────────────────────────────────────────────────

  /**
   * Save new source for a verb script.
   * Pushes the current source onto the history stack before overwriting.
   * Returns the updated record.
   */
  static async saveWithHistory(
    id: string,
    newSource: string,
    authorId: string,
  ): Promise<ObjectVerbScript> {
    const existing = await prisma.objectVerbScript.findUnique({ where: { id } });
    if (!existing) throw new Error(`Verb script ${id} not found`);

    // Push current source onto history (newest first, max 3)
    const history: string[] = ObjectVerbScriptService.parseHistory(existing.scriptHistory);
    if (existing.source.trim().length > 0) {
      history.unshift(existing.source);
      while (history.length > MAX_HISTORY_ENTRIES) {
        history.pop();
      }
    }

    return prisma.objectVerbScript.update({
      where: { id },
      data: {
        source: newSource,
        scriptHistory: JSON.stringify(history),
        version: existing.version + 1,
        authorId,
        compiledAt: new Date(),
      },
    });
  }

  // ── Undo (pop from history) ──────────────────────────────────────────────

  /**
   * Undo the last save by popping the most recent version from history.
   * The current source is NOT saved to history (no undo-of-undo).
   * Returns the restored record, or null if no history exists.
   */
  static async undo(id: string): Promise<ObjectVerbScript | null> {
    const existing = await prisma.objectVerbScript.findUnique({ where: { id } });
    if (!existing) return null;

    const history: string[] = ObjectVerbScriptService.parseHistory(existing.scriptHistory);
    if (history.length === 0) return null;

    const restoredSource = history.shift()!;

    return prisma.objectVerbScript.update({
      where: { id },
      data: {
        source: restoredSource,
        scriptHistory: JSON.stringify(history),
        version: existing.version + 1,
        compiledAt: new Date(),
      },
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Parse the JSON history string safely. */
  private static parseHistory(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** Get the number of undo steps available. */
  static getHistoryDepth(record: ObjectVerbScript): number {
    return ObjectVerbScriptService.parseHistory(record.scriptHistory).length;
  }
}
