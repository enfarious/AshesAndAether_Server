# Ashes & Aether — Corruption System (Server Spec v1)

**Purpose:** Replace shallow survival meters (hunger/thirst) with a long-term “moral pressure + world divergence” mechanic that rewards community-building and tempts isolation, greed, and ruin-delving.

Corruption is not a fail state. It is a trajectory that naturally creates:
- Clean communities that thrive through cooperation
- Corrupted empires that thrive through extraction and obsession
- Emergent conflict between the two

---

## 1) Core Concept

Each player has a persistent stat:

- `corruption` in range **0..100**

Corruption rises/falls over time based on:
- where the player spends time (zones)
- how long they are away from community (isolation)
- how much wealth they hoard (unused wealth)
- certain “forbidden” actions (bursts)
- contribution to a settlement/community (reductions)

Corruption affects:
- NPC acceptance and town access
- vendor pricing and services
- access to faction questlines
- event frequency and “weirdness”
- delving capability and high-risk zone survivability

---

## 2) Corruption States / Threshold Bands

| Corruption | State | World Reaction |
|---:|---|---|
| 0–24 | **Clean** | Fully welcome by goodly towns and NPCs |
| 25–49 | **Stained** | Minor suspicion; slight restrictions |
| 50–74 | **Warped** | Denied entry to many goodly towns; warded spaces repel |
| 75–100 | **Lost** | Treated as post-human; embraced by corrupted factions |

**Rule:** Do not hard-lock players. Reroute them into different content networks.

---

## 3) Update Model (Server Tick)

### 3.1 Tick Rate
Corruption updates on a fixed cadence:
- Recommended: **1 minute** per tick
- Acceptable: **5 minutes** per tick for performance

### 3.2 Delta Formula
Per tick:

```
delta = gain - reduction
corruption = clamp(corruption + delta, 0, 100)
```

Where:

**Gain components**
- `zone_gain`
- `isolation_gain`
- `wealth_gain`
- `behavior_gain`
- `forbidden_gain`

**Reduction components**
- `community_reduction`
- `contribution_reduction`
- `rest_reduction`
- `ritual_reduction`

---

## 4) Zone Corruption (Map Tags)

Every region has a `zone_tag` used by the corruption system:

### 4.1 Zone Tags
- `WILDS`
- `RUINS_CITY_EDGE`
- `OLD_CITY_CORE`
- `MOUNTAIN_HOLD`
- `DEEP_LAB`
- `WARD_ZONE`

### 4.2 Default Zone Gain Values (per minute)
Tunable server config values:

| Zone Tag | Corruption / Minute |
|---|---:|
| WILDS | +0.00 |
| RUINS_CITY_EDGE | +0.02 |
| OLD_CITY_CORE | +0.06 |
| MOUNTAIN_HOLD | +0.10 |
| DEEP_LAB | +0.18 |
| WARD_ZONE | -0.05 |

**Design note:** `DEEP_LAB` must feel like “you can go, but you’re paying with your soul.”

---

## 5) Isolation Gain (Time Away From Community)

Isolation exists to discourage endless solo delving and reinforce the world theme: **community is sanity**.

### 5.1 What Counts as “In Community”
A player is considered in community if ANY of the following are true:

- inside a settlement boundary
- within radius `R` of at least `N` players
- near a “community object” (campfire, shrine, market, community center)

Recommended defaults:
- `R = 35m`
- `N = 3 players`

### 5.2 Isolation Gain Model
Isolation gain begins after a grace window:

- `grace_minutes = 10`

After grace, corruption increases.

Suggested ramp (simple but effective):
- After grace: `+0.01 / minute`
- After 30 minutes isolated: `+0.02 / minute`
- After 2 hours isolated: `+0.03 / minute`

---

## 6) Wealth / Hoarding Gain

Wealth isn’t evil by itself, but **unused hoarded wealth** increases corruption.

### 6.1 Wealth Score
Maintain a cached server-authoritative value:

```
wealth_score = liquid_value + stash_value + rare_value_weighted
```

The server owns item pricing (avoid client-side exploits).

### 6.2 Wealth Gain Curve
Corruption gain based on wealth_score:

| Wealth Score Range | Corruption / Minute |
|---:|---:|
| < threshold | 0 |
| threshold → 2× | +0.01 |
| 2× → 5× | +0.03 |
| > 5× | +0.06 |

Wealth gain should be reduced by community investment (see Contribution).

---

## 7) Contribution / Investment (Anti-Corruption)

Contribution exists so the game supports:
- “rich but benevolent” players
- settlement builders
- crafting/support roles

