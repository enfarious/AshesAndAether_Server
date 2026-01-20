# Implementation Action Items

**Approach:** Documents next steps in order. Update with actual progress as work commences.

---

## Phase 1: Expand Companion Model & Quests (Days 1-5)

### Day 1: Database Schema Extension

**Goal:** Add NPC personality/context fields + quest system + memory system to schema.

**Tasks:**

- [ ] Read [prisma/schema.prisma](../prisma/schema.prisma) fully
- [x] Companion: Add `traits[]`, `goals[]`, `relationships`, `abilityIds[]`, `questIds[]` (DONE)
- [x] Quest: Add `giversNpcIds[]`, `dialogueStages` (DONE)
- [x] Add `CompanionMemory` model for Airlock's long-term NPC memory (DONE)
- [ ] Run `npx prisma migrate dev --name add_npc_system`
- [ ] Test migration locally
- [ ] Seed test NPCs with traits, goals, quests
- [ ] Review [QUEST_SYSTEM.md](QUEST_SYSTEM.md) and [NPC_MEMORY_SYSTEM.md](NPC_MEMORY_SYSTEM.md) for context

**Acceptance:** Database has new fields; migration successful.

---

### Day 2: Command Validation & Execution

**Goal:** Ensure Airlock-sent commands validated same as player commands.

**Tasks:**

- [ ] Review [src/commands/CommandExecutor.ts](../src/commands/CommandExecutor.ts)
- [ ] Identify validation points (range, target alive, etc)
- [ ] Verify Airlock commands go through same validation
- [ ] Add logging for Airlock command flow
- [ ] Test: Airlock `/say` → appears in proximity roster

**Acceptance:** Airlock-controlled NPCs execute commands under same rules as players.

---

### Day 3: Feedback Events (Server → Airlock)

**Goal:** Tell Airlock if commands succeeded/failed.

**Tasks:**

- [ ] Add event types to [src/network/protocol/types.ts](../src/network/protocol/types.ts):
  - `npc_action_executed` (success with result data)
  - `npc_action_failed` (reason for failure)
- [ ] Modify [src/gateway/GatewayClientSession.ts](../src/gateway/GatewayClientSession.ts)
  - Emit feedback after every command execution
  - Include: action, success, reason (if failed), new state
- [ ] Test: Execute command, observe feedback event

**Acceptance:** Airlock gets status on all NPC actions.

---

### Day 4: Position Override & NPC Inhabit Enhancement

**Goal:** Airlock can spawn NPCs at specific locations.

**Tasks:**

- [ ] Modify `inhabit_request` in [src/gateway/GatewayClientSession.ts](../src/gateway/GatewayClientSession.ts)
  - Add optional `positionOverride: { x, y, z }`
  - Allow Airlock to spawn NPC at custom position
- [ ] Provide quest context to Airlock on inhabit
  - Send NPC's `questIds` in inhabit_granted
  - Allow Airlock to know which quests NPC can give
- [ ] Integration test: Airlock inhabits, NPC appears, can move/talk/give quests

**Acceptance:** Airlock can fully control NPC including position and quest context.

---

### Day 5: Quest Commands (`/give` and `/take`)

**Goal:** NPCs can issue and complete quests.

**Tasks:**

- [ ] Implement `/give` command in [src/commands/CommandExecutor.ts](../src/commands/CommandExecutor.ts)
  - Syntax: `/give quest:<questId> target:<characterId> json:<rewardsOverride>`
  - Validate: NPC has quest, player meets level, not already active
  - Create `QuestProgress` record
  - Broadcast `quest_offered` event

- [ ] Implement `/take` command in [src/commands/CommandExecutor.ts](../src/commands/CommandExecutor.ts)
  - Syntax: `/take quest:<questId> character:<characterId> json:<rewards>`
  - Validate: player has quest, objectives complete
  - Grant XP, money, items to character
  - Update inventory
  - Mark quest `status="completed"`
  - Broadcast `quest_completed` event with rewards

- [ ] Add event types:
  - `quest_offered`
  - `quest_completed`
  - `objective_progress`

- [ ] Test: Full quest cycle (offer → accept → progress → complete → reward)

**Acceptance:** Quests work end-to-end. Player receives rewards on completion.

---

## Phase 2: Combat System Completion (Days 6-12)

### Day 6: Action Queue & Cast Times

**Goal:** Build queue for ability execution with future readiness times.

**Tasks:**

- [ ] Review [src/combat/CombatManager.ts](../src/combat/CombatManager.ts)
- [ ] Add `QueuedAction` interface with castTime, readyAt
- [ ] Implement `enqueueAction()` with validation (range, resources, target valid)
- [ ] Implement `processQueue()` to execute when ready
- [ ] Unit tests: enqueue, process, timeout

**Acceptance:** Queued actions execute at their `readyAt` timestamp.

---

### Day 7: Cooldown System

**Goal:** Track and enforce ability cooldowns per entity.

**Tasks:**

- [ ] Create [src/combat/CooldownManager.ts](../src/combat/CooldownManager.ts)
- [ ] Methods: `isOnCooldown()`, `apply()`, `expire()`
- [ ] Integrate into CombatManager: check before enqueue
- [ ] Unit tests: expiration, multiple abilities
- [ ] Manual: Attack, see cooldown, wait, can attack again

**Acceptance:** Cooldowns prevent ability spam.

---

### Day 8: Status Effects

**Goal:** Buffs/debuffs that modify stats with duration.

**Tasks:**

