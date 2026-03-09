/**
 * VaultTileGrid — Procedural cave generation using cellular automata.
 *
 * Pure-function module: no I/O, no side effects.  Takes parameters,
 * returns a tile grid with floor/wall layout, entrance/exit positions,
 * and collision geometry for the physics system.
 *
 * Algorithm (B5678/S45678 cellular automata):
 *   1. Random fill with configurable wall probability
 *   2. Iterative smoothing — cells become/stay wall based on neighbor count
 *   3. Flood fill to isolate the largest contiguous cave
 *   4. Place entrance (north-biased) and exit (south-biased) at max distance
 */

// ── Tile values (packed into Uint8Array) ────────────────────────────────────

export const Tile = {
  VOID:  0,
  FLOOR: 1,
  WALL:  2,
} as const;
export type TileValue = (typeof Tile)[keyof typeof Tile];

// ── Generation parameters ───────────────────────────────────────────────────

/**
 * Per-room cellular-automata overrides.
 * Any field left undefined falls back to the parent VaultGenParams value.
 */
export interface RoomDigOverrides {
  wallChance?: number;
  smoothIterations?: number;
  minFloorRatio?: number;
}

export interface VaultGenParams {
  /** Probability (0-1) a cell starts as wall in initial fill. Default 0.45. */
  wallChance: number;
  /** Number of CA smoothing passes. Default 5. */
  smoothIterations: number;
  /** Minimum floor ratio — retry if below. Default 0.35. */
  minFloorRatio: number;
  /**
   * Per-room-type CA overrides. Each key maps a RoomType to dig params
   * that override the base wallChance / smoothIterations / minFloorRatio.
   */
  roomDigOverrides?: Partial<Record<RoomType, RoomDigOverrides>>;
  /** Optional deterministic seed. */
  seed?: number;
  /** Total number of rooms to generate. Default 1 (single cave). */
  roomCount?: number;
  /** Number of columns in the room grid layout. Default: roomCount (single row). */
  roomCols?: number;
  /** Width of corridors connecting rooms, in tiles. Default 3. */
  corridorWidth?: number;
  /**
   * Random size range [min, max] in tiles for regular (TRASH) rooms.
   * Each room gets an independent random width and height from this range.
   * When omitted, rooms are sized uniformly from the grid dimensions.
   */
  roomSizeRange?: [number, number];
  /**
   * Random size range [min, max] for the ENTRY room.
   * Falls back to roomSizeRange if omitted.
   */
  entryRoomSizeRange?: [number, number];
  /**
   * Random size range [min, max] for the SUB_BOSS room.
   * Falls back to bossRoomSizeRange → roomSizeRange if omitted.
   */
  subBossRoomSizeRange?: [number, number];
  /**
   * Random size range [min, max] in tiles for the BOSS room.
   * Falls back to roomSizeRange if omitted.
   */
  bossRoomSizeRange?: [number, number];
  /** Room indices (serpentine order) that use bossRoomSizeRange. */
  bossRoomIndices?: number[];
  /**
   * Corridor indices that have gates (locked barriers).
   * Corridor i connects room[i] to room[i+1] in serpentine order.
   * Gate opens when room[i] is cleared.
   */
  gatedCorridors?: number[];
  /**
   * Vault tier (1, 2, 3, ...). Determines room count and types when using
   * chain-based generation. T1 = 5 rooms, T2 = 7, T3 = 9, etc.
   */
  tier?: number;
  /** Use chain-based layout instead of serpentine grid. Default false. */
  chain?: boolean;
  /**
   * Per-room-index dig overrides (highest priority).
   * Set by trash variant system — overrides both base and per-type values.
   * Index matches room order from _buildRoomTypeSequence().
   */
  perRoomDigOverrides?: Array<RoomDigOverrides | undefined>;
  /**
   * Per-room-index size range overrides.
   * Index matches room order from _buildRoomTypeSequence().
   */
  perRoomSizeOverrides?: Array<[number, number] | undefined>;
  /** Length of corridors between rooms in tiles. Default 8. */
  corridorLength?: number;
}

// ── Output types ────────────────────────────────────────────────────────────

export interface VaultGateDef {
  /** Corridor index (between room[i] and room[i+1] in serpentine order). */
  corridorIndex: number;
  /** Tile positions forming the gate barrier. */
  tiles: Array<{ row: number; col: number }>;
  /** World-space center of the gate. */
  position: { x: number; z: number };
  /** Direction of the corridor this gate blocks. */
  orientation: 'horizontal' | 'vertical';
}

export interface VaultTileGridData {
  width:    number;
  height:   number;
  tileSize: number;      // always 2.0m
  tiles:    Uint8Array;  // row-major: row=Z, col=X
  entrance: { x: number; z: number };
  exit:     { x: number; z: number };
  /** World-space center of each room (multi-room grids only). */
  roomCenters?: Array<{ x: number; z: number }>;
  /** World-space dimensions of each room (parallel to roomCenters). */
  roomSizes?: Array<{ width: number; height: number }>;
  /** Gate barriers placed in corridors (multi-room grids only). */
  gates?: VaultGateDef[];
  /** 3D vault geometry config (walls, ceiling). */
  geometry?: VaultGeometry;
}

export interface VaultGeometry {
  /** Height of perimeter walls in world units (metres). */
  wallHeight: number;
  /** Height of the ceiling at the dome's apex in world units (metres). */
  ceilingHeight: number;
  /** Ceiling shape. 'dome' interpolates from wallHeight at edges → ceilingHeight at center. */
  ceilingType: 'dome' | 'flat';
}

export interface WallSegment {
  ax: number; az: number;
  bx: number; bz: number;
}

export const TILE_SIZE = 2.0;

// ── Seedable PRNG (mulberry32) ──────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

// ── Chain-based generation types ────────────────────────────────────────────

export type RoomType = 'ENTRY' | 'TRASH' | 'SUB_BOSS' | 'BOSS';
type Direction = 'N' | 'S' | 'E' | 'W';

interface ChainRoom {
  type: RoomType;
  w: number;
  h: number;
  /** Top-left corner in abstract tile space (may be negative before normalization). */
  col: number;
  row: number;
  /** Direction the corridor FROM the previous room arrives at this room. */
  entryDir?: Direction;
}

// ── Core generation ─────────────────────────────────────────────────────────

