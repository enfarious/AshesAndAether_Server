# World of Darkness MMO - Server Architecture

## Overview
A modular monolithic server architecture built with Node.js/TypeScript, designed to support multiple client types (text, 2D, 3D, VR) with tactical combat, AI companions, and wildlife simulation.

## Core Design Principles

1. **Client Agnostic**: All game logic on server, clients are thin presentation layers
2. **Deterministic Simulation**: Server is source of truth for all game state
3. **Scalable from Day One**: Modular design allows easy extraction to microservices later
4. **AI-First**: LLM integration for NPCs and companions as first-class citizens
5. **Tactical Combat**: Turn-based or phase-based combat with planning windows

## Technology Stack

- **Runtime**: Node.js 20+ with TypeScript 5+
- **Networking**: WebSocket (Socket.io) for real-time + REST API for auxiliary services
- **Database**: PostgreSQL (persistent data) + Redis (real-time state, caching, pub/sub)
- **ORM**: Prisma (type-safe database access)
- **Pathfinding**: Custom navmesh implementation or library like `navmesh` npm package
- **AI/LLM**: Anthropic Claude API, OpenAI API, or local models via Ollama

## Server Modules

### 1. Network Layer (`/src/network`)
Handles all client connections and message routing.

**Components**:
- **WebSocketServer**: Real-time bidirectional communication
- **RESTServer**: HTTP API for authentication, character creation, static data
- **MessageRouter**: Routes incoming messages to appropriate handlers
- **ClientSession**: Manages individual client connection state

**Key Features**:
- Protocol abstraction (same game events for all client types)
- Heartbeat/ping for connection health
- Message queue with priority system
- Rate limiting and validation

### 2. World Management (`/src/world`)
Manages game world state, zones, and spatial data.

**Components**:
- **WorldManager**: Top-level world state coordinator
- **Zone**: Individual map regions with their own update loops
- **NavMesh**: Navigation mesh for pathfinding
- **TerrainData**: Environmental data (elevation, water, cover, etc.)
- **SpatialIndex**: Fast entity lookup by position (quad-tree or grid)

**Key Features**:
- Zone instancing support (for solo/group content)
- Dynamic loading/unloading of zones based on player presence
- Environmental effects (weather, time of day, lighting)
- Persistent world changes (player-built structures, terrain damage)

### 3. Entity System (`/src/entities`)
Entity Component System (ECS) for all game objects.

**Components**:
- **EntityManager**: Creates, destroys, and tracks all entities
- **Component Types**:
  - `Transform`: Position, rotation, velocity
  - `Health`: HP, stamina, injuries
  - `Stats`: Attributes (strength, agility, etc.)
  - `Inventory`: Items and equipment
  - `AI`: Behavior state, goals, blackboard
  - `Wildlife`: Hunger, thirst, fatigue, reproduction
  - `Supernatural`: Powers, blood/essence, humanity
  - `CombatState`: Initiative, actions, targeting
  - `Faction`: Allegiances, reputation

**Entity Types**:
- Player characters
- AI companions (LLM-driven)
- NPCs (scripted behaviors)
- Wildlife (life simulation)
- Items/objects
- Environmental hazards

### 4. Pathfinding (`/src/pathfinding`)
Navigation and movement planning.

**Components**:
- **NavMeshBuilder**: Generates navigation meshes from terrain data
- **PathPlanner**: A* or hierarchical pathfinding
- **MovementController**: Executes movement along paths
- **ObstacleAvoidance**: Dynamic obstacle handling

**Key Features**:
- Multi-layer navmesh (ground, water, air, climbing)
- Dynamic obstacles (moving entities, temporary barriers)
- Group movement coordination
- Cover and tactical position evaluation

### 5. Combat System (`/src/combat`)
Tactical, phase-based combat with planning windows.

**Components**:
- **CombatManager**: Orchestrates all active combats
- **EncounterInstance**: Individual combat encounter
- **TurnScheduler**: Initiative and action ordering
- **ActionResolver**: Validates and executes combat actions
- **TargetingSystem**: Line of sight, range, cover calculations

**Combat Flow**:
1. **Detection Phase**: Enemies detected, combat initiates
2. **Planning Phase**: Players/AI choose actions (30-60s window)
3. **Resolution Phase**: Actions resolve in initiative order
4. **Update Phase**: Status effects, environment, positioning
5. Repeat or end combat

**Key Features**:
- Simultaneous action declaration (fog of war on enemy plans)
- Combo/synergy system for team coordination
- Environmental interaction (cover, elevation, hazards)
- Status effects and conditions

### 6. AI System (`/src/ai`)
Manages all non-player entity behaviors.

**Components**:
- **AIDirector**: Coordinates all AI processing
- **BehaviorTree**: For scripted NPCs and wildlife
- **LLMController**: Manages LLM API calls for companions
- **LifeSimulation**: Wildlife needs (hunger, thirst, reproduction, etc.)
- **PackBehavior**: Group/pack dynamics

