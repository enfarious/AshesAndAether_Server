/**
 * seed-vault.ts — Seeds vault-related items, tags, mob templates, and loot tables.
 *
 * Creates:
 *   - ItemTag: vault_fragment_lab, vault_key_lab, vault_weapon, vault_armor
 *   - ItemTemplate: Nanotech Lab Fragment (stackable material)
 *   - ItemTemplate: Nanotech Lab Key (consumable)
 *   - ItemTemplate: Corrupted Nanoblade (vault weapon — slash)
 *   - ItemTemplate: Sentinel's War Hammer (vault weapon — blunt)
 *   - ItemTemplate: Overseer's Shock Staff (vault weapon — lightning)
 *   - ItemTemplate: Construct Plating (vault body armor)
 *   - LootTable: Vault Construct (drone/sentinel drops)
 *   - LootTable: Vault Overseer (mini-boss drops)
 *   - LootTable: Vault Boss (final boss drops)
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
const LOOT_TABLE_OVERSEER_ID = 'loot-table-vault-overseer';
const LOOT_TABLE_BOSS_ID = 'loot-table-vault-boss';

// Vault-tier item IDs
const NANOBLADE_ID = 'item-vault-nanoblade';
const WAR_HAMMER_ID = 'item-vault-war-hammer';
const SHOCK_STAFF_ID = 'item-vault-shock-staff';
const CONSTRUCT_PLATING_ID = 'item-vault-construct-plating';

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

  // Ensure generic tags exist for vault gear
  const tagWeapon = await prisma.itemTag.upsert({
    where: { name: 'weapon' },
    update: {},
    create: { id: 'tag-weapon', name: 'weapon' },
  });
  const tagArmor = await prisma.itemTag.upsert({
    where: { name: 'armor' },
    update: {},
    create: { id: 'tag-armor', name: 'armor' },
  });

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

  // ── Vault-Tier Weapon & Armor Templates ─────────────────────────────────────

  // Corrupted Nanoblade — fast slash sword, better than Rusty Sword (18 vs 12)
  if (!(await prisma.itemTemplate.findFirst({ where: { id: NANOBLADE_ID } }))) {
    await prisma.itemTemplate.create({
      data: {
        id: NANOBLADE_ID,
        name: 'Corrupted Nanoblade',
        description:
          'A blade forged from corrupted nanotech alloy. Its edge shimmers with an unstable molecular lattice.',
        itemType: 'weapon',
        properties: {
          weapon: {
            baseDamage: 18,
            speed: 2.3,
            damageProfiles: [
              { damageType: 'physical', physicalType: 'slash', ratio: 1.0 },
            ],
          },
          equipSlots: ['mainhand', 'offhand'],
        },
        value: 150,
        stackable: false,
        maxStackSize: 1,
        tags: { create: [{ tagId: tagWeapon.id }] },
      },
    });
    console.log('  ✓ ItemTemplate: Corrupted Nanoblade');
  } else {
    console.log('  Corrupted Nanoblade already exists, skipping.');
  }

  // Sentinel's War Hammer — slow heavy blunt, best raw damage (20)
  if (!(await prisma.itemTemplate.findFirst({ where: { id: WAR_HAMMER_ID } }))) {
    await prisma.itemTemplate.create({
      data: {
        id: WAR_HAMMER_ID,
        name: "Sentinel's War Hammer",
        description:
          'A massive hammer wielded by construct sentinels. Each swing carries the weight of pre-war engineering.',
        itemType: 'weapon',
        properties: {
          weapon: {
            baseDamage: 20,
            speed: 3.0,
            damageProfiles: [
              { damageType: 'physical', physicalType: 'blunt', ratio: 1.0 },
            ],
          },
          equipSlots: ['mainhand', 'offhand'],
        },
        value: 175,
        stackable: false,
        maxStackSize: 1,
        tags: { create: [{ tagId: tagWeapon.id }] },
      },
    });
    console.log("  ✓ ItemTemplate: Sentinel's War Hammer");
  } else {
    console.log("  Sentinel's War Hammer already exists, skipping.");
  }

  // Overseer's Shock Staff — lightning elemental, prized drop
  if (!(await prisma.itemTemplate.findFirst({ where: { id: SHOCK_STAFF_ID } }))) {
    await prisma.itemTemplate.create({
      data: {
        id: SHOCK_STAFF_ID,
        name: "Overseer's Shock Staff",
        description:
          'A crackling staff ripped from a vault overseer. Arcs of residual charge dance along its length.',
        itemType: 'weapon',
        properties: {
          weapon: {
            baseDamage: 16,
            speed: 2.5,
            damageProfiles: [
              { damageType: 'lightning', ratio: 1.0 },
            ],
          },
          equipSlots: ['mainhand', 'offhand'],
        },
        value: 200,
        stackable: false,
        maxStackSize: 1,
        tags: { create: [{ tagId: tagWeapon.id }] },
      },
    });
    console.log("  ✓ ItemTemplate: Overseer's Shock Staff");
  } else {
    console.log("  Overseer's Shock Staff already exists, skipping.");
  }

  // Construct Plating — body armor, strong vs pierce/slash
  if (!(await prisma.itemTemplate.findFirst({ where: { id: CONSTRUCT_PLATING_ID } }))) {
    await prisma.itemTemplate.create({
      data: {
        id: CONSTRUCT_PLATING_ID,
        name: 'Construct Plating',
        description:
          'Salvaged armor plating from a destroyed vault construct. Heavy but remarkably resilient.',
        itemType: 'armor',
        properties: {
          armor: {
            qualityBias: { slash: 0.22, pierce: 0.30, blunt: -0.08 },
          },
          equipSlots: ['body'],
        },
        value: 180,
        stackable: false,
        maxStackSize: 1,
        tags: { create: [{ tagId: tagArmor.id }] },
      },
    });
    console.log('  ✓ ItemTemplate: Construct Plating');
  } else {
    console.log('  Construct Plating already exists, skipping.');
  }

  // ── Loot Tables ─────────────────────────────────────────────────────────────
  // Delete and recreate to ensure entries are up-to-date

  const healthPotion = await prisma.itemTemplate.findFirst({ where: { name: 'Health Potion' } });
  if (!healthPotion) {
    console.warn('  ⚠ Health Potion template not found — run main seed first.');
  }

  // Helper type for loot entries
  type LootEntryInput = { itemTemplateId: string; chance: number; minQuantity: number; maxQuantity: number };

  // ── Vault Construct Loot Table (drone + sentinel drops) ──────────────────

  await prisma.lootEntry.deleteMany({ where: { lootTableId: LOOT_TABLE_CONSTRUCT_ID } });
  await prisma.lootTable.upsert({
    where: { id: LOOT_TABLE_CONSTRUCT_ID },
    update: { name: 'Vault Construct' },
    create: { id: LOOT_TABLE_CONSTRUCT_ID, name: 'Vault Construct' },
  });

  const constructEntries: LootEntryInput[] = [];
  if (healthPotion) constructEntries.push({ itemTemplateId: healthPotion.id, chance: 0.50, minQuantity: 1, maxQuantity: 2 });
  constructEntries.push({ itemTemplateId: NANOBLADE_ID, chance: 0.08, minQuantity: 1, maxQuantity: 1 });
  constructEntries.push({ itemTemplateId: CONSTRUCT_PLATING_ID, chance: 0.06, minQuantity: 1, maxQuantity: 1 });

  for (const entry of constructEntries) {
    await prisma.lootEntry.create({ data: { lootTableId: LOOT_TABLE_CONSTRUCT_ID, ...entry } });
  }
  console.log(`  ✓ LootTable: Vault Construct (${constructEntries.length} entries)`);

  // ── Vault Overseer Loot Table (mini-boss drops) ──────────────────────────

  await prisma.lootEntry.deleteMany({ where: { lootTableId: LOOT_TABLE_OVERSEER_ID } });
  await prisma.lootTable.upsert({
    where: { id: LOOT_TABLE_OVERSEER_ID },
    update: { name: 'Vault Overseer' },
    create: { id: LOOT_TABLE_OVERSEER_ID, name: 'Vault Overseer' },
  });

  const overseerEntries: LootEntryInput[] = [];
  if (healthPotion) overseerEntries.push({ itemTemplateId: healthPotion.id, chance: 0.80, minQuantity: 2, maxQuantity: 4 });
  overseerEntries.push({ itemTemplateId: NANOBLADE_ID, chance: 0.30, minQuantity: 1, maxQuantity: 1 });
  overseerEntries.push({ itemTemplateId: WAR_HAMMER_ID, chance: 0.25, minQuantity: 1, maxQuantity: 1 });
  overseerEntries.push({ itemTemplateId: CONSTRUCT_PLATING_ID, chance: 0.20, minQuantity: 1, maxQuantity: 1 });

  for (const entry of overseerEntries) {
    await prisma.lootEntry.create({ data: { lootTableId: LOOT_TABLE_OVERSEER_ID, ...entry } });
  }
  console.log(`  ✓ LootTable: Vault Overseer (${overseerEntries.length} entries)`);

  // ── Vault Boss Loot Table (final boss drops) ─────────────────────────────

  await prisma.lootEntry.deleteMany({ where: { lootTableId: LOOT_TABLE_BOSS_ID } });
  await prisma.lootTable.upsert({
    where: { id: LOOT_TABLE_BOSS_ID },
    update: { name: 'Vault Boss' },
    create: { id: LOOT_TABLE_BOSS_ID, name: 'Vault Boss' },
  });

  const bossEntries: LootEntryInput[] = [];
  if (healthPotion) bossEntries.push({ itemTemplateId: healthPotion.id, chance: 0.90, minQuantity: 3, maxQuantity: 5 });
  bossEntries.push({ itemTemplateId: SHOCK_STAFF_ID, chance: 0.40, minQuantity: 1, maxQuantity: 1 });
  bossEntries.push({ itemTemplateId: WAR_HAMMER_ID, chance: 0.35, minQuantity: 1, maxQuantity: 1 });
  bossEntries.push({ itemTemplateId: NANOBLADE_ID, chance: 0.25, minQuantity: 1, maxQuantity: 1 });
  bossEntries.push({ itemTemplateId: CONSTRUCT_PLATING_ID, chance: 0.20, minQuantity: 1, maxQuantity: 1 });

  for (const entry of bossEntries) {
    await prisma.lootEntry.create({ data: { lootTableId: LOOT_TABLE_BOSS_ID, ...entry } });
  }
  console.log(`  ✓ LootTable: Vault Boss (${bossEntries.length} entries)`);

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
  console.log('\nVault-tier items:');
  console.log(`  Corrupted Nanoblade:      18 dmg, 2.3s, slash`);
  console.log(`  Sentinel's War Hammer:    20 dmg, 3.0s, blunt`);
  console.log(`  Overseer's Shock Staff:   16 dmg, 2.5s, lightning`);
  console.log(`  Construct Plating:        body armor (slash/pierce defense)`);
  console.log('\nLoot tables:');
  console.log(`  ${LOOT_TABLE_CONSTRUCT_ID}  — drone/sentinel drops`);
  console.log(`  ${LOOT_TABLE_OVERSEER_ID}  — mini-boss drops`);
  console.log(`  ${LOOT_TABLE_BOSS_ID}       — final boss drops`);
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
