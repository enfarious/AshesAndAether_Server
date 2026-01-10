import { Socket } from 'socket.io';
import { logger } from '@/utils/logger';
import { AccountService, CharacterService, ZoneService } from '@/database';
import { StatCalculator } from '@/game/stats/StatCalculator';
import { MessageBus, MessageType, ZoneRegistry } from '@/messaging';
import {
  ClientType,
  ClientCapabilities,
  AuthMessage,
  AuthSuccessMessage,
  AuthErrorMessage,
  CharacterSelectMessage,
  CharacterCreateMessage,
  WorldEntryMessage,
  MoveMessage,
  ChatMessage,
  InteractMessage,
  CombatActionMessage,
} from '@/network/protocol/types';

interface ClientInfo {
  type: ClientType;
  version: string;
  capabilities: ClientCapabilities;
}

/**
 * Gateway Client Session - handles client connection on Gateway
 *
 * Manages auth and character selection locally
 * Routes game messages (movement, chat, etc.) to Zone servers via Redis
 */
export class GatewayClientSession {
  private authenticated: boolean = false;
  private characterId: string | null = null;
  private accountId: string | null = null;
  private currentZoneId: string | null = null;
  private lastPingTime: number = Date.now();
  private clientInfo: ClientInfo | null = null;

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
      this.setClientInfo({
        type: data.clientType,
        version: data.clientVersion,
        capabilities: data.capabilities,
      });

      this.socket.emit('handshake_ack', {
        protocolVersion: '1.0.0',
        compatible: data.protocolVersion === '1.0.0',
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

    // Character selection/creation
    this.socket.on('character_select', (data: CharacterSelectMessage['payload']) => {
      if (!this.authenticated) {
        this.sendError('NOT_AUTHENTICATED', 'Must authenticate before selecting character');
        return;
      }
      this.handleCharacterSelect(data);
    });

    this.socket.on('character_create', (data: CharacterCreateMessage['payload']) => {
      if (!this.authenticated) {
        this.sendError('NOT_AUTHENTICATED', 'Must authenticate before creating character');
        return;
      }
      this.handleCharacterCreate(data);
    });

    // Game messages - route to Zone server
    this.socket.on('move', async (data: MoveMessage['payload']) => {
      if (!this.characterId || !this.currentZoneId) return;
      await this.routeToZone('move', data);
    });

    this.socket.on('chat', async (data: ChatMessage['payload']) => {
      if (!this.characterId || !this.currentZoneId) return;
      await this.routeToZone('chat', data);
    });

    this.socket.on('combat_action', async (data: CombatActionMessage['payload']) => {
      if (!this.characterId || !this.currentZoneId) return;
      await this.routeToZone('combat_action', data);
    });

    this.socket.on('interact', async (data: InteractMessage['payload']) => {
      if (!this.characterId || !this.currentZoneId) return;
      await this.routeToZone('interact', data);
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
  private async routeToZone(event: string, data: unknown): Promise<void> {
    if (!this.currentZoneId || !this.characterId) return;

    const channel = `zone:${this.currentZoneId}:input`;

    let messageType: MessageType;
    switch (event) {
      case 'move':
        messageType = MessageType.PLAYER_MOVE;
        const moveData = data as MoveMessage['payload'];

        if (!moveData.position) {
          logger.warn({ characterId: this.characterId }, 'Movement request missing position');
          return;
        }

        // Update position in database
        await CharacterService.updatePosition(this.characterId, {
          x: moveData.position.x,
          y: moveData.position.y,
          z: moveData.position.z,
          heading: moveData.heading !== undefined ? moveData.heading : undefined,
        });

        await this.messageBus.publish(channel, {
          type: messageType,
          zoneId: this.currentZoneId,
          characterId: this.characterId,
          socketId: this.socket.id,
          payload: {
            characterId: this.characterId,
            zoneId: this.currentZoneId,
            position: moveData.position,
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

      default:
        logger.warn({ event }, 'Unhandled game event for routing');
    }
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
          await this.authenticateCredentials(data.username!, data.password!);
          break;
        case 'token':
          await this.authenticateToken(data.token!);
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
    const account = await AccountService.createGuestAccount(guestName);

    this.authenticated = true;
    this.accountId = account.id;

    const characters = await CharacterService.findByAccountId(account.id);

    const response: AuthSuccessMessage['payload'] = {
      accountId: account.id,
      token: 'guest-token',
      characters: characters.map(char => ({
        id: char.id,
        name: char.name,
        level: char.level,
        lastPlayed: char.lastSeenAt.getTime(),
        location: 'Unknown',
      })),
      canCreateCharacter: true,
      maxCharacters: 1,
    };

    this.socket.emit('auth_success', response);
    logger.info(`Guest authenticated: ${this.socket.id} as ${guestName} (Account: ${account.id})`);
  }

  private async authenticateCredentials(_username: string, _password: string): Promise<void> {
    logger.warn('Credential authentication not fully implemented, using mock data');

    this.authenticated = true;
    this.accountId = 'mock-account-id';

    const response: AuthSuccessMessage['payload'] = {
      accountId: this.accountId,
      token: 'mock-jwt-token',
      characters: [
        {
          id: 'char-1',
          name: 'Test Character',
          level: 1,
          lastPlayed: Date.now() - 86400000,
          location: 'The Crossroads',
        },
      ],
      canCreateCharacter: true,
      maxCharacters: 5,
    };

    this.socket.emit('auth_success', response);
    logger.info(`Credentials authenticated: ${this.socket.id} for account ${this.accountId}`);
  }

  private async authenticateToken(_token: string): Promise<void> {
    logger.warn('Token authentication not fully implemented');
    throw new Error('Token authentication not yet implemented');
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
    logger.info(`Character create for ${this.socket.id}: ${data.name}`);

    if (!this.accountId) {
      this.sendError('NOT_AUTHENTICATED', 'Must be authenticated to create character');
      return;
    }

    const starterZoneId = 'zone-crossroads';
    const character = await CharacterService.createCharacter({
      accountId: this.accountId,
      name: data.name,
      zoneId: starterZoneId,
      positionX: 100,
      positionY: 0,
      positionZ: 100,
    });

    this.characterId = character.id;
    logger.info(`Created character: ${character.name} (ID: ${character.id})`);

    await this.enterWorld();
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

    const coreStats = {
      strength: character.strength,
      vitality: character.vitality,
      dexterity: character.dexterity,
      agility: character.agility,
      intelligence: character.intelligence,
      wisdom: character.wisdom,
    };

    const derivedStats = StatCalculator.calculateDerivedStats(coreStats, character.level);

    const companions = await ZoneService.getCompanionsInZone(zone.id);

    const entities = companions.map(companion => ({
      id: companion.id,
      type: 'npc' as const,
      name: companion.name,
      position: { x: companion.positionX, y: companion.positionY, z: companion.positionZ },
      description: companion.description || '',
      interactive: true,
    }));

    const worldEntry: WorldEntryMessage['payload'] = {
      characterId: character.id,
      timestamp: Date.now(),
      character: {
        id: character.id,
        name: character.name,
        level: character.level,
        experience: character.experience,
        abilityPoints: character.abilityPoints,
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
      payload: { character, socketId: this.socket.id },
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

  async disconnect(): Promise<void> {
    this.socket.disconnect(true);
  }

  async cleanup(): Promise<void> {
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

    this.authenticated = false;
    this.characterId = null;
    this.accountId = null;
    this.currentZoneId = null;
    this.clientInfo = null;
  }

  updatePing(): void {
    this.lastPingTime = Date.now();
  }

  getLastPingTime(): number {
    return this.lastPingTime;
  }
}
