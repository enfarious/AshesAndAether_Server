import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed: Dueling Arena
 *
 * An instanced combat sandbox. The arena is a flat 60x60ft ring surrounded by
 * a spectator area. Corruption-free (WARD_ZONE). No weather, no time-of-day.
 *
 * Layout (top-down):
 *
 *   Spectator rail  ─────────────────────────
 *                  |   [S1] [S2] [S3] [S4]   |   spectator mill zone (y: 35-55)
 *                  |                          |
 *                  |     ═══════════════      |   arena rail (y: 30)
 *                  |    ║                ║    |
 *                  |    ║  [DUMMY] (0,0) ║    |   ring center y: 0
 *                  |    ║  [PLAYER](0,-8)║    |
 *                  |    ║                ║    |
 *                  |     ═══════════════      |
 *                  |                          |
 *   ────────────────────────────────────────────
 *
 * Coordinate origin (0,0,0) = ring center
 * X axis = east/west, Z axis = north/south, Y axis = elevation
 */

const ARENA_ZONE_ID = 'ARENA_DUEL_TEMPLATE';

// Spawn point positions
const POSITIONS = {
  // Player enters here, facing the dummy
  playerStart:    { x:  0,   y: 0, z: -8  },
  // Training dummy stands at ring center
  dummy:          { x:  0,   y: 0, z:  0  },
  // Companion spawns beside the player
  companionStart: { x: -3,   y: 0, z: -8  },
  // Spectator slots - behind the rail, spread out
  spectator1:     { x: -12,  y: 0, z:  40 },
  spectator2:     { x:  -4,  y: 0, z:  40 },
  spectator3:     { x:   4,  y: 0, z:  40 },
  spectator4:     { x:  12,  y: 0, z:  40 },
};

async function main() {
  console.log('=== Seeding Dueling Arena ===\n');

  // ── Zone ─────────────────────────────────────────────────────────────────

  const existingZone = await prisma.zone.findFirst({
    where: { id: ARENA_ZONE_ID },
  });

  let arena;
  if (existingZone) {
    console.log('Arena zone already exists, skipping zone creation.');
    arena = existingZone;
  } else {
    // Arena lives at a reserved world coordinate that won't conflict with real zones
    // Using a deliberately out-of-range value so it never collides with OSM tiles
    arena = await prisma.zone.create({
      data: {
        id: ARENA_ZONE_ID,
        name: 'Dueling Arena',
        description:
          'A flat warded ring built for combat practice and sanctioned duels. ' +
          'The corruption cannot touch this place. Spectators watch from behind the rail.',
        worldX: -9999,
        worldY: -9999,
        sizeX: 80,   // feet — ring is 60ft, with 10ft buffer each side
        sizeY: 20,   // vertical clearance
        sizeZ: 100,  // ring (60ft) + spectator area (40ft)
        terrainType: 'arena',
        weatherEnabled: false,
        timeOfDayEnabled: false,
        contentRating: 'T',
        corruptionTag: 'WARD_ZONE',
        isWarded: true,
        navmeshData: {
          // Simple flat grid — entire floor is walkable except spectator rail boundary
          type: 'flat',
          walkableY: 0,
          bounds: { minX: -40, maxX: 40, minZ: -20, maxZ: 60 },
          // Rail: z=30 to z=35 is blocked (spectators can't enter ring)
          blockedRegions: [
            { minX: -30, maxX: 30, minZ: 28, maxZ: 33, label: 'arena_rail' },
          ],
          spawnPoints: {
            player:     POSITIONS.playerStart,
            companion:  POSITIONS.companionStart,
            dummy:      POSITIONS.dummy,
            spectators: [
              POSITIONS.spectator1,
              POSITIONS.spectator2,
              POSITIONS.spectator3,
              POSITIONS.spectator4,
            ],
          },
        },
      },
    });
    console.log(`✓ Created arena zone: ${arena.id}`);
  }

  // ── Training Dummy ────────────────────────────────────────────────────────
  // Uses the companion model with tag 'mob.dummy'
  // No AI controller will be wired — stays inert until arena goes ACTIVE
  // personalityType 'dummy' signals ArenaManager to never feed it to Airlock

  const existingDummy = await prisma.companion.findFirst({
    where: { tag: 'mob.dummy.template', zoneId: ARENA_ZONE_ID },
  });

  if (existingDummy) {
    console.log('Training dummy template already exists, skipping.');
  } else {
    const dummy = await prisma.companion.create({
      data: {
        name: 'Training Dummy',
        tag: 'mob.dummy.template',
        description:
          'A battered wooden post wrapped in cloth. ' +
          'It does not fight back. It does not flinch. It just takes it.',
        personalityType: 'dummy',
        memoryData: {},
        level: 1,
        stats: {
          strength:     1,
          vitality:     20,   // tanky — meant to absorb a lot of hits
          dexterity:    1,
          agility:      1,
          intelligence: 1,
          wisdom:       1,
        },
        currentHealth: 9999,
        maxHealth:     9999,
        isAlive:       true,
        zoneId:        ARENA_ZONE_ID,
        positionX:     POSITIONS.dummy.x,
        positionY:     POSITIONS.dummy.y,
        positionZ:     POSITIONS.dummy.z,
        traits:        ['inert', 'unkillable'],
        goals:         [],
        relationships: {},
        abilityIds:    [],
        questIds:      [],
      },
    });
    console.log(`✓ Created training dummy: ${dummy.id}`);
    console.log(`  Position: (${dummy.positionX}, ${dummy.positionY}, ${dummy.positionZ})`);
    console.log(`  HP: ${dummy.maxHealth} (effectively unkillable)`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log('\n=== Arena Ready ===');
  console.log(`Zone ID:          ${ARENA_ZONE_ID}`);
  console.log(`Ring size:        60x60 ft`);
  console.log(`Player spawn:     (${POSITIONS.playerStart.x}, ${POSITIONS.playerStart.y}, ${POSITIONS.playerStart.z})`);
  console.log(`Companion spawn:  (${POSITIONS.companionStart.x}, ${POSITIONS.companionStart.y}, ${POSITIONS.companionStart.z})`);
  console.log(`Dummy position:   (${POSITIONS.dummy.x}, ${POSITIONS.dummy.y}, ${POSITIONS.dummy.z})`);
  console.log(`Spectator slots:  4 (behind rail at z=40)`);
  console.log('\nUsage:');
  console.log('  /arena create          — spin up your personal instance');
  console.log('  /arena open            — allow spectators to enter');
  console.log('  /arena spawn dummy     — place training dummy in ring');
  console.log('  /arena start           — begin 3..2..1..Fight countdown');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