export function generateVaultGrid(
  widthTiles:  number,
  heightTiles: number,
  params:      VaultGenParams,
  instanceId?: string,
): VaultTileGridData {
  // Delegate to chain-based generator when chain flag is set
  if (params.chain && params.tier != null) {
    return generateChainVault(params, instanceId);
  }

  // Delegate to multi-room generator when roomCount > 1
  if (params.roomCount && params.roomCount > 1) {
    return generateMultiRoomGrid(widthTiles, heightTiles, params, instanceId);
  }

  const seed = params.seed ?? (instanceId ? seedFromString(instanceId) : Date.now());
  const rng  = mulberry32(seed);
  const total = widthTiles * heightTiles;

  const MAX_ATTEMPTS = 10;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const tiles = _randomFill(widthTiles, heightTiles, params.wallChance, rng);
    _smoothCA(tiles, widthTiles, heightTiles, params.smoothIterations);
    _keepLargestCave(tiles, widthTiles, heightTiles);

    // Validate floor ratio
    let floorCount = 0;
    for (let i = 0; i < total; i++) {
      if (tiles[i] === Tile.FLOOR) floorCount++;
    }
    if (floorCount / total < params.minFloorRatio) continue;

    // Place entrance and exit
    const { entrance, exit } = _placeEntranceExit(tiles, widthTiles, heightTiles);

    return { width: widthTiles, height: heightTiles, tileSize: TILE_SIZE, tiles, entrance, exit };
  }

  // Fallback: rectangular room
  return _fallbackRoom(widthTiles, heightTiles);
}

// ── Step 1: Random fill ─────────────────────────────────────────────────────

function _randomFill(
  w: number, h: number, wallChance: number, rng: () => number,
): Uint8Array {
  const tiles = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const idx = row * w + col;
      // Force 1-tile wall border
      if (row === 0 || row === h - 1 || col === 0 || col === w - 1) {
        tiles[idx] = Tile.WALL;
      } else {
        tiles[idx] = rng() < wallChance ? Tile.WALL : Tile.FLOOR;
      }
    }
  }
  return tiles;
}

// ── Step 2: Cellular automata smoothing (B5678/S45678) ──────────────────────

function _smoothCA(tiles: Uint8Array, w: number, h: number, iterations: number): void {
  const buf = new Uint8Array(w * h);

  for (let iter = 0; iter < iterations; iter++) {
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const idx = row * w + col;
        const walls = _countWallNeighbors(tiles, w, h, col, row);
        const isWall = tiles[idx] === Tile.WALL;

        if (isWall) {
          // Survival: wall stays if ≥4 wall neighbors
          buf[idx] = walls >= 4 ? Tile.WALL : Tile.FLOOR;
        } else {
          // Birth: floor becomes wall if ≥5 wall neighbors
          buf[idx] = walls >= 5 ? Tile.WALL : Tile.FLOOR;
        }
      }
    }
    // Swap: copy buf → tiles
    tiles.set(buf);
  }
}

function _countWallNeighbors(
  tiles: Uint8Array, w: number, h: number, cx: number, cy: number,
): number {
  let count = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      // Out of bounds counts as wall
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
        count++;
      } else if (tiles[ny * w + nx] === Tile.WALL) {
        count++;
      }
    }
  }
  return count;
}

// ── Step 3: Flood fill — keep largest contiguous floor region ────────────────

function _keepLargestCave(tiles: Uint8Array, w: number, h: number): void {
  const total = w * h;
  const visited = new Uint8Array(total);
  let bestRegion: number[] = [];

  for (let i = 0; i < total; i++) {
    if (tiles[i] !== Tile.FLOOR || visited[i]) continue;

    // BFS from this floor cell
    const region: number[] = [];
    const queue: number[] = [i];
    visited[i] = 1;

    while (queue.length > 0) {
      const idx = queue.pop()!;
      region.push(idx);
      const col = idx % w;
      const row = (idx - col) / w;

      // 4-connected neighbors
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = col + dx;
        const ny = row + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (tiles[ni] === Tile.FLOOR && !visited[ni]) {
          visited[ni] = 1;
          queue.push(ni);
        }
      }
    }

    if (region.length > bestRegion.length) {
      bestRegion = region;
    }
  }

  // Convert all floor tiles NOT in the best region to wall
  const bestSet = new Set(bestRegion);
  for (let i = 0; i < total; i++) {
    if (tiles[i] === Tile.FLOOR && !bestSet.has(i)) {
      tiles[i] = Tile.WALL;
    }
  }
}

// ── Step 4: Place entrance and exit ─────────────────────────────────────────

function _placeEntranceExit(
  tiles: Uint8Array, w: number, h: number,
): { entrance: { x: number; z: number }; exit: { x: number; z: number } } {
  // Collect all floor tiles
  const floors: Array<{ col: number; row: number }> = [];
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      if (tiles[row * w + col] === Tile.FLOOR) {
        floors.push({ col, row });
      }
    }
  }

  if (floors.length < 2) {
    // Degenerate — shouldn't happen with minFloorRatio check
    return {
      entrance: tileToWorld(1, 1, w, h),
      exit:     tileToWorld(w - 2, h - 2, w, h),
    };
  }

  // Find pair with maximum distance
  let bestDist = 0;
  let bestA = floors[0]!;
  let bestB = floors[1]!;

  // Sample up to 200 random pairs for speed (full O(n²) too slow for large grids)
  const sampleCount = Math.min(floors.length, 200);
  for (let i = 0; i < sampleCount; i++) {
    for (let j = i + 1; j < sampleCount; j++) {
      const a = floors[i]!;
      const b = floors[j]!;
      const dx = a.col - b.col;
      const dz = a.row - b.row;
      const dist = dx * dx + dz * dz;
      if (dist > bestDist) {
        bestDist = dist;
        bestA = a;
        bestB = b;
      }
    }
  }

  // North-biased (lower row) = entrance
  const [entr, ext] = bestA.row <= bestB.row ? [bestA, bestB] : [bestB, bestA];

  return {
    entrance: tileToWorld(entr.col, entr.row, w, h),
    exit:     tileToWorld(ext.col,  ext.row,  w, h),
  };
}

// ── Fallback: simple rectangular room ───────────────────────────────────────

function _fallbackRoom(w: number, h: number): VaultTileGridData {
  const tiles = new Uint8Array(w * h);
  tiles.fill(Tile.WALL);

  // Carve out a rectangle leaving a 2-tile border
  const margin = 2;
  for (let row = margin; row < h - margin; row++) {
    for (let col = margin; col < w - margin; col++) {
      tiles[row * w + col] = Tile.FLOOR;
    }
  }

  return {
    width: w,
    height: h,
    tileSize: TILE_SIZE,
    tiles,
    entrance: tileToWorld(w >> 1, margin + 1, w, h),
    exit:     tileToWorld(w >> 1, h - margin - 2, w, h),
  };
}

// ── Coordinate helpers ──────────────────────────────────────────────────────

/** Convert tile grid coords to world-space position (centered at origin). */
export function tileToWorld(
  col: number, row: number, gridW: number, gridH: number,
): { x: number; z: number } {
  return {
    x: (col - gridW / 2) * TILE_SIZE + TILE_SIZE / 2,
    z: (row - gridH / 2) * TILE_SIZE + TILE_SIZE / 2,
  };
}

/** Convert world-space position to tile grid coords. */
export function worldToTile(
  wx: number, wz: number, gridW: number, gridH: number,
): { col: number; row: number } {
  return {
    col: Math.floor((wx / TILE_SIZE) + gridW / 2),
    row: Math.floor((wz / TILE_SIZE) + gridH / 2),
  };
}