- [ ] Create [src/combat/StatusEffectManager.ts](../src/combat/StatusEffectManager.ts)
- [ ] Methods: `apply()`, `tick()`, `expire()`
- [ ] Stat mods: `{ stat: "strength", delta: +2 }`
- [ ] Integration: Tick in combat loop, apply on ability hit
- [ ] Unit tests: apply, expire, stack multiple
- [ ] Manual: Cast buff, stat increases, expires after time

**Acceptance:** Effects apply, persist, and expire correctly.

---

### Day 9: Multi-Target Damage Scaling

**Goal:** Damage scales down when hitting multiple targets.

**Tasks:**

- [ ] Review [src/combat/DamageCalculator.ts](../src/combat/DamageCalculator.ts)
- [ ] Implement scaling formula:
  - 1 target: 100%
  - 2 targets: 120% total (60% each)
  - 5 targets: 150% total (30% each)
- [ ] Integrate into ability execution
- [ ] Unit tests: verify all cases
- [ ] Manual: AoE hits 3 mobs, damage correct per target

**Acceptance:** Multi-target abilities scale appropriately.

---

### Day 10: Combat Events

**Goal:** Broadcast all combat outcomes to nearby entities.

**Tasks:**

- [ ] Review existing events in [src/network/protocol/types.ts](../src/network/protocol/types.ts)
- [ ] Add missing types:
  - `combat_start`
  - `combat_action` (ability used)
  - `combat_hit` / `combat_miss`
  - `combat_effect` (buff/debuff applied)
  - `combat_death`
  - `combat_end`
- [ ] Emit at appropriate moments in CombatManager
- [ ] Include: source, target, damage, effects, outcome
- [ ] Manual: Watch combat, observe all events

**Acceptance:** All outcomes broadcast correctly.

---

### Days 11-12: Integration & Polish

**Goal:** Full combat scenario works end-to-end.

**Tasks:**

- [ ] Create test character with weapon
- [ ] Create test NPC with stats
- [ ] Start combat: character attacks
- [ ] Verify: hit/miss, damage applied, cooldown set
- [ ] Verify: events broadcast to nearby
- [ ] NPC counter-attacks (auto-attack)
- [ ] Apply effect, verify stat change
- [ ] Character/NPC dies, verify cleanup
- [ ] Fix any issues discovered

**Acceptance:** Combat system fully functional.

---

## Phase 3: World Content & OSM (Days 13-15)

### Day 13: Parse OSM Data

**Goal:** Load existing Stephentown OSM JSON files.

**Tasks:**

- [ ] List files in [data/osm/USA_NY_Stephentown/](../data/osm/USA_NY_Stephentown/)
- [ ] Read building geometry and tags
- [ ] Create [scripts/osm-to-zones.ts](../scripts/osm-to-zones.ts)
- [ ] Parse all 8 JSON files
- [ ] Extract: location, name, type, tags
- [ ] Test: Log parsed data

**Acceptance:** Can read and parse OSM structure.

---

### Day 14: Create Zone Records

**Goal:** Convert OSM features to Zone database entries.

**Tasks:**

- [ ] For each building: create Zone record
- [ ] Set: name (OSM), position (geometry), size, terrainType
- [ ] Use elevation service for Z coordinate
- [ ] Run migration to populate database
- [ ] Verify zones appear

**Acceptance:** All OSM features in database as zones.

---

### Day 15: Place NPCs at Locations

**Goal:** Seed NPCs at interesting locations.

**Tasks:**

- [ ] Identify POI from OSM tags (shop, bar, government, etc)
- [ ] Create NPCs:
  - Merchant at shop
  - Guard at town center
  - Innkeeper at tavern/inn
- [ ] Give each a few quests to offer
- [ ] Test: Log in, explore, find NPCs

**Acceptance:** NPCs visible at real-world locations with quests.

---

## Phase 4: Wildlife Integration (Days 16-18)

### Day 16: Wildlife Bridge

**Goal:** Wildlife sim ↔ Server via Redis.

**Tasks:**

- [ ] Review wildlife_sim Redis code
- [ ] Implement server listener in [src/wildlife/WildlifeManager.ts](../src/wildlife/WildlifeManager.ts)
- [ ] Handle events:
  - `wildlife_spawn` (new entity)
  - `wildlife_moved` (position update)
  - `wildlife_died` (despawn + loot)
- [ ] Test: Sim spawns, server receives

**Acceptance:** Events flow between services.

---

### Day 17: Visibility

**Goal:** Wildlife appears in proximity rosters.

**Tasks:**

- [ ] Add wildlife to zone entity map
- [ ] Include in proximity calculations
- [ ] Verify bearing/range math
- [ ] Manual: Wildlife spawns, player sees it

**Acceptance:** Wildlife visible to players.

---

### Day 18: Hunting & Loot

**Goal:** Players hunt wildlife, get loot.

**Tasks:**

- [ ] Player `/attack` wildlife
- [ ] Combat system applies
- [ ] Wildlife dies, despawns
- [ ] Loot drops to inventory
- [ ] Manual: Kill rabbit, get loot

**Acceptance:** Hunting loop complete.

---

## Ongoing: Documentation

- [ ] Update README roadmap with phase completions
- [ ] Add examples to PROTOCOL.md for new events
- [ ] Update QUEST_SYSTEM.md with final implementation notes
- [ ] Update ARCHITECTURE.md with quest/wildlife sections
- [ ] Verify all file paths are current

---

## Completion Criteria

- [x] Phase 1: Airlock controls NPCs + issues quests
- [ ] Phase 2: Combat works with cooldowns/effects
- [ ] Phase 3: Real-world zones with NPCs
- [ ] Phase 4: Wildlife visible and huntable
- [ ] Docs are current and accurate
