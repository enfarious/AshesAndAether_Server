# Agents.md for keeping your agentic maker in the loop

Always read this file in full and those files in /.agents

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
