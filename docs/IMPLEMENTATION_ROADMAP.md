# Implementation Roadmap

**Status:** Updated Jan 2026 - Reflects current architecture and working systems

This document outlines the critical path to make the MMO fully playable. All file paths are current and verified.

---

## Phase 1: Expand Companion Model & Airlock Integration (4-5 Days)

**Goal:** Lay groundwork for Airlock to autonomously control NPCs and issue quests. **Intent parsing happens in Airlock, not the server.**

### Why This Matters

- Airlock can inhabit NPCs but can only send chat messages
- Server needs to validate and execute NPC **commands** (move, attack, emote, give quests, complete quests)
- Airlock will parse LLM output and send slash commands; server just executes them
- Separating concerns: Airlock = thinking, Server = action
- Quests are part of NPC interaction—LLM decides what to offer, server tracks progress

### Architecture Reminder

See [RESPONSIBILITY_MATRIX.md](RESPONSIBILITY_MATRIX.md):

- **Server responsibility**: Execute commands (validate, apply state changes, broadcast)
- **Airlock responsibility**: Generate intents from LLM (parse, structure, send commands)
- **Server does NOT** interpret LLM output or generate NPC reasoning

### Tasks

#### 1. Extend Companion Schema (Database Context)

**File:** [prisma/schema.prisma](../prisma/schema.prisma)

