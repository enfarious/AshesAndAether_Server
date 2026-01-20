# Quest System Design

**Status:** Architectural design and database schema ready. Implementation follows Phase 1 (Companion expansion).

---

## Overview

NPCs give quests via Airlock. Quests are **lightweight, LLM-driven sidequests** with:
- Multiple quest givers (different NPCs can offer the same quest)
- Objectives (kill X mobs, collect Y items, reach location Z)
- Rewards (XP, money, items)
- Dialogue tied to stages (offered, accepted, in-progress, completed)

**Example:** Old Merchant offers "Gather Herbs" quest. Player accepts. Airlock tracks progress. When complete, player gets XP + reward from merchant.

---

## Architecture: Where Things Live

### Airlock Responsibilities

```typescript
// Airlock receives: Player approaches NPC
// Airlock→LLM: "Player is here. You know quests X, Y, Z. 
//              They're level 5. What do you offer?"

// LLM returns: "I'll offer them the Herb Gathering quest"
// Airlock: /give quest:herb_gathering

// Later, player completes quest
// Airlock→LLM: "Player completed the herb gathering!
//              They collected 5 herbs. Reward them 100 XP, 50 gold"

// LLM: /take quest:herb_gathering character:player1 
//      json:{ xp: 100, money: 50, items: [] }
```

**Airlock decides:**
- Which quests to offer (based on player level, completed quests, NPC personality)
- Dialogue for each stage ("Here's a task...", "How goes the search?", "Well done, friend!")
- Hints ("Try the forest north of here")
- Quest rewards (final say, though influenced by Quest template)

### Server (Zone) Responsibilities

```typescript
// Receive: /give quest:herb_gathering
// Validate: Does this NPC have this quest?
// Execute: Create QuestProgress record, tell player
// Broadcast: Player now has this quest

// Later: /take quest:herb_gathering character:player1 
//        json:{ xp: 100, money: 50, items: [] }
// Validate: Does player have this quest? Are objectives met?
// Execute: Grant XP, money, items. Mark quest complete. Update character.
// Broadcast: Player completed quest, got rewards
```

**Server maintains:**
- Quest definitions (Quest model)
- Player progress (QuestProgress model)
- Objective completion tracking
- Reward distribution logic
- Quest history per character

### Database Schema

**Companion** (NPC quest giver):
```typescript
questIds: String[]  // This NPC can give these quests
```

**Quest** (quest template):
```typescript
giversNpcIds: String[]  // Which NPCs offer this quest?
objectives: Json        // [{ type: "kill", target: "rat", count: 5 }]
rewards: Json           // { xp: 500, money: 100, items: ["item_id"] }
dialogueStages: Json    // { offered: "...", accepted: "...", etc }
```