// ── Spawn position helpers ──────────────────────────────────────────────────

/**
 * Find `count` floor tiles near `anchor` that are at least `minSpacing` apart.
 * Returns world-space positions with y=0.
 *
 * @param maxDistance  Optional maximum distance (world units) from anchor.
 *                    Use this in multi-room vaults to keep spawns inside
 *                    a single room instead of bleeding into corridors/neighbors.
 */
export function getSpawnPositions(
  grid:       VaultTileGridData,
  anchor:     { x: number; z: number },
  count:      number,
  minSpacing: number,
  maxDistance?: number,
): Array<{ x: number; y: number; z: number }> {
  const maxDistSq = maxDistance != null ? maxDistance * maxDistance : Infinity;

  // Collect floor tiles within maxDistance of anchor
  const candidates: Array<{ x: number; z: number; dist: number }> = [];
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      if (grid.tiles[row * grid.width + col] !== Tile.FLOOR) continue;
      const pos = tileToWorld(col, row, grid.width, grid.height);
      const dx = pos.x - anchor.x;
      const dz = pos.z - anchor.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > maxDistSq) continue;
      candidates.push({ x: pos.x, z: pos.z, dist: Math.sqrt(distSq) });
    }
  }

  // Sort by distance to anchor (closest first)
  candidates.sort((a, b) => a.dist - b.dist);

  // Pick positions ensuring minimum spacing
  const result: Array<{ x: number; y: number; z: number }> = [];
  const spacingSq = minSpacing * minSpacing;

  for (const c of candidates) {
    if (result.length >= count) break;
    // Check spacing against already-picked positions
    let tooClose = false;
    for (const r of result) {
      const dx = c.x - r.x;
      const dz = c.z - r.z;
      if (dx * dx + dz * dz < spacingSq) { tooClose = true; break; }
    }
    if (!tooClose) {
      result.push({ x: c.x, y: 0, z: c.z });
    }
  }

  // If we couldn't find enough spaced positions, just fill from nearest
  for (const c of candidates) {
    if (result.length >= count) break;
    if (!result.some(r => r.x === c.x && r.z === c.z)) {
      result.push({ x: c.x, y: 0, z: c.z });
    }
  }

  return result;
}

/**
 * Linearly interpolate between two 2D points.
 */
export function lerpPoint(
  a: { x: number; z: number },
  b: { x: number; z: number },
  t: number,
): { x: number; z: number } {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

// ── Wall collision geometry ─────────────────────────────────────────────────

/**
 * Extract WallSegment collision data from the tile grid.
 * Only emits segments for exposed wall edges (adjacent to FLOOR or VOID).
 */
export function getWallSegments(grid: VaultTileGridData): WallSegment[] {
  const segments: WallSegment[] = [];
  const { width: w, height: h, tiles } = grid;
  const half = TILE_SIZE / 2;

  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      if (tiles[row * w + col] !== Tile.WALL) continue;

      const center = tileToWorld(col, row, w, h);
      const left   = center.x - half;
      const right  = center.x + half;
      const top    = center.z - half;
      const bottom = center.z + half;

      // North face (row - 1)
      if (row === 0 || tiles[(row - 1) * w + col] !== Tile.WALL) {
        segments.push({ ax: left, az: top, bx: right, bz: top });
      }
      // South face (row + 1)
      if (row === h - 1 || tiles[(row + 1) * w + col] !== Tile.WALL) {
        segments.push({ ax: left, az: bottom, bx: right, bz: bottom });
      }
      // West face (col - 1)
      if (col === 0 || tiles[row * w + (col - 1)] !== Tile.WALL) {
        segments.push({ ax: left, az: top, bx: left, bz: bottom });
      }
      // East face (col + 1)
      if (col === w - 1 || tiles[row * w + (col + 1)] !== Tile.WALL) {
        segments.push({ ax: right, az: top, bx: right, bz: bottom });
      }
    }
  }

  return segments;
}

// ── Multi-room generation ───────────────────────────────────────────────────

/**
 * Generate a multi-room vault grid: N rooms arranged in a grid, connected
 * by corridors in a serpentine path.
 *
 * Each room is generated as an independent CA cave on a temporary grid,
 * then stamped onto the master tile array. Corridors are carved through
 * the gap tiles between rooms.
 */
