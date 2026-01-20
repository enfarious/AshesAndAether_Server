import { ZoneService, prisma } from '@/database';
import { ZoneManager } from '@/world/ZoneManager';
import { logger } from '@/utils/logger';

async function main() {
  logger.info('Starting proximity mob test');

  // Get a zone to test in
  const zones = await ZoneService.findAll();
  if (zones.length === 0) {
    throw new Error('No zones found. Seed a zone before running this test.');
  }
  const zone = zones[0];
  logger.info({ zoneId: zone.id, zoneName: zone.name }, 'Using first zone');

  // Ensure a mob-tagged companion exists in this zone
  const mobTag = 'mob.test_wolf';
  let mobCompanion = await prisma.companion.findFirst({ where: { tag: mobTag, zoneId: zone.id } });
  let createdCompanionId: string | null = null;

  if (!mobCompanion) {
    mobCompanion = await prisma.companion.create({
      data: {
        name: 'Test Wolf',
        tag: mobTag,
        description: 'A test mob wolf',
        personalityType: 'hostile',
        memoryData: {},
        level: 1,
        stats: {},
        currentHealth: 50,
        maxHealth: 50,
        isAlive: true,
        zoneId: zone.id,
        positionX: 10,
        positionY: 0,
        positionZ: 10,
        traits: [],
        goals: [],
        relationships: {},
        abilityIds: [],
        questIds: [],
      },
    });
    createdCompanionId = mobCompanion.id;
    logger.info({ companionId: mobCompanion.id }, 'Created mob-tagged companion for test');
  }

  // Initialize zone manager and load companions
  const zm = new ZoneManager(zone);
  await zm.initialize();

  // Add a player near the mob
  const playerId = 'player-test-1';
  zm.addPlayer(
    {
      id: playerId,
      accountId: 'acc-test',
      name: 'Test Player',
      level: 1,
      experience: 0,
      abilityPoints: 0,
      supernaturalType: null,
      supernaturalData: null,
      strength: 10,
      vitality: 10,
      dexterity: 10,
      agility: 10,
      intelligence: 10,
      wisdom: 10,
      maxHp: 200,
      maxStamina: 100,
      maxMana: 100,
      attackRating: 30,
      defenseRating: 5,
      magicAttack: 30,
      magicDefense: 5,
      currentHp: 200,
      currentStamina: 100,
      currentMana: 100,
      isAlive: true,
      zoneId: zone.id,
      positionX: 0,
      positionY: 0,
      positionZ: 0,
      heading: 0,
      rotation: 0,
      unlockedFeats: [],
      unlockedAbilities: [],
      activeLoadout: [],
      passiveLoadout: [],
      specialLoadout: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSeenAt: new Date(),
    } as any,
    'socket-test-1',
    false
  );

  // Calculate proximity roster for the player
  const rosterResult = zm.calculateProximityRoster(playerId);
  if (!rosterResult) {
    throw new Error('Proximity roster did not compute.');
  }

  const { roster } = rosterResult;
  const seeEntities = roster.channels.see.entities.map(e => ({ id: e.id, name: e.name, type: e.type, range: e.range }));

  // Print concise results
  console.log('SEE channel entities:', seeEntities);

  const hasMob = seeEntities.some(e => e.id === mobCompanion!.id && e.type === 'mob');
  if (!hasMob) {
    console.error('ERROR: Mob companion did not appear with type "mob" in proximity roster.');
    process.exitCode = 1;
  } else {
    console.log('SUCCESS: Mob companion appears with type "mob" in proximity roster.');
  }

  // Cleanup created test companion
  if (createdCompanionId) {
    await prisma.companion.delete({ where: { id: createdCompanionId } });
    logger.info({ companionId: createdCompanionId }, 'Deleted test mob companion');
  }
}

main()
  .catch(err => {
    console.error('Test failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await prisma.$disconnect(); } catch {}
  });
