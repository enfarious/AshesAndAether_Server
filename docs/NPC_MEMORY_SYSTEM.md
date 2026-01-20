# NPC Memory System

**Architecture for persistent, semantic NPC memories managed by Airlock.**

---

## Design Principles

1. **Server never interprets** - Server broadcasts raw events, Airlock processes them into meaning
2. **Postgres = truth, Redis = cache** - Long-term storage in Postgres, hot working memory in Redis
3. **Airlock owns semantics** - All disposition tracking, fact inference, emotional modeling happens in Airlock
4. **Multi-listener awareness** - NPCs can modulate dialogue based on multiple listeners in proximity

---

## Data Tiers

### PostgreSQL: Long-Term Memory (Cold Storage)

**Model:** `CompanionMemory`

```prisma
model CompanionMemory {
  id                  String   @id @default(uuid())
  companionId         String   @unique
  companion           Companion @relation(fields: [companionId], references: [id], onDelete: Cascade)
  
  // Raw interaction log (pruned to ~500 most recent)
  interactions        Json     @default("[]")
  
  // Consolidated disposition summary
  dispositionSummary  Json     @default("{}")
  
  // Semantic facts Airlock has inferred
  knownFacts          String[] @default([])
  
  // Track sync status between Redis and Postgres
  syncedToRedisAt     DateTime?
  
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
}
```

**Purpose:**
- Survives server restarts
- Persists across NPC dormancy (months offline)
- Rebuilt into Redis on demand when NPC becomes active

**Schema Details:**

- **interactions**: Array of raw events
  ```json
  [
    {
      "timestamp": 1737408000000,
      "sourceId": "char-123",
      "sourceName": "Kael",
      "action": "spoke",
      "content": "Hey, can you help me?",
      "outcome": "responded"
    }
  ]
  ```

- **dispositionSummary**: Map of character feelings
  ```json
  {
    "char-123": {
      "feeling": "friendly",
      "reason": "Helped me with a quest",
      "strength": 85,
      "lastInteractionAt": 1737408000000
    },
    "char-456": {
      "feeling": "hostile",
      "reason": "Insulted me repeatedly",
      "strength": 70,
      "lastInteractionAt": 1737407000000
    }
  }
  ```

- **knownFacts**: Semantic observations
  ```json
  ["Player Kael is strong", "Player Aria betrayed me", "I owe Kael a favor"]
  ```

**Pruning:**
- Interactions: Keep ~500 most recent (FIFO)
- Dispositions: Keep all (small footprint)
- Facts: Keep all (manually managed by Airlock)

---

### Redis: Hot Memory (Live Cache)

**Key Pattern:** `npc:{npcId}:memory`

**Structure:**
```typescript
interface NPCHotMemory {
  npcId: string
  
  // Current emotional state (changes minute-to-minute)
  emotional: {
    mood: string          // "happy", "angry", "contemplative", "neutral"
    intensity: number     // 0-100
    reason: string        // "just had a great conversation"
    expiresAt: number     // timestamp when emotion fades
  }
  
  // Dispositions toward specific characters (cached from Postgres)
  dispositions: {
    [characterId: string]: {
      feeling: "friendly" | "hostile" | "neutral"
      strength: number    // 0-100 confidence/intensity
      lastInteractionAt: number
    }
  }
  
  // Recent interactions (hot cache for LLM context window)
  recentInteractions: Array<{
    timestamp: number
    sourceId: string
    sourceName: string
    action: string        // "spoke", "attacked", "gifted", "helped"
    content?: string      // dialogue or action details
  }>
  
  // Nearby NPCs (updated when proximity changes)
  nearbyNpcs: string[]    // [npcId, npcId, ...]
  
  // Cache metadata
  loadedAt: number        // when loaded from Postgres
  ttl: number             // seconds until expiry (default: 3600)
}
```

**Purpose:**
- Fast reads for LLM context generation
- Live emotional state tracking
- Recent interaction cache (~30 most recent)
- Proximity awareness for multi-listener dialogue

