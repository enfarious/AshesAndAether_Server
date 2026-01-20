# Documentation Update (Jan 20, 2026)

This document tracks documentation changes made to ensure clarity on architecture and reduce future confusion.

---

## Created Documents

### 1. RESPONSIBILITY_MATRIX.md

**Purpose:** Clarify what lives where in the system.

**Key takeaway:** The server is NOT an interpretation service. It doesn't parse LLM output or generate intents.

**Content:**
- Service breakdown (Gateway, Zone, Airlock, Wildlife Sim, LLM)
- What each service does and does NOT do
- Command flow examples
- Decision flow chart for "where should feature X live?"
- Pattern: Airlock thinks, Server validates+executes

**Solves:** Confusion about where NPC intent parsing happens (Airlock, not server)

---

### 2. AIRLOCK_RESPONSIBILITIES.md

**Purpose:** Define what Airlock client does (separate service, not part of game server).

**Key takeaway:** Airlock is a stateless LLM client that controls NPCs. The server is the game authority.

**Content:**
- Authentication and inhabitancy flow
- LLM reasoning loop (proximity → LLM → parse → send commands)
- What Airlock does NOT do (validate, persist, interpret server state)
- Event flow examples
- Session management
- Testing locally (3-terminal setup)

**Solves:** Prevents implementing LLM parsing in server; clarifies boundaries

---

## Updated Documents

### 1. IMPLEMENTATION_ROADMAP.md (Complete Rewrite)

**Changes:**

- **Phase 1 renamed** from "NPC Context & Intent System" to "Expand Companion Model & Airlock Integration"
- **Removed server-side intent parsing** - that's Airlock's job
- **Added:** Database schema extension (traits, goals, abilityIds)
- **Added:** Command validation for Airlock-sent commands
- **Added:** Feedback events so Airlock knows if commands succeeded/failed
- **Added:** Optional position override in inhabit_request (for testing)
- **Clarified:** Architecture reminder pointing to RESPONSIBILITY_MATRIX.md
- **Timeline simplified:** Phase 1 now 3-4 days (not 4+ with intent parsing)
- **Phase 3 timeline reduced:** 2-3 days instead of 4-5 (OSM data already exists)

**Solves:** Old roadmap had Phase 1 doing server-side intent parsing, which was wrong

---

### 2. IMPLEMENTATION_ACTION_ITEMS.md (Complete Rewrite)

**Changes:**

- **Day-by-day breakdown** for Phase 1 (4 days) through Phase 4 (3 days)
- **Specific files to edit** for each task
- **Clear acceptance criteria** for each day
- **Removed:** References to IntentParser (server-side, doesn't exist)
- **Added:** Command feedback mechanism (new network events)
- **Added:** OSM parsing and zone loading (separate from NPC logic)
- **Added:** Documentation maintenance checklist

**Solves:** No more vague "implement combat" - now specific tasks with expected deliverables

---

### 3. ARCHITECTURE.md (Partial Update)

**Changes:**

- **Added:** Cross-reference to RESPONSIBILITY_MATRIX.md
- **Added:** "Lean core" principle (external services for LLM, wildlife, etc.)
- **Updated:** Runtime Stack section to clarify Airlock and Wildlife are external
- **Updated:** High-Level Topology diagram to show all services
- **Clarified:** Gateway's Airlock handling (inheritancy tracking)

**Solves:** Made architecture intent clear (server is lean, not monolithic)

---

## Key Principles Documented

### 1. Separation of Concerns

```
Airlock (external)        Server (game)              Wildlife Sim (external)
├─ LLM reasoning          ├─ Command validation      ├─ Behavior simulation
├─ Intent parsing         ├─ State authority         ├─ Movement/aging
├─ Session management     ├─ Event broadcasting      └─ Population dynamics
└─ Chat context           └─ Persistence
```

### 2. Command Flow

```
Player / Airlock client
        ↓
    /command (slash command)
        ↓
    Server validates (is it legal?)
        ↓
    Server executes (apply changes)
        ↓
    Server broadcasts (tell everyone)
```

### 3. NPC Control is Stateless

Airlock doesn't persist NPC state. It:
- Receives proximity roster (who's nearby)
- Calls LLM with context
- Gets back intent (do something)
- Sends command to server
- Server is authority - game state lives there

This means:
- Easy to add/remove Airlock instances
- Easy to scale Airlock horizontally
- Server remains single source of truth

---

## Architecture Decisions Documented

### 1. Intent Parsing in Airlock, Not Server

**Why:** Server should validate, not interpret. Allows:
- Airlock to iterate on parsing without server deploys
- Clear separation: Airlock = logic, Server = enforcement
- Server stays lean and fast
- Different LLM setups to have different parsing

### 2. OSM Pipeline Complete, Just Need Loading

**Discovery:** Stephentown data already exists (Python fetched it).

**Implication:**
- Phase 3 is now "load OSM data into zones" not "build OSM pipeline"
- Estimated 2-3 days instead of 4-5
- Focus on zone record creation and NPC placement

### 3. No NPC Auto-Behavior (LLM-Driven Only)

**Why:** NPCs do nothing unless Airlock is inhabiting them.

**Implication:**
- No "resident NPCs" that move on their own
- NPCs are controlled by Airlock or remain static
- Wildlife sim is the exception (separate process)

---

## Future Documentation Tasks

These docs are accurate but newer systems may need docs:

- [ ] Primer: "How to add a new slash command?"
- [ ] Primer: "How to add a new ability?"
- [ ] Primer: "How to create an Airlock client from scratch?"
- [ ] Primer: "How to run wildlife sim locally?"
- [ ] Deployment guide: "How to deploy to production?"
- [ ] Performance guide: "Zone server scaling considerations"

---

## Documentation Principles Going Forward

1. **Single Source of Truth:** Each concept in one doc, linked from others
2. **Specific File References:** All paths point to actual files in repo
3. **Example Code:** Always include actual TypeScript examples
4. **Flow Diagrams:** Use diagrams for complex flows
5. **Acceptance Criteria:** Each task has clear definition of "done"
6. **Update on Code Change:** When implementing, update docs immediately

---

## Summary

**Before:** Documentation was scattered, outdated, and wrong about where things lived.

**After:** Clear separation of concerns, accurate descriptions, actionable steps.

**Result:** Developers know where to implement things and won't waste time on wrong approaches.
