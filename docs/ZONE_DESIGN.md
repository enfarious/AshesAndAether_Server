# Zone Design - Civic Anchors, Vaults & Companion Combat

Working design document distilled from brainstorming session, March 2026.

## 1. Zone Architecture

Each playable area is centered on a real-world municipal anchor point. The game models neighborhoods around civic nodes, not whole cities.

### 1.1 Townhall as Zone Origin

Every zone begins at its real-world Town Hall. This is the canonical starting point and strongest ward anchor.

| Property | Detail |
|----------|--------|
| Function | New player spawn, zone directory, strongest ward anchor |
| Ward radius | 500m (configurable per anchor) |
| Ward strength | -0.05 corruption/min |
| Lore | Emergency coordination centers during the nano-plague. Survivors converged here first. |

### 1.2 Libraries as Secondary Anchors

Libraries serve as distributed ward anchors. OSM library density naturally mirrors real-world neighborhood structure.

- **Home base**: Players may home-base at any library in their starting town
- **No forced movement**: A player can complete most content from Town Hall or any single library
- **Implementation**: Tagged `amenity=library` in OSM, captured by `fetch_osm.py`
- **Design note**: Albany has 8-10 branch libraries. Smaller towns (Stephentown) have exactly one.

### 1.3 Corruption Gradient

Corruption scales with distance from the nearest ward anchor. No explicit level gating needed.

| Zone Tag | Distance Band | Rate |
|----------|--------------|------|
| `WARD_ZONE` | 0 to wardRadius | -0.05/min (active reduction) |
| `WILDS` | wardRadius to 2x | 0.00/min (neutral) |
| `RUINS_CITY_EDGE` | 2x to 4x wardRadius | +0.02/min |
| `OLD_CITY_CORE` | 4x to 8x wardRadius | +0.06/min |
| `DEEP_LAB` / `DEEP_ROADS` | Beyond 8x | +0.12-0.18/min |

The space between two library anchors with nothing in between is the **dead zone** -- where the plague was never pushed back, mobs scale up, and procedural dungeons increase in tier.

### 1.4 Lore Foundation

- Town Halls and Libraries are the only structures that survived the nano-plague intact
- They became bastions of law and knowledge where ward AIs took root
- Villages formed around these safe areas, built by players extending the ward network
- Library AIs and Town Hall AIs have distinct personalities: libraries favor access/sharing/lateral thinking, Town Halls favor law/order/hierarchy
- Whether library AIs within a city are networked (or plague-severed) is an open design opportunity

## 2. Vault System (Special Dungeons)

Inspired by FFXI Dynamis and Limbus. High-stakes instanced dungeons with collaborative key collection. Completable solo but designed to reward grouping.

### 2.1 Design Principles

- **No forced grouping**: Solo + companions must always be viable
- **Rewarded, not required**: Group play rewarded through speed, drop rates, alternate boss phases
- **Shared activity**: Key collection gives casual and hardcore players shared activity

### 2.2 Key Collection Loop

1. **Fragment gathering**: Fragments drop from high-corruption field content near the Vault entrance
2. **Key assembly**: At a library or townhall workbench (ties endgame to community anchors)
3. **Entry**: Key consumed on entry. Group shares a key or each member contributes one
4. **Instance scaling**: Difficulty/rewards scale to group size at entry time

Fragments can be traded, giving crafters and traders a role in the endgame loop.

### 2.3 Content Scaling

| Group Size | Effect |
|-----------|--------|
| Solo + companions | Tuned difficulty, full content, slower progression |
| Small group (2-3) | Moderate speed increase, improved drops, minor encounter variants |
| Full party (4-5) | Maximum drops, alternate boss phases, scale-locked lore |
| Alliance (multiple parties) | Endgame raids, server-event rewards |

## 3. Companion Combat Architecture

Companions are AI-driven via behavior tree + LLM hybrid. The behavior tree handles continuous execution; the LLM handles higher-order tactical decisions.

### 3.1 Architecture

| Layer | Responsibility |
|-------|---------------|
| Behavior Tree (motor cortex) | Executes movement, attacks, abilities every tick |
| LLM (prefrontal cortex) | Adjusts settings on meaningful state changes. Not called every tick. |

### 3.2 Settings Object

The LLM outputs a settings object that the behavior tree reads:

```json
{
  "preferredRange": "melee",
  "priority": "threatening_player",
  "stance": "aggressive",
  "abilityWeights": { "heal": 0.8, "damage": 0.2, "cc": 0.4 },
  "retreatThreshold": 0.25
}
```

The tree doesn't need to know whether settings came from LLM or config. LLM can be slotted in after testing against hardcoded baselines.

### 3.3 LLM Trigger Conditions

Only queried on meaningful state changes (3-6 calls per typical fight):

- New enemy type enters combat
- Ally health drops below threshold
- Player issues direct command
- Enemy phase shift
- Companion health crosses retreat threshold
- Combat begins/ends

### 3.4 Baseline Personalities

| Archetype | Baseline |
|-----------|----------|
| Scrappy fighter | Low retreat (0.1), high damage, aggressive stance |
| Cautious healer | High retreat (0.5), high heal weights, support stance |
| Opportunist | Dynamic priority (weakest), mid range, balanced |
| Tank | Melee locked, player-threat priority, high CC |

## 4. Open Questions

| Question | Notes |
|----------|-------|
| Library AI networking | Networked or plague-severed? Major questline potential. |
| Ward radius tuning | Needs to match real neighborhood density. |
| Vault naming | Vault, Resonance Site, Rift, Deep Cache? |
| Fragment tradability | All tradable or some bind-on-pickup? |
| Companion personality persistence | Remember past Vault runs? Failure affect future behavior? |
| Corruption player Vault access | Alternate Vault versions in the deep ruins? |

## 5. Implementation Status

### Done
- `CivicAnchor` Prisma model (townhalls/libraries as ward anchor entities)
- Seed script populating anchors from OSM amenities data
- Map API endpoints (`/api/map/anchors`, `/api/map/corruption-config`)
- Corruption visualization map (`/map.html`) with Leaflet + canvas gradient overlay

### Next
- Wire `CivicAnchor` ward radii into `CorruptionSystem` tick (distance-based corruption instead of zone-wide tags)
- Fetch OSM data for larger regions (Albany, Pittsfield) to populate more anchors
- Vault system prototype
- Companion combat settings object + behavior tree integration
