# Unit System Migration

## Changes Made

### Units - Everything in Meters
- Removed all `FEET_TO_METERS` conversions
- Changed all distance/range specifications to meters
- Removed `getElevationFeet()` method
- Updated `radiusMiles` → `radiusMeters` in metadata

### Currency - Gold → Shards
**Shards** are fragments of the old world - remnants of pre-war technology and materials that hold value in the post-war economy.

Database changes (requires migration):
- `CharacterWallet.gold` → `CharacterWallet.shards`
- All `gold` references in services → `shards`
- Comments about "Gold paid" → "Shards paid"

### Distance Constants (now in meters):
- Touch range: 1.5m (was ~5ft)
- Say range: 6m (was 20ft)
- Shout range: 45m (was 150ft)
- Emote range: 45m (was 150ft)
- Call for help: 75m (was 250ft)
- Combat event range: 45m (was 150ft)

### TODO:
- [ ] Create Prisma migration for gold → shards rename
- [ ] Update any client-side references to "gold"
- [ ] Update any documentation/UI text
