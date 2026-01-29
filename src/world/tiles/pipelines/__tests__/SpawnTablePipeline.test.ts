/**
 * Tests for SpawnTablePipeline
 */

// Jest globals (describe, it, expect, beforeEach) available automatically
import { SpawnTablePipeline, SpawnEntryType } from '../SpawnTablePipeline';
import { BiomeType } from '../BiomePipeline';
import { SettlementType } from '../PopulationPipeline';
import { createTileAddress } from '../../TileAddress';
import { ZoomLevels } from '../../TileConstants';

// Mock dependencies
jest.mock('@/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../../TileService', () => ({
  TileService: {
    getTile: jest.fn().mockResolvedValue(null),
  },
  TileBuildJobType: {
    SPAWN_GEN: 'SPAWN_GEN',
  },
}));

jest.mock('../BlobStorage', () => ({
  getDefaultBlobStorage: jest.fn().mockReturnValue({
    get: jest.fn().mockResolvedValue(null),
    put: jest.fn().mockResolvedValue('mock-hash'),
  }),
}));

describe('SpawnTablePipeline', () => {
  let pipeline: SpawnTablePipeline;

  beforeEach(() => {
    pipeline = new SpawnTablePipeline();
    jest.clearAllMocks();
  });

  describe('basic properties', () => {
    it('has correct name', () => {
      expect(pipeline.name).toBe('SpawnTablePipeline');
    });

    it('has correct job type', () => {
      expect(pipeline.jobType).toBe('SPAWN_GEN');
    });
  });

  describe('process', () => {
    it('generates spawn table for tile with no prior data', async () => {
      const tile = createTileAddress(ZoomLevels.MICRO, 1000, 500);
      const result = await pipeline.process(tile);

      expect(result.success).toBe(true);
      expect(result.outputHash).toBe('mock-hash');
      expect(result.metadata).toBeDefined();
    });
  });

  describe('determinism', () => {
    it('generates same spawn table for same tile coordinates', async () => {
      const tile1 = createTileAddress(ZoomLevels.MICRO, 2222, 3333);
      const tile2 = createTileAddress(ZoomLevels.MICRO, 2222, 3333);

      const result1 = await pipeline.process(tile1);
      const result2 = await pipeline.process(tile2);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      // Metadata should match for same tile
      expect(result1.metadata?.biome).toBe(result2.metadata?.biome);
    });
  });

  describe('spawn entry types', () => {
    it('defines all expected spawn types', () => {
      expect(SpawnEntryType.WILDLIFE).toBe('WILDLIFE');
      expect(SpawnEntryType.HOSTILE).toBe('HOSTILE');
      expect(SpawnEntryType.CORRUPTED).toBe('CORRUPTED');
      expect(SpawnEntryType.RESOURCE).toBe('RESOURCE');
      expect(SpawnEntryType.LOOT).toBe('LOOT');
      expect(SpawnEntryType.NPC).toBe('NPC');
    });
  });

  describe('biome compatibility', () => {
    it('uses BiomeType enum values', () => {
      // Verify biome types are accessible
      expect(BiomeType.FOREST).toBe('FOREST');
      expect(BiomeType.GRASSLAND).toBe('GRASSLAND');
      expect(BiomeType.RUINS).toBe('RUINS');
      expect(BiomeType.MARSH).toBe('MARSH');
      expect(BiomeType.DESERT).toBe('DESERT');
      expect(BiomeType.TUNDRA).toBe('TUNDRA');
    });
  });

  describe('settlement compatibility', () => {
    it('uses SettlementType enum values', () => {
      expect(SettlementType.WILDERNESS).toBe('WILDERNESS');
      expect(SettlementType.RURAL).toBe('RURAL');
      expect(SettlementType.VILLAGE).toBe('VILLAGE');
      expect(SettlementType.SUBURBAN).toBe('SUBURBAN');
      expect(SettlementType.URBAN).toBe('URBAN');
      expect(SettlementType.URBAN_CORE).toBe('URBAN_CORE');
      expect(SettlementType.METROPOLIS).toBe('METROPOLIS');
    });
  });

  describe('configuration', () => {
    it('accepts custom configuration', () => {
      const customPipeline = new SpawnTablePipeline({
        baseSpawnCapacity: 100,
        corruptionSpawnThreshold: 0.2,
      });
      expect(customPipeline).toBeDefined();
    });
  });
});
