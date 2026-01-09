import { Socket } from 'socket.io';
import { logger } from '@/utils/logger';
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
} from './protocol/types';

interface ClientInfo {
  type: ClientType;
  version: string;
  capabilities: ClientCapabilities;
}

/**
 * Represents a single client connection session
 */
export class ClientSession {
  private authenticated: boolean = false;
  private characterId: string | null = null;
  private accountId: string | null = null;
  private lastPingTime: number = Date.now();
  private clientInfo: ClientInfo | null = null;

  constructor(private socket: Socket) {
    this.setupMessageHandlers();
  }

  private setupMessageHandlers(): void {
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

    // Movement
    this.socket.on('move', (data: MoveMessage['payload']) => {
      if (!this.characterId) return;
      logger.debug({ data }, `Move request from ${this.socket.id}`);
      // TODO: Handle movement
    });

    // Chat
    this.socket.on('chat', (data: ChatMessage['payload']) => {
      if (!this.characterId) return;
      logger.debug({ data }, `Chat message from ${this.socket.id}`);
      // TODO: Handle chat
    });

    // Combat actions
    this.socket.on('combat_action', (data: CombatActionMessage['payload']) => {
      if (!this.characterId) return;
      logger.debug({ data }, `Combat action from ${this.socket.id}`);
      // TODO: Handle combat action
    });

    // Interaction
    this.socket.on('interact', (data: InteractMessage['payload']) => {
      if (!this.characterId) return;
      logger.debug({ data }, `Interaction from ${this.socket.id}`);
      // TODO: Handle interaction
    });
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
    // TODO: Implement proper guest account creation
    // For now, create temporary guest account
    this.authenticated = true;
    this.accountId = `guest-${this.socket.id}`;

    const response: AuthSuccessMessage['payload'] = {
      accountId: this.accountId,
      token: 'guest-token', // No real token for guests
      characters: [], // Guests start with no characters
      canCreateCharacter: true,
      maxCharacters: 1, // Guests can only have one character
    };

    this.socket.emit('auth_success', response);
    logger.info(`Guest authenticated: ${this.socket.id} as ${guestName}`);
  }

  private async authenticateCredentials(_username: string, _password: string): Promise<void> {
    // TODO: Implement proper credential authentication with database
    // For now, mock authentication
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
    // TODO: Implement JWT token validation
    logger.warn('Token authentication not fully implemented');
    throw new Error('Token authentication not yet implemented');
  }

  private async handleCharacterSelect(data: CharacterSelectMessage['payload']): Promise<void> {
    logger.info(`Character select for ${this.socket.id}: ${data.characterId}`);

    // TODO: Load character from database
    // For now, mock character data
    this.characterId = data.characterId;

    // Send world entry message
    await this.enterWorld();
  }

  private async handleCharacterCreate(data: CharacterCreateMessage['payload']): Promise<void> {
    logger.info(`Character create for ${this.socket.id}: ${data.name}`);

    // TODO: Create character in database
    // For now, mock character creation
    this.characterId = `char-${Date.now()}`;

    // Send world entry message
    await this.enterWorld();
  }

  private async enterWorld(): Promise<void> {
    if (!this.characterId) {
      this.sendError('NO_CHARACTER', 'No character selected');
      return;
    }

    logger.info(`Character ${this.characterId} entering world`);

    // TODO: Load actual world state from database/world manager
    // For now, send mock world entry data
    const worldEntry: WorldEntryMessage['payload'] = {
      characterId: this.characterId,
      timestamp: Date.now(),
      character: {
        id: this.characterId,
        name: 'Test Character',
        position: { x: 100, y: 0, z: 250 },
        heading: 0,  // Facing north
        rotation: { x: 0, y: 0, z: 0 },
        health: { current: 100, max: 100 },
        stamina: { current: 100, max: 100 },
        stats: {
          strength: 10,
          agility: 10,
          intelligence: 10,
        },
        currentSpeed: 'stop',  // Not moving initially
      },
      zone: {
        id: 'zone-crossroads',
        name: 'The Crossroads',
        description:
          'A weathered crossroads where five ancient paths converge. Moss-covered stones mark each direction, their inscriptions long faded. A sense of anticipation hangs in the air.',
        weather: 'clear',
        timeOfDay: 'dusk',
        lighting: 'dim',
        contentRating: 'T',  // Teen - public area with fantasy combat
      },
      entities: [
        {
          id: 'npc-merchant-1',
          type: 'npc',
          name: 'Old Merchant',
          position: { x: 102, y: 0, z: 248 },
          description: 'A weathered merchant with kind eyes, tending a small cart.',
          interactive: true,
        },
      ],
      exits: [
        {
          direction: 'north',
          name: 'Forest Path',
          description: 'A dark trail leading into dense woods.',
        },
        {
          direction: 'south',
          name: "King's Road",
          description: 'A well-maintained road toward civilization.',
        },
        {
          direction: 'east',
          name: 'Mountain Pass',
          description: 'A steep rocky path ascending into the peaks.',
        },
      ],
    };

    this.socket.emit('world_entry', worldEntry);
    logger.info(`World entry sent for character ${this.characterId}`);
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

  cleanup(): void {
    // Cleanup any resources
    this.authenticated = false;
    this.characterId = null;
    this.accountId = null;
    this.clientInfo = null;
  }

  updatePing(): void {
    this.lastPingTime = Date.now();
  }

  getLastPingTime(): number {
    return this.lastPingTime;
  }
}
