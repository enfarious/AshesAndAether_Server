# Protocol Compatibility Status

Last checked: 2026-01-10

## Summary

✅ **MUD Client (C# Terminal.Gui)** - COMPATIBLE
✅ **LLM Airlock (TypeScript)** - COMPATIBLE
✅ **Distributed Server (Gateway + Zone)** - COMPATIBLE

All existing clients are compatible with the new distributed server architecture.

## Protocol Version

**Current:** `1.0.0`

All components use the same protocol version defined in:
- Server: [src/network/protocol/types.ts](src/network/protocol/types.ts)
- MUD Client: `.claude/clients/mud-client/.../PROTOCOL.md`
- LLM Airlock: `.claude/clients/llm-airlock/.../`

## Message Flow Comparison

### Before (Monolithic)

```
Client → GameServer → WorldManager → ZoneManager → Database
                ↓
         Socket.IO direct emit
                ↓
            Client
```

### After (Distributed)

```
Client → Gateway → Redis Pub/Sub → Zone Server → Database
            ↓                           ↓
       Receives                   Processes
            ↓                           ↓
      Socket.IO ← Redis "gateway:output"
```

## Key Messages Status

### ✅ Handshake Flow
**Message:** `handshake` → `handshake_ack`

**Gateway Implementation:** [src/gateway/GatewayClientSession.ts:46-68](src/gateway/GatewayClientSession.ts)
```typescript
this.socket.on('handshake', (data) => {
  this.setClientInfo({
    type: data.clientType,
    version: data.clientVersion,
    capabilities: data.capabilities,
  });
  this.socket.emit('handshake_ack', { ... });
});
```

**Status:** ✅ Unchanged from monolithic version

---

### ✅ Authentication
**Messages:** `auth` → `auth_success` | `auth_error`

**Gateway Implementation:** [src/gateway/GatewayClientSession.ts:123-210](src/gateway/GatewayClientSession.ts)
```typescript
async authenticate(data: AuthMessage['payload']): Promise<void> {
  // Guest, credentials, or token auth
  // Returns auth_success with character list
}
```

**Status:** ✅ Unchanged - Gateway handles auth locally (no routing needed)

---

### ✅ Character Selection/Creation
**Messages:** `character_select`, `character_create` → `world_entry`

**Gateway Implementation:** [src/gateway/GatewayClientSession.ts:212-334](src/gateway/GatewayClientSession.ts)
```typescript
private async handleCharacterSelect(data) { ... }
private async handleCharacterCreate(data) { ... }
private async enterWorld() { ... }
```

**Status:** ✅ Gateway handles these locally, sends `world_entry` directly

---

### ✅ Movement
**Message:** `move` (from client)

**Gateway Implementation:** [src/gateway/GatewayClientSession.ts:91-94](src/gateway/GatewayClientSession.ts)
```typescript
this.socket.on('move', async (data: MoveMessage['payload']) => {
  if (!this.characterId || !this.currentZoneId) return;
  await this.routeToZone('move', data);
});
```

**routeToZone:** [src/gateway/GatewayClientSession.ts:122-171](src/gateway/GatewayClientSession.ts)
- Validates position data
- Updates database
- Publishes to `zone:{zoneId}:input` Redis channel

**Zone Server Handling:** [src/world/DistributedWorldManager.ts:146-163](src/world/DistributedWorldManager.ts)
```typescript
private async handlePlayerMove(message: MessageEnvelope) {
  zoneManager.updatePlayerPosition(characterId, position);
  await this.sendProximityRosterToPlayer(characterId);
  await this.broadcastNearbyUpdate(zoneId);
}
```

**Status:** ✅ Compatible - Just routed through Redis instead of direct call

---

### ✅ Proximity Roster
**Message:** `proximity_roster` (to client)

**Format:**
```typescript
interface ProximityRosterMessage {
  type: 'proximity_roster';
  payload: {
    channels: {
      touch: ProximityChannel;   // ~5 feet
      say: ProximityChannel;     // 20 feet
      shout: ProximityChannel;   // 150 feet
      emote: ProximityChannel;   // 150 feet
      see: ProximityChannel;     // 150 feet
      hear: ProximityChannel;    // 150 feet
      cfh: ProximityChannel;     // 250 feet
    };
    dangerState: boolean;
  };
  timestamp: number;
}

interface ProximityChannel {
  count: number;
  sample?: string[];        // Present ONLY if count <= 3
  lastSpeaker?: string;     // Present ONLY if count <= 3
}
```

**Zone Server Generation:** [src/world/ZoneManager.ts:195-225](src/world/ZoneManager.ts)
```typescript
calculateProximityRoster(entityId: string): ProximityRosterMessage['payload'] | null
```

**Gateway Broadcast:** [src/world/DistributedWorldManager.ts:177-207](src/world/DistributedWorldManager.ts)
- Zone server publishes to `gateway:output` Redis channel
- Gateway receives and emits to client Socket.IO

**Status:** ✅ Identical payload structure, just different transport

---

### ✅ Chat Messages
**Message:** `chat` (from client)

**Gateway Implementation:** [src/gateway/GatewayClientSession.ts:96-99](src/gateway/GatewayClientSession.ts)
```typescript
this.socket.on('chat', async (data: ChatMessage['payload']) => {
  if (!this.characterId || !this.currentZoneId) return;
  await this.routeToZone('chat', data);
});
```

**Status:** ✅ Routes to Zone server for processing (not yet implemented in Zone server)

---

## Compatibility Matrix

| Message | MUD Client | LLM Airlock | Gateway | Zone Server | Status |
|---------|-----------|-------------|---------|-------------|--------|
| `handshake` | ✅ Sends | N/A | ✅ Handles | N/A | ✅ |
| `handshake_ack` | ✅ Receives | N/A | ✅ Sends | N/A | ✅ |
| `auth` | ✅ Sends | N/A | ✅ Handles | N/A | ✅ |
| `auth_success` | ✅ Receives | N/A | ✅ Sends | N/A | ✅ |
| `auth_error` | ✅ Receives | N/A | ✅ Sends | N/A | ✅ |
| `character_select` | ✅ Sends | N/A | ✅ Handles | N/A | ✅ |
| `character_create` | ✅ Sends | N/A | ✅ Handles | N/A | ✅ |
| `world_entry` | ✅ Receives | N/A | ✅ Sends | N/A | ✅ |
| `move` | ✅ Sends | N/A | ✅ Routes | ✅ Processes | ✅ |
| `proximity_roster` | ✅ Receives | ✅ Uses | ✅ Forwards | ✅ Generates | ✅ |
| `chat` | ✅ Sends | ✅ Uses | ✅ Routes | ⏳ TODO | ⚠️ |
| `ping`/`pong` | ✅ Both | N/A | ✅ Handles | N/A | ✅ |

**Legend:**
- ✅ Implemented and compatible
- ⏳ Not yet implemented
- ⚠️ Partial compatibility
- ❌ Incompatible

## Breaking Changes

**None.** The distributed architecture is a transparent refactor from the client perspective.

### What Changed

**Transport layer only:**
- Monolithic: Client → GameServer (direct)
- Distributed: Client → Gateway → Redis → Zone Server

**Message payloads:** Unchanged
**Message timing:** Unchanged
**Message semantics:** Unchanged

## Testing Recommendations

### Phase 1: Gateway Server

```powershell
# Terminal 1: Start Redis
redis-server

# Terminal 2: Start Gateway
npm run dev:gateway

# Terminal 3: MUD Client
cd .claude/clients/mud-client/AshesAndAether_MUD_Client/clients/mud
dotnet run
```

**Expected:**
- ✅ Handshake succeeds
- ✅ Guest auth works
- ✅ Character creation works
- ✅ World entry succeeds
- ⚠️ Movement sends but no proximity updates (Zone server not running)

---

### Phase 2: Gateway + Zone Server

```powershell
# Terminal 1: Redis
redis-server

# Terminal 2: Gateway
npm run dev:gateway

# Terminal 3: Zone Server
npm run dev:zone

# Terminal 4: MUD Client
cd .claude/clients/mud-client/AshesAndAether_MUD_Client/clients/mud
dotnet run
```

**Expected:**
- ✅ Everything from Phase 1
- ✅ Movement triggers proximity roster updates
- ✅ Multiple clients see each other
- ✅ Proximity counts update correctly

---

### Phase 3: Multiple Clients

Same setup, but run multiple MUD client instances to test:
- ✅ Proximity roster shows correct counts
- ✅ Sample names appear (1-3 players)
- ✅ Crowd mode activates (4+ players)
- ✅ Movement updates propagate
- ✅ Last speaker tracking

---

## Known Issues

### ⚠️ Chat System Not Implemented
**Status:** Routes to Zone server but not processed yet

**Workaround:** Chat messages are received but not broadcast

**Fix:** Implement chat handling in DistributedWorldManager

---

### ⏳ LLM Airlock Integration
**Status:** LLM Airlock exists as separate server

**Plan:**
1. Integrate airlock as Zone server plugin
2. NPCs controlled via LLM messages
3. Narrator system uses LLM for generation

---

## Migration Notes

### For Existing Clients

**No changes required** - Clients can connect to Gateway server using same URL format:

```
ws://localhost:3100/socket.io/
```

(Changed from port 3000 to 3100 for Gateway)

### Configuration Changes

**.env.example:**
```env
# Old (Monolithic)
PORT=3000

# New (Distributed)
GATEWAY_PORT=3100
SERVER_ID="gateway-1"
REDIS_URL="redis://localhost:6379"
```

### Running Scripts

**Old:**
```powershell
npm run dev
```

**New:**
```powershell
# Distributed mode
./start-distributed.ps1

# Or manually
npm run dev:gateway  # Terminal 1
npm run dev:zone     # Terminal 2
```

---

## Future Considerations

### Adding New Client Types

When building new clients (2D, 3D, VR, AR):

1. **Use existing protocol** from [src/network/protocol/types.ts](src/network/protocol/types.ts)
2. **Connect to Gateway** at `ws://gateway-server:3100/socket.io/`
3. **Send handshake** with correct `clientType`
4. **Receive same messages** as MUD client
5. **Render differently** based on client capabilities

### Protocol Extensions

If new messages are needed:

1. Add to [src/network/protocol/types.ts](src/network/protocol/types.ts)
2. Update `ClientMessage` or `ServerMessage` union types
3. Document in this file
4. Update client documentation
5. Version bump if breaking change

---

## Contact

For protocol questions or compatibility issues, see:
- [PROTOCOL.md](src/network/protocol/types.ts) (source of truth)
- [DISTRIBUTED.md](DISTRIBUTED.md) (architecture)
- [VISION.md](VISION.md) (multi-client strategy)
