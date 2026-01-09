# Movement System - Unified 3D Architecture

## Overview

The server uses a **unified 3D movement system** that works seamlessly across all client types (text, 2D, 3D, VR). The key insight: maintain a single source of truth in 3D space, then translate appropriately for each client.

## Core Concept

**Single Source of Truth:**
- Every entity has a **position** (Vector3: x, y, z)
- Every entity has a **heading** (0-360 degrees, where 0 = north)
- Movement is calculated in 3D space
- Clients receive appropriate translations of this data

## The Translation Pipeline

```
3D Position + Heading (Server)
        │
        ├─→ 3D/VR Client: Full 3D data + rotation
        │
        ├─→ 2D Client: Orthographic projection (drop Y or project to ground)
        │
        └─→ Text Client: Compass directions + heading
```

## Why This Works

1. **3D is the most complex** - if you can handle 3D, everything else is simpler
2. **2D is just 3D projected** - drop the Y axis or project to ground plane
3. **Text is compass directions from 3D** - query navmesh for valid headings
4. **Single movement system** - no duplicate logic for different client types
5. **LLM friendly** - simple commands like "Walk.N" or "Run.045"

---

## Position & Heading

### Position (Vector3)

Right-handed coordinate system:
- **X axis**: East (+) / West (-)
- **Y axis**: Up (+) / Down (-)
- **Z axis**: North (+) / South (-)

```typescript
position: {
  x: 100.5,  // 100.5 units east of world origin
  y: 0,      // Ground level
  z: 250.3   // 250.3 units north of world origin
}
```

### Heading (0-360 degrees)

Clockwise from north:
- **0° / 360°** = North
- **90°** = East
- **180°** = South
- **270°** = West

```typescript
heading: 45  // Facing northeast
```

### Full Character State

```typescript
{
  id: "char-123",
  name: "Shadowblade",
  position: { x: 100.5, y: 0, z: 250.3 },
  heading: 45,                    // Facing NE
  rotation: { x: 0, y: 45, z: 0 }, // Full 3D rotation for VR/3D
  currentSpeed: "jog"              // Current movement speed
}
```

---

## Movement Commands

### Three Methods

1. **heading** - Specify speed and heading (universal, all clients)
2. **compass** - Specify speed and compass direction (text clients, auto-converted)
3. **position** - Direct position update (3D/VR clients only)

### Method 1: Heading (Universal)

Send speed and heading in degrees:

```json
{
  "type": "move",
  "payload": {
    "method": "heading",
    "speed": "jog",
    "heading": 45,
    "timestamp": 1234567890
  }
}
```

**Speed options:**
- `walk` - Base speed (1.0x multiplier)
- `jog` - Medium speed (2.0x multiplier)
- `run` - Fast speed (3.5x multiplier)
- `stop` - Stop movement (0x multiplier)

**Heading:**
- 0-360 degrees
- Optional: if omitted, uses current heading
- Allows precise control

### Method 2: Compass (Text Clients)

Send speed and compass direction:

```json
{
  "type": "move",
  "payload": {
    "method": "compass",
    "speed": "walk",
    "compass": "NE",
    "timestamp": 1234567890
  }
}
```

**Compass directions:**
- `N` = 0°
- `NE` = 45°
- `E` = 90°
- `SE` = 135°
- `S` = 180°
- `SW` = 225°
- `W` = 270°
- `NW` = 315°

**Server automatically converts to heading:**
```typescript
compass: "NE" → heading: 45
```

### Method 3: Position (3D/VR Only)

Direct position update for clients with free movement:

```json
{
  "type": "move",
  "payload": {
    "method": "position",
    "position": { "x": 101.5, "y": 0, "z": 251.0 },
    "timestamp": 1234567890
  }
}
```

Server validates against navmesh and updates position if valid.

---

## Text Client Commands

Text clients have the simplest, most LLM-friendly interface.

### Command Format

**Pattern:** `Speed.Direction`

```
Walk.N     # Walk north
Jog.NE     # Jog northeast
Run.SW     # Run southwest
Stop       # Stop moving
```

**Using exact degrees:**
```
Walk.037   # Walk at 37°
Jog.149    # Jog at 149°
Run.256    # Run at 256°
```

**Using current heading (omit direction):**
```
Walk       # Walk forward (current heading)
Jog        # Jog forward
Run        # Sprint forward
Stop       # Stop
```

### Examples

**Player command:** `Walk.N`
**Sent to server:**
```json
{
  "type": "move",
  "payload": {
    "method": "compass",
    "speed": "walk",
    "compass": "N",
    "timestamp": 1234567890
  }
}
```

**Player command:** `Run.045`
**Sent to server:**
```json
{
  "type": "move",
  "payload": {
    "method": "heading",
    "speed": "run",
    "heading": 45,
    "timestamp": 1234567890
  }
}
```

### Text Client Receives Available Directions

Text clients get `availableDirections` based on navmesh:

```json
{
  "availableDirections": ["N", "NE", "E", "W", "NW"],
  "currentHeading": 45,
  "currentSpeed": "walk"
}
```

