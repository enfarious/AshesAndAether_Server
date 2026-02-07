/**
 * Live Physics System Test Client
 *
 * Tests physics constraints in the live MMO server:
 * - Terrain collision (preventing falling through ground)
 * - Entity collision (preventing walking through NPCs)
 * - Line-of-sight blocking for combat
 * 
 * IMPORTANT: Server must be restarted after code changes!
 * - tsx watch only restarts on .ts file saves
 * - Old characters in DB will spawn at old positions
 * - Delete test characters or restart server for accurate results
 */

import io from 'socket.io-client';
import fs from 'fs';
import path from 'path';

const SERVER_URL = 'http://localhost:3100';
const PROTOCOL_VERSION = '1.0.0';
const WATER_DATA_PATH = path.join('data', 'osm', 'USA_NY_Stephentown', 'water.json');

// ANSI color codes
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

function logPhysics(message, success = true) {
  const icon = success ? '✅' : '❌';
  const color = success ? 'green' : 'red';
  log(`${icon} PHYSICS: ${message}`, color);
}

function loadWaterTarget() {
  try {
    if (!fs.existsSync(WATER_DATA_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(WATER_DATA_PATH, 'utf-8'));
    const feature = Array.isArray(raw)
      ? raw.find(entry => Array.isArray(entry.nodes) && entry.nodes.length > 0)
      : null;
    if (!feature) return null;
    const node = feature.nodes[0];
    if (!node || typeof node.lat !== 'number' || typeof node.lon !== 'number') return null;

    // Read metadata to get terrain center
    const metadataPath = path.join('data', 'osm', 'USA_NY_Stephentown', 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    const centerLat = metadata.center.lat;
    const centerLon = metadata.center.lon;

    // Convert lat/lon to world coordinates (meters from center)
    // 1 degree latitude ≈ 111,320 meters
    // 1 degree longitude ≈ 111,320 * cos(lat) meters
    const latOffset = (node.lat - centerLat) * 111320;
    const lonOffset = (node.lon - centerLon) * 111320 * Math.cos((centerLat * Math.PI) / 180);

    return {
      lat: node.lat,
      lon: node.lon,
      x: lonOffset,  // East/west offset in meters
      z: latOffset,  // North/south offset in meters
    };
  } catch (error) {
    log(`⚠️  Failed to read water data: ${error.message}`, 'yellow');
    return null;
  }
}

// Connect to server
log('\n🧪 Starting Live Physics System Test...', 'bright');
log('Testing terrain collision, entity collision, and LOS blocking', 'cyan');

const socket = io(SERVER_URL, {
  transports: ['websocket'],
});

let currentPosition = { x: 0, y: 265, z: 0 }; // Will be updated from server
let characterId = null;
let worldData = null;
let testsStarted = false;

socket.on('connect', () => {
  log('✓ Connected to server', 'green');

  // Send handshake
  socket.emit('handshake', {
    protocolVersion: PROTOCOL_VERSION,
    clientType: 'physics-test',
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
    socket.disconnect();
    return;
  }

  // Authenticate as guest
  socket.emit('auth', {
    method: 'guest',
    guestName: 'PhysicsTester',
  });
});

socket.on('auth_success', (data) => {
  log('✓ Authenticated', 'green');

  // Select first character or create one
  if (data.characters.length > 0) {
    characterId = data.characters[0].id;
    socket.emit('character_select', { characterId });
  } else {
    socket.emit('character_create', {
      name: 'PhysicsTester',
      appearance: { description: 'A physics testing entity.' },
    });
  }
});

socket.on('world_entry', (data) => {
  log('✓ Entered world', 'green');
  worldData = data;
  currentPosition = { ...data.character.position };
  characterId = data.character.id;

  // DEBUG: Show what entities we got
  console.log(`\nDEBUG: Received ${data.entities?.length || 0} entities:`);
  data.entities?.forEach((e, i) => {
    console.log(`  ${i + 1}. ${e.type} - ${e.name || e.tag} at (${e.position.x.toFixed(1)}, ${e.position.y.toFixed(1)}, ${e.position.z.toFixed(1)})`);
  });

  // Start physics tests after a brief delay (only once)
  if (!testsStarted) {
    testsStarted = true;
    setTimeout(() => {
      runPhysicsTests();
    }, 1000);
  }
});

socket.on('state_update', (data) => {
  // Update position tracking
  if (data.entities?.updated) {
    data.entities.updated.forEach(entity => {
      if (entity.id === characterId) {
        currentPosition = { ...entity.position };
      }
    });
  }
});

socket.on('dev_ack', (data) => {
  // Movement acknowledgments
});

socket.on('disconnect', () => {
  log('\n🏁 Physics test completed', 'bright');
  process.exit(0);
});

function runPhysicsTests() {
  log('\n' + '='.repeat(60), 'cyan');
  log('🧪 RUNNING PHYSICS TESTS', 'bright');
  log('='.repeat(60), 'cyan');

  let testIndex = 0;
  const tests = [
    // Test 1: Try to fall through terrain
    () => {
      log('\n📍 TEST 1: Terrain Collision (Falling)', 'yellow');
      log(`Current position: x=${currentPosition.x.toFixed(1)}, y=${currentPosition.y.toFixed(1)}, z=${currentPosition.z.toFixed(1)}`, 'cyan');
      log('Attempting to move below ground level...', 'blue');

      const belowGround = {
        x: currentPosition.x,
        y: currentPosition.y - 100, // Way below ground
        z: currentPosition.z
      };

      socket.emit('move', {
        method: 'position',
        position: belowGround,
        heading: 0,
        speed: 'walk',
      });

      // Check result after delay (give time for state update)
      setTimeout(() => {
        const expectedY = 265; // Terrain elevation at spawn ~265m
        const tolerance = 20; // Allow some variance
        if (Math.abs(currentPosition.y - expectedY) < tolerance) {
          logPhysics('Terrain collision working - prevented falling through ground');
        } else {
          logPhysics(`Terrain collision FAILED - expected ~${expectedY}m, got ${currentPosition.y.toFixed(1)}m`, false);
        }
      }, 500);
    },

    // Test 2: Try to walk through a mob
    () => {
      log('\n📍 TEST 2: Entity Collision (Mob)', 'yellow');
      if (!worldData?.entities?.length) {
        logPhysics('No entities nearby - skipping entity collision test');
        return;
      }

      // Find a mob (not player or NPC)
      const mob = worldData.entities.find(e => e.tag?.startsWith('mob.'));
      if (!mob) {
        logPhysics('No mobs found - skipping entity collision test');
        return;
      }

      log(`Attempting to walk through ${mob.name} at (${mob.position.x.toFixed(1)}, ${mob.position.z.toFixed(1)})...`, 'blue');
      const beforeDistance = Math.sqrt(
        Math.pow(currentPosition.x - mob.position.x, 2) +
        Math.pow(currentPosition.z - mob.position.z, 2)
      );

      // Try to move to the mob's exact position
      socket.emit('move', {
        method: 'position',
        position: { ...mob.position },
        heading: 0,
        speed: 'walk',
      });

      // Check if movement was blocked (wait for state update)
      setTimeout(() => {
        const afterDistance = Math.sqrt(
          Math.pow(currentPosition.x - mob.position.x, 2) +
          Math.pow(currentPosition.z - mob.position.z, 2)
        );

        // Should be blocked before reaching the mob (within collision radius)
        if (afterDistance > 0.5 && afterDistance >= beforeDistance * 0.5) {
          logPhysics('Entity collision working - prevented walking through mob');
        } else {
          logPhysics('Entity collision FAILED - walked through mob', false);
        }
      }, 500);
    },

    // Test 3: Movement + LOS + Combat with mob
    () => {
      log('\n📍 TEST 3: Combat Integration (Movement + LOS + Attack)', 'yellow');
      if (!worldData?.entities?.length) {
        logPhysics('No targets nearby - skipping combat test');
        return;
      }

      const mob = worldData.entities.find(e => e.tag?.startsWith('mob.'));
      if (!mob) {
        logPhysics('No mobs found - skipping combat test');
        return;
      }

      log(`Moving near ${mob.name} then attacking...`, 'blue');
      
      // Move close to the mob first
      const approachPos = {
        x: mob.position.x + 3, // 3m away
        y: currentPosition.y,
        z: mob.position.z + 3
      };
      
      socket.emit('move', {
        method: 'position',
        position: approachPos,
        speed: 'run',
      });

      setTimeout(() => {
        // Try to attack from this position
        socket.emit('command', {
          command: `/attack ${mob.tag || mob.name}`
        });
        
        setTimeout(() => {
          logPhysics('Combat integration test completed (check server logs for LOS/combat validation)');
        }, 300);
      }, 700);
    },

    // Test 4: Movement speed/distance validation
    () => {
      log('\n📍 TEST 4: Movement Speed Validation', 'yellow');
      log('Attempting impossible movement speed...', 'blue');

      const startPos = { ...currentPosition };
      const startTime = Date.now();
      
      // Try to move 1000m instantly (impossible)
      const extremePos = {
        x: currentPosition.x + 1000,
        y: currentPosition.y,
        z: currentPosition.z + 1000
      };

      socket.emit('move', {
        method: 'position',
        position: extremePos,
        heading: 0,
        speed: 'run',
      });

      setTimeout(() => {
        const elapsed = (Date.now() - startTime) / 1000; // seconds
        const actualDist = Math.sqrt(
          Math.pow(currentPosition.x - startPos.x, 2) +
          Math.pow(currentPosition.z - startPos.z, 2)
        );
        
        // Run speed is ~10m/s, so in 0.5s should move max ~5m
        const maxExpected = 15; // Allow some lag tolerance
        
        if (actualDist < maxExpected) {
          logPhysics(`Movement validation working - moved ${actualDist.toFixed(1)}m (expected <${maxExpected}m)`);
        } else {
          logPhysics(`Movement validation FAILED - teleported ${actualDist.toFixed(1)}m`, false);
        }
      }, 500);
    },

    // Test 5: Normal movement (should work)
    () => {
      log('\n📍 TEST 5: Normal Movement (Control Test)', 'yellow');
      log('Testing normal movement that should succeed...', 'blue');

      const normalPos = {
        x: currentPosition.x + 5,
        y: currentPosition.y,
        z: currentPosition.z + 5
      };

      socket.emit('move', {
        method: 'position',
        position: normalPos,
        heading: 45,
        speed: 'walk',
      });

      setTimeout(() => {
        const movedDistance = Math.sqrt(
          Math.pow(currentPosition.x - normalPos.x, 2) +
          Math.pow(currentPosition.z - normalPos.z, 2)
        );

        // Should be moving toward target (distance getting smaller over time)
        if (movedDistance < 10) { // Within reasonable range
          logPhysics('Normal movement working correctly');
        } else {
          logPhysics(`Normal movement distance: ${movedDistance.toFixed(1)}m from target`, movedDistance < 50);
        }
      }, 500);
    }
    ,
    // Test 6: Water surface clamp (non-aquatic)
    () => {
      log('\n📍 TEST 6: Water Surface Clamp', 'yellow');
      const waterTarget = loadWaterTarget();
      if (!waterTarget) {
        logPhysics('No OSM water data available - skipping water test');
        return;
      }

      log(`Teleporting to water at lat=${waterTarget.lat.toFixed(5)}, lon=${waterTarget.lon.toFixed(5)}...`, 'blue');

      socket.emit('move', {
        method: 'position',
        position: { x: waterTarget.x, y: currentPosition.y, z: waterTarget.z },
        speed: 'walk',
      });

      setTimeout(() => {
        const targetY = currentPosition.y - 100;
        socket.emit('move', {
          method: 'position',
          position: { x: currentPosition.x, y: targetY, z: currentPosition.z },
          speed: 'walk',
        });

        setTimeout(() => {
          if (currentPosition.y > targetY + 1) {
            logPhysics('Water surface clamp working - prevented deep submerge');
          } else {
            logPhysics('Water surface clamp FAILED - allowed deep submerge', false);
          }
        }, 700);
      }, 700);
    }
  ];

  function runNextTest() {
    if (testIndex < tests.length) {
      tests[testIndex]();
      testIndex++;

      // Run next test after delay (longer to allow state updates)
      setTimeout(runNextTest, 3000);
    } else {
      // All tests completed
      log('\n' + '='.repeat(60), 'cyan');
      log('🏁 PHYSICS TEST SUITE COMPLETED', 'bright');
      log('='.repeat(60), 'cyan');
      log('\nCheck server logs for detailed physics validation messages.', 'yellow');
      log('Expected messages: "Movement adjusted by physics", "Movement blocked by physics"', 'blue');

      // Disconnect after summary
      setTimeout(() => {
        socket.disconnect();
      }, 2000);
    }
  }

  runNextTest();
}

// Error handling
socket.on('connect_error', (error) => {
  log(`✗ Connection failed: ${error.message}`, 'red');
  process.exit(1);
});

socket.on('error', (data) => {
  log(`✗ Server error: ${data.message}`, 'red');
});

// Graceful shutdown
process.on('SIGINT', () => {
  log('\nShutting down physics test...', 'yellow');
  socket.disconnect();
  process.exit(0);
});
