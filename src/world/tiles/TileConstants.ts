/**
 * Tile system constants for the slippy map tile addressing system.
 *
 * Based on the Web Mercator projection (EPSG:3857) used by OSM and similar services.
 * Tile coordinates follow the standard (z, x, y) format where:
 *   - z = zoom level (0 = whole world in one tile)
 *   - x = column from west to east (0 to 2^z - 1)
 *   - y = row from north to south (0 to 2^z - 1)
 */

/**
 * Zoom level definitions for different use cases
 */
export const ZoomLevels = {
  /**
   * Macro tiles for streaming and prefetching.
   * At z=12, each tile is approximately 10km × 10km at the equator.
   * This is the unit of client streaming - players download macro tile manifests.
   */
  MACRO: 12,

  /**
   * Micro tiles for simulation granularity.
   * At z=14, each tile is approximately 2.5km × 2.5km at the equator.
   * This is the unit of simulation - each micro tile has its own state machine.
   * Each macro tile contains 4 micro tiles (2×2 subdivision).
   */
  MICRO: 14,

  /**
   * Detail tiles for fine-grained content placement.
   * At z=16, each tile is approximately 600m × 600m at the equator.
   * Used for precise ruin/POI placement within micro tiles.
   */
  DETAIL: 16,
} as const;

export type ZoomLevel = (typeof ZoomLevels)[keyof typeof ZoomLevels];

/**
 * Approximate tile dimensions in meters at various zoom levels.
 * These are computed at the equator; actual dimensions shrink toward the poles.
 */
export const TileSizeMeters = {
  [ZoomLevels.MACRO]: 9784, // ~10km
  [ZoomLevels.MICRO]: 2446, // ~2.5km
  [ZoomLevels.DETAIL]: 611, // ~600m
} as const;

/**
 * Earth parameters for coordinate calculations
 */
export const EarthConstants = {
  /** Earth's radius in meters (WGS84 semi-major axis) */
  RADIUS_METERS: 6378137,

  /** Earth's circumference at the equator in meters */
  CIRCUMFERENCE_METERS: 2 * Math.PI * 6378137,

  /** Maximum latitude for Web Mercator projection (arctan(sinh(π)) ≈ 85.051°) */
  MAX_LATITUDE: 85.0511287798,

  /** Minimum latitude for Web Mercator projection */
  MIN_LATITUDE: -85.0511287798,
} as const;

/**
 * Tile state machine timings
 */
export const TileStateTimings = {
  /** Minutes before a HOT tile without players downgrades to WARM */
  HOT_TO_WARM_MINUTES: 3,

  /** Minutes before a WARM tile without nearby players downgrades to COLD */
  WARM_TO_COLD_MINUTES: 30,

  /** Prefetch radius in tiles - how far ahead to warm tiles */
  PREFETCH_RADIUS_TILES: 2,

  /** Tick interval for HOT tiles in milliseconds */
  HOT_TICK_MS: 1000,

  /** Tick interval for WARM tiles in milliseconds */
  WARM_TICK_MS: 60000,
} as const;

/**
 * Tile ID format utilities
 */
export const TileIdFormat = {
  /** Separator used in tile IDs */
  SEPARATOR: '_',

  /**
   * Create a tile ID string from coordinates
   */
  toId: (z: number, x: number, y: number): string => `${z}_${x}_${y}`,

  /**
   * Parse a tile ID string into coordinates
   */
  fromId: (id: string): { z: number; x: number; y: number } | null => {
    const parts = id.split('_');
    if (parts.length !== 3) return null;

    const z = parseInt(parts[0], 10);
    const x = parseInt(parts[1], 10);
    const y = parseInt(parts[2], 10);

    if (isNaN(z) || isNaN(x) || isNaN(y)) return null;

    return { z, x, y };
  },
} as const;
