/**
 * Quick test of credentials authentication
 */
import io from 'socket.io-client';

const socket = io('http://localhost:3100', { transports: ['websocket'], reconnection: false });

socket.on('connect', () => {
  console.log('✓ Connected');
  
  socket.emit('handshake', {
    protocolVersion: '1.0.0',
    clientType: 'test',
  });
});

socket.on('handshake_ack', () => {
  console.log('✓ Handshake complete');
  console.log('Attempting credentials login...');
  
  socket.emit('auth', {
    method: 'credentials',
    email: 'test-persist@example.com',
    password: 'TestPassword123!',
  });
});

socket.on('auth_success', (data) => {
  console.log('✓ Credentials auth SUCCESS!');
  console.log('  Account ID:', data.accountId.slice(0, 8) + '...');
  console.log('  Characters:', data.characters.length);
  if (data.characters.length > 0) {
    console.log('  → First character:', data.characters[0].name);
  }
  socket.disconnect();
  process.exit(0);
});

socket.on('auth_error', (data) => {
  console.log('✗ Credentials auth FAILED');
  console.log('  Reason:', data.reason);
  console.log('  Message:', data.message);
  socket.disconnect();
  process.exit(1);
});

setTimeout(() => {
  console.log('✗ Timeout');
  socket.disconnect();
  process.exit(1);
}, 5000);
