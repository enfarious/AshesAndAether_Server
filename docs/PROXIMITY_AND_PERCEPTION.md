# Proximity & Perception System

## Overview

This system provides social context awareness for all clients (human and LLM). It answers: "Who can I interact with and how?" The server sends proximity data; clients enforce social rules.

**Key Insight**: Real social bandwidth degrades with group size. 1-on-1 is personal. 2-3 is small group. 4+ is crowd mode where you don't know anyone's name.

## Proximity Channels

Seven interaction channels based on distance and capability:

| Channel | Range | Purpose |
|---------|-------|---------|
| **touch** | ~5 feet | Physical interaction, trading, intimate conversation |
| **say** | 20 feet | Normal conversation, primary social channel |
| **shout** | 150 feet | Loud communication, announcements |
| **emote** | 150 feet | Actions, gestures (requires sight OR hearing) |
| **see** | 150 feet | Visual perception (affects emote interpretation) |
| **hear** | 150 feet | Auditory perception (affects all verbal channels) |
| **cfh** | 250 feet | Call for help - emergency only, danger-gated |

## Proximity Roster Message

Server sends this on zone entry and when proximity changes significantly (someone enters/leaves a channel).

### Message Format

```typescript
interface ProximityRosterMessage {
  type: 'proximity_roster';
  timestamp: number;
  payload: {
    channels: {
      touch: ProximityChannel;
      say: ProximityChannel;
      shout: ProximityChannel;
      emote: ProximityChannel;
      see: ProximityChannel;
      hear: ProximityChannel;
      cfh: ProximityChannel;
    };
    dangerState: boolean;  // true if in combat/danger
  };
}

interface ProximityChannel {
  count: number;              // Total entities in range
  sample?: string[];          // Present ONLY if count <= 3
  lastSpeaker?: string;       // Present ONLY if count <= 3 and someone spoke recently
}
```

### Examples

#### Empty Area
```json
{
  "type": "proximity_roster",
  "timestamp": 1704859200000,
  "payload": {
    "channels": {
      "touch": { "count": 0 },
      "say": { "count": 0 },
      "shout": { "count": 0 },
      "emote": { "count": 0 },
      "see": { "count": 0 },
      "hear": { "count": 0 },
      "cfh": { "count": 0 }
    },
    "dangerState": false
  }
}
```

#### 1-on-1 Conversation
```json
{
  "type": "proximity_roster",
  "timestamp": 1704859200000,
  "payload": {
    "channels": {
      "touch": { "count": 1, "sample": ["Shadowblade"] },
      "say": { "count": 1, "sample": ["Shadowblade"], "lastSpeaker": "Shadowblade" },
      "shout": { "count": 1, "sample": ["Shadowblade"] },
      "emote": { "count": 1, "sample": ["Shadowblade"] },
      "see": { "count": 1, "sample": ["Shadowblade"] },
      "hear": { "count": 1, "sample": ["Shadowblade"] },
      "cfh": { "count": 1, "sample": ["Shadowblade"] }
    },
    "dangerState": false
  }
}
```

#### Small Group (2-3 people)
```json
{
  "type": "proximity_roster",
  "timestamp": 1704859200000,
  "payload": {
    "channels": {
      "touch": { "count": 0 },
      "say": { "count": 3, "sample": ["Shadowblade", "Elara", "Wanderer"], "lastSpeaker": "Elara" },
      "shout": { "count": 3, "sample": ["Shadowblade", "Elara", "Wanderer"] },
      "emote": { "count": 3, "sample": ["Shadowblade", "Elara", "Wanderer"] },
      "see": { "count": 2, "sample": ["Elara", "Wanderer"] },
      "hear": { "count": 3, "sample": ["Shadowblade", "Elara", "Wanderer"] },
      "cfh": { "count": 3, "sample": ["Shadowblade", "Elara", "Wanderer"] }
    },
    "dangerState": false
  }
}
```

#### Crowd (4+ people)
```json
{
  "type": "proximity_roster",
  "timestamp": 1704859200000,
  "payload": {
    "channels": {
      "touch": { "count": 1, "sample": ["Shadowblade"] },
      "say": { "count": 4 },
      "shout": { "count": 9 },
      "emote": { "count": 7 },
      "see": { "count": 5 },
      "hear": { "count": 8 },
      "cfh": { "count": 9 }
    },
    "dangerState": false
  }
}
```

## Social Bandwidth Rules

These rules apply to ALL clients (human players, LLMs, NPCs):

### Audience Size → Interaction Mode

