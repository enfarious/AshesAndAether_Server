/**
 * TileAddress - Core addressing type for the slippy tile system.
 *
 * Represents a tile in the Web Mercator grid using (z, x, y) coordinates.
 */

import { ZoomLevels, TileIdFormat, type ZoomLevel } from './TileConstants';

/**
 * A tile address in the slippy map coordinate system.
 */
export interface TileAddress {
  /** Zoom level (0 = world, higher = more detail) */
  z: number;
  /** X coordinate (column from west to east) */
  x: number;
  /** Y coordinate (row from north to south) */
  y: number;
}

/**
 * Latitude/longitude bounds of a tile
 */
export interface TileBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/**
 * A geographic coordinate
 */
export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Create a TileAddress from components
 */
export function createTileAddress(z: number, x: number, y: number): TileAddress {
  return { z, x, y };
}

/**
 * Create a TileAddress from a tile ID string
 */
export function tileAddressFromId(id: string): TileAddress | null {
  const parsed = TileIdFormat.fromId(id);
  if (!parsed) return null;
  return createTileAddress(parsed.z, parsed.x, parsed.y);
}

/**
 * Convert a TileAddress to a tile ID string
 */
export function tileAddressToId(tile: TileAddress): string {
  return TileIdFormat.toId(tile.z, tile.x, tile.y);
}

/**
 * Check if two tile addresses are equal
 */
export function tilesEqual(a: TileAddress, b: TileAddress): boolean {
  return a.z === b.z && a.x === b.x && a.y === b.y;
}

/**
 * Check if a tile address is valid for its zoom level
 */
export function isValidTile(tile: TileAddress): boolean {
  if (tile.z < 0 || tile.z > 24) return false;
  const maxCoord = Math.pow(2, tile.z);
  if (tile.x < 0 || tile.x >= maxCoord) return false;
  if (tile.y < 0 || tile.y >= maxCoord) return false;
  return true;
}

/**
 * Normalize tile coordinates to valid range (wrap around for x, clamp for y)
 */
export function normalizeTile(tile: TileAddress): TileAddress {
  const maxCoord = Math.pow(2, tile.z);
  let x = tile.x % maxCoord;
  if (x < 0) x += maxCoord;

  const y = Math.max(0, Math.min(maxCoord - 1, tile.y));

  return { z: tile.z, x, y };
}

/**
 * Check if a tile is a macro tile (streaming unit)
 */
export function isMacroTile(tile: TileAddress): boolean {
  return tile.z === ZoomLevels.MACRO;
}

/**
 * Check if a tile is a micro tile (simulation unit)
 */
export function isMicroTile(tile: TileAddress): boolean {
  return tile.z === ZoomLevels.MICRO;
}

/**
 * Get the macro tile containing a given tile
 * Returns null if the tile is already at or below macro level
 */
export function getContainingMacroTile(tile: TileAddress): TileAddress | null {
  if (tile.z <= ZoomLevels.MACRO) return null;

  const zoomDiff = tile.z - ZoomLevels.MACRO;
  const scale = Math.pow(2, zoomDiff);

  return {
    z: ZoomLevels.MACRO,
    x: Math.floor(tile.x / scale),
    y: Math.floor(tile.y / scale),
  };
}

/**
 * Get the micro tile containing a given tile
 * Returns null if the tile is already at or below micro level
 */
export function getContainingMicroTile(tile: TileAddress): TileAddress | null {
  if (tile.z <= ZoomLevels.MICRO) return null;

  const zoomDiff = tile.z - ZoomLevels.MICRO;
  const scale = Math.pow(2, zoomDiff);

  return {
    z: ZoomLevels.MICRO,
    x: Math.floor(tile.x / scale),
    y: Math.floor(tile.y / scale),
  };
}

/**
 * Get all child tiles at a specific zoom level
 */
export function getChildTiles(tile: TileAddress, targetZoom: ZoomLevel): TileAddress[] {
  if (targetZoom <= tile.z) return [];

  const zoomDiff = targetZoom - tile.z;
  const scale = Math.pow(2, zoomDiff);

  const children: TileAddress[] = [];
  const baseX = tile.x * scale;
  const baseY = tile.y * scale;

  for (let dy = 0; dy < scale; dy++) {
    for (let dx = 0; dx < scale; dx++) {
      children.push({
        z: targetZoom,
        x: baseX + dx,
        y: baseY + dy,
      });
    }
  }

  return children;
}

/**
 * Get the 4 immediate children (one zoom level deeper)
 */
export function subdivide(tile: TileAddress): TileAddress[] {
  const childZ = tile.z + 1;
  const childX = tile.x * 2;
  const childY = tile.y * 2;

  return [
    { z: childZ, x: childX, y: childY }, // NW
    { z: childZ, x: childX + 1, y: childY }, // NE
    { z: childZ, x: childX, y: childY + 1 }, // SW
    { z: childZ, x: childX + 1, y: childY + 1 }, // SE
  ];
}

/**
 * Get the parent tile (one zoom level up)
 */
export function getParentTile(tile: TileAddress): TileAddress | null {
  if (tile.z === 0) return null;

  return {
    z: tile.z - 1,
    x: Math.floor(tile.x / 2),
    y: Math.floor(tile.y / 2),
  };
}
