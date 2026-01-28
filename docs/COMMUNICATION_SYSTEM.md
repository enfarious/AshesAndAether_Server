# Communication System

## Overview

The communication system provides range-based interaction with nearby entities (players, NPCs, companions). All communication types share the same range mechanics across text, 2D, 3D, VR, and Discord-integrated clients.

**Protocol Note**: The server uses the `chat` event for both inbound (client → server) and outbound (server → client) chat messages. Earlier documentation references to `communication` event are outdated.

## Communication Ranges

### Say - 20 feet
- **Use**: Normal conversation
- **Who hears**: Anyone within 20 feet
- **Volume**: Conversational tone
- **Privacy**: Semi-private, only immediate area
- **Best for**: Direct conversations, trading, small group interactions

### Shout - 150 feet
- **Use**: Loud communication, getting attention
- **Who hears**: Everyone within 150 feet
- **Volume**: Raised voice
- **Privacy**: Public, entire zone area typically hears
- **Best for**: Announcements, calling to distant players, warnings

### Emote - 150 feet
- **Use**: Actions, gestures, non-verbal communication
- **Who hears**: Everyone within 150 feet (sees the action)
- **Volume**: Visual/action-based
- **Privacy**: Public performance
- **Best for**: Roleplay actions, gestures, environmental interaction descriptions
- **Format**: "CharacterName waves enthusiastically at the crowd"

### Call for Help (CFH) - 250 feet
- **Use**: Emergency communication, distress signals
- **Who hears**: Everyone within 250 feet
- **Volume**: Maximum volume
- **Privacy**: Very public emergency broadcast
- **Best for**: Combat assistance, danger warnings, emergencies
- **Special**: May trigger UI alerts or special notifications

## Message Format

### Client → Server (Inbound)

```typescript
// Event: 'chat'
interface ChatMessagePayload {
  channel: 'say' | 'shout' | 'emote' | 'cfh';
  message: string;
}

// Example
socket.emit('chat', {
  channel: 'say',
  message: 'Hello everyone!'
});
```

**Note**: Messages starting with `/` are automatically routed to the command system.

### Server → Client (Outbound)

```typescript
// Event: 'chat'
interface ChatReceivedPayload {
  channel: 'say' | 'shout' | 'emote' | 'cfh';
  sender: string;      // Character name
  senderId: string;    // Character ID
  message: string;     // Formatted message content
  timestamp: number;   // Unix timestamp
}

// Example received
socket.on('chat', (data) => {
  // data = {
  //   channel: 'say',
  //   sender: 'Aria',
  //   senderId: 'char_123',
  //   message: 'Hello everyone!',
  //   timestamp: 1706400000000
  // }
});
```

## Nearby Entity List

To request an updated proximity roster, use:

```typescript
// Request proximity roster refresh
socket.emit('proximity_refresh');
```

**Important**: The server sends proximity updates via `proximity_roster_delta` events automatically as entities move. The initial roster after entering a zone is built from delta updates starting from an empty state. Clients should maintain their own roster by applying deltas.

Proximity delta structure:

```typescript
socket.on('proximity_roster_delta', (data) => {
  // data.payload contains:
  // - added: Entity[]    // New entities in range
  // - removed: string[]  // Entity IDs that left range
  // - updated: Entity[]  // Entities with changed bearing/range
});
```

**Note**: There is no full `proximity_roster` event in the distributed server path. Clients must build their roster by applying delta updates starting from an empty state when entering a zone.

### Privacy & Safety Notes

**What's Exposed via proximity roster:**
- Content access level (T/M/AO) - for age-appropriate interaction
- Account age bracket (minor/adult) - never exact age
- Current visible state (appearance, action)

**What's Hidden:**
- Exact birthdate
- Email, account details
- Real-world information
- Parental control settings

**Why This Matters:**
- LLMs can tailor responses appropriately (e.g., no flirting with minors)
- Players know who's around before initiating RP
- Prevents "talking to empty room" scenarios
- Enables proper pronoun usage and appearance descriptions

## LLM Integration

### Example LLM Workflow

1. **Check if anyone is around:**
   ```typescript
   // LLM wants character to speak
   const nearby = await client.getNearbyEntities();

   if (nearby.entities.say.length === 0) {
     // Nobody within conversation range
     return "You speak, but nobody is close enough to hear you.";
   }
   ```

2. **Generate age-appropriate content:**
   ```typescript
   const targetEntity = nearby.entities.say[0];
   const systemPrompt = `
     You are speaking to ${targetEntity.name}.
     Their content access level is ${targetEntity.contentAccessLevel}.
     Keep your response appropriate for that rating.
     ${targetEntity.accountAge === 'minor' ? 'This is a minor - no flirting, romance, or adult themes.' : ''}
   `;
   ```

3. **Send communication:**
   ```typescript
   socket.emit('chat', {
     type: 'say',
     content: llmGeneratedResponse,
     timestamp: Date.now()
   });
   ```

## Discord Integration

All communication types work identically in Discord:
- **#zone-channel**: Messages show with range indicators
- **Format**: `[SAY] CharacterName: "Hello there!"`
- **Range**: Server calculates based on character positions
- **Threading**: Long conversations can be threaded

