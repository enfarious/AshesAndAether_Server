# Ashes & Aether: Life on the Shatterline

An MMORPG of supernatural persuasions, featuring tactical combat, AI companions, and living wildlife ecosystems.

The Shatterline is a rift in upstate New York. No one returned from the first expeditions, but things return from it.
City-states cling to the old world with hard tech and harder borders while the wild grows clever and hungry.

## Overview

This is a custom-built MMO server designed to support multiple client types (text, 2D, 3D, VR) with an emphasis on:

- **Active Time Combat**: Real-time action with cooldowns - coordination and timing over rotations
- **AI Companions**: LLM-powered NPCs and companions with personalities and memory
- **Wildlife Simulation**: Dynamic ecosystem with basic life simulation (hunger, thirst, reproduction, aging)
- **Original Supernatural Setting**: Create your own path in a dark fantasy world

## Technology Stack

- **Server**: Node.js + TypeScript
- **Networking**: WebSocket (Socket.io) + REST API
- **Database**: PostgreSQL + Redis
- **ORM**: Prisma
- **AI/LLM**: Anthropic Claude API

## Project Structure

```
src/
├── network/        # WebSocket and REST networking
├── world/          # World management and zones
├── entities/       # Entity Component System
├── pathfinding/    # Navigation and pathfinding
├── combat/         # Tactical combat system
├── ai/             # AI behaviors and wildlife simulation
├── database/       # Database access layer
├── systems/        # Game systems (progression, crafting, etc)
├── llm/            # LLM integration for AI companions
└── utils/          # Shared utilities
```

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Redis 6+

### Installation

1. Install dependencies:

```bash
npm install
```

1. Copy environment variables:

```bash
cp .env.example .env
```

1. Configure your `.env` file with database credentials and API keys

2. Initialize the database:

```bash
npm run prisma:generate
npm run prisma:migrate
```

### Development

Start the development server with hot reload:

```bash
npm run dev
```

#### Running on Unique Ports (Testing on Live Machines)

When testing on a machine with running production servers, use unique ports to avoid conflicts:

```powershell
# Start gateway on test port (default: 3100, test: 212121)
./start-gateway.ps1 -ServerId "gateway-test" -Port 212121

# Start zone server with test ID
./start-zone.ps1 -ServerId "zone-test" -TickRate 10
```

This prevents port collisions and allows safe testing alongside live servers.

### Building

Build for production:

```bash
npm run build
npm start
```

### Testing

Run tests:

```bash
npm test
```

Run tests in watch mode:

```bash
npm run test:watch
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed architecture documentation.

## Game Design

### Combat System

Active Time Battle (ATB) system where every action has a cooldown - no pauses, no turns, just flowing combat. Timing is everything: coordinate with your team to layer abilities for devastating combos. A warrior's slash becomes a flaming smite of festering lacerations when your mage ignites their blade, your wolf howls for an attack boost, and your mummy touches the wound to add a festering DOT. The whole is greater than the sum of its parts. Position matters, timing matters, teamwork matters. Perfect rotations be damned.

### AI Companions

LLM-powered companions with persistent memory, personality traits, and the ability to understand natural language. They participate in combat, engage in dialogue, and form relationships with players.

### Wildlife Ecosystem

Wildlife with basic needs (hunger, thirst, fatigue, reproduction) that behave autonomously. Animals hunt, forage, form packs, establish territories, and age naturally. Some animals may also befriend players under certain circumstances.

### Supernatural Powers

Original supernatural system allowing players to develop unique abilities as they progress. Powers are tied to character choices and story progression.

## Development Roadmap

### ✅ Completed

- [x] Distributed server architecture (Gateway + Zone servers)
- [x] Redis pub/sub messaging system
- [x] WebSocket networking with Socket.io
- [x] Database schema (PostgreSQL + Prisma)
- [x] Text client (MUD-like with TUI)
- [x] Movement system (bearing/heading/compass)
- [x] Proximity roster with spatial awareness
- [x] Stat system (core + derived)
- [x] NPC/Companion system with LLM hooks
- [x] Airlock protocol (LLM client control)
- [x] Wildlife simulation (Rust standalone)

### 🚧 In Progress

- [ ] **NPC Intent System** - Context items + LLM → action pipeline
- [ ] **Combat System** - Full ATB, cooldowns, status effects, AoE
- [ ] **World Content** - OSM integration, zone generation, NPC placement

### 📋 Planned

- [ ] 2D Web Client (isometric/top-down)
- [ ] 3D Client (Unity)
- [ ] LLM Narrator System
- [ ] Quest System
- [ ] Crafting & Economy
- [ ] Faction/Reputation System
- [ ] AR/VR Clients

See [TODO.md](TODO.md) and [docs/NEXT_SESSION_PRIORITIES.md](docs/NEXT_SESSION_PRIORITIES.md) for detailed implementation priorities.

## Contributing

This is currently a solo project, but contributions may be welcome in the future.

## License

GNU Affero General Public License v3.0 (AGPL-3.0)

This ensures that anyone who runs a modified version of this server must make their source code available to their users. See [LICENSE](LICENSE) for full details.
