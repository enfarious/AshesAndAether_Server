# Comprehensive Action Items - Ready for Implementation

**Generated:** January 20, 2026
**Priority Order:** Sequential (each phase gates the next)
**Estimated Timeline:** 2-3 weeks to fully playable game

---

## PHASE 1: NPC Intent System (3-4 Days) 🎯 START HERE

**Why:** Unblocks Airlock, makes NPCs autonomous, foundation for combat AI.

### Task 1.1: Extend Companion Schema
- **File:** `prisma/schema.prisma`
- **What:** Add context fields to Companion model
  - `traits` (string array) - personality traits
  - `goals` (string array) - what NPC wants to do
  - `relationships` (JSON) - NPC relationships to other entities
  - `abilityIds` (string array) - available actions
  - `dialogueTrees` (JSON) - branching dialogue
  - `routineScript` (JSON) - daily routine/patrol

### Task 1.2: Create Intent Parser Module
- **File:** `src/ai/IntentParser.ts` (NEW)
- **What:** Convert LLM text to structured commands
  - Parse SAY, SHOUT, EMOTE, MOVE, ATTACK commands
  - Extract parameters (message, target, bearing, etc)
  - Handle malformed responses gracefully

### Task 1.3: Wire LLMService in NPCAIController
- **File:** `src/ai/NPCAIController.ts`
- **What:** Implement actual `update()` method that:
  - Calls LLMService with companion context + traits + goals
  - Passes proximity roster and recent messages
  - Parses response with IntentParser
  - Returns structured NPCIntent

### Task 1.4: Execute Intent in Zone
- **File:** `src/world/DistributedWorldManager.ts`
- **What:** In zone update loop, for each NPC:
  - Call controller.update()
  - Execute returned intent:
    - If chat: broadcast to proximity roster
    - If move: update position/heading
    - If combat: enqueue ability
  - Track NPC state

### Task 1.5: End-to-End Test
- Extend companion in database with traits
- Airlock connects and inhabits NPC
- Player nearby says something
- NPC responds with action (move/chat/emote)
- Action visible to other players

### Acceptance Criteria
- [ ] Companion schema has context fields
- [ ] IntentParser parses various LLM formats
- [ ] NPCAIController calls LLMService + parser
- [ ] Zone executes returned intents
- [ ] Test: Player talks → NPC responds with action

---

## PHASE 2: Combat System Completion (5-7 Days)

**Why:** Unblocks actual combat testing, damage/healing gameplay.

### Task 2.1: Implement Action Queue
- **File:** `src/combat/CombatManager.ts`
- **What:** Queue system for ability execution
  - QueuedAction structure (source, target, ability, castTime, readyAt)
  - enqueueAction() with validation
  - processQueue() to execute when ready
  - Handle cast time delays

### Task 2.2: Cooldown System
- **File:** `src/combat/AbilitySystem.ts`
- **What:** Cooldown tracking per entity
  - isOnCooldown() checks
  - apply() starts cooldown (duration from ability def)
  - Cooldown duration scales with haste/slow stats
  - Cleanup on expiration

### Task 2.3: Status Effects
- **File:** `src/combat/StatusEffectManager.ts` (NEW)
- **What:** Apply/track/expire effects
  - Buffs (stat increases, shields)
  - Debuffs (DoT, stat decreases, stuns)
  - Tick processing for damage/heal per second
  - Stack rules per effect type
  - Emit combat_effect events

### Task 2.4: Multi-Target Scaling
- **File:** `src/combat/DamageCalculator.ts`
- **What:** Scale damage based on target count
  - 1 target: 100%
  - 2 targets: 120% total (60% each)
  - 5 targets: 150% total (30% each)
  - AoE validation (radius, geometry)

### Task 2.5: Combat Events
- **File:** `src/world/DistributedWorldManager.ts`
- **What:** Emit all event types
  - combat_start
  - combat_action (ability queued)
  - combat_hit (with damage breakdown)
  - combat_miss
  - combat_effect (buff/debuff/DoT)
  - combat_death
  - combat_end

### Task 2.6: Integration Test
- Create character, fight NPC
- Land hit → see damage
- Get hit → take damage + status effect
- Use ability → see cooldown
- Death → respawn

