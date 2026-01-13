# Ashes & Aether - Vision Document

## The Big Idea

**One persistent world. Six ways to experience it. Real geography. Distributed architecture.**

A post-apocalyptic MMO set in upstate New York, 100 years after The 37-Hour War transformed humanity forever through AI-deployed nanotech.
The Shatterline cuts across the region, bleeding anomalies into the world and redrawing every border.

## What Makes This Different

### 1. Single-Shard Architecture

No "World 1, World 2" separation. Everyone plays in the same universe. Meet anyone, anywhere, regardless of which client they use.

### 2. Real Geography

- **Actual locations**: Stephentown NY, Berkshire County MA, Rensselaer/Albany Counties NY
- **OpenStreetMap data**: Real roads, real buildings, real landmarks
- **Transformed by The Event**: Familiar places made strange and dangerous
- **AR compatibility**: GPS coordinates = game coordinates

### 3. Six Client Modalities

All connect to the same server, see the same world, interact with the same players:

**Text Client (MUD/MOO)**

- Classic text commands (`look`, `move`, `say`, `examine`)
- Screen reader accessible
- Low bandwidth, work-friendly
- Pure nostalgia for MUD veterans

**LLM Airlock**

- Natural language interface
- AI Narrator for critical moments
- LLM-controlled NPCs
- Dynamic storytelling

**2D Client (Web)**

- Browser-based, isometric/top-down
- Point-and-click interface
- Quick sessions, guild management
- Low-spec friendly

**3D Client (Unity/Godot)**

- Traditional MMO experience
- Keyboard + mouse controls
- Full 3D world, no VR required
- Main experience for many

**VR Client**

- Full immersion option
- Same world as other clients
- Hand tracking, voice commands
- Deep dive experience

**AR Client (Mobile)**

- GPS-based real-world exploration
- Camera overlay
- Walk around actual Stephentown
- Casual play, exercise + gaming

### 4. The Unreliable Narrator

An AI voice that appears during critical moments:

- When you roll dice
- When danger approaches
- When you discover something
- When you make choices

**The Narrator never lies... but doesn't tell you everything.**

- Perception success: "You notice fresh claw marks on the stone..."
- Perception failure: "You hear scratching in the distance..." [silence]
- Critical failure: "Everything seems fine." [It is not fine]

Players learn to read the Narrator's tone, silences, and level of detail.

### 5. Distributed Server Architecture

**Gateway Server(s)** → **Redis Pub/Sub** → **Zone Server(s)** → **PostgreSQL**

- Horizontal scaling by zone distribution
- Geographic sharding (NYC zones on East Coast server, etc.)
- Handles thousands of concurrent players
- Seamless player transitions between zones/servers

## The Setting

### The 37-Hour War (100 Years Ago)

World War III was declared. Nukes launched... but never landed.

For exactly 37 hours, AI-deployed nanotech swept the planet:

- Billions died
- Humanity transformed
- Reality became flexible
- "Magic" became real (or indistinguishable from it)

Then it stopped. The AI vanished. The questions remain.

### The Changed

Some barely changed. Others transformed completely:

- **Shifted** - Werewolf characteristics, can change forms
- **Scaled** - Dragon/reptilian features, some breathe fire
- **Vampiric** - Blood dependency, enhanced senses, sun sensitivity
- **Stone-Kin** - Rock-hard hides, incredible durability
- **Psionics** - Mind powers, telekinesis, telepathy
- **Cyber-Fused** - Nanotech merged with flesh, living machines
- **Witches/Mages** - Consciously manipulate nanotech ("cast spells")
- **True Dragons** - Rare, massive, reality-warping
- **Naturals** - Mostly unchanged humans, adaptable survivors

### The Region

**Upstate New York Testing Grounds**

This area experienced unique anomalies during The Event:

- Higher transformation rates
- Nanotech corruption zones
- Reality fluctuations
- Frozen missiles still visible in the sky

**Key Locations:**

- **Stephentown, NY** - Starting town, trading hub, Covered Bridge Portal
- **Albany, NY** - Capitol building now Vampire court, political intrigue
- **Troy, NY** - Industrial district, cyber-enhanced stronghold
- **Berkshire Mountains** - Dragon territory, Mt. Greylock claimed
- **Hudson River** - Corruption flow, mutated creatures, danger

