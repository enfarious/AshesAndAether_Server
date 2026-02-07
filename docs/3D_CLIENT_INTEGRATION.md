# 3D Client Integration Guide

**Target Audience:** 3D Client Developers (Unity, Unreal, Godot, etc.)  
**Protocol Version:** 1.0.0  
**Last Updated:** 2026-02-05

## Overview

This guide explains how to integrate a 3D client with the Ashes & Aether MMO server. The server provides all necessary data for smooth character movement, animation, and world state through WebSocket messages.

---

## Connection Flow

### 1. WebSocket Connection
```javascript
// Connect to gateway
const socket = io('http://localhost:3100');
```

### 2. Handshake
```javascript
socket.emit('handshake', {
  protocolVersion: '1.0.0',
  clientType: '3d',  // or 'vr', 'unity', 'unreal', etc.
  clientVersion: '0.1.0',
  capabilities: {
    graphics: true,
    audio: true,
    physics: true,
    animation: true,
  },
});

socket.on('handshake_ack', (data) => {
  // { compatible: true, protocolVersion: '1.0.0', serverTime: 1234567890 }
});
```

### 3. Authentication
```javascript
// Guest (temporary account - no position persistence)
socket.emit('auth', {
  method: 'guest',
  guestName: 'Player123',
});

// Credentials (persistent account - RECOMMENDED for 3D clients)
socket.emit('auth', {
  method: 'credentials',
  email: 'player@example.com',
  password: 'secure-password',
});

socket.on('auth_success', (data) => {
  // { accountId, characters: [...], sessionToken }
});
```

### 4. Character Selection
```javascript
socket.emit('character_select', {
  characterId: 'char-uuid',
});

socket.on('world_entry', (data) => {
  // Full world state - see "World Entry" section below
});
```

---

## Critical Messages for 3D Clients

### World Entry (Initial State)
Received immediately after character selection. Contains everything needed to render the world:

```typescript
{
  type: 'world_entry',
  payload: {
    characterId: string;
    timestamp: number;
    
    character: {
      id: string;
      name: string;
      level: number;
      position: { x: number; y: number; z: number };  // World coordinates (meters)
      heading: number;                                // 0-360 degrees
      rotation: { x: number; y: number; z: number };  // Euler angles
      currentSpeed: 'stop' | 'walk' | 'jog' | 'run';
      currentAction?: AnimationAction;                // See "Animation States" below
      
      // Stats
      health: { current: number; max: number };
      stamina: { current: number; max: number };
      mana: { current: number; max: number };
      
      // ... more character data
    },
    
    zone: {
      id: string;
      name: string;
      description: string;
      weather: 'clear' | 'rain' | 'snow' | 'fog';
      timeOfDay: 'dawn' | 'day' | 'dusk' | 'night';
      lighting: 'bright' | 'normal' | 'dim' | 'dark';
    },
    
    entities: Entity[];  // All nearby NPCs, players, mobs
    exits: Exit[];       // Zone transitions
  }
}
```

### Entity Updates (Position Changes)
Received during movement - use for **smooth interpolation**:

```typescript
{
  type: 'entity_update',
  payload: {
    entityId: string;
    position: { x: number; y: number; z: number };
    heading: number;                    // 0-360 degrees
    speed: 'stop' | 'walk' | 'jog' | 'run';
    
    // NEW: Movement interpolation data
    movementDuration?: number;          // Milliseconds to interpolate
    movementSpeed?: number;             // Meters per second
    currentAction?: AnimationAction;    // Current animation state
    
    timestamp: number;
  }
}
```

**Client-Side Interpolation Example:**
```csharp
// Unity C# example
void OnEntityUpdate(EntityUpdate update) {
    var entity = GetEntity(update.entityId);
    var currentPos = entity.transform.position;
    var targetPos = new Vector3(update.position.x, update.position.y, update.position.z);
    
    // Use movementDuration for smooth interpolation
    float duration = update.movementDuration / 1000f;  // ms to seconds
    StartCoroutine(SmoothMove(entity, currentPos, targetPos, duration));
    
    // Set animation based on currentAction
    entity.animator.SetTrigger(update.currentAction);
}

IEnumerator SmoothMove(Entity entity, Vector3 from, Vector3 to, float duration) {
    float elapsed = 0f;
    while (elapsed < duration) {
        entity.transform.position = Vector3.Lerp(from, to, elapsed / duration);
        elapsed += Time.deltaTime;
        yield return null;
    }
    entity.transform.position = to;
}
```

