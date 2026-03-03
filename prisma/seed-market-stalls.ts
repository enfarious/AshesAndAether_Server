/**
 * seed-market-stalls.ts — seeds Regions and NPC market stalls in overworld towns.
 *
 * Run with: npx ts-node prisma/seed-market-stalls.ts
 * Safe to run multiple times (uses upsert patterns).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// System character ID used as owner for NPC-run stalls
const NPC_OWNER_ID = '00000000-0000-0000-0000-000000000000';

async function main() {
  console.log('Seeding regions and NPC market stalls...');

  // ── Regions ─────────────────────────────────────────────────────────────

  const stephentown = await prisma.region.upsert({
    where: { name: 'Stephentown' },
    update: { zoneIds: ['USA_NY_Stephentown'] },
    create: {
      name: 'Stephentown',
      biomeType: 'FOREST',
      zoneIds: ['USA_NY_Stephentown'],
      baseTaxRate: 0.05,
    },
  });
  console.log(`  + Region: ${stephentown.name}`);

  // ── NPC Market Stalls ───────────────────────────────────────────────────

  // Place an NPC market stall near the Stephentown Town Hall (origin)
  const stallName = 'Town Hall Market Stall';
  const existing = await prisma.marketStall.findFirst({
    where: { name: stallName, zoneId: 'USA_NY_Stephentown' },
  });

  if (!existing) {
    const stall = await prisma.marketStall.create({
      data: {
        ownerId: NPC_OWNER_ID,
        regionId: stephentown.id,
        name: stallName,
        stallType: 'GENERAL',
        zoneId: 'USA_NY_Stephentown',
        positionX: 5,
        positionY: 265,
        positionZ: 5,
        isActive: true,
      },
    });
    console.log(`  + MarketStall: ${stall.name} (NPC) at Stephentown`);
  } else {
    console.log(`  = MarketStall: ${stallName} already exists, skipping`);
  }

  console.log('Market stall seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