### Mysteries

- Where are the nukes? (Some frozen mid-air)
- What happened to the AI?
- Why exactly 37 hours?
- What was the purpose?
- **Will it happen again?**

## Technical Philosophy

### Server Architecture

**Built for scale from day one:**

- Distributed zones across servers
- Redis message bus
- Single-shard world state
- PostgreSQL persistence
- Horizontal scaling

**Six clients, one protocol:**

- All send same messages (`move`, `chat`, `interact`)
- All receive same updates (`proximity_roster`, `world_state`)
- Client type doesn't matter to server
- Add new client types easily

### Development Priorities

**Phase 1: Foundation**

1. Text client (fastest validation)
2. Narrator system
3. OpenStreetMap world generation

**Phase 2: Intelligence**
4. LLM airlock
5. NPC AI
6. Dynamic content

**Phase 3: Expansion**
7. 2D web client
8. 3D client
9. AR/VR prototypes

### Design Principles

**Accessibility First**

- Text client = screen reader compatible
- Multiple difficulty modes
- Colorblind-friendly UI
- Adjustable text size
- No pay-to-win

**Hobby Project Values**

- Take our time
- Iterate freely
- Experiment boldly
- No deadlines
- Quality over speed

**Community Focused**

- Single shard = everyone together
- Cross-client interaction
- Real geography = local communities
- Emergent storytelling
- Player-driven economy

## The Experience

### AR Player

"I'm walking to the coffee shop. My phone shows corruption zones glowing near the old covered bridge. I collect nanotech essence. A dragon alert pops up - someone spotted one at Mt. Greylock."

### VR Player

"I'm standing in the transformed Stephentown square. Around me, other players - some human, some Changed. I see the text player who just said hello. I wave. They see it. We team up for a raid."

### Text Player

```
> look
You stand in Stephentown Square. The old church looms to the north,
its steeple wrapped in corruption tendrils. A VR player waves at you.

> wave back
You wave at the cyber-enhanced warrior.

Narrator: "They smile. You sense no threat... yet."
```

### 3D Player

"I'm exploring the Berkshire Mountains in full 3D. My keyboard controls feel natural. I spot an AR player's marker - they're at the actual location IRL. We both investigate the same corruption zone, them with their phone camera, me with my PC."

**All in the same world. All experiencing the same event. All making choices that matter.**

## Why This Can Work

### Nobody Else Is Doing This

**Pokémon GO** - AR only, different world from main games
**WoW** - Desktop only, separate mobile companion apps
**VRChat** - VR focused, not an MMO
**Traditional MMOs** - One client type, separate servers

**We're building:**

- One world
- All client types
- Same server
- Real geography
- Distributed architecture
- Six modalities

### Technical Feasibility

**We already have:**

- Distributed server architecture
- Message bus (Redis)
- Database persistence
- Proximity system
- Real-time updates

**We need to add:**

- Text client (easiest)
- LLM integration (partially done)
- Map generation (OpenStreetMap APIs available)
- Additional clients (progressive enhancement)

### Market Gap

**Who plays this?**

- MUD veterans (text client)
- Modern MMO fans (3D client)
- Casual mobile players (2D web, AR)
- VR enthusiasts (VR client)
- Accessibility-focused players (text, narrator)
- Local communities (real geography)

**That's... everyone.**

## The Pitch

**"The war lasted 37 hours. The transformation will last forever."**

**"Your neighborhood survived. But nothing will ever be the same."**

**"One world. Six realities. Your choice how to experience it."**

**"Explore the transformed landscape of upstate New York, 100 years after the AI changed everything. Your hometown is still there... but so are the dragons."**

---

## For Developers

This is a **hobby project**. We iterate. We experiment. We build what's fun.

**Current Status:**

- Server architecture: ✅ Complete
- Distributed zones: ✅ Complete
- Database: ✅ Working
- Proximity system: ✅ Working

**Next Steps:**

- Text client (prove the concept)
- Narrator system (add the magic)
- World generation (make it real)

**Timeline:**

- There isn't one
- It's done when it's fun
- We pivot when inspired
- Quality matters more than speed

---

*"In this Ashes & Aether, some still find the light."*

**Welcome to the project. Let's build something amazing.**
