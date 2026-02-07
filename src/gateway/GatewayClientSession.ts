import { Socket } from 'socket.io';
import { logger } from '@/utils/logger';
import { AccountService, CharacterService, CompanionService, ZoneService } from '@/database';
import { SpawnPointService } from '@/world/SpawnPointService';
import { StatCalculator } from '@/game/stats/StatCalculator';
import { PhysicsSystem } from '@/physics/PhysicsSystem';
import { MessageBus, MessageType, ZoneRegistry } from '@/messaging';
import { randomUUID } from 'crypto';
import {
  ClientType,
  ClientCapabilities,
  AuthMessage,
  AuthSuccessMessage,
  AuthErrorMessage,
  AuthConfirmNameMessage,
  AuthNameConfirmedMessage,
  CharacterSelectMessage,
  CharacterCreateMessage,
  CharacterDeleteMessage,
  CharacterUpdateMessage,
  CharacterListRequestMessage,
  CharacterListMessage,
  CharacterRosterDeltaMessage,
  CharacterConfirmNameMessage,
  CharacterNameConfirmedMessage,
  CharacterErrorMessage,
  WorldEntryMessage,
  MoveMessage,
  ChatMessage,
  InteractMessage,
  CombatActionMessage,
} from '@/network/protocol/types';
import type { Character } from '@prisma/client';

interface ClientInfo {
  type: ClientType;
  version: string;
  capabilities: ClientCapabilities;
  isMachine: boolean;
}

/**
 * Gateway Client Session - handles client connection on Gateway
 *
 * Manages auth and character selection locally
 * Routes game messages (movement, chat, etc.) to Zone servers via Redis
 */
export class GatewayClientSession {
  private readonly PROTOCOL_VERSION = '1.0.0';
  private authenticated: boolean = false;
  private isAirlock: boolean = false;
  private airlockSessionId: string | null = null;
  private airlockId: string | null = null;
  private maxConcurrentInhabits: number = 0;
  private maxCharacters: number = 0;
  private characterId: string | null = null;
  private accountId: string | null = null;
  private currentZoneId: string | null = null;
  private lastPingTime: number = Date.now();
  private clientInfo: ClientInfo | null = null;
  // Pending registration: stores password while awaiting name confirmation
  private pendingRegistration: { username: string; password: string } | null = null;
  // Pending character creation: stores appearance while awaiting name confirmation
  private pendingCharacterCreate: { name: string; appearance?: { description: string } } | null = null;
  // Guest session flag - if true, account+character deleted on disconnect
  private isGuestSession: boolean = false;

  constructor(
    private socket: Socket,
    private messageBus: MessageBus,
    private zoneRegistry: ZoneRegistry
  ) {
    this.setupMessageHandlers();
  }

