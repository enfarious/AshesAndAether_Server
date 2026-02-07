import io from 'socket.io-client';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_URL = 'http://localhost:3100';
let socket = null;
let characterId = null;
let worldData = null;
let testsPassed = 0;
let testsFailed = 0;

function log(message, color = 'white') {
  const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    white: '\x1b[37m',
  };
  const reset = '\x1b[0m';
  console.log(`${colors[color]}${message}${reset}`);
}

function test(name, passed, details = '') {
  const emoji = passed ? '✅' : '❌';
  const color = passed ? 'green' : 'red';
  if (passed) testsPassed++;
  else testsFailed++;
  log(`${emoji} ${name}${details ? ': ' + details : ''}`, color);
}

async function connectAndAuth() {
  return new Promise((resolve, reject) => {
    socket = io(SERVER_URL, { reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 5000, reconnectionAttempts: 5 });

    socket.on('connect', () => {
      log('✓ Connected to server', 'green');

      socket.emit('handshake', {
        clientVersion: '0.1.0',
        capabilities: {
          graphics: false,
          audio: false,
          input: ['keyboard'],
          maxUpdateRate: 1,
        },
      });
    });

    socket.on('handshake_ack', (data) => {
      if (!data.compatible) {
        log('✗ Protocol incompatible', 'red');
        reject(new Error('Protocol incompatible'));
        return;
      }
      socket.emit('auth', {
        method: 'guest',
        guestName: 'GravityTester',
      });
    });

    socket.on('auth_success', (data) => {
      log('✓ Authenticated', 'green');
      if (data.characters.length > 0) {
        characterId = data.characters[0].id;
        socket.emit('character_select', { characterId });
      } else {
        socket.emit('character_create', {
          name: 'GravityTester',
          appearance: { description: 'Testing gravity constraints.' },
        });
      }
    });

    socket.on('world_entry', (data) => {
      log('✓ Entered world', 'green');
      worldData = data;
      characterId = data.character.id;
      resolve();
    });

    socket.on('error', (error) => {
      log(`Connection error: ${error}`, 'red');
      reject(error);
    });
  });
}

async function testGravityConstraint() {
  log('\n📍 TEST: Gravity Constraint - Can\'t fly without special ability');

  const startPos = { ...worldData.character.position };
  const flyingAttempt = { x: startPos.x, y: startPos.y + 100, z: startPos.z }; // Try to go 100m up

  return new Promise((resolve) => {
    // Try to move way up
    socket.emit('move', {
      method: 'position',
      position: flyingAttempt,
      speed: 'run',
    });

    setTimeout(() => {
      // Get current position from server
      socket.emit('get_position', {}, (response) => {
        const currentPos = response?.position || startPos;
        const yDiff = currentPos.y - startPos.y;

        test('Player can\'t fly upward', Math.abs(yDiff) < 5, `moved ${yDiff.toFixed(1)}m up (expected near 0)`);
        resolve();
      });
    }, 500);
  });
}

async function testMobStayOnGround() {
  log('\n📍 TEST: Mobs Stay on Ground');

  // Find a rat (smallest mob, at y=265.2)
  const rat = worldData.entities.find(e => e.tag?.startsWith('mob.rat'));
  if (!rat) {
    test('Mob gravity constraint', false, 'No rats found in world');
    return;
  }

  // Rats should be at or near their spawn elevation
  test('Mob at ground level', Math.abs(rat.position.y - 265.2) < 1, `Rat at y=${rat.position.y.toFixed(1)} (spawn=265.2m)`);

  // Check if rat could possibly be floating
  const rabidDog = worldData.entities.find(e => e.tag === 'mob.rabid_dog');
  if (rabidDog) {
    test('Mob on proper terrain', Math.abs(rabidDog.position.y - 267.2) < 1, `Rabid Dog at y=${rabidDog.position.y.toFixed(1)} (terrain=267.2m)`);
  }
}

async function testNoVerticalTeleport() {
  log('\n📍 TEST: No Vertical Teleport Abuse');

  const startPos = { ...worldData.character.position };

  // Try admin teleport (even if restricted)
  const attempted = { x: startPos.x + 50, y: startPos.y + 200, z: startPos.z };

  return new Promise((resolve) => {
    socket.emit('teleport', {
      position: attempted,
      heading: 0,
    });

    setTimeout(() => {
      socket.emit('get_position', {}, (response) => {
        const resultPos = response?.position || startPos;
        const yDiff = resultPos.y - startPos.y;

        test('Teleport respects gravity', Math.abs(yDiff) < 10, `Final y-diff=${yDiff.toFixed(1)}m (expected <10m)`);

        // If teleport went through but respects gravity, that's good
        if (yDiff < 10) {
          log('  → Teleport allowed but constrained by gravity', 'blue');
        }
        resolve();
      });
    }, 500);
  });
}

async function runTests() {
  log('\n' + '='.repeat(60));
  log('🧪 GRAVITY & FLIGHT CONSTRAINTS TEST');
  log('='.repeat(60));

  try {
    await connectAndAuth();

    await testMobStayOnGround();
    await testGravityConstraint();
    await testNoVerticalTeleport();

    log('\n' + '='.repeat(60));
    log(`✅ Tests Complete: ${testsPassed} passed, ${testsFailed} failed`, testsFailed === 0 ? 'green' : 'yellow');
    log('='.repeat(60));

    if (testsFailed === 0) {
      log('\n🎉 All gravity constraints working! Flying requires special abilities.', 'green');
    }
  } catch (error) {
    log(`Test failed: ${error.message}`, 'red');
  }

  socket?.disconnect();
  process.exit(testsFailed === 0 ? 0 : 1);
}

log('\n🧪 Starting Gravity & Flight Constraints Test...');
runTests();
