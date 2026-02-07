import { PrismaClient } from '@prisma/client';
import { ElevationService } from './src/world/terrain/ElevationService.js';

const prisma = new PrismaClient();

async function testGravityWithFloatingMobs() {
  console.log('\n🧪 Testing Gravity with Floating Mobs\n');
  console.log('='.repeat(60));

  const elevationService = ElevationService.tryLoad();
  if (!elevationService) {
    console.error('❌ Elevation service not available');
    process.exit(1);
  }

  // Get the Stephentown zone
  const zone = await prisma.zone.findUnique({
    where: { id: 'USA_NY_Stephentown' },
  });

  if (!zone) {
    console.error('❌ Zone not found');
    process.exit(1);
  }

  const groundLevel = elevationService.getElevationMeters(zone.originLat, zone.originLon) || 265;
  console.log(`Ground level at zone center: ${groundLevel.toFixed(1)}m`);

  // Create test mobs at different heights
  const testMobs = [
    {
      name: 'Flying Test Rat (Low)',
      height: groundLevel + 10,
      description: 'Should fall 10m',
    },
    {
      name: 'Flying Test Rat (High)',
      height: groundLevel + 50,
      description: 'Should fall 50m',
    },
    {
      name: 'Flying Test Rat (Sky)',
      height: groundLevel + 100,
      description: 'Should fall 100m',
    },
  ];

  const createdMobs = [];

  for (const mobDef of testMobs) {
    const mob = await prisma.mob.create({
      data: {
        name: mobDef.name,
        description: mobDef.description,
        tag: `test.floating_rat`,
        level: 1,
        stats: {
          strength: 6,
          vitality: 6,
          dexterity: 8,
          agility: 9,
          intelligence: 3,
          wisdom: 3,
        },
        currentHealth: 35,
        maxHealth: 35,
        isAlive: true,
        zoneId: zone.id,
        positionX: Math.random() * 50 - 25, // Random X near spawn
        positionY: mobDef.height, // FLOATING HIGH
        positionZ: Math.random() * 50 - 25, // Random Z near spawn
        aiType: 'wildlife_rat',
        aggroRadius: 10,
        respawnTime: 120,
        spawnedFromTable: false,
      },
    });

    createdMobs.push(mob);
    console.log(`✓ Created: ${mob.name} at height y=${mob.positionY.toFixed(1)}m (${(mob.positionY - groundLevel).toFixed(1)}m above ground)`);
  }

  console.log('\n📍 Mobs spawned above ground. Now connecting to server to observe...\n');
  console.log('Expected behavior:');
  console.log('  - Mobs should appear floating initially');
  console.log('  - Within a few server ticks, gravity should pull them to ground level');
  console.log('  - Final positions should be near ground elevation');

  // Don't disconnect - leave mobs in DB for server to find
  console.log('\n💡 Tip: Run the physics test now and look for floating mobs falling');
  console.log('   Mobs tagged as "test.floating_rat" will be at height and should drop\n');

  process.exit(0);
}

testGravityWithFloatingMobs().catch(console.error);
