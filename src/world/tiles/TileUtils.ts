/**
 * TileUtils - Coordinate conversion and spatial query utilities.
 *
 * Implements Web Mercator (EPSG:3857) tile addressing conversions.
 */

import { EarthConstants, ZoomLevels, TileSizeMeters } from './TileConstants';
import {
  type TileAddress,
  type TileBounds,
  type LatLon,
  createTileAddress,
  normalizeTile,
  isValidTile,
} from './TileAddress';

/**
 * Convert latitude/longitude to tile coordinates at a given zoom level.
 *
 * @param lat Latitude in degrees (-85.05 to 85.05)
 * @param lon Longitude in degrees (-180 to 180)
 * @param zoom Zoom level (0-24)
 * @returns TileAddress or null if coordinates are out of range
 */
export function latLonToTile(lat: number, lon: number, zoom: number): TileAddress | null {
  // Clamp latitude to valid range
  if (lat > EarthConstants.MAX_LATITUDE || lat < EarthConstants.MIN_LATITUDE) {
    return null;
  }

  // Normalize longitude to -180 to 180
  let normalizedLon = lon;
  while (normalizedLon > 180) normalizedLon -= 360;
  while (normalizedLon < -180) normalizedLon += 360;

  const n = Math.pow(2, zoom);
  const latRad = (lat * Math.PI) / 180;

  const x = Math.floor(((normalizedLon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);

  return normalizeTile(createTileAddress(zoom, x, y));
}

/**
 * Convert tile coordinates to latitude/longitude bounds.
 *
 * @param tile The tile address
 * @returns TileBounds with north, south, east, west edges
 */
export function tileToLatLonBounds(tile: TileAddress): TileBounds {
  const n = Math.pow(2, tile.z);

  const west = (tile.x / n) * 360 - 180;
  const east = ((tile.x + 1) / n) * 360 - 180;

  const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * tile.y) / n))) * 180) / Math.PI;
  const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + 1)) / n))) * 180) / Math.PI;

  return { north, south, east, west };
}

/**
 * Get the center point of a tile.
 */
export function getTileCenter(tile: TileAddress): LatLon {
  const bounds = tileToLatLonBounds(tile);
  return {
    lat: (bounds.north + bounds.south) / 2,
    lon: (bounds.east + bounds.west) / 2,
  };
}

/**
 * Get all 8 neighbor tiles (or fewer at edges).
 */
export function getNeighborTiles(tile: TileAddress): TileAddress[] {
  const neighbors: TileAddress[] = [];
  const offsets = [
    [-1, -1],
    [0, -1],
    [1, -1], // Top row
    [-1, 0],
    [1, 0], // Middle row (excluding center)
    [-1, 1],
    [0, 1],
    [1, 1], // Bottom row
  ];

  for (const [dx, dy] of offsets) {
    const neighbor = normalizeTile({
      z: tile.z,
      x: tile.x + dx,
      y: tile.y + dy,
    });

    if (isValidTile(neighbor)) {
      neighbors.push(neighbor);
    }
  }

  return neighbors;
}

/**
 * Get all tiles within a given radius (in tile units) of a center tile.
 * Includes the center tile.
 */
export function getTilesInRadius(center: TileAddress, radius: number): TileAddress[] {
  const tiles: TileAddress[] = [];

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const candidate = normalizeTile({
        z: center.z,
        x: center.x + dx,
        y: center.y + dy,
      });

      if (isValidTile(candidate)) {
        tiles.push(candidate);
      }
    }
  }

  return tiles;
}

/**
 * Get the tile containing a specific lat/lon at the macro zoom level.
 */
export function getMacroTile(lat: number, lon: number): TileAddress | null {
  return latLonToTile(lat, lon, ZoomLevels.MACRO);
}

/**
 * Get the tile containing a specific lat/lon at the micro zoom level.
 */
export function getMicroTile(lat: number, lon: number): TileAddress | null {
  return latLonToTile(lat, lon, ZoomLevels.MICRO);
}

/**
 * Get all micro tiles within a macro tile.
 */
export function getMicroTilesInMacro(macroTile: TileAddress): TileAddress[] {
  if (macroTile.z !== ZoomLevels.MACRO) {
    throw new Error(`Expected macro tile at z=${ZoomLevels.MACRO}, got z=${macroTile.z}`);
  }

  const zoomDiff = ZoomLevels.MICRO - ZoomLevels.MACRO;
  const scale = Math.pow(2, zoomDiff); // 4 for z12→z14

  const microTiles: TileAddress[] = [];
  const baseX = macroTile.x * scale;
  const baseY = macroTile.y * scale;

  for (let dy = 0; dy < scale; dy++) {
    for (let dx = 0; dx < scale; dx++) {
      microTiles.push({
        z: ZoomLevels.MICRO,
        x: baseX + dx,
        y: baseY + dy,
      });
    }
  }

  return microTiles;
}

