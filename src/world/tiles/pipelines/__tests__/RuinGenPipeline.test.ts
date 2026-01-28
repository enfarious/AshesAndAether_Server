/**
 * Tests for RuinGenPipeline
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RuinGenPipeline, StructureType, StructureCondition } from '../RuinGenPipeline';
import { SettlementType } from '../PopulationPipeline';
import { createTileAddress } from '../../TileAddress';
import { ZoomLevels } from '../../TileConstants';

// Mock dependencies
vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../TileService', () => ({
  TileService: {
    getTile: vi.fn().mockResolvedValue(null),
  },
  TileBuildJobType: {
    RUIN_GEN: 'RUIN_GEN',
  },
}));

vi.mock('../BlobStorage', () => ({
  getDefaultBlobStorage: vi.fn().mockReturnValue({
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue('mock-hash'),
  }),
}));

describe('RuinGenPipeline', () => {
  let pipeline: RuinGenPipeline;

  beforeEach(() => {
    pipeline = new RuinGenPipeline();
    vi.clearAllMocks();
  });

  describe('basic properties', () => {
    it('has correct name', () => {
      expect(pipeline.name).toBe('RuinGenPipeline');
    });

    it('has correct job type', () => {
      expect(pipeline.jobType).toBe('RUIN_GEN');
    });
  });

  describe('process', () => {
    it('generates layout for wilderness tile with no population data', async () => {
      const tile = createTileAddress(ZoomLevels.MICRO, 1000, 500);
      const result = await pipeline.process(tile);

      expect(result.success).toBe(true);
      expect(result.outputHash).toBe('mock-hash');
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.settlementType).toBe(SettlementType.WILDERNESS);
      expect(result.metadata?.structureCount).toBe(0);
    });
  });

  describe('determinism', () => {
    it('generates same layout for same tile coordinates', async () => {
      const tile1 = createTileAddress(ZoomLevels.MICRO, 1234, 5678);
      const tile2 = createTileAddress(ZoomLevels.MICRO, 1234, 5678);

      const result1 = await pipeline.process(tile1);
      const result2 = await pipeline.process(tile2);

      // Both should succeed and produce same metadata (since no pop data)
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.metadata?.settlementType).toBe(result2.metadata?.settlementType);
    });
  });

  describe('structure types', () => {
    it('defines all expected structure types', () => {
      expect(StructureType.HOUSE).toBe('HOUSE');
      expect(StructureType.APARTMENT).toBe('APARTMENT');
      expect(StructureType.COMMERCIAL).toBe('COMMERCIAL');
      expect(StructureType.INDUSTRIAL).toBe('INDUSTRIAL');
      expect(StructureType.SKYSCRAPER).toBe('SKYSCRAPER');
      expect(StructureType.LANDMARK).toBe('LANDMARK');
      expect(StructureType.GAS_STATION).toBe('GAS_STATION');
      expect(StructureType.ROAD).toBe('ROAD');
      expect(StructureType.HIGHWAY).toBe('HIGHWAY');
      expect(StructureType.BRIDGE).toBe('BRIDGE');
      expect(StructureType.DEBRIS).toBe('DEBRIS');
      expect(StructureType.VEHICLE).toBe('VEHICLE');
      expect(StructureType.FARM).toBe('FARM');
      expect(StructureType.BARN).toBe('BARN');
    });
  });

  describe('structure conditions', () => {
    it('defines all expected conditions', () => {
      expect(StructureCondition.INTACT).toBe('INTACT');
      expect(StructureCondition.DAMAGED).toBe('DAMAGED');
      expect(StructureCondition.PARTIAL_COLLAPSE).toBe('PARTIAL_COLLAPSE');
      expect(StructureCondition.COLLAPSED).toBe('COLLAPSED');
      expect(StructureCondition.BURNED).toBe('BURNED');
    });
  });

  describe('configuration', () => {
    it('accepts custom configuration', () => {
      const customPipeline = new RuinGenPipeline({
        maxStructuresPerTile: 100,
        baseLootChance: 0.5,
      });
      expect(customPipeline).toBeDefined();
    });
  });
});
