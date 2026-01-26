/**
 * Database Cleanup Utility
 *
 * Finds and removes orphaned records that may have been created by
 * server crashes, incomplete transactions, or missing cascade deletes.
 *
 * Run with: npx ts-node scripts/cleanup-orphans.ts [--dry-run]
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface CleanupResult {
  table: string;
  orphansFound: number;
  orphansDeleted: number;
  ids: string[];
}

async function findOrphanedCharacters(): Promise<CleanupResult> {
  // Characters whose accountId doesn't exist in accounts table
  const orphans = await prisma.$queryRaw<{ id: string }[]>`
    SELECT c.id FROM characters c
    LEFT JOIN accounts a ON c."accountId" = a.id
    WHERE a.id IS NULL
  `;

  return {
    table: 'characters',
    orphansFound: orphans.length,
    orphansDeleted: 0,
    ids: orphans.map((o) => o.id),
  };
}

async function findOrphanedFactionReputations(): Promise<CleanupResult> {
  // FactionReputations whose characterId doesn't exist
  const orphans = await prisma.$queryRaw<{ id: string }[]>`
    SELECT fr.id FROM faction_reputations fr
    LEFT JOIN characters c ON fr."characterId" = c.id
    WHERE c.id IS NULL
  `;

  return {
    table: 'faction_reputations',
    orphansFound: orphans.length,
    orphansDeleted: 0,
    ids: orphans.map((o) => o.id),
  };
}

async function findOrphanedQuestProgress(): Promise<CleanupResult> {
  // QuestProgress whose characterId doesn't exist
  const orphans = await prisma.$queryRaw<{ id: string }[]>`
    SELECT qp.id FROM quest_progress qp
    LEFT JOIN characters c ON qp."characterId" = c.id
    WHERE c.id IS NULL
  `;

  return {
    table: 'quest_progress',
    orphansFound: orphans.length,
    orphansDeleted: 0,
    ids: orphans.map((o) => o.id),
  };
}

async function findOrphanedInventoryItems(): Promise<CleanupResult> {
  // InventoryItems whose characterId doesn't exist
  const orphans = await prisma.$queryRaw<{ id: string }[]>`
    SELECT ii.id FROM inventory_items ii
    LEFT JOIN characters c ON ii."characterId" = c.id
    WHERE c.id IS NULL
  `;

  return {
    table: 'inventory_items',
    orphansFound: orphans.length,
    orphansDeleted: 0,
    ids: orphans.map((o) => o.id),
  };
}

async function findOrphanedCorruptionEvents(): Promise<CleanupResult> {
  // CorruptionEvents whose characterId doesn't exist
  const orphans = await prisma.$queryRaw<{ id: string }[]>`
    SELECT ce.id FROM corruption_events ce
    LEFT JOIN characters c ON ce."characterId" = c.id
    WHERE c.id IS NULL
  `;

  return {
    table: 'corruption_events',
    orphansFound: orphans.length,
    orphansDeleted: 0,
    ids: orphans.map((o) => o.id),
  };
}

async function findStaleGuestAccounts(): Promise<CleanupResult> {
  // Guest accounts older than 24 hours (should have been cleaned up on disconnect)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const staleGuests = await prisma.account.findMany({
    where: {
      email: { startsWith: 'guest-' },
      createdAt: { lt: cutoff },
    },
    select: { id: true },
  });

  return {
    table: 'accounts (stale guests)',
    orphansFound: staleGuests.length,
    orphansDeleted: 0,
    ids: staleGuests.map((g) => g.id),
  };
}

async function deleteOrphans(result: CleanupResult): Promise<CleanupResult> {
  if (result.ids.length === 0) return result;

  switch (result.table) {
    case 'characters':
      await prisma.character.deleteMany({ where: { id: { in: result.ids } } });
      break;
    case 'faction_reputations':
      await prisma.factionReputation.deleteMany({ where: { id: { in: result.ids } } });
      break;
    case 'quest_progress':
      await prisma.questProgress.deleteMany({ where: { id: { in: result.ids } } });
      break;
    case 'inventory_items':
      await prisma.inventoryItem.deleteMany({ where: { id: { in: result.ids } } });
      break;
    case 'corruption_events':
      await prisma.corruptionEvent.deleteMany({ where: { id: { in: result.ids } } });
      break;
    case 'accounts (stale guests)':
      // Characters will cascade delete now
      await prisma.account.deleteMany({ where: { id: { in: result.ids } } });
      break;
  }

  return { ...result, orphansDeleted: result.ids.length };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  console.log('=== Database Cleanup Utility ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will delete orphans)'}\n`);

  const checks = [
    findOrphanedCharacters,
    findOrphanedFactionReputations,
    findOrphanedQuestProgress,
    findOrphanedInventoryItems,
    findOrphanedCorruptionEvents,
    findStaleGuestAccounts,
  ];

  let totalFound = 0;
  let totalDeleted = 0;

  for (const check of checks) {
    let result = await check();
    totalFound += result.orphansFound;

    if (result.orphansFound > 0 && !dryRun) {
      result = await deleteOrphans(result);
      totalDeleted += result.orphansDeleted;
    }

    const status =
      result.orphansFound === 0
        ? 'OK'
        : dryRun
          ? `FOUND ${result.orphansFound}`
          : `DELETED ${result.orphansDeleted}`;

    console.log(`  ${result.table}: ${status}`);
    if (result.orphansFound > 0 && result.ids.length <= 10) {
      console.log(`    IDs: ${result.ids.join(', ')}`);
    } else if (result.orphansFound > 10) {
      console.log(`    First 10 IDs: ${result.ids.slice(0, 10).join(', ')}...`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`  Orphans found: ${totalFound}`);
  if (!dryRun) {
    console.log(`  Orphans deleted: ${totalDeleted}`);
  } else if (totalFound > 0) {
    console.log('  Run without --dry-run to delete orphans');
  }
}

main()
  .catch((e) => {
    console.error('Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