### Proximity Roster (Nearby Entities)
Received periodically (every few seconds) with delta updates:

```typescript
{
  type: 'proximity_roster',
  payload: {
    added: Entity[];    // New entities that entered range
    updated: Entity[];  // Entities with state changes
    removed: string[];  // Entity IDs that left range
    timestamp: number;
  }
}
```

---

## Animation States

The server sends `currentAction` field with animation state. Map these to your animation controller:

```typescript
type AnimationAction = 
  | 'idle'        // Standing still
  | 'sitting'     // Sitting down
  | 'emoting'     // Playing emote animation
  | 'walking'     // Walking speed
  | 'running'     // Running speed
  | 'jumping'     // Jump animation
  | 'attacking'   // Combat attack
  | 'casting'     // Spell casting
  | 'channeling'  // Channeling ability
  | 'hit'         // Taking damage
  | 'knockback'   // Knocked back
  | 'dying'       // Death animation
  | 'dead'        // Dead state
  | 'talking'     // NPC dialogue
  | 'trading';    // Trading interface
```

**Animation Blending Recommendations:**
- `walking` → `running`: Blend over 0.2s
- `idle` → `walking`: Blend over 0.1s
- `hit` → `idle`: Snap immediately
- `attacking` → `idle`: Wait for animation complete
- `dying` → `dead`: Transition after death animation

---

## Movement System

### Sending Movement Commands
```javascript
// Position-based movement (RECOMMENDED for 3D clients)
socket.emit('move', {
  method: 'position',
  position: { x: 100, y: 265, z: 50 },
  speed: 'walk',  // 'walk' | 'jog' | 'run' | 'stop'
  timestamp: Date.now(),
});

// Heading-based movement (for keyboard WASD)
socket.emit('move', {
  method: 'heading',
  heading: 45,  // 0-360 degrees (0=North, 90=East, 180=South, 270=West)
  speed: 'run',
  timestamp: Date.now(),
});

// Stop movement
socket.emit('move', {
  method: 'heading',
  speed: 'stop',
  timestamp: Date.now(),
});
```

### Movement Speed Reference
- **Walk:** ~1.4 m/s (base human walking speed)
- **Jog:** ~2.8 m/s (2x walk)
- **Run:** ~5.6 m/s (4x walk, sprint)

**Note:** Actual speeds may vary based on character stats (agility, buffs, encumbrance).

### Physics & Collision
- **Gravity:** Automatic - entities snap to terrain elevation
- **Terrain Collision:** Server validates all movement (no flying without abilities)
- **Entity Collision:** Characters can't walk through NPCs/players
- **Water:** Characters can wade but can't walk underwater (freediving requires abilities)

**Client Responsibility:**
- Visual interpolation between position updates
- Predictive movement (send ahead, reconcile with server)
- Collision prediction (can raycast terrain ahead of server response)

---

## Entity Data Structure

```typescript
interface Entity {
  id: string;
  type: 'player' | 'npc' | 'mob';
  name: string;
  tag?: string;  // Mob tag (e.g., 'deer', 'wolf')
  
  // Position & Movement
  position: Vector3;
  heading: number;
  currentSpeed?: 'stop' | 'walk' | 'jog' | 'run';
  currentAction?: AnimationAction;
  movementDuration?: number;  // ms
  movementSpeed?: number;     // m/s
  
  // State
  isAlive: boolean;
  level?: number;
  faction?: string;
  
  // Interaction
  interactive: boolean;
  description?: string;
}
```

---

## Chat & Communication

```javascript
// Send chat
socket.emit('chat', {
  channel: 'say',  // 'say' | 'shout' | 'emote' | 'whisper' | 'party'
  message: 'Hello world!',
  target?: 'recipient-id',  // For whispers
});

// Receive chat
socket.on('chat_message', (data) => {
  // { senderId, senderName, channel, message, timestamp }
  // Display above character's head or in chat window
});
```

**Channel Ranges:**
- **Touch:** 1.5m (physical interaction)
- **Say:** 20m (normal speech)
- **Emote:** 30m (visible actions)
- **Shout:** 100m (yelling)
- **Whisper:** Direct message (any range)
- **Party:** All party members (any range)

---

## Combat System (ATB)

```javascript
// Target entity
socket.emit('target', {
  targetId: 'entity-uuid',
});

// Use combat action
socket.emit('combat_action', {
  actionType: 'basic_attack',  // or ability ID
  targetId: 'entity-uuid',
});

// Receive combat result
socket.on('combat_result', (data) => {
  // { attackerId, targetId, damage, isCrit, timestamp }
  // Play hit animation, show damage numbers
});
```

