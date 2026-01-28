/**
 * TileService - Database operations for world tiles.
 *
 * Handles CRUD operations for WorldTile and TileBuildJob records.
 */

import { prisma } from '@/database';
import type { WorldTile, TileBuildJob } from '@prisma/client';
import { ZoomLevels } from './TileConstants';
import { type TileAddress, tileAddressToId, getContainingMacroTile } from './TileAddress';
import { TileState } from './TileState';
import { logger } from '@/utils/logger';

/**
 * Job types for tile building pipeline
 */
export enum TileBuildJobType {
  ELEVATION_FETCH = 'ELEVATION_FETCH',
  WATER_FETCH = 'WATER_FETCH',
  POPULATION_FETCH = 'POPULATION_FETCH',
  BIOME_FETCH = 'BIOME_FETCH',
  RUIN_GEN = 'RUIN_GEN',
  SPAWN_GEN = 'SPAWN_GEN',
  NAV_BAKE = 'NAV_BAKE',
}

/**
 * Job status
 */
export enum TileBuildJobStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

/**
 * Data for creating or updating a tile
 */
export interface TileData {
  state?: TileState;
  elevationHash?: string | null;
  waterHash?: string | null;
  populationHash?: string | null;
  biomeHash?: string | null;
  ruinLayoutVersion?: number;
  spawnTableVersion?: number;
  navmeshVersion?: number;
  ruinScore?: number;
  damageScore?: number;
  corruptionScore?: number;
  manifestHash?: string | null;
}

/**
 * TileService - Static methods for tile database operations
 */
export class TileService {
  /**
   * Get or create a tile record
   */
  static async getOrCreateTile(tile: TileAddress): Promise<WorldTile> {
    const tileId = tileAddressToId(tile);

    const existing = await prisma.worldTile.findUnique({
      where: { id: tileId },
    });

    if (existing) {
      return existing;
    }

    // Determine parent tile ID for micro tiles
    let parentTileId: string | null = null;
    if (tile.z === ZoomLevels.MICRO) {
      const macroTile = getContainingMacroTile(tile);
      if (macroTile) {
        parentTileId = tileAddressToId(macroTile);
      }
    }

    return prisma.worldTile.create({
      data: {
        id: tileId,
        z: tile.z,
        x: tile.x,
        y: tile.y,
        state: TileState.COLD,
        parentTileId,
      },
    });
  }

  /**
   * Get a tile by ID
   */
  static async getTile(tileId: string): Promise<WorldTile | null> {
    return prisma.worldTile.findUnique({
      where: { id: tileId },
    });
  }

  /**
   * Get a tile by coordinates
   */
  static async getTileByCoords(z: number, x: number, y: number): Promise<WorldTile | null> {
    return prisma.worldTile.findUnique({
      where: { z_x_y: { z, x, y } },
    });
  }

  /**
   * Update a tile's data
   */
  static async updateTile(tileId: string, data: TileData): Promise<WorldTile> {
    return prisma.worldTile.update({
      where: { id: tileId },
      data: {
        ...data,
        lastTouchedAt: new Date(),
      },
    });
  }

  /**
   * Update a tile's state
   */
  static async updateTileState(tileId: string, state: TileState): Promise<WorldTile> {
    return prisma.worldTile.update({
      where: { id: tileId },
      data: {
        state,
        lastTouchedAt: new Date(),
      },
    });
  }

  /**
   * Get all tiles in a specific state
   */
  static async getTilesByState(state: TileState): Promise<WorldTile[]> {
    return prisma.worldTile.findMany({
      where: { state },
    });
  }

  /**
   * Get micro tiles belonging to a macro tile
   */
  static async getMicroTilesForMacro(macroTileId: string): Promise<WorldTile[]> {
    return prisma.worldTile.findMany({
      where: { parentTileId: macroTileId },
    });
  }

  /**
   * Bulk update tile states (for efficiency)
   */
  static async bulkUpdateState(tileIds: string[], state: TileState): Promise<number> {
    const result = await prisma.worldTile.updateMany({
      where: { id: { in: tileIds } },
      data: {
        state,
        lastTouchedAt: new Date(),
      },
    });
    return result.count;
  }

