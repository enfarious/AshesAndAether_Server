import { prisma } from './src/database/DatabaseService.js';

async function cleanup() {
  const accountId = '6b903753-5672-4b72-a9d8-2958b2c18f2d';
  
  // Delete characters first
  await prisma.character.deleteMany({
    where: { accountId },
  });
  
  // Delete account
  await prisma.account.delete({
    where: { id: accountId },
  });
  
  console.log('✓ Deleted test account and characters');
}

cleanup()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