### Example Discord Display
```
[SAY] Aria: "Hey, anyone know where the blacksmith is?"
[SAY] Marcus: "North exit, friend. Can't miss it."
[SHOUT] Guard: "Closing the gates in 5 minutes!"
[EMOTE] Lyra stretches and yawns, clearly exhausted from the journey.
[CFH] Finn: "AMBUSH! HELP!"
```

## Client Implementation

### Text Client
```javascript
// Listen for incoming chat messages
socket.on('chat', (data) => {
  const channelTag = data.channel.toUpperCase();

  if (data.channel === 'emote') {
    console.log(`[${channelTag}] ${data.sender} ${data.message}`);
  } else {
    console.log(`[${channelTag}] ${data.sender}: "${data.message}"`);
  }
});

// Send chat message
function say(message) {
  socket.emit('chat', { channel: 'say', message });
}

function shout(message) {
  socket.emit('chat', { channel: 'shout', message });
}

function emote(action) {
  socket.emit('chat', { channel: 'emote', message: action });
}
```

### 2D/3D Client
```javascript
// Visual speech bubbles
socket.on('chat', (data) => {
  const entity = findEntityById(data.senderId);

  // Different bubble styles by channel
  const bubbleStyle = {
    say: { color: 'white', size: 'small', duration: 3000 },
    shout: { color: 'yellow', size: 'large', duration: 5000 },
    emote: { color: 'gray', size: 'medium', duration: 4000, italic: true },
    cfh: { color: 'red', size: 'large', duration: 7000, flash: true }
  }[data.channel];

  showSpeechBubble(entity, data.content, bubbleStyle);

  // Also add to chat log
  addToChatLog(data);
});
```

### VR Client
```javascript
// Spatial audio + text
socket.on('communication', (data) => {
  const entity = findEntityById(data.senderId);

  // Play spatial audio based on type and distance
  const audioConfig = {
    say: { volume: 1.0, falloff: 'linear' },
    shout: { volume: 2.0, falloff: 'linear' },
    cfh: { volume: 3.0, falloff: 'exponential', urgent: true }
  }[data.type];

  playSpatialAudio(entity.position, audioConfig);

  // Show 3D text near entity
  show3DText(entity, data.content, data.type);
});
```

## Range Calculation

Server calculates actual 3D distance between entities:

```typescript
function calculateDistance(pos1: Vector3, pos2: Vector3): number {
  const dx = pos2.x - pos1.x;
  const dy = pos2.y - pos1.y;
  const dz = pos2.z - pos1.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function getEntitiesInRange(
  origin: Vector3,
  range: number,
  zone: Zone
): EntityInfo[] {
  return zone.entities
    .map(entity => ({
      ...entity,
      distance: calculateDistance(origin, entity.position)
    }))
    .filter(entity => entity.distance <= range)
    .sort((a, b) => a.distance - b.distance);  // Closest first
}
```

## Privacy Settings

Players can optionally limit communication:

```typescript
interface CommunicationPreferences {
  acceptWhispers: boolean;           // Can receive private messages
  acceptGroupInvites: boolean;       // Can be invited to groups
  showOnlineStatus: boolean;         // Visible in nearby lists
  blockList: string[];               // Blocked player IDs

  // Auto-responses
  afkMessage?: string;               // Shown when AFK
  dndMode: boolean;                  // Do Not Disturb - blocks most communication
}
```

## Anti-Spam & Moderation

```typescript
interface CommunicationLimits {
  sayRateLimit: 1 per 0.5s;          // Normal conversation pace
  shoutRateLimit: 1 per 3s;          // Prevent spam
  cfhRateLimit: 1 per 10s;           // Emergency only
  emoteRateLimit: 1 per 1s;          // Allow expressive RP

  maxMessageLength: {
    say: 500 characters;
    shout: 200 characters;
    emote: 300 characters;
    cfh: 100 characters;
  };
}
```

## Future Enhancements

- **Whisper**: Private 1-on-1 communication (unlimited range)
- **Group Chat**: Party/guild channels
- **Languages**: Translate based on character skills
- **Voice Chat**: Integrate with spatial audio for voice
- **Channels**: Zone, Guild, Party, Trade, LFG channels
- **Message History**: Persist chat logs per-zone
- **Mentions**: @PlayerName notifications
- **Chat Commands**: /roll, /flip, /afk, etc.

## Testing Checklist

- [ ] Say only heard within 20 feet
- [ ] Shout heard within 150 feet
- [ ] CFH heard within 250 feet
- [ ] Emote displayed correctly (third person)
- [ ] Nearby entity list excludes out-of-range entities
- [ ] Content access level filtering works
- [ ] LLMs check for nearby entities before speaking
- [ ] LLMs respect age-appropriate content levels
- [ ] Rate limiting prevents spam
- [ ] Distance calculation accurate in 3D space
- [ ] Works across all client types (text, 2D, 3D, VR, Discord)
- [ ] Privacy settings respected
- [ ] Block list prevents communication

---

**Key Insight**: Same range system works for human players, LLM companions, NPCs, and all client types. The server calculates actual 3D distances; clients just display appropriately for their medium.