| Count | Mode | Name Usage | Tone | Attention Style |
|-------|------|------------|------|-----------------|
| 0 | **Silent** | N/A | Don't speak into void | No audience |
| 1 | **Personal** | Use name freely | Tailored, intimate | Full attention |
| 2-3 | **Small Group** | Use names, rotate | Facilitative | Shared attention, respond to who spoke |
| 4+ | **Crowd** | No names | General broadcast | "folks", "travelers", "y'all" |

### Implementation Rules

**Rule 1: Don't speak to empty channels**
```typescript
if (roster.channels.say.count === 0) {
  // Cannot use 'say' channel
  // Fall back to emote or internal thought
}
```

**Rule 2: Name usage based on sample presence**
```typescript
if (roster.channels.say.sample) {
  // Can use names from sample array
  // Example: "Hello, Shadowblade!"
} else {
  // Crowd mode - use general address
  // Example: "Hello, travelers!"
}
```

**Rule 3: Respond to lastSpeaker first (small groups)**
```typescript
if (roster.channels.say.count >= 2 && roster.channels.say.count <= 3) {
  if (roster.channels.say.lastSpeaker) {
    // Respond to this person primarily
    // Then optionally include others: "What do you think, Elara?"
  }
}
```

**Rule 4: CFH requires danger state**
```typescript
if (!roster.dangerState) {
  // Cannot use CFH channel
  // This is not an emergency
}
```

**Rule 5: Emotes require perception**
```typescript
// Visual emote (waving, gesturing)
if (roster.channels.see.count === 0) {
  // Nobody can see this emote - don't send visual emote
}

// Audible emote (laughing, coughing)
if (roster.channels.hear.count === 0) {
  // Nobody can hear this emote - don't send audible emote
}

// Combined emote (speaking + gesture)
if (roster.channels.see.count > 0 || roster.channels.hear.count > 0) {
  // At least someone can perceive this emote
}
```

## Player Inspection: The /look Command

Cross-client command for detailed entity information. Works for all client types (text, 2D, 3D, VR, Discord).

### Request Format

```typescript
interface PlayerPeekRequest {
  type: 'player_peek';
  payload: {
    targetName: string;  // or targetId
  };
}
```

### Response Format

```typescript
interface PlayerPeekResponse {
  type: 'player_peek_response';
  timestamp: number;
  payload: {
    id: string;
    name: string;
    type: 'player' | 'npc' | 'companion';

    // Visual
    appearance: string;         // Description
    equipment?: string[];       // Visible equipment

    // Basic info
    level?: number;
    title?: string;
    guildName?: string;

    // Social context
    ageGroup?: 'minor' | 'adult';           // Coarse, never exact
    pronouns?: string;                       // Player-provided (optional)
    contentAccessLevel?: 'T' | 'M' | 'AO';  // For age-appropriate interaction

    // State
    currentAction?: string;     // "standing", "sitting", "fighting"
    inCombat: boolean;
    afk: boolean;

    // Interaction flags
    interactive: boolean;
    acceptsWhispers: boolean;
    acceptsGroupInvites: boolean;
  };
}
```

### Privacy Rules

**What's Exposed:**
- Visual appearance (in-character description)
- Character name, level, title, guild
- Current visible state (standing, fighting, etc.)
- Coarse age group (minor/adult) - for content safety only
- Player-provided pronouns (optional)
- Content access level (T/M/AO) - for interaction appropriateness

**What's Hidden:**
- Real name, email, account details
- Exact birthdate or age
- Real-world location
- Account creation date
- Payment information
- Parental control settings
- Privacy: inspect target only, not all nearby players

### Client Implementation

**Text Client:**
```
> /look Shadowblade

[Shadowblade - Level 5 Wanderer]
A tall figure cloaked in shadows, eyes glinting with cautious intelligence.

Equipment: Worn leather armor, twin daggers

Status: Standing | Not in combat | Interactive
Pronouns: they/them
Content: Teen (13+)
```

**2D/3D Client:**
- Click on entity → Show inspection panel
- Same data, rendered in UI panel
- 3D: Rotate character model, show equipment

**VR Client:**
- Look at entity + gesture → Inspection panel appears in 3D space
- Can circle around to view equipment

**Discord:**
```
!look Shadowblade

**[Shadowblade]** - Level 5 Wanderer
*A tall figure cloaked in shadows, eyes glinting with cautious intelligence.*

Equipment: Worn leather armor, twin daggers
Status: Standing | Available
Pronouns: they/them
```

## Account Demographics (Optional)

At account creation, offer optional demographic fields with clear explanation:

### Form UI
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPTIONAL: Age & Presentation (Why we ask)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

