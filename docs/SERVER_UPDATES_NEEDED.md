# Server Updates Needed (Combat Alignment Plan)

This plan aligns the server combat implementation in `.agents/Server/src` with
`.agents/Server/docs/COMBAT_SYSTEM.md` and related system docs.

## 1) Core Combat Loop & ATB

- Wire derived `attackSpeedBonus` into ATB fill.
  - Source: `StatCalculator.calculateDerivedStats(...)`.
  - Update: `.agents/Server/src/world/DistributedWorldManager.ts` to pass a real
    bonus function into `CombatManager.update`.
  - Refs: `.agents/Server/src/combat/CombatManager.ts:49`, `.agents/Server/src/world/DistributedWorldManager.ts:1814`.
- Make auto-attacks build ATB as specified.
  - Update: `.agents/Server/src/world/DistributedWorldManager.ts` in
    `processAutoAttacks` to call `combatManager.addAtb(attackerId, X)` after a
    successful auto-attack (tunable amount).
  - Refs: `.agents/Server/src/world/DistributedWorldManager.ts:1891`.

## 2) Action Queue & Cast Times

- Add a combat action queue with optional cast times.
  - New data structure: queued actions with `readyAt`.
  - Validate on enqueue (range/resources/cooldowns), execute when ready.
  - File targets: `.agents/Server/src/combat/CombatManager.ts` (queue), and
    `.agents/Server/src/world/DistributedWorldManager.ts` (enqueue + tick).
  - Refs: `.agents/Server/src/combat/CombatManager.ts:1`, `.agents/Server/src/world/DistributedWorldManager.ts:862`.
- Respect `effectDuration` for cooldown start (cooldown starts when effect ends).
  - Update: `.agents/Server/src/world/DistributedWorldManager.ts` to delay
    cooldown start when `ability.effectDuration` is set.
  - Refs: `.agents/Server/src/combat/types.ts:50`, `.agents/Server/src/world/DistributedWorldManager.ts:974`.

## 3) Targeting & Area Effects

- Implement AoE targeting using `ability.aoeRadius`.
  - Validate range to center, then apply damage to all entities within radius.
  - Include multi-target damage scaling from `COMBAT_SYSTEM.md`.
  - File targets: `.agents/Server/src/world/DistributedWorldManager.ts`.
  - Refs: `.agents/Server/src/combat/types.ts:26`, `.agents/Server/src/world/DistributedWorldManager.ts:862`.
- Implement line/cone targeting if the ability definition requests it.
  - Add fields to `CombatAbilityDefinition` if needed.
  - Use bearing/range from positions to test geometry.
  - Refs: `.agents/Server/src/world/DistributedWorldManager.ts:1213`.

## 4) Status Effects & Combat Effects Events

- Add a status effect manager and tick loop.
  - Support buffs, debuffs, DoT/HoT, and durations.
  - Emit `combat_effect` events on apply/expire/tick.
  - File targets: `.agents/Server/src/combat` (new manager), and
    `.agents/Server/src/world/DistributedWorldManager.ts` (integration).
  - Refs: `.agents/Server/src/combat/types.ts:4`, `.agents/Server/src/world/DistributedWorldManager.ts:862`.

## 5) Stat-Driven Outcomes

- Replace hard-coded crit/penetrating/deflected chances with derived stats.
  - Source: derived stats in `StatCalculator`.
  - File targets: `.agents/Server/src/world/DistributedWorldManager.ts`,
    `.agents/Server/src/combat/DamageCalculator.ts`.
  - Refs: `.agents/Server/src/world/DistributedWorldManager.ts:1207`, `.agents/Server/src/combat/DamageCalculator.ts:134`.

## 6) Resource Costs & Ability Model

- Confirm `basic_attack` ATB cost behavior.
  - If basic attack should be ATB-free, set `atbCost: 0` or mark `isFree: true`.
  - If ATB-gated, document the intended flow clearly.
  - File target: `.agents/Server/src/combat/AbilitySystem.ts`.
  - Refs: `.agents/Server/src/combat/AbilitySystem.ts:12`.

## 7) Event Coverage & Payloads

- Ensure events emitted match combat spec:
  - `combat_start`, `combat_action`, `combat_hit`, `combat_miss`,
    `combat_effect`, `combat_death`, `combat_end`.
- Include mitigation breakdown in hit events where possible.
  - File target: `.agents/Server/src/world/DistributedWorldManager.ts`.
  - Refs: `.agents/Server/src/combat/types.ts:4`, `.agents/Server/src/world/DistributedWorldManager.ts:1066`.

## 8) Tests & Validation

- Add unit tests for:
  - ATB fill timing with attack speed bonus.
  - Queue + cast time execution order.
  - AoE targeting and multi-target scaling.
  - Status effects apply/expire/tick behavior.
- Add a small integration test path to simulate:
  - Basic attack, miss, hit, death, combat end.

## Suggested Execution Order

1) ATB + auto-attack ATB gain
2) Action queue + cast time + cooldown timing
3) AoE + multi-target scaling
4) Status effects + combat_effect
5) Stat-driven outcome cleanup
6) Ability model verification + docs sync
