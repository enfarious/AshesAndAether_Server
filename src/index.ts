import dotenv from 'dotenv';
import { logger } from '@/utils/logger';
import { GameServer } from '@/network/GameServer';

// Load environment variables
dotenv.config();

async function main() {
  logger.info('Starting Ashes & Aether MMO Server...');
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);

  // Create and initialize the game server
  const server = new GameServer({
    port: parseInt(process.env.PORT || '3000'),
    tickRate: parseInt(process.env.TICK_RATE || '10'),
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    await server.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start the server
  try {
    await server.start();
    logger.info('Server started successfully');
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error({ error }, 'Unhandled error in main');
  process.exit(1);
});