This game includes zone-based content ratings (Teen, Mature, Adults Only).
Providing your birth month/year helps us:
- Show appropriate content warnings
- Enable age-gated areas (if you're 18+)
- Provide safer interactions with LLM companions

You can skip this - you'll default to Teen (13+) content only.

Birth Month/Year: [        ] (e.g., "05/1995")
                  [Skip]

Pronouns (optional): [        ] (e.g., "she/her", "they/them", "he/him")

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Storage
```typescript
interface Account {
  id: string;
  email: string;

  // Demographics (all optional)
  birthMonth?: number;          // 1-12
  birthYear?: number;           // e.g., 1995
  pronouns?: string;            // Freeform text

  // Derived from birthdate (never store exact age)
  ageGroup?: 'minor' | 'adult'; // Computed: under 18 vs 18+

  // Content access (defaults to 'T')
  contentAccessLevel: 'T' | 'M' | 'AO';  // Defaults to 'T'

  // Parental controls (for minors)
  parentalControls?: {
    enabled: boolean;
    maxContentRating: 'T' | 'M';  // Can't allow AO for minors
  };
}
```

### Privacy Guarantees

1. **Never display exact age** - only coarse groups (minor/adult)
2. **Never require demographics** - all optional, defaults to 'T' access
3. **Never sell or share** - used only for content gating
4. **Deletable** - players can remove demographic data anytime
5. **Not tied to payment** - billing is separate system

### Age Verification Levels

| Level | Method | Grants Access To |
|-------|--------|------------------|
| **None** | Default | Teen (T) content only |
| **Self-reported** | Birth month/year provided | Mature (M) content if 17+ |
| **Self-reported** | Birth month/year provided | Adults Only (AO) if 18+ |

For initial launch: self-reported only. Future: optional ID verification for high-trust scenarios.

## Server-Side Rules

### When to Send Proximity Roster

1. **Zone entry** - Always send full roster
2. **Entity enters/exits channel** - Send updated roster if:
   - `say` channel count changes
   - Any channel crosses the 3→4 or 4→3 threshold (mode change)
   - `touch` channel count changes (high importance)
3. **Combat state change** - Send when `dangerState` flips
4. **Throttle**: Max once per second per client

### Range Calculation

Server calculates actual 3D distance between entities:

```typescript
function calculateDistance(pos1: Vector3, pos2: Vector3): number {
  const dx = pos2.x - pos1.x;
  const dy = pos2.y - pos1.y;
  const dz = pos2.z - pos1.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function getProximityRoster(character: Character, zone: Zone): ProximityRoster {
  const ranges = {
    touch: 5,
    say: 20,
    shout: 150,
    emote: 150,
    see: 150,
    hear: 150,
    cfh: 250,
  };

  const channels: Record<string, ProximityChannel> = {};

  for (const [channelName, range] of Object.entries(ranges)) {
    const entities = zone.entities
      .filter(e => e.id !== character.id)  // Exclude self
      .filter(e => calculateDistance(character.position, e.position) <= range)
      .sort((a, b) => {
        const distA = calculateDistance(character.position, a.position);
        const distB = calculateDistance(character.position, b.position);
        return distA - distB;  // Closest first
      });

    channels[channelName] = {
      count: entities.length,
      ...(entities.length <= 3 && entities.length > 0 && {
        sample: entities.map(e => e.name)
      })
    };
  }

  return {
    channels,
    dangerState: character.inCombat || zone.hasHostileNearby(character),
  };
}
```

### lastSpeaker Tracking

Server tracks most recent speaker in each channel:

```typescript
// When a message is received
function handleCommunication(message: CommunicationMessage, sender: Character) {
  // Update lastSpeaker for all listeners in range
  const listeners = getEntitiesInRange(sender.position, RANGES.say);

  for (const listener of listeners) {
    listener.proximityState.say.lastSpeaker = sender.name;
    listener.proximityState.say.lastSpeakerTime = Date.now();
  }

  // Clear lastSpeaker after 30 seconds of silence
  // (handled by cleanup timer)
}
```

## Airlock Behavior Rules

The LLM "airlock" (safety layer) enforces these rules before sending to LLM:

### Pre-LLM Checks

```typescript
interface AirlockRules {
  // Speech gating
  canSpeak(channel: string, roster: ProximityRoster): boolean;

  // Mode selection
  getSocialMode(roster: ProximityRoster): 'silent' | 'personal' | 'small_group' | 'crowd';

  // Name usage
  canUseName(name: string, roster: ProximityRoster): boolean;

  // Emergency gating
  canUseCFH(roster: ProximityRoster): boolean;
}

// Implementation
const AirlockRules: AirlockRules = {
  canSpeak(channel, roster) {
    return roster.channels[channel].count > 0;
  },

  getSocialMode(roster) {
    const sayCount = roster.channels.say.count;
    if (sayCount === 0) return 'silent';
    if (sayCount === 1) return 'personal';
    if (sayCount <= 3) return 'small_group';
    return 'crowd';
  },

  canUseName(name, roster) {
    // Can only use names if they're in the sample
    return roster.channels.say.sample?.includes(name) ?? false;
  },

  canUseCFH(roster) {
    return roster.dangerState === true;
  }
};
```

### System Prompt Additions

Based on roster, add to LLM system prompt:

```typescript
function generateSocialContext(roster: ProximityRoster): string {
  const mode = AirlockRules.getSocialMode(roster);

  const prompts = {
    silent: `
      You are currently alone. Nobody is nearby to hear you speak.
      Use emotes or internal thoughts instead of speaking.
    `,
    personal: `
      You are in a one-on-one conversation with ${roster.channels.say.sample![0]}.
      Use their name naturally. This is a personal, intimate conversation.
      Give them your full attention.
    `,
    small_group: `
      You are with a small group: ${roster.channels.say.sample!.join(', ')}.
      ${roster.channels.say.lastSpeaker ? `${roster.channels.say.lastSpeaker} just spoke - respond to them primarily.` : ''}
      Use names when addressing specific people.
      In a group of 2-3, you can have personal moments but also facilitate discussion.
    `,
    crowd: `
      You are in a crowd of ${roster.channels.say.count} people.
      You don't know everyone's names - address the group generally ("travelers", "folks").
      Keep your message broad and inclusive.
      This is a public broadcast, not a personal conversation.
    `
  };

  return prompts[mode];
}
```

### Post-LLM Validation

Before sending LLM output to server, validate:

```typescript
function validateLLMOutput(
  output: string,
  action: 'say' | 'shout' | 'emote' | 'cfh',
  roster: ProximityRoster
): { valid: boolean; reason?: string } {
  // Check if channel is available
  if (!AirlockRules.canSpeak(action, roster)) {
    return { valid: false, reason: `Nobody in range for ${action}` };
  }

  // Check CFH gating
  if (action === 'cfh' && !AirlockRules.canUseCFH(roster)) {
    return { valid: false, reason: 'CFH requires danger state' };
  }

  // Check for name usage in crowd mode
  const mode = AirlockRules.getSocialMode(roster);
  if (mode === 'crowd' && roster.channels.say.sample) {
    // In crowd mode but has sample? That's an error - sample only present if <= 3
    // This shouldn't happen, but validate anyway
    for (const name of roster.channels.say.sample) {
      if (output.includes(name)) {
        return { valid: false, reason: 'Cannot use names in crowd mode' };
      }
    }
  }

  return { valid: true };
}
```

## Testing Checklist

### Proximity Roster
- [ ] Empty area shows all counts as 0
- [ ] 1 person shows sample with 1 name
- [ ] 2-3 people show sample with names
- [ ] 4+ people show count only, no sample
- [ ] lastSpeaker updates when someone speaks
- [ ] lastSpeaker clears after 30s silence
- [ ] Roster updates when someone enters/exits range
- [ ] dangerState updates when combat starts/ends

### Social Bandwidth
- [ ] LLM cannot speak when say.count === 0
- [ ] LLM uses name in 1-on-1 (personal mode)
- [ ] LLM uses names in 2-3 group (small group mode)
- [ ] LLM uses "folks"/"travelers" in 4+ group (crowd mode)
- [ ] LLM responds to lastSpeaker in small groups
- [ ] LLM cannot use CFH when dangerState === false

### Player Peek
- [ ] /look command returns full entity info
- [ ] ageGroup shown correctly (minor/adult)
- [ ] pronouns shown if provided
- [ ] contentAccessLevel shown
- [ ] Privacy: no exact age, no email, no account details
- [ ] Works across all client types (text, 2D, 3D, VR, Discord)

### Demographics
- [ ] Account creation allows skipping age/pronouns
- [ ] Skipping defaults to 'T' content access
- [ ] Providing birthdate enables M/AO access (if 17+/18+)
- [ ] ageGroup computed correctly from birthdate
- [ ] Exact age never displayed anywhere
- [ ] Demographics deletable by player

---

**Key Insight**: This system makes NPCs and LLMs behave like real social beings by encoding human social bandwidth limits into the protocol. You don't need to teach an LLM "don't memorize 40 names" - you just don't send 40 names.
