import fs   from 'fs';
import path from 'path';

import { logger }        from '@/utils/logger';
import { CollisionLayer } from '@/physics/types';
import type { PhysicsEntity, WallSegment } from '@/physics/types';

// ── OSM data shapes ───────────────────────────────────────────────────────────

interface LatLon {
  lat: number;
  lon: number;
}

interface OsmBuilding {
  id:    number | string;
  nodes: LatLon[];
}

interface DemMetadata {
  originLat: number;
  originLon: number;
  center?: { lat: number; lon: number };
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Skip wall segments shorter than this (duplicate closing-node artefacts). */
const MIN_SEGMENT_METERS = 0.5;

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * Reads the zone's OSM buildings.json and converts every polygon wall segment
 * into a static WallSegment entity that the PhysicsSystem collides players
 * against.
 *
 * Each edge of a building polygon becomes its own WallSegment.  Collision is
 * a 2D sphere-vs-line-segment check in the XZ plane (walls are infinite
 * height), so diagonal walls are pixel-perfect — no phantom AABB corners that
 * would block the player in empty space.
 *
 * Coordinate conversion mirrors PhysicsSystem.getTerrainCollision exactly:
 *   worldX =  (lon − centerLon) × metersPerDegreeLon
 *   worldZ =  (centerLat − lat) × metersPerDegreeLat
 */
export class BuildingCollisionLoader {
  static load(zoneId: string): PhysicsEntity[] {
    const buildingsPath = path.join('data', 'osm',     zoneId,                    'buildings.json');
    const demMetaPath   = path.join('data', 'terrain', `${zoneId.toLowerCase()}_dem.json`);

    if (!fs.existsSync(buildingsPath)) {
      logger.debug({ zoneId }, '[BuildingCollision] No buildings.json — skipping');
      return [];
    }
    if (!fs.existsSync(demMetaPath)) {
      logger.warn({ zoneId }, '[BuildingCollision] No DEM metadata — cannot convert lat/lon to world coords');
      return [];
    }

    // ── Coordinate origin (same as PhysicsSystem uses) ─────────────────────

    const demMeta   = JSON.parse(fs.readFileSync(demMetaPath, 'utf-8')) as DemMetadata;
    const centerLat = demMeta.center?.lat ?? demMeta.originLat;
    const centerLon = demMeta.center?.lon ?? demMeta.originLon;

    const metersPerDegreeLat = 111320;
    const metersPerDegreeLon = 111320 * Math.cos((centerLat * Math.PI) / 180);

    const toWorld = (node: LatLon) => ({
      x: (node.lon - centerLon) * metersPerDegreeLon,
      z: (centerLat - node.lat) * metersPerDegreeLat,
    });

    // ── Convert each polygon edge to a wall box ─────────────────────────────

    const buildings = JSON.parse(fs.readFileSync(buildingsPath, 'utf-8')) as OsmBuilding[];
    const entities: PhysicsEntity[] = [];

    for (const building of buildings) {
      if (!building.nodes || building.nodes.length < 3) continue;

      const nodes = building.nodes;

      // OSM polygons close on themselves (last node == first node).
      // Iterate every consecutive pair to get each wall segment.
      for (let i = 0; i < nodes.length - 1; i++) {
        const a = toWorld(nodes[i]);
        const b = toWorld(nodes[i + 1]);

        // Skip degenerate / duplicate-closing-node segments
        const segLen = Math.hypot(b.x - a.x, b.z - a.z);
        if (segLen < MIN_SEGMENT_METERS) continue;

        const wall: WallSegment = { ax: a.x, az: a.z, bx: b.x, bz: b.z };

        entities.push({
          id: `building_${building.id}_wall_${i}`,
          position: { x: (a.x + b.x) / 2, y: 0, z: (a.z + b.z) / 2 },
          boundingVolume: wall,
          type:           'static',
          collisionLayer: CollisionLayer.STRUCTURES,
        });
      }
    }

    logger.info(
      { zoneId, walls: entities.length, buildings: buildings.length },
      '[BuildingCollision] Wall colliders registered',
    );
    return entities;
  }
}
