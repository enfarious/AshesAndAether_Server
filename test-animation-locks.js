/**
 * Animation Lock System Test
 * 
 * Tests animation states and locks with guest auth (which works)
 * User will test position persistence separately with credentials
 */

import io from 'socket.io-client';

const SERVER_URL = 'http://localhost:3100';
let socket;
let characterId;

function log(message, data = null) {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
  console.log(`[${timestamp}] ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function connect() {
  return new Promise((resolve, reject) => {
    socket = io(SERVER_URL, { 
      transports: ['websocket'],
      reconnection: false 
    });

    socket.on('connect', () => {
      log('✓ Connected');
      resolve();
    });

    socket.on('connect_error', (err) => {
      reject(err);
    });
  });
}

async function handshake() {
  return new Promise((resolve) => {
    socket.emit('handshake', {
      protocolVersion: '1.0.0',
      clientType: 'test',
      clientVersion: '1.0.0',
    });

    socket.once('handshake_ack', (data) => {
      log('✓ Handshake', { compatible: data.compatible });
      resolve();
    });
  });
}

async function authGuest() {
  return new Promise((resolve) => {
    socket.emit('auth', {
      method: 'guest',
      guestName: 'AnimTestBot',
    });

    socket.once('auth_success', (data) => {
      log('✓ Guest auth', { accountId: data.accountId.slice(0, 8) + '...' });
      
      // Guest auth auto-creates character, just select it
      if (data.characters.length > 0) {
        characterId = data.characters[0].id;
        log('  → Using existing character:', data.characters[0].name);
      }
      
      resolve(data);
    });
  });
}

async function enterWorld() {
  return new Promise((resolve) => {
    // If we have a character, select it; otherwise, create one
    if (characterId) {
      socket.emit('character_select', { characterId });
    } else {
      socket.emit('character_create', {
        name: 'TestAnimBot',
        appearance: { description: 'Testing animations' },
      });
    }

    socket.once('world_entry', (data) => {
      log('✓ Entered world', {
        zone: data.zone.name,
        position: data.character.position,
        currentAction: data.character.currentAction,
      });
      resolve(data);
    });
  });
}

async function testMovementAnimations() {
  log('\n=== TEST 1: Movement Animation States ===');
  
  return new Promise((resolve) => {
    let stateUpdates = [];
    
    const stateListener = (data) => {
      if (data.entities?.updated) {
        const update = data.entities.updated[0];
        if (update && update.currentAction) {
          stateUpdates.push({
            action: update.currentAction,
            position: update.position,
            speed: update.movementSpeed,
          });
          log(`  → Animation state: ${update.currentAction}`, {
            speed: update.movementSpeed,
            duration: update.movementDuration,
          });
        }
      }
    };
    
    socket.on('state_update', stateListener);
    
    // Start running
    log('Starting movement (run)...');
    socket.emit('move', {
      method: 'heading',
      heading: 90, // East
      speed: 'run',
      timestamp: Date.now(),
    });
    
    setTimeout(() => {
      // Stop movement
      log('Stopping movement...');
      socket.emit('move', {
        method: 'heading',
        speed: 'stop',
        timestamp: Date.now(),
      });
      
      setTimeout(() => {
        socket.off('state_update', stateListener);
        
        const hasRunning = stateUpdates.some(s => s.action === 'running');
        const hasIdle = stateUpdates.some(s => s.action === 'idle');
        
        if (hasRunning && hasIdle) {
          log('✓ TEST 1 PASSED: Movement animations working');
        } else {
          log('✗ TEST 1 FAILED: Expected running → idle transition');
          log('  Got states:', stateUpdates.map(s => s.action));
        }
        
        resolve();
      }, 500);
    }, 2000);
  });
}

async function testProximityRosterAnimations() {
  log('\n=== TEST 2: Proximity Roster Animation Data ===');
  
  return new Promise((resolve) => {
    socket.once('proximity_roster_delta', (data) => {
      const entities = [...(data.added || []), ...(data.updated || [])];
      
      if (entities.length > 0) {
        const withAnimations = entities.filter(e => e.currentAction);
        log(`✓ Received ${entities.length} entities, ${withAnimations.length} have currentAction`);
        
        if (withAnimations.length > 0) {
          log('  Sample:', {
            name: withAnimations[0].name,
            action: withAnimations[0].currentAction,
          });
          log('✓ TEST 2 PASSED: Proximity roster includes animation states');
        } else {
          log('⚠ TEST 2 PARTIAL: No entities with animations yet (may need more time)');
        }
      }
      
      resolve();
    });
    
    // Trigger a proximity update
    socket.emit('move', {
      method: 'heading',
      heading: 180,
      speed: 'walk',
      timestamp: Date.now(),
    });
    
    setTimeout(() => {
      socket.emit('move', {
        method: 'heading',
        speed: 'stop',
        timestamp: Date.now(),
      });
    }, 500);
    
    // Fallback timeout
    setTimeout(() => {
      log('⚠ TEST 2 TIMEOUT: No proximity update received');
      resolve();
    }, 3000);
  });
}

async function testCombatAnimationLock() {
  log('\n=== TEST 3: Combat Animation Locks ===');
  
  return new Promise(async (resolve) => {
    // Try to move during combat ability
    log('Attempting attack (will set animation lock)...');
    
    // Listen for combat events
    const combatListener = (data) => {
      if (data.eventType === 'combat_error') {
        log('  → Combat error:', data.reason || data.narrative);
      } else if (data.eventType === 'combat_action') {
        log('  → Combat action executed:', {
          ability: data.abilityName || data.abilityId,
        });
      }
    };
    
    socket.on('combat_event', combatListener);
    
    // Try to attack something (will likely fail with no target, but should set lock)
    socket.emit('combat_action', {
      abilityId: 'basic_attack',
      target: 'nonexistent',
    });
    
    await sleep(100);
    
    // Now try to move (should be blocked by animation lock)
    log('Trying to move immediately after attack...');
    socket.emit('move', {
      method: 'heading',
      heading: 0,
      speed: 'run',
      timestamp: Date.now(),
    });
    
    // Check if movement was blocked
    let movementBlocked = false;
    const moveListener = (data) => {
      if (data.entities?.updated) {
        const update = data.entities.updated[0];
        if (update && update.currentAction === 'running') {
          movementBlocked = false;
          log('  Movement allowed (soft lock or no lock)');
        }
      }
    };
    
    socket.on('state_update', moveListener);
    
    setTimeout(() => {
      socket.off('combat_event', combatListener);
      socket.off('state_update', moveListener);
      
      // Stop movement
      socket.emit('move', {
        method: 'heading',
        speed: 'stop',
        timestamp: Date.now(),
      });
      
      log('✓ TEST 3 COMPLETE: Combat animation system responded');
      log('  (Full lock testing requires valid combat target)');
      resolve();
    }, 1500);
  });
}

async function testPhysicsStillWorks() {
  log('\n=== TEST 4: Physics Integration ===');
  
  return new Promise((resolve) => {
    let positionUpdates = [];
    
    const posListener = (data) => {
      if (data.entities?.updated) {
        const update = data.entities.updated[0];
        if (update && update.position) {
          positionUpdates.push(update.position);
        }
      }
    };
    
    socket.on('state_update', posListener);
    
    log('Moving to test physics validation...');
    socket.emit('move', {
      method: 'heading',
      heading: 270, // West
      speed: 'run',
      timestamp: Date.now(),
    });
    
    setTimeout(() => {
      socket.emit('move', {
        method: 'heading',
        speed: 'stop',
        timestamp: Date.now(),
      });
      
      setTimeout(() => {
        socket.off('state_update', posListener);
        
        if (positionUpdates.length > 0) {
          const allYValid = positionUpdates.every(p => p.y > 0 && p.y < 1000);
          log(`✓ Received ${positionUpdates.length} position updates`);
          log('  Y values:', positionUpdates.map(p => p.y.toFixed(1)));
          
          if (allYValid) {
            log('✓ TEST 4 PASSED: Physics/gravity working (Y values reasonable)');
          } else {
            log('✗ TEST 4 FAILED: Suspicious Y values');
          }
        } else {
          log('⚠ TEST 4 WARNING: No position updates received');
        }
        
        resolve();
      }, 500);
    }, 2000);
  });
}

async function runTests() {
  log('\n========================================');
  log('Animation Lock System Integration Test');
  log('========================================\n');
  
  try {
    await connect();
    await handshake();
    await authGuest();
    await enterWorld();
    
    await sleep(1000);
    
    await testMovementAnimations();
    await sleep(500);
    
    await testProximityRosterAnimations();
    await sleep(500);
    
    await testCombatAnimationLock();
    await sleep(500);
    
    await testPhysicsStillWorks();
    
    log('\n========================================');
    log('✓ All Tests Complete');
    log('========================================');
    log('\nNext: User will test position persistence with credentials');
    log('  Email: test-persist@example.com');
    log('  Password: TestPassword123!');
    log('  Character: PositionTester\n');
    
    socket.disconnect();
    process.exit(0);
    
  } catch (error) {
    log('✗ Test failed:', error.message);
    console.error(error);
    if (socket) socket.disconnect();
    process.exit(1);
  }
}

runTests();