export function generateMultiRoomGrid(
  _widthTiles:  number,
  _heightTiles: number,
  params:       VaultGenParams,
  instanceId?:  string,
): VaultTileGridData {
  const roomCount     = params.roomCount ?? 1;
  const roomCols      = params.roomCols ?? roomCount;
  const roomRows      = Math.ceil(roomCount / roomCols);
  const corridorWidth = params.corridorWidth ?? 3;
  const border        = 2;
  const gap           = 4;

  const seed = params.seed ?? (instanceId ? seedFromString(instanceId) : Date.now());
  const rng  = mulberry32(seed);

  // ── Build serpentine room order ──────────────────────────────────────────
  // Row 0: left→right, Row 1: right→left, etc.

  const roomOrder: Array<{ gridCol: number; gridRow: number }> = [];
  let roomIdx = 0;
  for (let row = 0; row < roomRows && roomIdx < roomCount; row++) {
    if (row % 2 === 0) {
      for (let col = 0; col < roomCols && roomIdx < roomCount; col++) {
        roomOrder.push({ gridCol: col, gridRow: row });
        roomIdx++;
      }
    } else {
      for (let col = roomCols - 1; col >= 0 && roomIdx < roomCount; col--) {
        roomOrder.push({ gridCol: col, gridRow: row });
        roomIdx++;
      }
    }
  }

  // ── Determine per-room dimensions ───────────────────────────────────────

  const bossIndices = new Set(params.bossRoomIndices ?? []);

  interface RoomSize { w: number; h: number }
  const roomSizes: RoomSize[] = [];

  if (params.roomSizeRange) {
    // Variable room sizes — random within range
    const [rMin, rMax] = params.roomSizeRange;
    const [bMin, bMax] = params.bossRoomSizeRange ?? params.roomSizeRange;

    for (let i = 0; i < roomCount; i++) {
      const isBoss = bossIndices.has(i);
      const lo = isBoss ? bMin : rMin;
      const hi = isBoss ? bMax : rMax;
      roomSizes.push({
        w: lo + Math.floor(rng() * (hi - lo + 1)),
        h: lo + Math.floor(rng() * (hi - lo + 1)),
      });
    }
  } else {
    // Uniform — derive from passed-in grid dimensions (legacy behavior)
    const effectiveW = _widthTiles - border * 2;
    const effectiveH = _heightTiles - border * 2;
    const uniW = Math.floor((effectiveW - (roomCols - 1) * gap) / roomCols);
    const uniH = Math.floor((effectiveH - (roomRows - 1) * gap) / roomRows);
    for (let i = 0; i < roomCount; i++) {
      roomSizes.push({ w: uniW, h: uniH });
    }
  }

  // ── Compute column widths / row heights from per-room sizes ─────────────

  const colWidths  = new Array<number>(roomCols).fill(0);
  const rowHeights = new Array<number>(roomRows).fill(0);

  for (let i = 0; i < roomOrder.length; i++) {
    const { gridCol, gridRow } = roomOrder[i]!;
    const s = roomSizes[i]!;
    if (s.w > colWidths[gridCol]!)  colWidths[gridCol]  = s.w;
    if (s.h > rowHeights[gridRow]!) rowHeights[gridRow] = s.h;
  }

  // ── Compute actual grid dimensions ──────────────────────────────────────

  const widthTiles  = border * 2
    + colWidths.reduce((a, b) => a + b, 0)
    + (roomCols - 1) * gap;
  const heightTiles = border * 2
    + rowHeights.reduce((a, b) => a + b, 0)
    + (roomRows - 1) * gap;

  // Column / row start offsets inside the master grid
  const colStarts: number[] = [];
  let cx = border;
  for (let c = 0; c < roomCols; c++) {
    colStarts.push(cx);
    cx += colWidths[c]! + gap;
  }

  const rowStarts: number[] = [];
  let ry = border;
  for (let r = 0; r < roomRows; r++) {
    rowStarts.push(ry);
    ry += rowHeights[r]! + gap;
  }

  // ── Compute room positions (centered within their grid cell) ────────────

  interface RoomPos {
    startCol: number;
    startRow: number;
    centerCol: number;
    centerRow: number;
    gridCol: number;
    gridRow: number;
    w: number;
    h: number;
  }

  const roomPositions: RoomPos[] = roomOrder.map(({ gridCol, gridRow }, i) => {
    const s = roomSizes[i]!;
    const startCol = colStarts[gridCol]! + Math.floor((colWidths[gridCol]! - s.w) / 2);
    const startRow = rowStarts[gridRow]! + Math.floor((rowHeights[gridRow]! - s.h) / 2);
    return {
      startCol,
      startRow,
      centerCol: startCol + Math.floor(s.w / 2),
      centerRow: startRow + Math.floor(s.h / 2),
      gridCol,
      gridRow,
      w: s.w,
      h: s.h,
    };
  });

  // Master grid — fill with WALL
  const tiles = new Uint8Array(widthTiles * heightTiles);
  tiles.fill(Tile.WALL);

  // ── Generate each room via CA on a temporary grid ───────────────────────

  for (const rp of roomPositions) {
    const { w: rw, h: rh } = rp;
    let tempTiles: Uint8Array | null = null;
    const roomTotal = rw * rh;

    for (let attempt = 0; attempt < 10; attempt++) {
      const temp = _randomFill(rw, rh, params.wallChance, rng);
      _smoothCA(temp, rw, rh, params.smoothIterations);
      _keepLargestCave(temp, rw, rh);

      // Validate floor ratio
      let floorCount = 0;
      for (let i = 0; i < roomTotal; i++) {
        if (temp[i] === Tile.FLOOR) floorCount++;
      }
      if (floorCount / roomTotal >= params.minFloorRatio) {
        tempTiles = temp;
        break;
      }
    }

    // Fallback: open rectangle
    if (!tempTiles) {
      tempTiles = new Uint8Array(roomTotal);
      tempTiles.fill(Tile.WALL);
      for (let row = 2; row < rh - 2; row++) {
        for (let col = 2; col < rw - 2; col++) {
          tempTiles[row * rw + col] = Tile.FLOOR;
        }
      }
    }

    // Stamp temp grid onto master grid
    for (let row = 0; row < rh; row++) {
      for (let col = 0; col < rw; col++) {
        const masterIdx = (rp.startRow + row) * widthTiles + (rp.startCol + col);
        tiles[masterIdx] = tempTiles[row * rw + col]!;
      }
    }
  }

  // ── Carve corridors between consecutive rooms ──────────────────────────

  for (let i = 0; i < roomPositions.length - 1; i++) {
    const a = roomPositions[i]!;
    const b = roomPositions[i + 1]!;

    if (a.gridRow === b.gridRow) {
      // Horizontal corridor — extend 3 tiles into each room
      const leftRoom  = a.gridCol < b.gridCol ? a : b;
      const rightRoom = a.gridCol < b.gridCol ? b : a;

      const colStart = leftRoom.startCol + leftRoom.w - 4;
      const colEnd   = rightRoom.startCol + 3;
      const midRow   = a.centerRow;
      const halfCW   = Math.floor(corridorWidth / 2);

      for (let row = midRow - halfCW; row <= midRow + halfCW; row++) {
        for (let col = colStart; col <= colEnd; col++) {
          if (row >= 0 && row < heightTiles && col >= 0 && col < widthTiles) {
            tiles[row * widthTiles + col] = Tile.FLOOR;
          }
        }
      }
    } else {
      // Vertical corridor — extend 3 tiles into each room
      const topRoom    = a.gridRow < b.gridRow ? a : b;
      const bottomRoom = a.gridRow < b.gridRow ? b : a;

      const rowStart = topRoom.startRow + topRoom.h - 4;
      const rowEnd   = bottomRoom.startRow + 3;
      const midCol   = a.centerCol;
      const halfCW   = Math.floor(corridorWidth / 2);

      for (let row = rowStart; row <= rowEnd; row++) {
        for (let col = midCol - halfCW; col <= midCol + halfCW; col++) {
          if (row >= 0 && row < heightTiles && col >= 0 && col < widthTiles) {
            tiles[row * widthTiles + col] = Tile.FLOOR;
          }
        }
      }
    }
  }

  // ── Ensure all rooms are reachable from the first room ───────────────
  {
    const centerTiles = roomPositions.map(rp => ({ col: rp.centerCol, row: rp.centerRow }));
    _ensureConnectivity(tiles, widthTiles, heightTiles, centerTiles[0]!, centerTiles, corridorWidth);
  }

  // ── Place gates in gated corridors ──────────────────────────────────────
  //
  // A gate is a 2-tile-thick band of WALL placed at the midpoint of a
  // corridor. It blocks passage until the room on the near side is cleared.

  const gatedSet = new Set(params.gatedCorridors ?? []);
  const gates: VaultGateDef[] = [];

  for (let i = 0; i < roomPositions.length - 1; i++) {
    if (!gatedSet.has(i)) continue;

    const a = roomPositions[i]!;
    const b = roomPositions[i + 1]!;
    const gateTiles: Array<{ row: number; col: number }> = [];

    if (a.gridRow === b.gridRow) {
      // Horizontal corridor — gate is a vertical band across the corridor
      const leftRoom  = a.gridCol < b.gridCol ? a : b;
      const rightRoom = a.gridCol < b.gridCol ? b : a;
      const midCol    = Math.floor((leftRoom.startCol + leftRoom.w + rightRoom.startCol) / 2);
      const midRow    = a.centerRow;
      const halfCW    = Math.floor(corridorWidth / 2);

      for (let d = 0; d <= 1; d++) {          // 2 tiles thick
        for (let row = midRow - halfCW; row <= midRow + halfCW; row++) {
          const col = midCol + d;
          if (row >= 0 && row < heightTiles && col >= 0 && col < widthTiles) {
            tiles[row * widthTiles + col] = Tile.WALL;
            gateTiles.push({ row, col });
          }
        }
      }

      const worldPos = tileToWorld(midCol, midRow, widthTiles, heightTiles);
      gates.push({ corridorIndex: i, tiles: gateTiles, position: worldPos, orientation: 'horizontal' });
    } else {
      // Vertical corridor — gate is a horizontal band across the corridor
      const topRoom    = a.gridRow < b.gridRow ? a : b;
      const bottomRoom = a.gridRow < b.gridRow ? b : a;
      const midRow     = Math.floor((topRoom.startRow + topRoom.h + bottomRoom.startRow) / 2);
      const midCol     = a.centerCol;
      const halfCW     = Math.floor(corridorWidth / 2);

      for (let d = 0; d <= 1; d++) {          // 2 tiles thick
        for (let col = midCol - halfCW; col <= midCol + halfCW; col++) {
          const row = midRow + d;
          if (row >= 0 && row < heightTiles && col >= 0 && col < widthTiles) {
            tiles[row * widthTiles + col] = Tile.WALL;
            gateTiles.push({ row, col });
          }
        }
      }

      const worldPos = tileToWorld(midCol, midRow, widthTiles, heightTiles);
      gates.push({ corridorIndex: i, tiles: gateTiles, position: worldPos, orientation: 'vertical' });
    }
  }

  // ── Compute room centers and sizes in world space ───────────────────────

  const roomCenters = roomPositions.map(rp =>
    tileToWorld(rp.centerCol, rp.centerRow, widthTiles, heightTiles),
  );

  const roomWorldSizes = roomPositions.map(rp => ({
    width:  rp.w * TILE_SIZE,
    height: rp.h * TILE_SIZE,
  }));

  // ── Place entrance (Room 0 center) and exit (last room center) ─────────

  const firstCenter = roomPositions[0]!;
  const lastCenter  = roomPositions[roomPositions.length - 1]!;

  // Find nearest floor tile to each room center
  const entrance = _nearestFloor(tiles, widthTiles, heightTiles, firstCenter.centerCol, firstCenter.centerRow);
  const exit     = _nearestFloor(tiles, widthTiles, heightTiles, lastCenter.centerCol, lastCenter.centerRow);

  return {
    width:    widthTiles,
    height:   heightTiles,
    tileSize: TILE_SIZE,
    tiles,
    entrance: tileToWorld(entrance.col, entrance.row, widthTiles, heightTiles),
    exit:     tileToWorld(exit.col, exit.row, widthTiles, heightTiles),
    roomCenters,
    roomSizes: roomWorldSizes,
    gates: gates.length > 0 ? gates : undefined,
  };
}

