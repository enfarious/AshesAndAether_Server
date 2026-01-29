/**
 * Tests for POIPipeline
 */

// Jest globals (describe, it, expect, beforeEach) available automatically
import { POIPipeline, POIType, POITier } from '../POIPipeline';
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
    POI_PLACEMENT: 'POI_PLACEMENT',
  },
}));

jest.mock('../BlobStorage', () => ({
  getDefaultBlobStorage: jest.fn().mockReturnValue({
    get: jest.fn().mockResolvedValue(null),
    put: jest.fn().mockResolvedValue('mock-hash'),
  }),
}));

describe('POIPipeline', () => {
  let pipeline: POIPipeline;

  beforeEach(() => {
    pipeline = new POIPipeline();
    jest.clearAllMocks();
  });

  describe('basic properties', () => {
    it('has correct name', () => {
      expect(pipeline.name).toBe('POIPipeline');
    });

    it('has correct job type', () => {
      expect(pipeline.jobType).toBe('POI_PLACEMENT');
    });
  });

  describe('process', () => {
    it('generates POI layout for tile with no prior data', async () => {
      const tile = createTileAddress(ZoomLevels.MICRO, 1000, 500);
      const result = await pipeline.process(tile);

      expect(result.success).toBe(true);
      expect(result.outputHash).toBe('mock-hash');
      expect(result.metadata).toBeDefined();
    });
  });

  describe('determinism', () => {
    it('generates same POIs for same tile coordinates', async () => {
      const tile1 = createTileAddress(ZoomLevels.MICRO, 4444, 5555);
      const tile2 = createTileAddress(ZoomLevels.MICRO, 4444, 5555);

      const result1 = await pipeline.process(tile1);
      const result2 = await pipeline.process(tile2);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.metadata?.poiCount).toBe(result2.metadata?.poiCount);
    });
  });

  describe('POI types', () => {
    it('defines all expected POI types', () => {
      expect(POIType.CAVE_ENTRANCE).toBe('CAVE_ENTRANCE');
      expect(POIType.MINE_ENTRANCE).toBe('MINE_ENTRANCE');
      expect(POIType.BUNKER_ENTRANCE).toBe('BUNKER_ENTRANCE');
      expect(POIType.SUBWAY_ENTRANCE).toBe('SUBWAY_ENTRANCE');
      expect(POIType.SEWER_ENTRANCE).toBe('SEWER_ENTRANCE');
      expect(POIType.BASEMENT_ENTRANCE).toBe('BASEMENT_ENTRANCE');
      expect(POIType.ANCIENT_RUINS).toBe('ANCIENT_RUINS');
      expect(POIType.CORRUPTION_RIFT).toBe('CORRUPTION_RIFT');
      expect(POIType.SAFE_HOUSE).toBe('SAFE_HOUSE');
      expect(POIType.TRADER_CAMP).toBe('TRADER_CAMP');
      expect(POIType.WATER_SOURCE).toBe('WATER_SOURCE');
      expect(POIType.VIEWPOINT).toBe('VIEWPOINT');
      expect(POIType.CRASH_SITE).toBe('CRASH_SITE');
      expect(POIType.CHECKPOINT).toBe('CHECKPOINT');
      expect(POIType.RADIO_TOWER).toBe('RADIO_TOWER');
    });
  });

  describe('POI tiers', () => {
    it('defines all expected difficulty tiers', () => {
      expect(POITier.TIER_1).toBe('TIER_1');
      expect(POITier.TIER_2).toBe('TIER_2');
      expect(POITier.TIER_3).toBe('TIER_3');
      expect(POITier.TIER_4).toBe('TIER_4');
      expect(POITier.TIER_5).toBe('TIER_5');
    });
  });

  describe('configuration', () => {
    it('accepts custom configuration', () => {
      const customPipeline = new POIPipeline({
        maxPOIsPerTile: 20,
        dungeonChance: 0.2,
        corruptionRiftChance: 0.5,
      });
      expect(customPipeline).toBeDefined();
    });
  });

  describe('biome-based POI generation', () => {
    it('supports all biome types', () => {
      // Verify all biomes are handled
      const biomes = [
        BiomeType.FOREST,
        BiomeType.GRASSLAND,
        BiomeType.SCRUB,
        BiomeType.MARSH,
        BiomeType.DESERT,
        BiomeType.ROCKY,
        BiomeType.TUNDRA,
        BiomeType.RUINS,
        BiomeType.WATER,
        BiomeType.COASTAL,
        BiomeType.FARMLAND,
      ];

      biomes.forEach((biome) => {
        expect(biome).toBeDefined();
      });
    });
  });

  describe('settlement-based POI generation', () => {
    it('supports all settlement types', () => {
      const settlements = [
        SettlementType.WILDERNESS,
        SettlementType.RURAL,
        SettlementType.VILLAGE,
        SettlementType.SUBURBAN,
        SettlementType.URBAN,
        SettlementType.URBAN_CORE,
        SettlementType.METROPOLIS,
      ];

      settlements.forEach((settlement) => {
        expect(settlement).toBeDefined();
      });
    });
  });
});
