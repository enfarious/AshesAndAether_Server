# Command Validation & Execution Flow

**Understanding how commands work from parse → validation → execution, and where Airlock commands fit in.**

---

## Current Flow (Player Commands)

```
Client (Socket.io)
    ↓
/slash command string
    ↓
Gateway (GatewayClientSession.ts)
    ↓
handleCommand()
    ↓
DistributedWorldManager.executeCharacterCommand()
    ↓
CommandContext created:
  - characterId
  - characterName
  - accountId
  - zoneId
  - position, heading
  - socketId (where to send response)
    ↓
CommandExecutor.execute(rawCommand, context)
    ↓
CommandParser.parse() → ParsedCommand
    ├─ command name
    ├─ positional args
    └─ named args
    ↓
CommandParser.validate()
    ├─ syntax check
    └─ return error if malformed
    ↓
CommandRegistry.get(commandName)
    ├─ lookup definition
    └─ return null if unknown
    ↓
checkPermissions() [currently a stub, all pass]
    ↓
checkCooldown()
    ├─ Redis key: cooldown:{characterId}:{commandName}
    ├─ compare expiresAt vs Date.now()
    └─ return remaining time if active
    ↓
validateParameters()
    ├─ check required positional args
    └─ check required named args
    ↓
definition.handler(context, parsed)
    ├─ Run command-specific logic
    ├─ May modify zone state
    └─ Return CommandResult with events
    ↓
processCommandResult()
    ├─ Convert events to broadcasts
    ├─ Emit to proximity (say/shout)
    ├─ Emit to account (private messages)
    └─ Update zone state
    ↓
sendCommandResponse(socketId, command, response)
    ├─ Send back to client who issued command
    └─ success, message, error, data
```

---

## Validation Checkpoints (In Order)

