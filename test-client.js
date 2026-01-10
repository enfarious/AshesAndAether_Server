/**
 * Simple test client for World of Darkness MMO Server
 *
 * This demonstrates the complete handshake and connection flow.
 * Run with: node test-client.js
 */

import io from 'socket.io-client';

const SERVER_URL = 'http://localhost:3100';
const PROTOCOL_VERSION = '1.0.0';

// ANSI color codes for pretty output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logEvent(event, data) {
  log(`\n${'='.repeat(60)}`, 'cyan');
  log(`Event: ${event}`, 'bright');
  log(JSON.stringify(data, null, 2), 'blue');
  log('='.repeat(60), 'cyan');
}

// Connect to server
log('\nConnecting to World of Darkness MMO Server...', 'green');
const socket = io(SERVER_URL, {
  transports: ['websocket'],
});

socket.on('connect', () => {
  log(`✓ Connected! Socket ID: ${socket.id}`, 'green');

  // Step 1: Send handshake
  log('\n>>> Sending handshake...', 'yellow');
  socket.emit('handshake', {
    protocolVersion: PROTOCOL_VERSION,
    clientType: 'text',
    clientVersion: '0.1.0',
    capabilities: {
      graphics: false,
      audio: false,
      input: ['keyboard'],
      maxUpdateRate: 1,
    },
  });
});

// Step 2: Receive handshake acknowledgment
socket.on('handshake_ack', (data) => {
  logEvent('handshake_ack', data);

  if (!data.compatible) {
    log('✗ Protocol version incompatible! Server requires: ' + data.protocolVersion, 'red');
    socket.disconnect();
    return;
  }

  log('✓ Handshake successful!', 'green');

  // Step 3: Authenticate as guest
  log('\n>>> Authenticating as guest...', 'yellow');
  socket.emit('auth', {
    method: 'guest',
    guestName: 'TestWanderer',
  });
});

// Step 4: Handle authentication success
socket.on('auth_success', (data) => {
  logEvent('auth_success', data);
  log('✓ Authentication successful!', 'green');

  // Step 5: Create or select character
  if (data.characters.length > 0) {
    // Select existing character
    const char = data.characters[0];
    log(`\n>>> Selecting character: ${char.name}`, 'yellow');
    socket.emit('character_select', {
      characterId: char.id,
    });
  } else {
    // Create new character
    log('\n>>> Creating new character...', 'yellow');
    socket.emit('character_create', {
      name: 'TestHero',
      appearance: {
        description: 'A mysterious figure shrouded in shadows.',
      },
    });
  }
});

// Step 6: Receive world entry data
socket.on('world_entry', (data) => {
  logEvent('world_entry', data);
  log('✓ Entered world!', 'green');

  // Display the world in text format
  displayWorld(data);

  // Test sequence: move + chat variations
  let actionCount = 0;
  const actions = [
    // Move 1
    () => {
      const newZ = data.character.position.z - 10;
      log(`\n>>> Moving north (1/3)...`, 'yellow');
      socket.emit('move', {
        position: { x: data.character.position.x, y: data.character.position.y, z: newZ },
        heading: 0,
        speed: 'walk',
      });
      data.character.position.z = newZ;
    },
    // Say
    () => {
      log(`\n>>> Saying hello...`, 'yellow');
      socket.emit('chat', {
        channel: 'say',
        message: 'Hello, anyone nearby?',
      });
    },
    // Move 2
    () => {
      const newZ = data.character.position.z - 10;
      log(`\n>>> Moving north (2/3)...`, 'yellow');
      socket.emit('move', {
        position: { x: data.character.position.x, y: data.character.position.y, z: newZ },
        heading: 0,
        speed: 'walk',
      });
      data.character.position.z = newZ;
    },
    // Shout
    () => {
      log(`\n>>> Shouting...`, 'yellow');
      socket.emit('chat', {
        channel: 'shout',
        message: 'Is anyone out there?!',
      });
    },
    // Move 3
    () => {
      const newZ = data.character.position.z - 10;
      log(`\n>>> Moving north (3/3)...`, 'yellow');
      socket.emit('move', {
        position: { x: data.character.position.x, y: data.character.position.y, z: newZ },
        heading: 0,
        speed: 'walk',
      });
      data.character.position.z = newZ;
    },
    // Emote
    () => {
      log(`\n>>> Emoting...`, 'yellow');
      socket.emit('chat', {
        channel: 'emote',
        message: 'looks around cautiously',
      });
    },
    // Call for help
    () => {
      log(`\n>>> Calling for help...`, 'yellow');
      socket.emit('chat', {
        channel: 'cfh',
        message: 'Testing emergency broadcast system!',
      });
    },
  ];

  const actionInterval = setInterval(() => {
    if (actionCount < actions.length) {
      actions[actionCount]();
      actionCount++;
    } else {
      clearInterval(actionInterval);

      // Disconnect after final action
      setTimeout(() => {
        log('\n>>> Disconnecting...', 'yellow');
        socket.disconnect();
      }, 2000);
    }
  }, 2000);
});

// Handle proximity roster updates
socket.on('proximity_roster', (data) => {
  logEvent('proximity_roster', data);
  displayProximityRoster(data);
});

