# Next Session Priorities

**Expected Order**: 1 → 3 → 2 → rest (if time)

---

## Owner Notes (Next Session)

- NPC personality matrix for LLM context
- Simple grouping with NPCs or other players
- Stephentown area pass (persistent structure vs ephemeral)
- Cyberspace layer for deck/jack-in/technomance play
- Push client work toward the 3D client

---

## Priority 1: Combat System Implementation

With spatial navigation now complete (bearing/elevation/range), we can implement the core combat mechanics.

### Why This Is Next

- **Foundation Ready**: We have:
  - Full stat system (core + derived stats)
  - Ability point system and loadouts (8 active, 8 passive, 4 special)
  - Spatial targeting data for all entities
  - Proximity roster with combat awareness (`dangerState` flag)

- **Natural Progression**: Combat builds directly on spatial navigation
  - Text clients can `attack giant.ant.1` using bearing/range
  - 3D clients can click entities and use spatial data for positioning
  - LLM NPCs can make tactical decisions with proximity data

### Key Components to Implement

#### 1. Ability System
- **Ability Definitions** (database schema)
  - ID, name, description, icon
  - Type: physical, magic, special
  - Cost: HP, stamina, mana
  - Cooldown, cast time, range
  - Targeting: single, AoE, self, cone, line
  - Damage formula referencing derived stats
  - Status effects applied

- **Ability Execution**
  - Validate target in range
  - Check resource costs
  - Apply cooldowns
  - Calculate damage/effects using derived stats
  - Send combat events to all nearby players

#### 2. Combat Loop
- **Turn Resolution** (already have `COMBAT_TICK_RATE=20`)
  - Initiative system (uses `derivedStats.initiative`)
  - Action queue processing
  - Auto-attack system
  - Ability queue management

- **Damage Calculation**
  - Physical: `attackRating` vs `defenseRating`, modified by `physicalAccuracy` and `evasion`
  - Magic: `magicAttack` vs `magicDefense`, modified by `magicAccuracy` and `magicEvasion`
  - Absorption: `damageAbsorption` and `magicAbsorption` reduce incoming damage
  - Glancing blows: `glancingBlowChance` for partial damage
  - Critical hits (if implementing)

- **Combat State**
  - Enter/exit combat mode
  - Set `dangerState` in proximity roster (gates CFH usage)
  - Combat timeout (auto-exit after X seconds of no actions)

#### 3. Status Effects
- **Effect Types**
  - Buffs (stat increases, shields, regeneration)
  - Debuffs (stat decreases, DoTs, stuns, slows)
  - Duration tracking
  - Stack management

- **Effect Application**
  - Apply on ability hit
  - Tick processing (DoTs, HoTs)
  - Expiration handling
  - Display to client

#### 4. Combat Events
- **Event Messages** (send to all nearby players)
  - `combat_start`: Combat initiated
  - `combat_action`: Ability used
  - `combat_hit`: Damage dealt
  - `combat_miss`: Attack missed
  - `combat_effect`: Status effect applied/removed
  - `combat_death`: Entity defeated
  - `combat_end`: Combat concluded

### Files to Create/Modify

**New Files:**
- `src/combat/CombatManager.ts` - Core combat loop, turn resolution
- `src/combat/AbilitySystem.ts` - Ability execution, cooldowns
- `src/combat/DamageCalculator.ts` - Damage formulas using derived stats
- `src/combat/StatusEffectManager.ts` - Buff/debuff tracking
- `prisma/migrations/XXX_add_abilities.sql` - Ability tables

**Modify:**
- `src/world/ZoneManager.ts` - Add combat state tracking, set `dangerState`
- `src/network/protocol/types.ts` - Add combat event message types
- `src/network/handlers/CombatHandler.ts` - Handle `combat_action` from clients
- `docs/COMBAT_SYSTEM.md` - Document combat mechanics

### Success Criteria

- [ ] Player can target entity using proximity roster data
- [ ] Player can execute basic attack ability
- [ ] Damage calculated using derived stats (attack rating, defense rating, etc.)
- [ ] Combat events sent to all nearby players
- [ ] Status effects apply and tick
- [ ] Combat mode sets `dangerState` in proximity roster
- [ ] Combat timeout exits combat after inactivity
- [ ] Text client can attack specific targets (e.g., `attack ant.worker.2`)
- [ ] MUD client can use Approach/Evade buttons for tactical positioning

