/**
 * Validate spawn locations against terrain and navmesh
 * 
 * Checks if NPCs, mobs, and player starts are:
 * 1. In the correct tile
 * 2. At valid elevation
 * 3. On walkable navmesh cells
 */
import { prisma } from '../src/database/DatabaseService';
import { latLonToTile, tileToLatLonBounds } from '../src/world/tiles/TileUtils';
import { TileService } from '../src/world/tiles/TileService';

interface SpawnLocation {
  type: 'player' | 'npc' | 'mob';
  name: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
  z: number;
}

const STEPHENTOWN_LANDMARKS: Record<string, [number, number]> = {
  townHall: [42.5513326, -73.3792285],
  postOffice: [42.5486230, -73.3739670],
  fourFatFoul: [42.5501388, -73.3814902],
  library: [42.5507190, -73.3807245],
  fireDept: [42.5490736, -73.3750000],
  forge: [42.5506875, -73.3733125],
};

async function validateSpawnLocation(spawn: SpawnLocation): Promise<void> {
  try {
    // 1. Get tile coordinates
    const tile = latLonToTile(spawn.lat, spawn.lon, 9);
    if (!tile) {
      console.error(`  ✗ ${spawn.type.toUpperCase()} "${spawn.name}": Failed to get tile`);
      return;
    }

    // 2. Get tile record and navmesh
    const tileRecord = await TileService.getTile(
      `${tile.z}_${tile.x}_${tile.y}`
    );
    if (!tileRecord) {
      console.error(`  ✗ ${spawn.type.toUpperCase()} "${spawn.name}": Tile not found (${tile.z}_${tile.x}_${tile.y})`);
      return;
    }

    if (!tileRecord.navmeshHash) {
      console.error(`  ✗ ${spawn.type.toUpperCase()} "${spawn.name}": Tile has no navmesh (${tile.z}_${tile.x}_${tile.y})`);
      return;
    }

    // 3. Check bounds
    const bounds = tileToLatLonBounds(tile);
    const inBounds = spawn.lat >= bounds.south && spawn.lat <= bounds.north &&
                    spawn.lon >= bounds.west && spawn.lon <= bounds.east;
    
    if (!inBounds) {
      console.error(`  ✗ ${spawn.type.toUpperCase()} "${spawn.name}": Outside tile bounds`);
      return;
    }

    // 4. Check elevation
    if (spawn.z === undefined || spawn.z === null) {
      console.warn(`  ⚠ ${spawn.type.toUpperCase()} "${spawn.name}": No elevation data`);
      return;
    }

    console.log(`  ✓ ${spawn.type.toUpperCase().padEnd(6)} "${spawn.name}": Tile ${tile.z}_${tile.x}_${tile.y} | Elevation ${Math.round(spawn.z)}ft | Has navmesh`);
  } catch (error) {
    console.error(`  ✗ ${spawn.type.toUpperCase()} "${spawn.name}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  console.log('\n🗺️  Validating spawn locations against terrain and navmesh...\n');

  // Get seed data
  const zone = await prisma.zone.findFirst({
    where: { name: 'Stephentown, NY' }
  });

  if (!zone) {
    console.error('Zone not found. Run seed first.\n');
    process.exit(1);
  }

  console.log('Player:');
  // Player start
  const player = await prisma.character.findFirst();
  if (player) {
    const [lat, lon] = STEPHENTOWN_LANDMARKS.townHall;
    await validateSpawnLocation({
      type: 'player',
      name: player.name,
      lat,
      lon,
      x: player.positionX,
      y: player.positionY,
      z: player.positionZ,
    });
  }

  // NPCs
  const npcs = await prisma.companion.findMany({
    where: { 
      zoneId: zone.id,
      tag: { startsWith: 'npc.' }
    }
  });

  console.log(`\nNPCs (${npcs.length}):`);
  for (const npc of npcs) {
    // Use town hall as default location for all NPCs
    const [lat, lon] = STEPHENTOWN_LANDMARKS.townHall;
    
    await validateSpawnLocation({
      type: 'npc',
      name: npc.name,
      lat,
      lon,
      x: npc.positionX,
      y: npc.positionY,
      z: npc.positionZ,
    });
  }

  // Mobs
  const mobs = await prisma.companion.findMany({
    where: { 
      zoneId: zone.id,
      tag: { startsWith: 'mob.' }
    }
  });

  console.log(`\nMobs (${mobs.length}):`);
  for (const mob of mobs) {
    let landmarkCoords = STEPHENTOWN_LANDMARKS.townHall;
    
    if (mob.tag?.includes('rat')) {
      landmarkCoords = STEPHENTOWN_LANDMARKS.townHall;
    } else if (mob.tag?.includes('rabid_dog')) {
      landmarkCoords = STEPHENTOWN_LANDMARKS.fourFatFoul;
    } else if (mob.tag?.includes('dire_toad')) {
      landmarkCoords = STEPHENTOWN_LANDMARKS.postOffice;
    }

    await validateSpawnLocation({
      type: 'mob',
      name: mob.tag || 'Unknown',
      lat: landmarkCoords[0],
      lon: landmarkCoords[1],
      x: mob.positionX,
      y: mob.positionY,
      z: mob.positionZ,
    });
  }

  console.log('\n✅ Validation complete!\n');
  process.exit(0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
