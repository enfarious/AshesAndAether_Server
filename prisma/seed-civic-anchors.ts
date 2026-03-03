import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

// === Ward anchor defaults by amenity type ===

interface AnchorDefaults {
  wardRadius: number;
  wardStrength: number;
}

const ANCHOR_DEFAULTS: Record<string, AnchorDefaults> = {
  townhall: { wardRadius: 500, wardStrength: -0.05 }, // Strongest anchor, largest radius
  library: { wardRadius: 300, wardStrength: -0.03 },  // Secondary anchor
};

// === Coordinate conversion ===
// Game world: X = East (+), Z = South (+), matching PhysicsSystem and terrain/building GLBs.
// latlon_to_local in the Python mesh generators returns Z+ = North then negates;
// we negate inline here so seed positions match the 3D meshes.

const WORLD_ORIGIN = { lat: 42.5513326, lon: -73.3792285 }; // Stephentown Town Hall
const METERS_PER_RADIAN = 6378137;
const toRadians = (deg: number) => (deg * Math.PI) / 180;

function latLonToLocalMeters(lat: number, lon: number) {
  const latRad = toRadians(lat);
  const lonRad = toRadians(lon);
  const originLatRad = toRadians(WORLD_ORIGIN.lat);
  const originLonRad = toRadians(WORLD_ORIGIN.lon);
  const xMeters =
    (lonRad - originLonRad) *
    Math.cos((latRad + originLatRad) / 2) *
    METERS_PER_RADIAN;
  // Negate: higher latitude = north = -Z in the game world
  const zMeters = -(latRad - originLatRad) * METERS_PER_RADIAN;
  return { x: xMeters, z: zMeters };
}

/**
 * Area-weighted centroid of a polygon.
 * Much more accurate than a simple vertex average for irregular or
 * L-shaped building footprints.
 *
 * Uses the shoelace formula for signed area and the standard polygon
 * centroid equations.  All computation is done relative to the first
 * vertex to avoid floating-point cancellation (raw lat/lon values like
 * -73.38 and 42.55 cause catastrophic loss of precision in the cross
 * products).  Falls back to vertex average for degenerate polygons.
 */
function computeCentroid(
  nodes: Array<{ lat: number; lon: number }>
): { lat: number; lon: number } {
  // Ensure the ring is closed (last == first)
  const ring = [...nodes];
  if (
    ring.length > 1 &&
    (ring[0].lat !== ring[ring.length - 1].lat ||
     ring[0].lon !== ring[ring.length - 1].lon)
  ) {
    ring.push(ring[0]);
  }

  const n = ring.length - 1; // number of unique vertices
  if (n < 3) {
    // Degenerate — fall back to simple average
    let sLat = 0, sLon = 0;
    for (let i = 0; i < n; i++) { sLat += ring[i].lat; sLon += ring[i].lon; }
    return { lat: sLat / n, lon: sLon / n };
  }

  // Translate to local coords (first vertex as origin) for numeric stability
  const refLat = ring[0].lat;
  const refLon = ring[0].lon;

  // Signed area (shoelace) in local coords
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1;
    const xi = ring[i].lon - refLon;
    const yi = ring[i].lat - refLat;
    const xj = ring[j].lon - refLon;
    const yj = ring[j].lat - refLat;
    area += xi * yj - xj * yi;
  }
  area *= 0.5;

  if (Math.abs(area) < 1e-20) {
    // Zero-area polygon — fall back to simple average
    let sLat = 0, sLon = 0;
    for (let i = 0; i < n; i++) { sLat += ring[i].lat; sLon += ring[i].lon; }
    return { lat: sLat / n, lon: sLon / n };
  }

  // Centroid in local coords
  let cLat = 0;
  let cLon = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1;
    const xi = ring[i].lon - refLon;
    const yi = ring[i].lat - refLat;
    const xj = ring[j].lon - refLon;
    const yj = ring[j].lat - refLat;
    const cross = xi * yj - xj * yi;
    cLat += (yi + yj) * cross;
    cLon += (xi + xj) * cross;
  }
  cLat /= 6 * area;
  cLon /= 6 * area;

  // Translate back to absolute coords
  return { lat: cLat + refLat, lon: cLon + refLon };
}

