# Slash Command Proposal

**Status**: DRAFT - Needs approval before implementation

This document proposes the initial set of slash commands aligned with the Ashes & Aether MMO vision.

---

## Philosophy Alignment

From VISION.md and game design:

- Post-apocalyptic survival horror
- Narrative-driven with LLM narrator
- Social interaction and investigation
- No hand-holding, dangerous world
- Players are Changed (werewolves, vampires, etc.)
- Upstate NY real geography

Commands should:

- Support narrative gameplay (not just mechanics)
- Enable investigation and social RP
- Respect the danger/horror atmosphere
- Work for Changed abilities (not generic fantasy)
- Integrate with LLM narrator

---

## Tier 1: Essential Commands (Implement First)

### Movement

```bash
/move <direction>              # Move in cardinal/compass direction
/move heading:<degrees>        # Move at specific heading
/move to:<entity>[:range (melee, short, medium, long)] # Move toward entity (using spatial nav)
/stop                          # Stop moving
```

**Rationale**: Basic navigation is fundamental. Uses spatial navigation system we just built.

**Questions**:

- Should movement feel dangerous? (stamina cost, noise, attracting attention)
-- No, it might attract attention, you can be heard or seen, that's how aggro happens, but not stamina unless running/sprinting

- Auto-run or manual movement commands?
-- Yes, both. Autorun if you want to.

### Communication

```bash
/say <message>             # Local speech (20 feet)
/shout <message>           # Wider range speech (150 feet) on a cooldown careful where you shout, might attract unfriendly things
/tell <player> <message>   # Private message
/emote <action>            # Roleplay action (150 feet visible)
/callforhelp /cfh          # Call for help (250 feet) EVERYTHING that can hear will hear this, you may not get friends only.
```

**Rationale**: Core RP tools. 

**Questions**:

- Should /say cost stamina or attract attention in danger zones?
- Is /shout appropriate for horror atmosphere, or should it be a risky /yell that attracts threats?

shouting should be able to cause aggro, mobs will hear speech and shouting or calling for help

### Perception

```bash
/look [target]                 # Examine surroundings or entity
/listen                        # Actively listen for sounds (uses narrator)
/smell                         # Scent detection (werewolves especially)
/sense                         # Supernatural sense (vampires, psionics)
```

**Rationale**: Investigation is core gameplay. Different Changed types have different perception abilities.

**Questions**:

- Should these be separate commands or unified /perceive with automatic Changed-type detection?
-- I love the idea of /sense just hitting the narrator with who/what is /sensing

- Narrator responses vary based on success/Changed type?
-- Yep, and they don't have to be perfectly accurate. Failed roll, must've just been a trick of the wind, no that arrow is real, the trick was you thinking you didn't hear it.

### System

```bash
/help [category|command]       # Show help
/stats                         # Character stats
/inventory                     # Show inventory
/armoury                       # Equipment management
/character                     # Full character sheet
```

**Rationale**: Basic info players need.

---

## Tier 2: Combat Commands (After Combat System Built)

### Basic Combat

```bash
/attack <target>               # Basic attack
/<ability> [target]            # Use ability from loadout - All abilities are first class slash commands too
/shift                         # Shift to Changed form (werewolf, etc.) costly, time, vuln while shifting
/unshift                       # Return to human form
/flee                          # Attempt to escape combat
```

**Rationale**: Combat is dangerous and strategic. Shifting is a core Changed mechanic.

**Questions**:

- Should there be a /defend or /dodge, or is that automatic based on stats? Crit, penetrating, glancing, evasion, parry, block are all automatic.
- Is /flee always available or only in certain conditions? Only while in non-combat areas for always on. In combat areas it has a cooldown, if used during combat the duration is significantly reduced and the cooldown is longer.
- Should shifting be instant or require time/focus? Bodies don't change in the blink of an eye. Hope you have a safe space or good friends. Or can just take a beating while you shift.

### Tactical

```bash
/target <entity>               # Set current target
/focus <entity>                # Set focus (for awareness without targeting)
```
**Questions**:

- Are stances too MMO-like for narrative gameplay? 
-- For me, yeah. Though I do think they can be super handy if they're actually abilities. Like I use a great sword and I happen to have learned Power Stance, which is an active ability that, while active, provides a 10% attack boost, but reduces evasion rate by 25%.

- Should targeting be explicit or automatic (nearest threat)?
-- Yes, if you don't have a target set and you use an ability that needs one, it'll target the nearest viable. This can just be subtargeted too. Subtargeting must be a thing. 
---

## Tier 3: Social/Investigation (Core Gameplay)

### Investigation

```bash
/examine <entity>              # Detailed examination (narrator response)
/search [area]                 # Search for hidden things - this needs to have some kind of 'physical' bounds or people will spam it everywhere 
/track <entity>                # Follow trail (werewolves especially) - Love it, hunting, bounty hunting, yeah
/analyze <entity>              # Tech analysis (cyber-enhanced) - Love this too, can we do cyberdecking?
/read <entity>                 # Read minds (psionics) - This could be tons of fun with npc shops, lower the price, these aren't the droids ... sorry wrong franchise.
```

**Rationale**: Investigation is core. Different Changed types excel at different methods.

**Questions**:

- Should these be Changed-type specific or available to all with different success rates?
- Narrator always responds, or only on success?
Narrator always responds, available to all. Narrator responses are affected by how large of a success or failure you have. Changed folks, there's still humans around too, may get bonuses or penalties to some checks for sure.

### Social

```bash
/talk <npc> <"subject">        # Initiate conversation (opens dialogue)
/intimidate <entity>           # Threaten (werewolves, physical presence)
/charm <entity>                # Influence (vampires especially)
/deceive <entity>              # Lie convincingly
/persuade <entity>             # Convince with logic
```
If the follow-up commands are only used after /talk <npc> they don't need a target

**Rationale**: Social manipulation is core to vampire/supernatural gameplay.

**Questions**:

- Subject is whatever you're trying to get out of the LLM
- Should these be dice-rolled skill checks? Yeah they should be
- Narrator provides response based on success/failure? Mhmm
- Too rigid, or should /talk handle all with LLM interpreting intent? Mixed mode, still dice rolls, those rolls level of success or failure becomes part of the context for this /talk

---

## Tier 4: World Interaction

### Items

```bash
/use <item> [target]           # Use item
/equip <slot> <item>           # Equip gear - slots matter
/drop <item> [count]           # Drop item
/give <player> <item>          # Give item to player
/get <item>                    # Pick up item from ground /get sounds less aggressive, I think, than /take
```

**Rationale**: Basic inventory management.

**Questions**:

- Should there be /craft for making items? We'll have crafting benches
- /salvage for post-apocalyptic scavenging? Benches too

### Environment

```bash
/open <object>                 # Open door/container
/close <object>                # Close door/container
/lock <object>                 # Lock (if have key/ability)
/unlock <object>               # Unlock
/climb <object>                # Climb obstacle
/search <object>               # Like /search but object specific
/hide                          # Attempt to hide (stealth)
```

**Rationale**: Environmental interaction for exploration.

**Questions**:

- Should /hide be a toggle state or time-limited?
- Too many verbs, or necessary for rich interaction?
Many of these verbs are just needed. Most MOOs and MUDs have WAY more. IRL has WAY more. In the 3D/VR clients most of these would just appear as a button to tap/hold to interact anyway. It's just LLMs and MUDders that will feel the number of verbs, and they won't care.
---

## Commands We Should NOT Have

### ❌ Generic Fantasy Commands

```bash
/cast                          # Too D&D, every spell/ability is a first class script
/meditate                      # Not atmospheric for horror survival
/rest                          # Maybe /sleep in safe zones instead?
```

### ❌ Overly Gamey Commands

```bash
/macro                         # Maybe later, but not initially
/bind                          # Client-side concern
/fps, /ping                    # System info, not game commands
```

### ❌ Breaking Immersion

```bash
/teleport                      # No fast travel (maybe factions have portals later?) I like this as a solution, and mounts ofc
/respawn                       # Death should be meaningful and painful but that doesn't mean we can't respawn, it can mean when we respawn like this we have a corpse run ahead of us.
/gm, /admin                    # Separate admin interface
```

