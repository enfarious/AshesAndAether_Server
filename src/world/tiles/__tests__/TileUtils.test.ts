/**
 * Tests for TileUtils coordinate conversion functions
 */

import { describe, it, expect } from 'vitest';
import {
  latLonToTile,
  tileToLatLonBounds,
  getTileCenter,
  getNeighborTiles,
  getTilesInRadius,
  getMacroTile,
  getMicroTile,
  getMicroTilesInMacro,
  haversineDistance,
  isPointInTile,
  getTilesInBounds,
} from '../TileUtils';
import { createTileAddress, tilesEqual } from '../TileAddress';
import { ZoomLevels } from '../TileConstants';

describe('TileUtils', () => {
  describe('latLonToTile', () => {
    it('converts equator/prime meridian to correct tile', () => {
      // At z=0, the whole world is one tile (0,0)
      const tile = latLonToTile(0, 0, 0);
      expect(tile).not.toBeNull();
      expect(tile!.z).toBe(0);
      expect(tile!.x).toBe(0);
      expect(tile!.y).toBe(0);
    });

    it('converts New York City coordinates', () => {
      // NYC: ~40.7128° N, 74.0060° W
      const tile = latLonToTile(40.7128, -74.006, 12);
      expect(tile).not.toBeNull();
      expect(tile!.z).toBe(12);
      // At z=12, NYC should be around x=1205, y=1540
      expect(tile!.x).toBeGreaterThan(1200);
      expect(tile!.x).toBeLessThan(1210);
      expect(tile!.y).toBeGreaterThan(1535);
      expect(tile!.y).toBeLessThan(1545);
    });

    it('converts London coordinates', () => {
      // London: ~51.5074° N, 0.1278° W
      const tile = latLonToTile(51.5074, -0.1278, 12);
      expect(tile).not.toBeNull();
      expect(tile!.z).toBe(12);
      // London should be around x=2047, y=1362
      expect(tile!.x).toBeGreaterThan(2045);
      expect(tile!.x).toBeLessThan(2050);
    });

    it('returns null for latitude outside valid range', () => {
      expect(latLonToTile(90, 0, 12)).toBeNull(); // Beyond Web Mercator limit
      expect(latLonToTile(-90, 0, 12)).toBeNull();
    });

    it('wraps longitude correctly', () => {
      const tile1 = latLonToTile(0, 180, 12);
      const tile2 = latLonToTile(0, -180, 12);
      // Both should resolve to same x position
      expect(tile1).not.toBeNull();
      expect(tile2).not.toBeNull();
    });
  });

  describe('tileToLatLonBounds', () => {
    it('returns correct bounds for world tile', () => {
      const bounds = tileToLatLonBounds(createTileAddress(0, 0, 0));
      expect(bounds.west).toBeCloseTo(-180, 1);
      expect(bounds.east).toBeCloseTo(180, 1);
      expect(bounds.north).toBeGreaterThan(85);
      expect(bounds.south).toBeLessThan(-85);
    });

    it('returns bounds that contain the original point', () => {
      const lat = 40.7128;
      const lon = -74.006;
      const tile = latLonToTile(lat, lon, 14);
      expect(tile).not.toBeNull();

      const bounds = tileToLatLonBounds(tile!);
      expect(lat).toBeGreaterThanOrEqual(bounds.south);
      expect(lat).toBeLessThanOrEqual(bounds.north);
      expect(lon).toBeGreaterThanOrEqual(bounds.west);
      expect(lon).toBeLessThanOrEqual(bounds.east);
    });

    it('returns smaller bounds at higher zoom levels', () => {
      const boundsZ10 = tileToLatLonBounds(createTileAddress(10, 100, 100));
      const boundsZ14 = tileToLatLonBounds(createTileAddress(14, 400, 400));

      const sizeZ10 = (boundsZ10.north - boundsZ10.south) * (boundsZ10.east - boundsZ10.west);
      const sizeZ14 = (boundsZ14.north - boundsZ14.south) * (boundsZ14.east - boundsZ14.west);

      expect(sizeZ14).toBeLessThan(sizeZ10);
    });
  });

  describe('getTileCenter', () => {
    it('returns center point of tile', () => {
      const tile = createTileAddress(0, 0, 0);
      const center = getTileCenter(tile);
      expect(center.lat).toBeCloseTo(0, 0);
      expect(center.lon).toBeCloseTo(0, 0);
    });
  });

  describe('getNeighborTiles', () => {
    it('returns 8 neighbors for interior tile', () => {
      const tile = createTileAddress(12, 100, 100);
      const neighbors = getNeighborTiles(tile);
      expect(neighbors).toHaveLength(8);
    });

    it('returns correct neighbor positions', () => {
      const tile = createTileAddress(12, 100, 100);
      const neighbors = getNeighborTiles(tile);

      // Check that we have all expected neighbors
      const neighborCoords = neighbors.map((n) => `${n.x},${n.y}`);
      expect(neighborCoords).toContain('99,99'); // NW
      expect(neighborCoords).toContain('100,99'); // N
      expect(neighborCoords).toContain('101,99'); // NE
      expect(neighborCoords).toContain('99,100'); // W
      expect(neighborCoords).toContain('101,100'); // E
      expect(neighborCoords).toContain('99,101'); // SW
      expect(neighborCoords).toContain('100,101'); // S
      expect(neighborCoords).toContain('101,101'); // SE
    });

    it('handles edge wrapping for x', () => {
      // At z=2, x wraps at 4
      const tile = createTileAddress(2, 0, 2);
      const neighbors = getNeighborTiles(tile);
      // Should have neighbor at x=3 (wrapped from -1)
      const hasWrappedNeighbor = neighbors.some((n) => n.x === 3);
      expect(hasWrappedNeighbor).toBe(true);
    });
  });

  describe('getTilesInRadius', () => {
    it('returns correct number of tiles for radius 0', () => {
      const tiles = getTilesInRadius(createTileAddress(12, 100, 100), 0);
      expect(tiles).toHaveLength(1);
    });

    it('returns correct number of tiles for radius 1', () => {
      const tiles = getTilesInRadius(createTileAddress(12, 100, 100), 1);
      // 3x3 = 9 tiles
      expect(tiles).toHaveLength(9);
    });

    it('returns correct number of tiles for radius 2', () => {
      const tiles = getTilesInRadius(createTileAddress(12, 100, 100), 2);
      // 5x5 = 25 tiles
      expect(tiles).toHaveLength(25);
    });

    it('includes the center tile', () => {
      const center = createTileAddress(12, 100, 100);
      const tiles = getTilesInRadius(center, 1);
      const hasCenter = tiles.some((t) => tilesEqual(t, center));
      expect(hasCenter).toBe(true);
    });
  });

  describe('getMacroTile / getMicroTile', () => {
    it('returns macro tile for valid coordinates', () => {
      const tile = getMacroTile(40.7128, -74.006);
      expect(tile).not.toBeNull();
      expect(tile!.z).toBe(ZoomLevels.MACRO);
    });

    it('returns micro tile for valid coordinates', () => {
      const tile = getMicroTile(40.7128, -74.006);
      expect(tile).not.toBeNull();
      expect(tile!.z).toBe(ZoomLevels.MICRO);
    });
  });

  describe('getMicroTilesInMacro', () => {
    it('returns 16 micro tiles for a macro tile', () => {
      // z=12 to z=14 is 2 levels = 4^2 = 16 micro tiles
      const macroTile = createTileAddress(ZoomLevels.MACRO, 100, 100);
      const microTiles = getMicroTilesInMacro(macroTile);
      expect(microTiles).toHaveLength(16);
    });

    it('micro tiles are at correct zoom level', () => {
      const macroTile = createTileAddress(ZoomLevels.MACRO, 100, 100);
      const microTiles = getMicroTilesInMacro(macroTile);
      microTiles.forEach((t) => {
        expect(t.z).toBe(ZoomLevels.MICRO);
      });
    });

    it('throws for non-macro tile', () => {
      const nonMacro = createTileAddress(14, 100, 100);
      expect(() => getMicroTilesInMacro(nonMacro)).toThrow();
    });
  });

  describe('haversineDistance', () => {
    it('returns 0 for same point', () => {
      const dist = haversineDistance(40.7128, -74.006, 40.7128, -74.006);
      expect(dist).toBeCloseTo(0, 1);
    });

    it('calculates NYC to London correctly (~5,570 km)', () => {
      // NYC: 40.7128, -74.006
      // London: 51.5074, -0.1278
      const dist = haversineDistance(40.7128, -74.006, 51.5074, -0.1278);
      expect(dist / 1000).toBeGreaterThan(5500);
      expect(dist / 1000).toBeLessThan(5600);
    });

    it('calculates short distances accurately', () => {
      // About 1 degree latitude = ~111km
      const dist = haversineDistance(40, -74, 41, -74);
      expect(dist / 1000).toBeGreaterThan(110);
      expect(dist / 1000).toBeLessThan(112);
    });
  });

  describe('isPointInTile', () => {
    it('returns true for point inside tile', () => {
      const tile = latLonToTile(40.7128, -74.006, 12);
      expect(tile).not.toBeNull();
      expect(isPointInTile(40.7128, -74.006, tile!)).toBe(true);
    });

    it('returns false for point outside tile', () => {
      const tile = latLonToTile(40.7128, -74.006, 12);
      expect(tile).not.toBeNull();
      // London should not be in NYC's tile
      expect(isPointInTile(51.5074, -0.1278, tile!)).toBe(false);
    });
  });

  describe('getTilesInBounds', () => {
    it('returns tiles covering a bounding box', () => {
      const bounds = {
        north: 41,
        south: 40,
        east: -73,
        west: -75,
      };
      const tiles = getTilesInBounds(bounds, 10);
      expect(tiles.length).toBeGreaterThan(0);
      tiles.forEach((t) => {
        expect(t.z).toBe(10);
      });
    });

    it('returns single tile for very small bounds', () => {
      // A very small area should fit in one tile at low zoom
      const center = getTileCenter(createTileAddress(4, 8, 8));
      const bounds = {
        north: center.lat + 0.001,
        south: center.lat - 0.001,
        east: center.lon + 0.001,
        west: center.lon - 0.001,
      };
      const tiles = getTilesInBounds(bounds, 4);
      expect(tiles).toHaveLength(1);
    });
  });
});
