# Combat System (ATB)

This document defines the Active Time Battle (ATB) combat loop for the Ashes & Aether server.
It focuses on server-authoritative rules, event flow, and the minimal data model needed to implement.

## Goals

- Real-time ATB (no turns, no pauses).
- Server-authoritative validation and resolution.
- Supports text, 2D, 3D, and VR clients.
- Uses existing stats (core + derived) and proximity roster spatial data.
- Clear hooks for NPC AI and LLM airlock control.

## Core Concepts

### Combat State

- An entity is "in combat" if it has a recent hostile action or was targeted by one.
- Combat state is per-entity and per-encounter (zone-level grouping for now).
- Combat state sets `dangerState = true` in proximity roster for that entity.
- Combat auto-exits after inactivity timeout.

### ATB Gauge

- Each entity has an ATB gauge from 0 to 100.
- Gauge fills continuously: `fillRate = derivedStats.attackSpeedBonus + baseRate`.
- When gauge reaches 100, the entity can execute an action.
- Using an action consumes 0..100, depending on ability used.

### Auto-Attack

- Auto-attacks tick on a timer (affected by slow/haste).
- Auto-attacks are outside the global cooldown and do not require ATB.
- Auto-attacks build ATB; some builds can rely on them for sustained actions.

### Builders, Free Abilities, Ults

- Builders can push ATB above 100 (allowing back-to-back actions). They have long cooldowns.
- Free abilities cost no ATB and only use cooldowns; cooldown starts when the effect ends.
- Ults consume 100 ATB and have very long cooldowns (900s+).

### Action Queue

- Client sends /spell or /ability when ready and the server enqueues it.
- Server validates action: cooldowns, range, resources, target visibility.
- On validation success, resolve immediately (no delay) or after cast time.

### Targeting

- Single target: requires target within range and in same zone.
- AoE target: validate radius and affected entities.
- Line or cone: validate geometry using bearing and range.

### Range Units

- Proximity roster uses feet.
- World positions are meters.
- Convert: `feet * 0.3048 = meters`.

## Combat Flow (Server Side)

1) Detect hostile action -> mark combat start.
2) For each combat tick:
   - Update ATB gauge for all combatants.
   - Process any queued actions that are ready.
   - Apply ongoing effects (DoT, HoT, buffs).
3) Broadcast combat events.
4) Exit combat after inactivity timeout.

## Event Types (to clients)

- `combat_start`
- `combat_action`
- `combat_hit`
- `combat_miss`
- `combat_effect`
- `combat_death`
- `combat_end`

## Action Types

- Basic attack (melee/ranged)
- Ability cast (resource cost, cooldown, range)
- Defensive (guard, evade, block)
- Utility (taunt, heal, buff, debuff)

## Damage Model (Initial Pass)

### Physical

- Base: `attackRating` vs `defenseRating`
- Accuracy: `physicalAccuracy` vs `evasion`
- Absorption: `damageAbsorption`
- Critical Hits: `criticalHitChance`
- Glancing blows: `glancingBlowChance`
- Penetrating blows: `penetratingBlowChance`
- Deflected blows: `deflectedBlowChance`

### Magic

- Base: `magicAttack` vs `magicDefense`
- Accuracy: `magicAccuracy` vs `magicEvasion`
- Absorption: `magicAbsorption`

### Output

- `combat_hit` with amount, type, and mitigation breakdown.
- `combat_miss` when accuracy roll fails.

## Status Effects

- Buffs: increase stats or grant shields.
- Debuffs: reduce stats, apply DoT, slow, stun.
- Duration in seconds, ticks at COMBAT_TICK_RATE.
- Stack rules: replace, refresh, or stack (per effect definition).

## Engagement Rules

- Combat starts when a hostile action lands or is attempted on a valid target.
- Combat ends after `COMBAT_TIMEOUT_MS` with no hostile actions.
- Leaving range does not end combat immediately; it may trigger disengage timers.

## Commands Integration

Slash commands are first class scripts and should generate combat events:

- `/attack <target>` -> basic melee
- `/cast <ability> <target>` -> ability cast (aliases: /ability, /magic)
- `/flee` -> escape attempt
- `/guard <target>` -> damage reduction on ally

These commands route through the command system and publish combat actions into the zone input channel.

## AI Integration

- NPC AI uses the same proximity roster for target selection.
- LLM-driven NPCs can request actions via airlock, but server validates the same rules.

## Data Structures (Proposed)

### Combatant State

- entityId
- zoneId
- inCombat
- atbGauge
- cooldowns
- activeEffects
- lastHostileAt

### Combat Action

- actionId
- sourceId
- targetId
- abilityId
- timestamp
- castTime
- cost

## Tuning Defaults (Proposed)

- `COMBAT_TICK_RATE = 20`
- `ATB_BASE_RATE = 10` gauge per second
- `COMBAT_TIMEOUT_MS = 15000`

## Open Questions

- How do we group encounters: per-zone or per-target cluster?
  - Prefer per-target cluster (local engagement group).

- How do we handle line-of-sight for ranged attacks?
  - Check at time of ability use; if blocked, the ability hits the blocker.

- How do we resolve interrupts and counter-attacks?
  - Status effects (stun/sleep/paralysis) pause ATB until they expire.

- How do we cap multi-target damage in large fights?
  - Scale total damage with targets hit (+10% per target), then divide among all targets.
  - Example: 1 target = 100%; 2 targets = 120%/2 = 60% each; 5 targets = 150%/5 = 30% each.
  - Single-target remains efficient; AoE grows total output without dominating.

## Next Implementation Steps

1) Create `CombatManager` with tick loop and combatant tracking.
2) Implement `AbilitySystem` with cooldown and resource validation.
3) Implement `DamageCalculator`.
4) Emit combat events and integrate with proximity roster `dangerState`.
