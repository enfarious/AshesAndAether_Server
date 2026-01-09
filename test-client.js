/**
 * Simple test client for World of Darkness MMO Server
 *
 * This demonstrates the complete handshake and connection flow.
 * Run with: node test-client.js
 */

const io = require('socket.io-client');

const SERVER_URL = 'http://localhost:3000';
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

  // Send a test ping after 2 seconds
  setTimeout(() => {
    log('\n>>> Sending ping...', 'yellow');
    socket.emit('ping', { timestamp: Date.now() });
  }, 2000);

  // Disconnect after 5 seconds
  setTimeout(() => {
    log('\n>>> Disconnecting...', 'yellow');
    socket.disconnect();
  }, 5000);
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