**QuestProgress** (player's quest state):
```typescript
characterId: String
questId: String
status: String          // "active" | "completed" | "abandoned"
objectiveProgress: Json // { "kill_rat": 3 } (tracks partial progress)
startedAt: DateTime
completedAt: DateTime?
```

---

## Command Flow: Complete Quest Cycle

### 1. NPC Offers Quest

```
Airlock (inhabited merchant):
  Sees player nearby
  Calls LLM: "What quests can you offer this level-5 player?"
  
LLM responds:
  "I can offer them Herb Gathering, they haven't done it"
  
Airlock sends:
  /give quest:herb_gathering target:player_alice json:{...}

Server:
  Validates: Merchant has this quest? Player meets level req?
  Creates: QuestProgress(characterId, questId, status="active")
  Broadcasts: event { type: "quest_offered", quest: {...} }
  
Player sees:
  ✓ New quest in journal: "Herb Gathering"
  ✓ NPC said something about it
```

### 2. Player Works on Quest

Server tracks progress as player:
- Kills herbs (or whatever the objective is)
- Server emits: `objective_progress: { "collect_herb": 3/5 }`

Airlock provides context:
```
Airlock→LLM: "Player is at [herb_location]. 
             They've collected 3 of 5 herbs needed.
             What do you say?"

LLM: "Hint: Try the oak forest to the north"
Airlock: /say Hint: Try the oak forest to the north
```

### 3. Player Completes Quest

```
Server:
  Detects: Player has 5 herbs (objective complete)
  Broadcasts: objective_progress: { "collect_herb": 5/5, complete: true }
  
Airlock (if NPC is still inhabited):
  Receives: objective completed
  Calls LLM: "Player finished collecting herbs! Reward them?"
  
LLM responds:
  "Great work! Here's 100 XP and 50 gold"
  
Airlock sends:
  /take quest:herb_gathering character:player_alice 
    json:{ xp: 100, money: 50, items: [] }

Server:
  Validates: Player has quest? Objectives complete?
  Grants: XP (add to character.experience)
  Grants: Money (add to inventory or account)
  Grants: Items (create inventory_item records)
  Updates: QuestProgress(status="completed", completedAt=now)
  Broadcasts: event { type: "quest_completed", quest: {...} }
  
Player sees:
  ✓ +100 XP
  ✓ +50 gold
  ✓ Quest marked "Complete"
  ✓ Callback dialogue from NPC
```

---

## Dialogue System

Each quest has dialogue for different stages:

```json
{
  "dialogueStages": {
    "offered": "I've a task for you if you're interested...",
    "accepted": "Excellent! Find me some herbs from the northern forest.",
    "inProgress": "Still searching for those herbs?",
    "completed": "Ah, those herbs are perfect! Here's your reward.",
    "hint_stage_1": "The herbs grow near the old oak trees.",
    "hint_stage_2": "Look for blue flowers among the grass."
  }
}
```

**Airlock uses these to:**
- Provide quest context (NPC can give hints dynamically)
- Maintain conversation flow (dialogue based on stage)
- Make quests feel alive (NPC checks in on you)

**Airlock can override:**
- LLM can generate unique dialogue per personality
- But uses quest's dialogue as base/context

---

## Command Signatures

### `/give` (Issue Quest)

**Who sends:** Airlock (inhabited NPC)

**Syntax:**
```
/give quest:<questId> target:<characterId> json:<rewardsOverride>
```

**Example:**
```
/give quest:herb_gathering target:player_alice json:{"xp": 100, "money": 50}
```

**Server does:**
1. Validate NPC has this quest
2. Validate player meets level requirement
3. Check player not already on quest
4. Create QuestProgress record
5. Broadcast to zone

**Server response:** `npc_action_executed` event with quest details

---

### `/take` (Complete Quest)

**Who sends:** Airlock (inhabited NPC)

**Syntax:**
```
/take quest:<questId> character:<characterId> json:<rewards>
```

**Example:**
```
/take quest:herb_gathering character:player_alice json:{"xp": 100, "money": 50, "items": []}
```

**Server does:**
1. Validate player has this quest
2. Validate objectives completed
3. Grant rewards (XP, money, items)
4. Mark quest complete
5. Broadcast completion event

**Server response:** `npc_action_executed` with updated character stats

---

## Quest Definition Example

```json
{
  "id": "herb_gathering",
  "title": "Gather Herbs",
  "description": "The merchant needs healing herbs for their shop.",
  "questType": "sidequest",
  "requiredLevel": 1,
  "giversNpcIds": ["merchant_old"],
  "objectives": [
    {
      "type": "collect",
      "itemId": "herb_blue_flower",
      "count": 5,
      "description": "Blue flowers from the northern forest"
    }
  ],
  "rewards": {
    "xp": 100,
    "money": 50,
    "items": []
  },
  "dialogueStages": {
    "offered": "I could use some rare herbs from the northern forest. Could you gather five blue flowers for me?",
    "accepted": "Excellent! Look for them among the grass near the old oak trees.",
    "inProgress": "Still searching? They're blue flowers, quite distinctive.",
    "completed": "Ah, those are perfect! Here, take this reward for your service.",
    "hint_stage_1": "The forest is north of here, past the crossroads.",
    "hint_stage_2": "Blue flowers bloom near water sources."
  },
  "prerequisiteQuestIds": [],
  "followupQuestIds": []
}
```

---

## Quest Progress Tracking

**Server tracks per character:**

```json
{
  "characterId": "player_alice",
  "questId": "herb_gathering",
  "status": "active",
  "objectiveProgress": {
    "collect_herb_blue_flower": 3,
    "collect_herb_blue_flower_target": 5
  },
  "startedAt": "2026-01-20T10:30:00Z",
  "completedAt": null
}
```

**As player progresses:**
```
Player picks herb:
  Server: objectiveProgress.collect_herb_blue_flower++
  Server: Broadcast objective_progress event
  Airlock: Sees progress, provides hint if stage reached
  
Player reaches 5/5:
  Server: Broadcast objective_complete event
  Airlock: Offers completion dialogue
```

---

## Airlock Integration Points

### 1. Upon Inhabiting NPC

```typescript
// Airlock receives npc data:
const npc = {
  questIds: ["herb_gathering", "rat_bounty", "repair_fence"]
};

// Airlock→LLM: "You know these quests: X, Y, Z"
// LLM learns: This NPC can offer these quests
```

### 2. Player Approaches

```typescript
// Airlock→LLM: "A player has approached. 
//              They're level 5, completed 2 quests.
//              Which of your quests would you offer them?"

// LLM picks based on:
// - Player level vs quest requirement
// - Prereqs (completed other quests?)
// - NPC personality (greedy merchant = paid bounties, kind priest = charity)
```

### 3. During Conversation

```typescript
// Airlock→LLM: "Player says: 'Any work for me?'"
// LLM: "SAY: I have a task if you're interested..."
// Airlock: /say "I have a task if you're interested..."
// OR
// Airlock: /give quest:herb_gathering target:player
```

### 4. Quest In Progress

```typescript
// Airlock receives: objective_progress event
// Airlock→LLM: "Player has 3/5 herbs so far. Encourage them?"
// LLM: "SAY: How goes the herb gathering?"
// Airlock: /say "How goes the herb gathering?"
```

### 5. Quest Complete

```typescript
// Airlock receives: objective_complete event
// Airlock→LLM: "Player finished the quest! Congratulate and reward?"
// LLM: "SAY: Excellent work! Your reward awaits."
//      /take quest:herb_gathering character:player json:{xp:100, money:50}
// Airlock: Executes both commands
```

---

## Implementation Phases

### Phase 1.5: Quest Database Setup (1-2 days)

- [x] Update Companion schema (questIds)
- [x] Update Quest schema (giversNpcIds, dialogueStages)
- [ ] Run migration
- [ ] Create seed quests
- [ ] Verify schemas

### Phase 1.6: Quest Commands (2-3 days)

- [ ] Implement `/give` command handler
- [ ] Implement `/take` command handler
- [ ] Add `quest_offered`, `quest_completed` events
- [ ] Add objective_progress tracking
- [ ] Test end-to-end (LLM → commands → quests)

### Phase 1.7: Airlock Integration (1-2 days)

- [ ] Airlock learns quest IDs on inhabit
- [ ] Airlock calls LLM with quest context
- [ ] Airlock sends `/give` at right time
- [ ] Airlock sends `/take` with calculated rewards
- [ ] Integration test

### Phase 2: Combat + Quests (overlap)

Combat and quest systems run independently. Quest rewards tie together (XP goes to character, items go to inventory).

---

## Testing Checklist

### Unit Tests

- [ ] Quest prerequisites validation
- [ ] Objective progress tracking
- [ ] Reward calculation
- [ ] Quest completion validation

### Integration Tests

- [ ] NPC offers quest, player accepts
- [ ] Player progresses on quest
- [ ] Player completes, gets rewards
- [ ] Airlock dialogue matches stage
- [ ] Multiple NPCs can offer same quest

### Manual Tests

- [ ] Create test quest in database
- [ ] Inhabit NPC with quest
- [ ] Player receives quest
- [ ] Collect items, complete objective
- [ ] NPC rewards player
- [ ] Check character got XP + items

---

## Notes

**Quests are stateless in Airlock.** If inhabit ends, NPC loses context. On re-inhabit, Airlock starts fresh. Server maintains player progress in database—so quests don't reset.

**Multiple Airlock instances can inhabit different NPCs simultaneously.** Each makes independent decisions about which quests to offer.

**Quest rewards are final at `/take` time.** Airlock proposes amounts, but server is authority. If Airlock says "50 XP" and server's template says "100 XP", server should accept Airlock's proposal (LLM tailored it to this moment).

---

## Next: Implementation

Once Phase 1 (Companion + Command Feedback) is done, add these quest commands to Phase 1.6.

Then Airlock can provide context about quests to LLM, and NPCs become full quest givers.
