import { Server as SocketIOServer, Socket } from 'socket.io';
import { logger } from '@/utils/logger';
import { ClientSession } from './ClientSession';

/**
 * Manages all client connections and routes messages
 */
export class ConnectionManager {
  private sessions: Map<string, ClientSession> = new Map();

  constructor(private io: SocketIOServer) {
    this.setupSocketHandlers();
  }

  private setupSocketHandlers(): void {
    this.io.on('connection', (socket: Socket) => {
      logger.info(`New connection: ${socket.id}`);

      // Create session for this connection
      const session = new ClientSession(socket);
      this.sessions.set(socket.id, session);

      // Handle disconnection
      socket.on('disconnect', (reason) => {
        logger.info(`Client disconnected: ${socket.id}, reason: ${reason}`);
        this.sessions.delete(socket.id);
        session.cleanup();
      });

      // Handle authentication
      socket.on('auth', async (data) => {
        try {
          await session.authenticate(data);
        } catch (error) {
          logger.error(`Authentication failed for ${socket.id}:`, error);
          socket.emit('auth_error', { message: 'Authentication failed' });
        }
      });

      // Handle ping/pong for connection health
      socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() });
      });
    });
  }

  getPlayerCount(): number {
    return Array.from(this.sessions.values()).filter(
      (session) => session.isAuthenticated()
    ).length;
  }

  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.sessions.values()).map(
      (session) => session.disconnect()
    );
    await Promise.all(disconnectPromises);
    this.sessions.clear();
  }

  getSession(socketId: string): ClientSession | undefined {
    return this.sessions.get(socketId);
  }
}
