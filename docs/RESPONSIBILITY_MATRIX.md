# Responsibility Matrix: Where Does What Live?

This document clarifies which services handle which responsibilities in the Ashes & Aether architecture. The design philosophy is to **strip as much as possible out of the server** while keeping it **authoritative and consistent**.

---

## Core Principle

The **server is NOT**:

- An interpretation service (doesn't parse LLM output)
- A narrative engine (doesn't generate text)
- A wildlife simulator (separate process, just receives events)
- A strategic reasoner (doesn't generate NPC intents)

The **server IS**:

- Command executor (validates and applies commands)
- State manager (tracks entities, combat, proximity)
- Authority (all game logic is server-authoritative)
- Event broadcaster (tells clients what happened)

---

## Service Breakdown

### 1. Gateway Server (`src/gateway`)

**Responsibilities:**

- Socket.IO handshake and auth
- Character select/create  
- Route client messages to Zone servers via Redis
- Serve static assets (`/world/assets`, `/health`, `/api/info`)
- Enforce Airlock auth (separate clients can inhabit NPCs)

**Does NOT:**

- Validate commands (that's Zone)
- Track entity state (that's Zone)
- Generate NPC intents (that's Airlock)
- Interpret LLM output (that's Airlock)

**Outbound Events:**

- `proximity_roster_delta` - spatial updates
- `state_update` - resource deltas, combat gauges
- `event` - combat hits, deaths, narrative payloads

---

### 2. Zone Server (`src/zoneserver`)

**Responsibilities:**

- **Command execution**: Parse `/move`, `/say`, `/attack`, `/cast`, etc. and apply them
- **State authority**: Track entity positions, HP/stamina/mana, combat status
- **Movement**: Tick heading updates, spatial math, terrain collision
- **Proximity roster**: Calculate bearing/elevation/range for each entity to each other
- **Combat loop**: ATB timers, auto-attacks, outcome calculation
- **Event emission**: Combat hits, misses, deaths, special effects
- **Entity lifecycle**: Spawn, update, despawn NPCs/players/wildlife
- **Ability validation**: Check if ability can be used (cooldown, resources, range)

**Does NOT:**

- Generate NPC intents (that's Airlock)
- Interpret LLM output (that's Airlock)
- Simulate wildlife behavior (that's wildlife_sim, receives spawn/despawn events)
- Create narrative descriptions (that's LLM, server sends raw data)
- Parse natural language (all input is slash commands or structured Airlock messages)

**Outbound Events:**

- `command_executed` / `command_failed` - player action results
- `combat_action_resolved` - hit/miss with damage
- `state_update` - entity HP/stamina changes
- `proximity_roster_delta` - entity position changes
- `entity_spawn` / `entity_despawn` - for wildlife sim integration
- `npc_action_needed` - signal to Airlock that NPC should take a turn (e.g., in combat)

**Input Types:**

- `/command` (parsed by CommandParser)
- `inhabit_chat` (from Airlock - already parsed as action)
- `state_sync_request` (from clients)

---

### 3. Airlock Client (external service)

**Responsibilities:**

- **Authentication**: Prove you're an LLM client, get authority to inhabit NPCs
- **Intent generation**: Call LLM with context, get back structured intent (MOVE/ATTACK/SAY/EMOTE/etc.)
- **Action execution**: Convert intent to slash command or Airlock protocol message
- **Conversation**: Chat with players (LLM-driven, not server-driven)
- **Response parsing**: Take LLM text, extract actions
- **Session management**: Keep habitant alive (ping/release)

**Does NOT:**

- Validate commands (that's server)
- Modify game state directly (send commands like players do)
- Know about proximity rosters (receives them, translates to narrative)
- Simulate combat (server is authoritative, Airlock just acts)

**Inbound Events:**

- `proximity_roster_delta` - who's nearby
- `state_update` - combat gauge updates
- `event` - combat results, deaths, etc.

**Outbound Actions:**

- `inhabit_chat` - say something
- Commands as if it were a player (via slash commands or inhabit actions)
- `inhabit_ping` - keep session alive
- `inhabit_release` - give up control

---

### 4. Wildlife Sim (external service, in Rust)

**Responsibilities:**

- **Simulation**: Tick behaviors, hunger/thirst, breeding, aging
- **Movement**: Pathfinding, herd behavior, migration
- **Interaction protocol**: Listen for spawn/despawn from server, emit state updates

**Does NOT:**

- Know about players (server filters proximity)
- Persist state (server is source of truth for DB)
- Combat (server handles it, wildlife just dies)
- Authority (server validates all changes)

**Inbound Events:**

- `wildlife_spawn` - "Species X at position Y"
- `wildlife_kill` - "Remove this wildlife entity"
- `zone_changed` - "You're now simulating zone Z"

**Outbound Events:**

- `wildlife_moved` - position update (server applies)
- `wildlife_died` - natural death (server despawns)
- `wildlife_state_changed` - hunger/age (server persists)

---

### 5. LLM Services (OpenAI/Claude/Ollama)

**Responsibilities:**

- Text generation for Airlock (inhabited NPCs speaking)
- Narrator responses (describe what player senses)
- Combat narration (how that hit felt)

**Does NOT:**

- Know about game state (Airlock provides context)
- Make authoritative decisions (all server-validated)
- Validate anything (Airlock/server do that)

---

## Command Flow Examples

### Example 1: Player Movement

```
Client → Gateway: /move heading:90
Gateway → Zone: route to ZoneManager
Zone: Validate (is zone accessible, can character move there?)
Zone: Update character.positionX/Y/Z
Zone → Clients: proximity_roster_delta (new bearing/range to all entities)
```

**No LLM involvement.** Server is authoritative.

---

### Example 2: NPC Speaks & Acts (Airlock Inhabited)

```
NPC's Airlock session receives: proximity_roster_delta
Airlock: "Who's nearby? [Player Alice at bearing 45°, range 20ft]"
Airlock: Call LLM with context
LLM returns: "SAY: Welcome, traveler! MOVE: approach Alice"
Airlock: Extract actions, send to server:
  - /say Welcome, traveler!
  - /move to:Alice
Zone: Validate & execute both commands
Zone → Clients: 
  - event (NPC said something)
  - proximity_roster_delta (NPC moved closer)
```

**Airlock does the thinking, server does the execution.**

---

### Example 3: Combat (Player Attacks NPC)

```
Client → Gateway: /attack target:npc_merchant
Gateway → Zone: route to ZoneManager
Zone: Validate (in range? target exists? alive? can attack?)
Zone: Calculate hit/miss using DamageCalculator
Zone: Apply damage to target
Zone → Clients: 
  - event (combat_hit with damage amount)
  - state_update (target's HP changed)
```

**Server is authoritative. No client approval needed.**

---

### Example 4: NPC Combat (Airlock-Inhabited)

```
Zone: NPC is in combat, auto-attack timer fires
Zone: Emit "npc_action_needed" event to Airlock
Airlock: Receives event, generates combat intent
LLM returns: "ATTACK: basic_attack on:player_alice"
Airlock: Sends /attack command
Zone: Validate & execute attack
Zone → Clients: event (NPC attacked)
```

**Zone initiates, Airlock executes, Zone validates.**

---

### Example 5: Wildlife Interaction

```
Player commands: /attack target:dire_toad
Zone: Validate attack, calculate hit/miss
Zone → Wildlife Sim: "Kill directive for entity X"
Wildlife Sim: Stop simulating this entity
Zone: Despawn toad from proximity rosters
Zone → Clients: entity_despawn event
```

**Zone is source of truth. Wildlife just receives the signal.**

---

## What Commands Live Where?

### Zone Server (in CommandExecutor/CommandRegistry)

These are slash commands that modify game state:

- `/move heading:X` - Position update
- `/say message` - Chat broadcast
- `/shout message` - Wider chat
- `/emote action` - Action broadcast
- `/attack target:ID` - Combat action
- `/cast ability:X target:ID` - Ability use
- `/stop` - Cancel movement
- `/look [target]` - Perception (generates event with description)
- `/listen`, `/smell`, `/sense` - Perception (generates event)

### Airlock (external)

These are not slash commands, but high-level intents:

- Intent to move toward entity X
- Intent to attack in combat
- Intent to speak (already decided what to say)
- Intent to emote (already decided the action)

Airlock converts intents → slash commands → sends to server.

### Gateway (static endpoints)

- `/health` - Server health check
- `/api/info` - Server metadata
- `/world/assets` - Asset manifests
- `/world/assets/:zoneId` - Zone-specific assets

---

## Decision Flow Chart

**"Where should feature X live?"**

```
Does it modify game state?
  ├─ YES → Server (Zone)
  │ Does it happen automatically every frame?
  │   ├─ YES → ServerLoop (movement tick, proximity calc, ATB)
  │   └─ NO → CommandExecutor (on-demand like /attack)
  └─ NO → Could be elsewhere
    Does it require authoritative validation?
      ├─ YES → Server validates, other service executes
      │ (e.g., Airlock generates intent, server validates command)
      └─ NO → External service (Airlock, LLM, Wildlife Sim)
        Is it simulation of non-player behavior?
          ├─ YES → Wildlife Sim or Airlock (depends on entity type)
          └─ NO → Airlock or LLM (depends on interaction type)
```

---

## Future: Stateless Server Pattern

As load increases, the server can become more stateless:

```
Clients → Load Balancer → Multiple Gateway instances (stateless)
                             ↓
                         Redis pub/sub
                             ↓
                         Multiple Zone instances (stateless, but synchronized via Redis)
```

This is already architected; just needs deployment.

---

## NPC Intent Parsing: Where?

**Not in server.** Here's why:

- Server is authority for state, not logic
- Intent parsing is interpretation (LLM domain)
- Airlock is the LLM client, already has context
- Server just validates & executes what Airlock sends

**Implementation:**

1. Airlock receives proximity roster
2. Airlock calls LLM: "You see X nearby. What do you do?"
3. LLM returns: `MOVE toward:player_alice; SAY hello`
4. Airlock parses this (simple regex/JSON)
5. Airlock sends `/move to:alice` + `/say hello` as separate commands
6. Server validates each command independently
7. Server broadcasts results

This keeps server lean and lets Airlock iterate on intent parsing without server deploys.
