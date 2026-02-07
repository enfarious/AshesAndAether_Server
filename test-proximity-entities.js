/* eslint-env node */
/* global process, console, setTimeout */
/**
 * Test proximity roster deltas for player, NPC (companion), and mob entities.
 * Run with: node test-proximity-entities.js
 */

import io from 'socket.io-client';

const SERVER_URL = 'http://localhost:3100';
const PROTOCOL_VERSION = '1.0.0';

const PRIMARY_EMAIL = process.env.TEST_EMAIL || 'test-persist@example.com';
const PRIMARY_PASSWORD = process.env.TEST_PASSWORD || 'TestPassword123!';
const PRIMARY_CHARACTER_NAME = process.env.TEST_CHARACTER_NAME || 'PositionTester';

const results = {
  player: false,
  companion: false,
  mob: false,
};

let primaryPosition = null;
let primarySocket = null;
let secondarySocket = null;
let done = false;

function log(message) {
  console.log(message);
}

function markType(entityType) {
  if (entityType === 'player') results.player = true;
  if (entityType === 'companion') results.companion = true;
  if (entityType === 'mob') results.mob = true;
}

function extractTypesFromDelta(delta) {
  if (!delta || !delta.channels) return;
  for (const channel of Object.values(delta.channels)) {
    if (!channel?.added) continue;
    for (const entity of channel.added) {
      if (entity?.type) {
        markType(entity.type);
      }
    }
  }
}

function finish(exitCode) {
  if (done) return;
  done = true;
  log('\n=== Proximity Entity Test Results ===');
  log(`player:   ${results.player ? 'OK' : 'MISSING'}`);
  log(`npc:      ${results.companion ? 'OK' : 'MISSING'} (companion)`);
  log(`mob:      ${results.mob ? 'OK' : 'MISSING'}`);
  if (primarySocket) primarySocket.disconnect();
  if (secondarySocket) secondarySocket.disconnect();
  setTimeout(() => process.exit(exitCode), 200);
}

function startSecondaryClient() {
  secondarySocket = io(SERVER_URL, { transports: ['websocket'] });

  secondarySocket.on('connect', () => {
    secondarySocket.emit('handshake', {
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

  secondarySocket.on('handshake_ack', (data) => {
    if (!data.compatible) {
      log('Secondary handshake incompatible');
      return finish(1);
    }
    secondarySocket.emit('auth', {
      method: 'guest',
      guestName: 'ProximityBuddy',
    });
  });

  secondarySocket.on('auth_success', (data) => {
    if (data.characters.length > 0) {
      secondarySocket.emit('character_select', { characterId: data.characters[0].id });
    } else {
      secondarySocket.emit('character_create', {
        name: 'ProximityBuddy',
        appearance: { description: 'Test character for proximity.' },
      });
    }
  });

  secondarySocket.on('world_entry', () => {
    if (!primaryPosition) return;
    secondarySocket.emit('move', {
      position: {
        x: primaryPosition.x + 1.5,
        y: primaryPosition.y,
        z: primaryPosition.z + 1.5,
      },
      heading: 0,
      speed: 'walk',
    });
  });
}

function startPrimaryClient() {
  primarySocket = io(SERVER_URL, { transports: ['websocket'] });

  primarySocket.on('connect', () => {
    primarySocket.emit('handshake', {
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

  primarySocket.on('handshake_ack', (data) => {
    if (!data.compatible) {
      log('Primary handshake incompatible');
      return finish(1);
    }
    primarySocket.emit('auth', {
      method: 'credentials',
      email: PRIMARY_EMAIL,
      password: PRIMARY_PASSWORD,
    });
  });

  primarySocket.on('auth_success', (data) => {
    if (data.characters.length > 0) {
      const match = data.characters.find((c) => c.name === PRIMARY_CHARACTER_NAME) || data.characters[0];
      primarySocket.emit('character_select', { characterId: match.id });
    } else {
      primarySocket.emit('character_create', {
        name: PRIMARY_CHARACTER_NAME,
        appearance: { description: 'Primary test character.' },
      });
    }
  });

  primarySocket.on('world_entry', (data) => {
    primaryPosition = data.character.position;
    startSecondaryClient();
  });

  primarySocket.on('proximity_roster_delta', (data) => {
    extractTypesFromDelta(data);
    if (results.player && results.companion && results.mob) {
      finish(0);
    }
  });
}

startPrimaryClient();

setTimeout(() => {
  if (results.player && results.companion && results.mob) {
    finish(0);
  } else {
    finish(1);
  }
}, 12000);
