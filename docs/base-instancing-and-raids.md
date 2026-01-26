# Ashes & Aether — Base Instancing & Raid Rules (Server Spec v1)

This document defines how **personal bases (instanced)** and **community centers (persistent in-world)** work, including raid target selection, loss caps, reinforcement timers, and anti-exploit rules.

Design goal: **EVE vibes without offline total deletion.**
- Nothing is perfectly safe.
- But losses are bounded so players don’t quit.
- Community defense matters.

---

## 0) Base Types

### 0.1 Personal Base (Instanced)
- Not visible/persistent in the overworld.
- Can be raided via instance entry (Boom Beach-style).
- Intended for individuals / small households.

### 0.2 Community Center (Persistent / World-Anchored)
- Exists in the shared overworld at all times.
- Raids happen by physically showing up and attacking.
- Intended for groups, towns, factions, “goodly hubs,” or corrupted empires.

---

## 1) Personal Base Discovery & Raid Entry

### 1.1 “Homes Nearby” List
When a player or NPC initiates a raid action from a world location, the server offers a list of **eligible personal bases** “in the area.”

The list should not reveal exact ownership or full value to prevent target sniping.

Each base entry may show:
- approximate size class: `SMALL`, `MEDIUM`, `LARGE`
- security signature: `LOW`, `MED`, `HIGH`
- corruption taint signature (optional): `CLEAN`, `STAINED`, `WARPED`
- “estimated loot density” (coarse; optional)

**Do not reveal:**
- exact owner name
- exact inventory contents
- precise wealth values

### 1.2 Eligibility Radius
- Bases are eligible if their “home region anchor” is within:
  - `personal_base_raid_radius_meters` of the raider’s current world location
- The anchor is a lightweight mapping object, not the full base instance.

### 1.3 Anti-Spam Listing Rules
- Limit how often the same base appears:
  - exclude bases in reinforcement state
  - exclude bases raided recently (cooldown)
  - exclude bases already attacked by this same raider in the last X hours

---

## 2) Personal Base Raid Instance Flow

### 2.1 Entering the Instance
When the raider selects a base entry:
- server spins up an instance of that base layout
- defenders are AI by default unless the owner is online and opts in to defend live

### 2.2 Defender Participation Modes (Optional)
Personal bases can support:

**A) Offline Defense (default)**
- AI defenders only
- owner does not need to be online

**B) Live Defense (opt-in)**
- if the owner is online, they may “respond”
- owner may invite nearby allies
- improves defense outcomes (reduces loss)

Live defense must be time-boxed to prevent endless stalemates.

---

## 3) Raid Success Score (0–100%)

Every raid produces a `success_score` in range **0..100**, computed from objectives.

Example scoring inputs:
- % of outer defenses neutralized
- control point hold time
- generator disabled
- storage breached
- extraction completed

Scoring must be server authoritative.

---

## 4) Bounded Loss System (No Total Wipe)

### 4.1 Maximum Loss Per Raid
Personal base raids apply bounded losses:

- `max_loss_percent_per_raid = 10%` (default)

### 4.2 Loss vs Success Mapping (Example Curve)
Loss is derived from success score:

- 0–10% success → 0–2% loss
- 11–50% success → 2–6% loss
- 51–99% success → 6–9% loss
- 100% success → 10% loss (cap)

Exact curve is configurable.

### 4.3 Max Loss Per Time Window (Anti-Cheese)
To prevent 20 micro-raids equaling total wipe:

- Each personal base has a `loss_budget` per window.
- Example: max total loss = **10% per 24 hours**.

If the loss budget is exhausted:
- the base enters reinforcement automatically
- it cannot be listed for raids until the window resets

---

## 5) Reinforcement / Respite Timer

### 5.1 Reinforcement Trigger
After a personal base is raided, it enters a reinforced state:

- `REINFORCED` for `X` hours

### 5.2 Reinforcement Duration
Duration is based on how heavy the losses were:

Example:
- minor loss (0–2%) → 6 hours
- medium loss (3–6%) → 18 hours
- heavy loss (7–10%) → 48 hours

### 5.3 Breaking Reinforcement Early (Rebuild Pressure)
Reinforcement may end early if the owner “restores stability” by:

Option A (wealth-based rule):
- If owner’s wealth reaches `pre_attack_wealth * 1.02` (i.e., recovers lost value + 2% buffer)
- then reinforcement ends early

Option B (recommended: base reinvestment rule):
- If owner invests repair materials and restores the base’s structural integrity above a threshold
- then reinforcement ends early