/** Find the nearest FLOOR tile to the given tile coords via BFS. */
function _nearestFloor(
  tiles: Uint8Array, w: number, h: number, startCol: number, startRow: number,
): { col: number; row: number } {
  // If the target is already floor, return it
  if (tiles[startRow * w + startCol] === Tile.FLOOR) {
    return { col: startCol, row: startRow };
  }

  const visited = new Uint8Array(w * h);
  const queue: Array<{ col: number; row: number }> = [{ col: startCol, row: startRow }];
  visited[startRow * w + startCol] = 1;

  while (queue.length > 0) {
    const { col, row } = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = col + dx;
      const nr = row + dy;
      if (nc < 0 || nc >= w || nr < 0 || nr >= h) continue;
      const ni = nr * w + nc;
      if (visited[ni]) continue;
      visited[ni] = 1;
      if (tiles[ni] === Tile.FLOOR) return { col: nc, row: nr };
      queue.push({ col: nc, row: nr });
    }
  }

  // Should never happen if rooms have floor tiles
  return { col: startCol, row: startRow };
}

// ── Post-generation connectivity validation ─────────────────────────────────

/**
 * Flood-fill from a floor tile, returning the set of all reachable tile indices.
 */
function _floodFillSet(
  tiles: Uint8Array, w: number, h: number,
  startCol: number, startRow: number,
): Set<number> {
  const startIdx = startRow * w + startCol;
  if (tiles[startIdx] !== Tile.FLOOR) return new Set();

  const visited = new Set<number>();
  const queue: number[] = [startIdx];
  visited.add(startIdx);

  while (queue.length > 0) {
    const idx = queue.pop()!;
    const col = idx % w;
    const row = (idx - col) / w;

    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = col + dx;
      const nr = row + dy;
      if (nc < 0 || nc >= w || nr < 0 || nr >= h) continue;
      const ni = nr * w + nc;
      if (tiles[ni] === Tile.FLOOR && !visited.has(ni)) {
        visited.add(ni);
        queue.push(ni);
      }
    }
  }

  return visited;
}

/**
 * BFS from a point through ALL tiles (floor and wall) to find the nearest
 * tile whose index exists in `targetSet`. Used to bridge disconnected regions.
 */
function _findNearestInSet(
  w: number, h: number,
  startCol: number, startRow: number,
  targetSet: Set<number>,
): { col: number; row: number } | null {
  const startIdx = startRow * w + startCol;
  if (targetSet.has(startIdx)) return { col: startCol, row: startRow };

  const visited = new Set<number>();
  const queue: Array<{ col: number; row: number }> = [{ col: startCol, row: startRow }];
  visited.add(startIdx);

  while (queue.length > 0) {
    const { col, row } = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = col + dx;
      const nr = row + dy;
      if (nc < 0 || nc >= w || nr < 0 || nr >= h) continue;
      const ni = nr * w + nc;
      if (visited.has(ni)) continue;
      visited.add(ni);
      if (targetSet.has(ni)) return { col: nc, row: nr };
      queue.push({ col: nc, row: nr });
    }
  }

  return null;
}

/**
 * Carve an L-shaped corridor between two tile positions.
 * Goes horizontal first (from → corner), then vertical (corner → to).
 */
function _carveLCorridor(
  tiles: Uint8Array, w: number, h: number,
  fromCol: number, fromRow: number,
  toCol: number, toRow: number,
  halfW: number,
): void {
  // Horizontal leg
  const colMin = Math.min(fromCol, toCol);
  const colMax = Math.max(fromCol, toCol);
  for (let col = colMin; col <= colMax; col++) {
    for (let d = -halfW; d <= halfW; d++) {
      const row = fromRow + d;
      if (row >= 0 && row < h && col >= 0 && col < w) {
        tiles[row * w + col] = Tile.FLOOR;
      }
    }
  }

  // Vertical leg
  const rowMin = Math.min(fromRow, toRow);
  const rowMax = Math.max(fromRow, toRow);
  for (let row = rowMin; row <= rowMax; row++) {
    for (let d = -halfW; d <= halfW; d++) {
      const col = toCol + d;
      if (row >= 0 && row < h && col >= 0 && col < w) {
        tiles[row * w + col] = Tile.FLOOR;
      }
    }
  }
}

