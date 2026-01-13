# NPC AI System

**Status:** Foundation complete, ready for LLM integration

## Overview

NPCs (Companions) in the Ashes & Aether server are driven by LLM-powered personalities with proximity-aware social behavior. Each NPC has:

- **Personality**: Configured via `personalityType` and `systemPrompt` in database
- **Memory**: Conversation history and relationship data
- **Perception**: Proximity roster awareness (who's nearby, in what channels)
- **Actions**: Can chat (say/shout), emote, or remain silent based on social context

## Architecture

```
Zone Server
  ├── ZoneManager
  │     ├── Tracks all entities (players + NPCs)
  │     ├── Calculates proximity rosters
  │     └── Manages NPC AI Controllers
  │
  ├── NPCAIController (per NPC)
  │     ├── Monitors proximity/perception
  │     ├── Tracks recent chat messages
  │     ├── Decides when to act (cooldowns, triggers)
  │     └── Requests LLM responses
  │
  └── LLMService (singleton)
        ├── Calls Anthropic Claude API
        ├── Builds context-aware prompts
        ├── Parses NPC actions from responses
        └── Enforces airlock safety rules
```

## Components

### NPCAIController

**Location:** [src/ai/NPCAIController.ts](src/ai/NPCAIController.ts)

Manages individual NPC behavior:
- Updates periodically based on perception changes
- Cooldown system (5s between actions)
- Responds to nearby players and messages
- Future: Pathfinding, goal-directed behavior

### LLMService

**Location:** [src/ai/LLMService.ts](src/ai/LLMService.ts)

Generates NPC responses using Claude:
- **System Prompt**: Personality + social mode + response format
- **User Prompt**: Recent messages + proximity context
- **Response Parsing**: Structured actions (SAY/SHOUT/EMOTE/NONE)
- **Social Modes**: Silent, personal, small group, crowd

## Social Context Modes

Based on proximity roster, NPCs adapt behavior:

| Mode | Nearby Count | NPC Behavior |
|------|-------------|--------------|
| **Silent** | 0 | Uses emotes only (no one to talk to) |
| **Personal** | 1 | Uses names, intimate conversation |
| **Small Group** | 2-3 | Casual conversation, can use names |
| **Crowd** | 4+ | Avoids names, general statements |

## Airlock Integration

The airlock safety layer prevents NPCs from:
- Speaking when no one is in range
- Using names in crowd mode (unless sampled)
- Calling for help (CFH) when not in danger
- Violating proximity rules

**Future:** Full integration with LLM Airlock from `.claude/clients/llm-airlock/`

## Database Schema

```prisma
model Companion {
  id              String   @id @default(uuid())
  name            String
  description     String?

  // AI Configuration
  personalityType String   // e.g., "friendly merchant", "grumpy guard"
  systemPrompt    String?  // Custom personality override
  llmProvider     String   @default("anthropic")
  llmModel        String   @default("claude-3-5-sonnet-20241022")

  // Memory
  memoryData             Json  // Relationships, facts, goals
  conversationHistory    Json  @default("[]")

  // Position
  zoneId      String
  positionX   Float
  positionY   Float
  positionZ   Float

  // Stats (health, level, etc.)
  // ...
}
```

## Alive State and Mob Respawn

- All entities (players, NPCs, mobs) carry an `isAlive` flag.
- Proximity rosters exclude entities with `isAlive=false`.
- Mobs are identified by tag prefix `mob.` and respawn 120 seconds after death.

## Example Flow

```typescript
// 1. Player enters zone, proximity roster updates
ProximityRoster: { say: { count: 1, sample: ["Adventurer"] } }

// 2. Player says hello
Player: "Hey merchant, what are you selling?"

// 3. NPC AI Controller detects message in range
NPCAIController.update(proximityRoster, [
  { sender: "Adventurer", channel: "say", message: "Hey merchant, what are you selling?" }
])

// 4. LLM Service generates response
SystemPrompt: "You are Old Merchant, a weathered merchant with kind eyes.
               You are in a personal conversation with Adventurer.
               Personality: friendly merchant"

UserPrompt: "Recent conversation:
             Adventurer [say]: Hey merchant, what are you selling?
             How do you respond?"

LLM Response: "SAY: Ah, greetings friend! I have rare artifacts from the old world.
               Interested in nanotech essence or perhaps a reality anchor?"

// 5. Action parsed and broadcast
Action: { action: "chat", channel: "say", message: "..." }

// 6. Zone server broadcasts to nearby players
Gateway → Client: [SAY] Old Merchant: Ah, greetings friend! I have rare artifacts...
```

## Configuration

### Environment Variables

```env
# LLM Provider - Choose one:
# - lmstudio: Local LLM (free, runs on your machine)
# - anthropic: Claude API (paid, high quality)
# - openai: GPT API (paid, high quality)
LLM_PROVIDER=lmstudio

# LMStudio (local, no API key needed)
LMSTUDIO_URL=http://127.0.0.1:1234
LMSTUDIO_MODEL=local-model

# Anthropic Claude (requires API key)
ANTHROPIC_API_KEY=your-api-key-here

# OpenAI GPT (requires API key)
OPENAI_API_KEY=your-api-key-here

# NPC AI Settings (future)
NPC_AI_ENABLED=true
NPC_ACTION_COOLDOWN=5000  # ms between NPC actions
NPC_RESPONSE_CHANCE=0.7   # Probability to respond to greetings
```

### LLM Provider Setup

**LMStudio (Recommended for Development):**
1. Download LMStudio: https://lmstudio.ai/
2. Load a model (e.g., Llama 3, Mistral, Phi-3)
3. Start local server (default: `http://127.0.0.1:1234`)
4. Set `LLM_PROVIDER=lmstudio` in .env
5. No API key needed - runs entirely on your machine!

**Anthropic Claude:**
1. Get API key from https://console.anthropic.com/
2. Set `LLM_PROVIDER=anthropic` in .env
3. Set `ANTHROPIC_API_KEY=your-key` in .env
4. High quality responses, costs money

**OpenAI GPT:**
1. Get API key from https://platform.openai.com/
2. Set `LLM_PROVIDER=openai` in .env
3. Set `OPENAI_API_KEY=your-key` in .env
4. High quality responses, costs money

### Per-NPC Configuration

Set in database via `Companion` table:
- `personalityType`: "friendly merchant", "hostile guard", "mysterious wanderer"
- `systemPrompt`: Custom personality instructions
- `llmModel`: Which Claude model to use
- `memoryData`: JSON with relationships, facts, goals

## Testing

```bash
# Start distributed servers
./start-distributed.ps1

# Connect with MUD client or test client
node test-client.js

# Chat near an NPC
> say Hey Old Merchant!

# NPC should respond (if API key configured)
[SAY] Old Merchant: Greetings, traveler! What brings you to the Crossroads?
```

## Next Steps

1. **✅ Foundation Complete**
   - NPCAIController class created
   - LLMService with Claude integration
   - Social mode detection
   - Response parsing

2. **⏳ Integration Needed**
   - Add NPC controllers to ZoneManager
   - Hook chat messages to NPC perception
   - Broadcast NPC responses via message bus
   - Add conversation history tracking

3. **🔮 Future Enhancements**
   - Import full airlock from LLM Airlock repo
   - Advanced memory system (vector DB for relationships)
   - Goal-directed behavior (merchants sell, guards patrol)
   - Emotional states (angry, friendly, scared)
   - Movement AI (pathfinding to points of interest)
   - LLM-powered narrator for atmospheric descriptions

## Files

- [src/ai/NPCAIController.ts](src/ai/NPCAIController.ts) - Per-NPC behavior controller
- [src/ai/LLMService.ts](src/ai/LLMService.ts) - LLM response generation
- [src/ai/index.ts](src/ai/index.ts) - Module exports
- [prisma/schema.prisma](prisma/schema.prisma) - Companion model
- [.claude/clients/llm-airlock/](../.claude/clients/llm-airlock/) - Full airlock reference

## Philosophy

**NPCs should feel alive, not scripted.**

- No canned responses - every interaction is LLM-generated
- Context-aware - NPCs notice who's nearby and what's happening
- Memory-driven - NPCs remember past interactions
- Safety-first - Airlock prevents immersion-breaking behavior
- Emergent storytelling - NPC personalities create unique moments

---

*"In this Ashes & Aether, even the NPCs have stories to tell."*