// Handle chat messages
socket.on('chat', (data) => {
  log('\n' + '='.repeat(60), 'yellow');
  log(`[${data.channel.toUpperCase()}] ${data.sender}: ${data.message}`, 'bright');
  log('='.repeat(60), 'yellow');
});

// Handle pong response
socket.on('pong', (data) => {
  const latency = Date.now() - data.clientTimestamp;
  log(`✓ Pong received! Latency: ${latency}ms`, 'green');
});

// Handle errors
socket.on('auth_error', (data) => {
  logEvent('auth_error', data);
  log('✗ Authentication failed: ' + data.message, 'red');
});

socket.on('error', (data) => {
  logEvent('error', data);
  log(`✗ Error [${data.code}]: ${data.message}`, 'red');
});

socket.on('disconnect', (reason) => {
  log(`\nDisconnected: ${reason}`, 'yellow');
  process.exit(0);
});

socket.on('connect_error', (error) => {
  log(`✗ Connection error: ${error.message}`, 'red');
  log('\nMake sure the server is running on ' + SERVER_URL, 'yellow');
  process.exit(1);
});

// Helper function to display world state as text
function displayWorld(worldEntry) {
  log('\n' + '='.repeat(60), 'magenta');
  log('WORLD STATE', 'bright');
  log('='.repeat(60), 'magenta');

  // Character info
  const char = worldEntry.character;
  log(`\nCharacter: ${char.name}`, 'cyan');
  log(`Health: ${char.health.current}/${char.health.max}`, 'green');
  log(`Stamina: ${char.stamina.current}/${char.stamina.max}`, 'green');
  log(`Position: (${char.position.x}, ${char.position.y}, ${char.position.z})`, 'blue');

  // Movement info
  const headingNames = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
  const facingDir = headingNames[char.heading] || `${char.heading}°`;
  const speedText = char.currentSpeed === 'stop' ? 'stationary' : `${char.currentSpeed}ing`;
  log(`Facing: ${facingDir} (${char.heading}°) | Status: ${speedText}`, 'cyan');

  // Zone info
  const zone = worldEntry.zone;
  log(`\nLocation: ${zone.name}`, 'yellow');
  log(`${zone.description}`, 'reset');
  log(`Weather: ${zone.weather} | Time: ${zone.timeOfDay} | Lighting: ${zone.lighting}`, 'blue');

  // Content rating display
  const ratingNames = { T: 'Teen (13+)', M: 'Mature (17+)', AO: 'Adults Only (18+)' };
  const ratingColor = zone.contentRating === 'AO' ? 'red' : zone.contentRating === 'M' ? 'yellow' : 'green';
  log(`Content Rating: ${ratingNames[zone.contentRating] || zone.contentRating}`, ratingColor);

  // Entities
  if (worldEntry.entities.length > 0) {
    log('\nNearby:', 'yellow');
    worldEntry.entities.forEach(entity => {
      const hostile = entity.hostile ? '[HOSTILE]' : '';
      const interactive = entity.interactive ? '[?]' : '';
      log(`  - ${entity.name} ${hostile}${interactive}`, hostile ? 'red' : 'cyan');
      log(`    ${entity.description}`, 'reset');
    });
  }

  // Exits
  if (worldEntry.exits.length > 0) {
    log('\nExits:', 'yellow');
    worldEntry.exits.forEach(exit => {
      log(`  [${exit.direction}] ${exit.name}`, 'green');
      log(`    ${exit.description}`, 'reset');
    });
  }

  log('\n' + '='.repeat(60), 'magenta');
}

// Helper function to display proximity roster
function displayProximityRoster(roster) {
  log('\n' + '='.repeat(60), 'cyan');
  log('PROXIMITY ROSTER', 'bright');
  log('='.repeat(60), 'cyan');

  // Danger state
  if (roster.dangerState) {
    log('\n⚔️  COMBAT MODE ⚔️', 'red');
  }

  // Display each channel
  const channels = [
    { name: 'Touch', key: 'touch', range: '5ft', color: 'magenta' },
    { name: 'Say', key: 'say', range: '20ft', color: 'cyan' },
    { name: 'Shout', key: 'shout', range: '150ft', color: 'yellow' },
    { name: 'Emote', key: 'emote', range: '150ft', color: 'blue' },
    { name: 'See', key: 'see', range: '150ft', color: 'green' },
    { name: 'Hear', key: 'hear', range: '150ft', color: 'blue' },
    { name: 'CFH', key: 'cfh', range: '250ft', color: 'yellow' },
  ];

  channels.forEach(channel => {
    const data = roster.channels[channel.key];
    if (!data) return;

    log(`\n${channel.name} (${channel.range}):`, channel.color);

    if (data.count === 0) {
      log('  No one nearby', 'reset');
    } else if (data.sample) {
      // Show individual names (1-3 people)
      data.sample.forEach(name => {
        const isLastSpeaker = data.lastSpeaker === name;
        const marker = isLastSpeaker ? ' [Last Speaker]' : '';
        log(`  - ${name}${marker}`, isLastSpeaker ? 'bright' : 'cyan');
      });
    } else {
      // Show crowd count (4+ people)
      log(`  ${data.count} people (crowd mode)`, 'yellow');
    }
  });

  log('\n' + '='.repeat(60), 'cyan');
}
