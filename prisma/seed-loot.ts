/**
 * seed-loot.ts — seeds LootTables, LootEntries, and links them to existing Mobs.
 *
 * Run with: npx ts-node prisma/seed-loot.ts
 * Safe to run multiple times (uses upsert/update-or-skip patterns).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🎲 Seeding loot tables...');

  // ── Fetch existing ItemTemplates by name ──────────────────────────────────
  const templates = await prisma.itemTemplate.findMany({
    select: { id: true, name: true },
  });

  const tpl = (name: string): string => {
    const found = templates.find(t => t.name === name);
    if (!found) throw new Error(`ItemTemplate not found: "${name}" — run main seed first.`);
    return found.id;
  };

  // ── Loot Table: Town Vermin ───────────────────────────────────────────────
  // Used by: rats (levels 1–3)
  const tableVermin = await prisma.lootTable.upsert({
    where:  { id: 'loot-table-town-vermin' },
    update: {},
    create: {
      id:   'loot-table-town-vermin',
      name: 'Town Vermin',
      entries: {
        create: [
          { itemTemplateId: tpl('Health Potion'), chance: 0.35, minQuantity: 1, maxQuantity: 2 },
        ],
      },
    },
  });
  console.log(`  ✓ LootTable: ${tableVermin.name}`);

  // ── Loot Table: Mangy Beast ───────────────────────────────────────────────
  // Used by: rabid dog (level 7)
  const tableMangy = await prisma.lootTable.upsert({
    where:  { id: 'loot-table-mangy-beast' },
    update: {},
    create: {
      id:   'loot-table-mangy-beast',
      name: 'Mangy Beast',
      entries: {
        create: [
          { itemTemplateId: tpl('Health Potion'), chance: 0.55, minQuantity: 1, maxQuantity: 2 },
          { itemTemplateId: tpl('Rusty Sword'),   chance: 0.18, minQuantity: 1, maxQuantity: 1 },
          { itemTemplateId: tpl('Leather Jerkin'), chance: 0.10, minQuantity: 1, maxQuantity: 1 },
        ],
      },
    },
  });
  console.log(`  ✓ LootTable: ${tableMangy.name}`);

  // ── Loot Table: Swamp Creature ────────────────────────────────────────────
  // Used by: dire toad (level 6)
  const tableSwamp = await prisma.lootTable.upsert({
    where:  { id: 'loot-table-swamp-creature' },
    update: {},
    create: {
      id:   'loot-table-swamp-creature',
      name: 'Swamp Creature',
      entries: {
        create: [
          { itemTemplateId: tpl('Health Potion'), chance: 0.50, minQuantity: 1, maxQuantity: 3 },
          { itemTemplateId: tpl('Iron Mace'),     chance: 0.14, minQuantity: 1, maxQuantity: 1 },
          { itemTemplateId: tpl('Leather Jerkin'), chance: 0.14, minQuantity: 1, maxQuantity: 1 },
        ],
      },
    },
  });
  console.log(`  ✓ LootTable: ${tableSwamp.name}`);

  // ── Loot Table: Mountain Wildlife ─────────────────────────────────────────
  // Used by: Jiminy Peak hares + foxes + elk
  const tableMountain = await prisma.lootTable.upsert({
    where:  { id: 'loot-table-mountain-wildlife' },
    update: {},
    create: {
      id:   'loot-table-mountain-wildlife',
      name: 'Mountain Wildlife',
      entries: {
        create: [
          { itemTemplateId: tpl('Health Potion'), chance: 0.40, minQuantity: 1, maxQuantity: 2 },
          { itemTemplateId: tpl('Ashwood Spear'), chance: 0.08, minQuantity: 1, maxQuantity: 1 },
        ],
      },
    },
  });
  console.log(`  ✓ LootTable: ${tableMountain.name}`);

  // ── Link tables to mobs + set goldDrop ───────────────────────────────────
  const mobLinks: Array<{ tag: string; lootTableId: string; goldDrop: number }> = [
    // Stephentown rats
    { tag: 'mob.rat.1',       lootTableId: tableVermin.id, goldDrop: 2 },
    { tag: 'mob.rat.2',       lootTableId: tableVermin.id, goldDrop: 2 },
    { tag: 'mob.rat.3',       lootTableId: tableVermin.id, goldDrop: 2 },
    { tag: 'mob.rat.4',       lootTableId: tableVermin.id, goldDrop: 2 },
    { tag: 'mob.rat.5',       lootTableId: tableVermin.id, goldDrop: 2 },
    // Rabid dog
    { tag: 'mob.rabid_dog',   lootTableId: tableMangy.id,  goldDrop: 15 },
    // Dire toad
    { tag: 'mob.dire_toad',   lootTableId: tableSwamp.id,  goldDrop: 12 },
    // Jiminy Peak wildlife
    { tag: 'mob.jiminy.hare.1', lootTableId: tableMountain.id, goldDrop: 3 },
    { tag: 'mob.jiminy.hare.2', lootTableId: tableMountain.id, goldDrop: 3 },
    { tag: 'mob.jiminy.hare.3', lootTableId: tableMountain.id, goldDrop: 3 },
    { tag: 'mob.jiminy.hare.4', lootTableId: tableMountain.id, goldDrop: 3 },
    { tag: 'mob.jiminy.fox.1',  lootTableId: tableMountain.id, goldDrop: 8 },
    { tag: 'mob.jiminy.fox.2',  lootTableId: tableMountain.id, goldDrop: 8 },
    { tag: 'mob.jiminy.fox.3',  lootTableId: tableMountain.id, goldDrop: 8 },
    { tag: 'mob.jiminy.elk.1',  lootTableId: tableMountain.id, goldDrop: 18 },
    { tag: 'mob.jiminy.elk.2',  lootTableId: tableMountain.id, goldDrop: 18 },
  ];

  let linked = 0;
  for (const { tag, lootTableId, goldDrop } of mobLinks) {
    const result = await prisma.mob.updateMany({
      where: { tag },
      data:  { lootTableId, goldDrop },
    });
    if (result.count > 0) linked++;
    else console.warn(`  ⚠ Mob not found: ${tag}`);
  }
  console.log(`  ✓ Linked ${linked}/${mobLinks.length} mobs to loot tables`);

  console.log('✅ Loot seed complete.');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
