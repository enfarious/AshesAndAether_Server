# Airlock Client Responsibilities

**Airlock is a separate service** that connects to the game server to control NPCs via LLM. This document defines what it does and doesn't do.

---

## What Airlock Does (At Separation Boundary)

### 1. Authentication

- Authenticates as `method: 'airlock'` with shared secret
- Receives `airlockSessionId` and session token
- Maintains session via periodic `inhabit_ping`

### 2. Inhabitancy

- Requests to inhabit a companion NPC (`inhabit_request` → `inhabit_granted`)
- Maintains connection to stay "in character"
- Can inhabit up to N concurrent NPCs (default 5)
- Releases inhabitancy cleanly (`inhabit_release`)

### 3. LLM Reasoning

**Airlock calls the LLM.** Not the server.

For each NPC:

```
Airlock receives: proximity_roster_delta (who's nearby)
                  state_update (combat status)
                  event (things that happened)
                  chat_message (player spoke)

Airlock→LLM: "You are [npc]. You see [nearby entities]. 
             Player just said: [message]. What do you do?"

LLM returns: "I should say hello and offer them a quest."
            OR
            "I attack the enemy to the south."
            OR
            "I move north toward the tavern."

Airlock parses LLM output → structured intent
Airlock sends commands to server
```

### 4. Command Generation

Parse LLM text and convert to slash commands:

**Input LLM text:**
```
"The traveler seems kind. I'll greet them warmly."
MOVE: Step closer
SAY: Welcome, friend! You look like someone who could use an adventure.
```

**Output commands Airlock sends:**
```
/say Welcome, friend! You look like someone who could use an adventure.
/move heading:45
```

The server validates these commands. Airlock doesn't need to validate—just format and send.

### 5. Conversation Context

Maintain conversation history for each inhabited NPC:

- `conversationHistory` from database (long-term memory)
- Recent messages from proximity (short-term context)
- Player perception of NPC (relationships, status, mood)

Build LLM system prompt:

```typescript
const systemPrompt = npc.systemPrompt + `

Recent events in this zone:
${recentEvents.map(e => e.description).join('\n')}

Nearby entities:
${proximityRoster.entities
  .slice(0, 3)
  .map(e => `${e.name} (${e.type}): ${compassDirection(e.bearing)}, ${e.range}ft away`)
  .join('\n')}
`;
```

---

## What Airlock Does NOT Do

### 1. Validate Commands

**Server does that.** Airlock just sends:

```typescript
// WRONG (Airlock shouldn't do this):
if (targetRange > maxRange) {
  console.error('Target out of range, skipping attack');
  return;
}

// RIGHT (Airlock should just send it):
socket.emit('command', { type: 'say', message: 'Attack!' });
// Server will reject if invalid
```

### 2. Interpret Server State

**No decoding of protocol.** Just receive events and feed to LLM:

```typescript
// WRONG (Airlock shouldn't parse this):
const entity = proximityRoster.find(e => e.id === targetId);
const inMeleeRange = entity.range < 5;

// RIGHT (Let LLM read the data):
const context = `
Nearby: ${proximityRoster.map(e => `${e.name} ${e.bearing}° ${e.range}ft`).join(', ')}
Status: HP ${state.currentHp}/${state.maxHp}
`;
socket.emit('llm_context', context);
```

### 3. Persist Entity State

**Server is authority.** Airlock only caches current session state:

```typescript
// Airlock's view:
const inhabitedNPC = {
  inhabitId: 'uuid',
  npcId: 'merchant',
  sessionStartedAt: Date.now(),
  lastProximityRoster: { /* current */ },
  lastStateUpdate: { /* current */ },
  conversationHistory: [ /* just this session */ ]
};

// Server's view (database):
{
  id: 'merchant',
  name: 'Old Merchant',
  conversationHistory: [ /* all time */ ],
  relationsh ips: { /* persistent */ }
}
```

### 4. Make Game Design Decisions

