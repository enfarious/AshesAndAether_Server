# Ashes & Aether — Corruption Endgame (Server Supplement v1)

This document extends the base **Corruption System** into its **endgame**: consent-driven permaloss, NPC conversion, dream/blackout events, and “power-for-soul” mechanics.

**Design goal:** Make “going too far” a deliberate player pact (fine print), not a surprise punishment. Players who opt in can chase unique power at the cost of identity and control.

---

## 0) Key Principles

1) **Consent on consent**
- Players must explicitly opt into permaloss/NPC conversion modes.
- Opt-in is captured at character creation (recommended) and can be re-confirmed at major thresholds.

2) **No unfair grief**
- Puppet/blackout behaviors must not create unpreventable, unstoppable griefing.
- Any involuntary actions must be bounded by server rules and flagged for auditing.

3) **Endgame is content, not deletion**
- “Lost” characters convert into persistent world entities (named NPCs / mini-bosses).
- Players can spectate their converted character as a “replay observer.”

---

## 1) Opt-In Modes (Character Creation Flags)

At character creation, present two independent opt-ins:

### 1.1 Hardcore Permaloss
- `opt_in_permadeath: bool`
- Meaning: the character can permanently die under defined conditions (e.g., Lost endgame choice, lethal events, special zones).

### 1.2 NPC Conversion (Soul Sale)
- `opt_in_npc_conversion: bool`
- Meaning: the character can permanently convert into a server-controlled NPC after crossing a point of no return.

**Recommended UX:** Show explicit warnings with checkboxes and require a “Type CONFIRM” step.

---

## 2) Extended Corruption Range

Base system uses `0..100`. Endgame extends corruption beyond 100 for opted-in characters.

### 2.1 Corruption Caps by Consent
- If `opt_in_npc_conversion == false` AND `opt_in_permadeath == false`:
  - Hard cap corruption at `100` (cannot exceed).
  - When reaching 100, player must choose “Recovery” (see §3) or cannot continue into deep corruption zones (soft reroute).
- If either opt-in is true:
  - Allow corruption to exceed 100 up to `150` (default).

### 2.2 Thresholds
- **100**: The Gate (Choice Event)
- **110**: In-Session Blackouts Enabled
- **125**: Accidental Aggression Enabled (bounded)
- **150**: Lost (Conversion Finalization)

---

## 3) The Gate Event at Corruption = 100 (Choice)

When a player hits **exactly 100 corruption**, trigger a one-time “Gate Event” UI.

### 3.1 Available Choices
**A) Death** *(requires `opt_in_permadeath`)*  
- Immediately kills character via narrative event (server-auth).
- Character becomes unavailable for play.
- Optional: generate a “remains cache” in-world (configurable).

**B) Conversion** *(requires `opt_in_npc_conversion`)*  
- Immediately converts character into a named NPC at their current “camp”/logout location (see §6).
- Player no longer controls the character as an avatar.
- Player gains spectator access (see §7).

**C) One-time Recovery (“Rehab”)** *(always available)*  
- Sets corruption to **90** instantly.
- Applies a permanent flag: `rehab_used = true`
- After `rehab_used == true`, the Gate Event will not offer Recovery again.

### 3.2 Enforcement
- The Gate Event must block normal play input until a choice is made.
- The choice is server-validated and recorded in audit logs.

### 3.3 Config Knobs
- `gate_recovery_value` (default: 90)
- `gate_recovery_one_time_only` (default: true)
- `gate_choice_timeout_seconds` (optional: auto-logoff if ignored)

---

## 4) Power-for-Corruption: Locked Abilities

Players who choose to continue (i.e., do not die/convert, or recover then later push again) gain access to otherwise locked abilities.

### 4.1 Unlock Bands
Recommended unlock milestones (tunable):
- `>= 75`: minor corrupted perks (already in base doc)
- `>= 100`: “Abyssal” ability tier
- `>= 125`: “Predator” ability tier
- `>= 150`: no longer a player avatar (Lost)

### 4.2 Examples (Server Buff Hooks)
- Deep-ruin hazard immunity tiers
- Dead-system command prompts (limited)
- Aether siphon / corruption-based crafting
- Tracking “scent” mechanics for resources (and later… prey)

**Important:** All abilities must be server-side authoritative.

---

## 5) Dream & Blackout System

### 5.1 Offline Dreams (Login Vignettes)
**Trigger conditions (suggested):**
- `corruption >= 85`
- zone tag in `{OLD_CITY_CORE, MOUNTAIN_HOLD, DEEP_LAB}`
- player logged off in unwarded area
- `offline_duration >= min_offline_minutes`

**On next login:**
- Show a 10–30 second dream vignette (unreliable narration).
- Outcomes can be cosmetic or real.
- Player receives a “Memory Fragment” entry in a server log (see §8).

**Config:**
- `dream_enabled`
- `dream_min_corruption` (default: 85)
- `dream_min_offline_minutes` (default: 10)
- `dream_event_chance_by_zone`

### 5.2 In-Session Blackouts (Corruption >= 110)
At `corruption >= 110`, the player can experience short blackouts *during play*.

**Constraints (fairness):**
- Never trigger during active PvP combat, boss fights, or critical mission interactions (server-defined safe exclusions).
- Keep blackout durations short (e.g., 2–8 seconds).
- Blackout may reposition the player slightly, swap held item, or add a debuff—but must not delete inventory or destroy bases.