**AI Tiers**:
1. **Wildlife**: Simple behavior trees + life simulation
2. **NPCs**: Scripted behaviors, dialogue trees
3. **LLM Companions**: Full language understanding, personality, memory
4. **Hybrid**: NPCs that can escalate to LLM for complex interactions

**Life Simulation (Wildlife)**:
- Needs: Hunger, thirst, fatigue, pain, reproductive drive
- Behaviors: Foraging, hunting, drinking, resting, mating, fleeing
- Aging: Growth, maturity, old age, death
- Social: Pack formation, territory, dominance
- Seasonal/circadian rhythms

### 7. Database Layer (`/src/database`)
Persistence and caching.

**Components**:
- **Prisma Schema**: Database models
- **Repository Pattern**: Data access abstraction
- **CacheManager**: Redis caching strategies
- **StatePersistence**: Saving/loading world state

**Data Models**:
- Accounts and authentication
- Characters (players, companions)
- World state (persistent changes)
- Items and inventories
- Factions and relationships
- LLM conversation history

### 8. Game Systems (`/src/systems`)
Domain-specific game logic.

**Modules**:
- **CharacterProgression**: Leveling, skills, abilities
- **CraftingSystem**: Item creation, modification
- **QuestSystem**: Story progression, objectives
- **FactionSystem**: Reputation, politics
- **SupernaturalPowers**: Custom supernatural abilities
- **EconomySystem**: Currency, trading, markets

### 9. LLM Integration (`/src/llm`)
Manages AI companions and dynamic NPCs.

**Components**:
- **LLMProvider**: Abstract API interface (Claude, GPT, local)
- **ConversationManager**: Maintains context and history
- **PersonalityEngine**: Character personalities and memories
- **ActionTranslator**: Converts LLM intent to game actions

**Key Features**:
- Companion memory (short-term and long-term)
- Personality traits and goals
- Combat decision-making via LLM
- Dynamic dialogue generation
- Relationship tracking with players

## Communication Protocols

### Client-Server Protocol
All messages are JSON over WebSocket or HTTP.

**Message Structure**:
```typescript
{
  type: string,        // Message type (e.g., "move", "attack", "chat")
  payload: object,     // Type-specific data
  timestamp: number,   // Client timestamp
  sequence: number     // Message sequence number
}
```

**Core Message Types**:
- `auth`: Authentication
- `move`: Movement commands
- `action`: Combat/interaction actions
- `chat`: Text communication
- `state_update`: Server state broadcasts
- `combat_plan`: Combat action planning
- `companion_command`: Direct companion control

### State Synchronization
- **Interest Management**: Clients only receive updates for nearby entities
- **Delta Compression**: Only send changed data
- **Priority Queue**: Important updates (combat) sent before minor updates (distant wildlife)

## Performance Considerations

### Scalability
- **Horizontal Scaling**: Multiple server instances behind load balancer
- **Zone Sharding**: Distribute zones across servers
- **Database Read Replicas**: Separate read/write operations
- **Redis Pub/Sub**: Cross-server communication

### Optimization
- **Spatial Partitioning**: Only process entities in active zones
- **Update Frequency Tiers**: Different tick rates for different systems
  - Combat: 10-20 TPS (ticks per second)
  - Movement: 5-10 TPS
  - Wildlife: 1-2 TPS
  - Environment: 0.1-1 TPS
- **Lazy Loading**: Load entities/data on-demand
- **Object Pooling**: Reuse frequently created/destroyed objects

## Development Phases

### Phase 1: Foundation (Current)
- Project setup, dependencies
- Basic networking (WebSocket + REST)
- Database schema and ORM
- Simple world with zones
- Entity system skeleton

### Phase 2: Core Systems
- Pathfinding and movement
- Basic combat system
- Wildlife AI and life simulation
- Text client protocol

### Phase 3: Advanced Features
- LLM integration for companions
- Full tactical combat
- Character progression
- 2D client support

### Phase 4: Content & Polish
- Quest system
- Supernatural powers
- 3D client support
- Content creation tools

### Phase 5: Future
- VR client support
- Advanced faction systems
- Player housing/bases
- Large-scale PvP/RvR

## Security Considerations

- **Server Authority**: All validation server-side
- **Rate Limiting**: Prevent spam and abuse
- **Input Validation**: Sanitize all client input
- **Authentication**: JWT tokens with refresh mechanism
- **Anti-Cheat**: Server-side movement validation, action validation
- **LLM Safety**: Content filtering, prompt injection protection

## Monitoring & Observability

- **Logging**: Structured logging with Winston or Pino
- **Metrics**: Prometheus + Grafana for server health
- **Tracing**: OpenTelemetry for distributed tracing
- **Error Tracking**: Sentry or similar
- **Performance Profiling**: Node.js profiler, heap snapshots

## Next Steps

1. Set up Node.js/TypeScript project structure
2. Install core dependencies (Socket.io, Prisma, etc.)
3. Create database schema
4. Implement basic networking layer
5. Build simple world with pathfinding
6. Create text client for testing
