/**
 * Seed guild system data only (world points, library beacons, fuel items)
 * Run with: npx tsx prisma/seed-guild.ts
 */
import { PrismaClient } from '@prisma/client';
import { ElevationService } from '../src/world/terrain/ElevationService';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding guild system data...');

  const townHallLat = 42.5513326;
  const townHallLon = -73.3792285;

  const METERS_PER_RADIAN = 6378137;
  const toRadians = (deg: number) => (deg * Math.PI) / 180;

  const latLonToLocalMeters = (lat: number, lon: number) => {
    const latRad = toRadians(lat);
    const lonRad = toRadians(lon);
    const originLatRad = toRadians(townHallLat);
    const originLonRad = toRadians(townHallLon);
    const xMeters = (lonRad - originLonRad) * Math.cos((latRad + originLatRad) / 2) * METERS_PER_RADIAN;
    const zMeters = (latRad - originLatRad) * METERS_PER_RADIAN;
    return { x: xMeters, z: zMeters };
  };

  const elevationService = ElevationService.tryLoad();
  const townHallElevation = elevationService?.getElevationMeters(townHallLat, townHallLon) ?? 265;
  const townHall = { x: 0, y: townHallElevation, z: 0 };

  // Find the Stephentown zone
  const zone = await prisma.zone.findUnique({ where: { id: 'USA_NY_Stephentown' } });
  if (!zone) {
    console.error('Zone USA_NY_Stephentown not found. Run the main seed first.');
    process.exit(1);
  }

  // ── Item tags ──────────────────────────────────────────
  const tagNames = ['material', 'fuel', 'wood', 'beacon'];
  const tags = new Map<string, { id: string; name: string }>();
  for (const name of tagNames) {
    const tag = await prisma.itemTag.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    tags.set(name, tag);
  }

  // ── Wood fuel item templates (5 tiers) ─────────────────
  const fuelDefs = [
    { name: 'Common Wood', desc: 'Rough-cut firewood gathered from fallen branches. Burns quickly but serves for basic beacon fuel.', tier: 1, value: 5 },
    { name: 'Seasoned Wood', desc: 'Carefully dried hardwood that burns longer and steadier. Suitable for Tier 2 beacons.', tier: 2, value: 15 },
    { name: 'Darkwood', desc: 'Timber from corrupted groves, dense and slow-burning. Fuels Tier 3 beacons.', tier: 3, value: 40 },
    { name: 'Embered Wood', desc: 'Rare wood infused with latent heat, glowing faintly at the grain. Fuels Tier 4 beacons.', tier: 4, value: 100 },
    { name: 'Void Timber', desc: 'Wood that has passed through the deepest corruption and emerged transformed. Fuels Tier 5 beacons.', tier: 5, value: 250 },
  ];

  for (const def of fuelDefs) {
    const existing = await prisma.itemTemplate.findFirst({ where: { name: def.name } });
    if (existing) {
      console.log(`  Skipping ${def.name} (already exists)`);
      continue;
    }
    await prisma.itemTemplate.create({
      data: {
        name: def.name,
        description: def.desc,
        itemType: 'material',
        properties: { fuelTier: def.tier, fuelHours: 4, beaconFuel: true },
        value: def.value,
        stackable: true,
        maxStackSize: 50,
        tags: {
          create: [
            { tagId: tags.get('material')!.id },
            { tagId: tags.get('fuel')!.id },
            { tagId: tags.get('wood')!.id },
          ],
        },
      },
    });
    console.log(`  Created ${def.name}`);
  }

  // Soul Ember
  const existingEmber = await prisma.itemTemplate.findFirst({ where: { name: 'Soul Ember' } });
  if (!existingEmber) {
    await prisma.itemTemplate.create({
      data: {
        name: 'Soul Ember',
        description: 'A crystallized ember pulsing with faint warmth. Required to ignite a guild beacon at a world point.',
        itemType: 'material',
        properties: { beaconIgniter: true },
        value: 200,
        stackable: true,
        maxStackSize: 10,
        tags: {
          create: [
            { tagId: tags.get('material')!.id },
            { tagId: tags.get('beacon')!.id },
          ],
        },
      },
    });
    console.log('  Created Soul Ember');
  } else {
    console.log('  Skipping Soul Ember (already exists)');
  }

  // ── Guild world points ─────────────────────────────────
  const existingPoints = await prisma.guildWorldPoint.count({ where: { zoneId: zone.id } });
  if (existingPoints > 0) {
    console.log(`  Skipping world points (${existingPoints} already exist)`);
  } else {
    const churchPos = latLonToLocalMeters(42.5520, -73.3770);
    const parkPos = latLonToLocalMeters(42.5508, -73.3800);
    const cemeteryPos = latLonToLocalMeters(42.5530, -73.3750);
    const mountainPos = latLonToLocalMeters(42.5570, -73.3700);

    await Promise.all([
      prisma.guildWorldPoint.create({
        data: {
          name: 'Stephentown Town Hall',
          description: 'The civic anchor of Stephentown.',
          lat: townHallLat, lon: townHallLon,
          worldX: townHall.x, worldY: townHall.y, worldZ: townHall.z,
          zoneId: zone.id, tierHint: 1,
        },
      }),
      prisma.guildWorldPoint.create({
        data: {
          name: 'Stephentown Park',
          description: 'A small green space with old oaks and a rusted bench.',
          lat: 42.5508, lon: -73.3800,
          worldX: parkPos.x,
          worldY: elevationService?.getElevationMeters(42.5508, -73.3800) ?? townHallElevation,
          worldZ: parkPos.z,
          zoneId: zone.id, tierHint: 1,
        },
      }),
      prisma.guildWorldPoint.create({
        data: {
          name: 'St. Joseph\'s Church',
          description: 'A weathered white church on a gentle hill.',
          lat: 42.5520, lon: -73.3770,
          worldX: churchPos.x,
          worldY: elevationService?.getElevationMeters(42.5520, -73.3770) ?? townHallElevation,
          worldZ: churchPos.z,
          zoneId: zone.id, tierHint: 2,
        },
      }),
      prisma.guildWorldPoint.create({
        data: {
          name: 'Garfield Cemetery',
          description: 'An old cemetery with mossy headstones. The ground hums with latent energy.',
          lat: 42.5530, lon: -73.3750,
          worldX: cemeteryPos.x,
          worldY: elevationService?.getElevationMeters(42.5530, -73.3750) ?? townHallElevation,
          worldZ: cemeteryPos.z,
          zoneId: zone.id, tierHint: 3,
        },
      }),
      prisma.guildWorldPoint.create({
        data: {
          name: 'Berlin Mountain Overlook',
          description: 'A rocky outcrop near the summit, overlooking the valley.',
          lat: 42.5570, lon: -73.3700,
          worldX: mountainPos.x,
          worldY: elevationService?.getElevationMeters(42.5570, -73.3700) ?? (townHallElevation + 200),
          worldZ: mountainPos.z,
          zoneId: zone.id, tierHint: 4,
        },
      }),
    ]);
    console.log('  Created 5 guild world points (T1, T1, T2, T3, T4)');
  }

  // ── Library beacons ────────────────────────────────────
  const existingLibraries = await prisma.libraryBeacon.count({ where: { zoneId: zone.id } });
  if (existingLibraries > 0) {
    console.log(`  Skipping library beacons (${existingLibraries} already exist)`);
  } else {
    const libraryPos = latLonToLocalMeters(42.5505, -73.3785);
    const hancockPos = latLonToLocalMeters(42.5488, -73.3720);

    await Promise.all([
      prisma.libraryBeacon.create({
        data: {
          name: 'Stephentown Public Library',
          description: 'A small but well-stocked library. Its beacon provides services and protection.',
          worldX: libraryPos.x,
          worldY: elevationService?.getElevationMeters(42.5505, -73.3785) ?? townHallElevation,
          worldZ: libraryPos.z,
          zoneId: zone.id,
          catchmentRadius: 500,
          isOnline: true,
        },
      }),
      prisma.libraryBeacon.create({
        data: {
          name: 'Hancock Library',
          description: 'A sturdy stone library on the eastern edge of Stephentown.',
          worldX: hancockPos.x,
          worldY: elevationService?.getElevationMeters(42.5488, -73.3720) ?? townHallElevation,
          worldZ: hancockPos.z,
          zoneId: zone.id,
          catchmentRadius: 400,
          isOnline: true,
        },
      }),
    ]);
    console.log('  Created 2 library beacons');
  }

  // ── Give test character fuel items ─────────────────────
  const testChar = await prisma.character.findFirst({ where: { name: 'Wanderer' } });
  if (testChar) {
    const commonWood = await prisma.itemTemplate.findFirst({ where: { name: 'Common Wood' } });
    const soulEmber = await prisma.itemTemplate.findFirst({ where: { name: 'Soul Ember' } });

    if (commonWood) {
      const hasWood = await prisma.inventoryItem.findFirst({
        where: { characterId: testChar.id, itemTemplateId: commonWood.id },
      });
      if (!hasWood) {
        await prisma.inventoryItem.create({
          data: { characterId: testChar.id, itemTemplateId: commonWood.id, quantity: 10, equipped: false },
        });
        console.log('  Added 10x Common Wood to Wanderer');
      }
    }

    if (soulEmber) {
      const hasEmber = await prisma.inventoryItem.findFirst({
        where: { characterId: testChar.id, itemTemplateId: soulEmber.id },
      });
      if (!hasEmber) {
        await prisma.inventoryItem.create({
          data: { characterId: testChar.id, itemTemplateId: soulEmber.id, quantity: 2, equipped: false },
        });
        console.log('  Added 2x Soul Ember to Wanderer');
      }
    }
  }

  console.log('\nGuild system seed complete!');
}

main()
  .catch((e) => {
    console.error('Error seeding guild data:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