**Config:**
- `blackout_enabled`
- `blackout_min_corruption` (default: 110)
- `blackout_duration_seconds_range`
- `blackout_cooldown_seconds`
- `blackout_exclusion_tags` (e.g., PVP, BOSS, SAFE_TOWN)

---

## 6) Accidental Aggression (Corruption >= 125)

At `corruption >= 125`, “It just happened” events may occur:
- accidental attack swing
- misfired ability
- involuntary target lock

**Hard bounds:**
- Must not cause guaranteed player death.
- Must not bypass safe-zone protections.
- Must have cooldown and a visible “warning tell” (audio/visual cue) when possible.

**Recommended approach:** Implement as a short-lived “Compulsion Debuff” that:
- increases chance of misfire under stress
- spikes when in corrupted zones or when “hunger” meter is active (optional)

**Config:**
- `accidental_aggression_enabled`
- `accidental_aggression_min_corruption` (default: 125)
- `accidental_aggression_proc_chance`
- `accidental_aggression_cooldown_seconds`

---

## 7) Finalization: Lost at Corruption >= 150

At `corruption >= 150`, the character is **Lost**.

### 7.1 Outcome
- Character becomes a **server-controlled NPC** (even if conversion wasn’t chosen earlier), but ONLY if the character opted into NPC conversion at creation OR confirmed at the Gate.
- If no NPC conversion consent exists, the system must instead:
  - force permadeath (if consented), OR
  - force lockout and require recovery path (server policy), OR
  - hard-cap at 149.

### 7.2 Spawn Location
Lost conversion anchors at:
- the player’s last “corruption camp” location (recommended: last logout or last placed “camp marker”)
- OR nearest corrupted node/ruin landmark

### 7.3 NPC Identity
- NPC retains player name + a title suffix (e.g., “Mike, the Stained King”)
- NPC gets a unique ID and persistent stat block scaled by:
  - peak corruption reached
  - kills/deaths history
  - time spent in deep zones
  - special artifacts carried at conversion time (optional)

---

## 8) Spectator Mode (Replay Observer)

Converted characters remain “yours,” but you no longer control them.

### 8.1 Spectator Access
- Player can log into the character as **Spectator**:
  - no world interaction (no combat, no items)
  - freecam or tethered cam (server choice)
  - can observe the NPC’s behavior and encounters

### 8.2 Replay Feed
Provide a server-side event feed:
- kills
- deaths
- zone transitions
- major interactions (artifact activations, raids)

**Data structure (suggested):**
- `npc_replay_events` table keyed by `converted_npc_id`

---

## 9) Required Server Data Additions

### 9.1 Player Fields
- `opt_in_permadeath` (bool)
- `opt_in_npc_conversion` (bool)
- `rehab_used` (bool)
- `gate_choice` (enum: NONE, DEATH, CONVERSION, RECOVERY)
- `peak_corruption` (int/float)
- `corruption_extended_cap` (int, default 150 if opted-in)
- `last_safe_blackout_ts`
- `blackout_count_total`

### 9.2 Conversion Record
- `converted_npc_id`
- `conversion_ts`
- `conversion_location`
- `conversion_reason` (GATE_CONVERSION, LOST_FINALIZATION)
- `spectator_enabled` (bool)

### 9.3 Memory / Dream Log
- `memory_fragment_id`
- `player_id`
- `ts`
- `type` (DREAM, BLACKOUT, COMPULSION)
- `severity`
- `content_seed` (for deterministic vignette generation)
- `outcome_flags` (cosmetic/real)

---

## 10) Auditing & Abuse Prevention

Because involuntary events exist, auditing is mandatory.

- Log every involuntary action:
  - event type
  - timestamp
  - zone
  - affected targets
  - damage applied (if any)
- Add rate limits and safe-zone enforcement.
- Provide GM/admin tooling to review “puppet incidents.”

---

## 11) Test Scenarios (Endgame)

### Scenario 1 — Gate Event (Recovery)
- Player reaches 100, chooses Recovery
- corruption becomes 90
- `rehab_used == true`
- Gate should never offer Recovery again

### Scenario 2 — Gate Event (Conversion)
- Player reaches 100, chooses Conversion
- character becomes NPC at camp location
- player can access Spectator mode + replay feed

### Scenario 3 — Blackouts Exclusion
- Player at corruption 115 enters PvP combat
- blackout should not trigger until exclusions clear

### Scenario 4 — Accidental Aggression Bounds
- Player at corruption 130 in a safe town
- accidental aggression must not occur / must be blocked

### Scenario 5 — Lost Finalization
- Player with NPC-conversion consent reaches 150
- conversion finalizes, NPC persists
- spectator works

---

## 12) Config Knobs (Add to corruption-config)

- `endgame_enabled`
- `extended_corruption_max` (default 150)
- `gate_recovery_value` (default 90)
- `gate_recovery_one_time_only` (default true)
- `dream_*` settings
- `blackout_*` settings + exclusions
- `accidental_aggression_*` settings + exclusions
- `lost_*` settings (spawn rules, npc scaling)

---

## 13) Notes (Tone / Narrative Support)

This system is explicitly about “fine print” bargains:
- players knowingly chase power
- the cost is identity, community, and ultimately self-control
- the world remembers: the Lost become named threats and legends

“Shannara is born” because history becomes myth—and some myths are still walking around, hungry.