  private setupMessageHandlers(): void {
    // Handshake
    this.socket.on('handshake', (data) => {
      const compatible = this.isProtocolCompatible(data.protocolVersion);
      if (!compatible && process.env.NODE_ENV !== 'production') {
        logger.warn(
          `Dev mode: accepting protocol ${data.protocolVersion} (server ${this.PROTOCOL_VERSION})`
        );
      }

      this.setClientInfo({
        type: data.clientType,
        version: data.clientVersion,
        capabilities: data.capabilities,
        isMachine: data.isMachine === true,
      });

      this.socket.emit('handshake_ack', {
        protocolVersion: this.PROTOCOL_VERSION,
        compatible,
        serverCapabilities: {
          maxPlayers: 10000,
          features: ['proximity_roster', 'movement', 'chat', 'combat'],
        },
      });
    });

    // Authentication
    this.socket.on('auth', (data: AuthMessage['payload']) => {
      this.authenticate(data);
    });

    // Registration confirmation (when creating new account)
    this.socket.on('auth_name_confirmed', (data: AuthNameConfirmedMessage['payload']) => {
      this.handleNameConfirmation(data);
    });

    // Character selection/creation
    this.socket.on('character_select', (data: CharacterSelectMessage['payload']) => {
      if (this.isAirlock) {
        this.sendError('AIRLOCK_SESSION', 'Airlock sessions cannot select characters');
        return;
      }
      if (!this.authenticated) {
        this.sendError('NOT_AUTHENTICATED', 'Must authenticate before selecting character');
        return;
      }
      this.handleCharacterSelect(data);
    });

    this.socket.on('character_create', (data: CharacterCreateMessage['payload']) => {
      if (this.isAirlock) {
        this.sendError('AIRLOCK_SESSION', 'Airlock sessions cannot create characters');
        return;
      }
      if (!this.authenticated) {
        this.sendError('NOT_AUTHENTICATED', 'Must authenticate before creating character');
        return;
      }
      this.handleCharacterCreate(data);
    });

    this.socket.on('character_name_confirmed', (data: CharacterNameConfirmedMessage['payload']) => {
      if (this.isAirlock) {
        this.sendError('AIRLOCK_SESSION', 'Airlock sessions cannot create characters');
        return;
      }
      if (!this.authenticated) {
        this.sendError('NOT_AUTHENTICATED', 'Must authenticate before creating character');
        return;
      }
      this.handleCharacterNameConfirmation(data);
    });

    this.socket.on('character_delete', (data: CharacterDeleteMessage['payload']) => {
      if (this.isAirlock) {
        this.sendError('AIRLOCK_SESSION', 'Airlock sessions cannot delete characters');
        return;
      }
      if (!this.authenticated) {
        this.sendError('NOT_AUTHENTICATED', 'Must authenticate before deleting character');
        return;
      }
      this.handleCharacterDelete(data);
    });

    this.socket.on('character_update', (data: CharacterUpdateMessage['payload']) => {
      if (this.isAirlock) {
        this.sendError('AIRLOCK_SESSION', 'Airlock sessions cannot update characters');
        return;
      }
      if (!this.authenticated) {
        this.sendError('NOT_AUTHENTICATED', 'Must authenticate before updating character');
        return;
      }
      this.handleCharacterUpdate(data);
    });

    this.socket.on('character_list_request', (_data: CharacterListRequestMessage['payload']) => {
      if (!this.authenticated) {
        this.sendCharacterError('NOT_AUTHENTICATED', 'Must authenticate before requesting roster', 'list');
        return;
      }
      this.sendCharacterList();
    });

    // Game messages - route to Zone server
    this.socket.on('move', async (data: MoveMessage['payload']) => {
      if (!this.characterId || !this.currentZoneId) {
        this.sendDevAck('move', false, 'not_in_world');
        return;
      }
      const routed = await this.routeToZone('move', data);
      this.sendDevAck('move', routed, routed ? undefined : 'not_routed');
    });

    this.socket.on('chat', async (data: ChatMessage['payload']) => {
      if (!this.characterId || !this.currentZoneId) {
        this.sendDevAck('chat', false, 'not_in_world');
        return;
      }
      const message = (data.message || '').trim();
      if (message.startsWith('/')) {
        const routed = await this.routeCommandToZone(message);
        this.sendDevAck('command', routed, routed ? undefined : 'not_routed');
        return;
      }

      const routed = await this.routeToZone('chat', data);
      this.sendDevAck('chat', routed, routed ? undefined : 'not_routed');
    });

    this.socket.on('combat_action', async (data: CombatActionMessage['payload']) => {
      if (!this.characterId || !this.currentZoneId) {
        this.sendDevAck('combat_action', false, 'not_in_world');
        return;
      }
      const routed = await this.routeToZone('combat_action', data);
      this.sendDevAck('combat_action', routed, routed ? undefined : 'not_routed');
    });

    this.socket.on('interact', async (data: InteractMessage['payload']) => {
      if (!this.characterId || !this.currentZoneId) {
        this.sendDevAck('interact', false, 'not_in_world');
        return;
      }
      const routed = await this.routeToZone('interact', data);
      this.sendDevAck('interact', routed, routed ? undefined : 'not_routed');
    });

    this.socket.on('command', async (data: { command?: string } | string) => {
      if (!this.characterId || !this.currentZoneId) {
        this.sendDevAck('command', false, 'not_in_world');
        return;
      }

      const rawCommand = typeof data === 'string' ? data : data.command;
      if (!rawCommand || !rawCommand.trim()) {
        this.sendDevAck('command', false, 'empty_command');
        return;
      }

      const routed = await this.routeCommandToZone(rawCommand);
      this.sendDevAck('command', routed, routed ? undefined : 'not_routed');
    });

    // Airlock controls
    this.socket.on('inhabit_request', async (data) => {
      await this.handleInhabitRequest(data);
    });

    this.socket.on('inhabit_release', async (data) => {
      await this.handleInhabitRelease(data);
    });

    this.socket.on('inhabit_ping', async (data) => {
      await this.handleInhabitPing(data);
    });

    this.socket.on('inhabit_chat', async (data) => {
      await this.handleInhabitChat(data);
    });

    this.socket.on('proximity_refresh', async () => {
      if (!this.characterId || !this.currentZoneId) {
        this.sendDevAck('proximity_refresh', false, 'not_in_world');
        return;
      }

      const channel = `zone:${this.currentZoneId}:input`;
      await this.messageBus.publish(channel, {
        type: MessageType.PLAYER_PROXIMITY_REFRESH,
        zoneId: this.currentZoneId,
        characterId: this.characterId,
        socketId: this.socket.id,
        payload: { characterId: this.characterId, zoneId: this.currentZoneId },
        timestamp: Date.now(),
      });

      this.sendDevAck('proximity_refresh', true);
    });

    // Ping/pong
    this.socket.on('ping', (data) => {
      this.updatePing();
      this.socket.emit('pong', {
        serverTimestamp: Date.now(),
        clientTimestamp: data.timestamp,
      });
    });
  }

  /**
   * Route a game message to the appropriate Zone server
   */
  private async routeToZone(event: string, data: unknown): Promise<boolean> {
    if (!this.currentZoneId || !this.characterId) return false;

    const channel = `zone:${this.currentZoneId}:input`;

    let messageType: MessageType;
    switch (event) {
      case 'move':
        messageType = MessageType.PLAYER_MOVE;
        const moveData = data as MoveMessage['payload'];

        // Validate: need either position (for position-based move) or heading (for direction-based move)
        if (!moveData.position && moveData.heading === undefined && moveData.speed !== 'stop') {
          logger.warn({ characterId: this.characterId }, 'Movement request missing position or heading');
          this.sendDevAck('move', false, 'missing_position_or_heading');
          return false;
        }

        // Pass through full movement data to zone server for MovementSystem handling
        await this.messageBus.publish(channel, {
          type: messageType,
          zoneId: this.currentZoneId,
          characterId: this.characterId,
          socketId: this.socket.id,
          payload: {
            characterId: this.characterId,
            zoneId: this.currentZoneId,
            method: moveData.method,
            position: moveData.position,
            heading: moveData.heading,
            speed: moveData.speed || 'walk',
          },
          timestamp: Date.now(),
        });
        break;

      case 'chat':
        messageType = MessageType.PLAYER_CHAT;
        const chatData = data as ChatMessage['payload'];
        await this.messageBus.publish(channel, {
          type: messageType,
          zoneId: this.currentZoneId,
          characterId: this.characterId,
          socketId: this.socket.id,
          payload: {
            characterId: this.characterId,
            zoneId: this.currentZoneId,
            channel: chatData.channel,
            text: chatData.message,
          },
          timestamp: Date.now(),
        });
        break;
      case 'combat_action':
        messageType = MessageType.PLAYER_COMBAT_ACTION;
        const combatData = data as CombatActionMessage['payload'];
        await this.messageBus.publish(channel, {
          type: messageType,
          zoneId: this.currentZoneId,
          characterId: this.characterId,
          socketId: this.socket.id,
          payload: {
            characterId: this.characterId,
            zoneId: this.currentZoneId,
            socketId: this.socket.id,
            abilityId: combatData.abilityId,
            targetId: combatData.targetId,
            position: combatData.position,
            timestamp: combatData.timestamp,
          },
          timestamp: Date.now(),
        });
        break;

      default:
        logger.warn({ event }, 'Unhandled game event for routing');
        return false;
    }

    return true;
  }

