# Agents.md for keeping our agentic makers in the loop

Always read this file in full and those files in .agents/ and docs/ as needed, skimming at least.

## Things to keep in mind as we always work future forward

With what we have already built, we're in good shape:

Already scale-ready:

Gateway pattern - Client entry point is separated from game logic. Gateways can be load-balanced behind a reverse proxy later.
Zone servers - Separate processes that communicate via Redis pub/sub. Add more zones = add more servers.
Redis messaging - Pub/sub for inter-server communication works the same whether it's 1 machine or 50.
Prisma ORM - Connection pooling built-in, easy to point at a different DB when you migrate.
Stateless auth flow - Replit Auth uses standard OIDC, swappable for any auth provider.

## Things to keep an eye on as we build

No hardcoded localhost/ports - Use environment variables for all service endpoints
Zone servers should be location-agnostic - They don't care where other zones live, just talk through Redis
Database queries should be zone-scoped - Makes sharding by region trivial later
Session/player state in Redis, not in-memory - So any gateway can handle any player

The architecture doc shows we've already thought this through. The distributed design is there - it's just running on one machine right now. When we scale, we deploy the same code to more machines and update the connection strings.

Keep this in mind as we work. No shortcuts that would bite us later.

## Ask About Services/Servers

**The user can spin up services quickly and enjoys doing so.**

When you need a database, Redis, message queue, or any other service:

- **ASK** instead of assuming or suggesting workarounds
- The user likely has it available or can set it up in minutes
- Examples: PostgreSQL, Redis, RabbitMQ, Elasticsearch, etc.
- They prefer real services over mocks for development

Don't suggest SQLite when PostgreSQL is better. Don't suggest in-memory caching when Redis is an option. Just ask for credentials.

## Port Configuration

- Server runs on PORT=3100 (not 3000)
- WebSocket runs on WS_PORT=3101 (not 3001)
- Multiple Node instances running, avoid standard ports

## Development Server

- **Server is usually already running** via `npm run dev` (tsx watch mode)
- TSX auto-restarts on file changes
- Don't try to start it in background - it's already watching
- Check if it's running before attempting to start it
- To restart: user will handle it manually or tsx will auto-restart on save
