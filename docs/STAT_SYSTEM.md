# Stat System - Ashes & Aether MMO

## Philosophy

**Player agency through tactical builds.** Mix supernatural powers, cybernetic enhancements, and traditional combat in a system that rewards smart builds over grinding. Controller-friendly for cozy combat.

---

## Core Stats (6 Primary Attributes)

These are the foundation of your character. Raised with XP.

### Physical Stats

**Strength (STR)**
- **Primary Use**: Weight capacity, strength-based weapon damage
- **Affects**:
  - Carrying capacity (inventory weight)
  - Melee weapon damage bonus (clubs, axes, hammers, unarmed)
  - Strength feat requirements
  - Breaking/forcing objects
  - Grappling power

**Vitality (VIT)**
- **Primary Use**: Survivability and endurance
- **Affects**:
  - Maximum HP (10 HP per point)
  - Damage absorption (reduce incoming physical damage)
  - Resistance to poison, disease, fatigue
  - Physical status effect resistance
  - Natural healing rate

**Dexterity (DEX)**
- **Primary Use**: Precision and fine motor control
- **Affects**:
  - Physical accuracy (hit chance)
  - Dexterity weapon damage (daggers, rapiers, whips)
  - Parry accuracy (active defense)
  - Crafting precision
  - Lockpicking, sleight of hand

**Agility (AGI)**
- **Primary Use**: Speed and reflexes
- **Affects**:
  - Evasion (dodge incoming attacks)
  - Agility weapon damage (dual-wield, fist weapons, thrown)
  - Initiative (turn order in ATB combat)
  - Glancing blow chance (partial damage reduction)
  - Movement speed bonus

### Mental Stats

**Intelligence (IQ)**
- **Primary Use**: Knowledge and magical power
- **Affects**:
  - Magic accuracy (spell hit chance)
  - Magic attack power (offensive spell damage)
  - IQ feat requirements (tech skills, hacking, research)
  - Resist mental attacks (illusions, mind control)
  - Cyberdeck operation effectiveness
  - Crafting complexity (electronics, alchemy)

**Wisdom (WIS)**
- **Primary Use**: Insight and magical defense
- **Affects**:
  - Magic evasion (dodge incoming spells)
  - Magic defense (reduce incoming magic damage)
  - Wisdom feat requirements (perception, healing, divination)
  - Resistance to soul/spirit damage
  - Magic damage absorption
  - Mana regeneration rate

---

## Derived Stats (Calculated from Core Stats)

These are automatically calculated from your core stats + equipment + buffs.

### Combat - Physical

**Attack Rating (ATK)**
```
Base ATK = Weapon Base Damage + Primary Stat Bonus
Primary Stat = STR (heavy weapons), DEX (precision), or AGI (speed weapons)
Formula: Base ATK + (Primary Stat × Weapon Stat Scaling)
```

**Defense Rating (DEF)**
```
DEF = Base Armor + (VIT × 0.5) + Equipment Bonuses
Reduces physical damage taken
```

**Physical Accuracy (P.ACC)**
```
P.ACC = 75 + (DEX × 2) + Weapon Accuracy Bonus + Buffs
Determines hit chance vs target's Evasion
```

**Evasion (EVA)**
```
EVA = 5 + (AGI × 2) + Equipment Bonuses
Determines dodge chance vs attacker's Accuracy
```

**Damage Absorption (ABS)**
```
ABS = (VIT × 0.3) + Armor ABS + Buffs
Flat damage reduction before DEF calculation
```

**Glancing Blow Chance (GBC)**
```
GBC = (AGI × 0.5)%
Chance to convert hit into glancing blow (50% damage)
```

### Combat - Magical

**Magic Attack (M.ATK)**
```
M.ATK = Base Spell Power + (IQ × Spell IQ Scaling)
Offensive spell damage
```

**Magic Defense (M.DEF)**
```
M.DEF = Base Magic Resist + (WIS × 0.5) + Equipment Bonuses
Reduces magic damage taken
```