### Phase 2 Combat Follow-Ups

- [ ] Status effects manager (buff/debuff/DoT/HoT) + `combat_effect` events.
- [ ] Haste/slow hooks that modify ATB fill (no RNG).
- [ ] Casting escrow/now_casting bucket; refund on interrupt/failure.
- [ ] Channeled upkeep system (persistent MP drain while other casts continue).
- [ ] Validate/extend AoE + line/cone targeting (LOS, better shapes, balance).

---

## Priority 3: NPC AI Enhancement

The LLM integration is set up, but NPCs need more behaviors beyond chat.

### Why This Is Third

- **Combat Dependency**: NPCs need combat system to fight back
- **Spatial Navigation**: NPCs can now make movement decisions using bearing/elevation/range
- **LLM Foundation**: Already have multi-provider support (Anthropic, OpenAI-compatible)

### Key Components to Enhance

#### 1. Movement AI
- **Decision Making**
  - Wandering behavior (random walk within zone bounds)
  - Following targets (companions, hostile mobs)
  - Fleeing from danger (low HP, overwhelmed)
  - Patrolling routes (guards, merchants)

- **Using Spatial Data**
  - NPCs receive same proximity roster as players
  - Can navigate toward/away from entities using bearing/range
  - Respect movement speeds (walk/jog/run)

#### 2. Combat AI
- **Target Selection**
  - Aggro system (threat table)
  - Target switching (healers, low HP targets)
  - AoE positioning

