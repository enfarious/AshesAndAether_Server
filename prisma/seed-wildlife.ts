/**
 * seed-wildlife.ts — seeds ItemTemplates + ItemTags for all wildlife loot drops.
 *
 * Run with: npx ts-node prisma/seed-wildlife.ts
 * Safe to run multiple times (uses upsert patterns).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface LootItemDef {
  tag:          string;
  name:         string;
  description:  string;
  itemType:     string;
  value:        number;
  maxStackSize: number;
}

const WILDLIFE_ITEMS: LootItemDef[] = [
  // ── Rabbit ──────────────────────────────────────────────────────────────────
  { tag: 'rabbit_meat', name: 'Rabbit Meat',  description: 'A small cut of lean rabbit meat.',           itemType: 'material', value: 2,  maxStackSize: 20 },
  { tag: 'rabbit_hide', name: 'Rabbit Hide',  description: 'A soft, thin hide from a rabbit.',          itemType: 'material', value: 3,  maxStackSize: 20 },
  { tag: 'rabbit_foot', name: 'Rabbit Foot',  description: 'A lucky charm — or so they say.',           itemType: 'material', value: 15, maxStackSize: 5 },

  // ── Deer ────────────────────────────────────────────────────────────────────
  { tag: 'venison',     name: 'Venison',       description: 'Rich, dark red meat from a deer.',          itemType: 'material', value: 4,  maxStackSize: 20 },
  { tag: 'deer_hide',   name: 'Deer Hide',     description: 'A sturdy hide, good for leatherworking.',   itemType: 'material', value: 5,  maxStackSize: 20 },
  { tag: 'deer_antler', name: 'Deer Antler',   description: 'A pronged antler, useful in crafting.',      itemType: 'material', value: 8,  maxStackSize: 10 },
  { tag: 'deer_sinew',  name: 'Deer Sinew',    description: 'Tough, fibrous sinew for bowstrings.',       itemType: 'material', value: 6,  maxStackSize: 20 },

  // ── Fox ─────────────────────────────────────────────────────────────────────
  { tag: 'fox_pelt',    name: 'Fox Pelt',      description: 'A beautiful russet pelt.',                   itemType: 'material', value: 8,  maxStackSize: 10 },
  { tag: 'fox_tail',    name: 'Fox Tail',      description: 'A bushy tail — prized by hatters.',          itemType: 'material', value: 12, maxStackSize: 5 },

  // ── Wolf ────────────────────────────────────────────────────────────────────
  { tag: 'wolf_pelt',   name: 'Wolf Pelt',     description: 'A thick grey pelt, warm and durable.',       itemType: 'material', value: 10, maxStackSize: 10 },
  { tag: 'wolf_fang',   name: 'Wolf Fang',     description: 'A sharp canine tooth from a wolf.',          itemType: 'material', value: 6,  maxStackSize: 20 },
  { tag: 'wolf_claw',   name: 'Wolf Claw',     description: 'A curved claw, still razor-sharp.',          itemType: 'material', value: 5,  maxStackSize: 20 },

  // ── Boar ────────────────────────────────────────────────────────────────────
  { tag: 'pork',         name: 'Pork',          description: 'A fatty cut of wild boar meat.',            itemType: 'material', value: 3,  maxStackSize: 20 },
  { tag: 'boar_hide',    name: 'Boar Hide',     description: 'A tough, bristly hide.',                    itemType: 'material', value: 5,  maxStackSize: 20 },
  { tag: 'boar_tusk',    name: 'Boar Tusk',     description: 'A curved ivory tusk from a wild boar.',     itemType: 'material', value: 10, maxStackSize: 10 },
  { tag: 'boar_bristle', name: 'Boar Bristle',  description: 'Coarse bristles, used in brushes.',         itemType: 'material', value: 2,  maxStackSize: 20 },

  // ── Shared ──────────────────────────────────────────────────────────────────
  { tag: 'raw_meat',     name: 'Raw Meat',      description: 'A generic cut of raw meat.',                itemType: 'material', value: 2,  maxStackSize: 20 },
];

async function main() {
  console.log('🐾 Seeding wildlife loot items...');

  for (const def of WILDLIFE_ITEMS) {
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

  console.log('🐾 Wildlife seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
