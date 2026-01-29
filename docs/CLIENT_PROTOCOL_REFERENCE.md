# Client Protocol Reference

**Last Updated**: January 28, 2026  
**Status**: Canonical - This document reflects the actual server implementation

## Purpose

This document answers common questions about the server protocol and clarifies discrepancies between older documentation and current implementation.

---

## Chat vs Communication

### Question: Do you want to standardize on `chat` or `communication`?

**Answer: `chat` is the canonical event name.**

- **Inbound** (Client → Server): `socket.emit('chat', { channel, message })`
- **Outbound** (Server → Client): `socket.on('chat', (data) => { ... })`

**Payload Schema (Inbound)**:

```typescript
{
  channel: 'say' | 'shout' | 'emote' | 'cfh',
  message: string
}
```

**Payload Schema (Outbound)**:

```typescript
{
  channel: 'say' | 'shout' | 'emote' | 'cfh',
  sender: string,      // Character name
  senderId: string,    // Character ID
  message: string,     // Formatted message
  timestamp: number    // Unix milliseconds
}
```

**Note**: Any references to `communication` event in documentation are outdated.

---

## Proximity Roster: Full vs Delta

### Question: Should distributed server ever emit full `proximity_roster`, or is delta-only the official contract?

**Answer: Delta-only (`proximity_roster_delta`) is the official contract for distributed servers.**

**Implementation**:

- When a player enters a zone, they start with an **empty roster**
- Server sends `proximity_roster_delta` events with:
  - `added`: New entities that entered range
  - `removed`: Entity IDs that left range
  - `updated`: Entities with changed bearing/range/elevation

**Client Responsibility**:
Clients MUST maintain their own roster by applying deltas:

```javascript
const proximityRoster = new Map();

socket.on('proximity_roster_delta', (data) => {
  // Add new entities
  data.payload.added.forEach(entity => {
    proximityRoster.set(entity.id, entity);
  });

  // Remove entities
  data.payload.removed.forEach(id => {
    proximityRoster.delete(id);
  });

  // Update existing entities
  data.payload.updated.forEach(entity => {
    proximityRoster.set(entity.id, entity);
  });
});
```

**Why Delta-Only?**

- More efficient for real-time spatial updates
- Reduces bandwidth (only send changes)
- Scales better with many entities

---

## Proximity Refresh Request

### Question: Is `proximity_refresh` the official client request? Should `get_nearby`/`get_proximity` be removed from docs?

**Answer: `proximity_refresh` is the official event name.**

**Usage**:

```javascript
// Request a full roster recalculation
socket.emit('proximity_refresh');
```

**Response**:
The server will send a `proximity_roster_delta` with the current state (may have `added` entries representing the full current roster).

**Documentation Status**:

- ✅ `proximity_refresh` - Correct, use this
- ❌ `get_nearby` - Outdated, remove from docs
- ❌ `get_proximity` - Outdated, remove from docs

---

## Command System: Chat vs Commands

### Question: For normal typed input, should clients send `chat` for non-slash and `command` for slash, or always send `command` (auto-wrap `/say`)?

**Answer: Use `chat` for non-slash messages, commands are auto-detected.**

**Recommended Approach**:

```javascript
function handleUserInput(text) {
  if (text.startsWith('/')) {
    // Slash command - can use either method:
    
    // Method 1: Let chat handler auto-route (preferred for simplicity)
    socket.emit('chat', {
      channel: 'say',  // Default channel (server will ignore this)
      message: text
    });
    
    // Method 2: Direct command routing (preferred for explicit control)
    socket.emit('command', { command: text });
    
  } else {
    // Regular chat message
    socket.emit('chat', {
      channel: 'say',  // or 'shout', 'emote', 'cfh'
      message: text
    });
  }
}
```

**Server Behavior**:

- `chat` event with message starting with `/` → automatically routed to command system
- `command` event → directly processed by command system

**Both work, but `method 2` (direct command event) is clearer and skips an extra routing step.**

---

## Movement: Commands vs Events

