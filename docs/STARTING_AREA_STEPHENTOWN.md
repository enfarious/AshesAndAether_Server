# Stephentown Starting Area (Seeded Content)

This file documents the current seeded content used for the starter area.
Positions use local feet offsets derived from lat/lon.

## Zone

- Zone ID: `USA_NY_Stephentown`
- Zone name: `Stephentown, NY`
- Anchor point (Town Hall): `x=0, y=0, z=0` (zone units = feet)
- Reference: Stephentown Town Hall on Grange Hall Rd

## Alive State

All entities have an `isAlive` flag in the database and runtime state.
- Dead entities are excluded from proximity rosters.
- Mobs respawn by restoring `currentHealth` to max and setting `isAlive=true`.

## NPCs (Hireable)

Location: town hall steps (close to anchor point).

- `npc.merchant.old` - Old Merchant (friendly guidance)
- `npc.hire.swordsman` - Hired Swordsman
- `npc.hire.bowman` - Hired Bowman

## Mobs (Non-Aggro, Respawn 120s)

All mobs use `tag` prefix `mob.` and respawn 2 minutes after death.

- 5x Rats (`mob.rat.1`..`mob.rat.5`)
  - Spawn: random ring 10-25 ft around Town Hall
  - Level: 1-3
- Rabid Dog (`mob.rabid_dog`)
  - Spawn: near Four Fat Foul (NY-43)
  - Level: 7
- Dire Toad (`mob.dire_toad`)
  - Spawn: behind the post office (offset from post office location)
  - Level: 6

## Landmark Lat/Lon (OSM/Nominatim)

- Stephentown Town Hall (OSM way 1047754315)
  - 26 Grange Hall Rd
  - 42.5513326, -73.3792285
- Stephentown Post Office
  - 389 NY-43
  - 42.5486230, -73.3739670
- Four Fat Foul
  - 473 NY-43
  - 42.5501388, -73.3814902
- Stephentown Memorial Library
  - 472 NY-43
  - 42.5507190, -73.3807245
- Stephentown Volunteer Fire Department
  - 396 NY-43
  - 42.5490736, -73.3750000
- Heather's Heart Forge
  - 25 Browns Rd
  - 42.5506875, -73.3733125 (plus code HJ2G+7M)

## Notes

- Local `x/y` use an equirectangular approximation from Town Hall.