**Note:** Option B is preferred because it promotes rebuilding over endless hoarding.

### 5.4 Reinforcement Visibility
Raiders should see bases in reinforcement as “not available.”
Owners should see a timer + required rebuild progress.

---

## 6) Loot Handling

### 6.1 Loot as “Extracted Value”
Rather than directly stealing specific items, raids generate “extracted value” from eligible storages.

Rules:
- owner loses a % of resources/value (bounded)
- raider receives a % as loot
- a portion may be “destroyed/spoiled” to prevent inflation

Example split of raided loss:
- 60% → raider loot
- 40% → destroyed (sinks wealth)

Tunable in config:
- `loot_attacker_fraction`
- `loot_destroyed_fraction`

This keeps the economy from becoming infinite.

---

## 7) Community Center Raids (Open World)

### 7.1 Always-Online Structures
Community centers exist in the overworld and can be attacked directly.

Rules:
- require physical presence
- defenders can rally in real time
- raids are higher-stakes than personal base raids

### 7.2 Bounded Damage (No One-Shot Deletion)
Even community centers should be resilient:

- attackers can damage structures, steal resources, disable utilities
- but cannot delete the entire settlement in a single raid

Suggested model:
- max structural damage per raid window
- “critical systems” can be disabled temporarily (power, comms, gates)
- stored resources protected behind multiple layers

---

## 8) NPC Raiders and “Lost” Characters

NPCs follow the same raid pipeline:
- choose eligible bases from the “homes nearby” list
- enter instances and perform raids
- obey cooldown rules and loss caps

Lost characters (former players) can become NM-grade NPC raid leaders:
- they can trigger raids more often
- they may coordinate NPC squads
- they increase pressure in regions near corruption zones

This creates living world threat gradients.

---

## 9) Anti-Exploit Rules (Required)

### 9.1 Alt/Feeder Account Protection
Prevent players from farming their own alts:
- no loot if raider and target share IP/device fingerprint (configurable)
- diminishing returns if raider hits same region too often
- suspicious patterns flagged for review

### 9.2 Target Sniping Prevention
Prevent repeatedly selecting the richest visible base:
- base list is shuffled and fogged
- value tier is approximate only
- limit repeats against the same target

### 9.3 Offline Immunity Abuse Prevention
Prevent players from hiding forever:
- bases can always be raided eventually
- reinforcement is temporary
- excessive reinforcement chaining triggers a “decay tax” (optional)

---

## 10) Required Server Data

### 10.1 `personal_bases`
- `base_id`
- `owner_player_id`
- `region_anchor_id`
- `size_class`
- `security_rating`
- `last_raided_ts`
- `reinforced_until_ts`
- `loss_budget_remaining`
- `pre_attack_wealth_snapshot` (if using wealth-based reinforcement)
- `structural_integrity` (if using rebuild-based reinforcement)

### 10.2 `personal_base_raid_events`
- `raid_id`
- `base_id`
- `raider_id` (player or npc)
- `success_score`
- `loss_percent_applied`
- `loot_value_awarded`
- `destroyed_value`
- `created_ts`

### 10.3 `region_anchors`
- `region_anchor_id`
- `world_position`
- `region_id`

---

## 11) Config Knobs

- `personal_base_raid_radius_meters`
- `max_loss_percent_per_raid`
- `max_loss_percent_per_window`
- `loss_window_seconds`
- `reinforcement_duration_curve`
- `loot_attacker_fraction`
- `loot_destroyed_fraction`
- `base_list_fogging_level`
- `repeat_target_cooldown_seconds`
- `npc_raid_frequency_modifiers`
- `community_center_damage_caps`

---

## 12) Test Scenarios

### Scenario A — Personal Base Basic Raid
- base is listed
- raider enters instance
- success score computed
- loss applied with cap
- reinforcement set

### Scenario B — Reinforcement Anti-Spam
- base raided once
- base cannot appear again until reinforced ends

### Scenario C — Window Loss Budget
- multiple raids in 24h
- total applied loss never exceeds configured max

### Scenario D — Community Center Raid
- open world assault
- bounded damage applied
- no single-raid deletion

### Scenario E — NPC “Lost” Raider
- NPC selects base from list
- performs raid
- event logged

---

## 13) Notes / Philosophy

- Personal bases provide “safer, not safe” stability.
- Community centers create politics, alliances, and real territory defense.
- Raids create pressure, but bounded loss prevents rage-quits.
- Corruption endgame characters becoming world NPC threats is intended gameplay, not griefing.
