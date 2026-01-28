/**
 * Tile system module exports
 *
 * Provides slippy tile addressing, state management, and utilities
 * for the planet-scale streaming world system.
 */

// Constants
export {
  ZoomLevels,
  TileSizeMeters,
  EarthConstants,
  TileStateTimings,
  TileIdFormat,
  type ZoomLevel,
} from './TileConstants';

// Address types and functions
export {
  type TileAddress,
  type TileBounds,
  type LatLon,
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
  getChildTiles,
  subdivide,
  getParentTile,
} from './TileAddress';

// Utility functions
export {
  latLonToTile,
  tileToLatLonBounds,
  getTileCenter,
  getNeighborTiles,
  getTilesInRadius,
  getMacroTile,
  getMicroTile,
  getMicroTilesInMacro,
  getTileDistance,
  haversineDistance,
  getTileSizeAtLatitude,
  isPointInTile,
  getTilesInBounds,
  worldToLatLon,
  latLonToWorld,
  type WorldToGeoMapping,
} from './TileUtils';

// State machine
export {
  TileState,
  TransitionReason,
  type TileStateData,
  type TransitionResult,
  type TileTransitionEvent,
  createInitialStateData,
  evaluateTransition,
  applyTransition,
  playerEntered,
  playerLeft,
  updateNearbyPlayers,
  getTickInterval,
  createTransitionEvent,
} from './TileState';

// State manager
export { TileStateManager, type TileStateManagerEvents } from './TileStateManager';

// Database service
export {
  TileService,
  TileBuildJobType,
  TileBuildJobStatus,
  type TileData,
} from './TileService';
