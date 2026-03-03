/**
 * grant-ap.ts — Grant ability points to a character for testing.
 *
 * Usage: npx ts-node prisma/grant-ap.ts <character_name> [amount]
 * Default: 10 AP
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const name = process.argv[2];
  const amount = parseInt(process.argv[3] ?? '10', 10);

  if (!name) {
    console.error('Usage: npx ts-node prisma/grant-ap.ts <character_name> [amount]');
    process.exit(1);
  }

  const char = await prisma.character.findFirst({ where: { name } });
  if (!char) {
    console.error(`Character "${name}" not found.`);
    process.exit(1);
  }

  const newAp = char.abilityPoints + amount;
  await prisma.character.update({
    where: { id: char.id },
    data: { abilityPoints: newAp },
  });

  console.log(`Granted ${amount} AP to ${name}. Total AP: ${newAp}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