**TTL Strategy:**
- Active NPCs: 1 hour (3600s)
- Idle NPCs: Expire and lazy-load on next interaction
- Frequently accessed: Auto-renewed on each read

---

## Data Flow

### 1. Player Interacts with NPC

```
Player → Server → Zone broadcasts event → Airlock receives event
```

**Server emits:**
```json
{
  "type": "interaction_recorded",
  "npcId": "npc-789",
  "sourceId": "char-123",
  "sourceName": "Kael",
  "action": "spoke",
  "content": "Can you help me find the lost sword?",
  "timestamp": 1737408000000
}
```

**Server does NOT:**
- Interpret sentiment
- Update dispositions
- Process meaning

---

### 2. Airlock Processes Interaction

```typescript
async function onInteractionRecorded(event: InteractionEvent) {
  const { npcId, sourceId, sourceName, action, content } = event;
  
  // 1. Load or create hot memory
  let memory = await getNPCMemory(npcId);
  
  // 2. Add to recent interactions
  memory.recentInteractions.push({
    timestamp: Date.now(),
    sourceId,
    sourceName,
    action,
    content
  });
  
  // Prune to 30 most recent
  if (memory.recentInteractions.length > 30) {
    memory.recentInteractions.shift();
  }
  
  // 3. Update disposition (semantic processing)
  const sentiment = await analyzeSentiment(content, action);
  updateDisposition(memory, sourceId, sentiment);
  
  // 4. Update emotional state
  memory.emotional = {
    mood: deriveEmotionFromSentiment(sentiment),
    intensity: 75,
    reason: `${sourceName} just ${action}`,
    expiresAt: Date.now() + 300000 // 5 min decay
  };
  
  // 5. Save to Redis
  await redis.setex(`npc:${npcId}:memory`, 3600, JSON.stringify(memory));
  
  // 6. Periodically sync to Postgres
  if (shouldSync(memory)) {
    await syncMemoryToPostgres(npcId, memory);
  }
}
```

---

### 3. Airlock Generates NPC Dialogue

When NPC needs to speak (Airlock-controlled):

```typescript
async function generateNPCDialogue(npcId: string, speakerIds: string[], context: string) {
  // 1. Load hot memory
  const memory = await getNPCMemory(npcId);
  
  // 2. Query zone server for nearby entities
  const nearby = await queryZoneServer('get_proximity', { entityId: npcId });
  memory.nearbyNpcs = nearby.filter(e => e.type === 'companion').map(e => e.id);
  
  // 3. Build multi-listener context
  const speakerContexts = speakerIds.map(speakerId => {
    const disposition = memory.dispositions[speakerId] || { feeling: 'neutral', strength: 50 };
    const recentHistory = memory.recentInteractions
      .filter(i => i.sourceId === speakerId)
      .slice(-5);
    
    return {
      speakerId,
      name: getCharacterName(speakerId),
      disposition,
      recentHistory
    };
  });
  
  // 4. Build LLM prompt with tone modulation
  const prompt = `
    You are ${getNPCName(npcId)}. Current mood: ${memory.emotional.mood} (${memory.emotional.intensity}% intensity).
    
    You are speaking to:
    ${speakerContexts.map(s => `
      - ${s.name}: You feel ${s.disposition.feeling} toward them (${s.disposition.strength}% strength).
        Recent interactions: ${s.recentHistory.map(h => `${h.action}: "${h.content}"`).join(', ')}
    `).join('\n')}
    
    ${memory.nearbyNpcs.length > 0 ? `Also nearby: ${memory.nearbyNpcs.map(getNPCName).join(', ')}` : ''}
    
    Context: ${context}
    
    Modulate your tone based on your feelings toward each listener. Be warmer to friends, colder to enemies.
  `;
  
  // 5. Call LLM
  const response = await callLLM(prompt);
  
  // 6. NPC speaks via server command
  await sendCommand(npcId, `/say ${response}`);
  
  return response;
}
```

---

### 4. Zone Server Proximity Query

Airlock queries zone server for nearby entities (not gateway):

