# AshesAndAether Server — Session Memory

## Architecture Quick Reference
- Gateway (port 3100/3101) → Redis pub/sub → Zone servers
- `publishZoneEntities` → `ZoneRegistry.setZoneEntities` (Redis) → `GatewayClientSession.world_entry`
- Mob health is DB-persisted; ZoneManager caches it in `Entity.currentHealth/maxHealth`
- Call `zoneManager.setEntityHealth()` after any mob HP change to keep cache in sync

## Entity Data Pipeline (what flows to client)
Fields that flow: `id`, `name`, `type`, `position`, `isAlive`, `description`,
`tag`, `level`, `faction`, `aiType`, `notorious`, `health: {current, max}`

Key files:
- `ZoneManager.ts` — `Entity` interface, `getAllEntities()`, `setEntityHealth()`
- `DistributedWorldManager.ts` — `publishZoneEntities()`, mob wander loop
- `ZoneRegistry.ts` — Redis types for entity data
- `GatewayClientSession.ts` — `world_entry` handler (live + DB fallback paths)
- `network/protocol/types.ts` — `Entity` interface used by protocol

## Mob Schema Fields (require migration after changes)
Run: `npx prisma migrate dev --name <name>` after schema edits.
Current Mob model includes: `faction String?`, `notorious Boolean @default(false)`,
`currentHealth Int`, `maxHealth Int`, `level Int`, `tag String @unique`, `aiType String`

## Nameplate System Design (server-side complete, client to implement)
- HP bar: show when `health.current < health.max`
- Level indicator: `↑` mob > player, `↓` mob < player, `==` equal, `??` if `notorious: true`
- NM marker: `!` or `*` icon when `notorious: true`
- Color: difficulty-relative (level-based) — client determines from `level` vs player level

## Known Fixes Applied
- `SpawnPointService` was missing import in `GatewayClientSession.ts` (fixed)
- `getAllEntities()` was stripping mob fields before fix — now returns full entity data
- `publishZoneEntities` had broken `(e as any)` casts on stripped objects — now direct access
- Mob wall collision: `PhysicsSystem.resolveAgainstStructures()` applied in mob wander loop
- `faction`/`level`/`tag`/`aiType` pipeline fixed across ZoneManager → Redis → world_entry

## User Preferences
- Real services preferred (PostgreSQL, Redis) — ask for credentials, not mocks
- Server: port 3100/3101, tsx watch mode, restart via `.\restart-servers.ps1`
- No auto-commit; confirm before pushing
