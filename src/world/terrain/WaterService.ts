import fs from 'fs';
import path from 'path';

type WaterNode = {
  lat: number;
  lon: number;
};

type WaterFeature = {
  id: number;
  tags?: Record<string, string>;
  nodes: WaterNode[];
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  closed: boolean;
};

const EARTH_RADIUS_M = 6371000;

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function metersPerDegreeLat(): number {
  return (Math.PI * EARTH_RADIUS_M) / 180;
}

function metersPerDegreeLon(lat: number): number {
  return metersPerDegreeLat() * Math.cos(degToRad(lat));
}

function pointInPolygon(point: WaterNode, polygon: WaterNode[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lon;
    const yi = polygon[i].lat;
    const xj = polygon[j].lon;
    const yj = polygon[j].lat;
    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function distancePointToSegmentMeters(point: WaterNode, a: WaterNode, b: WaterNode): number {
  const metersLat = metersPerDegreeLat();
  const metersLon = metersPerDegreeLon(point.lat);

  const px = point.lon * metersLon;
  const py = point.lat * metersLat;
  const ax = a.lon * metersLon;
  const ay = a.lat * metersLat;
  const bx = b.lon * metersLon;
  const by = b.lat * metersLat;

  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;

  const abLenSq = abx * abx + aby * aby;
  if (abLenSq === 0) {
    const dx = px - ax;
    const dy = py - ay;
    return Math.sqrt(dx * dx + dy * dy);
  }

  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq));
  const closestX = ax + abx * t;
  const closestY = ay + aby * t;
  const dx = px - closestX;
  const dy = py - closestY;
  return Math.sqrt(dx * dx + dy * dy);
}

export class WaterService {
  private features: WaterFeature[];

  private constructor(features: WaterFeature[]) {
    this.features = features;
  }

  static tryLoad(
    waterPath: string = path.join('data', 'osm', 'USA_NY_Stephentown', 'water.json')
  ): WaterService | null {
    if (!fs.existsSync(waterPath)) {
      return null;
    }

    const raw = JSON.parse(fs.readFileSync(waterPath, 'utf-8')) as Array<{
      id: number;
      tags?: Record<string, string>;
      nodes: WaterNode[];
    }>;

    const features: WaterFeature[] = raw
      .filter(entry => Array.isArray(entry.nodes) && entry.nodes.length >= 2)
      .map(entry => {
        let minLat = Number.POSITIVE_INFINITY;
        let maxLat = Number.NEGATIVE_INFINITY;
        let minLon = Number.POSITIVE_INFINITY;
        let maxLon = Number.NEGATIVE_INFINITY;

        for (const node of entry.nodes) {
          minLat = Math.min(minLat, node.lat);
          maxLat = Math.max(maxLat, node.lat);
          minLon = Math.min(minLon, node.lon);
          maxLon = Math.max(maxLon, node.lon);
        }

        const first = entry.nodes[0];
        const last = entry.nodes[entry.nodes.length - 1];
        const closed = Math.abs(first.lat - last.lat) < 1e-6 && Math.abs(first.lon - last.lon) < 1e-6;

        return {
          id: entry.id,
          tags: entry.tags,
          nodes: entry.nodes,
          bbox: { minLat, maxLat, minLon, maxLon },
          closed,
        };
      });

    return new WaterService(features);
  }

  isWater(lat: number, lon: number): boolean {
    const point = { lat, lon };
    const lineBufferMeters = 15;
    const bufferLat = lineBufferMeters / metersPerDegreeLat();
    const bufferLon = lineBufferMeters / metersPerDegreeLon(lat);

    for (const feature of this.features) {
      const { minLat, maxLat, minLon, maxLon } = feature.bbox;
      if (
        lat < minLat - bufferLat ||
        lat > maxLat + bufferLat ||
        lon < minLon - bufferLon ||
        lon > maxLon + bufferLon
      ) {
        continue;
      }

      if (feature.closed && feature.nodes.length >= 3) {
        if (pointInPolygon(point, feature.nodes)) {
          return true;
        }
      } else {
        for (let i = 0; i < feature.nodes.length - 1; i++) {
          const distance = distancePointToSegmentMeters(point, feature.nodes[i], feature.nodes[i + 1]);
          if (distance <= lineBufferMeters) {
            return true;
          }
        }
      }
    }

    return false;
  }
}