  /**
   * Get stale tiles (not touched in a while)
   */
  static async getStaleTiles(olderThan: Date, state?: TileState): Promise<WorldTile[]> {
    const where: Record<string, unknown> = {
      lastTouchedAt: { lt: olderThan },
    };

    if (state) {
      where.state = state;
    }

    return prisma.worldTile.findMany({
      where,
      orderBy: { lastTouchedAt: 'asc' },
      take: 100,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Build Jobs
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a build job for a tile
   */
  static async createBuildJob(
    tileId: string,
    jobType: TileBuildJobType,
    priority: number = 0,
    inputHash?: string
  ): Promise<TileBuildJob> {
    // Check for existing pending/running job of same type
    const existing = await prisma.tileBuildJob.findFirst({
      where: {
        tileId,
        jobType,
        status: { in: [TileBuildJobStatus.PENDING, TileBuildJobStatus.RUNNING] },
      },
    });

    if (existing) {
      logger.debug(`[TileService] Build job already exists for ${tileId}:${jobType}`);
      return existing;
    }

    return prisma.tileBuildJob.create({
      data: {
        tileId,
        jobType,
        priority,
        inputHash,
      },
    });
  }

  /**
   * Get the next pending build job
   */
  static async getNextBuildJob(): Promise<TileBuildJob | null> {
    return prisma.tileBuildJob.findFirst({
      where: { status: TileBuildJobStatus.PENDING },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Get pending build jobs for a tile
   */
  static async getPendingJobsForTile(tileId: string): Promise<TileBuildJob[]> {
    return prisma.tileBuildJob.findMany({
      where: {
        tileId,
        status: TileBuildJobStatus.PENDING,
      },
      orderBy: { priority: 'desc' },
    });
  }

  /**
   * Start a build job
   */
  static async startBuildJob(jobId: string): Promise<TileBuildJob> {
    return prisma.tileBuildJob.update({
      where: { id: jobId },
      data: {
        status: TileBuildJobStatus.RUNNING,
        startedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
  }

  /**
   * Complete a build job
   */
  static async completeBuildJob(jobId: string, outputHash?: string): Promise<TileBuildJob> {
    return prisma.tileBuildJob.update({
      where: { id: jobId },
      data: {
        status: TileBuildJobStatus.COMPLETED,
        completedAt: new Date(),
        outputHash,
      },
    });
  }

  /**
   * Fail a build job
   */
  static async failBuildJob(jobId: string, errorMsg: string): Promise<TileBuildJob> {
    const job = await prisma.tileBuildJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new Error(`Build job not found: ${jobId}`);
    }

    // Check if we should retry
    const shouldRetry = job.attempts < job.maxAttempts;

    return prisma.tileBuildJob.update({
      where: { id: jobId },
      data: {
        status: shouldRetry ? TileBuildJobStatus.PENDING : TileBuildJobStatus.FAILED,
        errorMsg,
      },
    });
  }

  /**
   * Get build job statistics
   */
  static async getBuildJobStats(): Promise<Record<TileBuildJobStatus, number>> {
    const results = await prisma.tileBuildJob.groupBy({
      by: ['status'],
      _count: { status: true },
    });

    const stats: Record<TileBuildJobStatus, number> = {
      [TileBuildJobStatus.PENDING]: 0,
      [TileBuildJobStatus.RUNNING]: 0,
      [TileBuildJobStatus.COMPLETED]: 0,
      [TileBuildJobStatus.FAILED]: 0,
    };

    for (const result of results) {
      stats[result.status as TileBuildJobStatus] = result._count.status;
    }

    return stats;
  }

  /**
   * Clean up old completed jobs
   */
  static async cleanupCompletedJobs(olderThan: Date): Promise<number> {
    const result = await prisma.tileBuildJob.deleteMany({
      where: {
        status: TileBuildJobStatus.COMPLETED,
        completedAt: { lt: olderThan },
      },
    });
    return result.count;
  }

  /**
   * Reset stalled running jobs
   */
  static async resetStalledJobs(stalledThreshold: Date): Promise<number> {
    const result = await prisma.tileBuildJob.updateMany({
      where: {
        status: TileBuildJobStatus.RUNNING,
        startedAt: { lt: stalledThreshold },
      },
      data: {
        status: TileBuildJobStatus.PENDING,
        errorMsg: 'Job stalled and was reset',
      },
    });
    return result.count;
  }
}
