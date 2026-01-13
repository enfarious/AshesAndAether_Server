# Slash Command System Design

## Philosophy

**One Interface, All Clients**: All game actions are slash commands. GUIs are just pretty wrappers that emit slash commands. LLMs parse natural language into slash commands. This creates a universal, extensible, discoverable interface.

## Core Principles

1. **Universal Protocol**: Same commands work in text, GUI, VR, Discord, LLM
2. **Extensible**: Add new abilities/items/actions without protocol changes
3. **Discoverable**: `/help`, tab completion, command hints
4. **Parseable**: Easy for both humans and machines
5. **Macro-Friendly**: GUIs just emit slash commands
6. **Type-Safe**: Server validates parameters before execution

## Command Structure

### Basic Syntax

```
/command [arg1] [arg2] [key:value] [key:value]
```

### Examples

```bash
# Movement
/move north
/move heading:45 speed:run
/move to:Merchant

# Combat
/attack ant.worker.1
/cast fireball target:ant.queen
/use potion:health

# Social
/say Hello everyone!
/whisper player:Shadowblade message:Got the quest item
/emote looks around cautiously

# Abilities
/ability barbarian-rage
/ability stealth-strike target:guard.1
/ability healing-touch target:self

# Items
/equip sword:vorpal
/use lockpick target:door.1
/trade with:Merchant

# System
/help combat
/macro add "quick-heal" "/use potion:health"
/settings proximity.update:delta
```

## Parameter Types

### Positional Arguments
```bash
/attack ant.worker.1
/say Hello world
```

### Named Parameters (key:value)
```bash
/move heading:45 speed:run
/cast fireball target:ant.queen power:max
```

### Target Shorthand
```bash
# Explicit
/attack target:ant.worker.1

# Shorthand (first positional arg)
/attack ant.worker.1

# Both work
```

### Multiple Words (Quoted)
```bash
/say "Hello everyone, how are you?"
/whisper player:Shadowblade message:"Meet at the tavern"
```

## Command Categories

### Movement Commands

```bash
/move <direction>              # Cardinal direction
/move heading:<degrees>        # Absolute heading
/move to:<entity>              # Move toward entity
/move compass:<N|NE|E|SE|S|SW|W|NW>  # 8-way compass
/move speed:<walk|jog|run>     # Set speed
/stop                          # Stop moving
/follow <entity>               # Follow entity
```

### Combat Commands

```bash
/attack <target>               # Basic attack
/cast <ability> [target:<entity>] [power:<number>]  # Aliases: /ability, /magic
/target <entity>               # Set current target
/assist <player>               # Target their target
/focus <entity>                # Set focus (off-target)
/defocus                       # Clear focus
```

### Social Commands

```bash
/say <message>                 # Say (20 feet)
/shout <message>               # Shout (150 feet)
/emote <action>                # Emote (150 feet)
/whisper <player> <message>    # Private message
/tell <player> <message>       # Alias for whisper
/reply <message>               # Reply to last whisper
/cfh <message>                 # Call for help (danger only)
```

### Inventory Commands

```bash
/inventory                     # Show inventory
/equip <item>                  # Equip item
/unequip <slot>                # Unequip slot
/use <item>                    # Use consumable (alias: /item)
/drop <item> [count:<n>]       # Drop item
/give <player> <item> [count:<n>]
/trade <player>                # Open trade window
```

### Character Commands

```bash
/stats                         # Show character stats
/abilities                     # Show abilities
/loadout                       # Show ability loadout
/loadout set active:<slot> ability:<id>
/loadout set passive:<slot> ability:<id>
/feats                         # Show unlocked feats
/character                     # Character sheet
```

### World Commands

```bash
/look                          # Examine surroundings
/examine <entity>              # Examine entity
/proximity                     # Show proximity roster
/map                           # Show local map
/who                           # List nearby players
/time                          # Show in-game time
/companion <next|prev>         # Cycle companion control (alias: /comp)
```

### System Commands

```bash
/help [category]               # Show help
/macro add <name> <command>    # Create macro
/macro remove <name>           # Delete macro
/macro list                    # List macros
/settings                      # Show settings
/settings <key>:<value>        # Change setting
/ping                          # Check latency
/logout                        # Disconnect
```

## Command Parser Design

### Input Processing

