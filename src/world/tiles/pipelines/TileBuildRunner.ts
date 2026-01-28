/**
 * TileBuildRunner - Processes tile build jobs from the queue.
 *
 * Polls the database for pending jobs and runs the appropriate pipeline.
 */

import { EventEmitter } from 'events';
import { TileService, TileBuildJobType } from '../TileService';
import { tileAddressFromId } from '../TileAddress';
import { getPipelineRegistry, type PipelineResult } from './TilePipeline';
import { ElevationPipeline } from './ElevationPipeline';
import { PopulationPipeline } from './PopulationPipeline';
import { BiomePipeline } from './BiomePipeline';
import { RuinGenPipeline } from './RuinGenPipeline';
import { SpawnTablePipeline } from './SpawnTablePipeline';
import { POIPipeline } from './POIPipeline';
import { NavmeshPipeline } from './NavmeshPipeline';
import { logger } from '@/utils/logger';

/**
 * Configuration for the build runner
 */
export interface TileBuildRunnerConfig {
  /** Poll interval in ms */
  pollInterval: number;
  /** Maximum concurrent jobs */
  maxConcurrency: number;
  /** Whether to auto-register default pipelines */
  registerDefaultPipelines: boolean;
}

const DEFAULT_CONFIG: TileBuildRunnerConfig = {
  pollInterval: 1000,
  maxConcurrency: 4,
  registerDefaultPipelines: true,
};

/**
 * Events emitted by TileBuildRunner
 */
export interface TileBuildRunnerEvents {
  /** Job started processing */
  jobStarted: (jobId: string, jobType: TileBuildJobType, tileId: string) => void;
  /** Job completed successfully */
  jobCompleted: (jobId: string, jobType: TileBuildJobType, tileId: string, result: PipelineResult) => void;
  /** Job failed */
  jobFailed: (jobId: string, jobType: TileBuildJobType, tileId: string, error: string) => void;
  /** Runner started */
  started: () => void;
  /** Runner stopped */
  stopped: () => void;
}

/**
 * TileBuildRunner - Job queue processor
 */
export class TileBuildRunner extends EventEmitter {
  private config: TileBuildRunnerConfig;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private activeJobs = 0;
  private processedCount = 0;
  private failedCount = 0;

