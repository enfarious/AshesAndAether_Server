# Quick Start Guide - Ashes & Aether MMO Server

## Getting Your Server Running

### 1. Install Dependencies

Already done! Your dependencies are installed.

### 2. Configure Environment

The `.env` file has been created from `.env.example`. You can run the server without a database for now (it uses mock data).

### 3. Start the Server

```bash
npm run dev
```

The server will start on:
- **HTTP API**: http://localhost:3000
- **WebSocket**: ws://localhost:3000/socket.io/

You should see:
```
Starting Ashes & Aether MMO Server...
HTTP server listening on port 3000
WebSocket server initialized
World initialized with 1 zones
Game loop started at 10 ticks per second
Game server fully initialized
```

### 4. Test the Connection

In a separate terminal, run the test client:

```bash
node test-client.js
```

This will:
1. Connect to the server
2. Perform handshake
3. Authenticate as a guest
4. Create a character
5. Receive world entry data
6. Display the world state in text format
7. Send a ping
8. Disconnect

## What's Implemented

### Server Features
- ✅ WebSocket connection handling
- ✅ Full handshake protocol
- ✅ Guest authentication (no database needed)
- ✅ Character creation (mock data)
- ✅ World entry with mock zone data
- ✅ Ping/pong for connection health
- ✅ Type-safe protocol messages
- ✅ Structured logging

### Mock Data
The server currently uses mock data for:
- Authentication (guests only)
- Characters
- World zones ("The Crossroads")
- NPCs (Old Merchant)
- Exits (north, south, east)

### Not Yet Implemented
- ❌ Database integration (Prisma)
- ❌ Real character data
- ❌ Movement handling
- ❌ Chat system
- ❌ Combat system
- ❌ Entity updates
- ❌ Credential/token authentication

## For Your Client Developer

### Connection Flow

1. **Connect via WebSocket**
   ```javascript
   const socket = io('http://localhost:3000');
   ```

2. **Send Handshake**
   ```javascript
   socket.emit('handshake', {
     protocolVersion: '1.0.0',
     clientType: 'text',
     clientVersion: '0.1.0',
     capabilities: {
       graphics: false,
       audio: false,
       input: ['keyboard'],
       maxUpdateRate: 1
     }
   });
   ```

3. **Wait for Handshake ACK**
   ```javascript
   socket.on('handshake_ack', (data) => {
     if (!data.compatible) {
       // Handle version mismatch
     }
     // Proceed to authentication
   });
   ```

4. **Authenticate**
   ```javascript
   socket.emit('auth', {
     method: 'guest',
     guestName: 'PlayerName'
   });
   ```

5. **Handle Auth Success**
   ```javascript
   socket.on('auth_success', (data) => {
     // data.characters contains available characters
     // data.canCreateCharacter indicates if can create new
   });
   ```

6. **Create or Select Character**
   ```javascript
   // Create new:
   socket.emit('character_create', {
     name: 'HeroName',
     appearance: { description: '...' }
   });

   // Or select existing:
   socket.emit('character_select', {
     characterId: 'char-id'
   });
   ```

7. **Receive World Entry**
   ```javascript
   socket.on('world_entry', (data) => {
     // data.character - Your character state
     // data.zone - Current location
     // data.entities - Nearby NPCs/players/objects
     // data.exits - Available exits
   });
   ```

### Key Files to Reference

- **`PROTOCOL.md`** - Complete protocol specification
- **`src/network/protocol/types.ts`** - TypeScript type definitions for all messages
- **`test-client.js`** - Working example client

### Testing Tools

The test client (`test-client.js`) shows the complete flow. Your client developer can:
1. Run it to see expected message formats
2. Use it as a reference implementation
3. Modify it to test specific scenarios

## Troubleshooting

### Server won't start
- Check if port 3000 is already in use
- Look at the error logs
- Make sure all dependencies are installed (`npm install`)

### Test client can't connect
- Make sure server is running (`npm run dev`)
- Check firewall settings
- Verify server is on port 3000

### Connection drops immediately
- Check protocol version matches (1.0.0)
- Ensure handshake is sent first
- Look at server logs for errors

## Next Steps

1. **Test the current implementation** with your client
2. **Implement actual movement** - when client sends `move` events
3. **Add chat system** - handle `chat` events and broadcast to nearby players
4. **Set up database** - replace mock data with real Prisma models
5. **Implement state updates** - broadcast entity changes to clients

## Useful Commands

```bash
# Start development server (auto-reload)
npm run dev

# Build TypeScript
npm run build

# Start production server
npm start

# Run test client
node test-client.js

# Check for TypeScript errors
npm run build
```

## Need Help?

- See `PROTOCOL.md` for detailed message specifications
- Check `ARCHITECTURE.md` for system design
- Review `src/network/ClientSession.ts` for server-side message handling
- Look at `test-client.js` for client-side examples
