/**
 * BlobStorage - Content-addressed storage for tile data.
 *
 * Stores binary data by its hash for deduplication and cache efficiency.
 * Currently uses filesystem; can be swapped for S3 later.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '@/utils/logger';

/**
 * Configuration for blob storage
 */
export interface BlobStorageConfig {
  /** Base directory for blob storage */
  basePath: string;
  /** Number of directory levels for sharding (2 = ab/cd/abcd1234...) */
  shardDepth: number;
}

const DEFAULT_CONFIG: BlobStorageConfig = {
  basePath: './data/blobs',
  shardDepth: 2,
};

/**
 * Compute SHA-256 hash of data
 */
export function computeHash(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * BlobStorage - Content-addressed blob storage
 */
export class BlobStorage {
  private config: BlobStorageConfig;
  private initialized = false;

  constructor(config: Partial<BlobStorageConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the storage directory
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await fs.mkdir(this.config.basePath, { recursive: true });
    this.initialized = true;
    logger.info(`[BlobStorage] Initialized at ${this.config.basePath}`);
  }

  /**
   * Get the file path for a given hash
   */
  private getPath(hash: string): string {
    const parts: string[] = [];
    for (let i = 0; i < this.config.shardDepth; i++) {
      parts.push(hash.slice(i * 2, i * 2 + 2));
    }
    parts.push(hash);
    return path.join(this.config.basePath, ...parts);
  }

  /**
   * Store data and return its hash
   */
  async put(data: Buffer): Promise<string> {
    await this.initialize();

    const hash = computeHash(data);
    const filePath = this.getPath(hash);

    // Check if already exists (content-addressed = idempotent)
    try {
      await fs.access(filePath);
      logger.debug(`[BlobStorage] Blob ${hash.slice(0, 8)} already exists`);
      return hash;
    } catch {
      // File doesn't exist, continue to write
    }

    // Create directory and write
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
    logger.debug(`[BlobStorage] Stored blob ${hash.slice(0, 8)} (${data.length} bytes)`);

    return hash;
  }

  /**
   * Retrieve data by hash
   */
  async get(hash: string): Promise<Buffer | null> {
    await this.initialize();

    const filePath = this.getPath(hash);
    try {
      return await fs.readFile(filePath);
    } catch {
      return null;
    }
  }

  /**
   * Check if a blob exists
   */
  async exists(hash: string): Promise<boolean> {
    await this.initialize();

    const filePath = this.getPath(hash);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete a blob by hash
   */
  async delete(hash: string): Promise<boolean> {
    await this.initialize();

    const filePath = this.getPath(hash);
    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get storage statistics
   */
  async getStats(): Promise<{ totalBlobs: number; totalBytes: number }> {
    await this.initialize();

    let totalBlobs = 0;
    let totalBytes = 0;

    async function countDir(dirPath: string): Promise<void> {
      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            await countDir(fullPath);
          } else if (entry.isFile()) {
            totalBlobs++;
            const stat = await fs.stat(fullPath);
            totalBytes += stat.size;
          }
        }
      } catch {
        // Directory doesn't exist yet
      }
    }

    await countDir(this.config.basePath);
    return { totalBlobs, totalBytes };
  }
}

// Singleton instance
let defaultStorage: BlobStorage | null = null;

/**
 * Get the default blob storage instance
 */
export function getDefaultBlobStorage(): BlobStorage {
  if (!defaultStorage) {
    defaultStorage = new BlobStorage();
  }
  return defaultStorage;
}
