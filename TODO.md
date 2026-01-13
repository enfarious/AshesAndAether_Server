# TODO - Ashes & Aether Server

Last updated: 2026-01-10

## Vision

**The 37-Hour War transformed everything.** Build a post-apocalyptic MMO set in upstate New York, 100 years after AI-deployed nanotech changed humanity forever. Real geography. Six client modalities. One persistent world.

See [LORE.md](LORE.md) for complete world background.

## Current Status

**MILESTONE: Distributed architecture complete!**

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
- Database persistence (PostgreSQL)
- Movement and proximity detection
- Proximity roster optimization (dirty tracking - 70-90% reduction in network traffic)
- Spatial navigation (bearing/elevation/range for all entities)
- NPC system ready with LLM integration (Anthropic, OpenAI-compatible)

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

### Phase 1: World Building (Current Focus)

1. **OpenStreetMap Integration**
   - Import real geography data for starting region
   - Generate zones from actual locations
   - Seed database with landmarks as POIs
   - Add corruption zones and nanotech anomalies

2. **Narrator System**
   - Build AI narrator for critical moments
   - Integrate with dice rolls (failed = vague, success = detailed)
   - Context-aware narration (danger, exploration, combat)
   - Never lies, but doesn't tell everything

3. **Text Client (Priority)**
   - Classic MUD-style interface
   - Command parser (`look`, `move`, `examine`, `say`, etc.)
   - Proves server architecture works
   - Foundation for other clients
   - Fastest to build and test

### Phase 2: LLM Integration

1. **LLM Airlock Completion**
   - Natural language command processing
   - LLM-controlled NPCs
   - Dynamic dialogue system
   - Narrator personality and tone

2. **NPC Intelligence**
   - LLMs control NPC behavior
   - Contextual responses
   - Quest generation
   - Faction interactions

### Phase 3: Additional Clients

1. **2D Web Client**
   - Browser-based, top-down view
   - WebGL or Canvas rendering
   - Point-and-click interface
   - Guild management features

2. **3D Client (Unity/Godot)**
   - Traditional MMO experience
   - Full 3D rendering of upstate NY
   - Keyboard+mouse controls
   - No VR required

3. **AR Client**
   - Mobile GPS-based exploration
   - Real-world location = game location
   - Camera overlay
   - Casual/exploration focus

4. **VR Client**
   - Full immersion option
   - Same world as other clients
   - Hand tracking, voice commands
   - Deep dive experience

## Technical Roadmap

**Immediate (Week 1-2):**

- [ ] Test distributed server with Redis
- [ ] Build basic text client
- [ ] Implement core commands (move, look, say, examine)
- [ ] Add narrator responses to actions

**Short-term (Month 1):**

- [ ] Import OpenStreetMap data for Stephentown region
- [ ] Generate zones from real geography
- [ ] Implement LLM narrator system
- [ ] Build NPC AI with LLM control
- [ ] Add dice rolling mechanics
- [ ] Create character races (Changed types)

**Medium-term (Months 2-3):**

- [ ] Expand to full 4-county region
- [ ] Build 2D web client
- [ ] Implement crafting system
- [ ] Add corruption zones with dynamic effects
- [ ] Faction system and reputation
- [ ] Quest generation via LLM

**Long-term (Months 4-6):**

- [ ] 3D client (Unity/Godot)
- [ ] Combat system refinement
- [ ] AR client prototype
- [ ] Player housing and building
- [ ] Dynamic world events
- [ ] VR client (if time/interest)

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
