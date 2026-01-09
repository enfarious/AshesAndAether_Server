# World of Darkness MMO

An MMORPG of supernatural persuasions, featuring tactical combat, AI companions, and living wildlife ecosystems.

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

### Phase 1: Foundation ✅

- [x] Project setup and architecture
- [x] Basic networking layer
- [x] Database schema
- [x] World and zone management
- [ ] Text client protocol

### Phase 2: Core Systems (In Progress)

- [ ] Entity Component System
- [ ] Pathfinding and navmesh
- [ ] Basic combat system
- [ ] Wildlife AI and life simulation

### Phase 3: Advanced Features

- [ ] LLM integration for companions
- [ ] Full tactical combat
- [ ] Character progression
- [ ] 2D client support

### Phase 4: Content & Polish

- [ ] Quest system
- [ ] Supernatural powers
- [ ] 3D client support
- [ ] Content creation tools

### Phase 5: Future

- [ ] VR client support
- [ ] Advanced faction systems
- [ ] Player housing/bases
- [ ] Large-scale PvP/RvR

## Contributing

This is currently a solo project, but contributions may be welcome in the future.

## License

GNU Affero General Public License v3.0 (AGPL-3.0)

This ensures that anyone who runs a modified version of this server must make their source code available to their users. See [LICENSE](LICENSE) for full details.