  constructor(config: Partial<TileBuildRunnerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.registerDefaultPipelines) {
      this.registerDefaultPipelines();
    }
  }

  /**
   * Register the default pipelines
   */
  private registerDefaultPipelines(): void {
    const registry = getPipelineRegistry();

    // Truth layer pipelines
    registry.register(new ElevationPipeline());
    registry.register(new PopulationPipeline());
    registry.register(new BiomePipeline());

    // Game layer pipelines
    registry.register(new RuinGenPipeline());
    registry.register(new SpawnTablePipeline());
    registry.register(new POIPipeline());
    registry.register(new NavmeshPipeline());

    logger.info('[TileBuildRunner] Registered default pipelines (7 total)');
  }

  /**
   * Start the build runner
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    logger.info('[TileBuildRunner] Starting build runner');
    this.emit('started');

    this.poll();
  }

  /**
   * Stop the build runner
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    logger.info('[TileBuildRunner] Stopping build runner');
    this.emit('stopped');
  }

  /**
   * Get runner statistics
   */
  getStats(): { running: boolean; activeJobs: number; processedCount: number; failedCount: number } {
    return {
      running: this.running,
      activeJobs: this.activeJobs,
      processedCount: this.processedCount,
      failedCount: this.failedCount,
    };
  }

  /**
   * Queue a build job for a tile
   */
  async queueJob(
    tileId: string,
    jobType: TileBuildJobType,
    priority: number = 0
  ): Promise<string> {
    const job = await TileService.createBuildJob(tileId, jobType, priority);
    logger.debug(`[TileBuildRunner] Queued job ${job.id} for ${tileId}: ${jobType}`);
    return job.id;
  }

  /**
   * Queue all truth layer jobs for a tile
   */
  async queueAllTruthLayers(tileId: string, priority: number = 0): Promise<string[]> {
    const jobTypes = [
      TileBuildJobType.ELEVATION_FETCH,
      TileBuildJobType.POPULATION_FETCH,
      TileBuildJobType.BIOME_FETCH,
    ];

    const jobIds: string[] = [];
    for (const jobType of jobTypes) {
      const jobId = await this.queueJob(tileId, jobType, priority);
      jobIds.push(jobId);
    }

    return jobIds;
  }

  /**
   * Queue all game layer jobs for a tile
   * Note: Truth layers should be completed first
   */
  async queueAllGameLayers(tileId: string, priority: number = 0): Promise<string[]> {
    const jobTypes = [
      TileBuildJobType.RUIN_GEN,
      TileBuildJobType.SPAWN_GEN,
      TileBuildJobType.POI_PLACEMENT,
      TileBuildJobType.NAV_BAKE,
    ];

    const jobIds: string[] = [];
    for (const jobType of jobTypes) {
      const jobId = await this.queueJob(tileId, jobType, priority);
      jobIds.push(jobId);
    }

    return jobIds;
  }

  /**
   * Queue all pipelines for a tile (truth + game layers)
   * Truth layers run first, then game layers
   */
  async queueFullBuild(tileId: string, priority: number = 0): Promise<string[]> {
    // Truth layers first (higher priority within same priority band)
    const truthJobs = await this.queueAllTruthLayers(tileId, priority + 1);
    // Game layers after (lower priority, will run after truth layers complete)
    const gameJobs = await this.queueAllGameLayers(tileId, priority);

    return [...truthJobs, ...gameJobs];
  }

  /**
   * Poll for and process pending jobs
   */
  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      // Check if we have capacity
      while (this.activeJobs < this.config.maxConcurrency) {
        const job = await TileService.getNextBuildJob();
        if (!job) break;

        // Start processing (don't await - run concurrently)
        this.processJob(job.id, job.tileId, job.jobType as TileBuildJobType, job.inputHash ?? undefined);
      }
    } catch (error) {
      logger.error({ err: error }, '[TileBuildRunner] Poll error');
    }

    // Schedule next poll
    if (this.running) {
      this.pollTimer = setTimeout(() => this.poll(), this.config.pollInterval);
    }
  }

  /**
   * Process a single job
   */
  private async processJob(
    jobId: string,
    tileId: string,
    jobType: TileBuildJobType,
    inputHash?: string
  ): Promise<void> {
    this.activeJobs++;

    try {
      // Mark job as running
      await TileService.startBuildJob(jobId);
      this.emit('jobStarted', jobId, jobType, tileId);
      logger.info(`[TileBuildRunner] Processing job ${jobId}: ${tileId} (${jobType})`);

      // Get the pipeline
      const registry = getPipelineRegistry();
      const pipeline = registry.get(jobType);

      if (!pipeline) {
        throw new Error(`No pipeline registered for job type: ${jobType}`);
      }

      // Parse tile address
      const tile = tileAddressFromId(tileId);
      if (!tile) {
        throw new Error(`Invalid tile ID: ${tileId}`);
      }

      // Run the pipeline
      const result = await pipeline.process(tile, inputHash);

      if (result.success) {
        // Mark job as completed
        await TileService.completeBuildJob(jobId, result.outputHash);

        // Update tile with new hash
        await this.updateTileFromResult(tileId, jobType, result);

        this.processedCount++;
        this.emit('jobCompleted', jobId, jobType, tileId, result);
        logger.info(`[TileBuildRunner] Completed job ${jobId}: ${tileId} (${jobType})`);
      } else {
        // Mark job as failed
        await TileService.failBuildJob(jobId, result.error ?? 'Unknown error');
        this.failedCount++;
        this.emit('jobFailed', jobId, jobType, tileId, result.error ?? 'Unknown error');
        logger.warn(`[TileBuildRunner] Failed job ${jobId}: ${result.error}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await TileService.failBuildJob(jobId, message);
      this.failedCount++;
      this.emit('jobFailed', jobId, jobType, tileId, message);
      logger.error({ err: error, jobId }, '[TileBuildRunner] Job error');
    } finally {
      this.activeJobs--;
    }
  }

  /**
   * Update tile record with pipeline results
   */
  private async updateTileFromResult(
    tileId: string,
    jobType: TileBuildJobType,
    result: PipelineResult
  ): Promise<void> {
    const updates: Record<string, unknown> = {};

    switch (jobType) {
      case TileBuildJobType.ELEVATION_FETCH:
        updates.elevationHash = result.outputHash;
        break;

      case TileBuildJobType.POPULATION_FETCH:
        updates.populationHash = result.outputHash;
        if (result.metadata) {
          if (typeof result.metadata.ruinScore === 'number') {
            updates.ruinScore = result.metadata.ruinScore;
          }
          if (typeof result.metadata.damageScore === 'number') {
            updates.damageScore = result.metadata.damageScore;
          }
          if (typeof result.metadata.corruptionScore === 'number') {
            updates.corruptionScore = result.metadata.corruptionScore;
          }
        }
        break;

      case TileBuildJobType.BIOME_FETCH:
        updates.biomeHash = result.outputHash;
        break;

      case TileBuildJobType.WATER_FETCH:
        updates.waterHash = result.outputHash;
        break;

      // Game layer jobs
      case TileBuildJobType.RUIN_GEN:
        updates.ruinLayoutHash = result.outputHash;
        if (result.metadata?.version) {
          updates.ruinLayoutVersion = result.metadata.version as number;
        }
        break;

      case TileBuildJobType.SPAWN_GEN:
        updates.spawnTableHash = result.outputHash;
        if (result.metadata?.version) {
          updates.spawnTableVersion = result.metadata.version as number;
        }
        break;

      case TileBuildJobType.POI_PLACEMENT:
        updates.poiHash = result.outputHash;
        if (result.metadata?.version) {
          updates.poiVersion = result.metadata.version as number;
        }
        break;

      case TileBuildJobType.NAV_BAKE:
        updates.navmeshHash = result.outputHash;
        if (result.metadata?.version) {
          updates.navmeshVersion = result.metadata.version as number;
        }
        break;
    }

    if (Object.keys(updates).length > 0) {
      await TileService.updateTile(tileId, updates);
    }
  }
}

// Type augmentation for EventEmitter
export declare interface TileBuildRunner {
  on<K extends keyof TileBuildRunnerEvents>(
    event: K,
    listener: TileBuildRunnerEvents[K]
  ): this;
  emit<K extends keyof TileBuildRunnerEvents>(
    event: K,
    ...args: Parameters<TileBuildRunnerEvents[K]>
  ): boolean;
}