### 7.1 Contribution Points
Players earn `contribution_points` via:
- donating materials to community storage
- building structures
- repairing utilities
- crafting items for other players (confirmed trade)
- escort/rescue mission completion

### 7.2 Contribution Effect
Contribution can be applied as:
- flat corruption reduction
- or reduction multipliers on gain sources

Suggested example:
- Every 100 contribution points:
  - `corruption -= 1`
  - and apply `wealth_gain_multiplier *= 0.90` for 24h

---

## 8) Forbidden Actions (Instant Bursts)

Some actions apply immediate corruption spikes (server event hooks).

Suggested defaults:

| Forbidden Action | Corruption Add |
|---|---:|
| Betrayal contract / PK ally | +5 |
| Looting a community store | +8 |
| Deep Lab Artifact Activation | +10 |
| Aether siphon ritual | +12 |
| Install forbidden augmentation | +15 |

---

## 9) Corruption Benefits (Temptation Rewards)

Corruption must provide meaningful upside, otherwise players will ignore the system.

Suggested perks by corruption band:
- increased cache detection
- reduced ruin hazard damage
- ability to interface with dead systems / AI terminals
- reduced “weirdness” penalties in deep zones

Example buffs:
- `Stained`: +5% cache detection
- `Warped`: +15% cache detection, +10% hazard resist
- `Lost`: +30% cache detection, +25% hazard resist, +special interactions

---

## 10) Social Gating (NPC / Town Rules)

### 10.1 Town Acceptance
Towns define:

- `max_corruption_allowed`

Examples:
- Goodly towns: `max_corruption_allowed = 50`
- Neutral trade towns: higher allowance
- Corrupted camps: accept only high-corruption players

Town entry check:
- If `player.corruption > max_corruption_allowed`:
  - deny entry OR
  - allow via bribe OR
  - require cleansing ritual OR
  - require escort (optional future feature)

### 10.2 Vendor Pricing Modifier
Pricing multiplier example:
- Clean: `1.0x`
- Stained: `1.1x`
- Warped: `1.3x` or refuse
- Lost: refuse in most goodly towns

---

## 11) Corruption Factions / World Divergence

Corruption is the core driver of world evolution.

At high corruption, players become eligible for “corrupted factions” that:
- offer safe access in hostile zones
- provide specialized quests
- provide unique crafting trees
- support “empire gameplay”

This creates emergent outcomes:
- corrupt empires form naturally
- clean coalitions form to survive
- player-driven conflict emerges

---

## 12) Data Model (Minimal Required)

### 12.1 `players`
- `player_id`
- `corruption` (float or int)
- `corruption_state` (enum/int)
- `last_corruption_tick_ts`
- `time_in_community_seconds`
- `time_in_isolation_seconds`
- `wealth_score_cached`
- `contribution_points`

### 12.2 `zones`
- `zone_id`
- `zone_tag`
- `corruption_gain_per_min`
- `is_warded` (bool)

### 12.3 `player_corruption_events` (audit/debug)
- `event_id`
- `player_id`
- `event_type`
- `delta`
- `reason`
- `created_ts`

### 12.4 `towns`
- `town_id`
- `max_corruption_allowed`
- `vendor_modifier_curve`
- `cleansing_available` (bool)

---

## 13) Server Config Knobs (Hot Reload Required)

These must be adjustable without code deployment:

- tick rate
- zone gain values
- isolation grace window
- isolation ramp curve
- wealth thresholds and curve
-contribution conversion rate
- forbidden action spikes
- corruption state thresholds
- vendor pricing modifiers
- cleansing strengths

---

## 14) Required Dev Test Scenarios

### Scenario A — Clean Citizen
- Stays in community, donates, builds
- Corruption stays low or decreases
- Full goodly access

### Scenario B — Solo Delver
- Spends 2 hours delving solo
- Corruption rises steadily, not instantly catastrophic
- Can cleanse/recover by returning to community

### Scenario C — Wealth Hoarder
- Builds massive stash, no contribution
- Corruption rises even without deep zones
- Town acceptance decreases

### Scenario D — Deep Lab Addict
- Lives in deep zones
- Corruption rises rapidly
- Gains delving perks but loses goodly access
- Corrupted factions accept and offer content

### Scenario E — Corrupt Empire
- Corrupted players cluster and build in hostile areas
- System supports their “bad community” gameplay
- Clean players must unite to survive

---

## 15) Notes for v2 Expansion (Optional Later)
- corruption visual / aura effects
- permanent Aether scars / marks
- cleansing rituals as multiplayer events
- redemption questlines for Lost players
- NPC fear / hostility patterns based on corruption
- “weirdness events” scaling with corruption level
