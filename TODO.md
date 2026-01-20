# TODO - Ashes & Aether Server

Last updated: 2026-01-20

## Vision

**The 37-Hour War transformed everything.** Build a post-apocalyptic MMO set in upstate New York, 100 years after AI-deployed nanotech changed humanity forever. Real geography. Six client modalities. One persistent world.

See [docs/LORE.md](docs/LORE.md) for complete world background.

## Current Status - January 2026

**MILESTONE: Distributed architecture & text client working. Airlock ready for NPC context integration. Wildlife sim in Rust prototype.**

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
- NPC/Companion system with database schema ready for LLM integration
- LLMService (Anthropic + OpenAI-compatible API support)
- **Wildlife Simulation** (Rust) - Flora/fauna with hunger/thirst/reproduction, climate, behavior trees
- Stat system (core + derived stats) with ability loadouts
- Basic auto-attack mechanics with +/- hit feedback

**Partially Done:**

- Combat system (ATB design complete, basic auto-attack working, missing: cooldown system, action queue, status effects)
- NPC AI control (Airlock connected, but needs: context items, intent generation, action validation)
- World content (no OSM integration yet, no NPC placement)

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

## Recommended Next Steps

### Phase 1: Complete Core Systems (Weeks 1-2)

1. **NPC Context & Intent System**
   - Expand Companion schema with personality context items (traits, goals, relationships)
   - Add action sets (abilities, dialogue trees, movement patterns)
   - Implement intent parsing (convert LLM responses to zone commands)
   - Wire NPCAIController to actually call LLMService
   - **Unblocks:** Airlock NPC control, dynamic NPC behavior

2. **Combat System Completion**
   - Finish cooldown system and action queue
   - Add status effects and effect duration tracking
   - Implement multi-target scaling and AoE targeting
   - Wire all combat events (hit/miss/effect/death)
   - **Unblocks:** Full tactical gameplay, ability testing

3. **World Content Foundation**
   - OpenStreetMap integration for Stephentown region
   - Zone generation from real geography
   - Basic NPC placement (merchants, guards, quest-givers)
   - **Unblocks:** Real world exploration, content iteration

### Phase 2: Expand Features (Weeks 3-4)

1. **Text Client Enhancement**
   - Command improvements (examine, inspect, detailed look)
   - Combat UI refinement
   - Macro system expansion
   - Test with live combat

2. **Wildlife Sim Integration**
   - Wire Rust sim to game server via Redis
   - Visibility in proximity rosters
   - Player hunting mechanics
   - Respawn system

3. **Basic Quest System**
   - Quest database schema
   - Simple quest generation
   - Objective tracking
   - Rewards system

### Phase 3: Polish & Clients (Months 2-3)

1. **LLM Narrator System**
   - Context-aware narration for critical moments
   - Dice integration (failed = vague, success = detailed)
   - Personality tone consistency

2. **2D Web Client**
   - Browser-based isometric/top-down view
   - Point-and-click interface
   - Shared protocol with text client

3. **Documentation & Tooling**
   - Quest creation tools
   - NPC personality templates
   - World editing utilities

## Technical Implementation Priority

### Critical Path to Playable World

1. **NPC Intent System** (3-4 days)
   - [ ] Extend Companion schema with context items
   - [ ] Implement intent parser (chat/emote/move/action)
   - [ ] Wire NPCAIController.update() → LLMService → intent execution
   - [ ] Test Airlock → NPC interaction end-to-end

2. **Combat Completion** (5-7 days)
   - [ ] Implement action queue with cast times
   - [ ] Add cooldown system with stat scaling
   - [ ] Implement status effects (buffs/debuffs/DoT)
   - [ ] Add AoE and multi-target damage
   - [ ] All combat events: hit/miss/effect/death
   - [ ] Integration test: player vs NPC/wildlife

3. **OSM Integration** (4-5 days)
   - [ ] Load OSM data for Stephentown region
   - [ ] Generate zones from locations
   - [ ] Create zone boundaries and navmesh
   - [ ] Seed basic NPCs and props

4. **Wildlife Integration** (2-3 days)
   - [ ] Wire wildlife_sim to game server via Redis
   - [ ] Visibility in proximity rosters
   - [ ] Player hunting/loot mechanics
   - [ ] Spawn respawn system

### Full Development Timeline

**Week 1-2:**

- [ ] NPC Intent system complete
- [ ] Combat system finished
- [ ] Text client combat UI polish
- [ ] Basic end-to-end test (create char → move → fight NPC → damage/heal)

**Week 3-4:**

- [ ] OSM integration
- [ ] Wildlife integration  
- [ ] Basic quest system
- [ ] World content (5+ starter zones)

**Month 2:**

- [ ] 2D web client (basic)
- [ ] LLM narrator system
- [ ] Advanced NPC behaviors (wandering, routines)
- [ ] Faction reputation system

**Month 3+:**

- [ ] 3D client (Unity)
- [ ] Advanced combat features
- [ ] Crafting system
- [ ] Housing/bases
- [ ] PvP/faction wars

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
