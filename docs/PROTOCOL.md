# Client-Server Protocol - Ashes & Aether MMO

## Overview

The protocol is designed to be **client-agnostic**, meaning the same message structures work for text, 2D, 3D, and VR clients. Clients receive rich semantic data and render it according to their capabilities.

**Transport**: WebSocket (Socket.io) for real-time bidirectional communication

**Format**: JSON messages with consistent structure

**Philosophy**: Server is the source of truth. Clients are thin presentation layers.

---

## Connection Flow

### 1. Initial Connection

Client connects to WebSocket server:

```
ws://server:port/socket.io/
```

**Server Response**: Socket.io connection established, socket ID assigned.

---

### 2. Handshake Sequence

#### Step 1: Client ΓåÆ Server: Version Check & Capabilities

```json
{
  "type": "handshake",
  "payload": {
    "protocolVersion": "1.0.0",
    "clientType": "text",  // "text" | "2d" | "3d" | "vr"
    "clientVersion": "0.1.0",
    "capabilities": {
      "graphics": false,
      "audio": false,
      "input": ["keyboard"],
      "maxUpdateRate": 1  // Updates per second client can handle
    }
  }
}
```

**Client Types**:
- `text`: MUD-style text client (low bandwidth, narrative descriptions)
- `2d`: 2D graphical client (sprite positions, visual effects)
- `3d`: 3D client (full 3D coordinates, models, animations)
- `vr`: VR client (same as 3D but with additional VR-specific data)

#### Step 2: Server ΓåÆ Client: Handshake Acknowledgment

```json
{
  "type": "handshake_ack",
  "payload": {
    "protocolVersion": "1.0.0",
    "serverVersion": "0.1.0",
    "compatible": true,
    "sessionId": "unique-session-id",
    "timestamp": 1234567890,
    "requiresAuth": true
  }
}
```

If `compatible: false`, the connection will be closed with a reason.

---

### 3. Authentication

#### Step 3a: Guest Login (No Account)

For testing or demo purposes:

```json
{
  "type": "auth",
  "payload": {
    "method": "guest",
    "guestName": "Wanderer"  // Optional display name
  }
}
```

#### Step 3b: Account Login (With Credentials)

```json
{
  "type": "auth",
  "payload": {
    "method": "credentials",
    "username": "player@example.com",
    "password": "hashed_or_encrypted"  // Use proper encryption in production
  }
}
```

#### Step 3c: Token Login (Existing Session)

```json
{
  "type": "auth",
  "payload": {
    "method": "token",
    "token": "jwt_token_here"
  }
}
```

---

### 4. Authentication Response

#### Success:

```json
{
  "type": "auth_success",
  "payload": {
    "accountId": "account-uuid",
    "token": "jwt_refresh_token",  // For future logins
    "characters": [
      {
        "id": "char-uuid-1",
        "name": "Shadowblade",
        "level": 5,
        "lastPlayed": 1234567890,
        "location": "The Crossroads"
      },
      {
        "id": "char-uuid-2",
        "name": "Elara",
        "level": 3,
        "lastPlayed": 1234567000,
        "location": "Moonlit Grove"
      }
    ],
    "canCreateCharacter": true,
    "maxCharacters": 5
  }
}
```

#### Failure:

```json
{
  "type": "auth_error",
  "payload": {
    "reason": "invalid_credentials",  // or "account_locked", "server_error", etc.
    "message": "Invalid username or password.",
    "canRetry": true
  }
}
```

---

### 5. Character Selection

Client selects or creates a character:

#### Select Existing Character:

```json
{
  "type": "character_select",
  "payload": {
    "characterId": "char-uuid-1"
  }
}
```

#### Create New Character:

```json
{
  "type": "character_create",
  "payload": {
    "name": "Nightshade",
    "appearance": {
      "description": "A tall figure shrouded in midnight blue robes..."
    }
    // Additional character creation data
  }
}
```

---

### 6. Enter World

#### Server ΓåÆ Client: World Entry

Once character is selected/created, server sends the initial world state:

```json
{
  "type": "world_entry",
  "payload": {
    "characterId": "char-uuid-1",
    "timestamp": 1234567890,

    // Character state
    "character": {
      "id": "char-uuid-1",
      "name": "Shadowblade",
      "position": { "x": 100.5, "y": 0, "z": 250.3 },
      "rotation": { "x": 0, "y": 45, "z": 0 },
      "health": { "current": 80, "max": 100 },
      "stamina": { "current": 95, "max": 100 },
      "stats": {
        "strength": 12,
        "agility": 16,
        "intelligence": 10
        // ... other stats
      }
    },

    // Current location
    "zone": {
      "id": "USA_NY_Stephentown",
      "name": "The Crossroads",
      "description": "A weathered crossroads where five ancient paths converge. Moss-covered stones mark each direction, their inscriptions long faded. A sense of anticipation hangs in the air.",
      "weather": "clear",
      "timeOfDay": "dusk",
      "lighting": "dim",
      "contentRating": "T"  // T (Teen 13+), M (Mature 17+), AO (Adults Only 18+)
    },

    // Nearby entities (players, NPCs, objects)
    "entities": [
      {
        "id": "entity-npc-1",
        "type": "npc",
        "name": "Old Merchant",
        "position": { "x": 102.0, "y": 0, "z": 248.0 },
        "description": "A weathered merchant with kind eyes, tending a small cart.",
        "interactive": true
      },
      {
        "id": "entity-player-2",
        "type": "player",
        "name": "Elara",
        "position": { "x": 98.0, "y": 0, "z": 252.0 },
        "description": "A mysterious figure clad in forest-green leathers."
      }
    ],

    // Available exits/paths
    "exits": [
      { "direction": "north", "name": "Forest Path", "description": "A dark trail leading into dense woods." },
      { "direction": "south", "name": "King's Road", "description": "A well-maintained road toward civilization." },
      { "direction": "east", "name": "Mountain Pass", "description": "A steep rocky path ascending into the peaks." }
    ]
  }
}
```

---

## Ongoing Communication

### Server ΓåÆ Client: State Updates

The server sends periodic updates about world changes:

```json
{
  "type": "state_update",
  "payload": {
    "timestamp": 1234567891,

    // Entity updates (added, moved, removed)
    "entities": {
      "updated": [
        {
          "id": "entity-player-2",
          "position": { "x": 99.0, "y": 0, "z": 251.0 },
          "animation": "walking"  // For graphical clients
        }
      ],
      "added": [
        {
          "id": "entity-wolf-1",
          "type": "wildlife",
          "name": "Grey Wolf",
          "position": { "x": 110.0, "y": 0, "z": 240.0 },
          "description": "A lean wolf with silver-grey fur, watching warily.",
          "hostile": true
        }
      ],
      "removed": ["entity-npc-1"]  // Entity IDs that left the area
    },

    // Character state changes
    "character": {
      "health": { "current": 78, "max": 100 },  // Only changed values
      "effects": [
        { "id": "buff-speed", "name": "Swift Stride", "duration": 30 }
      ]
    },

    // Zone changes (weather, time, etc.)
    "zone": {
      "timeOfDay": "night",
      "lighting": "dark"
    }
  }
}
```

**Update Rate**: Adaptive based on client `maxUpdateRate` capability and current activity.
- Text clients: 0.5-1 update/sec (500-1000ms)
- 2D/3D clients: 10-20 updates/sec (50-100ms)
- During combat: Higher rate for all clients

---

### Client ΓåÆ Server: Player Actions

#### Movement:

The server uses a unified 3D movement system with heading (0-360┬░). See [MOVEMENT_SYSTEM.md](docs/MOVEMENT_SYSTEM.md) for complete details.

**Method 1: Heading (Universal)**
```json
{
  "type": "move",
  "payload": {
    "method": "heading",
    "speed": "jog",        // "walk" | "jog" | "run" | "stop"
    "heading": 45,         // 0-360 degrees (0=north, optional: uses current if omitted)
    "timestamp": 1234567890
  }
}
```

**Method 2: Compass (Text Clients)**
```json
{
  "type": "move",
  "payload": {
    "method": "compass",
    "speed": "walk",
    "compass": "NE",       // "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW"
    "timestamp": 1234567890
  }
}
```

**Method 3: Position (3D/VR Clients)**
```json
{
  "type": "move",
  "payload": {
    "method": "position",
    "position": { "x": 105, "y": 0, "z": 245 },
    "timestamp": 1234567890
  }
}
```

**Text Command Format:** `Speed.Direction`
- Examples: `Walk.N`, `Jog.NE`, `Run.045`, `Stop`
- Perfect for LLM integration

#### Chat/Communication:

```json
{
  "type": "chat",
  "payload": {
    "channel": "say",  // "say", "yell", "whisper", "party", "world"
    "message": "Hello, traveler!",
    "target": "entity-player-2",  // For whispers
    "timestamp": 1234567890
  }
}
```

#### Interaction:

```json
{
  "type": "interact",
  "payload": {
    "targetId": "entity-npc-1",
    "action": "talk",  // "talk", "trade", "attack", "use", "examine"
    "timestamp": 1234567890
  }
}
```

#### Combat Action:

```json
{
  "type": "combat_action",
  "payload": {
    "abilityId": "ability-slash",
    "targetId": "entity-wolf-1",
    "position": { "x": 100, "y": 0, "z": 250 },  // Optional: used for AoE or positioning
    "timestamp": 1234567890
  }
}
```

---

### Server ΓåÆ Client: Events

Events are one-time occurrences that clients should present to the user:

```json
{
  "type": "event",
  "payload": {
    "eventType": "combat_damage",  // Type of event
    "timestamp": 1234567890,

    // Event-specific data
    "source": "entity-player-123",
    "target": "entity-wolf-1",
    "damage": 15,
    "damageType": "slashing",
    "critical": false,

    // Client presentation hints
    "narrative": "Your blade strikes the wolf for 15 damage!",  // For text clients
    "animation": "slash_hit",  // For graphical clients
    "sound": "sword_hit_flesh",  // For audio-capable clients
    "visual": {
      "effect": "blood_splatter",
      "position": { "x": 110, "y": 1, "z": 240 }
    }
  }
}
```

**Common Event Types**:
- `combat_damage`: Damage dealt/received
- `combat_miss`: Attack missed
- `combat_heal`: Healing applied
- `chat_message`: Incoming chat message
- `entity_died`: Entity death
- `quest_update`: Quest progress
- `item_obtained`: Item gained
- `level_up`: Character leveled up
- `dialogue`: NPC dialogue

---

## Client Type Adaptations

### Text Client (MUD-style)

Receives:
- Narrative descriptions (`description`, `narrative` fields)
- Exit/direction information
- Entity names and descriptions
- Text-formatted events

Ignores:
- Visual effects
- Animations
- 3D positions (uses symbolic locations instead)

**Example Text Rendering**:

```
The Crossroads
A weathered crossroads where five ancient paths converge. Moss-covered stones
mark each direction, their inscriptions long faded. A sense of anticipation
hangs in the air.

Exits: [north] [south] [east]

You see:
- Old Merchant (An elderly figure tending a cart)
- Elara (A mysterious figure in forest-green leathers)
- Grey Wolf (A lean wolf with silver-grey fur, watching warily) [hostile]

>
```

---

### 2D/3D Client

Receives:
- Full position coordinates
- Animation states
- Visual effects
- Model/sprite references

Uses:
- `position` for rendering
- `animation` for character/entity states
- `visual` data for effects

---

### VR Client

Same as 3D client, plus:
- Hand tracking data (future)
- Room-scale movement adjustments
- Spatial audio positioning

---

## Connection Health

### Ping/Pong

Client sends periodic pings:

```json
{
  "type": "ping",
  "payload": {
    "timestamp": 1234567890
  }
}
```

Server responds:

```json
{
  "type": "pong",
  "payload": {
    "clientTimestamp": 1234567890,
    "serverTimestamp": 1234567891
  }
}
```

**Recommended Interval**: Every 10-30 seconds

---

## Disconnection

### Graceful Disconnect

Client initiates:

```json
{
  "type": "disconnect",
  "payload": {
    "reason": "user_logout"
  }
}
```

Server acknowledges and closes connection.

---

### Connection Lost

If connection drops unexpectedly:
- Server keeps character in world for 30-60 seconds (reconnect grace period)
- Client can reconnect with token and resume session
- After timeout, character is removed from world but state is saved

---

## Message Structure Summary

All messages follow this base structure:

```typescript
{
  type: string,        // Message type (e.g., "move", "chat", "event")
  payload: object,     // Type-specific data
  timestamp?: number,  // Optional client timestamp (for client ΓåÆ server)
  sequence?: number    // Optional sequence number (for ordering)
}
```

---

## Error Handling

Server can send error responses:

```json
{
  "type": "error",
  "payload": {
    "code": "INVALID_ACTION",
    "message": "You cannot move while stunned.",
    "severity": "warning",  // "info", "warning", "error", "fatal"
    "originalMessage": { /* the message that caused the error */ }
  }
}
```

---

## Next Steps for Implementation

1. **Implement handshake flow** in ConnectionManager
2. **Add authentication logic** (JWT, guest login)
3. **Implement character selection/creation**
4. **Send initial world state** on character entry
5. **Build state update system** for ongoing communication
6. **Create text client** for testing

---

## Content Ratings

Every zone has a content rating that clients should display to users. This helps set expectations for mature content.

### Rating Levels

- **T (Teen)** - 13+: Fantasy violence, mild blood, mild profanity, suggestive themes
- **M (Mature)** - 17+: Intense violence, blood/gore, strong profanity, sexual themes (fade-to-black)
- **AO (Adults Only)** - 18+: Graphic violence, explicit content (with consent), extreme themes

### Client Display

Clients should:
1. Display the zone's content rating prominently when entering a new zone
2. Show a warning when entering M or AO rated zones
3. Color code ratings for quick recognition (suggested: T=green, M=yellow, AO=red)
4. Allow users to set content filters in their settings

### Zone Transitions

When a player attempts to enter a zone with a higher rating than their account allows, the server will send an `error` message with code `CONTENT_RESTRICTED`.

---

## Notes

- All coordinates use right-handed coordinate system: X = east/west, Y = up/down, Z = north/south
- Timestamps are Unix epoch milliseconds
- All string content should support UTF-8
- Consider rate limiting on client messages (TBD: specific limits)
- Minimum game rating is Teen (T) - combat is a core gameplay element