// Map OSM region directory names to zone IDs
const REGION_ZONE_MAP: Record<string, string> = {
  USA_NY_Stephentown: 'USA_NY_Stephentown',
};

async function main() {
  console.log('=== Seeding Civic Anchors ===\n');

  const osmBaseDir = path.join(process.cwd(), 'data', 'osm');
  if (!fs.existsSync(osmBaseDir)) {
    console.log('  No data/osm/ directory found. Run fetch_osm.py first.');
    return;
  }

  const regionDirs = fs
    .readdirSync(osmBaseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let totalCreated = 0;

  for (const region of regionDirs) {
    const amenitiesPath = path.join(osmBaseDir, region, 'amenities.json');
    if (!fs.existsSync(amenitiesPath)) {
      console.log(`  Skipping ${region}: no amenities.json`);
      continue;
    }

    const zoneId = REGION_ZONE_MAP[region];
    if (!zoneId) {
      console.log(`  Skipping ${region}: no zone mapping configured`);
      continue;
    }

    // Verify zone exists
    const zone = await prisma.zone.findFirst({ where: { id: zoneId } });
    if (!zone) {
      console.log(`  Skipping ${region}: zone "${zoneId}" not found in database`);
      continue;
    }

    const amenities = JSON.parse(fs.readFileSync(amenitiesPath, 'utf-8'));
    console.log(`  Processing ${region} (${amenities.length} amenities)...`);

    for (const amenity of amenities) {
      const amenityType: string | undefined = amenity.tags?.amenity;
      if (!amenityType || !(amenityType in ANCHOR_DEFAULTS)) continue;

      const defaults = ANCHOR_DEFAULTS[amenityType];
      const anchorType = amenityType === 'townhall' ? 'TOWNHALL' : 'LIBRARY';
      const name: string = amenity.tags?.name || `Unknown ${anchorType}`;

      // Determine coordinates: point node has direct lat/lon, polygon way has nodes array
      let lat: number;
      let lon: number;
      if (amenity.lat !== undefined && amenity.lon !== undefined) {
        lat = amenity.lat;
        lon = amenity.lon;
      } else if (amenity.nodes && amenity.nodes.length > 0) {
        const centroid = computeCentroid(amenity.nodes);
        lat = centroid.lat;
        lon = centroid.lon;
      } else {
        console.log(`    Skipping ${name}: no coordinates`);
        continue;
      }

      const worldPos = latLonToLocalMeters(lat, lon);

      const anchor = await prisma.civicAnchor.upsert({
        where: { osmId: amenity.id },
        create: {
          type: anchorType,
          name,
          description: `${name} - civic ward anchor`,
          lat,
          lon,
          worldX: worldPos.x,
          worldY: 0,
          worldZ: worldPos.z,
          wardRadius: defaults.wardRadius,
          wardStrength: defaults.wardStrength,
          zoneId,
          osmId: amenity.id,
          osmType: amenity.nodes ? 'way' : 'node',
          metadata: amenity.tags || {},
        },
        update: {
          name,
          lat,
          lon,
          worldX: worldPos.x,
          worldZ: worldPos.z,
          metadata: amenity.tags || {},
        },
      });

      console.log(
        `    + ${anchor.type} "${anchor.name}" at (${lat.toFixed(4)}, ${lon.toFixed(4)})` +
          ` -> world (${worldPos.x.toFixed(1)}, ${worldPos.z.toFixed(1)})` +
          ` ward=${defaults.wardRadius}m strength=${defaults.wardStrength}/min`
      );
      totalCreated++;
    }
  }

  console.log(`\n=== Civic Anchor Seed Complete ===`);
  console.log(`  Created/updated: ${totalCreated}`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