```typescript
interface ParsedCommand {
  command: string;              // "attack"
  positionalArgs: string[];     // ["ant.worker.1"]
  namedArgs: Record<string, string>;  // { power: "max" }
  rawInput: string;             // Original input
}

function parseCommand(input: string): ParsedCommand {
  // 1. Extract command (first word after /)
  // 2. Parse quoted strings
  // 3. Separate positional vs named args
  // 4. Return parsed structure
}
```

### Example Parser

```typescript
parseCommand('/attack ant.worker.1 power:max')
// Returns:
{
  command: 'attack',
  positionalArgs: ['ant.worker.1'],
  namedArgs: { power: 'max' },
  rawInput: '/attack ant.worker.1 power:max'
}

parseCommand('/say "Hello everyone!"')
// Returns:
{
  command: 'say',
  positionalArgs: ['Hello everyone!'],
  namedArgs: {},
  rawInput: '/say "Hello everyone!"'
}

parseCommand('/move heading:45 speed:run')
// Returns:
{
  command: 'move',
  positionalArgs: [],
  namedArgs: { heading: '45', speed: 'run' },
  rawInput: '/move heading:45 speed:run'
}
```

## Command Registry

### Command Definition

```typescript
interface CommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
  category: string;

  parameters: {
    positional?: ParameterDef[];
    named?: Record<string, ParameterDef>;
  };

  permissions?: string[];  // Required permissions
  cooldown?: number;       // Milliseconds

  handler: CommandHandler;
}

interface ParameterDef {
  type: 'string' | 'number' | 'entity' | 'boolean';
  required?: boolean;
  default?: any;
  description?: string;
  validation?: (value: any) => boolean;
}

type CommandHandler = (
  context: CommandContext,
  args: ParsedCommand
) => Promise<CommandResult>;

interface CommandContext {
  characterId: string;
  zoneId: string;
  position: Vector3;
  // ... other context
}

interface CommandResult {
  success: boolean;
  message?: string;
  data?: any;
}
```

### Example Command Registration

```typescript
commandRegistry.register({
  name: 'attack',
  aliases: ['atk'],
  description: 'Attack a target',
  category: 'combat',

  parameters: {
    positional: [
      {
        type: 'entity',
        required: true,
        description: 'Target to attack'
      }
    ],
    named: {
      power: {
        type: 'number',
        required: false,
        default: 100,
        description: 'Power percentage (0-100)'
      }
    }
  },

  cooldown: 1000,  // 1 second GCD

  handler: async (context, args) => {
    const targetId = args.positionalArgs[0];
    const power = args.namedArgs.power || 100;

    // Execute attack
    const result = await combatSystem.attack(context.characterId, targetId, power);

    return {
      success: result.hit,
      message: result.hit
        ? `You hit ${result.targetName} for ${result.damage} damage!`
        : `You missed ${result.targetName}!`,
      data: result
    };
  }
});
```

## Command Execution Flow

```
1. Client sends: "/attack ant.worker.1 power:max"

2. Server receives raw command string

3. Parser extracts:
   - command: "attack"
   - positional: ["ant.worker.1"]
   - named: { power: "max" }

4. Command registry lookup:
   - Find "attack" command definition
   - Validate permissions
   - Check cooldown

5. Parameter validation:
   - Resolve "ant.worker.1" to entity ID
   - Validate "max" → convert to 100
   - Check required params present

6. Execute handler:
   - Pass context + validated args
   - Handler performs game logic
   - Returns result

7. Send response to client:
   - Success/failure message
   - Game state updates
   - Combat events
```

## GUI Integration

### Button Example

```typescript
// GUI button click
attackButton.onClick = () => {
  const target = getCurrentTarget();
  if (!target) {
    showError("No target selected");
    return;
  }

  // Emit slash command
  socket.emit('command', `/attack ${target.id}`);
};
```

### Macro System

```typescript
// Player creates macro
/macro add "burn" "/cast fireball target:{target} power:max"

// Clicking macro button sends:
socket.emit('command', `/cast fireball target:ant.queen power:max`);

// Template variables:
// {target} - current target
// {self} - player
// {focus} - focus target
```

## LLM Integration

### Natural Language → Slash Command

```typescript
// LLM receives: "Attack the giant ant with my strongest spell"

// LLM generates:
{
  intent: "combat_cast",
  command: "/cast fireball target:ant.queen power:max",
  reasoning: "User wants to attack ant.queen with maximum power fireball"
}

// Server receives slash command as normal
```

### LLM Narrator