  private async routeCommandToZone(rawCommand: string): Promise<boolean> {
    if (!this.currentZoneId || !this.characterId) return false;

    const channel = `zone:${this.currentZoneId}:input`;
    await this.messageBus.publish(channel, {
      type: MessageType.PLAYER_COMMAND,
      zoneId: this.currentZoneId,
      characterId: this.characterId,
      socketId: this.socket.id,
      payload: {
        characterId: this.characterId,
        zoneId: this.currentZoneId,
        command: rawCommand,
        socketId: this.socket.id,
      },
      timestamp: Date.now(),
    });

    return true;
  }

  setClientInfo(info: ClientInfo): void {
    this.clientInfo = info;
    logger.debug({ info }, `Client info set for ${this.socket.id}`);
  }

  getClientInfo(): ClientInfo | null {
    return this.clientInfo;
  }

  async authenticate(data: AuthMessage['payload']): Promise<void> {
    logger.info(`Authentication attempt for ${this.socket.id}, method: ${data.method}`);

    try {
      switch (data.method) {
        case 'guest':
          await this.authenticateGuest(data.guestName || 'Guest');
          break;
        case 'credentials':
          // Support both email and username
          const identifier = data.email || data.username;
          if (!identifier || !data.password) {
            throw new Error('Email/username and password required');
          }
          await this.authenticateCredentials(identifier, data.password);
          break;
        case 'token':
          await this.authenticateToken(data.token!);
          break;
        case 'airlock':
          await this.authenticateAirlock(data);
          break;
        default:
          throw new Error('Invalid authentication method');
      }
    } catch (error) {
      logger.error({ error }, `Authentication failed for ${this.socket.id}`);
      const errorResponse: AuthErrorMessage['payload'] = {
        reason: 'invalid_credentials',
        message: error instanceof Error ? error.message : 'Authentication failed',
        canRetry: true,
      };
      this.socket.emit('auth_error', errorResponse);
    }
  }

  private async authenticateGuest(guestName: string): Promise<void> {
    // Generate a unique guest name
    const guestSuffix = Math.random().toString(36).substring(2, 8);
    const characterName = guestName ? `${guestName}_${guestSuffix}` : `Guest_${guestSuffix}`;

    // Create guest account
    const account = await AccountService.createGuestAccount(characterName);

    this.authenticated = true;
    this.accountId = account.id;
    this.maxCharacters = 0;  // Guests can't create more characters
    this.isGuestSession = true;

    // Auto-create a guest character
    const starterZoneId = 'USA_NY_Stephentown';
    const spawn = SpawnPointService.getStarterSpawn(starterZoneId);
    
    if (!spawn) {
      throw new Error('No spawn point available for guest');
    }
    
    const character = await CharacterService.createCharacter({
      accountId: account.id,
      name: characterName,
      zoneId: starterZoneId,
      positionX: spawn.position.x,
      positionY: spawn.position.y,
      positionZ: spawn.position.z,
    });

    this.characterId = character.id;

    const characterInfo = await this.buildCharacterInfo(character);
    const ephemeralMessage = `You are exploring as "${characterName}". This character will be deleted when you disconnect.`;

    const response: AuthSuccessMessage['payload'] = {
      accountId: account.id,
      token: 'guest-token',
      characters: [characterInfo],
      canCreateCharacter: false,
      maxCharacters: 0,
      isEphemeral: true,
      ephemeralMessage,
    };

    this.socket.emit('auth_success', response);
    logger.info(`Guest authenticated: ${this.socket.id} as ${characterName} (Account: ${account.id})`);

    // Auto-enter the world
    await this.enterWorld();
  }

  private async authenticateCredentials(identifier: string, password: string): Promise<void> {
    // Validate input
    if (!identifier || !password) {
      throw new Error('Email/username and password required');
    }

    if (password.length < 6) {
      throw new Error('Password must be at least 6 characters');
    }

    // Find account by email or username
    let account = await AccountService.findByEmail(identifier);
    if (!account) {
      account = await AccountService.findByUsername(identifier);
    }

    if (!account) {
      throw new Error('Invalid credentials');
    }

    // Verify password
    const bcrypt = await import('bcryptjs');
    const passwordValid = await bcrypt.compare(password, account.passwordHash);
    if (!passwordValid) {
      throw new Error('Invalid credentials');
    }

    // Password correct - complete authentication
    await this.completeCredentialAuth(account);
  }

  private async handleNameConfirmation(data: AuthNameConfirmedMessage['payload']): Promise<void> {
    if (!this.pendingRegistration) {
      this.sendError('NO_PENDING_REGISTRATION', 'No pending registration to confirm');
      return;
    }

    if (data.username !== this.pendingRegistration.username) {
      this.sendError('USERNAME_MISMATCH', 'Username does not match pending registration');
      this.pendingRegistration = null;
      return;
    }

    if (!data.confirmed) {
      // User cancelled - clear pending and send error
      this.pendingRegistration = null;
      const errorResponse: AuthErrorMessage['payload'] = {
        reason: 'registration_cancelled',
        message: 'Account creation cancelled',
        canRetry: true,
      };
      this.socket.emit('auth_error', errorResponse);
      return;
    }

    try {
      // Double-check username is still available (race condition protection)
      const isAvailable = await AccountService.isUsernameAvailable(this.pendingRegistration.username);
      if (!isAvailable) {
        this.pendingRegistration = null;
        throw new Error('Username was taken while confirming. Please try a different name.');
      }

      // Create the account
      const newAccount = await AccountService.createWithPassword(
        this.pendingRegistration.username,
        this.pendingRegistration.password
      );

      this.pendingRegistration = null;
      logger.info(`New account created: ${newAccount.username} (${newAccount.id})`);

      // Complete authentication
      await this.completeCredentialAuth(newAccount);
    } catch (error) {
      this.pendingRegistration = null;
      logger.error({ error }, `Account creation failed for ${this.socket.id}`);
      const errorResponse: AuthErrorMessage['payload'] = {
        reason: 'registration_failed',
        message: error instanceof Error ? error.message : 'Account creation failed',
        canRetry: true,
      };
      this.socket.emit('auth_error', errorResponse);
    }
  }

