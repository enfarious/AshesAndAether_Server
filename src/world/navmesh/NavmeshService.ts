import { ElevationService } from '@/world/terrain/ElevationService';
import { TileService } from '@/world/tiles/TileService';
import { latLonToTile, tileToLatLonBounds } from '@/world/tiles/TileUtils';
import { ZoomLevels } from '@/world/tiles/TileConstants';
import { getDefaultBlobStorage } from '@/world/tiles/pipelines/BlobStorage';
import { NavmeshPipeline, WalkabilityFlag, type TileNavmesh } from '@/world/tiles/pipelines/NavmeshPipeline';
import type { Vector3 } from '@/network/protocol/types';

const METERS_PER_DEGREE = 111320;
const MAX_PATH_DISTANCE_METERS = 500;
const MAX_PATH_NODES = 4096;

interface NavmeshPathResult {
  waypoints: Vector3[];
}

interface CellCoord {
  row: number;
  col: number;
}

// eslint-disable-next-line no-unused-vars
type IndexToCell = (index: number) => CellCoord;

export class NavmeshService {
  private elevationService: ElevationService | null = null;
  private navmeshCache: Map<string, TileNavmesh> = new Map();

  constructor() {
    this.elevationService = ElevationService.tryLoad();
  }

  async findPath(start: Vector3, end: Vector3): Promise<NavmeshPathResult | null> {
    const meta = this.elevationService?.getMetadata();
    if (!meta) return null;

    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const planarDistance = Math.sqrt(dx * dx + dz * dz);
    if (planarDistance > MAX_PATH_DISTANCE_METERS) return null;

    const startLatLon = this.worldToLatLon(start.x, start.z, meta);
    const endLatLon = this.worldToLatLon(end.x, end.z, meta);

    const startTile = latLonToTile(startLatLon.lat, startLatLon.lon, ZoomLevels.MICRO);
    const endTile = latLonToTile(endLatLon.lat, endLatLon.lon, ZoomLevels.MICRO);

    if (!startTile || !endTile) return null;
    if (startTile.z !== endTile.z || startTile.x !== endTile.x || startTile.y !== endTile.y) {
      return null;
    }

    const navmesh = await this.loadNavmesh(startTile.z, startTile.x, startTile.y);
    if (!navmesh) return null;

    const bounds = tileToLatLonBounds(startTile);
    const resolution = navmesh.resolution;

    const startCell = this.latLonToCell(startLatLon.lat, startLatLon.lon, bounds, resolution);
    const endCell = this.latLonToCell(endLatLon.lat, endLatLon.lon, bounds, resolution);

    if (!startCell || !endCell) return null;

    const startIndex = startCell.row * resolution + startCell.col;
    const endIndex = endCell.row * resolution + endCell.col;

    if (!this.isWalkable(navmesh, startIndex) || !this.isWalkable(navmesh, endIndex)) {
      return null;
    }

    const path = this.findPathInGrid(navmesh, startCell, endCell);
    if (!path || path.length === 0) return null;
    if (path.length > MAX_PATH_NODES) return null;

    const waypoints = this.cellsToWaypoints(path, bounds, resolution, meta, start.y);
    if (waypoints.length === 0) return null;

    return { waypoints };
  }

  private async loadNavmesh(z: number, x: number, y: number): Promise<TileNavmesh | null> {
    const tileId = `${z}_${x}_${y}`;
    const cached = this.navmeshCache.get(tileId);
    if (cached) return cached;

    const storage = getDefaultBlobStorage();

    try {
      const tile = await TileService.getTileByCoords(z, x, y);
      if (!tile?.navmeshHash) return null;
      const buffer = await storage.get(tile.navmeshHash);
      if (!buffer) return null;
      const navmesh = NavmeshPipeline.deserializeNavmesh(buffer);
      this.navmeshCache.set(tileId, navmesh);
      return navmesh;
    } catch {
      return null;
    }
  }

  private isWalkable(navmesh: TileNavmesh, index: number): boolean {
    const cell = navmesh.cells[index];
    if (!cell) return false;
    if (!Number.isFinite(cell.cost)) return false;

    const blockedMask =
      WalkabilityFlag.BLOCKED_STRUCTURE |
      WalkabilityFlag.BLOCKED_WATER |
      WalkabilityFlag.BLOCKED_SLOPE |
      WalkabilityFlag.BLOCKED_CORRUPTION;

    return (cell.flags & blockedMask) === 0;
  }

  private findPathInGrid(navmesh: TileNavmesh, start: CellCoord, end: CellCoord): CellCoord[] | null {
    const resolution = navmesh.resolution;
    const total = resolution * resolution;

    const toIndex = (row: number, col: number) => row * resolution + col;
    const fromIndex = (index: number): CellCoord => ({ row: Math.floor(index / resolution), col: index % resolution });

    const startIndex = toIndex(start.row, start.col);
    const endIndex = toIndex(end.row, end.col);

    const gScore = new Array<number>(total).fill(Number.POSITIVE_INFINITY);
    const fScore = new Array<number>(total).fill(Number.POSITIVE_INFINITY);
    const cameFrom = new Array<number>(total).fill(-1);

    gScore[startIndex] = 0;
    fScore[startIndex] = this.heuristic(start, end);

    const openSet: number[] = [startIndex];
    const inOpen = new Set<number>([startIndex]);

    while (openSet.length > 0) {
      let currentIndex = openSet[0];
      let currentScore = fScore[currentIndex];
      for (const idx of openSet) {
        if (fScore[idx] < currentScore) {
          currentScore = fScore[idx];
          currentIndex = idx;
        }
      }

      if (currentIndex === endIndex) {
        return this.reconstructPath(cameFrom, currentIndex, fromIndex);
      }

      inOpen.delete(currentIndex);
      openSet.splice(openSet.indexOf(currentIndex), 1);

      const current = fromIndex(currentIndex);
      const neighbors = this.getNeighbors(current, resolution);

      for (const neighbor of neighbors) {
        const neighborIndex = toIndex(neighbor.row, neighbor.col);
        if (!this.isWalkable(navmesh, neighborIndex)) continue;

        const tentativeG = gScore[currentIndex] + this.movementCost(navmesh, currentIndex, neighborIndex);
        if (tentativeG < gScore[neighborIndex]) {
          cameFrom[neighborIndex] = currentIndex;
          gScore[neighborIndex] = tentativeG;
          fScore[neighborIndex] = tentativeG + this.heuristic(neighbor, end);

          if (!inOpen.has(neighborIndex)) {
            openSet.push(neighborIndex);
            inOpen.add(neighborIndex);
          }
        }
      }
    }

    return null;
  }