/**
 * Ensure every room center is reachable from the entrance via flood-fill.
 * If any room is disconnected, carve an L-shaped corridor to connect it.
 * Call BEFORE placing gates.
 */
function _ensureConnectivity(
  tiles: Uint8Array,
  w: number, h: number,
  entranceTile: { col: number; row: number },
  roomCenterTiles: Array<{ col: number; row: number }>,
  corridorWidth: number,
): void {
  const start = _nearestFloor(tiles, w, h, entranceTile.col, entranceTile.row);
  let reachable = _floodFillSet(tiles, w, h, start.col, start.row);

  const halfW = Math.floor(corridorWidth / 2);

  for (const center of roomCenterTiles) {
    const floorNear = _nearestFloor(tiles, w, h, center.col, center.row);
    const idx = floorNear.row * w + floorNear.col;

    if (reachable.has(idx)) continue;

    // Find the nearest reachable tile to this disconnected room
    const bridge = _findNearestInSet(w, h, floorNear.col, floorNear.row, reachable);
    if (!bridge) continue;

    // Carve an L-shaped corridor to connect
    _carveLCorridor(tiles, w, h, bridge.col, bridge.row, floorNear.col, floorNear.row, halfW);

    // Re-flood to include newly connected areas
    reachable = _floodFillSet(tiles, w, h, start.col, start.row);
  }
}

// ── Chain-based generation ───────────────────────────────────────────────────

/**
 * Build the room type sequence for a given vault tier.
 * T1: ENTRY, TRASH, SUB_BOSS, TRASH, BOSS  (5 rooms)
 * T2: ENTRY, TRASH×2, SUB_BOSS, TRASH×2, BOSS  (7 rooms)
 * General: ENTRY + tier×TRASH + SUB_BOSS + tier×TRASH + BOSS
 */
function _buildRoomTypeSequence(tier: number): RoomType[] {
  const seq: RoomType[] = ['ENTRY'];
  for (let i = 0; i < tier; i++) seq.push('TRASH');
  seq.push('SUB_BOSS');
  for (let i = 0; i < tier; i++) seq.push('TRASH');
  seq.push('BOSS');
  return seq;
}

function _oppositeDir(dir: Direction): Direction {
  switch (dir) {
    case 'N': return 'S';
    case 'S': return 'N';
    case 'E': return 'W';
    case 'W': return 'E';
  }
}

/** Shuffle an array in-place using Fisher-Yates. */
function _shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/**
 * Compute where a new room's top-left corner should go when placed in `dir`
 * relative to `prev`. The rooms are separated by `gap` tiles (corridor + padding).
 * The new room is center-aligned with the previous room along the perpendicular axis.
 */
function _computeRoomOrigin(
  prev: ChainRoom, dir: Direction,
  nextW: number, nextH: number, gap: number,
): { col: number; row: number } {
  switch (dir) {
    case 'E':
      return {
        col: prev.col + prev.w + gap,
        row: prev.row + Math.floor(prev.h / 2) - Math.floor(nextH / 2),
      };
    case 'W':
      return {
        col: prev.col - gap - nextW,
        row: prev.row + Math.floor(prev.h / 2) - Math.floor(nextH / 2),
      };
    case 'S':
      return {
        col: prev.col + Math.floor(prev.w / 2) - Math.floor(nextW / 2),
        row: prev.row + prev.h + gap,
      };
    case 'N':
      return {
        col: prev.col + Math.floor(prev.w / 2) - Math.floor(nextW / 2),
        row: prev.row - gap - nextH,
      };
  }
}

/** Check if two axis-aligned rectangles overlap (with optional padding). */
function _roomsOverlap(
  a: { col: number; row: number; w: number; h: number },
  b: { col: number; row: number; w: number; h: number },
  padding: number,
): boolean {
  return !(
    a.col + a.w + padding <= b.col ||
    b.col + b.w + padding <= a.col ||
    a.row + a.h + padding <= b.row ||
    b.row + b.h + padding <= a.row
  );
}

/**
 * Clear a square area of tiles to FLOOR around a center point.
 * Used at corridor-room junctions to prevent CA walls from blocking entrances.
 */
function _clearConnectionZone(
  tiles: Uint8Array, gridW: number, gridH: number,
  centerCol: number, centerRow: number, size: number,
): void {
  const half = Math.floor(size / 2);
  for (let dr = -half; dr <= half; dr++) {
    for (let dc = -half; dc <= half; dc++) {
      const r = centerRow + dr;
      const c = centerCol + dc;
      if (r >= 0 && r < gridH && c >= 0 && c < gridW) {
        tiles[r * gridW + c] = Tile.FLOOR;
      }
    }
  }
}

/**
 * Generate a vault using a linear chain layout. Rooms are placed sequentially
 * with corridors going in random directions (N/S/E/W). Room counts and types
 * are derived from the vault tier.
 */
