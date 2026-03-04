# TODO - Ashes & Aether Server

Last updated: 2026-03-04

## Vision

**The 37-Hour War transformed everything.** Build a post-apocalyptic MMO set in upstate New York, 100 years after AI-deployed nanotech changed humanity forever. Real geography. Six client modalities. One persistent world.

See [docs/LORE.md](docs/LORE.md) for complete world background.

## Current Status - March 2026

**MILESTONE: Distributed architecture solid. Companion system with behavior trees and LLM-driven combat live. Ability trees defined. Scripting engine (Lua) functional. Wildlife/flora sim connected.**

**Architecture:**

- **Gateway Server**: Handles all client WebSocket connections, routes messages via Redis
- **Zone Server(s)**: Process game logic for assigned zones, calculate proximity, run AI
- **Message Bus**: Redis pub/sub connects all servers in real-time
- **Zone Registry**: Tracks which zones are on which servers, player locations
- **Proximity Roster System**: Fully functional across distributed zones

**What's Working:**

- Single-shard world (everyone shares same universe, not "World 1, World 2")
- Zones distributed across multiple physical machines
- Players seamlessly interact across server boundaries
- Gateway servers handle 10k+ concurrent connections
- Zone servers scale based on player density per zone
- Automatic health monitoring via Redis heartbeats
- Database persistence (PostgreSQL + Prisma)
- Movement and proximity detection with spatial navigation
- Proximity roster optimization (dirty tracking - 70-90% reduction in network traffic)
- **Text Client (MUD-Like)** - C# .NET client with movement ring, proximity roster, auto-attack UI
- **Airlock Protocol** - LLM client control with inhabit/release/chat flow
- LLMService (Anthropic + OpenAI-compatible API support)
- Stat system (core + derived stats) with ability loadouts
- Basic auto-attack mechanics with +/- hit feedback
- **Companion System** - Behavior tree ("motor cortex"), 4 combat archetypes (scrappy_fighter, cautious_healer, opportunist, tank), LLM-driven combat settings, engagement gate with species/family overrides, follow/detach/task/harvest/recall commands
- **Companion Task System** - LLM generates behavior trees from natural language, throttled execution, harvest tasks working
- **Wildlife/Flora Simulation** - Connected to game server. Flora growth stages, harvesting, wildlife consumption, respawning. Integrates with companion harvest tasks
- **Ability Trees** - Two webs (Active/Passive), 4 tiers, 6 sectors (66 nodes). T1 abilities defined: Provoke, Mend, Shadow Bolt, Embolden, Ensnare. AP pool shared across webs
- **NPC AI** - Social layer (chat/emote via LLM) + combat layer (behavior tree + LLM triggers). Engagement gate functional
- **Scripting Engine** - Fengari Lua VM with sandboxed world API. Scripted objects, verb callbacks, NPC dialogue trees
- **Villages, Market, Arena, Vault** systems in various stages (recent commits)

**Partially Done:**

- Combat system (ATB gauge + cooldowns implemented, T1 abilities defined; missing: status effect execution, taunt/root wiring, AoE damage, action queue with cast times)
- Airlock Protocol (connected but needs revisit — companions are now real entities, NPCs need user inhabitation flow reworked)
- World content (no live zone generation yet, no OSM integration)
- Companion task system (harvest works; hasItem condition stubbed, limited action/condition set)

**Setting:**

- **Post-apocalyptic upstate New York** (Stephentown NY, Berkshire County MA, Rensselaer/Albany Counties NY)
- Real geography from OpenStreetMap
- 100 years after The 37-Hour War
- Nanotech-transformed humans (werewolves, vampires, dragons, psionics, cyber-enhanced, mages)
- Corruption zones, faction conflicts, mysteries

**Planned Client Modalities:**

1. **Text Client** (MUD/MOO style) - Classic text commands
2. **LLM Airlock** - Natural language interface with AI Narrator
3. **2D Client** - Web-based point-and-click (isometric/top-down)
4. **3D Client** - Traditional MMO (Unity/Godot, keyboard+mouse)
5. **VR Client** - Full immersion (optional)
6. **AR Client** - Real-world exploration (GPS-based)

All clients connect to the same server, see the same world, interact with same players.

## MVP Critical Path

These are the remaining blockers to a playable world.

### 1. Combat System Completion

The ATB gauge, cooldown tracking, and T1 ability definitions are in place. What remains:

- [ ] Wire taunt mechanic (Provoke forces target switch)
- [ ] Wire root mechanic (Ensnare prevents movement)
- [ ] Implement status effect execution (buff/debuff apply + tick + expire)
- [ ] Action queue with cast times
- [ ] AoE and multi-target damage
- [ ] Death handling and respawn flow
- [ ] Integration test: player vs NPC/wildlife end-to-end

**Unblocks:** Full tactical gameplay, ability testing, companion combat validation

### 2. Airlock Revisit

The Airlock protocol works but was built before companions became real entities. Needs rework:

- [ ] Rethink inhabit/release flow for companion NPCs vs world NPCs
- [ ] Wire NPC intent system (LLM response → zone commands: move/attack/interact)
- [ ] Context injection (companion personality, nearby entities, combat state, quest state)
- [ ] Action validation (can this NPC actually do what the LLM says?)
- [ ] Test end-to-end: user inhabits NPC → speaks/moves/fights via natural language

**Unblocks:** LLM-driven NPC gameplay, natural language client experience

### 3. Live Zone Generation

Zones need to generate dynamically from real geography, not be hand-seeded:

- [ ] OSM data pipeline for Stephentown region
- [ ] Dynamic zone generation from geographic features (roads, buildings, terrain)
- [ ] Zone boundary calculation and navmesh generation
- [ ] Auto-populate with NPCs, flora, wildlife based on biome/terrain
- [ ] Hot-loading: generate new zones as players explore outward

**Unblocks:** Real world exploration, scalable content, no manual seeding

## Next Priorities (Post-MVP)

### Companion System Polish
- [ ] CC ability detection in BehaviorTree (currently stubbed)
- [ ] Wire hasItem condition to InventoryService
- [ ] Expand task LLM with more conditions (enemies nearby, zone type) and actions (combat, trade)
- [ ] Multi-companion support/testing

### Ability System Expansion
- [ ] T2-T4 ability definitions
- [ ] Quest gates for T4 capstones
- [ ] Depth-gate enforcement (must unlock prior tier)
- [ ] Balance pass on stat scaling

### Text Client Enhancement
- Command improvements (examine, inspect, detailed look)
- Combat UI refinement for new ability system
- Macro system expansion
- Test with live combat

### Basic Quest System
- Quest database schema
- Simple quest generation
- Objective tracking
- Rewards system

### LLM Narrator System
- Context-aware narration for critical moments
- Dice integration (failed = vague, success = detailed)
- Personality tone consistency

### 2D Web Client
- Browser-based isometric/top-down view
- Point-and-click interface
- Shared protocol with text client

## Quick Start

### Development (Single Machine)

```powershell
# Terminal 1: Start Redis
redis-server

# Terminal 2: Launch Gateway + Zone Server
./start-distributed.ps1

# Terminal 3: Test client
node test-client.js
```

### Production (Multiple Machines)

See [DISTRIBUTED.md](DISTRIBUTED.md) for zone assignment examples.
