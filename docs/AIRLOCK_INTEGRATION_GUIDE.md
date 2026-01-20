# Airlock Integration Guide: NPC Memory & Personalities

**For:** Airlock Development Team  
**Status:** Ready for implementation  
**Date:** January 20, 2026

---

## Overview

Server now provides complete NPC personality and memory infrastructure. Airlock's job: **process raw events into semantic understanding, generate contextualized dialogue, track dispositions, manage emotional state**.

Server does **not** interpret sentiment, make disposition changes, or manage NPC personality—that's all Airlock.

---

## Architecture

```
Server (authority)              Redis (hot cache)              Postgres (cold storage)
├─ Broadcasts raw events  ├─ npc:{id}:memory         ├─ CompanionMemory
│  (interaction_recorded)  │  - emotional state        │  - interactions log
│  (combat_hit)            │  - recent interactions    │  - dispositionSummary
│  (proximity_update)      │  - dispositions           │  - knownFacts
│                          │  - nearby NPCs            │  - syncedToRedisAt
└─ Validates/executes      └─ TTL: 1 hour (reloads)   └─ Pruned: ~500 interactions
  commands                                               per NPC

Airlock (reasoning)
├─ Listens to events (Redis pub/sub)
├─ Loads/updates hot memory (Redis)
├─ Periodically syncs to cold storage (Postgres)
├─ Generates dialogue with multi-listener context
├─ Sends commands back to server
└─ Never interprets server responses (server is truth)
```

---

## What Server Provides

### 1. NPC Data Structure

```typescript
interface Companion {
  id: string
  name: string
  tag: string
  description: string
  personalityType: string
  
  // For your context
  traits: string[]          // ["aggressive", "curious", "protective"]
  goals: string[]           // ["protect the forest", "find lost daughter"]
  relationships: Json       // {factionId: "friendly", otherId: "hostile"}
  abilityIds: string[]      // Combat/action abilities
  questIds: string[]        // Quests this NPC can give
  
  // Current state (for inhabit response)
  currentHealth: number
  maxHealth: number
  positionX: number
  positionY: number
  positionZ: number
  isAlive: boolean
}
```

### 2. Memory Structure (Postgres)

```typescript
interface CompanionMemory {
  companionId: string
  
  // Raw interaction log (FIFO, ~500 max)
  interactions: Array<{
    timestamp: number
    sourceId: string
    sourceName: string
    action: string        // "spoke", "attacked", "gifted", "helped"
    content?: string
  }>
  
  // Consolidated feelings toward characters
  dispositionSummary: {
    [characterId]: {
      feeling: "friendly" | "hostile" | "neutral"
      reason: string        // "Helped me with a quest"
      strength: 0-100       // Confidence/intensity
      lastInteractionAt: number
    }
  }
  
  // Semantic facts Airlock inferred
  knownFacts: string[]      // ["Player X is strong", "Player Y betrayed me"]
  
  syncedToRedisAt: DateTime // Track hot/cold sync
}
```

### 3. Quest Structure

```typescript
interface Quest {
  id: string
  title: string
  description: string
  questType: string        // "side", "bounty", "investigation"
  requiredLevel: number
  
  giversNpcIds: string[]   // Which NPCs offer this
  
  dialogueStages: {
    offered: string        // When NPC offers the quest
    accepted: string       // When player accepts
    inProgress: string     // Reminder while active
    completed: string      // When player finishes
    declined: string       // If they reject it
  }
  
  objectives: Json         // {kill_rats: {type: "kill", target: "rat", count: 5}}
  rewards: Json            // {xp: 500, money: 100, items: ["loot"]}
  
  prerequisiteQuestIds: string[]   // Must complete these first
  followupQuestIds: string[]       // These unlock after
}
```

### 4. Events (Redis pub/sub on `world:events`)

Server publishes these events. Airlock subscribes:

```typescript
// Player talks to NPC
{
  type: "interaction_recorded",
  npcId: "npc-123",
  sourceId: "char-456",
  sourceName: "Kael",
  action: "spoke",
  content: "Can you help me?",
  timestamp: 1705769600000
}

// Player attacks NPC
{
  type: "combat_hit",
  npcId: "npc-123",
  sourceId: "char-456",
  sourceName: "Kael",
  damage: 42,
  timestamp: 1705769600000
}

// Player gives item to NPC
{
  type: "item_gifted",
  npcId: "npc-123",
  sourceId: "char-456",
  sourceName: "Kael",
  itemId: "deer-pelt",
  timestamp: 1705769600000
}

// Entities near NPC changed (automatic broadcast)
{
  type: "proximity_update",
  npcId: "npc-123",
  nearby: [
    {id: "char-456", name: "Kael", type: "character", distance: 15},
    {id: "npc-789", name: "Merchant", type: "companion", distance: 25}
  ],
  timestamp: 1705769600000
}

// Quest completed by player
{
  type: "quest_completed",
  questId: "rat-problem",
  characterId: "char-456",
  characterName: "Kael",
  giversNpcIds: ["npc-123"],  // All NPCs who give this quest
  timestamp: 1705769600000
}
```

### 5. Commands (Redis on `zone:commands`)

Airlock sends commands to server via Redis:

```typescript
// Format
{
  sourceId: "npc-123",        // NPC ID (NOT character or airlock ID)
  sourceType: "airlock",      // Tell server this came from Airlock
  command: "/say Hello, friend!",
  timestamp: 1705769600000
}

// Airlock can send any slash command
// /say, /emote, /attack, /move, /give, /take, etc.
// Server validates and executes as if the NPC issued it
```

### 6. Manual Proximity Query (Socket.io)

If automatic `proximity_update` events stop arriving (network hiccup, stale connection), Airlock can manually query:

**Request (Airlock → Gateway via Socket.io):**
```typescript
socket.emit('get_proximity', {
  entityId: npcId,
  radius: 50  // Optional, defaults to proximity radius
});
```

**Response (Gateway → Airlock via Socket.io):**
```typescript
socket.on('proximity_data', (data) => {
  // {
  //   entityId: 'npc-123',
  //   nearby: [
  //     {id: 'char-456', name: 'Kael', type: 'character', distance: 20},
  //     {id: 'npc-789', name: 'Merchant', type: 'companion', distance: 30}
  //   ],
  //   timestamp: 1705769600000
  // }
});
```

**Recommended Pattern (Stale Proximity Watchdog):**

```typescript
class StaleProximityWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private readonly STALE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
  
  start(npcId: string, socket: Socket) {
    this.reset(npcId, socket);
  }
  
  reset(npcId: string, socket: Socket) {
    if (this.timer) clearTimeout(this.timer);
    
    this.timer = setTimeout(() => {
      // No proximity update for 10 min, query manually
      console.log(`[Watchdog] Stale proximity for ${npcId}, querying...`);
      socket.emit('get_proximity', { entityId: npcId });
      
      // Reset timer after query
      this.reset(npcId, socket);
    }, this.STALE_TIMEOUT);
  }
  
  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// Usage
const watchdog = new StaleProximityWatchdog();

// Start on connect/inhabit
watchdog.start(npcId, socket);

// Reset on every proximity event
socket.on('proximity_update', (data) => {
  watchdog.reset(npcId, socket);
  // ... handle update
});

socket.on('proximity_data', (data) => {
  watchdog.reset(npcId, socket);
  // ... handle manual query response
});

// Stop on disconnect
socket.on('disconnect', () => {
  watchdog.stop();
});
```

**Why this matters:**
- Automatic `proximity_update` events may be dropped (network issues)
- Stale proximity = NPC doesn't know who's nearby = can't modulate dialogue
- Watchdog ensures proximity data stays fresh even in degraded conditions

---

## What Airlock Needs to Implement

### 1. Memory Manager (Redis Ops)