```typescript
// Zone server endpoint (NOT gateway)
zoneServer.on('query:get_proximity', (request) => {
  const { entityId, radius = 50 } = request;
  
  const entity = zone.getEntity(entityId);
  if (!entity) return { error: 'Entity not found' };
  
  const nearby = zone.getEntitiesInRadius(entity.position, radius);
  
  return {
    entityId,
    nearby: nearby.map(e => ({
      id: e.id,
      name: e.name,
      type: e.type, // 'character', 'companion', 'creature'
      position: e.position,
      distance: calculateDistance(entity.position, e.position)
    }))
  };
});
```

**Alternative:** Airlock subscribes to `proximity_update` events already broadcast by zone servers.

---

## Memory Management

### Loading Memory (Cache Miss)

```typescript
async function getNPCMemory(npcId: string): Promise<NPCHotMemory> {
  // 1. Check Redis
  const cached = await redis.get(`npc:${npcId}:memory`);
  if (cached) {
    return JSON.parse(cached);
  }
  
  // 2. Cache miss → load from Postgres
  const persistent = await db.companionMemory.findUnique({
    where: { companionId: npcId }
  });
  
  // 3. Hydrate Redis
  const memory: NPCHotMemory = {
    npcId,
    emotional: {
      mood: "neutral",
      intensity: 50,
      reason: "just woke up",
      expiresAt: Date.now() + 300000
    },
    dispositions: persistent?.dispositionSummary || {},
    recentInteractions: (persistent?.interactions || []).slice(-30), // Last 30
    nearbyNpcs: [],
    loadedAt: Date.now(),
    ttl: 3600
  };
  
  // 4. Cache in Redis
  await redis.setex(`npc:${npcId}:memory`, 3600, JSON.stringify(memory));
  
  return memory;
}
```

---

### Syncing Memory (Hot → Cold)

**When to sync:**
- Every 50 interactions
- Every 10 minutes (if active)
- On NPC de-inhabit (Airlock disconnects)
- On server shutdown (graceful)

```typescript
async function syncMemoryToPostgres(npcId: string, memory: NPCHotMemory) {
  await db.companionMemory.upsert({
    where: { companionId: npcId },
    create: {
      companionId: npcId,
      interactions: memory.recentInteractions,
      dispositionSummary: memory.dispositions,
      knownFacts: [], // Managed separately
      syncedToRedisAt: new Date()
    },
    update: {
      interactions: memory.recentInteractions,
      dispositionSummary: memory.dispositions,
      syncedToRedisAt: new Date()
    }
  });
}
```

---

### Pruning Old Interactions

Run periodically (daily cron):

```typescript
async function pruneOldMemories() {
  const memories = await db.companionMemory.findMany();
  
  for (const memory of memories) {
    const interactions = memory.interactions as any[];
    
    // Keep 500 most recent
    if (interactions.length > 500) {
      const pruned = interactions.slice(-500);
      
      await db.companionMemory.update({
        where: { id: memory.id },
        data: { interactions: pruned }
      });
    }
  }
}
```

---

## Disposition Logic

### Sentiment Analysis

```typescript
async function analyzeSentiment(content: string, action: string): Promise<number> {
  // Simple rules (can upgrade to LLM later)
  const lowerContent = content.toLowerCase();
  
  // Action-based sentiment
  if (action === 'attacked') return -30;
  if (action === 'gifted') return +20;
  if (action === 'helped') return +15;
  
  // Content-based sentiment
  if (lowerContent.includes('thank')) return +10;
  if (lowerContent.includes('idiot') || lowerContent.includes('stupid')) return -15;
  if (lowerContent.includes('love') || lowerContent.includes('friend')) return +10;
  if (lowerContent.includes('hate') || lowerContent.includes('enemy')) return -15;
  
  return 0; // Neutral
}
```

---

### Updating Dispositions