- **Ability Usage**
  - Ability priority system
  - Cooldown management
  - Resource conservation (don't spam expensive abilities)
  - Tactical decisions (heal when low HP, buff before combat)

#### 3. LLM-Enhanced Behaviors
- **Personality-Driven Actions**
  - Friendly merchant: approaches players, initiates trade
  - Hostile guard: challenges trespassers, attacks on aggression
  - Mysterious wanderer: avoids crowds, cryptic emotes

- **Context-Aware Responses**
  - React to combat (flee, fight, call for help)
  - React to world events (zone transitions, weather changes)
  - React to player actions (trade requests, gifts, threats)

#### 4. Memory & Relationships
- **Short-Term Memory**
  - Recent conversations (last 10 messages)
  - Recent interactions (trades, combat, gifts)
  - Current goals/objectives

- **Long-Term Memory** (database-backed)
  - Relationship tracking (friendly, neutral, hostile per player)
  - Quest state per player
  - Learned facts about world/players

### Files to Modify/Create

**Enhance:**
- `src/ai/NPCController.ts` - Add movement, combat, and decision-making
- `src/ai/LLMService.ts` - Add action generation beyond chat (move, attack, use item)
- `src/world/DistributedWorldManager.ts` - NPC tick processing

**New Files:**
- `src/ai/behaviors/WanderBehavior.ts` - Random movement
- `src/ai/behaviors/FollowBehavior.ts` - Track target
- `src/ai/behaviors/FleeBehavior.ts` - Escape danger
- `src/ai/behaviors/PatrolBehavior.ts` - Route following
- `src/ai/CombatAI.ts` - NPC combat decision tree
- `src/ai/MemoryManager.ts` - Conversation and relationship tracking

### Success Criteria

- [ ] NPC wanders within zone bounds when idle
- [ ] NPC follows companion owner when summoned
- [ ] NPC enters combat and uses abilities against targets
- [ ] NPC flees when HP drops below threshold
- [ ] LLM generates contextual chat based on combat state
- [ ] NPC remembers recent conversation for context
- [ ] NPC relationship values affect behavior (friendly NPCs assist, hostile attack)

---

## Priority 2: Inventory & Equipment System

With combat working, players need items, equipment, and loot.

### Why This Is Second

- **Combat Dependency**: Need combat working to drop loot
- **Stat Modifications**: Equipment modifies derived stats
- **Special Abilities**: Equipment grants 4 special ability slots

### Key Components

#### 1. Item System
- **Item Types**
  - Weapons (melee, ranged, magic)
  - Armor (head, chest, hands, legs, feet)
  - Accessories (rings, amulets, trinkets)
  - Consumables (potions, food, scrolls)
  - Quest items
  - Trade goods

- **Item Properties**
  - Base stats (damage, armor, etc.)
  - Stat modifiers (+ strength, + vitality, etc.)
  - Special abilities granted (4 special slots)
  - Rarity (common, uncommon, rare, epic, legendary)
  - Bind rules (bind on pickup, bind on equip, tradeable)
  - Level requirements

#### 2. Inventory Management
- **Storage**
  - Player inventory (configurable size based on `carryingCapacity`)
  - Bank storage (persistent, larger capacity)
  - Quest item storage (separate, unlimited)

- **Operations**
  - Add/remove items
  - Stack consumables
  - Weight/capacity limits
  - Item sorting/filtering

#### 3. Equipment System
- **Equipment Slots**
  - Main hand, off hand
  - Head, chest, hands, legs, feet
  - 2 accessory slots (rings/amulets)

- **Stat Recalculation**
  - When equipment changes, recalculate derived stats
  - Update special ability loadout (4 slots from equipment)
  - Send stat update to client

#### 4. Trading
- **Trade Windows**
  - Player-to-player trades
  - NPC vendor trades
  - Trade confirmation flow

- **Economy**
  - Currency system
  - Vendor buy/sell prices
  - Vendor inventory (static or dynamic)

#### 5. Loot System
- **Loot Tables**
  - Per-creature loot definitions
  - Drop rates (weighted random)
  - Loot scaling (by player level, difficulty)

- **Distribution**
  - Solo: all loot to player
  - Party: round-robin, need/greed, master looter

### Files to Create

**New:**
- `src/inventory/InventoryManager.ts` - Inventory operations
- `src/inventory/EquipmentManager.ts` - Equipment and stat recalc
- `src/inventory/TradingSystem.ts` - Trade windows and flow
- `src/combat/LootSystem.ts` - Loot generation and distribution
- `prisma/migrations/XXX_add_items.sql` - Item and inventory tables

**Modify:**
- `src/world/ZoneManager.ts` - Drop loot on creature death
- `src/network/protocol/types.ts` - Add inventory/trade message types
- `src/network/handlers/InventoryHandler.ts` - Handle inventory actions

### Success Criteria

- [ ] Player receives starting equipment on character creation
- [ ] Equipping item recalculates derived stats correctly
- [ ] Equipment grants special abilities (4 slots)
- [ ] Inventory respects carrying capacity
- [ ] Creatures drop loot on death
- [ ] Player can trade items with other players
- [ ] Player can buy/sell items from NPC vendors
- [ ] Bank storage persists across sessions

---

## Rest of List (If Time)

### 4. Quest System
- Quest definitions and progression tracking
- Objective types (kill, collect, interact, escort)
- Quest rewards (XP, items, currency)
- Quest journal/log

### 5. Zone Transitions & World Persistence
- Zone boundary detection and transfers
- Cross-zone coordination via Redis
- World state persistence (save/load)

### 6. Wildlife/Creature System
- Spawn points and population management
- Creature AI (wandering, aggression, fleeing)
- Ecosystem simulation (tick rate already configured)
- Growth/aging impact on combat stats and level progression
- Combat experience: creatures that survive fights level up and grow stronger

### 7. Party/Group System
- Party formation and management
- Shared experience and loot
- Party chat channel
- Group-based abilities
- Core flow: invite, join, leave, kick
- Max party size: 5 members
- `state_update.allies` should include party members' MP/Stamina percentages and ATB only
- Alliance layer: up to 6 parties (raid structure)
- Decide on alliance vs. large war-band model (EVE-style vs. capped raids)

### 8. Guild/Clan System
- Guild creation and membership
- Guild ranks and permissions
- Guild storage/bank
- Guild chat channel

### 9. Automated Testing
- Unit tests for core systems
- Integration tests for client-server flow
- Load testing with multiple concurrent clients

### 10. Client Development
- **MUD Client Features** (already has solid foundation):
  - Position ring widget for tactical combat
  - Nearby entity roster with Approach/Evade
  - Movement commands (Walk.N, Jog.NE, Run.045)
  - Macro buttons for quick actions
  - Content rating display

- **LLM Airlock Features** (already has safety layer):
  - Pre-LLM checks (canSpeak, getSocialMode, canUseCFH)
  - Action validation (proximity rules, crowd mode)
  - Social context prompts (adjusts per audience size)
  - LLM output verification before forwarding

### 11. Database Optimization
- Query performance analysis
- Indexing strategy
- Connection pooling tuning
- Cache layer optimization

### 12. Monitoring & Observability
- Metrics collection (player counts, zone loads)
- Performance monitoring
- Error tracking and alerting
- Admin dashboard

---

## Existing Client Context

You already have two functional clients in progress:

### AshesAndAether_MUD_Client
**Tech**: .NET 8, Terminal.Gui, SocketIOClient

**Features (v0.1)**:
- ✅ Scrollback log with optional timestamps
- ✅ Input line with history (up/down)
- ✅ Clickable macro buttons that emit text commands
- ✅ Position ring widget for relative movement intent
- ✅ **Nearby entity roster** - Shows players/NPCs with bearing/elevation/range + Approach/Evade controls
- ✅ WebSocket (Socket.io) handshake + auth flow support
- ✅ Login and character selection dialogs
- ✅ Content rating display from zone data
- ✅ Movement command parsing (`Walk.N`, `Run.045`) into move messages
- ✅ Theme switching with presets and custom palettes

**Protocol Support**:
- Both `event` mode (one event per message type) and `envelope` mode (single event with `{ type, payload }`)

**Location**: `../AshesAndAether_MUD_Client`

**Docs**:
- `docs/mud-client/README.md`
- `docs/mud-client/ui-spec.md`
- `docs/mud-client/config.md`
- `docs/mud-client/commands.md`
- `docs/mud-client/controls.md`
- `docs/mud-client/themes.md`

### AshesAndAether_LLM_Airlock
**Tech**: Node.js + TypeScript

**Features**:
- ✅ **Airlock safety layer** for LLM interactions
- ✅ Pre-LLM checks (canSpeak, getSocialMode, canUseCFH)
- ✅ Action validation (proximity rules, crowd mode name restrictions)
- ✅ Social context prompts (adjusts per audience size: silent, personal, small_group, crowd)
- ✅ LLM output verification before server forwards
- ✅ Provider-agnostic LLM settings (LMStudio, OpenAI-compatible, Claude)
- ✅ Smoke test script: `npx tsx scripts/lmstudio-smoke.ts`
- ✅ Interactive dashboard: `npx tsx scripts/lmstudio-dashboard.ts`

**Provider Support**:
- Anthropic Claude
- OpenAI
- LMStudio (local)
- Ollama (local)
- Any OpenAI-compatible endpoint

**Location**: `../AshesAndAether_LLM_Airlock`

**Docs**:
- `README.md`
- `ARCHITECTURE.md`
- `COMMUNICATION_SYSTEM.md`
- `PROXIMITY_AND_PERCEPTION.md`
- `SERVER_READY.md`
- `QUICKSTART.md`

---

## Integration Points

When implementing combat (Priority 1):

1. **MUD Client** can immediately use:
   - Nearby entity roster → Attack/target selection
   - Approach/Evade buttons → Tactical positioning during combat
   - Macro buttons → Quick ability execution (`attack {target}`, `cast "Drain" {target}`)
   - Position ring widget → Position around target at specific range/angle

2. **LLM Airlock** provides:
   - Combat-aware social modes (NPCs don't chat casually while fighting)
   - CFH gating via `dangerState` (emergency broadcast only in combat/danger)
   - Action validation (prevent illegal actions during combat)

3. **Server Integration**:
   - Set `dangerState: true` in proximity roster when combat starts
   - Send combat events to all clients in range
   - Use spatial data (bearing/elevation/range) for ability targeting validation
   - Update proximity roster as entities move during combat

---

## Notes

- **Spatial Navigation**: Already complete with bearing/elevation/range for all entities
- **Stat System**: Already complete (core stats + 12 derived stats)
- **Ability Loadouts**: Already have slots (8 active, 8 passive, 4 special from equipment)
- **Database**: PostgreSQL + Prisma ORM, already integrated
- **LLM Integration**: Multi-provider support already working
- **Protocol**: Complete with all message types defined

**Combat is the natural next step** - it leverages everything we've built and unlocks the rest of the gameplay loop.