export function generateChainVault(
  params:      VaultGenParams,
  instanceId?: string,
): VaultTileGridData {
  const tier           = params.tier ?? 1;
  const corridorWidth  = params.corridorWidth ?? 3;
  const corridorLength = params.corridorLength ?? 8;
  const border         = 2;

  const seed = params.seed ?? (instanceId ? seedFromString(instanceId) : Date.now());
  const rng  = mulberry32(seed);

  // ── 1. Build room type sequence ──────────────────────────────────────────
  const roomTypes = _buildRoomTypeSequence(tier);
  const roomCount = roomTypes.length;

  // ── 2. Determine room sizes (per–room-type ranges) ──────────────────────
  const trashRange:   [number, number] = params.roomSizeRange        ?? [25, 45];
  const entryRange:   [number, number] = params.entryRoomSizeRange   ?? [20, 28];
  const subBossRange: [number, number] = params.subBossRoomSizeRange ?? params.bossRoomSizeRange ?? [32, 42];
  const bossRange:    [number, number] = params.bossRoomSizeRange    ?? [36, 48];

  function sizeFromRange([lo, hi]: [number, number]): { w: number; h: number } {
    return {
      w: lo + Math.floor(rng() * (hi - lo + 1)),
      h: lo + Math.floor(rng() * (hi - lo + 1)),
    };
  }

  interface RoomSize { w: number; h: number }
  const roomSizes: RoomSize[] = [];
  for (let i = 0; i < roomCount; i++) {
    // Per-room size override (from trash variants) takes highest priority
    const perRoomSize = params.perRoomSizeOverrides?.[i];
    if (perRoomSize) {
      roomSizes.push(sizeFromRange(perRoomSize));
    } else {
      switch (roomTypes[i]) {
        case 'ENTRY':    roomSizes.push(sizeFromRange(entryRange));   break;
        case 'SUB_BOSS': roomSizes.push(sizeFromRange(subBossRange)); break;
        case 'BOSS':     roomSizes.push(sizeFromRange(bossRange));    break;
        default:         roomSizes.push(sizeFromRange(trashRange));   break;
      }
    }
  }

  // ── 3. Place rooms sequentially in abstract space ────────────────────────
  const gap = corridorLength + 2; // corridor tiles + padding
  const chain: ChainRoom[] = [];

  // Room 0 (ENTRY) at origin
  chain.push({
    type: roomTypes[0]!,
    w: roomSizes[0]!.w,
    h: roomSizes[0]!.h,
    col: 0,
    row: 0,
  });

  let lastDir: Direction | undefined;

  for (let i = 1; i < roomCount; i++) {
    const prev = chain[i - 1]!;
    const nextW = roomSizes[i]!.w;
    const nextH = roomSizes[i]!.h;

    // Build direction priority: perpendicular first (for variety), then
    // same direction, and U-turn excluded entirely.
    const uTurn = lastDir ? _oppositeDir(lastDir) : undefined;
    const perpendicular: Direction[] = [];
    const sameDir: Direction[] = [];
    for (const d of ['N', 'S', 'E', 'W'] as Direction[]) {
      if (d === uTurn) continue;
      if (d === lastDir) {
        sameDir.push(d);
      } else {
        perpendicular.push(d);
      }
    }
    const dirs: Direction[] = [
      ..._shuffle(perpendicular, rng),
      ..._shuffle(sameDir, rng),
    ];

    let placed = false;

    for (const dir of dirs) {
      const origin = _computeRoomOrigin(prev, dir, nextW, nextH, gap);
      const candidate = { col: origin.col, row: origin.row, w: nextW, h: nextH };

      // Check overlap against all placed rooms
      let overlaps = false;
      for (const existing of chain) {
        if (_roomsOverlap(existing, candidate, 2)) {
          overlaps = true;
          break;
        }
      }

      if (!overlaps) {
        chain.push({
          type: roomTypes[i]!,
          w: nextW,
          h: nextH,
          col: origin.col,
          row: origin.row,
          entryDir: _oppositeDir(dir), // direction the corridor enters FROM
        });
        lastDir = dir;
        placed = true;
        break;
      }
    }

    // Fallback: if all directions overlap, try with increased gap
    if (!placed) {
      for (const dir of dirs) {
        const origin = _computeRoomOrigin(prev, dir, nextW, nextH, gap * 2);
        const candidate = { col: origin.col, row: origin.row, w: nextW, h: nextH };

        let overlaps = false;
        for (const existing of chain) {
          if (_roomsOverlap(existing, candidate, 2)) {
            overlaps = true;
            break;
          }
        }

        if (!overlaps) {
          chain.push({
            type: roomTypes[i]!,
            w: nextW,
            h: nextH,
            col: origin.col,
            row: origin.row,
            entryDir: _oppositeDir(dir),
          });
          lastDir = dir;
          placed = true;
          break;
        }
      }
    }

    // Last resort: force East placement far away
    if (!placed) {
      const origin = _computeRoomOrigin(prev, 'E', nextW, nextH, gap * 3);
      chain.push({
        type: roomTypes[i]!,
        w: nextW,
        h: nextH,
        col: origin.col,
        row: origin.row,
        entryDir: 'W',
      });
      lastDir = 'E';
    }
  }

  // ── 4. Normalize positions ─────────────────────────────────────────────
  let minCol = Infinity;
  let minRow = Infinity;
  for (const room of chain) {
    if (room.col < minCol) minCol = room.col;
    if (room.row < minRow) minRow = room.row;
  }

  const shiftCol = border - minCol;
  const shiftRow = border - minRow;
  for (const room of chain) {
    room.col += shiftCol;
    room.row += shiftRow;
  }

  // ── 5. Compute master grid dimensions ──────────────────────────────────
  let maxCol = 0;
  let maxRow = 0;
  for (const room of chain) {
    if (room.col + room.w > maxCol) maxCol = room.col + room.w;
    if (room.row + room.h > maxRow) maxRow = room.row + room.h;
  }

  const widthTiles  = maxCol + border;
  const heightTiles = maxRow + border;

  // ── 6. Allocate master grid & generate CA rooms ────────────────────────
  const tiles = new Uint8Array(widthTiles * heightTiles);
  tiles.fill(Tile.WALL);

  const typeDigOverrides = params.roomDigOverrides ?? {};

  for (let roomIdx = 0; roomIdx < chain.length; roomIdx++) {
    const room = chain[roomIdx]!;
    const { w: rw, h: rh } = room;
    let tempTiles: Uint8Array | null = null;
    const roomTotal = rw * rh;

    // Resolve CA params: per-room override → per-type override → base
    const perRoom      = params.perRoomDigOverrides?.[roomIdx];
    const perType      = typeDigOverrides[room.type];
    const wallChance   = perRoom?.wallChance       ?? perType?.wallChance       ?? params.wallChance;
    const smoothIter   = perRoom?.smoothIterations ?? perType?.smoothIterations ?? params.smoothIterations;
    const minFloor     = perRoom?.minFloorRatio    ?? perType?.minFloorRatio    ?? params.minFloorRatio;

    for (let attempt = 0; attempt < 10; attempt++) {
      const temp = _randomFill(rw, rh, wallChance, rng);
      _smoothCA(temp, rw, rh, smoothIter);
      _keepLargestCave(temp, rw, rh);

      let floorCount = 0;
      for (let i = 0; i < roomTotal; i++) {
        if (temp[i] === Tile.FLOOR) floorCount++;
      }
      if (floorCount / roomTotal >= minFloor) {
        tempTiles = temp;
        break;
      }
    }

    // Fallback: open rectangle
    if (!tempTiles) {
      tempTiles = new Uint8Array(roomTotal);
      tempTiles.fill(Tile.WALL);
      for (let row = 2; row < rh - 2; row++) {
        for (let col = 2; col < rw - 2; col++) {
          tempTiles[row * rw + col] = Tile.FLOOR;
        }
      }
    }

    // Stamp onto master grid
    for (let row = 0; row < rh; row++) {
      for (let col = 0; col < rw; col++) {
        const masterIdx = (room.row + row) * widthTiles + (room.col + col);
        tiles[masterIdx] = tempTiles[row * rw + col]!;
      }
    }
  }

  // ── 7. Carve corridors between consecutive rooms ───────────────────────

  /** Compute the center tile of a room. */
  function roomCenter(r: ChainRoom): { col: number; row: number } {
    return {
      col: r.col + Math.floor(r.w / 2),
      row: r.row + Math.floor(r.h / 2),
    };
  }

  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i]!;
    const b = chain[i + 1]!;
    const ac = roomCenter(a);
    const halfCW = Math.floor(corridorWidth / 2);

    if (a.row + a.h <= b.row || b.row + b.h <= a.row) {
      // Vertical corridor (rooms are separated vertically)
      const topRoom    = a.row < b.row ? a : b;
      const bottomRoom = a.row < b.row ? b : a;
      const midCol     = ac.col;

      const rowStart = topRoom.row + topRoom.h - 4;
      const rowEnd   = bottomRoom.row + 3;

      for (let row = rowStart; row <= rowEnd; row++) {
        for (let col = midCol - halfCW; col <= midCol + halfCW; col++) {
          if (row >= 0 && row < heightTiles && col >= 0 && col < widthTiles) {
            tiles[row * widthTiles + col] = Tile.FLOOR;
          }
        }
      }

      // Connection clearance zones at both ends
      _clearConnectionZone(tiles, widthTiles, heightTiles, midCol, topRoom.row + topRoom.h - 1, 5);
      _clearConnectionZone(tiles, widthTiles, heightTiles, midCol, bottomRoom.row, 5);
    } else {
      // Horizontal corridor (rooms are separated horizontally)
      const leftRoom  = a.col < b.col ? a : b;
      const rightRoom = a.col < b.col ? b : a;
      const midRow    = ac.row;

      const colStart = leftRoom.col + leftRoom.w - 4;
      const colEnd   = rightRoom.col + 3;

      for (let row = midRow - halfCW; row <= midRow + halfCW; row++) {
        for (let col = colStart; col <= colEnd; col++) {
          if (row >= 0 && row < heightTiles && col >= 0 && col < widthTiles) {
            tiles[row * widthTiles + col] = Tile.FLOOR;
          }
        }
      }

      // Connection clearance zones at both ends
      _clearConnectionZone(tiles, widthTiles, heightTiles, leftRoom.col + leftRoom.w - 1, midRow, 5);
      _clearConnectionZone(tiles, widthTiles, heightTiles, rightRoom.col, midRow, 5);
    }
  }

  // ── 7b. Ensure all rooms are reachable from the entrance ────────────
  {
    const centerTiles = chain.map(r => roomCenter(r));
    _ensureConnectivity(tiles, widthTiles, heightTiles, centerTiles[0]!, centerTiles, corridorWidth);
  }

  // ── 8. Place gates before SUB_BOSS and BOSS rooms ──────────────────────

  const gates: VaultGateDef[] = [];

  for (let i = 0; i < chain.length - 1; i++) {
    const currentType = chain[i]!.type;
    const nextType    = chain[i + 1]!.type;
    // Gate before SUB_BOSS, after SUB_BOSS, and before BOSS
    if (nextType !== 'SUB_BOSS' && nextType !== 'BOSS' && currentType !== 'SUB_BOSS') continue;

    const a = chain[i]!;
    const b = chain[i + 1]!;
    const ac = roomCenter(a);
    const halfCW = Math.floor(corridorWidth / 2);
    const gateTiles: Array<{ row: number; col: number }> = [];

    if (a.row + a.h <= b.row || b.row + b.h <= a.row) {
      // Vertical corridor — horizontal gate band
      const topRoom    = a.row < b.row ? a : b;
      const bottomRoom = a.row < b.row ? b : a;
      const midCol     = ac.col;
      const midRow     = Math.floor((topRoom.row + topRoom.h + bottomRoom.row) / 2);

      for (let d = 0; d <= 1; d++) {
        for (let col = midCol - halfCW; col <= midCol + halfCW; col++) {
          const row = midRow + d;
          if (row >= 0 && row < heightTiles && col >= 0 && col < widthTiles) {
            tiles[row * widthTiles + col] = Tile.WALL;
            gateTiles.push({ row, col });
          }
        }
      }

      const worldPos = tileToWorld(midCol, midRow, widthTiles, heightTiles);
      gates.push({ corridorIndex: i, tiles: gateTiles, position: worldPos, orientation: 'vertical' });
    } else {
      // Horizontal corridor — vertical gate band
      const leftRoom  = a.col < b.col ? a : b;
      const rightRoom = a.col < b.col ? b : a;
      const midRow    = ac.row;
      const midCol    = Math.floor((leftRoom.col + leftRoom.w + rightRoom.col) / 2);

      for (let d = 0; d <= 1; d++) {
        for (let row = midRow - halfCW; row <= midRow + halfCW; row++) {
          const col = midCol + d;
          if (row >= 0 && row < heightTiles && col >= 0 && col < widthTiles) {
            tiles[row * widthTiles + col] = Tile.WALL;
            gateTiles.push({ row, col });
          }
        }
      }

      const worldPos = tileToWorld(midCol, midRow, widthTiles, heightTiles);
      gates.push({ corridorIndex: i, tiles: gateTiles, position: worldPos, orientation: 'horizontal' });
    }
  }

  // ── 9. Compute outputs ────────────────────────────────────────────────

  const roomCenters = chain.map(r => {
    const c = roomCenter(r);
    return tileToWorld(c.col, c.row, widthTiles, heightTiles);
  });

  const roomWorldSizes = chain.map(r => ({
    width:  r.w * TILE_SIZE,
    height: r.h * TILE_SIZE,
  }));

  // Entrance = ENTRY room center, Exit = BOSS room center
  const firstCenter = roomCenter(chain[0]!);
  const lastCenter  = roomCenter(chain[chain.length - 1]!);

  const entrance = _nearestFloor(tiles, widthTiles, heightTiles, firstCenter.col, firstCenter.row);
  const exit     = _nearestFloor(tiles, widthTiles, heightTiles, lastCenter.col, lastCenter.row);

  return {
    width:    widthTiles,
    height:   heightTiles,
    tileSize: TILE_SIZE,
    tiles,
    entrance: tileToWorld(entrance.col, entrance.row, widthTiles, heightTiles),
    exit:     tileToWorld(exit.col, exit.row, widthTiles, heightTiles),
    roomCenters,
    roomSizes: roomWorldSizes,
    gates: gates.length > 0 ? gates : undefined,
  };
}