**Magic Accuracy (M.ACC)**
```
M.ACC = 75 + (IQ × 2) + Focus/Catalyst Bonus
Spell hit chance vs target's M.EVA
```

**Magic Evasion (M.EVA)**
```
M.EVA = 5 + (WIS × 2) + Equipment Bonuses
Chance to dodge incoming spells
```

**Magic Absorption (M.ABS)**
```
M.ABS = (WIS × 0.3) + Equipment M.ABS
Flat magic damage reduction
```

### Resources

**Hit Points (HP)**
```
Max HP = 100 + (VIT × 10) + Equipment + Level Bonuses
```

**Stamina (STA)**
```
Max Stamina = 100 + (VIT × 5) + (AGI × 3)
Used for: Physical abilities, sprinting, dodging
Regenerates: 10/sec out of combat, 3/sec in combat
```

**Mana/Essence (MP)**
```
Max Mana = 100 + (IQ × 5) + (WIS × 5)
Used for: Magic spells, supernatural powers
Regenerates: (WIS × 0.5)/sec
```

**Carrying Capacity (Weight)**
```
Max Weight = (STR × 10) kg
Encumbered at 75%+ (movement penalty)
Overencumbered at 100%+ (can't run)
```

### Speed & Timing

**Initiative (Combat Turn Order)**
```
Initiative = AGI + d20 (rolled at combat start)
Determines action order in ATB system
```

**Movement Speed**
```
Base Speed = 5 m/s + (AGI × 0.1)
Modified by: Equipment weight, status effects, terrain
```

**Attack Speed (Cooldown Reduction)**
```
Attack Speed Bonus = (AGI × 0.5)%
Reduces ability cooldowns
```

---

## Progression System: XP vs AP

### Experience Points (XP) - Character Growth

**Earned From:**
- Defeating enemies
- Completing quests
- Discovering new areas
- Crafting items
- Social interactions (RP rewards)

**Spent On:**
- **Core stat increases** (cost scales: 100 XP × current stat level)
- **Skill unlocks** (weapon proficiencies, crafting, etc.)
- **Equipment unlock tiers** (access to better armor/weapons)
- **Feat unlocks** (passive bonuses tied to stats)

**Example XP Costs:**
- STR 10 → 11: 1,000 XP
- STR 11 → 12: 1,100 XP
- Unlock "Heavy Armor Proficiency": 5,000 XP
- Unlock "Two-Handed Weapons III": 8,000 XP

### Ability Points (AP) - Combat Abilities

**Earned From:**
- Level-up milestones (1 AP per 5 levels)
- Completing challenging content (dungeons, bosses)
- Faction reputation milestones
- Special achievements
- Story milestones

**Spent On:**
- **Active abilities** (attacks, buffs, heals)
- **Passive abilities** (permanent bonuses)
- **Special abilities** (equipment-linked powers)

**AP is scarce** - forces meaningful build choices.

---

## Ability System: Tactical Loadouts

### The 8/8/4 System

Players can have many abilities unlocked but can only **equip a limited loadout**:

**Active Abilities (8 slots)**
- Offensive skills (attacks, spells)
- Support skills (buffs, heals)
- Utility skills (movement, crowd control)
- **Always usable when equipped**
- **Cooldown-based** (no mana cost for most)

**Passive Abilities (8 slots)**
- Permanent stat bonuses
- Conditional triggers (on hit, on crit, etc.)
- Resistance buffs
- Resource regeneration
- **Always active when equipped**

**Special Abilities (4 slots)**
- **Equipment-linked** - tied to weapon/armor type
- High-impact, long cooldown
- Signature moves
- **Example**: "Cursed Blade Strike" (only usable with cursed weapons)

### Controller Mapping (For Visual Clients)

**D-Pad**: Actives 1-4
**Face Buttons (ABXY/✕○□△)**: Actives 5-8
**Bumpers (L1/R1)**: Cycle through Specials 1-4
**Triggers (L2/R2)**: Use selected Special

**Passives**: Always active, no input needed

---

## Ability Trees & Progression

### Tree Structure

