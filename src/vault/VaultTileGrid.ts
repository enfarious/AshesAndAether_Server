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

export interface VaultGenParams {
  /** Probability (0-1) a cell starts as wall in initial fill. Default 0.45. */
  wallChance: number;
  /** Number of CA smoothing passes. Default 5. */
  smoothIterations: number;
  /** Minimum floor ratio — retry if below. Default 0.35. */
  minFloorRatio: number;
  /** Optional deterministic seed. */
  seed?: number;
}

// ── Output types ────────────────────────────────────────────────────────────

export interface VaultTileGridData {
  width:    number;
  height:   number;
  tileSize: number;      // always 2.0m
  tiles:    Uint8Array;  // row-major: row=Z, col=X
  entrance: { x: number; z: number };
  exit:     { x: number; z: number };
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

// ── Core generation ─────────────────────────────────────────────────────────

export function generateVaultGrid(
  widthTiles:  number,
  heightTiles: number,
  params:      VaultGenParams,
  instanceId?: string,
): VaultTileGridData {
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
 */
export function getSpawnPositions(
  grid:       VaultTileGridData,
  anchor:     { x: number; z: number },
  count:      number,
  minSpacing: number,
): Array<{ x: number; y: number; z: number }> {
  // Collect all floor tiles with distance to anchor
  const candidates: Array<{ x: number; z: number; dist: number }> = [];
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      if (grid.tiles[row * grid.width + col] !== Tile.FLOOR) continue;
      const pos = tileToWorld(col, row, grid.width, grid.height);
      const dx = pos.x - anchor.x;
      const dz = pos.z - anchor.z;
      candidates.push({ x: pos.x, z: pos.z, dist: Math.sqrt(dx * dx + dz * dz) });
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

// ── Serialization ───────────────────────────────────────────────────────────

export interface VaultTileGridJSON {
  width:    number;
  height:   number;
  tileSize: number;
  tiles:    number[];
  entrance: { x: number; z: number };
  exit:     { x: number; z: number };
}

export function tileGridToJSON(grid: VaultTileGridData): VaultTileGridJSON {
  return {
    width:    grid.width,
    height:   grid.height,
    tileSize: grid.tileSize,
    tiles:    Array.from(grid.tiles),
    entrance: grid.entrance,
    exit:     grid.exit,
  };
}

export function tileGridFromJSON(json: VaultTileGridJSON): VaultTileGridData {
  return {
    width:    json.width,
    height:   json.height,
    tileSize: json.tileSize,
    tiles:    new Uint8Array(json.tiles),
    entrance: json.entrance,
    exit:     json.exit,
  };
}
