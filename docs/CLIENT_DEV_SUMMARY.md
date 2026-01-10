# Quick Reference for Client Developers

## What You Need to Know

### 1. Message Format: Event-per-type (Keep It)

**We're sticking with Socket.io's event-per-type pattern:**

```javascript
socket.on('handshake_ack', (data) => { ... });
socket.on('world_entry', (data) => { ... });
socket.on('state_update', (data) => { ... });
```

Not using envelope pattern. This is Socket.io idiomatic and works great with TypeScript types.

---

### 2. Content Ratings (NEW)

Every zone now has a `contentRating` field:

```javascript
{
  "zone": {
    "name": "The Crossroads",
    "contentRating": "T"  // "T" | "M" | "AO"
    // ... rest of zone data
  }
}
```

**Ratings:**
- **T (Teen 13+)** - Fantasy violence, mild profanity, suggestive themes
- **M (Mature 17+)** - Intense violence, gore, strong profanity, sexual themes
- **AO (Adults Only 18+)** - Graphic content, explicit themes

**Display it:**
```javascript
const ratings = {
  T: { name: 'Teen (13+)', color: 'green' },
  M: { name: 'Mature (17+)', color: 'yellow' },
  AO: { name: 'Adults Only (18+)', color: 'red' }
};

const rating = ratings[zone.contentRating];
// Show: "The Crossroads [Teen (13+)]" in green
```

**It's always present** - no need to check. Defaults to 'T'.

---

### 3. Movement System (NEW - IMPORTANT)

**Unified 3D architecture:** One movement system works for text, 2D, 3D, and VR clients.

#### Core Concept

Every character has:
- **position**: `{ x, y, z }` (3D coordinates)
- **heading**: `0-360` degrees (0=north, 90=east, 180=south, 270=west)
- **currentSpeed**: `"walk" | "jog" | "run" | "stop"`

#### Your Character State

```json
{
  "character": {
    "position": { "x": 100, "y": 0, "z": 250 },
    "heading": 45,              // Facing northeast
    "rotation": { "x": 0, "y": 45, "z": 0 },  // Full 3D (if needed)
    "currentSpeed": "walk"      // Current movement
  }
}
```

#### How to Send Movement

**Three methods - pick what fits your client:**

**Method 1: Heading (Universal)**
```json
{
  "type": "move",
  "payload": {
    "method": "heading",
    "speed": "jog",
    "heading": 45,
    "timestamp": Date.now()
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
    "compass": "NE",  // N, NE, E, SE, S, SW, W, NW
    "timestamp": Date.now()
  }
}
```

**Method 3: Position (3D/VR Direct)**
```json
{
  "type": "move",
  "payload": {
    "method": "position",
    "position": { "x": 101, "y": 0, "z": 251 },
    "timestamp": Date.now()
  }
}
```

#### Client-Specific Usage

**Text Client:**
- Use `compass` method with 8-way directions
- Display heading as compass direction
- Command format: `Walk.N`, `Jog.NE`, `Run.045`
- Perfect for LLM integration

**2D Client:**
- Use `heading` method
- Drop Y axis: use only (x, z) for position
- Use heading to select sprite direction
- 8-way sprites: N, NE, E, SE, S, SW, W, NW

**3D/VR Client:**
- Use `heading` or `position` method
- Full 3D coordinates + rotation
- Smooth interpolation between updates
- Animation based on `currentSpeed`

---

### 4. Proximity Roster (NEW - REQUIRED FOR COMMUNICATION)

**Social awareness system:** Know who's around before you speak.

#### Core Concept

Server tells you who can hear/see you in each range. This prevents:
- Talking to empty rooms
- Using names in crowds (creepy)
- Calling for help when not in danger

#### Message You'll Receive

```json
{
  "type": "proximity_roster",
  "timestamp": 1704859200000,
  "payload": {
    "channels": {
      "touch": { "count": 1, "sample": ["Shadowblade"] },
      "say": { "count": 3, "sample": ["Shadowblade", "Elara", "Wanderer"], "lastSpeaker": "Elara" },
      "shout": { "count": 9 },
      "emote": { "count": 4 },
      "see": { "count": 2, "sample": ["Elara", "Wanderer"] },
      "hear": { "count": 7 },
      "cfh": { "count": 0 }
    },
    "dangerState": false
  }
}
```

#### Channel Ranges

| Channel | Range | Purpose |
|---------|-------|---------|
| touch | 5 feet | Physical interaction, trading |
| say | 20 feet | Normal conversation |
| shout | 150 feet | Loud communication |
| emote | 150 feet | Actions, gestures |
| see | 150 feet | Who can see you |
| hear | 150 feet | Who can hear you |
| cfh | 250 feet | Call for Help (danger-gated) |

#### The Rules (CRITICAL)

**Rule 1: Names vs Crowds**
- If `sample` exists (1-3 people): Use names freely
- If `count >= 4` (no sample): Use "folks", "travelers", "everyone" - NO NAMES

**Rule 2: Don't talk to empty rooms**
- If `say.count === 0`: Don't send say messages (use emotes or internal thoughts)