// ── Serialization ───────────────────────────────────────────────────────────

export interface VaultTileGridJSON {
  width:    number;
  height:   number;
  tileSize: number;
  tiles:    number[];
  entrance: { x: number; z: number };
  exit:     { x: number; z: number };
  roomCenters?: Array<{ x: number; z: number }>;
  roomSizes?: Array<{ width: number; height: number }>;
  gates?: VaultGateDef[];
  geometry?: VaultGeometry;
}

export function tileGridToJSON(grid: VaultTileGridData): VaultTileGridJSON {
  return {
    width:       grid.width,
    height:      grid.height,
    tileSize:    grid.tileSize,
    tiles:       Array.from(grid.tiles),
    entrance:    grid.entrance,
    exit:        grid.exit,
    roomCenters: grid.roomCenters,
    roomSizes:   grid.roomSizes,
    gates:       grid.gates,
    geometry:    grid.geometry,
  };
}

export function tileGridFromJSON(json: VaultTileGridJSON): VaultTileGridData {
  return {
    width:       json.width,
    height:      json.height,
    tileSize:    json.tileSize,
    tiles:       new Uint8Array(json.tiles),
    entrance:    json.entrance,
    exit:        json.exit,
    roomCenters: json.roomCenters,
    roomSizes:   json.roomSizes,
    gates:       json.gates,
    geometry:    json.geometry,
  };
}
