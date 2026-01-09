import express, { Express } from 'express';
import cors from 'cors';
import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { logger } from '@/utils/logger';
import { ConnectionManager } from './ConnectionManager';
import { WorldManager } from '@/world/WorldManager';

interface GameServerConfig {
  port: number;
  wsPort: number;
  tickRate: number;
}

export class GameServer {
  private app: Express;
  private httpServer: HTTPServer | null = null;
  private io: SocketIOServer | null = null;
  private connectionManager: ConnectionManager | null = null;
  private worldManager: WorldManager | null = null;

  private tickRate: number;
  private tickInterval: NodeJS.Timeout | null = null;
  private lastTickTime: number = 0;

  constructor(private config: GameServerConfig) {
    this.app = express();
    this.tickRate = config.tickRate;

    this.setupExpress();
  }

  private setupExpress(): void {
    // Middleware
    this.app.use(cors());
    this.app.use(express.json());

    // Health check endpoint
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        timestamp: Date.now(),
        uptime: process.uptime(),
      });
    });

    // API routes placeholder
    this.app.get('/api/info', (_req, res) => {
      res.json({
        name: 'World of Darkness MMO',
        version: '0.1.0',
        players: this.connectionManager?.getPlayerCount() || 0,
      });
    });
  }

  async start(): Promise<void> {
    // Start HTTP server
    this.httpServer = this.app.listen(this.config.port, () => {
      logger.info(`HTTP server listening on port ${this.config.port}`);
    });

    // Start WebSocket server
    this.io = new SocketIOServer(this.httpServer, {
      cors: {
        origin: '*', // Configure properly in production
        methods: ['GET', 'POST'],
      },
      path: '/socket.io/',
    });

    logger.info(`WebSocket server initialized`);

    // Initialize managers
    this.connectionManager = new ConnectionManager(this.io);
    this.worldManager = new WorldManager();

    await this.worldManager.initialize();

    // Start game loop
    this.startGameLoop();

    logger.info('Game server fully initialized');
  }

  private startGameLoop(): void {
    const tickIntervalMs = 1000 / this.tickRate;
    this.lastTickTime = Date.now();

    this.tickInterval = setInterval(() => {
      const now = Date.now();
      const deltaTime = (now - this.lastTickTime) / 1000; // Convert to seconds
      this.lastTickTime = now;

      this.tick(deltaTime);
    }, tickIntervalMs);

    logger.info(`Game loop started at ${this.tickRate} ticks per second`);
  }

  private tick(deltaTime: number): void {
    // Update world simulation
    if (this.worldManager) {
      this.worldManager.update(deltaTime);
    }

    // TODO: Update other systems
    // - Combat system
    // - AI/Wildlife
    // - Movement
    // - Status effects
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down game server...');

    // Stop game loop
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    // Disconnect all clients
    if (this.connectionManager) {
      await this.connectionManager.disconnectAll();
    }

    // Close WebSocket server
    if (this.io) {
      await new Promise<void>((resolve) => {
        this.io?.close(() => {
          logger.info('WebSocket server closed');
          resolve();
        });
      });
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => {
          logger.info('HTTP server closed');
          resolve();
        });
      });
    }

    logger.info('Game server shutdown complete');
  }
}