Abilities are organized in **skill trees** based on:
- Combat styles (melee, ranged, magic)
- Supernatural types (vampire, werewolf, mage, etc.)
- Cybernetics (body mods, neural implants)
- Crafting specializations

**Example Tree: Vampire Blood Magic**
```
Tier 1 (1 AP):
  ├─ Blood Strike (Active) - Drain HP from target
  └─ Hemomancy (Passive) - +10% healing from blood

Tier 2 (2 AP, requires Tier 1):
  ├─ Blood Shield (Active) - Consume HP for temporary shield
  ├─ Crimson Tide (Active) - AoE blood damage
  └─ Sanguis Vitae (Passive) - Lifesteal on melee attacks

Tier 3 (3 AP, requires 2× Tier 2):
  ├─ Blood Frenzy (Active) - Berserk mode, HP drain over time
  └─ Exsanguination (Special) - Ultimate blood drain ability
```

### Multi-Classing

**You can invest in multiple trees** - no class restrictions.

Want to be a cyborg vampire wizard? Go for it. The 8/8/4 loadout limit forces tactical choices.

---

## Stat Scaling by Weapon Type

Different weapons scale with different stats:

| Weapon Type | Primary Stat | Secondary Stat | Scaling |
|-------------|-------------|----------------|---------|
| Greatswords, Hammers | STR | - | S (1.2×) |
| Longswords, Axes | STR | DEX | A (1.0×) |
| Rapiers, Daggers | DEX | AGI | A (1.0×) |
| Dual Wield | AGI | DEX | B (0.8×) |
| Fist Weapons | STR | AGI | B (0.8×) |
| Bows, Crossbows | DEX | - | A (1.0×) |
| Thrown Weapons | AGI | STR | B (0.8×) |
| Staves, Wands | IQ | WIS | S (1.2×) |

**Scaling Formula**:
```
Weapon Damage = Base Damage + (Primary Stat × Primary Scaling) + (Secondary Stat × Secondary Scaling × 0.5)
```

---

## Status Effects & Conditions

### Physical Conditions
- **Bleeding**: DoT, reduces healing received
- **Poisoned**: DoT, reduces stats
- **Stunned**: Can't act for X seconds
- **Slowed**: Movement speed reduced
- **Weakened**: Reduced physical damage output

### Magical Conditions
- **Burning**: Fire DoT
- **Frozen**: Can't move, increased damage taken
- **Shocked**: Periodic stun triggers
- **Cursed**: Reduced healing, increased damage taken
- **Silenced**: Can't use magic abilities

### Supernatural Conditions
- **Soul Wounded**: Max HP reduced
- **Essence Drained**: Max Mana reduced
- **Frenzy**: Lose control (berserker state)
- **Dominated**: Mind controlled

**Resistance Formula**:
```
Resist Chance = (Relevant Stat × 0.5) + Buffs - Enemy Potency
```

---

## Equipment System

### Weapon Types
- **One-Handed Melee**: Swords, axes, maces, daggers
- **Two-Handed Melee**: Greatswords, polearms, hammers
- **Dual-Wield**: Two one-handed weapons (special bonuses)
- **Ranged Physical**: Bows, crossbows, thrown weapons
- **Ranged Magic**: Staves, wands, focuses
- **Cyber Weapons**: Arm blades, plasma guns, mono-whips

### Armor Sets
- **Light Armor**: High AGI, low DEF (cloth, leather)
- **Medium Armor**: Balanced (chain, scale)
- **Heavy Armor**: High DEF, low AGI (plate, power armor)
- **Cyber Armor**: Integrated systems, tech bonuses
- **Supernatural**: Enchanted gear, unique effects

### Special Abilities Tied to Equipment

