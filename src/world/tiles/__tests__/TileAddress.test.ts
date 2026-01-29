/**
 * Tests for TileAddress functions
 */

// Jest globals (describe, it, expect) available automatically
import {
  createTileAddress,
  tileAddressFromId,
  tileAddressToId,
  tilesEqual,
  isValidTile,
  normalizeTile,
  isMacroTile,
  isMicroTile,
  getContainingMacroTile,
  getContainingMicroTile,
  subdivide,
  getParentTile,
  getChildTiles,
} from '../TileAddress';
import { ZoomLevels } from '../TileConstants';

describe('TileAddress', () => {
  describe('createTileAddress', () => {
    it('creates a tile address with correct properties', () => {
      const tile = createTileAddress(12, 100, 200);
      expect(tile.z).toBe(12);
      expect(tile.x).toBe(100);
      expect(tile.y).toBe(200);
    });
  });

  describe('tileAddressToId / tileAddressFromId', () => {
    it('converts tile to ID and back', () => {
      const original = createTileAddress(14, 4823, 6127);
      const id = tileAddressToId(original);
      expect(id).toBe('14_4823_6127');

      const parsed = tileAddressFromId(id);
      expect(parsed).not.toBeNull();
      expect(parsed!.z).toBe(14);
      expect(parsed!.x).toBe(4823);
      expect(parsed!.y).toBe(6127);
    });

    it('returns null for invalid ID formats', () => {
      expect(tileAddressFromId('invalid')).toBeNull();
      expect(tileAddressFromId('12_abc_100')).toBeNull();
      expect(tileAddressFromId('12_100')).toBeNull();
      expect(tileAddressFromId('')).toBeNull();
    });
  });

  describe('tilesEqual', () => {
    it('returns true for equal tiles', () => {
      const a = createTileAddress(12, 100, 200);
      const b = createTileAddress(12, 100, 200);
      expect(tilesEqual(a, b)).toBe(true);
    });

    it('returns false for different tiles', () => {
      const a = createTileAddress(12, 100, 200);
      expect(tilesEqual(a, createTileAddress(13, 100, 200))).toBe(false);
      expect(tilesEqual(a, createTileAddress(12, 101, 200))).toBe(false);
      expect(tilesEqual(a, createTileAddress(12, 100, 201))).toBe(false);
    });
  });

  describe('isValidTile', () => {
    it('validates tiles at zoom 0', () => {
      expect(isValidTile(createTileAddress(0, 0, 0))).toBe(true);
      expect(isValidTile(createTileAddress(0, 1, 0))).toBe(false); // x=1 invalid at z=0
      expect(isValidTile(createTileAddress(0, 0, 1))).toBe(false); // y=1 invalid at z=0
    });

    it('validates tiles at higher zoom levels', () => {
      // At z=12, valid range is 0 to 4095
      expect(isValidTile(createTileAddress(12, 0, 0))).toBe(true);
      expect(isValidTile(createTileAddress(12, 4095, 4095))).toBe(true);
      expect(isValidTile(createTileAddress(12, 4096, 0))).toBe(false);
      expect(isValidTile(createTileAddress(12, -1, 0))).toBe(false);
    });

    it('rejects invalid zoom levels', () => {
      expect(isValidTile(createTileAddress(-1, 0, 0))).toBe(false);
      expect(isValidTile(createTileAddress(25, 0, 0))).toBe(false);
    });
  });

  describe('normalizeTile', () => {
    it('wraps x coordinate', () => {
      // At z=2, valid x is 0-3
      const tile = normalizeTile(createTileAddress(2, 5, 1));
      expect(tile.x).toBe(1); // 5 % 4 = 1
    });

    it('wraps negative x coordinate', () => {
      const tile = normalizeTile(createTileAddress(2, -1, 1));
      expect(tile.x).toBe(3); // -1 + 4 = 3
    });

    it('clamps y coordinate', () => {
      const tile = normalizeTile(createTileAddress(2, 1, 5));
      expect(tile.y).toBe(3); // clamped to max
    });
  });

  describe('isMacroTile / isMicroTile', () => {
    it('correctly identifies macro tiles', () => {
      expect(isMacroTile(createTileAddress(ZoomLevels.MACRO, 100, 200))).toBe(true);
      expect(isMacroTile(createTileAddress(ZoomLevels.MICRO, 100, 200))).toBe(false);
    });

    it('correctly identifies micro tiles', () => {
      expect(isMicroTile(createTileAddress(ZoomLevels.MICRO, 100, 200))).toBe(true);
      expect(isMicroTile(createTileAddress(ZoomLevels.MACRO, 100, 200))).toBe(false);
    });
  });

  describe('getContainingMacroTile', () => {
    it('returns containing macro tile for micro tile', () => {
      // Micro tile at z=14, macro at z=12
      // Scale factor is 2^(14-12) = 4
      const microTile = createTileAddress(14, 400, 800);
      const macroTile = getContainingMacroTile(microTile);

      expect(macroTile).not.toBeNull();
      expect(macroTile!.z).toBe(ZoomLevels.MACRO);
      expect(macroTile!.x).toBe(100); // 400 / 4
      expect(macroTile!.y).toBe(200); // 800 / 4
    });

    it('returns null for tiles at or below macro level', () => {
      expect(getContainingMacroTile(createTileAddress(12, 100, 200))).toBeNull();
      expect(getContainingMacroTile(createTileAddress(10, 50, 100))).toBeNull();
    });
  });

  describe('getContainingMicroTile', () => {
    it('returns containing micro tile for detail tile', () => {
      // Detail at z=16, micro at z=14
      // Scale factor is 2^(16-14) = 4
      const detailTile = createTileAddress(16, 400, 800);
      const microTile = getContainingMicroTile(detailTile);

      expect(microTile).not.toBeNull();
      expect(microTile!.z).toBe(ZoomLevels.MICRO);
      expect(microTile!.x).toBe(100);
      expect(microTile!.y).toBe(200);
    });
  });

  describe('subdivide', () => {
    it('returns 4 children at next zoom level', () => {
      const parent = createTileAddress(12, 10, 20);
      const children = subdivide(parent);

      expect(children).toHaveLength(4);
      expect(children[0]).toEqual({ z: 13, x: 20, y: 40 }); // NW
      expect(children[1]).toEqual({ z: 13, x: 21, y: 40 }); // NE
      expect(children[2]).toEqual({ z: 13, x: 20, y: 41 }); // SW
      expect(children[3]).toEqual({ z: 13, x: 21, y: 41 }); // SE
    });
  });

  describe('getParentTile', () => {
    it('returns parent at previous zoom level', () => {
      const child = createTileAddress(13, 21, 41);
      const parent = getParentTile(child);

      expect(parent).not.toBeNull();
      expect(parent!.z).toBe(12);
      expect(parent!.x).toBe(10);
      expect(parent!.y).toBe(20);
    });

    it('returns null for zoom 0', () => {
      expect(getParentTile(createTileAddress(0, 0, 0))).toBeNull();
    });
  });

  describe('getChildTiles', () => {
    it('returns all children at target zoom', () => {
      const parent = createTileAddress(12, 10, 20);
      const children = getChildTiles(parent, 14);

      // From z=12 to z=14 is 2 levels, so 4^2 = 16 children
      expect(children).toHaveLength(16);

      // First child should be at top-left
      expect(children[0]).toEqual({ z: 14, x: 40, y: 80 });
    });

    it('returns empty array if target zoom is at or below current', () => {
      const tile = createTileAddress(14, 100, 200);
      expect(getChildTiles(tile, 14)).toEqual([]);
      expect(getChildTiles(tile, 12)).toEqual([]);
    });
  });
});
