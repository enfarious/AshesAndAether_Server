/**
 * seed-flora.ts — seeds ItemTemplates + ItemTags for all flora harvest drops.
 *
 * Run with: npx ts-node prisma/seed-flora.ts
 * Safe to run multiple times (uses upsert patterns).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface HarvestItemDef {
  tag:          string;   // matches harvestItems[].itemId in species files
  name:         string;
  description:  string;
  itemType:     string;
  value:        number;
  maxStackSize: number;
}

const HARVEST_ITEMS: HarvestItemDef[] = [
  // ── Vegetables ──────────────────────────────────────────────────────────────
  { tag: 'carrot',       name: 'Carrot',        description: 'A crisp orange root vegetable.',               itemType: 'material', value: 2,  maxStackSize: 20 },
  { tag: 'carrot_top',   name: 'Carrot Top',    description: 'Leafy greens from a carrot plant.',            itemType: 'material', value: 1,  maxStackSize: 20 },
  { tag: 'potato',       name: 'Potato',        description: 'A starchy tuber, good for cooking.',           itemType: 'material', value: 2,  maxStackSize: 20 },
  { tag: 'onion',        name: 'Onion',         description: 'A pungent bulb with papery skin.',             itemType: 'material', value: 2,  maxStackSize: 20 },
  { tag: 'onion_seed',   name: 'Onion Seed',    description: 'A tiny black seed from an onion plant.',       itemType: 'material', value: 1,  maxStackSize: 50 },
  { tag: 'garlic',       name: 'Garlic',        description: 'A small bulb of pungent cloves.',              itemType: 'material', value: 3,  maxStackSize: 20 },
  { tag: 'garlic_seed',  name: 'Garlic Seed',   description: 'A clove that can be replanted.',               itemType: 'material', value: 1,  maxStackSize: 50 },

  // ── Fruit ───────────────────────────────────────────────────────────────────
  { tag: 'apple',        name: 'Apple',         description: 'A crisp red apple from a wild tree.',          itemType: 'material', value: 3,  maxStackSize: 20 },
  { tag: 'pear',         name: 'Pear',          description: 'A soft, sweet pear.',                          itemType: 'material', value: 3,  maxStackSize: 20 },
  { tag: 'berries',      name: 'Berries',       description: 'A handful of small, tart berries.',            itemType: 'material', value: 2,  maxStackSize: 20 },
  { tag: 'berry_seeds',  name: 'Berry Seeds',   description: 'Tiny seeds from a berry bush.',                itemType: 'material', value: 1,  maxStackSize: 50 },

  // ── Herbs & greens ──────────────────────────────────────────────────────────
  { tag: 'herb_sage',    name: 'Sage',          description: 'Fragrant grey-green leaves used in remedies.',  itemType: 'material', value: 4,  maxStackSize: 20 },
  { tag: 'sage_oil',     name: 'Sage Oil',      description: 'Concentrated oil pressed from sage leaves.',    itemType: 'material', value: 8,  maxStackSize: 10 },
  { tag: 'sage_seed',    name: 'Sage Seed',     description: 'A small seed from a sage plant.',               itemType: 'material', value: 1,  maxStackSize: 50 },
  { tag: 'clover',       name: 'Clover',        description: 'A common three-leaf clover.',                   itemType: 'material', value: 1,  maxStackSize: 20 },
  { tag: 'clover_seed',  name: 'Clover Seed',   description: 'A tiny seed from a clover plant.',              itemType: 'material', value: 1,  maxStackSize: 50 },
  { tag: 'four_leaf_clover', name: 'Four-Leaf Clover', description: 'A rare find — said to bring good luck.', itemType: 'material', value: 25, maxStackSize: 5 },

  // ── Mushrooms ───────────────────────────────────────────────────────────────
  { tag: 'mushroom',        name: 'Mushroom',        description: 'A common edible mushroom.',                    itemType: 'material', value: 2,  maxStackSize: 20 },
  { tag: 'rare_mushroom',   name: 'Rare Mushroom',   description: 'An unusual mushroom with a faint glow.',       itemType: 'material', value: 12, maxStackSize: 10 },
  { tag: 'mushroom_spores', name: 'Mushroom Spores', description: 'Fine spores that could propagate new growth.', itemType: 'material', value: 1,  maxStackSize: 50 },

  // ── Grass ───────────────────────────────────────────────────────────────────
  { tag: 'grass_bundle', name: 'Grass Bundle', description: 'A bundle of dried grass, useful for crafting.',  itemType: 'material', value: 1, maxStackSize: 20 },
  { tag: 'grass_seed',   name: 'Grass Seed',   description: 'Seeds that will grow into tall grass.',          itemType: 'material', value: 1, maxStackSize: 50 },
];

async function main() {
  console.log('🌿 Seeding flora harvest items...');

  for (const def of HARVEST_ITEMS) {
    // 1. Upsert the ItemTag
    const tag = await prisma.itemTag.upsert({
      where:  { name: def.tag },
      update: {},
      create: { name: def.tag },
    });

    // 2. Check if an ItemTemplate already exists with this tag linked
    const existing = await prisma.itemTemplateTag.findFirst({
      where: { tagId: tag.id },
    });

    if (existing) {
      console.log(`  · ${def.name} — already linked, skipping`);
      continue;
    }

    // 3. Create the ItemTemplate
    const template = await prisma.itemTemplate.create({
      data: {
        name:         def.name,
        description:  def.description,
        itemType:     def.itemType,
        properties:   {},
        value:        def.value,
        stackable:    true,
        maxStackSize: def.maxStackSize,
        tags: {
          create: [{ tagId: tag.id }],
        },
      },
    });

    console.log(`  ✓ ${template.name} (tag: ${def.tag})`);
  }

  console.log('🌿 Flora seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