```typescript
function updateDisposition(
  memory: NPCHotMemory, 
  characterId: string, 
  sentimentDelta: number
) {
  const current = memory.dispositions[characterId] || {
    feeling: 'neutral',
    strength: 50,
    lastInteractionAt: 0
  };
  
  // Adjust strength based on sentiment
  let newStrength = current.strength + sentimentDelta;
  newStrength = Math.max(0, Math.min(100, newStrength)); // Clamp 0-100
  
  // Determine feeling category
  let feeling: 'friendly' | 'hostile' | 'neutral';
  if (newStrength >= 70) feeling = 'friendly';
  else if (newStrength <= 30) feeling = 'hostile';
  else feeling = 'neutral';
  
  memory.dispositions[characterId] = {
    feeling,
    strength: newStrength,
    lastInteractionAt: Date.now()
  };
}
```

---

## Integration Points

### Server → Airlock Events

Server broadcasts these events (Airlock listens via Redis pub/sub):

```typescript
// Zone server publishes
redis.publish('world:events', JSON.stringify({
  type: 'interaction_recorded',
  npcId: 'npc-789',
  sourceId: 'char-123',
  sourceName: 'Kael',
  action: 'spoke',
  content: 'Hello!',
  timestamp: Date.now()
}));
```

**Event types:**
- `interaction_recorded` - Any player → NPC interaction
- `proximity_update` - Entities entering/leaving NPC proximity
- `combat_hit` - NPC was attacked
- `quest_completed` - Player finished NPC's quest
- `item_gifted` - Player gave item to NPC

---

### Airlock → Server Commands

Airlock sends commands via Redis (same as player commands):

```typescript
// Airlock publishes command
redis.publish('zone:commands', JSON.stringify({
  sourceId: npcId,
  sourceType: 'airlock',
  command: '/say Hello, friend!',
  timestamp: Date.now()
}));
```

---

## Testing Checklist

**Unit Tests:**
- [ ] Load memory from Postgres on cache miss
- [ ] Update disposition on positive/negative interactions
- [ ] Prune interactions to 30 in Redis, 500 in Postgres
- [ ] Sync Redis → Postgres every 50 interactions
- [ ] Emotional state decays after expiry time

**Integration Tests:**
- [ ] Player speaks to NPC → interaction recorded → disposition updates
- [ ] NPC generates dialogue with multi-listener context
- [ ] Memory survives Redis flush (reloads from Postgres)
- [ ] Nearby NPCs appear in context
- [ ] Emotional state influences dialogue tone

**Manual Tests:**
- [ ] Insult NPC 5 times → disposition becomes hostile
- [ ] Gift NPC item → disposition becomes friendly
- [ ] NPC speaks differently to friend vs enemy in same proximity
- [ ] NPC dormant for 2 hours → memory reloads correctly on next interaction

---

## Migration Path

**Phase 1:** (Current - add schema)
- [x] Add `CompanionMemory` model to schema
- [ ] Run migration: `npx prisma migrate dev --name add_companion_memory`

**Phase 2:** (Day 2-3)
- [ ] Implement Airlock memory manager (Redis ops)
- [ ] Subscribe to server interaction events
- [ ] Basic disposition tracking

**Phase 3:** (Day 4-5)
- [ ] Multi-listener dialogue generation
- [ ] Proximity awareness
- [ ] Periodic Postgres sync

**Phase 4:** (Week 2)
- [ ] Advanced sentiment analysis
- [ ] Fact inference from interactions
- [ ] Memory pruning automation

---

## Open Questions

1. **Emotion decay rate?** Currently 5 minutes, might need tuning
2. **Disposition decay?** Should friendly/hostile feelings fade over time without reinforcement?
3. **Fact management?** Should Airlock auto-generate facts from interactions, or manually curated?
4. **Multi-NPC conversations?** How to handle NPCs talking to each other (not just players)?

---

## Summary

**Server:** Broadcasts raw events, never interprets  
**Airlock:** Processes events into dispositions, emotions, facts  
**Postgres:** Long-term truth (survives everything)  
**Redis:** Hot cache (fast LLM context generation)  
**Zone Servers:** Provide proximity data (not gateway)

This creates depth without server complexity—all semantic processing lives in Airlock, server stays lean and authoritative.