Add fields that describe the NPC (for Airlock's LLM context):

```prisma
model Companion {
  // ... existing fields ...
  
  // Personality & Context (used by Airlock's LLM)
  traits          String[]      // ["aggressive", "greedy", "curious"]
  goals           String[]      // ["protect this zone", "gather food"]
  relationships   Json          // {playerId: "friendly", otherId: "hostile"}
  
  // Available actions (what this NPC can do)
  abilityIds      String[]      // Abilities this NPC can use in combat
  routineScript   Json?         // Daily routine (patrol, shop hours, etc)
}
```

#### 2. Command Validation for NPCs

**File:** [src/commands/CommandExecutor.ts](../src/commands/CommandExecutor.ts)

Ensure commands from Airlock (inhabited NPCs) are validated same as player commands:

- `/say message` → broadcast to proximity roster
- `/move heading:X` → update NPC position
- `/attack target:ID` → enqueue combat action
- `/emote action` → broadcast action to proximity roster

No special parsing needed—just treat Airlock-sent commands identically to player commands.

#### 3. NPC Action Feedback to Airlock

**File:** [src/gateway/GatewayClientSession.ts](../src/gateway/GatewayClientSession.ts)

When an Airlock-inhabited NPC takes an action, send feedback:

```typescript
// After command executes successfully:
socket.emit('event', {
  type: 'npc_action_executed',
  payload: {
    inhabitId: 'uuid',
    action: 'move',
    result: 'success',
    newBearing: 45,
    newRange: 10.5
  }
});

// If command fails:
socket.emit('event', {
  type: 'npc_action_failed',
  payload: {
    inhabitId: 'uuid',
    reason: 'target_out_of_range'
  }
});
```

This lets Airlock know if its commands worked or failed, improving decision-making.

#### 4. Inhabit Request with Spawn Position

**File:** [src/gateway/GatewayClientSession.ts](../src/gateway/GatewayClientSession.ts)

Update `inhabit_request` to optionally specify position:

```typescript
// Airlock can request a companion at a specific position
{
  "type": "inhabit_request",
  "payload": {
    "airlockSessionId": "...",
    "npcId": "...",
    "positionOverride": { x: 100, y: 50, z: 200 },  // Optional
    "ttlMs": 300000
  }
}
```

Useful for spawning NPCs at specific locations without database seeding.

#### 5. Test Airlock with Real NPCs

- Airlock inhabits an NPC
- Player nearby
- Airlock sends `/say hello` → NPC says it, other players see it
- Airlock sends `/move heading:45` → NPC moves, proximity updates
- Airlock sends `/emote nods` → action broadcast

#### 6. Add Quest Commands (for Phase 1.5)

**File:** [src/commands/CommandExecutor.ts](../src/commands/CommandExecutor.ts)

Add `/give` and `/take` command handlers:

```typescript
// /give quest:<questId> target:<characterId> json:<rewards>
case 'give':
  if (sourceId !== npcId) throw new Error('Only NPCs can give quests');
  const quest = await getQuest(args.quest);
  const character = await getCharacter(args.target);
  // Validate NPC has this quest
  // Create QuestProgress record
  // Broadcast quest_offered event
  
// /take quest:<questId> character:<characterId> json:<rewards>
case 'take':
  if (sourceId !== npcId) throw new Error('Only NPCs can complete quests');
  const progress = await getQuestProgress(args.character, args.quest);
  // Validate objectives complete
  // Grant XP, money, items
  // Mark complete
  // Broadcast quest_completed event
```

#### 7. Test Quest System End-to-End

- NPC receives command to give quest
- Player gets quest in journal
- Player completes objective
- NPC receives command to take quest (complete it)
- Player gets rewards (XP, money, items)

---

## Phase 2: Combat System Completion (5-7 Days)

**Goal:** Full ATB combat with cooldowns, abilities, effects.

### Current State

- Basic auto-attack working
- Hit/miss calculation done
- Missing: action queue, cooldowns, status effects, AoE

### Task 1: Action Queue & Cast Times

**File:** [src/combat/CombatManager.ts](../src/combat/CombatManager.ts)

```typescript
interface QueuedAction {
  actionId: string;
  sourceId: string;
  targetId: string;
  abilityId: string;
  castTime: number;       // seconds
  readyAt: number;        // ms timestamp
}

export class CombatManager {
  private actionQueue: QueuedAction[] = [];
  
  enqueueAction(action: QueuedAction) {
    // Validate range, resources, target visibility
    // Add to queue
  }
  
  processQueue(now: number) {
    // Check which actions are ready (now >= readyAt)
    // Execute them, apply effects
  }
}
```

### Task 2: Cooldown System

**File:** [src/combat/AbilitySystem.ts](../src/combat/AbilitySystem.ts)

```typescript
interface AbilityCooldown {
  abilityId: string;
  expiresAt: number;  // ms
}

// Track cooldowns per entity
export class CooldownManager {
  isOnCooldown(entityId: string, abilityId: string): boolean {
    const cooldown = this.cooldowns.get(entityId)?.find(c => c.abilityId === abilityId);
    return cooldown ? Date.now() < cooldown.expiresAt : false;
  }
  
  apply(entityId: string, abilityId: string, duration: number) {
    // Start cooldown
  }
}
```

### Task 3: Status Effects

**New File:** [src/combat/StatusEffectManager.ts](../src/combat/StatusEffectManager.ts)

```typescript
interface StatusEffect {
  id: string;
  type: 'buff' | 'debuff';
  statMods: { stat: string; delta: number }[];
  duration: number;  // seconds
  expiresAt: number;
}

export class StatusEffectManager {
  apply(entityId: string, effect: StatusEffect) { }
  tick(now: number) { }
  expire(effectId: string) { }
}
```

### Task 4: Multi-Target Scaling

**File:** [src/combat/DamageCalculator.ts](../src/combat/DamageCalculator.ts)

Per COMBAT_SYSTEM.md:

- 1 target: 100% damage
- 2 targets: 120% total / 2 = 60% each
- 5 targets: 150% total / 5 = 30% each

### Task 5: Combat Events

Ensure all events are emitted:

```typescript
socket.emit('event', {
  type: 'combat_start' | 'combat_action' | 'combat_hit' | 
        'combat_miss' | 'combat_effect' | 'combat_death' | 'combat_end'
  payload: { ... }
})
```

### Task 6: Integration Test

- Character attacks NPC
- Gets a hit, applies cooldown
- NPC counter-attacks (if AI)
- Damage and status effects visible
- Combat ends properly

---

## Phase 3: World Content & OSM (2-3 Days)

**Goal:** Real world zones with NPCs and points of interest.

**Note:** OSM data pipeline is already complete (Stephentown data exists). This phase focuses on loading that data into the game.

### Task 1: Load OSM Data into Zones

**New File:** [scripts/osm-to-zones.ts](../scripts/osm-to-zones.ts)

Parse existing OSM JSON files and create Zone records in database:

```typescript
// Load from data/osm/USA_NY_Stephentown/*.json
// For each building/POI, create a Zone or a location marker
// Store in database
```

### Task 2: Place NPCs at Key Locations

Use OSM data to find interesting POIs (buildings tagged as shop, tavern, government):

- Merchant at central location
- Guard at populated areas
- Innkeeper if tavern exists in OSM data

### Task 3: Generate Navmesh

For each zone, mark:

- Walkable areas
- Obstacles (buildings, water)
- Spawn points
- Safe zones

---

## Phase 4: Wildlife Integration (2-3 Days)

**Goal:** Rust wildlife_sim visible and huntable in game.

### Current State

- Standalone Rust simulation working
- Can spawn rabbits, foxes, plants
- Needs Redis bridge to game server

### Task 1: Configure Wildlife Sim

**File:** [wildlife_sim/src/redis_bridge.rs](../../wildlife_sim/src/redis_bridge.rs)

Connect to game server Redis:

```rust
// Listen for zone spawn events
// Publish wildlife events (spawn, move, death)
```

### Task 2: Integration Handler

**File:** [src/wildlife/WildlifeManager.ts](../src/wildlife/WildlifeManager.ts)

```typescript
// Receive wildlife events from Redis
// Add to zone entity map
// Update proximity rosters
// Handle player interactions (hunting, loot)
```

### Task 3: Hunting Mechanics

- Player targets wildlife
- Combat system applies
- Wildlife drops loot
- Corpse despawns

---

## Testing Checklist

### Unit Tests

- [ ] Cooldown expiration
- [ ] Multi-target damage scaling
- [ ] Status effect application/expiration
- [ ] OSM zone generation

### Integration Tests

- [ ] Full combat flow: attack → hit/miss → effect → cooldown
- [ ] NPC action execution: Airlock sends command → zone executes
- [ ] Wildlife spawning and player interaction
- [ ] OSM zones with NPCs present

### Manual Tests

- [ ] Create character in starter zone (from OSM)
- [ ] Talk to NPC (Airlock inhabits)
- [ ] NPC responds with action (move/chat/emote)
- [ ] Combat with wildlife
- [ ] Damage, effects, death, loot

---

## Priority Order (Do Sequentially)

1. **Phase 1 (NPC Companion)** → Unblocks Airlock, NPCs ready for control
2. **Phase 2 (Combat)** → Unblocks combat testing, ability design
3. **Phase 3 (OSM)** → Unblocks world exploration
4. **Phase 4 (Wildlife)** → Unblocks hunting, ecosystem gameplay

Each phase gates the next. Once Phase 1 is done, you can test Airlock with real NPC control. Once Phase 2 is done, you can test combat. Etc.

---

## Files Reference

**Core Systems:**

- [src/world/DistributedWorldManager.ts](../src/world/DistributedWorldManager.ts) - Zone simulation (3000+ lines)
- [src/gateway/GatewayClientSession.ts](../src/gateway/GatewayClientSession.ts) - Client session handling
- [src/commands/CommandExecutor.ts](../src/commands/CommandExecutor.ts) - Command execution
- [src/combat/CombatManager.ts](../src/combat/CombatManager.ts) - Combat loop
- [prisma/schema.prisma](../prisma/schema.prisma) - Data schema

**Documentation:**

- [RESPONSIBILITY_MATRIX.md](RESPONSIBILITY_MATRIX.md) - Where each responsibility lives
- [COMBAT_SYSTEM.md](COMBAT_SYSTEM.md) - Combat mechanics spec
- [PROTOCOL.md](PROTOCOL.md) - Network protocol
- [ARCHITECTURE.md](ARCHITECTURE.md) - System design
- [AIRLOCK_PROTOCOL.md](AIRLOCK_PROTOCOL.md) - Airlock message types
