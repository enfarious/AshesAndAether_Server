/* eslint-env node */
/* global process, console, setTimeout, clearTimeout */

import io from 'socket.io-client';

const SERVER_URL = 'http://localhost:3100';
const PROTOCOL_VERSION = '1.0.0';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

const socket = io(SERVER_URL, { transports: ['websocket'] });

let characterId = null;
let currentPosition = null;
let stateUpdateCount = 0;
let testsStarted = false;

function waitForStateUpdate(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('state_update', onUpdate);
      reject(new Error('Timed out waiting for state_update'));
    }, timeoutMs);

    const onUpdate = (data) => {
      if (data?.entities?.updated) {
        const selfUpdate = data.entities.updated.find((e) => e.id === characterId);
        if (selfUpdate) {
          clearTimeout(timeout);
          socket.off('state_update', onUpdate);
          resolve(selfUpdate.position);
        }
      }
    };

    socket.on('state_update', onUpdate);
  });
}

function waitForMovementComplete(expectedReason, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('event', onEvent);
      reject(new Error('Timed out waiting for movement_complete'));
    }, timeoutMs);

    const onEvent = (data) => {
      if (data?.eventType === 'movement_complete') {
        if (!expectedReason || data.reason === expectedReason) {
          clearTimeout(timeout);
          socket.off('event', onEvent);
          resolve(data);
        }
      }
    };

    socket.on('event', onEvent);
  });
}

async function runTests() {
  log('\n=== Navmesh Movement Test Suite ===', 'bright');

  // Test 1: Fall to ground (physics adjusts)
  log('\nTEST 1: Fall to ground', 'yellow');
  const startY = currentPosition.y;
  const fallUpdate = waitForStateUpdate(4000);
  socket.emit('move', {
    method: 'position',
    position: {
      x: currentPosition.x,
      y: currentPosition.y - 100,
      z: currentPosition.z,
    },
  });
  await fallUpdate;
  if (currentPosition.y < startY - 50) {
    throw new Error(`Fall test failed. y=${currentPosition.y.toFixed(2)} start=${startY.toFixed(2)}`);
  }
  const groundY = currentPosition.y;
  log(`✅ Fall adjusted to y=${currentPosition.y.toFixed(2)}`, 'green');

  // Test 1b: Walk downward into ground (should not go below ground)
  log('\nTEST 1b: Walk downward through ground (blocked/adjusted)', 'yellow');
  const downwardUpdate = waitForStateUpdate(4000);
  socket.emit('command', `/move to:${currentPosition.x.toFixed(1)},${(groundY - 50).toFixed(1)},${currentPosition.z.toFixed(1)}`);
  await downwardUpdate;
  if (currentPosition.y < groundY - 1) {
    throw new Error(`Downward move penetrated ground. y=${currentPosition.y.toFixed(2)} ground=${groundY.toFixed(2)}`);
  }
  socket.emit('command', '/stop');
  await waitForMovementComplete('command', 8000);
  log('✅ Downward movement blocked/adjusted above ground', 'green');

  // Test 2: Navmesh move to position (uses /move command)
  log('\nTEST 2: Navmesh /move to:<x,z> then stop', 'yellow');
  const target = {
    x: currentPosition.x + 25,
    z: currentPosition.z + 10,
  };
  const updatesBefore = stateUpdateCount;
  const moveUpdate = waitForStateUpdate(5000);
  socket.emit('command', `/move to:${target.x.toFixed(1)},${target.z.toFixed(1)}`);

  await moveUpdate;
  await new Promise((resolve) => setTimeout(resolve, 1500));

  if (stateUpdateCount <= updatesBefore) {
    throw new Error('No state_update received during navmesh move');
  }

  socket.emit('command', '/stop');
  await waitForMovementComplete('command', 8000);
  log('✅ Navmesh move emitted state_update and movement_complete', 'green');

  // Test 3: Move and stop
  log('\nTEST 3: Move distance and stop (target reached)', 'yellow');
  const updatesBeforeStop = stateUpdateCount;
  socket.emit('command', '/move north 8m');

  await waitForMovementComplete('distance_reached', 12000);

  if (stateUpdateCount <= updatesBeforeStop) {
    throw new Error('No state_update received during stop test');
  }
  log('✅ Distance move emitted movement_complete and state_update', 'green');

  // Test 4: Path too long should be rejected
  log('\nTEST 4: Path too long rejected', 'yellow');
  const farTarget = {
    x: currentPosition.x + 2000,
    z: currentPosition.z + 2000,
  };

  const rejection = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('command_response', onResponse);
      reject(new Error('Timed out waiting for command_response'));
    }, 5000);

    const onResponse = (data) => {
      if (data?.success === false) {
        clearTimeout(timeout);
        socket.off('command_response', onResponse);
        resolve(data);
      }
    };

    socket.on('command_response', onResponse);
    socket.emit('command', `/move to:${farTarget.x.toFixed(1)},${farTarget.z.toFixed(1)}`);
  });

  if (!rejection) {
    throw new Error('Expected move rejection for long path');
  }
  log('✅ Long path rejected as expected', 'green');

  log('\nAll navmesh movement tests passed.', 'bright');
  socket.disconnect();
  process.exit(0);
}

socket.on('connect', () => {
  log('✓ Connected', 'green');
  socket.emit('handshake', {
    protocolVersion: PROTOCOL_VERSION,
    clientType: 'navmesh-test',
    clientVersion: '0.1.0',
    capabilities: { graphics: false, audio: false, input: ['keyboard'], maxUpdateRate: 1 },
  });
});

socket.on('handshake_ack', (data) => {
  if (!data.compatible) {
    log('✗ Protocol incompatible', 'red');
    socket.disconnect();
    return;
  }

  socket.emit('auth', { method: 'guest', guestName: 'NavmeshTester' });
});

socket.on('auth_success', (data) => {
  if (data.characters.length > 0) {
    socket.emit('character_select', { characterId: data.characters[0].id });
  } else {
    socket.emit('character_create', {
      name: 'NavmeshTester',
      appearance: { description: 'Navmesh test entity.' },
    });
  }
});

socket.on('world_entry', (data) => {
  if (testsStarted) {
    return;
  }
  characterId = data.character.id;
  currentPosition = { ...data.character.position };
  log(`✓ Entered world at (${currentPosition.x.toFixed(1)}, ${currentPosition.y.toFixed(1)}, ${currentPosition.z.toFixed(1)})`, 'green');

  if (!currentPosition) {
    throw new Error('No character position on world_entry');
  }

  testsStarted = true;
  setTimeout(() => {
    runTests().catch((error) => {
      log(`\n❌ Test failure: ${error.message}`, 'red');
      socket.disconnect();
      process.exit(1);
    });
  }, 1000);
});

socket.on('state_update', (data) => {
  if (data?.entities?.updated) {
    for (const entity of data.entities.updated) {
      if (entity.id === characterId) {
        currentPosition = { ...entity.position };
        stateUpdateCount += 1;
      }
    }
  }
});

socket.on('command_response', (data) => {
  if (!data?.success) {
    log(`Command failed: ${data.error || 'unknown error'}`, 'red');
  }
});

socket.on('disconnect', () => {
  log('Disconnected', 'yellow');
});
