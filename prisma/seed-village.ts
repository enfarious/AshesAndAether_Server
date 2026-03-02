/**
 * seed-village.ts — seeds PlotTemplates and StructureCatalog entries.
 *
 * Run with: npx ts-node prisma/seed-village.ts
 * Safe to run multiple times (uses upsert patterns).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding village templates and structure catalog...');

  // ── Plot Templates ──────────────────────────────────────────────────────

  const meadow = await prisma.plotTemplate.upsert({
    where:  { name: 'meadow_small' },
    update: {},
    create: {
      name:          'meadow_small',
      description:   'A small meadow clearing surrounded by wildflowers.',
      terrainType:   'village_meadow',
      sizeX:         48,
      sizeY:         15,
      sizeZ:         48,
      gridSize:      2.0,
      maxStructures: 6,
      buildMinX:     -20,
      buildMinZ:     -20,
      buildMaxX:     20,
      buildMaxZ:     20,
      spawnX:        0,
      spawnY:        0,
      spawnZ:        12,
    },
  });
  console.log(`  + PlotTemplate: ${meadow.name}`);

  const hilltop = await prisma.plotTemplate.upsert({
    where:  { name: 'hilltop_medium' },
    update: {},
    create: {
      name:          'hilltop_medium',
      description:   'A broad hilltop plateau with sweeping views.',
      terrainType:   'village_hilltop',
      sizeX:         64,
      sizeY:         20,
      sizeZ:         64,
      gridSize:      2.0,
      maxStructures: 8,
      buildMinX:     -28,
      buildMinZ:     -28,
      buildMaxX:     28,
      buildMaxZ:     28,
      spawnX:        0,
      spawnY:        0,
      spawnZ:        16,
    },
  });
  console.log(`  + PlotTemplate: ${hilltop.name}`);

  const riverside = await prisma.plotTemplate.upsert({
    where:  { name: 'riverside_large' },
    update: {},
    create: {
      name:          'riverside_large',
      description:   'A lush grove along a quiet riverside.',
      terrainType:   'village_riverside',
      sizeX:         80,
      sizeY:         20,
      sizeZ:         80,
      gridSize:      2.0,
      maxStructures: 10,
      buildMinX:     -36,
      buildMinZ:     -36,
      buildMaxX:     36,
      buildMaxZ:     36,
      spawnX:        0,
      spawnY:        0,
      spawnZ:        20,
    },
  });
  console.log(`  + PlotTemplate: ${riverside.name}`);

  // ── Structure Catalog ───────────────────────────────────────────────────

  const structures = [
    {
      name:          'market_stall',
      displayName:   'Market Stall',
      description:   'A small wooden stall for trading goods.',
      category:      'commerce',
      sizeX:         4,
      sizeZ:         3,
      modelAsset:    'structures/market_stall',
      goldCost:      200,
      maxPerVillage: 2,
    },
    {
      name:          'small_house',
      displayName:   'Small House',
      description:   'A cozy cottage with room for storage.',
      category:      'housing',
      sizeX:         6,
      sizeZ:         6,
      modelAsset:    'structures/small_house',
      goldCost:      500,
      maxPerVillage: 3,
    },
    {
      name:          'farm_plot',
      displayName:   'Farm Plot',
      description:   'A tilled patch of earth for growing crops.',
      category:      'production',
      sizeX:         4,
      sizeZ:         4,
      modelAsset:    'structures/farm_plot',
      goldCost:      150,
      maxPerVillage: 4,
    },
    {
      name:          'storage_shed',
      displayName:   'Storage Shed',
      description:   'Extra storage space for materials and supplies.',
      category:      'utility',
      sizeX:         4,
      sizeZ:         4,
      modelAsset:    'structures/storage_shed',
      goldCost:      300,
      maxPerVillage: 2,
    },
  ];

  for (const s of structures) {
    const result = await prisma.structureCatalog.upsert({
      where:  { name: s.name },
      update: {},
      create: s,
    });
    console.log(`  + StructureCatalog: ${result.displayName} (${result.goldCost}g)`);
  }

  console.log('Village seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