  private async completeCredentialAuth(account: import('@prisma/client').Account): Promise<void> {
    this.authenticated = true;
    this.accountId = account.id;
    this.maxCharacters = 5;

    // Update last login time
    await AccountService.updateLastLogin(account.id);

    // Get character list
    const characters = await CharacterService.findByAccountId(account.id);
    const characterSummaries = await Promise.all(
      characters.map(char => this.buildCharacterInfo(char))
    );

    // TODO: Generate real JWT token when we add token auth
    const token = `session-${account.id}-${Date.now()}`;

    const response: AuthSuccessMessage['payload'] = {
      accountId: account.id,
      token,
      characters: characterSummaries,
      canCreateCharacter: characters.length < this.maxCharacters,
      maxCharacters: this.maxCharacters,
    };

    this.socket.emit('auth_success', response);
    logger.info(`Credentials authenticated: ${this.socket.id} for account ${account.username} (${account.id})`);
  }

  private async authenticateToken(_token: string): Promise<void> {
    logger.warn('Token authentication not fully implemented');
    throw new Error('Token authentication not yet implemented');
  }

  private async authenticateAirlock(data: AuthMessage['payload']): Promise<void> {
    const airlockKey = data.airlockKey || '';
    const airlockId = data.airlockId || 'airlock';
    const sharedSecret = process.env.AIRLOCK_SHARED_SECRET || '';

    if (!sharedSecret || airlockKey !== sharedSecret) {
      throw new Error('Invalid airlock key');
    }

    const sessionId = randomUUID();
    const sessionTtlMs = Number.parseInt(
      process.env.AIRLOCK_SESSION_TTL_MS || `${12 * 60 * 60 * 1000}`,
      10
    );

    const expiresAt = Date.now() + sessionTtlMs;
    const maxConcurrent = Number.parseInt(process.env.AIRLOCK_MAX_CONCURRENT || '5', 10);

    const redis = this.messageBus.getRedisClient();
    await redis.hSet(`airlock:session:${sessionId}`, {
      airlockId,
      expiresAt: `${expiresAt}`,
    });
    await redis.pExpire(`airlock:session:${sessionId}`, sessionTtlMs);

    this.isAirlock = true;
    this.airlockSessionId = sessionId;
    this.airlockId = airlockId;
    this.maxConcurrentInhabits = maxConcurrent;
    this.maxCharacters = 0;
    this.authenticated = true;

    const response: AuthSuccessMessage['payload'] = {
      accountId: '',
      token: 'airlock-session',
      characters: [],
      canCreateCharacter: false,
      maxCharacters: this.maxCharacters,
      airlockSessionId: sessionId,
      expiresAt,
      canInhabit: true,
      maxConcurrentInhabits: maxConcurrent,
    };

    this.socket.emit('auth_success', response);
    logger.info(`Airlock authenticated: ${this.socket.id} as ${airlockId}`);
  }

  private async handleCharacterSelect(data: CharacterSelectMessage['payload']): Promise<void> {
    logger.info(`Character select for ${this.socket.id}: ${data.characterId}`);

    const character = await CharacterService.findById(data.characterId);

    if (!character) {
      this.sendError('CHARACTER_NOT_FOUND', 'Character not found');
      return;
    }

    if (character.accountId !== this.accountId) {
      this.sendError('NOT_YOUR_CHARACTER', 'This character does not belong to your account');
      return;
    }

    this.characterId = character.id;
    await CharacterService.updateLastSeen(character.id);
    await this.enterWorld();
  }

  private async handleCharacterCreate(data: CharacterCreateMessage['payload']): Promise<void> {
    logger.info(`Character create request for ${this.socket.id}: ${data.name}`);

    if (!this.accountId) {
      this.sendError('NOT_AUTHENTICATED', 'Must be authenticated to create character');
      return;
    }

    const name = (data.name || '').trim();
    if (!name) {
      this.sendCharacterError('INVALID_NAME', 'Character name is required', 'create');
      return;
    }

    if (name.length < 2 || name.length > 24) {
      this.sendCharacterError('INVALID_NAME', 'Character name must be between 2 and 24 characters', 'create');
      return;
    }

    const characters = await CharacterService.findByAccountId(this.accountId);
    if (this.maxCharacters > 0 && characters.length >= this.maxCharacters) {
      this.sendCharacterError('LIMIT_REACHED', 'Character limit reached', 'create');
      return;
    }

    const existing = await CharacterService.findByName(name);
    if (existing) {
      this.sendCharacterError('NAME_TAKEN', 'That name is already taken', 'create');
      return;
    }

    // Store pending creation and ask for confirmation
    this.pendingCharacterCreate = { name, appearance: data.appearance };

    const confirmMessage: CharacterConfirmNameMessage['payload'] = {
      name,
      message: `Create character named "${name}"?`,
    };

    this.socket.emit('character_confirm_name', confirmMessage);
    logger.info(`Character name confirmation requested for ${this.socket.id}: ${name}`);
  }