```typescript
// After combat action executes, LLM narrator enriches output:

// Raw result:
"You hit ant.queen for 45 damage!"

// LLM narrator:
"Your fireball erupts in a brilliant explosion, engulfing the queen ant in
flames. She shrieks in pain as the fire scorches her carapace for 45 damage,
leaving blackened scars across her thorax."
```

## Auto-Completion

### Command Completion

```typescript
interface CompletionSuggestion {
  value: string;
  description: string;
  category?: string;
}

// Input: "/at"
// Suggestions:
[
  { value: "/attack", description: "Attack a target", category: "combat" },
  { value: "/atk", description: "Alias for attack", category: "combat" }
]

// Input: "/attack "
// Suggestions:
[
  { value: "ant.worker.1", description: "Giant Ant Worker (15 feet away)", category: "targets" },
  { value: "ant.worker.2", description: "Giant Ant Worker (23 feet away)", category: "targets" }
]
```

## Help System

### Category Help

```bash
/help
# Shows categories: movement, combat, social, inventory, character, world, system

/help combat
# Shows all combat commands with descriptions

/help attack
# Shows detailed help for /attack command:
#   Usage: /attack <target> [power:<0-100>]
#   Description: Attack a target entity
#   Examples:
#     /attack ant.worker.1
#     /attack target:ant.queen power:max
#   Cooldown: 1 second
```

## Error Handling

### Validation Errors

```typescript
// Unknown command
"/atack ant.worker.1"
→ Error: Unknown command 'atack'. Did you mean '/attack'?

// Missing required parameter
"/attack"
→ Error: Missing required parameter: target

// Invalid parameter type
"/attack speed:fast"
→ Error: Invalid target 'speed:fast'. Expected entity ID or name.

// Out of range
"/attack player.faraway"
→ Error: Target 'player.faraway' is out of attack range (85 feet away, max 5 feet)

// Cooldown
"/attack ant.worker.1"
(immediately followed by)
"/attack ant.worker.1"
→ Error: Ability on cooldown (0.5 seconds remaining)
```

## Protocol Message

### Command Message

```typescript
interface CommandMessage {
  type: 'command';
  payload: {
    command: string;  // Raw command string
    timestamp: number;
  };
}

// Client sends:
socket.emit('command', {
  type: 'command',
  payload: {
    command: '/attack ant.worker.1 power:max',
    timestamp: Date.now()
  }
});

// Or simplified:
socket.emit('command', '/attack ant.worker.1 power:max');
```

### Command Response

```typescript
interface CommandResponseMessage {
  type: 'command_response';
  payload: {
    success: boolean;
    command: string;  // Echo original command
    message?: string;
    data?: any;
    timestamp: number;
  };
}

// Server sends:
{
  type: 'command_response',
  payload: {
    success: true,
    command: '/attack ant.worker.1',
    message: 'You hit Giant Ant Worker for 45 damage!',
    data: {
      damage: 45,
      targetHp: 55,
      targetMaxHp: 100
    },
    timestamp: Date.now()
  }
}
```

## Implementation Plan

### Phase 1: Core Infrastructure

1. **Parser**: Parse slash commands into structured format
2. **Registry**: Command registration and lookup
3. **Validator**: Parameter validation and type conversion
4. **Executor**: Command execution flow

### Phase 2: Basic Commands

1. Movement: `/move`, `/stop`
2. Social: `/say`, `/shout`, `/emote`
3. System: `/help`, `/ping`

### Phase 3: Combat Commands

1. `/attack`
2. `/cast`
3. `/target`
4. `/focus`

### Phase 4: Advanced Features

1. Macro system
2. Auto-completion
3. Command history
4. Aliases

### Phase 5: Integration

1. Update existing handlers to use commands
2. Add GUI→command conversion
3. Add LLM→command conversion
4. Comprehensive help system

## Benefits

### For Players
- **Consistent**: Same commands everywhere
- **Discoverable**: `/help` shows everything
- **Powerful**: Macros and scripting
- **Flexible**: Natural language or precise commands

### For Developers
- **Extensible**: Add abilities without protocol changes
- **Testable**: Commands are pure functions
- **Debuggable**: All actions are logged commands
- **Versionable**: Command definitions in database

### For Clients
- **Simple**: Send strings, get responses
- **Universal**: Works for text, GUI, VR, Discord
- **Efficient**: No complex protocol negotiations
- **Future-proof**: New commands work automatically

---

**Key Insight**: Slash commands are the universal language of the game. Everything else is just a translation layer.