---

## Special Changed-Type Commands

### Werewolves

```bash
/shift [form]                  # Shift between human/wolf forms
/scent <entity>                # Track by scent
/howl                          # Pack communication (danger: attracts attention)
/rage                          # Enter frenzy state
```

### Vampires

```bash
/feed <target>                 # Drink blood
/mesmerize <entity>            # Hypnotic gaze
/shadowstep <location>         # Short-range teleport through shadows
/nightsense                    # Supernatural dark vision
```

### Psionics

```bash
/mindread <entity>             # Read surface thoughts
/project <message> <target>    # Telepathy
/telekinesis <object>          # Move objects with mind
/shield                        # Psychic barrier
```

### Cyber-Enhanced

```bash
/scan <entity>                 # Cybernetic analysis
/hack <object>                 # Interface with tech
/overclock                     # Boost cybernetics (stamina cost)
/interface                     # Direct tech connection
```

### Dragons

```bash
/breathe <fire|ice|acid>       # Breath weapon
/fly                           # Flight (limited in cramped zones)
/hoard                         # Special inventory (dragons hoard)
/intimidate                    # Natural dragon presence
```

### Mages

```bash
/ritual <spell>                # Cast ritual magic (takes time)
/weave <element>               # Elemental manipulation
/ward <area>                   # Create magical barrier
/scry <location>               # Remote viewing
```

---

## Questions for Discussion

1. **Command Scope**: Should Tier 1 be even smaller? Just movement + communication + perception? I'm not thinking of our commands as Tiered, they're all first class scripts, there is no heirarchy. If you want to catagorize, do like you did in some places: Social, combat, world, etc.

2. **Changed-Type Specificity**: Should Changed abilities be:
   - Separate commands (/howl, /mesmerize, etc.)
   - Unified command with type detection (/ability <name>)
   - Mix of both?
   - All first class scripts

3. **Narrator Integration**: Should commands that involve investigation/perception always:
   - Return narrator text? Yes, though it may not be useful or relevant
   - Return mechanical data? Only if relevant
   - Both, with narrator enriching the mechanical data? If relevant and successes on rolls.

4. **Danger/Stamina**: Should most actions cost stamina/resources to emphasize survival horror? Nah, we're cozy survival horror lol Stamina on sprint, jump, feat, ability based on defined costs

5. **Social Commands**: Are /intimidate, /charm, /deceive too rigid, or necessary for clear player intent? They're more rigid than I'd typically go for, but, since they're first class scripts and we can add more freely, it's fine

6. **Automatic vs Manual**: Should some things be automatic (like /search when entering a room) or always manual? There's 2 levels of perception, passive and active. Passive perception may find secrets and things, and the narrator will pop in when it does pass a roll. Active has to be manual, and the narrator will speak up pass or fail.

7. **Emote vs Action**: Should /emote be purely cosmetic, or can it trigger game effects (like /hide being an emote that has mechanical stealth)? I think /hide as a command that triggers an emote is awesome.

---

## Proposed Implementation Order

**Phase 1**: Core Foundation (This Session?)

- `/move`, `/stop`, `/look`
- `/say`, `/whisper`, `/emote`
- `/help`, `/stats`, `/inventory`

**Phase 2**: Perception & Investigation

- `/listen`, `/smell`, `/sense`, `/examine`
- Narrator integration

**Phase 3**: Combat (After Combat System)

- `/attack`, `/use`, `/flee`
- `/shift` (Changed forms)

**Phase 4**: Changed-Type Abilities

- Type-specific commands or unified `/ability` system
- Decide based on gameplay testing

**Phase 5**: Social & World Interaction

- Investigation commands
- Social manipulation
- Environment interaction

---

## Your Input Needed

Please review and provide:

1. **Approval/rejection** of each command category
2. **Priority order** for implementation
3. **Answers to questions** scattered throughout
4. **Missing commands** that align with game vision
5. **Commands to remove** that don't fit

Once approved, I'll implement only the agreed-upon commands.
