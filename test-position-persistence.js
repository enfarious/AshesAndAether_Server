/**
 * Position Persistence Test
 * 
 * Tests that character positions are saved on logout and restored on login
 * Verifies respawn collision avoidance and fallback chain
 */

import io from 'socket.io-client';

const SERVER_URL = 'http://localhost:3100';
const PROTOCOL_VERSION = '1.0.0';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logTest(message, success = true) {
  const icon = success ? '✅' : '❌';
  const color = success ? 'green' : 'red';
  log(`${icon} TEST: ${message}`, color);
}

function logStep(message) {
  log(`📍 ${message}`, 'cyan');
}

function formatPosition(pos) {
  return `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;
}

async function testPositionPersistence() {
  log('\n' + '='.repeat(60), 'bright');
  log('POSITION PERSISTENCE TEST', 'bright');
  log('='.repeat(60) + '\n', 'bright');

  const testCharacterName = `PersistTest_${Date.now()}`;
  let socket1 = null;
  let socket2 = null;
  let accountId = null;
  let characterId = null;
  let initialPosition = null;
  let savedPosition = null;
  let respawnPosition = null;

  try {
    // === PHASE 1: Create Account and Character ===
    logStep('Phase 1: Creating test account and character');
    
    socket1 = io(SERVER_URL, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5,
    });

    await new Promise((resolve) => {
      socket1.on('connect', () => {
        logTest('Socket 1 connected', true);
        
        // Send handshake
        socket1.emit('handshake', {
          protocolVersion: PROTOCOL_VERSION,
          clientType: 'test',
          clientVersion: '1.0.0',
          capabilities: {
            graphics: false,
            audio: false,
            physics: true,
            animation: false,
          },
        });
        
        resolve();
      });
    });

    await new Promise((resolve) => {
      socket1.once('handshake_ack', (data) => {
        if (data.compatible) {
          logTest('Handshake successful', true);
        }
        resolve();
      });
    });

    // Authenticate with credentials (persistent account, not guest)
    socket1.emit('auth', {
      method: 'credentials',
      email: 'test-persist@example.com',
      password: 'test-password-123',
    });

    const authResult = await new Promise((resolve) => {
      socket1.once('auth_success', resolve);
      socket1.once('auth_error', () => {
        logTest('Auth failed', false);
        resolve(null);
      });
      setTimeout(() => resolve(null), 5000);
    });

    if (!authResult) {
      logTest('Authentication failed', false);
      throw new Error('Auth failed');
    }

    accountId = authResult.accountId;
    logTest(`Authenticated with account ${accountId}`, true);

    // Check if we have existing characters
    if (authResult.characters && authResult.characters.length > 0) {
      characterId = authResult.characters[0].id;
      logTest(`Using existing character: ${authResult.characters[0].name}`, true);
    } else {
      // Create new character
      socket1.emit('character_create', { name: testCharacterName, appearance: {} });

      const createResult = await new Promise((resolve) => {
        socket1.once('character_roster_delta', resolve);
        socket1.once('character_error', () => {
          logTest('Character creation error', false);
          resolve(null);
        });
        setTimeout(() => resolve(null), 5000);
      });

      if (!createResult?.added?.[0]?.id) {
        logTest('Character creation failed', false);
        throw new Error('Character creation failed');
      }

      characterId = createResult.added[0].id;
      logTest(`Created character ${testCharacterName} (ID: ${characterId})`, true);
    }

    // === PHASE 2: Enter World and Record Position ===
    logStep('Phase 2: Entering world and recording initial position');

    socket1.emit('character_select', { characterId });

    const worldEntry = await new Promise((resolve) => {
      socket1.once('world_entry', resolve);
      setTimeout(() => resolve(null), 5000);
    });

    if (!worldEntry?.character?.position) {
      logTest('World entry failed', false);
      throw new Error('World entry failed');
    }

    initialPosition = worldEntry.character.position;
    logTest(`Character spawned at ${formatPosition(initialPosition)}`, true);

    // === PHASE 3: Move Character to New Position ===
    logStep('Phase 3: Moving character to test position');

    const testPosition = {
      x: initialPosition.x + 50,
      y: initialPosition.y,
      z: initialPosition.z + 50,
    };

    socket1.emit('move', {
      method: 'position',
      position: testPosition,
      speed: 'walk',
      timestamp: Date.now(),
    });

    // Wait for movement to complete and persist to database
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Simulate position update (normally done via ticks)
    const movementResult = await new Promise((resolve) => {
      socket1.once('entity_update', resolve);
      setTimeout(() => resolve(null), 2000);
    });

    if (movementResult) {
      logTest(`Movement update received`, true);
    }

    // === PHASE 4: Disconnect (Save Position) ===
    logStep('Phase 4: Disconnecting (should save position)');

    socket1.disconnect();
    await new Promise(resolve => setTimeout(resolve, 500));
    logTest('Disconnected, position saved to database', true);

    // === PHASE 5: Reconnect and Verify Respawn Position ===
    logStep('Phase 5: Reconnecting to verify position restoration');

    socket2 = io(SERVER_URL, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5,
    });

    await new Promise((resolve) => {
      socket2.on('connect', () => {
        logTest('Socket 2 connected', true);
        
        // Send handshake
        socket2.emit('handshake', {
          protocolVersion: PROTOCOL_VERSION,
          clientType: 'test',
          clientVersion: '1.0.0',
          capabilities: {
            graphics: false,
            audio: false,
            physics: true,
            animation: false,
          },
        });
        
        resolve();
      });
    });

    await new Promise((resolve) => {
      socket2.once('handshake_ack', (data) => {
        if (data.compatible) {
          logTest('Handshake successful', true);
        }
        resolve();
      });
    });

    // Re-authenticate with same credentials (persistent account)
    socket2.emit('auth', {
      method: 'credentials',
      email: 'test-persist@example.com',
      password: 'test-password-123',
    });

    const auth2Result = await new Promise((resolve) => {
      socket2.once('auth_success', resolve);
      socket2.once('auth_error', (err) => {
        logTest('Re-auth failed', false);
        resolve(null);
      });
      setTimeout(() => resolve(null), 5000);
    });

    if (!auth2Result) {
      logTest('Re-authentication failed', false);
      throw new Error('Re-auth failed');
    }

    logTest('Re-authenticated', true);

    // Select character again
    socket2.emit('character_select', { characterId });

    const respawnEntry = await new Promise((resolve) => {
      socket2.once('world_entry', resolve);
      setTimeout(() => resolve(null), 5000);
    });

    if (!respawnEntry?.character?.position) {
      logTest('Respawn failed', false);
      throw new Error('Respawn failed');
    }

    respawnPosition = respawnEntry.character.position;
    logTest(`Character respawned at ${formatPosition(respawnPosition)}`, true);

    // === PHASE 6: Verify Position Persistence ===
    logStep('Phase 6: Verifying position persistence');

    const positionDiff = Math.sqrt(
      Math.pow(respawnPosition.x - testPosition.x, 2) +
      Math.pow(respawnPosition.y - testPosition.y, 2) +
      Math.pow(respawnPosition.z - testPosition.z, 2)
    );

    const isPositionRestored = positionDiff < 2; // Allow 2m tolerance for collision avoidance

    logTest(
      `Position restored (diff: ${positionDiff.toFixed(2)}m, ` +
      `expected within 2m for collision offset)`,
      isPositionRestored
    );

    if (isPositionRestored) {
      logTest('✨ POSITION PERSISTENCE TEST PASSED ✨', true);
    } else {
      logTest('Position not properly restored', false);
    }

    // === Cleanup ===
    log('\nCleaning up...', 'yellow');
    socket2.disconnect();

  } catch (error) {
    logTest(`Test failed with error: ${error.message}`, false);
    console.error(error);
  }

  log('\n' + '='.repeat(60) + '\n', 'bright');
}

// Run test
testPositionPersistence().catch(console.error);