  private async handleCharacterNameConfirmation(data: CharacterNameConfirmedMessage['payload']): Promise<void> {
    if (!this.pendingCharacterCreate) {
      this.sendCharacterError('NO_PENDING', 'No pending character creation to confirm', 'create');
      return;
    }

    if (data.name !== this.pendingCharacterCreate.name) {
      this.sendCharacterError('NAME_MISMATCH', 'Name does not match pending character creation', 'create');
      this.pendingCharacterCreate = null;
      return;
    }

    if (!data.confirmed) {
      // User cancelled
      this.pendingCharacterCreate = null;
      this.sendCharacterError('CANCELLED', 'Character creation cancelled', 'create');
      return;
    }

    try {
      // Double-check name is still available (race condition protection)
      const existing = await CharacterService.findByName(this.pendingCharacterCreate.name);
      if (existing) {
        this.pendingCharacterCreate = null;
        this.sendCharacterError('NAME_TAKEN', 'That name was taken while confirming. Please try a different name.', 'create');
        return;
      }

      // Double-check character limit
      const characters = await CharacterService.findByAccountId(this.accountId!);
      if (this.maxCharacters > 0 && characters.length >= this.maxCharacters) {
        this.pendingCharacterCreate = null;
        this.sendCharacterError('LIMIT_REACHED', 'Character limit reached', 'create');
        return;
      }

      // Create the character
      const cosmetics = this.pendingCharacterCreate.appearance
        ? { appearance: this.pendingCharacterCreate.appearance }
        : undefined;
      const starterZoneId = 'USA_NY_Stephentown';
      const spawn = SpawnPointService.getStarterSpawn(starterZoneId);
      
      if (!spawn) {
        this.sendCharacterError('SERVER_ERROR', 'No spawn point available', 'create');
        return;
      }
      
      const character = await CharacterService.createCharacter({
        accountId: this.accountId!,
        name: this.pendingCharacterCreate.name,
        zoneId: starterZoneId,
        positionX: spawn.position.x,
        positionY: spawn.position.y,
        positionZ: spawn.position.z,
        cosmetics,
      });

      this.pendingCharacterCreate = null;
      this.characterId = character.id;
      logger.info(`Created character: ${character.name} (ID: ${character.id})`);

      await this.sendCharacterRosterDelta({
        added: [await this.buildCharacterInfo(character)],
        ...this.buildRosterLimits(characters.length + 1),
      });

      await this.enterWorld();
    } catch (error) {
      this.pendingCharacterCreate = null;
      logger.error({ error }, `Character creation failed for ${this.socket.id}`);
      this.sendCharacterError('CREATE_FAILED', error instanceof Error ? error.message : 'Character creation failed', 'create');
    }
  }

  private async handleCharacterDelete(data: CharacterDeleteMessage['payload']): Promise<void> {
    if (!this.accountId) {
      this.sendCharacterError('NOT_AUTHENTICATED', 'Must be authenticated to delete character', 'delete');
      return;
    }

    if (this.characterId || this.currentZoneId) {
      this.sendCharacterError('ACTIVE_CHARACTER', 'Cannot delete while a character is active', 'delete');
      return;
    }

    const characterId = data.characterId;
    if (!characterId) {
      this.sendCharacterError('NOT_FOUND', 'Character id is required', 'delete');
      return;
    }

    const character = await CharacterService.findById(characterId);
    if (!character) {
      this.sendCharacterError('NOT_FOUND', 'Character not found', 'delete');
      return;
    }

    if (character.accountId !== this.accountId) {
      this.sendCharacterError('NOT_OWNED', 'This character does not belong to your account', 'delete');
      return;
    }

    await CharacterService.deleteCharacter(characterId);

    const characters = await CharacterService.findByAccountId(this.accountId);
    await this.sendCharacterRosterDelta({
      removed: [characterId],
      ...this.buildRosterLimits(characters.length),
    });
  }

  private async handleCharacterUpdate(data: CharacterUpdateMessage['payload']): Promise<void> {
    if (!this.accountId) {
      this.sendCharacterError('NOT_AUTHENTICATED', 'Must be authenticated to update character', 'update');
      return;
    }

    if (this.characterId || this.currentZoneId) {
      this.sendCharacterError('ACTIVE_CHARACTER', 'Cannot update while a character is active', 'update');
      return;
    }

    if (!data.characterId) {
      this.sendCharacterError('NOT_FOUND', 'Character id is required', 'update');
      return;
    }

    const character = await CharacterService.findById(data.characterId);
    if (!character) {
      this.sendCharacterError('NOT_FOUND', 'Character not found', 'update');
      return;
    }

    if (character.accountId !== this.accountId) {
      this.sendCharacterError('NOT_OWNED', 'This character does not belong to your account', 'update');
      return;
    }

    let name: string | undefined = undefined;
    if (data.name !== undefined) {
      const trimmed = data.name.trim();
      if (!trimmed) {
        this.sendCharacterError('INVALID_NAME', 'Character name is required', 'update');
        return;
      }

      const existing = await CharacterService.findByName(trimmed);
      if (existing && existing.id !== character.id) {
        this.sendCharacterError('NAME_TAKEN', 'That name is already taken', 'update');
        return;
      }

      name = trimmed;
    }

    const cosmetics = data.cosmetics;
    if (name === undefined && cosmetics === undefined) {
      this.sendCharacterError('NO_CHANGES', 'No character updates provided', 'update');
      return;
    }

    const updated = await CharacterService.updateCharacter(character.id, { name, cosmetics });
    await this.sendCharacterRosterDelta({
      updated: [await this.buildCharacterInfo(updated)],
    });
  }

