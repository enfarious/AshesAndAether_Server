# TODO - World of Darkness Server

Last updated: 2026-01-09

## Current Focus
Phase 1: Foundation - Setting up core infrastructure

## In Progress
- [ ] Document current project state and setup tracking files

## Phase 1: Foundation
- [x] Project structure and dependencies (package.json created)
- [x] Architecture documentation (ARCHITECTURE.md)
- [x] README with overview
- [ ] Environment configuration (.env.example exists, needs verification)
- [ ] Database schema (Prisma)
  - [ ] User/Account models
  - [ ] Character models
  - [ ] World/Zone models
  - [ ] Entity models
- [ ] Basic networking layer
  - [ ] WebSocket server (Socket.io)
  - [ ] REST API (Express)
  - [ ] Message router
  - [ ] Client session management
- [ ] Simple world with zones
  - [ ] Zone manager
  - [ ] Spatial indexing
- [ ] Entity system skeleton
  - [ ] Entity manager
  - [ ] Component definitions
- [ ] Text client protocol for testing

## Phase 2: Core Systems (Not Started)
- [ ] Pathfinding and movement
- [ ] Basic combat system
- [ ] Wildlife AI and life simulation
- [ ] Full text client implementation

## Blocked/Questions
- None currently

## Notes
- Combat system changed from turn-based to Active Time Battle (ATB) per README
- LLM provider will be Anthropic Claude API
- License is AGPL-3.0 (not MIT as in package.json - needs correction)