**Server defines what's possible.** Airlock just executes:

- Server says: "Max range for /attack is 30 feet"
- Airlock: "LLM, you're 50 feet away, can't attack"
- LLM: "I'll move closer"
- Airlock sends `/move heading:45`

Airlock doesn't override server rules.

### 5. Handle Persistency or Schedules

**Server manages** when NPCs act, how often they save, etc.

Airlock is **stateless and session-based**. Each inhabit is independent.

---

## Event Flow: Player → Airlock → Server

```
Player speaks to NPC: "/ask merchant what are you selling?"

Server broadcasts: event {
  type: 'chat_message',
  speaker: 'player_alice',
  message: 'what are you selling?',
  range: 20  // heard within 20 feet
}

Airlock receives event (if within range and inhabited):
  "Ah, a customer!"

Airlock→LLM:
  "A player just asked: 'what are you selling?'
   You're a merchant.
   You see them 20 feet away.
   What do you say?"

LLM:
  "SAY: I have the finest goods this side of the river!
   MOVE: closer to the player"

Airlock sends:
  /say I have the finest goods this side of the river!
  /move heading:45

Server validates, executes, broadcasts:
  event { type: 'chat_message', speaker: 'merchant', message: '...' }
  proximity_roster_delta { merchant moved closer }

All players nearby see it.
Conversation continues...
```

---

## Intent Parsing (Airlock, not Server)

LLM outputs could be freeform. Airlock must parse them into commands:

```typescript
// LLM output:
`The merchant's eyes light up. I should tell them about my wares!
SAY: I've got rare potions, weapons, and supplies!
ACTION_DELAY: 500ms
SAY: What interests you, traveler?
MOVE: 2 steps closer to the player
EMOTE: rubs hands together greedily`

// Airlock parses:
const intents = [
  { action: 'say', message: 'I\'ve got rare potions, weapons, and supplies!' },
  { action: 'delay', ms: 500 },
  { action: 'say', message: 'What interests you, traveler?' },
  { action: 'move', heading: calculateHeading(...) },
  { action: 'emote', message: 'rubs hands together greedily' }
];

// Airlock executes sequentially:
for (const intent of intents) {
  await executeIntent(intent);
}
```

This is **Airlock's responsibility**, not the server's.

---

## Session Management

Airlock is responsible for:

- Keeping inhabitancy alive with periodic pings
- Cleaning up on session end
- Handling LLM rate limits
- Buffering commands if needed

Server just:

- Validates commands
- Tells Airlock if NPC can't act (in combat, dead, stunned)
- Sends feedback events

---

## Testing Airlock Locally

```bash
# Terminal 1: Start game server
npm run dev

# Terminal 2: Start Airlock client
# (Airlock is separate repo)

# Terminal 3: Player client
# npm run start  (in client repo)

# Game:
# 1. Player logs in
# 2. Airlock inhabits a merchant NPC
# 3. Player walks up and talks
# 4. Airlock LLM generates response
# 5. Merchant speaks/moves/emotes
# 6. Observer sees it all
```

---

## Summary Table

| Responsibility | Airlock | Server |
|---|---|---|
| Authenticate | ✓ | Verify |
| Inhabit NPCs | ✓ | Track |
| Call LLM | ✓ | - |
| Parse LLM output | ✓ | - |
| Format commands | ✓ | - |
| Validate commands | - | ✓ |
| Execute commands | - | ✓ |
| Broadcast results | - | ✓ |
| Maintain conversation history | ✓ (session) | ✓ (persistent) |
| Handle persistence | - | ✓ |
| Respect rules | - | ✓ |

---

## Server's Responsibility Summary

From server perspective, Airlock is **just another client**. Everything Airlock sends gets:

1. **Validated** - Does it violate game rules?
2. **Executed** - Apply the change
3. **Broadcast** - Tell others what happened

That's it. Server doesn't care that Airlock is LLM-powered.