/**
 * Calculate the approximate distance in meters between two tiles at the same zoom level.
 * Uses the center points of each tile.
 */
export function getTileDistance(a: TileAddress, b: TileAddress): number {
  if (a.z !== b.z) {
    throw new Error('Tiles must be at the same zoom level');
  }

  const centerA = getTileCenter(a);
  const centerB = getTileCenter(b);

  return haversineDistance(centerA.lat, centerA.lon, centerB.lat, centerB.lon);
}

/**
 * Calculate the haversine distance between two points in meters.
 */
export function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = EarthConstants.RADIUS_METERS;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Get the approximate tile size in meters at a given latitude.
 * Tile size decreases toward the poles.
 */
export function getTileSizeAtLatitude(zoom: number, latitude: number): number {
  const baseSize = TileSizeMeters[zoom as keyof typeof TileSizeMeters];
  if (!baseSize) {
    // Calculate for non-standard zoom levels
    const equatorSize = EarthConstants.CIRCUMFERENCE_METERS / Math.pow(2, zoom);
    return equatorSize * Math.cos((latitude * Math.PI) / 180);
  }
  return baseSize * Math.cos((latitude * Math.PI) / 180);
}

/**
 * Check if a point is within a tile's bounds.
 */
export function isPointInTile(lat: number, lon: number, tile: TileAddress): boolean {
  const bounds = tileToLatLonBounds(tile);

  return lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east;
}

/**
 * Get all tiles that overlap with a bounding box.
 */
export function getTilesInBounds(bounds: TileBounds, zoom: number): TileAddress[] {
  const nwTile = latLonToTile(bounds.north, bounds.west, zoom);
  const seTile = latLonToTile(bounds.south, bounds.east, zoom);

  if (!nwTile || !seTile) return [];

  const tiles: TileAddress[] = [];

  for (let y = nwTile.y; y <= seTile.y; y++) {
    for (let x = nwTile.x; x <= seTile.x; x++) {
      tiles.push(createTileAddress(zoom, x, y));
    }
  }

  return tiles;
}

/**
 * Convert game world coordinates (x, z) to lat/lon.
 * Assumes a reference point is set for the game world.
 *
 * This is a placeholder - the actual conversion will depend on
 * how we decide to map game coordinates to real-world coordinates.
 */
export interface WorldToGeoMapping {
  /** Reference point in game world */
  worldOrigin: { x: number; z: number };
  /** Reference point in lat/lon */
  geoOrigin: LatLon;
  /** Meters per game unit */
  metersPerUnit: number;
}

/**
 * Convert game world coordinates to lat/lon using a mapping.
 */
export function worldToLatLon(
  worldX: number,
  worldZ: number,
  mapping: WorldToGeoMapping
): LatLon {
  // Calculate offset from origin in meters
  const offsetX = (worldX - mapping.worldOrigin.x) * mapping.metersPerUnit;
  const offsetZ = (worldZ - mapping.worldOrigin.z) * mapping.metersPerUnit;

  // Convert meter offset to degree offset (approximate)
  // 1 degree latitude ≈ 111,320 meters
  // 1 degree longitude ≈ 111,320 * cos(lat) meters
  const latOffset = offsetZ / 111320;
  const lonOffset = offsetX / (111320 * Math.cos((mapping.geoOrigin.lat * Math.PI) / 180));

  return {
    lat: mapping.geoOrigin.lat + latOffset,
    lon: mapping.geoOrigin.lon + lonOffset,
  };
}

/**
 * Convert lat/lon to game world coordinates using a mapping.
 */
export function latLonToWorld(
  lat: number,
  lon: number,
  mapping: WorldToGeoMapping
): { x: number; z: number } {
  // Calculate degree offset from origin
  const latOffset = lat - mapping.geoOrigin.lat;
  const lonOffset = lon - mapping.geoOrigin.lon;

  // Convert to meters
  const offsetZ = latOffset * 111320;
  const offsetX = lonOffset * 111320 * Math.cos((mapping.geoOrigin.lat * Math.PI) / 180);

  // Convert to game units
  return {
    x: mapping.worldOrigin.x + offsetX / mapping.metersPerUnit,
    z: mapping.worldOrigin.z + offsetZ / mapping.metersPerUnit,
  };
}
