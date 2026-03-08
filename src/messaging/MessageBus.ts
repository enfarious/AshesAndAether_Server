import { createClient, RedisClientType } from 'redis';
import { logger } from '@/utils/logger';

/**
 * Message types for inter-server communication
 */
export enum MessageType {
  // Player events
  PLAYER_JOIN_ZONE = 'player_join_zone',
  PLAYER_LEAVE_ZONE = 'player_leave_zone',
  PLAYER_MOVE = 'player_move',
  PLAYER_CHAT = 'player_chat',
  PLAYER_ACTION = 'player_action',
  PLAYER_COMMAND = 'player_command',
  PLAYER_PROXIMITY_REFRESH = 'player_proximity_refresh',
  PLAYER_COMBAT_ACTION = 'player_combat_action',
  PLAYER_RESPAWN = 'player_respawn',
  NPC_CHAT = 'npc_chat',
  NPC_INHABIT = 'npc_inhabit',
  NPC_RELEASE = 'npc_release',

  // Zone events
  PROXIMITY_UPDATE = 'proximity_update',
  ZONE_STATE_UPDATE = 'zone_state_update',
  COMPANION_SPAWN = 'companion_spawn',

  // Script editor messages (Gateway -> Zone)
  EDITOR_ACTION = 'editor_action',

  // Companion BYOLLM messages (Client -> Gateway -> Zone)
  COMPANION_SETTINGS_UPDATE = 'companion_settings_update',
  COMPANION_SOCIAL_ACTION = 'companion_social_action',

  // Guild events (cross-zone)
  GUILD_CHAT = 'guild_chat',
  GUILD_INVITE = 'guild_invite',
  GUILD_BEACON_STATE = 'guild_beacon_state',
  LIBRARY_ASSAULT_START = 'library_assault_start',
  LIBRARY_ASSAULT_RESOLVED = 'library_assault_resolved',

  // Client-bound messages (Gateway -> Client)
  CLIENT_MESSAGE = 'client_message',
}

export interface MessageEnvelope {
  type: MessageType;
  zoneId?: string;
  characterId?: string;
  socketId?: string;
  payload: unknown;
  timestamp: number;
}

export interface ClientMessagePayload {
  socketId: string;
  event: string;
  data: unknown;
}

/**
 * Redis-based message bus for distributed server communication
 *
 * Handles pub/sub messaging between Gateway and Zone servers
 */
export class MessageBus {
  private publisher: RedisClientType;
  private subscriber: RedisClientType;
  private connected: boolean = false;
  private messageHandlers: Map<MessageType, Set<(msg: MessageEnvelope) => void>> = new Map();

  constructor(private redisUrl: string = 'redis://localhost:6379') {
    this.publisher = createClient({ url: redisUrl }) as RedisClientType;
    this.subscriber = createClient({ url: redisUrl }) as RedisClientType;

    // Setup error handlers
    this.publisher.on('error', (err) => logger.error({ err }, 'Redis publisher error'));
    this.subscriber.on('error', (err) => logger.error({ err }, 'Redis subscriber error'));
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    await this.publisher.connect();
    await this.subscriber.connect();

    this.connected = true;
    logger.info({ url: this.redisUrl }, 'Message bus connected to Redis');
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (!this.connected) return;

    await this.publisher.quit();
    await this.subscriber.quit();

    this.connected = false;
    logger.info('Message bus disconnected from Redis');
  }

  /**
   * Publish a message to a specific channel
   */
  async publish(channel: string, message: MessageEnvelope): Promise<void> {
    if (!this.connected) {
      logger.warn('Attempted to publish message while disconnected from Redis');
      return;
    }

    const serialized = JSON.stringify(message);
    await this.publisher.publish(channel, serialized);

    logger.debug({ channel, type: message.type }, 'Published message');
  }

  /**
   * Subscribe to a channel
   */
  async subscribe(channel: string, handler: (message: MessageEnvelope) => void): Promise<void> {
    if (!this.connected) {
      logger.warn('Attempted to subscribe while disconnected from Redis');
      return;
    }

    await this.subscriber.subscribe(channel, (serialized) => {
      try {
        const message = JSON.parse(serialized) as MessageEnvelope;
        handler(message);
      } catch (error) {
        logger.error({ error, channel, serialized }, 'Failed to parse message');
      }
    });

    logger.info({ channel }, 'Subscribed to channel');
  }

  /**
   * Unsubscribe from a channel
   */
  async unsubscribe(channel: string): Promise<void> {
    if (!this.connected) return;

    await this.subscriber.unsubscribe(channel);
    logger.info({ channel }, 'Unsubscribed from channel');
  }

  /**
   * Get Redis publisher client (for direct access, e.g., cooldowns)
   */
  getRedisClient(): RedisClientType {
    return this.publisher;
  }

  /**
   * Subscribe to pattern (e.g., "zone:*:input")
   */
  async psubscribe(pattern: string, handler: (channel: string, message: MessageEnvelope) => void): Promise<void> {
    if (!this.connected) {
      logger.warn('Attempted to psubscribe while disconnected from Redis');
      return;
    }

    await this.subscriber.pSubscribe(pattern, (serialized, channel) => {
      try {
        const message = JSON.parse(serialized) as MessageEnvelope;
        handler(channel, message);
      } catch (error) {
        logger.error({ error, channel, serialized }, 'Failed to parse pattern message');
      }
    });

    logger.info({ pattern }, 'Subscribed to pattern');
  }

  /**
   * Register a typed message handler
   */
  on(type: MessageType, handler: (msg: MessageEnvelope) => void): void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set());
    }
    this.messageHandlers.get(type)!.add(handler);
  }

  /**
   * Emit a typed message to registered handlers
   */
  emit(message: MessageEnvelope): void {
    const handlers = this.messageHandlers.get(message.type);
    if (handlers) {
      handlers.forEach(handler => handler(message));
    }
  }

  /**
   * Get Redis client for direct operations (e.g., get/set)
   */
  getClient(): RedisClientType {
    return this.publisher;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }
}
