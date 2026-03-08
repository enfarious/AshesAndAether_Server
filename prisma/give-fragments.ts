/**
 * Quick script to give vault fragments to a character.
 * Usage: npx tsx prisma/give-fragments.ts
 */
import { PrismaClient } from '@prisma/client';

const FRAGMENT_TEMPLATE_ID = 'item-vault-fragment-lab';

async function main() {
  const prisma = new PrismaClient();
  try {
    // Find all characters
    const chars = await prisma.character.findMany({ select: { id: true, name: true } });
    console.log('Characters:', chars);

    if (chars.length === 0) {
      console.log('No characters found.');
      return;
    }

    // Give 3 fragments to each character
    for (const char of chars) {
      // Check if they already have fragments
      const existing = await prisma.inventoryItem.findFirst({
        where: { characterId: char.id, itemTemplateId: FRAGMENT_TEMPLATE_ID },
      });

      if (existing) {
        // Update quantity to at least 3
        const newQty = Math.max(existing.quantity, 3);
        await prisma.inventoryItem.update({
          where: { id: existing.id },
          data: { quantity: newQty },
        });
        console.log(`  ${char.name}: updated fragment quantity to ${newQty}`);
      } else {
        // Create new stack of 3
        await prisma.inventoryItem.create({
          data: {
            characterId: char.id,
            itemTemplateId: FRAGMENT_TEMPLATE_ID,
            quantity: 3,
          },
        });
        console.log(`  ${char.name}: gave 3 Nanotech Lab Fragments`);
      }
    }

    console.log('\nDone! Use /vault assemble near a workbench, then /vault enter.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(console.error);
