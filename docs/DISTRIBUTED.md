# Distributed Server Architecture

## Overview

The Ashes & Aether server supports distributed deployment across multiple machines for horizontal scaling. The architecture uses Redis as a message bus to coordinate between Gateway servers (handling client connections) and Zone servers (processing game logic).

## Architecture

```
ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ
Γöé                    CLIENTS                              Γöé
Γöé              (WebSocket connections)                    Γöé
ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓö¼ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ
                     Γöé
         ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓû╝ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ
         Γöé   GATEWAY SERVER      Γöé  ΓåÉ Handles ALL client connections
         Γöé   - Authentication     Γöé     Doesn't run game logic
         Γöé   - Message routing    Γöé     Just routes messages
         Γöé   - Connection mgmt    Γöé
         ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓö¼ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ
                     Γöé
              ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓû╝ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ
              Γöé    REDIS    Γöé  ΓåÉ Message bus + shared state
              Γöé  Pub/Sub    Γöé     - Online players
              ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓö¼ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ     - Zone assignments
                     Γöé            - Character positions
         ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓö╝ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ
         Γöé           Γöé           Γöé
    ΓöîΓöÇΓöÇΓöÇΓöÇΓû╝ΓöÇΓöÇΓöÇΓöÇΓöÉ ΓöîΓöÇΓöÇΓöÇΓû╝ΓöÇΓöÇΓöÇΓöÇΓöÉ ΓöîΓöÇΓöÇΓöÇΓû╝ΓöÇΓöÇΓöÇΓöÇΓöÉ
    Γöé  ZONE   Γöé Γöé  ZONE  Γöé Γöé  ZONE  Γöé  ΓåÉ Run game logic
    Γöé SERVER  Γöé Γöé SERVER Γöé Γöé SERVER Γöé     Calculate proximity
    Γöé    1    Γöé Γöé    2   Γöé Γöé    3   Γöé     Run AI/combat
    ΓööΓöÇΓöÇΓöÇΓöÇΓö¼ΓöÇΓöÇΓöÇΓöÇΓöÿ ΓööΓöÇΓöÇΓöÇΓö¼ΓöÇΓöÇΓöÇΓöÇΓöÿ ΓööΓöÇΓöÇΓöÇΓö¼ΓöÇΓöÇΓöÇΓöÇΓöÿ     Publish updates
         Γöé          Γöé          Γöé
         ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓö╝ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ
                    Γöé
            ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓû╝ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ
            Γöé   POSTGRESQL   Γöé  ΓåÉ Persistent storage
            Γöé   - Characters  Γöé     - Zone definitions
            Γöé   - Accounts    Γöé     - Game state
            ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ
```

## Deployment Modes

### Single-Server Mode (Development)

Run everything on one machine:

```powershell
# Terminal 1: Start Redis
redis-server

# Terminal 2: Start Gateway
npm run dev:gateway

# Terminal 3: Start Zone Server (handles all zones)
npm run dev:zone
```

### Multi-Server Mode (Production)

#### Gateway Server(s)

```powershell
# .env
SERVER_ID="gateway-1"
GATEWAY_PORT=3100
REDIS_URL="redis://your-redis-server:6379"

# Start
npm run start:gateway
```

You can run multiple Gateway servers behind a load balancer for redundancy.

#### Zone Server 1 (North America zones)

```powershell
# .env
SERVER_ID="zone-na-1"
ASSIGNED_ZONES="zone-nyc-manhattan,zone-nyc-brooklyn,zone-chicago"
REDIS_URL="redis://your-redis-server:6379"
TICK_RATE=20

# Start
npm run start:zone
```

#### Zone Server 2 (Europe zones)

```powershell
# .env
SERVER_ID="zone-eu-1"
ASSIGNED_ZONES="zone-london,zone-paris,zone-berlin"
REDIS_URL="redis://your-redis-server:6379"
TICK_RATE=20

# Start
npm run start:zone
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SERVER_ID` | Unique server identifier | `server-1` |
| `GATEWAY_PORT` | Port for Gateway HTTP/WS | `3100` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `TICK_RATE` | Game loop ticks per second | `20` |
| `ASSIGNED_ZONES` | Comma-separated zone IDs | `` (all zones) |

### Zone Assignment

**All zones (single-server):**
```env
ASSIGNED_ZONES=""
```

**Specific zones:**
```env
ASSIGNED_ZONES="USA_NY_Stephentown,zone-forest,zone-city"
```

**Geographic distribution:**
```env
# Server 1 - East Coast
ASSIGNED_ZONES="zone-nyc-manhattan,zone-nyc-brooklyn,zone-boston,zone-philly"

# Server 2 - West Coast
ASSIGNED_ZONES="zone-sf,zone-la,zone-seattle,zone-portland"

# Server 3 - Europe
ASSIGNED_ZONES="zone-london,zone-paris,zone-berlin,zone-rome"
```

## Message Flow

### Player Movement Example