  private reconstructPath(
    cameFrom: number[],
    currentIndex: number,
    fromIndex: IndexToCell
  ): CellCoord[] {
    const path: CellCoord[] = [fromIndex(currentIndex)];
    let current = currentIndex;

    while (cameFrom[current] !== -1) {
      current = cameFrom[current];
      path.unshift(fromIndex(current));
    }

    return path;
  }

  private getNeighbors(cell: CellCoord, resolution: number): CellCoord[] {
    const neighbors: CellCoord[] = [];
    const deltas = [
      { row: -1, col: 0 },
      { row: 1, col: 0 },
      { row: 0, col: -1 },
      { row: 0, col: 1 },
    ];

    for (const delta of deltas) {
      const row = cell.row + delta.row;
      const col = cell.col + delta.col;
      if (row >= 0 && row < resolution && col >= 0 && col < resolution) {
        neighbors.push({ row, col });
      }
    }

    return neighbors;
  }

  private movementCost(navmesh: TileNavmesh, fromIndex: number, toIndex: number): number {
    const from = navmesh.cells[fromIndex];
    const to = navmesh.cells[toIndex];
    if (!from || !to) return 1;
    const cost = (from.cost + to.cost) / 2;
    return Number.isFinite(cost) ? cost : 1;
  }

  private heuristic(a: CellCoord, b: CellCoord): number {
    return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
  }

  private latLonToCell(lat: number, lon: number, bounds: { north: number; south: number; east: number; west: number }, resolution: number): CellCoord | null {
    if (lat > bounds.north || lat < bounds.south || lon < bounds.west || lon > bounds.east) {
      return null;
    }

    const u = (lon - bounds.west) / (bounds.east - bounds.west);
    const v = (bounds.north - lat) / (bounds.north - bounds.south);

    const col = Math.min(resolution - 1, Math.max(0, Math.floor(u * resolution)));
    const row = Math.min(resolution - 1, Math.max(0, Math.floor(v * resolution)));

    return { row, col };
  }

  private cellsToWaypoints(
    cells: CellCoord[],
    bounds: { north: number; south: number; east: number; west: number },
    resolution: number,
    meta: { center?: { lat: number; lon: number }; originLat: number; originLon: number },
    fallbackY: number
  ): Vector3[] {
    const step = cells.length > 20 ? 4 : 1;
    const waypoints: Vector3[] = [];

    for (let i = 0; i < cells.length; i += step) {
      waypoints.push(this.cellToWorld(cells[i], bounds, resolution, meta, fallbackY));
    }

    const last = cells[cells.length - 1];
    const lastPoint = this.cellToWorld(last, bounds, resolution, meta, fallbackY);
    if (waypoints.length === 0 || this.distanceSquared(waypoints[waypoints.length - 1], lastPoint) > 0.01) {
      waypoints.push(lastPoint);
    }

    return waypoints;
  }

  private cellToWorld(
    cell: CellCoord,
    bounds: { north: number; south: number; east: number; west: number },
    resolution: number,
    meta: { center?: { lat: number; lon: number }; originLat: number; originLon: number },
    fallbackY: number
  ): Vector3 {
    const lon = bounds.west + ((cell.col + 0.5) / resolution) * (bounds.east - bounds.west);
    const lat = bounds.north - ((cell.row + 0.5) / resolution) * (bounds.north - bounds.south);

    const centerLat = meta.center?.lat ?? meta.originLat;
    const centerLon = meta.center?.lon ?? meta.originLon;

    const x = (lon - centerLon) * METERS_PER_DEGREE * Math.cos((centerLat * Math.PI) / 180);
    const z = (lat - centerLat) * METERS_PER_DEGREE;

    const elevation = this.elevationService?.getElevationMeters(lat, lon);
    const y = elevation !== null && elevation !== undefined ? elevation + 1.7 : fallbackY;

    return { x, y, z };
  }

  private worldToLatLon(x: number, z: number, meta: { center?: { lat: number; lon: number }; originLat: number; originLon: number }): { lat: number; lon: number } {
    const centerLat = meta.center?.lat ?? meta.originLat;
    const centerLon = meta.center?.lon ?? meta.originLon;

    const lat = centerLat + z / METERS_PER_DEGREE;
    const lon = centerLon + x / (METERS_PER_DEGREE * Math.cos((centerLat * Math.PI) / 180));

    return { lat, lon };
  }

  private distanceSquared(a: Vector3, b: Vector3): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return dx * dx + dz * dz;
  }
}
