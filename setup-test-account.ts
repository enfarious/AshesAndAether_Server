/**
 * Setup a persistent test account for position persistence testing
 */
import { prisma } from './src/database/DatabaseService';
import { SpawnPointService } from './src/world/SpawnPointService';
import bcrypt from 'bcryptjs';

async function main() {
  const testEmail = 'test-persist@example.com';
  const testPassword = 'TestPassword123!';
  const testCharName = 'PositionTester';
  const starterZoneId = 'USA_NY_Stephentown';

  console.log('Setting up persistent test account...');

  // Check if account already exists
  let account = await prisma.account.findUnique({
    where: { email: testEmail },
  });

  if (!account) {
    // Hash password
    const passwordHash = await bcrypt.hash(testPassword, 10);
    
    // Create account
    account = await prisma.account.create({
      data: {
        email: testEmail,
        username: 'positiontester',
        passwordHash,
      },
    });
    console.log(`✓ Created account: ${account.email} (ID: ${account.id})`);
    console.log(`  Password: ${testPassword}`);
  } else {
    console.log(`✓ Account already exists: ${account.email} (ID: ${account.id})`);
  }

  // Check if character exists
  let character = await prisma.character.findFirst({
    where: {
      accountId: account.id,
      name: testCharName,
    },
  });

  if (!character) {
    // Get spawn position
    const spawn = SpawnPointService.getStarterSpawn(starterZoneId);
    if (!spawn) {
      throw new Error('No spawn point available');
    }

    // Create character
    character = await prisma.character.create({
      data: {
        accountId: account.id,
        name: testCharName,
        level: 1,
        experience: 0,
        abilityPoints: 0,
        
        // Core stats (all 10)
        strength: 10,
        vitality: 10,
        dexterity: 10,
        agility: 10,
        intelligence: 10,
        wisdom: 10,
        
        // Derived stats (basic)
        maxHp: 100,
        maxStamina: 100,
        maxMana: 100,
        attackRating: 50,
        defenseRating: 50,
        magicAttack: 50,
        magicDefense: 50,
        
        // Current resources
        currentHp: 100,
        currentStamina: 100,
        currentMana: 100,
        isAlive: true,
        
        // Position
        zoneId: starterZoneId,
        positionX: spawn.position.x,
        positionY: spawn.position.y,
        positionZ: spawn.position.z,
        heading: 0,
        
        // Progression (empty arrays)
        unlockedFeats: [],
        unlockedAbilities: [],
        activeLoadout: [],
        passiveLoadout: [],
        specialLoadout: [],
      },
    });
    console.log(`✓ Created character: ${character.name} (ID: ${character.id})`);
  } else {
    console.log(`✓ Character already exists: ${character.name} (ID: ${character.id})`);
  }

  console.log('\n=== Test Account Ready ===');
  console.log(`Account ID: ${account.id}`);
  console.log(`Account Email: ${testEmail}`);
  console.log(`Character ID: ${character.id}`);
  console.log(`Character Name: ${character.name}`);
  console.log(`Position: (${character.positionX.toFixed(1)}, ${character.positionY.toFixed(1)}, ${character.positionZ.toFixed(1)})`);
}

main()
  .then(() => {
    console.log('\n✓ Setup complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Setup failed:', error);
    process.exit(1);
  });
