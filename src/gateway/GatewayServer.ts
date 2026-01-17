import express, { Express } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { logger } from '@/utils/logger';
import { db } from '@/database';
import { MessageBus, MessageType, ZoneRegistry, type ClientMessagePayload, type MessageEnvelope } from '@/messaging';
import { GatewayConnectionManager } from './GatewayConnectionManager';
import { setupAuth, registerAuthRoutes } from '@/auth';

interface GatewayConfig {
  port: number;
  serverId: string;
  redisUrl?: string;
}

/**
 * Gateway Server - handles all client WebSocket connections
 *
 * Routes messages between clients and Zone servers via Redis
 * Does NOT run game logic - purely a message router
 */
export class GatewayServer {
  private app: Express;
  private httpServer: HTTPServer | null = null;
  private io: SocketIOServer | null = null;
  private messageBus: MessageBus;
  private zoneRegistry: ZoneRegistry;
  private connectionManager: GatewayConnectionManager | null = null;

  constructor(private config: GatewayConfig) {
    this.app = express();
    this.messageBus = new MessageBus(config.redisUrl);
    this.zoneRegistry = new ZoneRegistry(this.messageBus, config.serverId);

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
        type: 'gateway',
        serverId: this.config.serverId,
        timestamp: Date.now(),
        uptime: process.uptime(),
        connected: this.messageBus.isConnected(),
      });
    });

    // Serve static web content (CSS, JS, images - but not catch-all)
    const publicDir = path.join(process.cwd(), 'public');
    if (fs.existsSync(publicDir)) {
      this.app.use(express.static(publicDir));
    }

    // API routes
    this.app.get('/api/info', async (_req, res) => {
      const zones = await this.zoneRegistry.getAllZoneAssignments();
      const servers = await this.zoneRegistry.getActiveServers();

      res.json({
        name: 'Ashes & Aether MMO - Gateway',
        version: '0.1.0',
        serverId: this.config.serverId,
        players: this.connectionManager?.getPlayerCount() || 0,
        zones: zones.length,
        servers: servers.length,
      });
    });

    this.app.get('/api/zones', async (_req, res) => {
      const zones = await this.zoneRegistry.getAllZoneAssignments();
      res.json({ zones });
    });

    this.app.get('/api/servers', async (_req, res) => {
      const servers = await this.zoneRegistry.getActiveServers();
      const serverStatus = await Promise.all(
        servers.map(async (serverId) => ({
          serverId,
          alive: await this.zoneRegistry.isServerAlive(serverId),
        }))
      );
      res.json({ servers: serverStatus });
    });
  }

  async start(): Promise<void> {
    // Connect to database
    logger.info('Connecting to database...');
    await db.connect();

    // Setup authentication
    logger.info('Setting up Replit Auth...');
    await setupAuth(this.app);
    registerAuthRoutes(this.app);

    // SPA fallback - serve index.html for client-side routing (AFTER auth routes)
    this.app.get('*', (_req, res, next) => {
      const indexPath = path.join(process.cwd(), 'public', 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        next();
      }
    });

    // Connect to Redis
    logger.info('Connecting to Redis...');
    await this.messageBus.connect();

    // Start heartbeat
    this.zoneRegistry.startHeartbeat();

    // Subscribe to Gateway output channel (for messages to clients)
    await this.messageBus.subscribe('gateway:output', (message) => {
      this.handleGatewayMessage(message);
    });

    // Start HTTP server
    this.httpServer = this.app.listen(this.config.port, '0.0.0.0', () => {
      logger.info(`Gateway HTTP server listening on port ${this.config.port}`);
    });

    // Start WebSocket server
    this.io = new SocketIOServer(this.httpServer, {
      cors: {
        origin: '*', // Configure properly in production
        methods: ['GET', 'POST'],
      },
      path: '/socket.io/',
    });

    logger.info('Gateway WebSocket server initialized');

    // Initialize connection manager
    this.connectionManager = new GatewayConnectionManager(
      this.io,
      this.messageBus,
      this.zoneRegistry
    );

    logger.info(`Gateway server fully initialized (ID: ${this.config.serverId})`);
  }

  /**
   * Handle messages from Zone servers destined for clients
   */
  private handleGatewayMessage(message: MessageEnvelope): void {
    if (message.type !== MessageType.CLIENT_MESSAGE) {
      logger.warn({ type: message.type }, 'Unexpected message type on gateway:output');
      return;
    }

    const { socketId, event, data } = message.payload as ClientMessagePayload;

    if (!this.io) {
      logger.warn('Attempted to send client message but Socket.IO not initialized');
      return;
    }

    // Send message to specific client
    this.io.to(socketId).emit(event, data);

    logger.debug({ socketId, event }, 'Sent message to client');
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down gateway server...');

    // Stop heartbeat
    this.zoneRegistry.stopHeartbeat();

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

    // Disconnect from Redis
    await this.messageBus.disconnect();

    // Disconnect from database
    await db.disconnect();

    logger.info('Gateway server shutdown complete');
  }
}
