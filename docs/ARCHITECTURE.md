# Ashes & Aether MMO - Server Architecture

## Overview
Distributed Node.js/TypeScript server with a Gateway/Zone split and Redis pub/sub. The Gateway handles client WebSocket connections; Zone servers run authoritative simulation (movement, proximity, combat, AI, wildlife).

**See also:** [RESPONSIBILITY_MATRIX.md](RESPONSIBILITY_MATRIX.md) - Clarifies what lives where (server vs Airlock vs wildlife_sim).

## Core Principles

1. **Server-authoritative**: All validation and simulation run on the server.
2. **Client-agnostic**: Multiple client modalities (MUD, 2D, 3D, VR) use the same protocol.
3. **Distributed by default**: Zones can be scaled horizontally via Redis messaging.
4. **Delta-first state**: Proximity roster deltas and state_update deltas keep bandwidth low.
5. **Command-first input**: Slash commands resolve to validated server events.
6. **Lean core**: Interpretation (LLM), wildlife simulation, and NPC reasoning live in separate services.

## Runtime Stack

- **Runtime**: Node.js 20+ with TypeScript 5+
- **Networking**: Socket.IO + REST (auth/info/health)
- **Database**: PostgreSQL (persistent data)
- **Messaging**: Redis pub/sub (Gateway ⇆ Zone, also bridges external services)
- **ORM**: Prisma
- **LLM**: Handled by Airlock service (external), not server
- **Wildlife**: Handled by wildlife_sim (Rust, external), not server

## High-Level Topology

```
[MUD Text] [2D Client] [3D Client] [Airlock LLM] [Wildlife Sim]
    ↕           ↕          ↕            ↕            ↕
    └────── Socket.IO / Redis pub/sub ──────────────┘
              ↕
    [Gateway Server]
              ↕
         Redis pub/sub
              ↕
    [Zone 1] [Zone 2] [Zone N]
              ↕
         PostgreSQL
```

## Server Responsibilities

### Gateway Server (`/src/gateway`)
Handles client connections and authentication, and forwards all game actions to Zone servers. Also handles Airlock (NPC control).

**Key responsibilities**
- Socket.IO handshake/auth (regular clients and Airlock)
- Character select/create
- Airlock inhabitancy (which NPC does this session control?)
- Routing messages to Zone servers via Redis
- Serving static web content + API endpoints (`/health`, `/api/info`, `/world/assets`)

### Zone Server (`/src/zoneserver`)
Runs authoritative simulation for assigned zones.

**Key responsibilities**
- Movement tick + spatial updates
- Proximity roster + deltas
- Combat loop (ATB, auto-attack, events)
- NPC AI and chat context
- Wildlife simulation (spawning + movement)

## Core Modules

### Messaging (`/src/messaging`)
Redis pub/sub with typed envelopes.
- `MessageBus`: publish/subscribe
- `MessageType`: player actions, combat, command, client messages

### World & Movement (`/src/world`)
Zone-level simulation and movement system.
- `DistributedWorldManager`: authoritative per-zone coordinator
- `ZoneManager`: entity registry + proximity roster calculations
- `MovementSystem`: heading/target movement + persistence

### Command System (`/src/commands`)
Slash commands parse into validated, typed events.
- `CommandParser` → `CommandRegistry` → `CommandExecutor`
- Outputs events like `speech`, `movement_start`, `combat_action`

### Combat (`/src/combat`)
ATB-based combat with auto-attacks and ability validation.
- `CombatManager`: combat state + ATB + auto-attack timers
- `AbilitySystem`: load abilities (DB + in-memory)
- `DamageCalculator`: hit/miss + outcome flags (crit/pen/deflect/glance)

### Proximity & Protocol (`/src/network/protocol`)
Typed message contracts.
- `proximity_roster_delta`: spatial data for all nearby entities
- `state_update`: resource deltas and combat gauges
- `event`: combat events and narrative payloads

### AI + Wildlife (`/src/ai`, `/src/wildlife`)
NPC response hooks and wildlife simulation.
- Wildlife spawns + moves per-zone and is visible in proximity rosters.

## State Synchronization

- **Proximity**: Delta updates to roster (`proximity_roster_delta`) with spatial info (bearing/elevation/range).
- **Resources**: `state_update.character` deltas for HP/Stamina/Mana.
- **Combat UI**: `state_update.combat` for ATB + auto-attack timers.
- **Events**: `event` messages for combat hits, misses, deaths, etc.

## Authentication

- **Replit OIDC** in production.
- **Fake auth** in dev (configurable via `AUTH_MODE`).

## Scaling Model

- **Gateways**: Stateless, scale horizontally behind a proxy.
- **Zones**: Multiple Zone servers, each owning a subset of zones.
- **Redis**: Pub/sub for cross-server messaging.

## Current Gaps / Phase 2

- Party system (`state_update.allies`) and alliance layering
- Wildlife growth/aging affecting combat stats and levels
- Status effects/haste/slow and casting escrow

## Next Steps

1. Party core flows (invite/join/leave/kick) + ally gauges.
2. Wildlife growth/aging integration with combat stats.
3. Status effects + casting escrow.