```typescript
async function getNPCMemory(npcId: string): Promise<NPCHotMemory> {
  // 1. Check Redis cache
  let cached = await redis.get(`npc:${npcId}:memory`);
  if (cached) {
    return JSON.parse(cached);
  }
  
  // 2. Cache miss → load from Postgres
  const persistent = await db.companionMemory.findUnique({
    where: { companionId: npcId }
  });
  
  if (!persistent) {
    // First time this NPC is loaded
    persistent = await db.companionMemory.create({
      data: { companionId: npcId }
    });
  }
  
  // 3. Hydrate Redis from Postgres
  const memory: NPCHotMemory = {
    npcId,
    emotional: {
      mood: "neutral",
      intensity: 50,
      reason: "woke up",
      expiresAt: Date.now() + 5 * 60 * 1000  // 5 min decay
    },
    dispositions: persistent.dispositionSummary || {},
    recentInteractions: (persistent.interactions || []).slice(-30),  // Last 30
    nearbyNpcs: [],
    loadedAt: Date.now(),
    ttl: 3600
  };
  
  // 4. Cache in Redis
  await redis.setex(`npc:${npcId}:memory`, 3600, JSON.stringify(memory));
  
  return memory;
}

async function saveNPCMemory(npcId: string, memory: NPCHotMemory): Promise<void> {
  // Update Redis
  await redis.setex(`npc:${npcId}:memory`, 3600, JSON.stringify(memory));
  
  // Periodically sync to Postgres (every 50 interactions or 10 minutes)
  if (shouldSync(memory)) {
    await db.companionMemory.update({
      where: { companionId: npcId },
      data: {
        interactions: memory.recentInteractions,
        dispositionSummary: memory.dispositions,
        syncedToRedisAt: new Date()
      }
    });
  }
}
```

### 2. Event Processing

```typescript
// Subscribe to server events
redis.subscribe('world:events', async (message) => {
  const event = JSON.parse(message);
  
  if (event.type === 'interaction_recorded') {
    await handleInteraction(event);
  } else if (event.type === 'combat_hit') {
    await handleCombatHit(event);
  } else if (event.type === 'item_gifted') {
    await handleGift(event);
  } else if (event.type === 'proximity_update') {
    await handleProximityUpdate(event);
  }
});

async function handleInteraction(event: InteractionEvent) {
  const { npcId, sourceId, sourceName, action, content } = event;
  
  // Load memory
  const memory = await getNPCMemory(npcId);
  
  // 1. Add to interaction log
  memory.recentInteractions.push({
    timestamp: event.timestamp,
    sourceId,
    sourceName,
    action,
    content
  });
  if (memory.recentInteractions.length > 30) {
    memory.recentInteractions.shift();
  }
  
  // 2. Analyze sentiment
  const sentiment = analyzeSentiment(content, action);
  
  // 3. Update disposition
  updateDisposition(memory, sourceId, sentiment);
  
  // 4. Update emotional state
  memory.emotional = {
    mood: deriveEmotion(sentiment, memory),
    intensity: Math.min(100, 50 + Math.abs(sentiment)),
    reason: `${sourceName} just ${action}`,
    expiresAt: Date.now() + 5 * 60 * 1000
  };
  
  // 5. Save back to Redis
  await saveNPCMemory(npcId, memory);
  
  // Optional: trigger dialogue response
  // generateDialogueResponse(npcId, sourceId);
}

function analyzeSentiment(content: string, action: string): number {
  // Simple rules (can enhance with LLM later)
  if (action === 'attacked') return -30;
  if (action === 'gifted') return +20;
  if (action === 'helped') return +15;
  
  const lowerContent = content.toLowerCase();
  if (lowerContent.includes('thank')) return +10;
  if (lowerContent.includes('hate') || lowerContent.includes('stupid')) return -20;
  if (lowerContent.includes('love') || lowerContent.includes('friend')) return +15;
  
  return 0;  // Neutral
}

function updateDisposition(
  memory: NPCHotMemory,
  characterId: string,
  sentimentDelta: number
) {
  if (!memory.dispositions[characterId]) {
    memory.dispositions[characterId] = {
      feeling: 'neutral',
      strength: 50,
      lastInteractionAt: Date.now()
    };
  }
  
  const current = memory.dispositions[characterId];
  current.strength = Math.max(0, Math.min(100, current.strength + sentimentDelta));
  current.lastInteractionAt = Date.now();
  
  // Categorize feeling
  if (current.strength >= 70) {
    current.feeling = 'friendly';
  } else if (current.strength <= 30) {
    current.feeling = 'hostile';
  } else {
    current.feeling = 'neutral';
  }
}
```

### 3. Dialogue Generation

**Context for LLM:**

