import { PrismaClient } from '@prisma/client';
import { ElevationService } from '../src/world/terrain/ElevationService';

const prisma = new PrismaClient();

async function main() {
  console.log('≡ƒî▒ Seeding database...');

  const townHallLat = 42.5513326;
  const townHallLon = -73.3792285;

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

  const elevationService = ElevationService.tryLoad();
  const townHallElevation = elevationService?.getElevationFeet(townHallLat, townHallLon) ?? 0;
  const townHall = { x: 0, y: 0, z: townHallElevation };
  const postOfficeLat = 42.5486230;
  const postOfficeLon = -73.3739670;
  const fourFatFoulLat = 42.5501388;
  const fourFatFoulLon = -73.3814902;

  const postOfficePos = {
    ...latLonToLocalFeet(postOfficeLat, postOfficeLon),
    z: elevationService?.getElevationFeet(postOfficeLat, postOfficeLon) ?? townHallElevation,
  };
  const fourFatFoulPos = {
    ...latLonToLocalFeet(fourFatFoulLat, fourFatFoulLon),
    z: elevationService?.getElevationFeet(fourFatFoulLat, fourFatFoulLon) ?? townHallElevation,
  };

  // Create starter zone: Stephentown Town Hall
  console.log('Creating Stephentown Town Hall zone...');
  const crossroads = await prisma.zone.create({
    data: {
      id: 'USA_NY_Stephentown',
      name: 'Stephentown, NY',
      description:
        'The Stephentown Town Hall on Grange Hall Rd. Weathered clapboard walls, a small lawn, and quiet civic pride. The air is still, with distant birdsong and the rustle of leaves.',
      worldX: 0,
      worldY: 0,
      sizeX: 8000,
      sizeY: 50,
      sizeZ: 8000,
      terrainType: 'wilderness',
      weatherEnabled: true,
      timeOfDayEnabled: true,
      contentRating: 'T', // Teen - public starting area
      navmeshData: null, // TODO: Add navmesh data
    },
  });
  console.log(`Γ£ô Created zone: ${crossroads.name}`);

  // Create a test account
  console.log('Creating test account...');
  const testAccount = await prisma.account.create({
    data: {
      email: 'test@worldofdarkness.com',
      username: 'TestPlayer',
      passwordHash: '$2b$10$dummyhashforseeddataonly', // Not a real hash, just for seeding
    },
  });
  console.log(`Γ£ô Created account: ${testAccount.username}`);

  // Create a test character for the account
  console.log('Creating test character...');
  const testCharacter = await prisma.character.create({
    data: {
      accountId: testAccount.id,
      name: 'Wanderer',
      level: 1,
      experience: 0,
      abilityPoints: 0,

      // Core stats (all 10 - balanced starter)
      strength: 10,
      vitality: 10,
      dexterity: 10,
      agility: 10,
      intelligence: 10,
      wisdom: 10,

      // Derived stats (defaults from schema)
      maxHp: 200,
      maxStamina: 100,
      maxMana: 100,
      attackRating: 30,
      defenseRating: 5,
      magicAttack: 30,
      magicDefense: 5,

      // Current state (full health)
      currentHp: 200,
      currentStamina: 100,
      currentMana: 100,

      // Starting position at Stephentown Town Hall
      zoneId: crossroads.id,
      positionX: townHall.x,
      positionY: townHall.y,
      positionZ: townHall.z,
      heading: 0, // Facing north
      isAlive: true,

      // Progression
      unlockedFeats: [],
      unlockedAbilities: [],
      activeLoadout: [],
      passiveLoadout: [],
      specialLoadout: [],
    },
  });
  console.log(`Γ£ô Created character: ${testCharacter.name} (Level ${testCharacter.level})`);

  // Create an NPC companion in the zone
  console.log('Creating NPC companion...');
  const merchant = await prisma.companion.create({
    data: {
      name: 'Old Merchant',
      description: 'A weathered merchant with kind eyes, tending a small cart of mysterious wares.',
      tag: 'npc.merchant.old',
      personalityType: 'friendly_merchant',
      memoryData: {
        background: 'Has traveled the roads for decades, knows many secrets.',
        relationships: [],
        recentEvents: [],
      },
      level: 5,
      stats: {
        strength: 8,
        vitality: 12,
        dexterity: 10,
        agility: 8,
        intelligence: 14,
        wisdom: 16,
      },
      currentHealth: 150,
      maxHealth: 150,
      isAlive: true,
      zoneId: crossroads.id,
      positionX: townHall.x + 2,
      positionY: townHall.y,
      positionZ: townHall.z - 2,
      llmProvider: 'anthropic',
      llmModel: 'claude-3-5-sonnet-20241022',
      systemPrompt: `You are the Old Merchant, a wise and friendly NPC at Stephentown Town Hall.
You've traveled these roads for decades and know many secrets of Stephentown.
You're here to help new adventurers and offer guidance (and occasionally sell useful items).

Content Rating: Teen (13+) - Keep language mild, no graphic content.
Personality: Warm, wise, occasionally cryptic, enjoys wordplay.
Speech pattern: Calm and measured, uses "traveler" or "friend" when addressing others.`,
      conversationHistory: [],
    },
  });
  console.log(`Γ£ô Created NPC: ${merchant.name}`);

  console.log('Creating hireable NPCs...');
  const swordsman = await prisma.companion.create({
    data: {
      name: 'Hired Swordsman',
      description: 'A seasoned swordsman in patched armor, waiting for work.',
      tag: 'npc.hire.swordsman',
      personalityType: 'hireling_swordsman',
      memoryData: { background: 'A local blade for hire in Stephentown.', relationships: [], recentEvents: [] },
      level: 3,
      stats: {
        strength: 12,
        vitality: 11,
        dexterity: 10,
        agility: 11,
        intelligence: 8,
        wisdom: 9,
      },
      currentHealth: 120,
      maxHealth: 120,
      isAlive: true,
      zoneId: crossroads.id,
      positionX: townHall.x + 4,
      positionY: townHall.y,
      positionZ: townHall.z + 2,
      llmProvider: 'anthropic',
      llmModel: 'claude-3-5-sonnet-20241022',
      systemPrompt: `You are a swordsman for hire at Stephentown Town Hall.
You speak plainly and evaluate adventurers for competence.
If asked about hire, explain your terms and availability.
Content Rating: Teen (13+) - Keep language mild, no graphic content.`,
      conversationHistory: [],
    },
  });

  const bowman = await prisma.companion.create({
    data: {
      name: 'Hired Bowman',
      description: 'A calm bowman with a longbow and a keen eye.',
      tag: 'npc.hire.bowman',
      personalityType: 'hireling_bowman',
      memoryData: { background: 'A local bowman for hire in Stephentown.', relationships: [], recentEvents: [] },
      level: 3,
      stats: {
        strength: 9,
        vitality: 10,
        dexterity: 13,
        agility: 12,
        intelligence: 10,
        wisdom: 10,
      },
      currentHealth: 110,
      maxHealth: 110,
      isAlive: true,
      zoneId: crossroads.id,
      positionX: townHall.x - 4,
      positionY: townHall.y,
      positionZ: townHall.z + 2,
      llmProvider: 'anthropic',
      llmModel: 'claude-3-5-sonnet-20241022',
      systemPrompt: `You are a bowman for hire at Stephentown Town Hall.
You are observant, concise, and willing to travel for the right job.
Content Rating: Teen (13+) - Keep language mild, no graphic content.`,
      conversationHistory: [],
    },
  });
  console.log(`✓ Created NPCs: ${swordsman.name}, ${bowman.name}`);

  console.log('Creating nearby wildlife...');
  const createRat = async (index: number) => {
    const angle = Math.random() * Math.PI * 2;
    const distance = 10 + Math.random() * 15;
    return prisma.companion.create({
      data: {
        name: `Rat ${index}`,
        description: 'A scrappy town rat, skittish but bold.',
        tag: `mob.rat.${index}`,
        personalityType: 'wildlife_rat',
        memoryData: { background: 'A scavenger outside the town hall.', relationships: [], recentEvents: [] },
        level: 1 + (index % 3),
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
        zoneId: crossroads.id,
        positionX: townHall.x + Math.cos(angle) * distance,
        positionY: townHall.y,
        positionZ: townHall.z + Math.sin(angle) * distance,
        llmProvider: 'anthropic',
        llmModel: 'claude-3-5-sonnet-20241022',
        systemPrompt: 'You are a rat. You do not speak. Respond ONLY with NONE.',
        conversationHistory: [],
      },
    });
  };

  const rats = await Promise.all([1, 2, 3, 4, 5].map(i => createRat(i)));
  console.log(`✓ Created ${rats.length} rats near the town hall`);

  const rabidDog = await prisma.companion.create({
    data: {
      name: 'Rabid Dog',
      description: 'A gaunt dog with a wild stare, pacing near Four Fat Foul.',
      tag: 'mob.rabid_dog',
      personalityType: 'wildlife_dog',
      memoryData: { background: 'A dangerous stray near Four Fat Foul.', relationships: [], recentEvents: [] },
      level: 7,
      stats: {
        strength: 12,
        vitality: 11,
        dexterity: 12,
        agility: 14,
        intelligence: 4,
        wisdom: 5,
      },
      currentHealth: 140,
      maxHealth: 140,
      isAlive: true,
      zoneId: crossroads.id,
      positionX: fourFatFoulPos.x,
      positionY: fourFatFoulPos.y,
      positionZ: fourFatFoulPos.z,
      llmProvider: 'anthropic',
      llmModel: 'claude-3-5-sonnet-20241022',
      systemPrompt: 'You are a rabid dog. You do not speak. Respond ONLY with NONE.',
      conversationHistory: [],
    },
  });

  const direToad = await prisma.companion.create({
    data: {
      name: 'Dire Toad',
      description: 'A massive toad lurking behind the post office.',
      tag: 'mob.dire_toad',
      personalityType: 'wildlife_toad',
      memoryData: { background: 'A toad nesting behind the post office.', relationships: [], recentEvents: [] },
      level: 6,
      stats: {
        strength: 11,
        vitality: 13,
        dexterity: 6,
        agility: 7,
        intelligence: 3,
        wisdom: 4,
      },
      currentHealth: 160,
      maxHealth: 160,
      isAlive: true,
      zoneId: crossroads.id,
      positionX: postOfficePos.x - 30,
      positionY: postOfficePos.y - 40,
      positionZ: postOfficePos.z,
      llmProvider: 'anthropic',
      llmModel: 'claude-3-5-sonnet-20241022',
      systemPrompt: 'You are a dire toad. You do not speak. Respond ONLY with NONE.',
      conversationHistory: [],
    },
  });
  console.log(`✓ Created mobs: ${rabidDog.name}, ${direToad.name}`);

  // Create basic combat ability (hybrid metadata)
  console.log('Creating basic combat ability...');
  await prisma.ability.upsert({
    where: { id: 'basic_attack' },
    update: {
      name: 'Basic Attack',
      description: 'A simple weapon strike.',
      data: {
        targetType: 'enemy',
        range: 2,
        cooldown: 0,
        atbCost: 100,
        staminaCost: 5,
        damage: {
          type: 'physical',
          amount: 8,
          scalingStat: 'strength',
          scalingMultiplier: 0.4,
        },
      },
    },
    create: {
      id: 'basic_attack',
      name: 'Basic Attack',
      description: 'A simple weapon strike.',
      data: {
        targetType: 'enemy',
        range: 2,
        cooldown: 0,
        atbCost: 100,
        staminaCost: 5,
        damage: {
          type: 'physical',
          amount: 8,
          scalingStat: 'strength',
          scalingMultiplier: 0.4,
        },
      },
    },
  });
  console.log('Γ£ô Created ability: Basic Attack');

  // Create some basic item templates
  console.log('Creating item templates...');

  const tagNames = [
    'weapon',
    'sword',
    'mace',
    'spear',
    'staff',
    'elemental',
    'fire',
    'armor',
    'plate',
    'leather',
    'cloth',
  ];

  const tags = new Map<string, { id: string; name: string }>();
  for (const name of tagNames) {
    const tag = await prisma.itemTag.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    tags.set(name, tag);
  }

  const rustySword = await prisma.itemTemplate.create({
    data: {
      name: 'Rusty Sword',
      description: 'An old iron sword, covered in rust but still serviceable.',
      itemType: 'weapon',
      properties: {
        equipSlots: ['right_hand', 'left_hand'],
        weapon: {
          baseDamage: 12,
          speed: 2.4,
          damageProfiles: [
            { damageType: 'physical', physicalType: 'slash', ratio: 1 },
          ],
        },
      },
      value: 50,
      stackable: false,
      maxStackSize: 1,
      tags: {
        create: [
          { tagId: tags.get('weapon')!.id },
          { tagId: tags.get('sword')!.id },
        ],
      },
    },
  });

  const ironMace = await prisma.itemTemplate.create({
    data: {
      name: 'Iron Mace',
      description: 'A heavy mace with a dented steel head.',
      itemType: 'weapon',
      properties: {
        equipSlots: ['right_hand', 'left_hand'],
        weapon: {
          baseDamage: 14,
          speed: 2.8,
          damageProfiles: [
            { damageType: 'physical', physicalType: 'blunt', ratio: 1 },
          ],
        },
      },
      value: 65,
      stackable: false,
      maxStackSize: 1,
      tags: {
        create: [
          { tagId: tags.get('weapon')!.id },
          { tagId: tags.get('mace')!.id },
        ],
      },
    },
  });

  const ashwoodSpear = await prisma.itemTemplate.create({
    data: {
      name: 'Ashwood Spear',
      description: 'A long ashwood spear with a sharpened tip.',
      itemType: 'weapon',
      properties: {
        equipSlots: ['right_hand', 'left_hand'],
        weapon: {
          baseDamage: 13,
          speed: 2.6,
          damageProfiles: [
            { damageType: 'physical', physicalType: 'pierce', ratio: 1 },
          ],
        },
      },
      value: 60,
      stackable: false,
      maxStackSize: 1,
      tags: {
        create: [
          { tagId: tags.get('weapon')!.id },
          { tagId: tags.get('spear')!.id },
        ],
      },
    },
  });

  const morningStar = await prisma.itemTemplate.create({
    data: {
      name: 'Morning Star',
      description: 'A spiked flail that crushes and pierces.',
      itemType: 'weapon',
      properties: {
        equipSlots: ['right_hand', 'left_hand'],
        weapon: {
          baseDamage: 15,
          speed: 2.9,
          damageProfiles: [
            { damageType: 'physical', physicalType: 'blunt', ratio: 0.7 },
            { damageType: 'physical', physicalType: 'pierce', ratio: 0.3 },
          ],
        },
      },
      value: 90,
      stackable: false,
      maxStackSize: 1,
      tags: {
        create: [
          { tagId: tags.get('weapon')!.id },
          { tagId: tags.get('mace')!.id },
        ],
      },
    },
  });

  const fireStaff = await prisma.itemTemplate.create({
    data: {
      name: 'Fire Staff',
      description: 'A staff that hums with heat, ideal for back-line casters.',
      itemType: 'weapon',
      properties: {
        equipSlots: ['right_hand', 'left_hand'],
        weapon: {
          baseDamage: 11,
          speed: 2.7,
          damageProfiles: [
            { damageType: 'fire', ratio: 1 },
          ],
        },
      },
      value: 110,
      stackable: false,
      maxStackSize: 1,
      tags: {
        create: [
          { tagId: tags.get('weapon')!.id },
          { tagId: tags.get('staff')!.id },
          { tagId: tags.get('elemental')!.id },
          { tagId: tags.get('fire')!.id },
        ],
      },
    },
  });

  const steelBreastplate = await prisma.itemTemplate.create({
    data: {
      name: 'Steel Breastplate',
      description: 'Solid plate armor that shrugs off slashes and thrusts.',
      itemType: 'armor',
      properties: {
        equipSlots: ['chest'],
        armor: {
          qualityBias: {
            slash: 0.18,
            pierce: 0.25,
            blunt: -0.12,
          },
        },
      },
      value: 140,
      stackable: false,
      maxStackSize: 1,
      tags: {
        create: [
          { tagId: tags.get('armor')!.id },
          { tagId: tags.get('plate')!.id },
        ],
      },
    },
  });

  const leatherJerkin = await prisma.itemTemplate.create({
    data: {
      name: 'Leather Jerkin',
      description: 'A supple jerkin offering modest protection.',
      itemType: 'armor',
      properties: {
        equipSlots: ['chest'],
        armor: {
          qualityBias: {
            slash: 0.08,
            pierce: -0.05,
            blunt: 0.02,
          },
        },
      },
      value: 80,
      stackable: false,
      maxStackSize: 1,
      tags: {
        create: [
          { tagId: tags.get('armor')!.id },
          { tagId: tags.get('leather')!.id },
        ],
      },
    },
  });

  const silkRobe = await prisma.itemTemplate.create({
    data: {
      name: 'Silk Robe',
      description: 'Light robes that favor mobility over protection.',
      itemType: 'armor',
      properties: {
        equipSlots: ['chest'],
        armor: {
          qualityBias: {
            slash: 0,
            pierce: 0,
            blunt: 0,
          },
        },
      },
      value: 60,
      stackable: false,
      maxStackSize: 1,
      tags: {
        create: [
          { tagId: tags.get('armor')!.id },
          { tagId: tags.get('cloth')!.id },
        ],
      },
    },
  });

  const healthPotion = await prisma.itemTemplate.create({
    data: {
      name: 'Health Potion',
      description: 'A small vial of red liquid that restores vitality.',
      itemType: 'consumable',
      properties: {
        consumableType: 'potion',
        effect: {
          type: 'heal',
          amount: 50,
        },
        cooldown: 30,
      },
      value: 25,
      stackable: true,
      maxStackSize: 20,
    },
  });

  console.log(`Γ£ô Created item templates: ${rustySword.name}, ${ironMace.name}, ${ashwoodSpear.name}, ${morningStar.name}, ${fireStaff.name}, ${steelBreastplate.name}, ${leatherJerkin.name}, ${silkRobe.name}, ${healthPotion.name}`);

  // Give the test character a starting weapon
  console.log('Equipping test character...');
  await prisma.inventoryItem.create({
    data: {
      characterId: testCharacter.id,
      itemTemplateId: rustySword.id,
      quantity: 1,
      equipped: true,
      equipSlot: 'right_hand',
    },
  });

  // Give the test character some health potions
  await prisma.inventoryItem.create({
    data: {
      characterId: testCharacter.id,
      itemTemplateId: healthPotion.id,
      quantity: 5,
      equipped: false,
    },
  });

  await prisma.inventoryItem.create({
    data: {
      characterId: testCharacter.id,
      itemTemplateId: fireStaff.id,
      quantity: 1,
      equipped: false,
    },
  });

  await prisma.inventoryItem.create({
    data: {
      characterId: testCharacter.id,
      itemTemplateId: steelBreastplate.id,
      quantity: 1,
      equipped: false,
    },
  });

  await prisma.inventoryItem.create({
    data: {
      characterId: testCharacter.id,
      itemTemplateId: leatherJerkin.id,
      quantity: 1,
      equipped: false,
    },
  });

  await prisma.inventoryItem.create({
    data: {
      characterId: testCharacter.id,
      itemTemplateId: silkRobe.id,
      quantity: 1,
      equipped: false,
    },
  });

  console.log('Γ£ô Added starting equipment to test character');

  console.log('\nΓ£à Database seeded successfully!');
  console.log('\nSeeded data:');
  console.log(`  - 1 zone: ${crossroads.name}`);
  console.log(`  - 1 account: ${testAccount.username}`);
  console.log(`  - 1 character: ${testCharacter.name}`);
  console.log(`  - 3 NPCs: ${merchant.name}, ${swordsman.name}, ${bowman.name}`);
  console.log(`  - 7 mobs: 5 rats, ${rabidDog.name}, ${direToad.name}`);
  console.log(`  - 1 ability (basic_attack)`);
  console.log(`  - 9 item templates`);
  console.log(`  - Character equipped with ${rustySword.name} and 5x ${healthPotion.name}`);
  console.log(`  - Character inventory includes ${fireStaff.name}, ${steelBreastplate.name}, ${leatherJerkin.name}, ${silkRobe.name}`);
  console.log('\nYou can now connect with:');
  console.log(`  Email: ${testAccount.email}`);
  console.log(`  Character: ${testCharacter.name}`);
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
