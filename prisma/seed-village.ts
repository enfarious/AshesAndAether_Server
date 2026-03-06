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
    // ── Commerce ──
    {
      name:          'market_stall',
      displayName:   'Market Stall',
      description:   'A small wooden stall for trading goods.',
      category:      'commerce',
      sizeX:         4,
      sizeZ:         3,
      modelAsset:    'village/building_market.glb',
      goldCost:      200,
      maxPerVillage: 2,
    },
    {
      name:          'armor_shop',
      displayName:   'Armor Shop',
      description:   'A sturdy workshop for buying and repairing armor.',
      category:      'commerce',
      sizeX:         6,
      sizeZ:         6,
      modelAsset:    'village/building_armor_shop.glb',
      goldCost:      800,
      maxPerVillage: 1,
    },
    {
      name:          'weapon_shop',
      displayName:   'Weapon Shop',
      description:   'A forge-front shop dealing in blades and bows.',
      category:      'commerce',
      sizeX:         6,
      sizeZ:         6,
      modelAsset:    'village/building_weapon_shop.glb',
      goldCost:      800,
      maxPerVillage: 1,
    },
    {
      name:          'jewelry_shop',
      displayName:   'Jewelry Shop',
      description:   'A delicate storefront for gems and trinkets.',
      category:      'commerce',
      sizeX:         4,
      sizeZ:         4,
      modelAsset:    'village/building_jewelry_shop.glb',
      goldCost:      600,
      maxPerVillage: 1,
    },
    {
      name:          'apothecary',
      displayName:   'Apothecary',
      description:   'A cluttered shop of potions and remedies.',
      category:      'commerce',
      sizeX:         5,
      sizeZ:         5,
      modelAsset:    'village/building_apothecary.glb',
      goldCost:      600,
      maxPerVillage: 1,
    },
    // ── Housing ──
    {
      name:          'house_basic',
      displayName:   'Basic House',
      description:   'A simple shelter with room for storage.',
      category:      'housing',
      sizeX:         6,
      sizeZ:         6,
      modelAsset:    'village/house_basic.glb',
      goldCost:      500,
      maxPerVillage: 3,
    },
    {
      name:          'house_cottage',
      displayName:   'Cottage',
      description:   'A charming cottage with a small garden.',
      category:      'housing',
      sizeX:         6,
      sizeZ:         6,
      modelAsset:    'village/house_cottage.glb',
      goldCost:      750,
      maxPerVillage: 2,
    },
    {
      name:          'house_comfortable',
      displayName:   'Comfortable House',
      description:   'A well-furnished home with extra amenities.',
      category:      'housing',
      sizeX:         8,
      sizeZ:         8,
      modelAsset:    'village/house_comfortable.glb',
      goldCost:      1200,
      maxPerVillage: 2,
    },
    {
      name:          'house_improved',
      displayName:   'Improved House',
      description:   'A reinforced dwelling with upgraded storage.',
      category:      'housing',
      sizeX:         8,
      sizeZ:         8,
      modelAsset:    'village/house_improved.glb',
      goldCost:      1500,
      maxPerVillage: 1,
    },
    // ── Utility ──
    {
      name:          'well',
      displayName:   'Well',
      description:   'A stone well providing fresh water.',
      category:      'utility',
      sizeX:         2,
      sizeZ:         2,
      modelAsset:    'village/building_well.glb',
      goldCost:      100,
      maxPerVillage: 1,
    },
    {
      name:          'delivery_bin',
      displayName:   'Delivery Bin',
      description:   'A reinforced bin for receiving and storing deliveries.',
      category:      'utility',
      sizeX:         3,
      sizeZ:         3,
      modelAsset:    'village/building_delivery_bin.glb',
      goldCost:      250,
      maxPerVillage: 2,
    },
    {
      name:          'compost',
      displayName:   'Compost Heap',
      description:   'Breaks down organic waste into rich fertilizer.',
      category:      'utility',
      sizeX:         3,
      sizeZ:         3,
      modelAsset:    'village/building_compost.glb',
      goldCost:      100,
      maxPerVillage: 2,
    },
    // ── Production / Resource Nodes ──
    {
      name:          'grain_field',
      displayName:   'Grain Field',
      description:   'A tilled patch of earth for growing grain.',
      category:      'production',
      sizeX:         4,
      sizeZ:         4,
      modelAsset:    'village/node_grain_field.glb',
      goldCost:      150,
      maxPerVillage: 4,
    },
    {
      name:          'veggie_plot',
      displayName:   'Veggie Plot',
      description:   'A raised bed for growing vegetables.',
      category:      'production',
      sizeX:         4,
      sizeZ:         4,
      modelAsset:    'village/node_veggie_plot.glb',
      goldCost:      150,
      maxPerVillage: 4,
    },
    {
      name:          'herb_patch',
      displayName:   'Herb Patch',
      description:   'A fragrant garden of medicinal and culinary herbs.',
      category:      'production',
      sizeX:         3,
      sizeZ:         3,
      modelAsset:    'village/node_herb_patch.glb',
      goldCost:      200,
      maxPerVillage: 3,
    },
    {
      name:          'fruit_tree',
      displayName:   'Fruit Tree',
      description:   'A mature tree bearing seasonal fruit.',
      category:      'production',
      sizeX:         2,
      sizeZ:         2,
      modelAsset:    'village/node_fruit_tree.glb',
      goldCost:      300,
      maxPerVillage: 3,
    },
    {
      name:          'tree',
      displayName:   'Lumber Tree',
      description:   'A sturdy tree for harvesting wood.',
      category:      'production',
      sizeX:         2,
      sizeZ:         2,
      modelAsset:    'village/node_tree.glb',
      goldCost:      100,
      maxPerVillage: 4,
    },
    {
      name:          'log_pile',
      displayName:   'Log Pile',
      description:   'Stacked logs ready for processing.',
      category:      'production',
      sizeX:         3,
      sizeZ:         2,
      modelAsset:    'village/node_log_pile.glb',
      goldCost:      75,
      maxPerVillage: 3,
    },
    {
      name:          'ore_node',
      displayName:   'Ore Deposit',
      description:   'A rocky outcrop rich with metal ore.',
      category:      'production',
      sizeX:         3,
      sizeZ:         3,
      modelAsset:    'village/node_ore_node.glb',
      goldCost:      400,
      maxPerVillage: 2,
    },
    {
      name:          'gem_node',
      displayName:   'Gem Deposit',
      description:   'A crystalline vein of precious gemstones.',
      category:      'production',
      sizeX:         2,
      sizeZ:         2,
      modelAsset:    'village/node_gem_node.glb',
      goldCost:      600,
      maxPerVillage: 1,
    },
  ];

  for (const s of structures) {
    const result = await prisma.structureCatalog.upsert({
      where:  { name: s.name },
      update: { modelAsset: s.modelAsset, displayName: s.displayName, description: s.description },
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
