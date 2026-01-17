# Ash & Aether: Life at the Shatterline

## Overview
MMO game server for "Ash & Aether: Life at the Shatterline" - a tactical supernatural combat and wildlife simulation game.

## Recent Changes
- **2026-01-17**: Moved Replit Auth from GameServer to Gateway
  - Gateway is now the client-facing entry point with auth, web serving, and WebSocket connections
  - GameServer is now purely game logic (no auth, no web serving)
  - Added static file serving from `public/` directory in gateway
  - Redis installed for distributed messaging between gateway and zone servers

## Project Architecture

### Tech Stack
- **Runtime**: Node.js 20
- **Language**: TypeScript
- **Framework**: Express.js + Socket.IO
- **Database**: PostgreSQL with Prisma ORM
- **Messaging**: Redis (pub/sub for distributed servers)
- **Authentication**: Replit Auth (OpenID Connect) - handled by Gateway

### Server Architecture
```
                    ┌─────────────────┐
                    │    Gateway      │  ← Client entry point (port 5000)
                    │  (Auth + Web)   │     - Replit Auth
                    │                 │     - Static files (public/)
                    └────────┬────────┘     - WebSocket connections
                             │
                      Redis Pub/Sub
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
   │  Zone   │          │  Zone   │          │  Zone   │
   │ Server  │          │ Server  │          │ Server  │
   └─────────┘          └─────────┘          └─────────┘
```

### Directory Structure
```
src/
├── auth/           # Replit Auth integration (used by Gateway)
├── ai/             # NPC AI and LLM services
├── combat/         # Combat system and damage calculation
├── commands/       # Game commands (movement, combat, social, etc.)
├── database/       # Prisma database services
├── game/           # Game mechanics (stats, abilities)
├── gateway/        # Gateway server - client entry point
├── messaging/      # Redis message bus and zone registry
├── network/        # Monolithic GameServer (for standalone mode)
├── utils/          # Logging and utilities
├── wildlife/       # Wildlife and flora simulation
├── world/          # Zone and world management
└── zoneserver/     # Zone server for distributed architecture
public/             # Static web files served by Gateway
```

### Auth Routes (Gateway)
- `GET /api/login` - Begin login flow (redirects to Replit)
- `GET /api/auth/callback` - OAuth callback
- `GET /api/logout` - Logout and redirect to home
- `GET /api/auth/user` - Get current authenticated user

### Key Commands
```bash
npm run dev:gateway  # Start gateway (main entry point)
npm run dev          # Start monolithic game server (standalone)
npm run dev:zone     # Start zone server
npm run build        # Build for production
npm run prisma:generate  # Generate Prisma client
npm run prisma:migrate   # Run database migrations
```

## User Preferences
(To be updated based on user feedback)