```typescript
async function buildLLMPrompt(
  npcId: string,
  speakerIds: string[],
  situationContext: string
): Promise<string> {
  const npc = await getNPCData(npcId);
  const memory = await getNPCMemory(npcId);
  
  // Build speaker context
  const speakers = speakerIds.map(speakerId => {
    const disp = memory.dispositions[speakerId] || {
      feeling: 'neutral',
      strength: 50
    };
    const recentHistory = memory.recentInteractions
      .filter(i => i.sourceId === speakerId)
      .slice(-5);
    
    return {
      speakerId,
      feeling: disp.feeling,
      strength: disp.strength,
      recentHistory
    };
  });
  
  const prompt = `
    You are ${npc.name}. 
    
    Personality traits: ${npc.traits.join(', ')}
    Goals: ${npc.goals.join(', ')}
    Current mood: ${memory.emotional.mood} (${memory.emotional.intensity}% intensity)
    
    You are speaking to:
    ${speakers.map(s => `
      - ${getCharName(s.speakerId)}: You feel ${s.feeling} toward them (${s.strength}% strength)
        Recent: ${s.recentHistory.map(h => `${h.action}: "${h.content}"`).join(', ')}
    `).join('\n')}
    
    Modulate your tone based on your feelings toward each listener.
    Be warm to friends, cold to enemies, respectful to neutral parties.
    
    Context: ${situationContext}
    
    Respond naturally as ${npc.name}. Keep it brief (1-2 sentences).
  `;
  
  return prompt;
}

async function generateNPCDialogue(
  npcId: string,
  speakerIds: string[],
  situationContext: string
): Promise<string> {
  const prompt = await buildLLMPrompt(npcId, speakerIds, situationContext);
  
  // Call your LLM (Claude, OpenAI, etc.)
  const response = await callLLM(prompt, {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 150
  });
  
  // Send command to server
  await redis.publish('zone:commands', JSON.stringify({
    sourceId: npcId,
    sourceType: 'airlock',
    command: `/say ${response}`,
    timestamp: Date.now()
  }));
  
  return response;
}
```

### 4. Quest Integration

**Offering a quest:**

```typescript
async function offerQuest(npcId: string, characterId: string, questId: string) {
  const quest = await db.quest.findUnique({ where: { id: questId } });
  const npc = await getNPCData(npcId);
  
  // Send offer command to server
  await redis.publish('zone:commands', JSON.stringify({
    sourceId: npcId,
    sourceType: 'airlock',
    command: `/give quest:${questId} target:${characterId} json:{}`,
    timestamp: Date.now()
  }));
  
  // Optionally say the offer dialogue
  const dialogue = (quest.dialogueStages as any).offered;
  if (dialogue) {
    await redis.publish('zone:commands', JSON.stringify({
      sourceId: npcId,
      sourceType: 'airlock',
      command: `/say ${dialogue}`,
      timestamp: Date.now()
    }));
  }
}
```

**Completing a quest:**

```typescript
async function completeQuest(npcId: string, characterId: string, questId: string, rewards?: any) {
  const quest = await db.quest.findUnique({ where: { id: questId } });
  const finalRewards = rewards || quest.rewards;
  
  // Send completion command to server
  await redis.publish('zone:commands', JSON.stringify({
    sourceId: npcId,
    sourceType: 'airlock',
    command: `/take quest:${questId} character:${characterId} json:${JSON.stringify(finalRewards)}`,
    timestamp: Date.now()
  }));
  
  // Say completion dialogue
  const dialogue = (quest.dialogueStages as any).completed;
  if (dialogue) {
    await redis.publish('zone:commands', JSON.stringify({
      sourceId: npcId,
      sourceType: 'airlock',
      command: `/say ${dialogue}`,
      timestamp: Date.now()
    }));
  }
}
```

### 5. Inhabit Response Enhancement

When `inhabit_request` is accepted:

```typescript
// In your inhabit_granted response, include:
{
  type: 'inhabit_granted',
  npcId: 'npc-123',
  npc: {
    // ... existing NPC data ...
    traits: ['gruff', 'wise', 'protective'],
    goals: ['protect the forest', 'find lost daughter'],
    questIds: ['quest-1', 'quest-2'],  // What quests does this NPC offer?
    relationships: {
      'faction-hunters': 'friendly',
      'faction-loggers': 'hostile'
    }
  },
  
  // Include initial memory load
  memory: {
    dispositions: {
      'char-456': { feeling: 'friendly', strength: 75 }
    },
    recentInteractions: [
      // Last few interactions
    ],
    knownFacts: [
      'Kael is a skilled hunter'
    ]
  },
  
  proximity: {
    nearby: [
      {id: 'char-456', name: 'Kael', type: 'character', distance: 20}
    ]
  }
}
```

---

## Implementation Checklist

**Phase 1: Memory Loading & Caching**

- [ ] Implement `getNPCMemory()` (load from Redis or Postgres)
- [ ] Implement `saveNPCMemory()` (update Redis, sync to Postgres)
- [ ] Test: Load NPC, memory appears in Redis

**Phase 2: Event Processing**

- [ ] Subscribe to `world:events` on Redis
- [ ] Implement interaction handler
- [ ] Implement disposition updates
- [ ] Implement emotion state management
- [ ] Test: Player talks to NPC, disposition increases

**Phase 3: Dialogue Generation**

- [ ] Build LLM prompts with memory context
- [ ] Implement multi-listener tone modulation
- [ ] Test: NPC speaks differently to friend vs enemy

**Phase 4: Quest Integration**

- [ ] Implement `/give` quest command
- [ ] Implement `/take` quest command
- [ ] Connect to quest dialogue stages
- [ ] Test: Offer quest, player accepts, NPC congratulates on completion

**Phase 5: Polish**

- [ ] Handle NPC dormancy (memory expires from Redis, reloads on inhabit)
- [ ] Test sentiment analysis with various inputs
- [ ] Add fact inference (optional, can enhance later)
- [ ] Add emotional decay (moods fade without reinforcement)

---

## Testing

**Unit Tests:**

- [ ] Memory loads from Postgres when Redis is cold
- [ ] Memory persists across inhabit cycles
- [ ] Dispositions update correctly (positive/negative sentiment)
- [ ] Emotional state decays over time

**Integration Tests:**

- [ ] End-to-end: Player talks → event → disposition updates → NPC responds
- [ ] Quest flow: Offer → accept → complete → rewards
- [ ] Multi-listener: NPC modulates tone for each listener
- [ ] Persistence: NPC dormant 1 hour → memory reloads correctly

**Manual Tests:**

- [ ] Insult NPC 5 times → becomes hostile
- [ ] Gift NPC item → becomes friendly
- [ ] NPC speaks differently to friend vs enemy in same conversation
- [ ] Quest dialogue appears at correct stages

---

## Database Queries You'll Use Often

```typescript
// Get NPC's memory
const memory = await db.companionMemory.findUnique({
  where: { companionId: npcId }
});

// Get quests this NPC gives
const questsGiven = await db.quest.findMany({
  where: { giversNpcIds: { has: npcId } }
});

// Get character's active quests
const activeQuests = await db.questProgress.findMany({
  where: {
    characterId,
    status: 'active'
  },
  include: { quest: true }  // Get quest definitions too
});

// Update disposition
await db.companionMemory.update({
  where: { companionId: npcId },
  data: {
    dispositionSummary: updatedDispositions
  }
});
```

---

## Notes

1. **Never ignore server responses** - Server is truth. If server says command failed, don't assume success.
2. **Emotion decay** - Current mood should fade if not reinforced. Implement expiry timers.
3. **Fact management** - Keep knownFacts relatively small (~50 per NPC). Periodically summarize old facts.
4. **Sentiment tuning** - Start with simple rules, upgrade to LLM-based sentiment later.
5. **Memory cleanup** - Postgres prunes interactions to ~500 per NPC (server-side). Redis expires on TTL.

---

## Questions for Server Dev (Me)

- Need a `/nearby-npcs` endpoint, or do you prefer Airlock subscribes to `proximity_update` events?
- Should Airlock track "conversation threads" (multi-turn with same character) or just log individual interactions?
- Want Airlock to auto-decay emotions, or should server send "time has passed" events?
- Should Airlock have access to zone server APIs, or stay pure Redis-based?

---

## Contact & Updates

Schema is finalized. Server-side quest handlers being implemented next week. This doc will be updated with any changes.

Good luck! 🚀