### Acceptance Criteria
- [ ] Action queue processes abilities with cast time
- [ ] Cooldowns prevent repeated use
- [ ] Status effects apply/tick/expire
- [ ] Multi-target damage scales correctly
- [ ] All combat events emitted
- [ ] Test: Full combat cycle works

---

## PHASE 3: World Content & OSM (4-5 Days)

**Why:** Unblocks world exploration, content iteration, NPC placement.

### Task 3.1: OSM Data Pipeline
- **New File:** `scripts/osm-import.ts`
- **What:** Convert OpenStreetMap → game zones
  - Load Stephentown area OSM data
  - Parse buildings, roads, POIs
  - Generate zone cells (e.g., 100m x 100m)
  - Create zone records in database
  - Assign starting zone as player spawn

### Task 3.2: Zone Generation
- **What:** Create Zone records with:
  - Position (world X, Y)
  - Boundaries (bounds_min, bounds_max)
  - Terrain type (grassland, urban, etc)
  - Description from OSM name
  - Content rating (T/M/AO - default T)

### Task 3.3: Navmesh Generation
- **What:** For each zone, define:
  - Walkable area (no buildings/obstacles)
  - Spawn points (safe locations)
  - Quest givers (NPCs)
  - Points of interest
  - Procedural or manual per zone

### Task 3.4: Seed Starter NPCs
- **What:** Create initial Companion records
  - Merchant (sells items, can trade)
  - Guard (patrols, greets players)
  - Innkeeper (provides services)
  - Quest-giver (starts simple quests)
  - Traits and dialogue unique per location

### Task 3.5: Test World Exploration
- Player spawns in Stephentown starter zone
- Can walk around (not wall through buildings)
- NPCs visible and interactive
- Proximity roster works in new zones

### Acceptance Criteria
- [ ] OSM data loaded into database
- [ ] Zones generated from geography
- [ ] Navmesh walkable
- [ ] NPCs placed and visible
- [ ] Test: Explore starter zone, talk to NPCs

---

## PHASE 4: Wildlife Integration (2-3 Days)

**Why:** Unblocks hunting, ecosystem gameplay, resource gathering.

### Task 4.1: Wildlife Sim Redis Bridge
- **File:** `.agents/wildlife_sim/src/redis_bridge.rs` (update)
- **What:** Connect Rust sim to game server
  - Listen for zone setup messages
  - Publish wildlife events (spawn, move, death)
  - Receive player actions (hunt, interact)
  - Sync positions to game server

### Task 4.2: Wildlife Manager in Game
- **New File:** `src/wildlife/WildlifeManager.ts`
- **What:** Integrate wildlife events
  - Receive spawn events from sim
  - Add wildlife to zone entity map
  - Update proximity rosters
  - Track health/despawn on death

### Task 4.3: Hunting Mechanics
- **What:** Player can hunt wildlife
  - Target wildlife entity
  - Combat system applies (wildlife has stats/abilities)
  - On death, drop loot table items
  - Corpse despawns after timeout
  - Respawn sim spawns replacement

### Task 4.4: Test Hunting
- Rabbits/foxes visible in Stephentown
- Can target and attack
- Get drops (meat, hides)
- New ones respawn over time

### Acceptance Criteria
- [ ] Wildlife visible in proximity roster
- [ ] Combat system works for wildlife
- [ ] Loot drops on death
- [ ] Test: Hunt rabbits, get meat/hide

---

## Summary Table

| Phase | Task | Duration | Files | Status |
|-------|------|----------|-------|--------|
| 1 | NPC Intent | 3-4 days | 5 files | Design done |
| 2 | Combat | 5-7 days | 4 files | Partial impl |
| 3 | OSM + Zones | 4-5 days | 4 files | Not started |
| 4 | Wildlife | 2-3 days | 2 files | Rust sim exists |
| **TOTAL** | | **14-19 days** | | **Ready** |

---

## For Next Session

1. **Pick Phase 1** and start with Task 1.1 (Prisma schema update)
2. Reference **[IMPLEMENTATION_ROADMAP.md](docs/IMPLEMENTATION_ROADMAP.md)** for detailed code examples
3. All file paths are accurate and verified
4. Time estimates are realistic with experienced dev

Good luck! The architecture is solid, the pieces are there, you're just connecting them now.