This tells the client (or LLM):
- Can move: North, Northeast, East, West, Northwest
- Cannot move: Southeast, South, Southwest (blocked by terrain/obstacles)
- Currently facing: 45° (Northeast)
- Currently moving at: Walk speed

---

## LLM Integration

This system is **perfect for LLMs** controlling characters or NPCs.

### System Prompt Example

```
MOVEMENT COMMANDS:
Use the format: Speed.Direction

Speeds:
- Walk: Normal pace
- Jog: Medium pace
- Run: Fast sprint
- Stop: Stop moving

Directions:
- Compass: N, NE, E, SE, S, SW, W, NW
- Exact degrees: 0-360 (0=north, 90=east, 180=south, 270=west)
- Omit direction to continue current heading

Current situation:
- Available directions: [N, E, SE, S, W]
- Current heading: 45° (NE)
- Current speed: Walk

Examples:
- "Walk.N" - Walk north
- "Run.E" - Run east
- "Jog.135" - Jog at 135° (southeast)
- "Walk" - Continue walking current direction (45°)
- "Stop" - Stop moving
```

### LLM Response Processing

LLM outputs: `"I'll head east. Run.E"`

Parser extracts: `Run.E`

Converts to:
```json
{
  "method": "compass",
  "speed": "run",
  "compass": "E"
}
```

Server converts to:
```json
{
  "method": "heading",
  "speed": "run",
  "heading": 90
}
```

Updates entity:
```typescript
entity.heading = 90;
entity.currentSpeed = "run";
entity.velocity = calculateVelocity(90, SPEED_MULTIPLIERS.run);
```

---

## Client-Specific Implementations

### 3D/VR Client

**Receives:**
```json
{
  "character": {
    "position": { "x": 100.5, "y": 0, "z": 250.3 },
    "heading": 45,
    "rotation": { "x": 0, "y": 45, "z": 0 },
    "currentSpeed": "jog"
  }
}
```

**Sends:**
- Method: `position` (direct position updates from physics)
- Method: `heading` (speed + heading from input)

**Rendering:**
- Use full 3D position for camera and character placement
- Use rotation for character model orientation
- Interpolate between updates for smooth movement
- Play animations based on `currentSpeed`

### 2D Client

**Receives:**
```json
{
  "character": {
    "position": { "x": 100.5, "y": 0, "z": 250.3 },
    "heading": 45,
    "currentSpeed": "jog"
  }
}
```

**Sends:**
- Method: `heading` (speed + heading from input)

**Rendering:**
- Drop Y axis: project to 2D plane (x, z)
- Use heading to select sprite direction (8-way sprites)
- Orthographic camera view from above
- Position sprite at (x, z) on screen
- Select sprite based on heading:
  - 0° = "character_north"
  - 45° = "character_northeast"
  - 90° = "character_east"
  - etc.

### Text Client

**Receives:**
```json
{
  "character": {
    "position": { "x": 100.5, "y": 0, "z": 250.3 },
    "heading": 45,
    "currentSpeed": "walk"
  },
  "textMovement": {
    "availableDirections": ["N", "NE", "E", "SE", "S"],
    "currentHeading": 45,
    "currentSpeed": "walk"
  }
}
```

**Sends:**
- Method: `compass` (speed + compass direction)
- Method: `heading` (speed + exact degrees)

**Display:**
```
Location: The Crossroads
You are facing northeast, walking.

Available exits:
  [N] North - Forest Path
  [NE] Northeast
  [E] East - Mountain Pass
  [SE] Southeast
  [S] South - King's Road

Commands: Walk.N, Jog.E, Run.SE, Stop
```

---

## Navmesh Integration

The navmesh determines what's walkable and provides available directions for text clients.

### Checking Available Directions

```typescript
function getAvailableDirections(
  position: Vector3,
  navmesh: NavMesh
): CompassDirection[] {
  const directions: CompassDirection[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const headings = [0, 45, 90, 135, 180, 225, 270, 315];
  const testDistance = 5.0; // Test 5 units ahead

  const available: CompassDirection[] = [];

  for (let i = 0; i < directions.length; i++) {
    const testPos = projectPosition(position, headings[i], testDistance);

    if (navmesh.isWalkable(testPos)) {
      available.push(directions[i]);
    }
  }

  return available;
}

function projectPosition(position: Vector3, heading: number, distance: number): Vector3 {
  const radians = (heading * Math.PI) / 180;

  return {
    x: position.x + Math.sin(radians) * distance,
    y: position.y,
    z: position.z + Math.cos(radians) * distance,
  };
}
```

### Movement Validation

Server validates all movement against navmesh:

