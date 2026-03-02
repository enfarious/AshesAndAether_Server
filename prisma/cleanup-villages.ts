/**
 * cleanup-villages.ts — removes orphaned village data (PlayerVillage, VillageStructure, Zone)
 * where the owning character no longer exists.
 *
 * Run with: npx ts-node prisma/cleanup-villages.ts
 * Safe to run multiple times.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Cleaning up orphaned village data...\n');

  // Find all PlayerVillage records
  const villages = await prisma.playerVillage.findMany({
    include: { structures: true },
  });

  let removedVillages = 0;
  let removedStructures = 0;
  let removedZones = 0;

  for (const village of villages) {
    const character = await prisma.character.findUnique({
      where: { id: village.characterId },
    });

    if (!character) {
      console.log(`  Orphaned village: "${village.name}" (owner: ${village.characterId})`);
      console.log(`    Removing ${village.structures.length} structure(s)...`);

      // Delete structures (cascade would handle this, but be explicit)
      await prisma.villageStructure.deleteMany({ where: { villageId: village.id } });
      removedStructures += village.structures.length;

      // Delete village
      await prisma.playerVillage.delete({ where: { id: village.id } });
      removedVillages++;

      // Delete the Zone record created for this village
      const villageZoneId = `village:${village.characterId}`;
      const zoneResult = await prisma.zone.deleteMany({ where: { id: villageZoneId } });
      removedZones += zoneResult.count;
      if (zoneResult.count > 0) {
        console.log(`    Removed Zone: ${villageZoneId}`);
      }
    }
  }

  // Also clean up any village:* Zone records that have no corresponding PlayerVillage
  const villageZones = await prisma.zone.findMany({
    where: { id: { startsWith: 'village:' } },
  });

  for (const zone of villageZones) {
    const charId = zone.id.slice('village:'.length);
    const village = await prisma.playerVillage.findUnique({ where: { characterId: charId } });
    if (!village) {
      console.log(`  Orphaned zone: ${zone.id} (no matching village)`);
      await prisma.zone.delete({ where: { id: zone.id } });
      removedZones++;
    }
  }

  console.log(`\nDone. Removed ${removedVillages} village(s), ${removedStructures} structure(s), ${removedZones} zone(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