  private async enterWorld(): Promise<void> {
    if (!this.characterId) {
      this.sendError('NO_CHARACTER', 'No character selected');
      return;
    }

    logger.info(`Character ${this.characterId} entering world`);

    const character = await CharacterService.findByIdWithZone(this.characterId);

    if (!character) {
      this.sendError('CHARACTER_NOT_FOUND', 'Character data not found');
      return;
    }

    const zone = character.zone;

    // Get respawn position (uses saved lastPosition if available, with collision avoidance)
    const respawnPos = SpawnPointService.getRespawnPosition(
      zone.id,
      character.lastPositionX,
      character.lastPositionY,
      character.lastPositionZ
    );

    // Update character position to respawn position if different
    if (
      respawnPos.x !== character.positionX ||
      respawnPos.y !== character.positionY ||
      respawnPos.z !== character.positionZ
    ) {
      await CharacterService.updatePosition(this.characterId, {
        x: respawnPos.x,
        y: respawnPos.y,
        z: respawnPos.z,
      });
      // Reload character with updated position
      const updatedCharacter = await CharacterService.findByIdWithZone(this.characterId);
      if (updatedCharacter) {
        Object.assign(character, updatedCharacter);
      }
    }

    const coreStats = {
      strength: character.strength,
      vitality: character.vitality,
      dexterity: character.dexterity,
      agility: character.agility,
      intelligence: character.intelligence,
      wisdom: character.wisdom,
    };

    const derivedStats = StatCalculator.calculateDerivedStats(coreStats, character.level);

    // Get companions (NPCs) and mobs in the zone
    const companions = await ZoneService.getCompanionsInZone(zone.id);
    const mobs = await ZoneService.getMobsInZone(zone.id);

    // Build entity list (NPCs and mobs)
    const npcEntities = companions
      .filter(companion => companion.isAlive ?? true)
      .map(companion => ({
      id: companion.id,
      type: 'npc' as const,
      name: companion.name,
      position: { x: companion.positionX, y: companion.positionY, z: companion.positionZ },
      description: companion.description || '',
      isAlive: companion.isAlive ?? true,
      interactive: true,
    }));

    // Apply gravity to mobs (pull floating entities to ground)
    const physicsSystem = new PhysicsSystem();
    const mobEntities = mobs
      .filter(mob => mob.isAlive)
      .map(mob => {
        const mobPos = { x: mob.positionX, y: mob.positionY, z: mob.positionZ };
        const adjustedPos = physicsSystem.applyGravity(mobPos);
        
        return {
          id: mob.id,
          type: 'mob' as const,
          tag: mob.tag,
          name: mob.name,
          position: { x: adjustedPos.x, y: adjustedPos.y, z: adjustedPos.z },
          description: mob.description || '',
          isAlive: mob.isAlive,
          level: mob.level,
          faction: mob.faction,
          interactive: true,
        };
      });

    const entities = [...npcEntities, ...mobEntities];

    const worldEntry: WorldEntryMessage['payload'] = {
      characterId: character.id,
      timestamp: Date.now(),
      character: {
        id: character.id,
        name: character.name,
        level: character.level,
        experience: character.experience,
        abilityPoints: character.abilityPoints,
        isAlive: character.isAlive ?? true,
        position: { x: character.positionX, y: character.positionY, z: character.positionZ },
        heading: character.heading,
        rotation: { x: 0, y: character.heading, z: 0 },
        currentSpeed: 'stop',
        coreStats,
        derivedStats,
        health: { current: character.currentHp, max: character.maxHp },
        stamina: { current: character.currentStamina, max: character.maxStamina },
        mana: { current: character.currentMana, max: character.maxMana },
        unlockedFeats: character.unlockedFeats as string[],
        unlockedAbilities: character.unlockedAbilities as string[],
        activeLoadout: character.activeLoadout as string[],
        passiveLoadout: character.passiveLoadout as string[],
        specialLoadout: character.specialLoadout as string[],
      },
      zone: {
        id: zone.id,
        name: zone.name,
        description: zone.description || '',
        weather: 'clear',
        timeOfDay: 'dusk',
        lighting: 'dim',
        contentRating: zone.contentRating as 'T' | 'M' | 'AO',
      },
      entities,
      exits: [],
    };

    this.socket.emit('world_entry', worldEntry);
    logger.info(`World entry sent for character ${character.name} in ${zone.name}`);

    // Notify Zone server that player joined
    this.currentZoneId = zone.id;
    await this.zoneRegistry.updatePlayerLocation(character.id, zone.id, this.socket.id);

    const channel = `zone:${zone.id}:input`;
    await this.messageBus.publish(channel, {
      type: MessageType.PLAYER_JOIN_ZONE,
      zoneId: zone.id,
      characterId: character.id,
      socketId: this.socket.id,
      payload: {
        character,
        socketId: this.socket.id,
        isMachine: this.clientInfo?.isMachine === true,
      },
      timestamp: Date.now(),
    });
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  getCharacterId(): string | null {
    return this.characterId;
  }

  getAccountId(): string | null {
    return this.accountId;
  }

  send(event: string, data: unknown): void {
    this.socket.emit(event, data);
  }

  sendError(code: string, message: string, severity: 'info' | 'warning' | 'error' | 'fatal' = 'error'): void {
    this.socket.emit('error', {
      code,
      message,
      severity,
    });
  }

  private async handleInhabitRequest(data: {
    airlockSessionId?: string;
    npcId?: string;
    npcTag?: string;
    ttlMs?: number;
  }): Promise<void> {
    if (!this.isAirlock || !this.airlockSessionId || !this.airlockId) {
      this.socket.emit('inhabit_denied', { reason: 'not_authorized' });
      return;
    }

    if (data.airlockSessionId !== this.airlockSessionId) {
      this.socket.emit('inhabit_denied', { reason: 'not_authorized' });
      return;
    }

    const redis = this.messageBus.getRedisClient();
    const sessionSetKey = `airlock:session:${this.airlockSessionId}:inhabits`;
    const activeCount = await redis.sCard(sessionSetKey);

    if (activeCount >= this.maxConcurrentInhabits) {
      this.socket.emit('inhabit_denied', { reason: 'limit_reached' });
      return;
    }

    let companion = null;
    if (data.npcId) {
      companion = await CompanionService.findById(data.npcId);
    } else if (data.npcTag) {
      const candidates = await CompanionService.findByTag(data.npcTag);
      for (const candidate of candidates) {
        const occupied = await redis.get(`airlock:npc:${candidate.id}`);
        if (!occupied) {
          companion = candidate;
          break;
        }
      }
    }

    if (!companion) {
      this.socket.emit('inhabit_denied', { reason: 'npc_unavailable' });
      return;
    }

    if (companion.possessedAirlockId && companion.possessedAirlockId !== this.airlockId) {
      this.socket.emit('inhabit_denied', { reason: 'not_authorized' });
      return;
    }

    const sessionTtlMs = Number.parseInt(
      process.env.AIRLOCK_SESSION_TTL_MS || `${12 * 60 * 60 * 1000}`,
      10
    );
    const defaultTtlEnv = process.env.AIRLOCK_INHABIT_TTL_MS;
    const defaultTtlMs = defaultTtlEnv === undefined
      ? sessionTtlMs
      : Number.parseInt(defaultTtlEnv || '0', 10);
    const maxTtlMs = Number.parseInt(
      process.env.AIRLOCK_INHABIT_MAX_TTL_MS || `${30 * 60 * 1000}`,
      10
    );
    const requestedTtlMs = data.ttlMs ?? defaultTtlMs;
    const ttlMs = requestedTtlMs <= 0 ? 0 : Math.min(requestedTtlMs, maxTtlMs);

    const inhabitId = randomUUID();
    const npcKey = `airlock:npc:${companion.id}`;
    const setResult = ttlMs > 0
      ? await redis.set(npcKey, inhabitId, { PX: ttlMs, NX: true })
      : await redis.set(npcKey, inhabitId, { NX: true });

    if (!setResult) {
      this.socket.emit('inhabit_denied', { reason: 'npc_unavailable' });
      return;
    }

    const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;
    const inhabitKey = `airlock:inhabit:${inhabitId}`;
    await redis.hSet(inhabitKey, {
      airlockSessionId: this.airlockSessionId,
      airlockId: this.airlockId,
      npcId: companion.id,
      zoneId: companion.zoneId,
      expiresAt: `${expiresAt}`,
      ttlMs: `${ttlMs}`,
    });
    if (ttlMs > 0) {
      await redis.pExpire(inhabitKey, ttlMs);
    }
    await redis.sAdd(sessionSetKey, inhabitId);
    await redis.pExpire(sessionSetKey, sessionTtlMs);

    const channel = `zone:${companion.zoneId}:input`;
    await this.messageBus.publish(channel, {
      type: MessageType.NPC_INHABIT,
      zoneId: companion.zoneId,
      socketId: this.socket.id,
      payload: {
        companionId: companion.id,
        zoneId: companion.zoneId,
        socketId: this.socket.id,
      },
      timestamp: Date.now(),
    });

    this.socket.emit('inhabit_granted', {
      inhabitId,
      npcId: companion.id,
      displayName: companion.name,
      zoneId: companion.zoneId,
      expiresAt,
    });
  }

  private async handleInhabitRelease(data: { inhabitId?: string; reason?: string }): Promise<void> {
    if (!data.inhabitId) return;
    await this.releaseInhabit(data.inhabitId, data.reason || 'session_end', true);
  }

  private async handleInhabitPing(data: { inhabitId?: string }): Promise<void> {
    if (!this.isAirlock || !this.airlockSessionId || !data.inhabitId) return;

    const redis = this.messageBus.getRedisClient();
    const inhabitKey = `airlock:inhabit:${data.inhabitId}`;
    const result = await redis.hGetAll(inhabitKey);

    if (!result.airlockSessionId || result.airlockSessionId !== this.airlockSessionId) {
      this.socket.emit('inhabit_revoked', { inhabitId: data.inhabitId, reason: 'not_authorized' });
      return;
    }

    await this.refreshInhabitTtl(redis, inhabitKey, result);
  }

  private async handleInhabitChat(data: { inhabitId?: string; channel?: string; message?: string }): Promise<void> {
    if (!this.isAirlock || !this.airlockSessionId || !data.inhabitId) {
      this.sendDevAck('inhabit_chat', false, 'not_authorized');
      return;
    }

    const redis = this.messageBus.getRedisClient();
    const inhabitKey = `airlock:inhabit:${data.inhabitId}`;
    const result = await redis.hGetAll(inhabitKey);

    if (!result.airlockSessionId || result.airlockSessionId !== this.airlockSessionId) {
      this.socket.emit('inhabit_denied', { reason: 'not_authorized' });
      return;
    }

    if (!result.npcId || !result.zoneId || !data.message || !data.channel) {
      this.sendDevAck('inhabit_chat', false, 'invalid_payload');
      return;
    }

    const channel = `zone:${result.zoneId}:input`;
    await this.messageBus.publish(channel, {
      type: MessageType.NPC_CHAT,
      zoneId: result.zoneId,
      payload: {
        companionId: result.npcId,
        zoneId: result.zoneId,
        channel: data.channel,
        text: data.message,
      },
      timestamp: Date.now(),
    });

    await this.refreshInhabitTtl(redis, inhabitKey, result);
    this.sendDevAck('inhabit_chat', true);
  }

  async disconnect(): Promise<void> {
    this.socket.disconnect(true);
  }

  async cleanup(): Promise<void> {
    if (this.isAirlock && this.airlockSessionId) {
      await this.releaseAllInhabits('disconnect');
      this.isAirlock = false;
      this.airlockSessionId = null;
      this.airlockId = null;
    }

    // Notify Zone server that player left
    if (this.characterId && this.currentZoneId) {
      const channel = `zone:${this.currentZoneId}:input`;
      await this.messageBus.publish(channel, {
        type: MessageType.PLAYER_LEAVE_ZONE,
        zoneId: this.currentZoneId,
        characterId: this.characterId,
        socketId: this.socket.id,
        payload: { characterId: this.characterId, zoneId: this.currentZoneId },
        timestamp: Date.now(),
      });

      await this.zoneRegistry.removePlayer(this.characterId);
    }

    // Clean up guest session - delete character and account
    if (this.isGuestSession && this.accountId) {
      try {
        // Delete character first (foreign key constraint)
        if (this.characterId) {
          await CharacterService.deleteCharacter(this.characterId);
          logger.info(`Guest character deleted: ${this.characterId}`);
        }
        // Delete the guest account
        await AccountService.deleteAccount(this.accountId);
        logger.info(`Guest account deleted: ${this.accountId}`);
      } catch (error) {
        logger.error({ error }, `Failed to clean up guest session: ${this.accountId}`);
      }
    }

    this.authenticated = false;
    this.characterId = null;
    this.accountId = null;
    this.currentZoneId = null;
    this.clientInfo = null;
    this.isGuestSession = false;
  }

  private async releaseInhabit(inhabitId: string, reason: string, notifyClient: boolean): Promise<void> {
    if (!this.airlockSessionId) return;

    const redis = this.messageBus.getRedisClient();
    const inhabitKey = `airlock:inhabit:${inhabitId}`;
    const result = await redis.hGetAll(inhabitKey);

    if (!result.airlockSessionId || result.airlockSessionId !== this.airlockSessionId) {
      if (notifyClient) {
        this.socket.emit('inhabit_denied', { reason: 'not_authorized' });
      }
      return;
    }

    if (result.npcId) {
      await redis.del(`airlock:npc:${result.npcId}`);
    }

    await redis.del(inhabitKey);
    await redis.sRem(`airlock:session:${this.airlockSessionId}:inhabits`, inhabitId);

    if (result.npcId && result.zoneId) {
      const channel = `zone:${result.zoneId}:input`;
      await this.messageBus.publish(channel, {
        type: MessageType.NPC_RELEASE,
        zoneId: result.zoneId,
        payload: {
          companionId: result.npcId,
          zoneId: result.zoneId,
        },
        timestamp: Date.now(),
      });
    }

    if (notifyClient) {
      this.socket.emit('inhabit_revoked', { inhabitId, reason });
    }
  }

  private async releaseAllInhabits(reason: string): Promise<void> {
    if (!this.airlockSessionId) return;

    const redis = this.messageBus.getRedisClient();
    const sessionSetKey = `airlock:session:${this.airlockSessionId}:inhabits`;
    const inhabitIds = await redis.sMembers(sessionSetKey);

    for (const inhabitId of inhabitIds) {
      await this.releaseInhabit(inhabitId, reason, false);
    }

    await redis.del(sessionSetKey);
    await redis.del(`airlock:session:${this.airlockSessionId}`);
  }

  private async refreshInhabitTtl(
    redis: ReturnType<MessageBus['getRedisClient']>,
    inhabitKey: string,
    result: Record<string, string>
  ): Promise<void> {
    const ttlMs = Number.parseInt(result.ttlMs || '0', 10);
    if (ttlMs <= 0) {
      return;
    }

    const expiresAt = Date.now() + ttlMs;
    await redis.hSet(inhabitKey, { expiresAt: `${expiresAt}` });
    await redis.pExpire(inhabitKey, ttlMs);
    if (result.npcId) {
      await redis.pExpire(`airlock:npc:${result.npcId}`, ttlMs);
    }
  }

  updatePing(): void {
    this.lastPingTime = Date.now();
  }

  getLastPingTime(): number {
    return this.lastPingTime;
  }

  private sendDevAck(event: string, ok: boolean, reason?: string): void {
    if (process.env.NODE_ENV === 'production') {
      return;
    }

    this.socket.emit('dev_ack', {
      event,
      ok,
      reason,
      timestamp: Date.now(),
    });
  }

  private isProtocolCompatible(clientVersion: string): boolean {
    if (process.env.NODE_ENV !== 'production') {
      return true;
    }

    const client = this.parseVersion(clientVersion);
    const server = this.parseVersion(this.PROTOCOL_VERSION);

    if (!client || !server) {
      return false;
    }

    return client.major === server.major && client.minor === server.minor;
  }

  private parseVersion(version: string): { major: number; minor: number; patch: number } | null {
    const parts = version.split('.').map((part) => Number.parseInt(part, 10));
    if (parts.length < 2 || parts.some((part) => Number.isNaN(part))) {
      return null;
    }

    return {
      major: parts[0],
      minor: parts[1],
      patch: parts[2] ?? 0,
    };
  }

  private buildRosterLimits(characterCount: number): Pick<CharacterListMessage['payload'], 'maxCharacters' | 'emptySlots' | 'canCreateCharacter'> {
    const maxCharacters = this.maxCharacters;
    const emptySlots = Math.max(0, maxCharacters - characterCount);
    const canCreateCharacter = maxCharacters > 0 && emptySlots > 0;
    return { maxCharacters, emptySlots, canCreateCharacter };
  }

  private async buildCharacterInfo(character: Character): Promise<CharacterListMessage['payload']['characters'][number]> {
    const zone = await ZoneService.findById(character.zoneId);
    const cosmetics = this.extractCosmetics(character);
    return {
      id: character.id,
      name: character.name,
      level: character.level,
      lastPlayed: character.lastSeenAt.getTime(),
      location: zone?.name ?? 'Unknown',
      ...(cosmetics && { cosmetics }),
    };
  }

  private async sendCharacterList(): Promise<void> {
    if (!this.accountId) return;
    const characters = await CharacterService.findByAccountId(this.accountId);
    const list: CharacterListMessage['payload'] = {
      characters: await Promise.all(characters.map(char => this.buildCharacterInfo(char))),
      ...this.buildRosterLimits(characters.length),
    };
    this.socket.emit('character_list', list);
  }

  private async sendCharacterRosterDelta(payload: CharacterRosterDeltaMessage['payload']): Promise<void> {
    this.socket.emit('character_roster_delta', payload);
  }

  private sendCharacterError(code: string, message: string, action: CharacterErrorMessage['payload']['action']): void {
    this.socket.emit('character_error', { code, message, action });
  }

  private extractCosmetics(character: Character): Record<string, unknown> | null {
    const data = character.supernaturalData;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return null;
    }
    const cosmetics = (data as Record<string, unknown>).cosmetics;
    if (!cosmetics || typeof cosmetics !== 'object' || Array.isArray(cosmetics)) {
      return null;
    }
    return cosmetics as Record<string, unknown>;
  }
}