**Rule 3: CFH requires danger**
- If `dangerState === false`: Cannot use CFH channel

**Rule 4: Respond to lastSpeaker**
- If `lastSpeaker` exists: They just spoke, respond to them first

#### Why This Matters

This encodes real human social bandwidth:
- **1-on-1**: Personal, use names, full attention
- **2-3 people**: Small group, use names, rotate attention
- **4+ people**: Crowd mode, no names, general address

Your LLM/client should enforce these rules. Server provides the data, you enforce behavior.

#### Example: Text Client

```javascript
socket.on('proximity_roster', (data) => {
  const roster = data.payload;

  // Can we speak?
  if (roster.channels.say.count === 0) {
    console.log("Nobody is nearby to hear you.");
    return;
  }

  // What mode are we in?
  if (roster.channels.say.sample) {
    // Personal or small group - use names
    console.log(`Nearby: ${roster.channels.say.sample.join(', ')}`);
    if (roster.channels.say.lastSpeaker) {
      console.log(`${roster.channels.say.lastSpeaker} just spoke.`);
    }
  } else {
    // Crowd mode
    console.log(`${roster.channels.say.count} people nearby (crowd mode - no names)`);
  }

  // Can we call for help?
  if (roster.dangerState) {
    console.log("You can call for help! (CFH available)");
  }
});
```

#### Player Inspection: /look Command

Get detailed info about specific players:

```javascript
// Send request
socket.emit('player_peek', { targetName: 'Shadowblade' });

// Receive response
socket.on('player_peek_response', (data) => {
  const info = data.payload;
  console.log(`${info.name} - Level ${info.level}`);
  console.log(`${info.appearance}`);
  console.log(`Pronouns: ${info.pronouns || 'not specified'}`);
  console.log(`Content: ${info.contentAccessLevel}`);
  console.log(`Age group: ${info.ageGroup}`);
});
```

**Privacy**: Only shows coarse age group (minor/adult), never exact age or personal data.

---

## Translation Guide

### 3D → 2D

```javascript
// Server sends full 3D
position3D: { x: 100.5, y: 0, z: 250.3 }

// You render in 2D
position2D: { x: 100.5, z: 250.3 }  // Drop Y or project to ground

// Use heading for sprite direction
heading: 45 → sprite: "character_northeast"
```

### 3D → Text

```javascript
// Server sends
position: { x: 100.5, y: 0, z: 250.3 }
heading: 45

// You display
"You are facing northeast at The Crossroads."
"Available directions: [N, NE, E, S, W]"
```

### Heading to Compass

```javascript
const headingToCompass = (heading) => {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round(heading / 45) % 8;
  return dirs[index];
};

headingToCompass(45) // "NE"
headingToCompass(180) // "S"
headingToCompass(315) // "NW"
```

---

## Quick Tips

### For Text Clients
1. Parse user commands: `Walk.N` → `{ method: "compass", speed: "walk", compass: "N" }`
2. Display heading as compass direction
3. Show available directions (will come from server later)
4. Perfect for LLM control: simple text commands

### For 2D Clients
1. Use orthographic projection (drop Y axis)
2. Heading determines sprite direction
3. Position on screen = (x, z) coordinates
4. Animate based on `currentSpeed`

### For 3D/VR Clients
1. Use full position + rotation
2. Interpolate between updates for smoothness
3. Heading = yaw rotation (Y axis)
4. Send position updates directly from physics

---

## Complete Example: Text Client

```javascript
// User types: "walk north"
const command = parseCommand("walk north");  // { speed: "walk", direction: "N" }

// Send to server
socket.emit('move', {
  method: 'compass',
  speed: command.speed,
  compass: command.direction,
  timestamp: Date.now()
});

// Receive update
socket.on('state_update', (data) => {
  const char = data.character;
  const heading = headingToCompass(char.heading);

  console.log(`You are ${char.currentSpeed}ing ${heading}.`);
  // "You are walking N."
});
```

---

## Documentation Links

- **Full Protocol**: [PROTOCOL.md](PROTOCOL.md)
- **Movement System Deep Dive**: [docs/MOVEMENT_SYSTEM.md](docs/MOVEMENT_SYSTEM.md)
- **Content Safety**: [docs/CONTENT_SAFETY.md](docs/CONTENT_SAFETY.md)
- **Quick Start**: [QUICKSTART.md](QUICKSTART.md)

---

## Type Definitions Available

If you want TypeScript types, they're in:
`src/network/protocol/types.ts`

Includes:
- `ContentRating` type
- `MovementSpeed` type
- `CompassDirection` type
- `MoveMessage` interface
- `CharacterState` interface
- `COMPASS_TO_HEADING` constants
- `SPEED_MULTIPLIERS` constants

---

## Questions?

- Check [PROTOCOL.md](PROTOCOL.md) for complete message specs
- Check [MOVEMENT_SYSTEM.md](docs/MOVEMENT_SYSTEM.md) for 25 pages of movement details
- Look at [test-client.js](test-client.js) for working examples

The key insight: **3D is the source of truth, everything else is translation.**
