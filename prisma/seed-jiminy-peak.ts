import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed Jiminy Peak - The Cursed Resort
 *
 * Corporate corruption caused Uzumaki spiraling paths, confusing travel patterns,
 * and general weirdness. The ski lifts still run, somehow. Corruption rises at night
 * and when alone. Groups are safer. Low-level mobs (1-6) near the lodge, with rumors
 * of a cave entrance leading to the Deep Roads.
 */
async function main() {
  console.log('=== Seeding Jiminy Peak: The Cursed Resort ===\n');

  // Coordinate calculation relative to Stephentown Town Hall (origin)
  const townHallLat = 42.5513326;
  const townHallLon = -73.3792285;

  // Jiminy Peak coordinates (37 Corey Rd, Hancock, MA)
  const jiminyPeakLat = 42.4995;
  const jiminyPeakLon = -73.2843;

  const METERS_PER_RADIAN = 6378137;
  const FEET_PER_METER = 3.28084;
  const toRadians = (deg: number) => (deg * Math.PI) / 180;

  const latLonToLocalFeet = (lat: number, lon: number) => {
    const latRad = toRadians(lat);
    const lonRad = toRadians(lon);
    const originLatRad = toRadians(townHallLat);
    const originLonRad = toRadians(townHallLon);
    const xMeters = (lonRad - originLonRad) * Math.cos((latRad + originLatRad) / 2) * METERS_PER_RADIAN;
    const yMeters = (latRad - originLatRad) * METERS_PER_RADIAN;
    return { x: xMeters * FEET_PER_METER, y: yMeters * FEET_PER_METER };
  };

  // Calculate Jiminy Peak position
  const jiminyPos = latLonToLocalFeet(jiminyPeakLat, jiminyPeakLon);
  // Approximate elevation for a ski resort base (about 2000 ft)
  const baseElevation = 2000;

  console.log(`Jiminy Peak position: (${jiminyPos.x.toFixed(0)}, ${jiminyPos.y.toFixed(0)}, ${baseElevation})`);

  // Create Jiminy Peak zone
  console.log('\nCreating Jiminy Peak zone...');

  // Check if zone already exists
  const existingZone = await prisma.zone.findFirst({
    where: { id: 'USA_MA_JiminyPeak' }
  });

  if (existingZone) {
    console.log('Zone already exists, updating...');
    await prisma.zone.update({
      where: { id: 'USA_MA_JiminyPeak' },
      data: {
        corruptionTag: 'CURSED_RESORT',
        isWarded: false,
      }
    });
    console.log('✓ Updated existing zone with corruption tag');
    return;
  }

  // Need to find an unused worldX/worldY coordinate
  // Jiminy Peak is roughly 5 miles east and 4 miles south of Stephentown
  const worldX = 1; // East of origin
  const worldY = -1; // South of origin

  const jiminyPeak = await prisma.zone.create({
    data: {
      id: 'USA_MA_JiminyPeak',
      name: 'Jiminy Peak Mountain Resort',
      description: `The base lodge of Jiminy Peak ski resort. Corporate influence before the Fall warped this place - paths spiral in on themselves like an Uzumaki nightmare, direction seems to shift when you're not looking, and the mountain itself feels... wrong. Yet the chairlifts still run, humming with an energy that shouldn't exist.

During the day, groups of travelers can enjoy relative safety. But when darkness falls, or when you find yourself alone, the corruption seeps in. The mountain watches. The snow remembers.

Rumors persist of a cave entrance near the summit - an entrance to something older and deeper than the resort. The Deep Roads, some call it.`,
      worldX,
      worldY,
      sizeX: 12000, // Large ski area
      sizeY: 1500,  // Mountain elevation range
      sizeZ: 12000,
      terrainType: 'mountain_resort',
      weatherEnabled: true,
      timeOfDayEnabled: true,
      contentRating: 'T',
      navmeshData: null,
      // Corruption system
      corruptionTag: 'CURSED_RESORT',
      isWarded: false,
    },
  });
  console.log(`✓ Created zone: ${jiminyPeak.name}`);

  // Create NPCs and mobs for the zone
  console.log('\nCreating NPCs...');

  // Lodge Keeper - helps travelers
  const lodgeKeeper = await prisma.companion.create({
    data: {
      name: 'Ada (Lodge Keeper)',
      description: 'A weathered woman who maintains the base lodge. Her eyes carry the weight of too many winters.',
      tag: 'npc.jiminy.lodgekeeper',
      personalityType: 'survivor_keeper',
      memoryData: {
        background: 'Ada has kept the lodge running since before the Fall. She knows the mountain\'s secrets but speaks of them rarely.',
        relationships: [],
        recentEvents: [],
      },
      level: 12,
      stats: {
        strength: 10,
        vitality: 14,
        dexterity: 11,
        agility: 9,
        intelligence: 13,
        wisdom: 18,
      },
      currentHealth: 180,
      maxHealth: 180,
      isAlive: true,
      zoneId: jiminyPeak.id,
      positionX: jiminyPos.x,
      positionY: baseElevation,
      positionZ: jiminyPos.y,
      llmProvider: 'anthropic',
      llmModel: 'claude-3-5-sonnet-20241022',
      systemPrompt: `You are Ada, the Lodge Keeper at Jiminy Peak. You've survived here since before the Fall.

Personality: Stoic, practical, protective of travelers. Speaks with weary wisdom.
Knowledge: You know the mountain is corrupted. You warn travelers about going alone, especially at night.
You mention that groups of 5 are safest, but even pairs have better odds.
You've heard rumors about the cave entrance but discourage exploration unless travelers are prepared.

Content Rating: Teen (13+)
Speech: Calm, measured, occasionally ominous. Uses "the mountain" as if it were alive.`,
      conversationHistory: [],
      traits: ['survivor', 'protective', 'cryptic'],
      goals: ['protect_travelers', 'maintain_lodge'],
      relationships: {},
      abilityIds: [],
      questIds: [],
    },
  });
  console.log(`✓ Created NPC: ${lodgeKeeper.name}`);

  // Lift Operator - mysterious figure
  const liftOperator = await prisma.companion.create({
    data: {
      name: 'The Operator',
      description: 'A silent figure in ski gear who operates the chairlift. You never see their face.',
      tag: 'npc.jiminy.operator',
      personalityType: 'mysterious_operator',
      memoryData: {
        background: 'No one knows who The Operator is or how long they\'ve been here.',
        relationships: [],
        recentEvents: [],
      },
      level: 15,
      stats: {
        strength: 12,
        vitality: 12,
        dexterity: 14,
        agility: 14,
        intelligence: 16,
        wisdom: 16,
      },
      currentHealth: 200,
      maxHealth: 200,
      isAlive: true,
      zoneId: jiminyPeak.id,
      positionX: jiminyPos.x + 150,
      positionY: baseElevation + 20,
      positionZ: jiminyPos.y + 50,
      llmProvider: 'anthropic',
      llmModel: 'claude-3-5-sonnet-20241022',
      systemPrompt: `You are The Operator at Jiminy Peak. You run the chairlift.

Personality: Silent, enigmatic. You rarely speak. When you do, it's brief and unsettling.
You gesture more than speak. You point travelers toward the lift, or away from danger.
You seem to know things you shouldn't.

Content Rating: Teen (13+)
Speech: Sparse. One to five words at most. Often just gestures or nods.
Example responses: "*points up the mountain*", "Not alone.", "Dawn is safer.", "*shakes head slowly*"`,
      conversationHistory: [],
      traits: ['silent', 'enigmatic', 'knowing'],
      goals: ['operate_lift', 'warn_travelers'],
      relationships: {},
      abilityIds: [],
      questIds: [],
    },
  });
  console.log(`✓ Created NPC: ${liftOperator.name}`);

  // Create low-level mobs (1-6) for the ski area
  console.log('\nCreating wildlife/mobs...');

  // Snow Hares - level 1-2, skittish
  for (let i = 1; i <= 4; i++) {
    const angle = (Math.PI * 2 * i) / 4 + Math.random() * 0.5;
    const distance = 200 + Math.random() * 300;
    await prisma.companion.create({
      data: {
        name: `Snow Hare`,
        description: 'A large white hare with too-knowing eyes. Its fur seems to shimmer.',
        tag: `mob.jiminy.hare.${i}`,
        personalityType: 'wildlife_hare',
        memoryData: { background: 'Wildlife adapted to the corrupted mountain.', relationships: [], recentEvents: [] },
        level: 1 + (i % 2),
        stats: {
          strength: 4,
          vitality: 5,
          dexterity: 12,
          agility: 14,
          intelligence: 4,
          wisdom: 6,
        },
        currentHealth: 25,
        maxHealth: 25,
        isAlive: true,
        zoneId: jiminyPeak.id,
        positionX: jiminyPos.x + Math.cos(angle) * distance,
        positionY: baseElevation + Math.random() * 100,
        positionZ: jiminyPos.y + Math.sin(angle) * distance,
        llmProvider: 'anthropic',
        llmModel: 'claude-3-5-sonnet-20241022',
        systemPrompt: 'You are a snow hare. You do not speak. Respond ONLY with NONE.',
        conversationHistory: [],
        traits: [],
        goals: [],
        relationships: {},
        abilityIds: [],
        questIds: [],
      },
    });
  }
  console.log('✓ Created 4 Snow Hares (level 1-2)');

  // Corrupted Foxes - level 3-4
  for (let i = 1; i <= 3; i++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = 400 + Math.random() * 400;
    await prisma.companion.create({
      data: {
        name: `Spiral Fox`,
        description: 'A fox with fur that seems to swirl in impossible patterns. Its movements are jerky, unnatural.',
        tag: `mob.jiminy.fox.${i}`,
        personalityType: 'corrupted_predator',
        memoryData: { background: 'A predator twisted by the mountain\'s corruption.', relationships: [], recentEvents: [] },
        level: 3 + (i % 2),
        stats: {
          strength: 8,
          vitality: 7,
          dexterity: 11,
          agility: 13,
          intelligence: 5,
          wisdom: 4,
        },
        currentHealth: 55,
        maxHealth: 55,
        isAlive: true,
        zoneId: jiminyPeak.id,
        positionX: jiminyPos.x + Math.cos(angle) * distance,
        positionY: baseElevation + 200 + Math.random() * 200,
        positionZ: jiminyPos.y + Math.sin(angle) * distance,
        llmProvider: 'anthropic',
        llmModel: 'claude-3-5-sonnet-20241022',
        systemPrompt: 'You are a corrupted fox. You do not speak. Respond ONLY with NONE.',
        conversationHistory: [],
        traits: [],
        goals: [],
        relationships: {},
        abilityIds: [],
        questIds: [],
      },
    });
  }
  console.log('✓ Created 3 Spiral Foxes (level 3-4)');

  // Mountain Elk - level 5-6, near summit
  for (let i = 1; i <= 2; i++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = 800 + Math.random() * 400;
    await prisma.companion.create({
      data: {
        name: `Twisted Elk`,
        description: 'A massive elk with antlers that branch in fractal patterns. Frost clings to its hide even in summer.',
        tag: `mob.jiminy.elk.${i}`,
        personalityType: 'corrupted_beast',
        memoryData: { background: 'An apex herbivore warped by deep corruption.', relationships: [], recentEvents: [] },
        level: 5 + (i % 2),
        stats: {
          strength: 14,
          vitality: 16,
          dexterity: 8,
          agility: 10,
          intelligence: 4,
          wisdom: 8,
        },
        currentHealth: 120,
        maxHealth: 120,
        isAlive: true,
        zoneId: jiminyPeak.id,
        positionX: jiminyPos.x + Math.cos(angle) * distance,
        positionY: baseElevation + 500 + Math.random() * 300,
        positionZ: jiminyPos.y + Math.sin(angle) * distance,
        llmProvider: 'anthropic',
        llmModel: 'claude-3-5-sonnet-20241022',
        systemPrompt: 'You are a corrupted elk. You do not speak. Respond ONLY with NONE.',
        conversationHistory: [],
        traits: [],
        goals: [],
        relationships: {},
        abilityIds: [],
        questIds: [],
      },
    });
  }
  console.log('✓ Created 2 Twisted Elk (level 5-6)');

  // Cave Guardian - hints at the Deep Roads entrance
  const caveGuardian = await prisma.companion.create({
    data: {
      name: 'Something in the Snow',
      description: 'A shape half-buried in snow near what might be a cave entrance. It watches you. It has always watched.',
      tag: 'mob.jiminy.cave_guardian',
      personalityType: 'dungeon_guardian',
      memoryData: { background: 'Guardian of the Deep Roads entrance.', relationships: [], recentEvents: [] },
      level: 10,
      stats: {
        strength: 16,
        vitality: 18,
        dexterity: 10,
        agility: 8,
        intelligence: 12,
        wisdom: 14,
      },
      currentHealth: 250,
      maxHealth: 250,
      isAlive: true,
      zoneId: jiminyPeak.id,
      positionX: jiminyPos.x + 1000,
      positionY: baseElevation + 800, // Near summit
      positionZ: jiminyPos.y + 800,
      llmProvider: 'anthropic',
      llmModel: 'claude-3-5-sonnet-20241022',
      systemPrompt: 'You are the guardian of the Deep Roads entrance. You do not speak. Respond ONLY with NONE.',
      conversationHistory: [],
      traits: [],
      goals: ['guard_entrance'],
      relationships: {},
      abilityIds: [],
      questIds: [],
    },
  });
  console.log(`✓ Created: ${caveGuardian.name} (level 10 - Deep Roads guardian)`);

  console.log('\n=== Jiminy Peak Seeded Successfully! ===');
  console.log('\nZone Info:');
  console.log(`  - Name: ${jiminyPeak.name}`);
  console.log(`  - Corruption Tag: CURSED_RESORT`);
  console.log(`  - Day corruption: 0.04/min`);
  console.log(`  - Night corruption: 0.10/min (2.5x multiplier)`);
  console.log('\nParty Corruption Reduction:');
  console.log('  - 2 members: 10% reduction');
  console.log('  - 3 members: 30% reduction');
  console.log('  - 4 members: 50% reduction');
  console.log('  - 5 members: 70% reduction');
  console.log('\nNPCs:');
  console.log(`  - ${lodgeKeeper.name} (Lodge Keeper, quest giver)`);
  console.log(`  - ${liftOperator.name} (Mysterious lift operator)`);
  console.log('\nMobs (levels 1-6):');
  console.log('  - 4x Snow Hare (level 1-2)');
  console.log('  - 3x Spiral Fox (level 3-4)');
  console.log('  - 2x Twisted Elk (level 5-6)');
  console.log('  - 1x Something in the Snow (level 10, guards Deep Roads)');
}

main()
  .catch((e) => {
    console.error('Error seeding Jiminy Peak:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
