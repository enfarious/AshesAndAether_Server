import { ZoneServer } from './zoneserver/ZoneServer';
import { logger } from './utils/logger';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Parse assigned zones from env (comma-separated)
const assignedZonesStr = process.env.ASSIGNED_ZONES || '';
const assignedZones = assignedZonesStr
  ? assignedZonesStr.split(',').map(z => z.trim()).filter(z => z.length > 0)
  : [];

const config = {
  serverId: process.env.SERVER_ID || 'zoneserver-1',
  tickRate: parseInt(process.env.TICK_RATE || '20'), // 20 TPS
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  assignedZones,
};

logger.info({ config }, 'Starting Zone Server');

const server = new ZoneServer(config);

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
  logger.error({ err: error }, 'Fatal error starting Zone Server');
  process.exit(1);
});