**Example**: Wearing "Vampire Covenant Armor Set" (4 pieces) unlocks:
- Special 1: "Mist Form" (become invulnerable, can't attack)
- Special 2: "Bloodlust Aura" (party buff)

**Example**: Wielding "Techno-Katana" unlocks:
- Special 1: "Neon Slash" (charge attack)
- Special 2: "Phase Strike" (teleport behind enemy)

---

## Feat System

**Feats are passive unlocks** tied to core stat milestones.

**Strength Feats:**
- STR 15: **Power Attack** - Melee attacks have +10% damage but +5% stamina cost
- STR 25: **Titan's Grip** - Can dual-wield two-handed weapons
- STR 40: **Unbreakable** - Cannot be staggered by attacks

**Vitality Feats:**
- VIT 15: **Thick Skinned** - +10% damage absorption
- VIT 25: **Iron Constitution** - Immune to poison and disease
- VIT 40: **Phoenix Rebirth** - Survive fatal damage once per day (1 HP)

**Dexterity Feats:**
- DEX 15: **Precision Strike** - +5% critical hit chance
- DEX 25: **Riposte Master** - Perfect parry triggers counterattack
- DEX 40: **Assassin's Focus** - Critical hits deal 2x damage instead of 1.5x

**Agility Feats:**
- AGI 15: **Fleet Footed** - +10% movement speed
- AGI 25: **Elusive** - First dodge in combat has no stamina cost
- AGI 40: **Bullet Time** - Briefly slow time after perfect dodge

**Intelligence Feats:**
- IQ 15: **Spell Mastery** - -10% mana cost for all spells
- IQ 25: **Overcharge** - Spells can be charged for +50% damage
- IQ 40: **Archmage** - Can memorize two additional spells

**Wisdom Feats:**
- WIS 15: **Inner Peace** - +50% mana regeneration out of combat
- WIS 25: **Spell Ward** - First spell hit each combat absorbed
- WIS 40: **Transcendence** - Immune to mental status effects

---

## Progression Example

**New Character (Level 1):**
- Core Stats: All 10 (base)
- HP: 200 (100 + 10×10)
- Stamina: 100
- Mana: 100
- XP: 0
- AP: 0
- Abilities: None (must unlock)

**Mid-Game (Level 25):**
- Core Stats: STR 18, VIT 22, DEX 12, AGI 15, IQ 14, WIS 16
- HP: 320
- Stamina: 185
- Mana: 250
- Active Loadout: 8/8 abilities equipped
- Passive Loadout: 8/8 passives equipped
- Special Loadout: 4/4 equipment specials

**End-Game (Level 50+):**
- Core Stats: Specialized build (30-40 in primary stats)
- HP: 500+
- Multiple ability trees unlocked
- Full 8/8/4 optimized loadout
- Legendary equipment with unique specials

---

## Database Implementation

### Character Stats Storage

```typescript
// In Prisma schema
model Character {
  // Core stats
  strength     Int  @default(10)
  vitality     Int  @default(10)
  dexterity    Int  @default(10)
  agility      Int  @default(10)
  intelligence Int  @default(10)
  wisdom       Int  @default(10)

  // Derived stats (cached for performance)
  maxHp        Int  @default(200)
  maxStamina   Int  @default(100)
  maxMana      Int  @default(100)
  attackRating Float @default(10)
  defenseRating Float @default(10)

  // Current state
  currentHp    Int
  currentStamina Int
  currentMana  Int

  // Progression
  level        Int  @default(1)
  experience   Int  @default(0)
  abilityPoints Int @default(0)

  // Unlocked abilities (JSON array of IDs)
  unlockedAbilities Json @default("[]")

  // Equipped loadout
  activeLoadout  Json @default("[]")  // 8 ability IDs
  passiveLoadout Json @default("[]")  // 8 ability IDs
  specialLoadout Json @default("[]")  // 4 ability IDs (from equipment)

  // Unlocked feats
  unlockedFeats Json @default("[]")
}
```

---

## Next Steps

1. **Define ability templates** - Create ability definitions (damage, cooldown, cost, effects)
2. **Implement stat calculation** - Build derived stat calculator
3. **Create ability trees** - Design skill trees for different builds
4. **Equipment special abilities** - Define equipment-linked specials
5. **Combat formula** - Hit/miss/damage calculations using stats
6. **Dev tools** - Character builder, stat calculator, ability tester

This system gives **massive build variety** while keeping combat tactical and controller-friendly. The 8/8/4 limit forces meaningful choices.

Want me to start implementing any of this?
