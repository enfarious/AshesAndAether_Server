# Changelog - Ashes & Aether Server

All notable changes and progress will be documented in this file.

## [2026-01-28] - World Building v2 Phase D Complete

### Features

**NavmeshPipeline (Phase D Complete)**:
- Server-side pathfinding grid generation (64×64 cells per micro tile, ~39m resolution)
- WalkabilityFlag bitfield system (8 flags: WALKABLE, BLOCKED_WATER, BLOCKED_SLOPE, BLOCKED_CORRUPTION, ROAD, DENSE_VEGETATION, RUBBLE, INDOOR)
- MovementCost enum for terrain-based movement modifiers (9 cost types)
- Slope-based blocking with configurable max walkable angle
- Biome-based cost assignment (forests, marshes, sand, snow, rubble, etc.)
- Road optimization (0.7x movement cost)
- Corruption blocking at threshold (0.9 default)
- Structure integration (buildings block cells, roads modify costs)
- Edge connection generation for cross-tile pathfinding
- Deterministic output based on tile coordinates

**Test Coverage**:
- NavmeshPipeline: 14 tests covering enums, generation, determinism, error handling
- All tile system tests passing: 110 total (93 existing + 14 navmesh + 3 pipeline tests)
- Converted all test files from Vitest to Jest syntax

**Integration**:
- Registered in TileBuildRunner with NAV_BAKE job type
- Database schema already has navmeshHash/navmeshVersion fields
- Exports added to pipelines/index.ts

### Bug Fixes
- Fixed CharacterService Prisma JSON type errors (added Prisma import, cast to InputJsonObject)
- Removed unused imports in RuinGenPipeline
- Prefixed unused parameters in POIPipeline and SpawnTablePipeline
- Fixed NavmeshPipeline test config property name (gridSize → resolution)

## [2026-01-28] - Protocol Documentation Clarification

### Documentation

**Added**:
- **CLIENT_PROTOCOL_REFERENCE.md** - Canonical protocol reference for client developers
  - Clarifies `chat` vs `communication` (chat is canonical)
  - Documents `proximity_refresh` (not get_nearby/get_proximity)
  - Explains delta-only proximity roster updates
  - Standardizes command vs chat event usage
  - Documents move events vs movement commands
  - Confirms command_response payload structure

**Updated**:
- COMMUNICATION_SYSTEM.md - Updated to reflect actual server implementation
  - Changed `communication` event references to `chat`
  - Updated proximity request to use `proximity_refresh`
  - Clarified delta-only roster updates (no full roster in distributed path)
  - Updated client code examples to match actual protocol

- README.md - Added documentation index with CLIENT_PROTOCOL_REFERENCE.md highlighted

**Key Changes for Client Developers**:
- Use `chat` event (not `communication`) for inbound and outbound messages
- Use `proximity_refresh` (not `get_nearby` or `get_proximity`) for roster requests
- Expect `proximity_roster_delta` only - build roster from empty state with deltas
- Prefer `move` events over `/move` commands for real-time movement
- `command_response` format is stable: `{ success, command, message?, error?, data?, timestamp }`

## [Unreleased]

### Project Setup
- Initial project structure created
- Dependencies installed (Socket.io, Prisma, Express, Anthropic SDK, etc.)
- TypeScript configuration
- Jest test configuration
- ESLint configuration
- Git repository initialized

### Documentation
- Created ARCHITECTURE.md with comprehensive system design
- Created README.md with project overview and getting started guide
- Created .env.example for environment configuration
- Created TODO.md for task tracking
- Created CHANGELOG.md (this file) for session notes
- Created NOTES.md for implementation details

### Current State
- Phase 1 (Foundation) in progress
- No implementation code written yet
- Prisma schema needs to be defined
- Server entry point needs to be created

## [Initial Commit] - 2026-01-09 (or earlier)
- Project initialized with git
- Initial file structure
