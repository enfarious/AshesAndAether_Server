/**
 * NavmeshPipeline Tests
 *
 * Tests for the navmesh generation pipeline.
 */

import {
  NavmeshPipeline,
  WalkabilityFlag,
  MovementCost,
} from './NavmeshPipeline';
import { TileBuildJobType } from '../TileService';
import { createTileAddress } from '../TileAddress';

// Mock logger
jest.mock('@/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('NavmeshPipeline', () => {
  let pipeline: NavmeshPipeline;

  beforeEach(() => {
    pipeline = new NavmeshPipeline();
  });

  describe('Basic Properties', () => {
    it('should have correct job type', () => {
      expect(pipeline.jobType).toBe(TileBuildJobType.NAV_BAKE);
    });

    it('should have valid config', () => {
      const config = (pipeline as any).config;
      expect(config).toBeDefined();
      expect(config.gridSize).toBe(64);
    });
  });

  describe('WalkabilityFlag Enum', () => {
    it('should define all walkability flags', () => {
      expect(WalkabilityFlag.WALKABLE).toBeDefined();
      expect(WalkabilityFlag.BLOCKED_STRUCTURE).toBeDefined();
      expect(WalkabilityFlag.BLOCKED_WATER).toBeDefined();
      expect(WalkabilityFlag.BLOCKED_SLOPE).toBeDefined();
      expect(WalkabilityFlag.BLOCKED_CORRUPTION).toBeDefined();
      expect(WalkabilityFlag.ROAD).toBeDefined();
      expect(WalkabilityFlag.DENSE_VEGETATION).toBeDefined();
      expect(WalkabilityFlag.RUBBLE).toBeDefined();
      expect(WalkabilityFlag.INDOOR).toBeDefined();
    });

    it('should have unique bitfield values', () => {
      const values = [
        WalkabilityFlag.WALKABLE,
        WalkabilityFlag.BLOCKED_STRUCTURE,
        WalkabilityFlag.BLOCKED_WATER,
        WalkabilityFlag.BLOCKED_SLOPE,
        WalkabilityFlag.BLOCKED_CORRUPTION,
        WalkabilityFlag.ROAD,
        WalkabilityFlag.DENSE_VEGETATION,
        WalkabilityFlag.RUBBLE,
        WalkabilityFlag.INDOOR,
      ];

      const uniqueValues = new Set(values);
      expect(uniqueValues.size).toBe(values.length);
    });

    it('should be power-of-2 for bitfield operations', () => {
      // Check that non-WALKABLE flags are powers of 2
      const flags = [
        WalkabilityFlag.BLOCKED_STRUCTURE,
        WalkabilityFlag.BLOCKED_WATER,
        WalkabilityFlag.BLOCKED_SLOPE,
        WalkabilityFlag.BLOCKED_CORRUPTION,
        WalkabilityFlag.ROAD,
        WalkabilityFlag.DENSE_VEGETATION,
        WalkabilityFlag.RUBBLE,
        WalkabilityFlag.INDOOR,
      ];

      for (const flag of flags) {
        // Powers of 2 have exactly one bit set: n & (n-1) === 0
        expect(flag & (flag - 1)).toBe(0);
      }
    });
  });

  describe('MovementCost Enum', () => {
    it('should define all movement costs', () => {
      expect(MovementCost.NORMAL).toBe(1.0);
      expect(MovementCost.ROAD).toBe(0.7);
      expect(MovementCost.VEGETATION).toBe(1.5);
      expect(MovementCost.RUBBLE).toBe(2.0);
      expect(MovementCost.MARSH).toBe(2.5);
      expect(MovementCost.SAND).toBe(1.3);
      expect(MovementCost.SNOW).toBe(1.8);
      expect(MovementCost.ROCKY).toBe(1.4);
      expect(MovementCost.IMPASSABLE).toBe(Infinity);
    });

    it('should have road cost less than normal', () => {
      expect(MovementCost.ROAD).toBeLessThan(MovementCost.NORMAL);
    });

    it('should have difficult terrain costs greater than normal', () => {
      expect(MovementCost.VEGETATION).toBeGreaterThan(MovementCost.NORMAL);
      expect(MovementCost.RUBBLE).toBeGreaterThan(MovementCost.NORMAL);
      expect(MovementCost.MARSH).toBeGreaterThan(MovementCost.NORMAL);
      expect(MovementCost.SAND).toBeGreaterThan(MovementCost.NORMAL);
      expect(MovementCost.SNOW).toBeGreaterThan(MovementCost.NORMAL);
      expect(MovementCost.ROCKY).toBeGreaterThan(MovementCost.NORMAL);
    });
  });

  describe('Navmesh Generation', () => {
    it('should generate navmesh for valid tile', async () => {
      const tile = createTileAddress(14, 4823, 6127);
      const result = await pipeline.process(tile);

      expect(result.success).toBe(true);
      expect(result.outputHash).toBeDefined();
      expect(result.outputHash!.length).toBe(64); // SHA-256
    });

    it('should produce deterministic output', async () => {
      const tile = createTileAddress(14, 4823, 6127);
      const result1 = await pipeline.process(tile);
      const result2 = await pipeline.process(tile);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.outputHash).toBe(result2.outputHash);
    });

    it('should generate different navmeshes for different tiles', async () => {
      const tile1 = createTileAddress(14, 4823, 6127);
      const tile2 = createTileAddress(14, 4824, 6127);

      const result1 = await pipeline.process(tile1);
      const result2 = await pipeline.process(tile2);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.outputHash).not.toBe(result2.outputHash);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing dependencies gracefully', async () => {
      // Test with a tile that might not have cached elevation data
      const tile = createTileAddress(14, 9999, 9999);
      const result = await pipeline.process(tile);

      // Should still succeed with procedural generation
      expect(result.success).toBe(true);
      expect(result.outputHash).toBeDefined();
    });

    it('should handle invalid zoom levels', async () => {
      // Navmesh should only run on z=14 (micro tiles)
      const tile = createTileAddress(12, 1205, 1531); // Macro tile
      const result = await pipeline.process(tile);

      // Should still succeed but may have different behavior
      expect(result.success).toBe(true);
    });
  });

  describe('Metadata', () => {
    it('should include version in result metadata', async () => {
      const tile = createTileAddress(14, 4823, 6127);
      const result = await pipeline.process(tile);

      expect(result.metadata).toBeDefined();
      expect(result.metadata!.version).toBe(1);
    });
  });
});