### Question: Should clients send `/move` + `/stop` commands or keep using `move` payloads? Which is preferred long-term?

**Answer: `move` events are the preferred long-term protocol.**

**Current Support**:

| Method | Supported | Status | Use Case |
|--------|-----------|--------|----------|
| `socket.emit('move', payload)` | ✅ Yes | **Preferred** | Real-time movement, joystick, WASD |
| `/move` command | ✅ Yes | Legacy | Text-based movement |
| `/stop` command | ✅ Yes | Legacy | Text-based stop |

**Recommended Implementation**:

```javascript
// Preferred: Direct move events
function movePlayer(direction, speed = 'walk') {
  socket.emit('move', {
    direction,  // 'north', 'south', 'east', 'west', or compass degrees
    speed       // 'walk', 'run', 'sprint'
  });
}

function stopPlayer() {
  socket.emit('move', {
    direction: 'stop'
  });
}
```

**Why `move` events?**

- Lower latency (no command parsing)
- Designed for real-time input (joysticks, WASD)
- More efficient for high-frequency updates

**When to use commands?**

- Text-only clients without continuous input
- Scripting/macros
- Accessibility (e.g., voice commands → text → slash command)

---

## Command Response Format

### Question: Any changes to `command_response` payload? Can clients rely on `{ success, command, message?, error?, data?, timestamp }`?

**Answer: Yes, the `command_response` format is stable and reliable.**

**Official Schema** (from `src/commands/types.ts`):

```typescript
interface CommandResponseMessage {
  type: 'command_response';
  payload: {
    success: boolean;     // Command succeeded or failed
    command: string;      // Echo of original command
    message?: string;     // Success message (when success=true)
    error?: string;       // Error description (when success=false)
    data?: any;           // Optional command-specific data
    timestamp: number;    // Unix milliseconds
  };
}
```

**Example Usage**:

```javascript
socket.on('command_response', (data) => {
  if (data.success) {
    console.log(`✓ ${data.command}: ${data.message || 'OK'}`);
    
    // Some commands return extra data
    if (data.data) {
      console.log('Additional data:', data.data);
    }
  } else {
    console.error(`✗ ${data.command}: ${data.error}`);
  }
});
```

**Guarantees**:

- `success` and `command` fields are always present
- `message` OR `error` will be present (never both)
- `data` is optional and command-specific
- `timestamp` is always a Unix timestamp in milliseconds

**This format is part of the stable protocol and will not change without a major version bump.**

---

## Quick Reference Card

### Event Summary

| Event | Direction | Purpose | Payload |
|-------|-----------|---------|---------|
| `chat` | Client → Server | Send chat message | `{ channel, message }` |
| `chat` | Server → Client | Receive chat message | `{ channel, sender, senderId, message, timestamp }` |
| `command` | Client → Server | Execute slash command | `{ command }` or `string` |
| `command_response` | Server → Client | Command result | `{ success, command, message?, error?, data?, timestamp }` |
| `move` | Client → Server | Move character | `{ direction, speed? }` |
| `proximity_refresh` | Client → Server | Request roster update | `{}` (no payload) |
| `proximity_roster_delta` | Server → Client | Spatial updates | `{ added, removed, updated }` |

### Migration Checklist

If you're updating from old documentation:

- [ ] Change `communication` to `chat` (both inbound and outbound)
- [ ] Change `get_nearby` / `get_proximity` to `proximity_refresh`
- [ ] Expect only `proximity_roster_delta`, never full roster
- [ ] Build local roster by applying deltas from empty initial state
- [ ] Use `move` events for real-time movement (not commands)
- [ ] Use `command` event for slash commands (or let `chat` auto-route)
- [ ] Handle `command_response` with full schema

---

## Support & Questions

If you find any discrepancies between this document and the server behavior:

1. **Trust the code**: This document is generated from actual implementation
2. **File an issue**: Note the specific event/payload that doesn't match
3. **Check the date**: Protocol may have evolved since older docs were written

**This document is the source of truth for client developers as of January 2026.**
