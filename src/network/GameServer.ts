import express, { Express } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createServer, Server as HTTPServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { logger } from '@/utils/logger';
import { db } from '@/database';
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
  private wsServer: HTTPServer | null = null;
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

    const assetsDir = path.join(process.cwd(), 'data', 'world', 'assets');
    const terrainDir = path.join(process.cwd(), 'data', 'terrain');
    const manifestForZone = (zoneId: string) =>
      path.join(assetsDir, zoneId, 'manifest.json');

    this.app.use('/world/assets', express.static(assetsDir));
    this.app.use('/world/terrain', express.static(terrainDir));

    this.app.get('/world/assets', (_req, res) => {
      const zones = fs.existsSync(assetsDir)
        ? fs
            .readdirSync(assetsDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
        : [];

      res.json({
        version: '0.1.0',
        zones,
      });
    });

    this.app.get('/world/assets/:zoneId', (req, res) => {
      const { zoneId } = req.params;
      const manifestPath = manifestForZone(zoneId);

      if (!fs.existsSync(manifestPath)) {
        res.status(404).json({ error: 'manifest_not_found', zoneId });
        return;
      }

      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const etag = crypto.createHash('sha256').update(raw).digest('hex');
      const ifNoneMatch = req.header('if-none-match');

      res.setHeader('ETag', etag);
      if (ifNoneMatch && ifNoneMatch === etag) {
        res.status(304).end();
        return;
      }

      res.json(JSON.parse(raw));
    });

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
        name: 'Ashes & Aether MMO',
        version: '0.1.0',
        players: this.connectionManager?.getPlayerCount() || 0,
      });
    });
  }

  async start(): Promise<void> {
    // Connect to database
    logger.info('Connecting to database...');
    await db.connect();

    // Start HTTP server
    this.httpServer = createServer(this.app);
    this.httpServer.listen(this.config.port, () => {
      logger.info(`HTTP server listening on port ${this.config.port}`);
    });

    // Start WebSocket server on its own port
    this.wsServer = createServer();
    this.wsServer.listen(this.config.wsPort, () => {
      logger.info(`WebSocket server listening on port ${this.config.wsPort}`);
    });

    this.io = new SocketIOServer(this.wsServer, {
      cors: {
        origin: '*', // Configure properly in production
        methods: ['GET', 'POST'],
      },
      path: '/socket.io/',
    });

    logger.info(`WebSocket server initialized`);

    // Initialize managers
    this.worldManager = new WorldManager();
    this.worldManager.setIO(this.io);
    await this.worldManager.initialize();

    this.connectionManager = new ConnectionManager(this.io, this.worldManager);

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

    if (this.wsServer) {
      await new Promise<void>((resolve) => {
        this.wsServer?.close(() => {
          logger.info('WebSocket HTTP server closed');
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

    // Disconnect from database
    await db.disconnect();

    logger.info('Game server shutdown complete');
  }
}