| Checkpoint | What It Does | Location | Fails? |
|------------|------------|----------|--------|
| **Parse** | Parse `/slash command args` into structured form | CommandParser.parse() | Returns error |
| **Syntax** | Check if command string is valid | CommandParser.validate() | Returns error |
| **Exists** | Command name registered? | CommandRegistry.get() | Returns "Unknown command" |
| **Permission** | Character has permission? | checkPermissions() | Returns "Permission denied" (stub, always true) |
| **Cooldown** | Command off cooldown? | getCooldownRemaining() | Returns "Command on cooldown (Xs)" |
| **RequiresTarget** | If definition needs target, do we have one? | definition.requiresTarget | Returns "This command requires a target" |
| **Parameters** | All required args provided? | validateParameters() | Returns "Missing required parameter: X" |
| **Handler** | Command-specific validation (range, target alive, etc) | definition.handler() | Returns error from handler |
| **Broadcast** | Emit events to proximity | processCommandResult() | (Failure here doesn't affect execution) |

**Key:** Stops at first failure. Does NOT continue if any checkpoint fails.

---

## Airlock Integration Points

### Current State
Airlock connects to Gateway via **Socket.io**, just like player clients. When Airlock-controlled NPCs issue commands, they're treated **identically to player commands**.

**Key:** Companions are fully "players" in the system. The only difference is:
- Players: Commands driven by human via Socket.io
- Companions: Commands driven by LLM (Airlock) via Socket.io

Both execute through the same pipeline, same validation, same handlers. The system knows they're Companions (entity type flag), but that doesn't affect command execution.

**Flow:**
1. Airlock (Socket.io client) calls `/command args` on behalf of a Companion
2. Gateway receives command, looks up Companion entity (same as character lookup)
3. CommandContext created with Companion data (name, position, etc.)
4. CommandExecutor validates and executes (identical to player commands)
5. Events broadcast to proximity (identical to player commands)
6. Result sent back via Socket.io (identical to player commands)

---

## Validation Differences: None

Companions execute commands identically to characters. No special cases, no different validation gates.

| Aspect | Player | Companion (Airlock) |
| --- | --- | --- |
| **Source** | Socket.io (human) | Socket.io (LLM service) |
| **Entity Lookup** | Character table | Companion table |
| **Validation** | Same 8 checkpoints | Same 8 checkpoints |
| **Handlers** | /say, /attack, /give, etc. | /say, /attack, /give, etc. |
| **Response** | Via Socket.io | Via Socket.io |
| **Broadcast** | To proximity roster | To proximity roster |

---

## Current Validation Checklist

✅ Parse command syntax  
✅ Lookup command definition  
✅ Check permissions (stub, always passes for both)  
✅ Check cooldown (Redis-based, per entity)  
✅ Check if target required  
✅ Validate parameter counts  
✅ Handler runs command-specific logic  
✅ Events are broadcast  

---

## What CommandRegistry Provides

```typescript
// Each command has a definition
interface CommandDefinition {
  name: string;                    // "say", "attack", "give", etc.
  description?: string;
  
  // Validation
  permissions?: string[];          // ["player", "npc", "admin"]
  cooldown?: number;               // ms between uses
  requiresTarget?: boolean;        // Must have /target or arg
  
  // Parameters
  parameters?: {
    positional?: Array<{           // /say <message> <optional>
      description?: string;
      required?: boolean;          // default: true
    }>;
    named?: Record<string, {       // /give quest:id target:name
      required?: boolean;
      type?: string;
    }>;
  };
  
  // The actual handler
  handler: (context: CommandContext, parsed: ParsedCommand) => Promise<CommandResult>;
}
```

---

## Handler Signature

```typescript
async handler(context: CommandContext, parsed: ParsedCommand): Promise<CommandResult>

interface CommandResult {
  success: boolean;
  message?: string;           // Success message for player
  error?: string;             // Error message if success=false
  data?: any;                 // Extra data (e.g., damage dealt, xp gained)
  events?: CommandEvent[];    // What happened (broadcast to proximity)
}

interface CommandEvent {
  type: 'speech' | 'emote' | 'combat_hit' | 'quest_offered' | etc.;
  data: any;                  // Event-specific payload
}
```

---

## Example: /say Command Handler

```typescript
// Location: src/commands/handlers/say.ts

export const sayCommand = {
  name: 'say',
  description: 'Speak to nearby entities',
  cooldown: 500,  // 500ms between messages
  
  handler: async (context: CommandContext, parsed: ParsedCommand) => {
    const message = parsed.positionalArgs.join(' ');
    
    if (!message || message.trim().length === 0) {
      return {
        success: false,
        error: 'Please provide a message to say.'
      };
    }
    
    // Handler doesn't need to check cooldown—executor already did
    // Handler doesn't need to check permissions—executor already did
    
    // Just generate the event
    return {
      success: true,
      message: `You say: "${message}"`,
      events: [
        {
          type: 'speech',
          data: {
            channel: 'say',
            sourceId: context.characterId,
            sourceName: context.characterName,
            message,
            position: context.position,
            range: 20,  // Say is ~20 feet
          }
        }
      ]
    };
  }
};
```

---

## Implementation Plan (Day 2)

### Step 1: Verify Companion Lookup Works

Check that `executeCharacterCommand()` in [DistributedWorldManager.ts](src/world/DistributedWorldManager.ts) can handle Companion IDs:

```typescript
private async executeCharacterCommand(
  characterId: string,    // Could be Companion ID (Airlock controls it)
  command: string,
  zoneId: string
) {
  const entity = zoneManager.getEntity(characterId);
  
  // This should work for both Character and Companion entities
  // since both are stored in the zone's entity map
  
  if (!entity) {
    logger.warn('Entity not found', { characterId });
    return;
  }
  
  // Get entity data from database (Character or Companion)
  const data = await this.getEntityData(characterId);
  
  // Create CommandContext and execute
  // Should work identically for both
}
```

**Action:** Check if `getEntityData()` or equivalent already handles both Character and Companion, or if it needs updating.

### Step 2: Confirm Entity Type Tracking

Verify that zone entities have a `type` field or way to distinguish:

```typescript
interface ZoneEntity {
  id: string;
  type: 'character' | 'companion' | 'creature';  // Are we tracking this?
  name: string;
  position: Vector3;
  socketId?: string;
  // ...
}
```

If yes, great—no changes needed. If no, may need to add it.

### Step 3: Test Command Execution

Once verified:

1. Create test Companion in database
2. Have Airlock inhabit it
3. Airlock sends `/say Hello` via Socket.io
4. Check logs: command executed, `/say` event broadcast
5. Verify proximity roster includes the message from Companion

### Step 4: Add Logging to Track Entity Type

When logging command execution, include whether it's a player or Companion:

```typescript
const isCompanion = entity.type === 'companion';
logger.info(`${isCompanion ? 'NPC' : 'Player'} command executed: ${command}`, {
  characterId,
  entityType: entity.type,
  success: result.success
});
```

---

## Summary

**Implementation:** Near-zero. Companions already execute commands like players.

**Verification checklist:**
- [ ] `executeCharacterCommand()` works with Companion IDs
- [ ] Entity lookup finds Companions correctly
- [ ] CommandContext created correctly for Companions
- [ ] Airlock can inhabit and issue commands via Socket.io
- [ ] Commands broadcast to proximity

**Files to check:**
- [src/world/DistributedWorldManager.ts](src/world/DistributedWorldManager.ts) — `executeCharacterCommand()` method
- Zone entity handling — how Companions are stored/retrieved
- Logging — ensure we can distinguish player vs Companion commands for debugging

Once verified, Airlock dev can start testing the full flow: inhabit → command → broadcast → proximity roster update.

---

## Notes for Airlock Dev

You're fully operational once:

1. **Inhabit an NPC:** `inhabit_request` with Companion ID
2. **Receive response:** `inhabit_granted` with NPC data + initial memory
3. **Issue commands:** `/say Hello` via Socket.io (same as players)
4. **Listen to events:** Subscribe to proximity updates and quest events
5. **Update memory:** Process `interaction_recorded` events via Redis

No special Airlock protocol needed. You're just a Socket.io client with a Companion entity instead of a Character entity.

---

## Command Applicability by Entity Type

Only human players and LLM-inhabited companions can issue slash commands. Wildlife/mobs, flora, and fauna do not traverse the command pipeline; they use AI/system-driven behaviors instead.

Taxonomy alignment (server-side enforcement):

- Player: Full command pipeline; validated via session and `Character` state.
- Companion: Full command pipeline when inhabited (Airlock); otherwise limited to scripted interactions.
- Mob: No slash commands; appears in proximity as `mob`; valid combat targets only.
- Wildlife: No slash commands; external sim drives behavior; appears as `wildlife`.
- Flora/Fauna: No slash commands; non-combat or environmental only.

Note: Proximity rosters label mob-tagged companions (`tag` prefixed with `mob.`) as `mob`, ensuring they aren’t treated as companions for chat/commands while remaining targetable in combat and visible in spatial navigation data.