```typescript
function validateMovement(
  currentPos: Vector3,
  targetPos: Vector3,
  navmesh: NavMesh
): { valid: boolean; reason?: string } {
  // Check if target position is walkable
  if (!navmesh.isWalkable(targetPos)) {
    return { valid: false, reason: 'Target position is not walkable' };
  }

  // Check if path between current and target is clear
  if (!navmesh.hasLineOfSight(currentPos, targetPos)) {
    return { valid: false, reason: 'Path is blocked' };
  }

  // Check maximum movement distance per tick
  const distance = calculateDistance(currentPos, targetPos);
  const maxDistance = calculateMaxMoveDistance(currentSpeed, tickRate);

  if (distance > maxDistance) {
    return { valid: false, reason: 'Movement too fast (possible cheat)' };
  }

  return { valid: true };
}
```

---

## Server-Side Processing

### Receiving Movement Commands

```typescript
socket.on('move', (data: MoveMessage['payload']) => {
  const entity = getEntity(session.characterId);

  let finalHeading: number;
  let speed: MovementSpeed;

  switch (data.method) {
    case 'heading':
      finalHeading = data.heading ?? entity.heading; // Use current if omitted
      speed = data.speed!;
      break;

    case 'compass':
      finalHeading = COMPASS_TO_HEADING[data.compass!];
      speed = data.speed!;
      break;

    case 'position':
      // Direct position update (validate first)
      if (validateMovement(entity.position, data.position!, navmesh).valid) {
        entity.position = data.position!;
      }
      return;
  }

  // Update entity state
  entity.heading = finalHeading;
  entity.currentSpeed = speed;

  // Calculate velocity
  const speedMultiplier = SPEED_MULTIPLIERS[speed];
  entity.velocity = calculateVelocity(finalHeading, speedMultiplier);
});
```

### Broadcasting Updates

```typescript
function broadcastEntityUpdate(entity: Entity) {
  const nearbyPlayers = getNearbyPlayers(entity.position);

  for (const player of nearbyPlayers) {
    const clientType = player.session.clientType;

    // Customize update based on client type
    const update = formatUpdateForClient(entity, clientType);

    player.session.send('state_update', {
      entities: {
        updated: [update]
      }
    });
  }
}

function formatUpdateForClient(entity: Entity, clientType: ClientType) {
  const base = {
    id: entity.id,
    position: entity.position,
    heading: entity.heading,
    currentSpeed: entity.currentSpeed,
  };

  if (clientType === 'text') {
    // Add text-specific movement info
    return {
      ...base,
      textMovement: {
        availableDirections: getAvailableDirections(entity.position, navmesh),
        currentHeading: entity.heading,
        currentSpeed: entity.currentSpeed,
      }
    };
  }

  if (clientType === '3d' || clientType === 'vr') {
    // Add full 3D rotation
    return {
      ...base,
      rotation: entity.rotation,
      velocity: entity.velocity,
      animation: getAnimationForSpeed(entity.currentSpeed),
    };
  }

  // 2D client - base is sufficient
  return base;
}
```

---

## Benefits Summary

✅ **Single Source of Truth** - 3D position + heading for everything
✅ **Easy Translation** - 3D → 2D → Text all from same data
✅ **Navmesh Integration** - Text gets valid directions from 3D collision data
✅ **LLM Friendly** - Simple, parseable commands ("Walk.N", "Run.045")
✅ **Client Flexibility** - Each client gets appropriate level of detail
✅ **Consistent Movement** - Same physics/validation for all clients
✅ **Future Proof** - Easy to add new client types

---

## Implementation Checklist

**Phase 1: Core System**
- [x] Add `heading` to CharacterState
- [x] Add `currentSpeed` to CharacterState
- [x] Update MoveMessage with three methods
- [x] Add compass/heading conversion constants
- [ ] Implement server-side movement processing
- [ ] Add navmesh query for available directions

**Phase 2: Client Support**
- [ ] Text client: send compass commands
- [ ] Text client: display available directions
- [ ] 2D client: project 3D to 2D
- [ ] 3D/VR client: full 3D movement

**Phase 3: LLM Integration**
- [ ] System prompt templates for movement
- [ ] Command parser for LLM outputs
- [ ] Test with Claude/GPT controlling character

**Phase 4: Optimization**
- [ ] Movement prediction/interpolation
- [ ] Update rate tuning per client type
- [ ] Navmesh caching for common queries

---

## Example Flow: Text Client to LLM

1. **User types:** "go north quickly"

2. **LLM receives context:**
   ```
   Available directions: [N, NE, E, W]
   Current heading: 45° (NE)
   ```

3. **LLM outputs:** "I'll run north. Run.N"

4. **Client parses:** `Run.N`

5. **Client sends:**
   ```json
   {
     "type": "move",
     "payload": {
       "method": "compass",
       "speed": "run",
       "compass": "N",
       "timestamp": 1234567890
     }
   }
   ```

6. **Server converts:** `compass: "N"` → `heading: 0`

7. **Server updates entity:**
   ```typescript
   entity.heading = 0;
   entity.currentSpeed = "run";
   entity.velocity = { x: 0, y: 0, z: 3.5 }; // 3.5 units/sec north
   ```

8. **Server broadcasts:** All nearby clients receive position update

9. **Text client receives:**
   ```
   You sprint north along the forest path...
   Available directions: [N, NE, E, SE, W, NW]
   ```

Perfect! Everything works from a single unified 3D system.
