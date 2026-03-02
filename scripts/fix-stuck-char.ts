import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const chars = await prisma.character.findMany({
    select: {
      id: true,
      name: true,
      zoneId: true,
      positionX: true,
      positionY: true,
      positionZ: true,
      lastPositionX: true,
      lastPositionY: true,
      lastPositionZ: true,
      isAlive: true,
    },
  });

  console.log('=== All Characters ===');
  for (const c of chars) {
    console.log(
      `${c.name} | zone=${c.zoneId} | pos=(${c.positionX}, ${c.positionY}, ${c.positionZ}) | lastPos=(${c.lastPositionX}, ${c.lastPositionY}, ${c.lastPositionZ}) | alive=${c.isAlive}`
    );
  }

  // If a character name is passed as arg, reset their position
  const targetName = process.argv[2];
  if (targetName) {
    const safeX = 575;
    const safeY = 21;
    const safeZ = 485;
    console.log(`\nResetting ${targetName} to safe pos (${safeX}, ${safeY}, ${safeZ})...`);
    const result = await prisma.character.updateMany({
      where: { name: targetName },
      data: {
        positionX: safeX,
        positionY: safeY,
        positionZ: safeZ,
        lastPositionX: safeX,
        lastPositionY: safeY,
        lastPositionZ: safeZ,
      },
    });
    console.log(`Updated ${result.count} character(s).`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
