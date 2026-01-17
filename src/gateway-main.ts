import { GatewayServer } from './gateway/GatewayServer';
import { logger } from './utils/logger';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const config = {
  port: parseInt(process.env.PORT || process.env.GATEWAY_PORT || '5000'),
  serverId: process.env.SERVER_ID || 'gateway-1',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
};

logger.info({ config }, 'Starting Gateway Server');

const server = new GatewayServer(config);

// Handle shutdown gracefully
async function shutdown() {
  logger.info('Received shutdown signal');
  await server.shutdown();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start server
server.start().catch((error) => {
  logger.error({ error }, 'Fatal error starting Gateway Server');
  process.exit(1);
});
