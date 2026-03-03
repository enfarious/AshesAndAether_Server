/**
 * seed-vault.ts — Seeds vault-related items, tags, mob templates, and loot tables.
 *
 * Creates:
 *   - ItemTag: vault_fragment_lab, vault_key_lab
 *   - ItemTemplate: Nanotech Lab Fragment (stackable material)
 *   - ItemTemplate: Nanotech Lab Key (consumable)
 *   - LootTable: Vault Construct (room clear drops)
 *   - LootTable: Vault Boss (boss kill drops)
 *   - LootEntry additions to high-corruption mob tables for fragment drops
 *
 * Run with: npx tsx prisma/seed-vault.ts
 * Safe to run multiple times (uses upsert/findFirst patterns).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─── Constants ────────────────────────────────────────────────────────────────

const FRAGMENT_TEMPLATE_ID = 'item-vault-fragment-lab';
const KEY_TEMPLATE_ID = 'item-vault-key-lab';
const TAG_FRAGMENT_ID = 'tag-vault-fragment-lab';
const TAG_KEY_ID = 'tag-vault-key-lab';
const LOOT_TABLE_CONSTRUCT_ID = 'loot-table-vault-construct';
const LOOT_TABLE_BOSS_ID = 'loot-table-vault-boss';

async function main() {
  console.log('=== Seeding Vault System ===\n');

  // ── Item Tags ──────────────────────────────────────────────────────────────

  const tagFragment = await prisma.itemTag.upsert({
    where: { name: 'vault_fragment_lab' },
    update: {},
    create: { id: TAG_FRAGMENT_ID, name: 'vault_fragment_lab' },
  });
  console.log(`  ✓ ItemTag: ${tagFragment.name}`);

  const tagKey = await prisma.itemTag.upsert({
    where: { name: 'vault_key_lab' },
    update: {},
    create: { id: TAG_KEY_ID, name: 'vault_key_lab' },
  });
  console.log(`  ✓ ItemTag: ${tagKey.name}`);

  // ── Fragment ItemTemplate ──────────────────────────────────────────────────

  const existingFragment = await prisma.itemTemplate.findFirst({
    where: { id: FRAGMENT_TEMPLATE_ID },
  });

  if (existingFragment) {
    console.log('  Fragment template already exists, skipping.');
  } else {
    const fragment = await prisma.itemTemplate.create({
      data: {
        id: FRAGMENT_TEMPLATE_ID,
        name: 'Nanotech Lab Fragment',
        description:
          'A shard of crystallized corruption pulsing with residual nanotech energy. ' +
          'Three of these can be assembled into a vault key at a civic workbench.',
        itemType: 'material',
        properties: {
          vaultId: 'vault_ruined_lab',
          fragmentType: 'generic',
        },
        value: 25,
        stackable: true,
        maxStackSize: 20,
        tags: {
          create: [{ tagId: tagFragment.id }],
        },
      },
    });
    console.log(`  ✓ ItemTemplate: ${fragment.name} (${fragment.id})`);
  }

  // ── Key ItemTemplate ───────────────────────────────────────────────────────

  const existingKey = await prisma.itemTemplate.findFirst({
    where: { id: KEY_TEMPLATE_ID },
  });

  if (existingKey) {
    console.log('  Key template already exists, skipping.');
  } else {
    const key = await prisma.itemTemplate.create({
      data: {
        id: KEY_TEMPLATE_ID,
        name: 'Nanotech Lab Key',
        description:
          'An assembled key thrumming with nanotech resonance. ' +
          'Consumed on entry to the Ruined Nanotech Lab vault.',
        itemType: 'key',
        properties: {
          vaultId: 'vault_ruined_lab',
          consumedOnUse: true,
        },
        value: 100,
        stackable: false,
        maxStackSize: 1,
        tags: {
          create: [{ tagId: tagKey.id }],
        },
      },
    });
    console.log(`  ✓ ItemTemplate: ${key.name} (${key.id})`);
  }

  // ── Vault Construct Loot Table (room clear drops) ──────────────────────────

  const existingConstructTable = await prisma.lootTable.findFirst({
    where: { id: LOOT_TABLE_CONSTRUCT_ID },
  });

  if (existingConstructTable) {
    console.log('  Construct loot table already exists, skipping.');
  } else {
    // Look up existing item templates for loot
    const healthPotion = await prisma.itemTemplate.findFirst({
      where: { name: 'Health Potion' },
    });

    if (!healthPotion) {
      console.warn('  ⚠ Health Potion template not found — run main seed first. Skipping construct loot table.');
    } else {
      const tableConstruct = await prisma.lootTable.create({
        data: {
          id: LOOT_TABLE_CONSTRUCT_ID,
          name: 'Vault Construct',
          entries: {
            create: [
              { itemTemplateId: healthPotion.id, chance: 0.60, minQuantity: 1, maxQuantity: 3 },
            ],
          },
        },
      });
      console.log(`  ✓ LootTable: ${tableConstruct.name}`);
    }
  }

  // ── Vault Boss Loot Table ──────────────────────────────────────────────────

  const existingBossTable = await prisma.lootTable.findFirst({
    where: { id: LOOT_TABLE_BOSS_ID },
  });

  if (existingBossTable) {
    console.log('  Boss loot table already exists, skipping.');
  } else {
    const healthPotion = await prisma.itemTemplate.findFirst({ where: { name: 'Health Potion' } });
    const rustySword = await prisma.itemTemplate.findFirst({ where: { name: 'Rusty Sword' } });
    const ironMace = await prisma.itemTemplate.findFirst({ where: { name: 'Iron Mace' } });

    const entries: Array<{ itemTemplateId: string; chance: number; minQuantity: number; maxQuantity: number }> = [];

    if (healthPotion) entries.push({ itemTemplateId: healthPotion.id, chance: 0.80, minQuantity: 2, maxQuantity: 5 });
    if (rustySword) entries.push({ itemTemplateId: rustySword.id, chance: 0.40, minQuantity: 1, maxQuantity: 1 });
    if (ironMace) entries.push({ itemTemplateId: ironMace.id, chance: 0.35, minQuantity: 1, maxQuantity: 1 });

    if (entries.length > 0) {
      const tableBoss = await prisma.lootTable.create({
        data: {
          id: LOOT_TABLE_BOSS_ID,
          name: 'Vault Boss',
          entries: {
            create: entries,
          },
        },
      });
      console.log(`  ✓ LootTable: ${tableBoss.name}`);
    } else {
      console.warn('  ⚠ No item templates found for boss loot table — run main seed first.');
    }
  }

  // ── Fragment drops from high-corruption mobs ───────────────────────────────
  // Add vault fragment to existing loot tables for high-corruption zone mobs

  const fragmentTpl = await prisma.itemTemplate.findFirst({ where: { id: FRAGMENT_TEMPLATE_ID } });
  if (fragmentTpl) {
    const targetTables = ['loot-table-mangy-beast', 'loot-table-swamp-creature'];

    for (const tableId of targetTables) {
      const existing = await prisma.lootEntry.findFirst({
        where: { lootTableId: tableId, itemTemplateId: fragmentTpl.id },
      });

      if (existing) {
        console.log(`  Fragment drop already exists in ${tableId}, skipping.`);
      } else {
        const table = await prisma.lootTable.findFirst({ where: { id: tableId } });
        if (table) {
          await prisma.lootEntry.create({
            data: {
              lootTableId: tableId,
              itemTemplateId: fragmentTpl.id,
              chance: 0.15,
              minQuantity: 1,
              maxQuantity: 1,
            },
          });
          console.log(`  ✓ Added fragment drop (15%) to: ${table.name}`);
        } else {
          console.warn(`  ⚠ Loot table ${tableId} not found — run seed-loot first.`);
        }
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log('\n=== Vault Seed Complete ===');
  console.log(`Fragment template: ${FRAGMENT_TEMPLATE_ID}`);
  console.log(`Key template:      ${KEY_TEMPLATE_ID}`);
  console.log(`Fragment tag:      vault_fragment_lab`);
  console.log(`Key tag:           vault_key_lab`);
  console.log(`Fragments needed:  3 (assemble at civic anchor workbench)`);
  console.log('\nUsage:');
  console.log('  /vault fragments    — check fragment count');
  console.log('  /vault assemble     — assemble key from fragments (near workbench)');
  console.log('  /vault enter        — consume key and enter the vault');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
