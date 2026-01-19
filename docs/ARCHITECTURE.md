# Ashes & Aether MMO - Server Architecture

## Overview
Distributed Node.js/TypeScript server with a Gateway/Zone split and Redis pub/sub. The Gateway handles client WebSocket connections; Zone servers run authoritative simulation (movement, proximity, combat, AI, wildlife).

## Core Principles

1. **Server-authoritative**: All validation and simulation run on the server.
2. **Client-agnostic**: Multiple client modalities (MUD, 2D, 3D, VR) use the same protocol.
3. **Distributed by default**: Zones can be scaled horizontally via Redis messaging.
4. **Delta-first state**: Proximity roster deltas and state_update deltas keep bandwidth low.
5. **Command-first input**: Slash commands resolve to validated server events.

## Runtime Stack

- **Runtime**: Node.js 20+ with TypeScript 5+
- **Networking**: Socket.IO + REST (auth/info/health)
- **Database**: PostgreSQL (persistent data)
- **Messaging**: Redis pub/sub (Gateway ⇆ Zone)
- **ORM**: Prisma
- **LLM**: OpenAI/Claude compatible or local (Ollama/LMStudio)

## High-Level Topology

```
Clients (MUD/2D/3D/VR)
  ↕ Socket.IO
Gateway Server (auth + socket router)
  ↕ Redis pub/sub
Zone Servers (simulation)
  ↕ PostgreSQL
```

## Server Responsibilities

### Gateway Server (`/src/gateway`)
Handles client connections and authentication, and forwards all game actions to Zone servers.

**Key responsibilities**
- Socket.IO handshake/auth
- Character select/create
- Routing messages to Zone servers via Redis
- Serving static web content + API endpoints (`/health`, `/api/info`)

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