1. Client sends `move` message ΓåÆ Gateway
2. Gateway looks up "which zone server has this player?" (Redis registry)
3. Gateway publishes to `zone:crossroads:input` Redis channel
4. Zone Server 1 (hosting Crossroads) receives message
5. Zone Server updates position, calculates proximity
6. Zone Server publishes to `gateway:output` channel
7. Gateway receives, forwards `proximity_roster` to client WebSocket

### Cross-Zone Communication

When a player in Manhattan shouts and it should be heard in adjacent Brooklyn:

1. Zone Server 1 (Manhattan) processes shout
2. Zone Server 1 publishes to `zone:brooklyn:input` channel
3. Zone Server 2 (Brooklyn) receives and processes
4. Both servers publish results to `gateway:output`
5. Gateway forwards to all affected clients

## API Endpoints

### Gateway Server

- `GET /health` - Health check
- `GET /api/info` - Server info (players, zones, servers)
- `GET /api/zones` - List all zone assignments
- `GET /api/servers` - List all active servers

## Redis Keys

### Zone Registry

- `zone:assignment:{zoneId}` - Which server hosts this zone
- `player:location:{characterId}` - Which zone/server a player is in
- `server:heartbeat:{serverId}` - Server alive indicator (TTL: 15s)

### Redis Channels

- `zone:{zoneId}:input` - Commands for a specific zone
- `gateway:output` - Messages destined for clients
- `zone:{zoneId}:broadcast` - Zone-wide announcements

## Scaling Strategies

### Vertical Scaling (Single Machine)

1. Start with single-server mode
2. Increase TICK_RATE for better performance
3. Add more CPU cores (Node.js can use multiple cores via clustering)

### Horizontal Scaling (Multiple Machines)

1. Run 1 Gateway + 1 Zone Server on same machine initially
2. When zones get crowded, split zones across multiple Zone Servers
3. Add more Gateway servers behind load balancer for connection handling
4. Use Redis Cluster for Redis scaling (beyond 10k concurrent)

### Geographic Distribution

Deploy Zone Servers close to player populations:

- NA East: New York-based zones on East Coast server
- NA West: California-based zones on West Coast server
- EU: European zones on EU server
- All connect to same Redis + PostgreSQL (or use read replicas)

## Monitoring

### Metrics to Track

- **Gateway**: Active connections, messages/sec routed
- **Zone Server**: Zones loaded, players per zone, tick time
- **Redis**: Pub/sub messages/sec, memory usage
- **PostgreSQL**: Query time, connection pool usage

### Health Checks

All servers expose `/health` endpoint:

```json
{
  "status": "ok",
  "type": "gateway",  // or "zone"
  "serverId": "gateway-1",
  "timestamp": 1234567890,
  "uptime": 12345,
  "connected": true
}
```

## Failover

### Zone Server Failure

1. Zone Server stops sending heartbeats (Redis key expires)
2. Gateway detects missing zone assignment
3. Another Zone Server can be configured to take over those zones
4. Players in affected zones reconnect and re-enter world

### Gateway Failure

1. Load balancer detects health check failure
2. Routes new connections to other Gateway servers
3. Existing WebSocket connections lost, clients reconnect
4. Zone Servers unaffected (player state persisted in DB)

## Development Workflow

### Testing Distributed Setup Locally

Use the provided PowerShell scripts:

```powershell
# Start everything (Gateway + Zone + Redis)
./start-distributed.ps1

# Start only Gateway
./start-gateway.ps1

# Start only Zone Server
./start-zone.ps1
```

### Simulating Multiple Zone Servers

Terminal 1 (Gateway):
```powershell
$env:SERVER_ID="gateway-1"
$env:GATEWAY_PORT="3100"
npm run dev:gateway
```

Terminal 2 (Zone Server 1):
```powershell
$env:SERVER_ID="zone-1"
$env:ASSIGNED_ZONES="USA_NY_Stephentown"
npm run dev:zone
```

Terminal 3 (Zone Server 2):
```powershell
$env:SERVER_ID="zone-2"
$env:ASSIGNED_ZONES="zone-forest,zone-city"
npm run dev:zone
```

## Performance

### Expected Capacity

| Component | Limit | Bottleneck |
|-----------|-------|------------|
| Gateway | ~10k connections/server | CPU, Network |
| Zone Server | ~500 players/zone | Game logic CPU |
| Redis | ~100k msgs/sec | Network |
| PostgreSQL | ~10k queries/sec | Disk I/O |

### Recommendations

- **< 100 players**: Single server mode
- **100-1,000 players**: 1 Gateway + 1 Zone Server
- **1,000-10,000 players**: 2 Gateways + 3-5 Zone Servers
- **10,000+ players**: Load balancer + multiple Gateways + many Zone Servers

## Migration Path

1. **Start**: Monolithic (current index.ts)
2. **Step 1**: Single Gateway + Single Zone Server (all zones)
3. **Step 2**: Single Gateway + Multiple Zone Servers (split zones)
4. **Step 3**: Multiple Gateways + Multiple Zone Servers
5. **Step 4**: Redis Cluster + PostgreSQL replicas for ultimate scale
