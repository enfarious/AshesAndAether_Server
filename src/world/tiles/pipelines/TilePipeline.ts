/**
 * TilePipeline - Base interface for tile data processing pipelines.
 *
 * Each pipeline fetches/processes one type of truth layer data.
 */

import { type TileAddress, tileAddressToId } from '../TileAddress';
import { TileBuildJobType } from '../TileService';
import { BlobStorage, getDefaultBlobStorage } from './BlobStorage';
import { logger } from '@/utils/logger';

/**
 * Result of a pipeline execution
 */
export interface PipelineResult {
  /** Whether the pipeline succeeded */
  success: boolean;
  /** Content-addressed hash of the output data */
  outputHash?: string;
  /** Error message if failed */
  error?: string;
  /** Metadata about the processed data */
  metadata?: Record<string, unknown>;
}

/**
 * Base interface for tile data pipelines
 */
export interface TilePipeline {
  /** The job type this pipeline handles */
  jobType: TileBuildJobType;

  /** Human-readable name */
  name: string;

  /**
   * Process a tile and return the result
   * @param tile The tile to process
   * @param inputHash Optional hash of existing data (for incremental updates)
   */
  process(tile: TileAddress, inputHash?: string): Promise<PipelineResult>;

  /**
   * Check if data needs to be refreshed
   * @param tile The tile to check
   * @param existingHash The hash of existing data
   */
  needsRefresh?(tile: TileAddress, existingHash: string): Promise<boolean>;
}

/**
 * Abstract base class for pipelines with common functionality
 */
export abstract class BaseTilePipeline implements TilePipeline {
  abstract jobType: TileBuildJobType;
  abstract name: string;

  protected storage: BlobStorage;

  constructor(storage?: BlobStorage) {
    this.storage = storage ?? getDefaultBlobStorage();
  }

  abstract process(tile: TileAddress, inputHash?: string): Promise<PipelineResult>;

  /**
   * Default implementation - always returns false (no automatic refresh)
   */
  async needsRefresh(_tile: TileAddress, _existingHash: string): Promise<boolean> {
    return false;
  }

  /**
   * Helper to create a successful result
   */
  protected success(outputHash: string, metadata?: Record<string, unknown>): PipelineResult {
    return { success: true, outputHash, metadata };
  }

  /**
   * Helper to create a failed result
   */
  protected failure(error: string): PipelineResult {
    return { success: false, error };
  }

  /**
   * Helper to log pipeline activity
   */
  protected log(tile: TileAddress, message: string): void {
    logger.info(`[${this.name}] ${tileAddressToId(tile)}: ${message}`);
  }

  /**
   * Helper to log debug info
   */
  protected debug(tile: TileAddress, message: string): void {
    logger.debug(`[${this.name}] ${tileAddressToId(tile)}: ${message}`);
  }
}

/**
 * Registry of available pipelines
 */
export class PipelineRegistry {
  private pipelines: Map<TileBuildJobType, TilePipeline> = new Map();

  /**
   * Register a pipeline
   */
  register(pipeline: TilePipeline): void {
    this.pipelines.set(pipeline.jobType, pipeline);
    logger.info(`[PipelineRegistry] Registered pipeline: ${pipeline.name}`);
  }

  /**
   * Get a pipeline by job type
   */
  get(jobType: TileBuildJobType): TilePipeline | undefined {
    return this.pipelines.get(jobType);
  }

  /**
   * Get all registered pipelines
   */
  getAll(): TilePipeline[] {
    return Array.from(this.pipelines.values());
  }

  /**
   * Check if a pipeline is registered
   */
  has(jobType: TileBuildJobType): boolean {
    return this.pipelines.has(jobType);
  }
}

// Global registry instance
let registryInstance: PipelineRegistry | null = null;

/**
 * Get the global pipeline registry
 */
export function getPipelineRegistry(): PipelineRegistry {
  if (!registryInstance) {
    registryInstance = new PipelineRegistry();
  }
  return registryInstance;
}