**Animation Triggers:**
- `currentAction: 'attacking'` - Play attack animation
- `currentAction: 'hit'` - Play hit reaction
- `currentAction: 'dying'` → `'dead'` - Play death sequence

---

## Best Practices

### Performance
- **Interpolate don't extrapolate:** Use `movementDuration` to smoothly move between positions
- **Cull distant entities:** Only render entities in `proximity_roster`
- **LOD Management:** Reduce detail for far entities
- **Entity Pooling:** Reuse game objects for added/removed entities

### Network
- **Predict client movement:** Send move commands immediately, reconcile with server
- **Timestamp everything:** Use server timestamps for sync
- **Handle latency:** Show predicted position, snap to server authoritative state

### Animation
- **Blend states:** Don't snap between animations
- **Root motion:** Use for combat abilities, disable for movement (server controls position)
- **IK:** Apply for feet on terrain, hands on weapons
- **Facial:** Trigger on `currentAction: 'talking'`

### Position Persistence
- **Use credentials auth:** Guest accounts don't persist positions
- **Logout properly:** Disconnect cleanly to trigger position save
- **Spawn handling:** Respect server spawn position (includes collision avoidance)

---

## Troubleshooting

### Character spawns at origin after logout
**Cause:** Using guest authentication  
**Fix:** Use `method: 'credentials'` for persistent accounts

### Movement feels jerky
**Cause:** Not using `movementDuration` for interpolation  
**Fix:** Lerp positions over `movementDuration` milliseconds

### Animations don't sync
**Cause:** Not listening to `currentAction` updates  
**Fix:** Trigger animations based on `currentAction` field

### Character falls through terrain
**Cause:** Using client-side physics only  
**Fix:** Server controls Y position, client renders at server position

### Entities pop in/out suddenly
**Cause:** Not handling `proximity_roster` delta updates  
**Fix:** Add entities from `added`, remove from `removed` array

---

## Example: Complete Integration (Unity)

```csharp
using SocketIOClient;
using UnityEngine;
using System.Collections.Generic;

public class MMOClient : MonoBehaviour {
    private SocketIOUnity socket;
    private Dictionary<string, GameObject> entities = new Dictionary<string, GameObject>();
    
    void Start() {
        socket = new SocketIOUnity("http://localhost:3100");
        socket.On("world_entry", OnWorldEntry);
        socket.On("entity_update", OnEntityUpdate);
        socket.On("proximity_roster", OnProximityRoster);
        socket.Connect();
        
        // After connection, send handshake/auth/character_select...
    }
    
    void OnWorldEntry(SocketIOResponse response) {
        var data = response.GetValue<WorldEntryData>();
        
        // Spawn player
        SpawnPlayer(data.character);
        
        // Spawn nearby entities
        foreach (var entity in data.entities) {
            SpawnEntity(entity);
        }
    }
    
    void OnEntityUpdate(SocketIOResponse response) {
        var update = response.GetValue<EntityUpdate>();
        
        if (entities.TryGetValue(update.entityId, out var entity)) {
            // Smooth interpolation
            StartCoroutine(InterpolatePosition(
                entity,
                update.position,
                update.movementDuration / 1000f
            ));
            
            // Animation
            var animator = entity.GetComponent<Animator>();
            animator.SetTrigger(update.currentAction);
        }
    }
    
    void OnProximityRoster(SocketIOResponse response) {
        var delta = response.GetValue<ProximityDelta>();
        
        // Add new entities
        foreach (var entity in delta.added) {
            SpawnEntity(entity);
        }
        
        // Remove entities that left
        foreach (var id in delta.removed) {
            if (entities.TryGetValue(id, out var entity)) {
                Destroy(entity);
                entities.Remove(id);
            }
        }
    }
    
    // ... helper methods
}
```

---

## Additional Resources

- **Protocol Reference:** [PROTOCOL.md](./PROTOCOL.md)
- **Client Protocol Summary:** [CLIENT_PROTOCOL_REFERENCE.md](./CLIENT_PROTOCOL_REFERENCE.md)
- **Movement System:** [MOVEMENT_SYSTEM.md](./MOVEMENT_SYSTEM.md)
- **Combat System:** [COMBAT_SYSTEM.md](./COMBAT_SYSTEM.md)

---

## Support

For questions or issues:
- Check server logs for error messages
- Verify protocol version compatibility
- Test with `test-client.js` to confirm server behavior
- Review network messages in browser dev tools (for web clients)
