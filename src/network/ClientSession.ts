import { Socket } from 'socket.io';
import { logger } from '@/utils/logger';
import { AccountService, CharacterService, ZoneService } from '@/database';
import { StatCalculator } from '@/game/stats/StatCalculator';
import { WorldManager } from '@/world/WorldManager';
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
  MovementSpeed,
} from './protocol/types';

interface ClientInfo {
  type: ClientType;
  version: string;
  capabilities: ClientCapabilities;
  isMachine: boolean;
}

/**
 * Represents a single client connection session
 */
export class ClientSession {
  private authenticated: boolean = false;
  private characterId: string | null = null;
  private accountId: string | null = null;
  private currentZoneId: string | null = null;
  private lastPingTime: number = Date.now();
  private clientInfo: ClientInfo | null = null;

  constructor(
    private socket: Socket,
    private worldManager: WorldManager
  ) {
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

    // Movement (tick-based, server-authoritative)
    this.socket.on('move', async (data: MoveMessage['payload']) => {
      if (!this.characterId || !this.currentZoneId) return;
      await this.handleMovement(data);
    });

    // Teleport (direct position update, admin/debug)
    this.socket.on('teleport', async (data: { position: { x: number; y: number; z: number }; heading?: number }) => {
      if (!this.characterId || !this.currentZoneId) return;
      await this.handleTeleport(data);
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
    // Create guest account in database
    const account = await AccountService.createGuestAccount(guestName);

    this.authenticated = true;
    this.accountId = account.id;

    // Get existing characters (should be empty for new guest)
    const characters = await CharacterService.findByAccountId(account.id);

    const response: AuthSuccessMessage['payload'] = {
      accountId: account.id,
      token: 'guest-token', // No real token for guests
      characters: characters.map(char => ({
        id: char.id,
        name: char.name,
        level: char.level,
        lastPlayed: char.lastSeenAt.getTime(),
        location: 'Unknown', // TODO: Get zone name
      })),
      canCreateCharacter: true,
      maxCharacters: 1, // Guests can only have one character
    };

    this.socket.emit('auth_success', response);
    logger.info(`Guest authenticated: ${this.socket.id} as ${guestName} (Account: ${account.id})`);
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

    // Verify character belongs to this account
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

    // Update last seen
    await CharacterService.updateLastSeen(character.id);

    // Send world entry message
    await this.enterWorld();
  }

  private async handleCharacterCreate(data: CharacterCreateMessage['payload']): Promise<void> {
    logger.info(`Character create for ${this.socket.id}: ${data.name}`);

    if (!this.accountId) {
      this.sendError('NOT_AUTHENTICATED', 'Must be authenticated to create character');
      return;
    }

    // Create character in starter zone (The Crossroads)
    const starterZoneId = 'USA_NY_Stephentown';
    const character = await CharacterService.createCharacter({
      accountId: this.accountId,
      name: data.name,
      zoneId: starterZoneId,
      positionX: 100, // Center of The Crossroads
      positionY: 0,
      positionZ: 100,
    });

    this.characterId = character.id;
    logger.info(`Created character: ${character.name} (ID: ${character.id})`);

    // Send world entry message
    await this.enterWorld();
  }

  private async enterWorld(): Promise<void> {
    if (!this.characterId) {
      this.sendError('NO_CHARACTER', 'No character selected');
      return;
    }

    logger.info(`Character ${this.characterId} entering world`);

    // Load character with zone data from database
    const character = await CharacterService.findByIdWithZone(this.characterId);

    if (!character) {
      this.sendError('CHARACTER_NOT_FOUND', 'Character data not found');
      return;
    }

    const zone = character.zone;

    // Calculate derived stats
    const coreStats = {
      strength: character.strength,
      vitality: character.vitality,
      dexterity: character.dexterity,
      agility: character.agility,
      intelligence: character.intelligence,
      wisdom: character.wisdom,
    };

    const derivedStats = StatCalculator.calculateDerivedStats(coreStats, character.level);

    // Get companions (NPCs) in the zone
    const companions = await ZoneService.getCompanionsInZone(zone.id);

    // Build entity list
    const entities = companions
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

        // Position
        position: { x: character.positionX, y: character.positionY, z: character.positionZ },
        heading: character.heading,
        rotation: { x: 0, y: character.heading, z: 0 },
        currentSpeed: 'stop',

        // Stats
        coreStats,
        derivedStats,

        // Current Resources
        health: { current: character.currentHp, max: character.maxHp },
        stamina: { current: character.currentStamina, max: character.maxStamina },
        mana: { current: character.currentMana, max: character.maxMana },

        // Progression
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
        weather: 'clear', // TODO: Dynamic weather system
        timeOfDay: 'dusk', // TODO: Dynamic time of day
        lighting: 'dim', // TODO: Calculate based on time
        contentRating: zone.contentRating as 'T' | 'M' | 'AO',
      },
      entities,
      exits: [], // TODO: Generate exits from navmesh or zone connections
    };

    this.socket.emit('world_entry', worldEntry);
    logger.info(`World entry sent for character ${character.name} in ${zone.name}`);

    // Register player with WorldManager
    this.currentZoneId = zone.id;
    await this.worldManager.addPlayerToZone(
      character,
      this.socket.id,
      this.clientInfo?.isMachine === true
    );
  }

  private async handleMovement(data: MoveMessage['payload']): Promise<void> {
    if (!this.characterId || !this.currentZoneId) return;

    const { method, position, heading, speed } = data;

    // Get current character position from database for movement start
    const character = await CharacterService.findById(this.characterId);
    if (!character) {
      logger.warn({ characterId: this.characterId }, 'Character not found for movement');
      return;
    }

    const startPosition = {
      x: character.positionX,
      y: character.positionY,
      z: character.positionZ,
    };

    // Determine movement speed (default to walk)
    const movementSpeed: MovementSpeed = speed || 'walk';

    // Handle stop
    if (movementSpeed === 'stop') {
      this.worldManager.stopMovement(this.characterId, this.currentZoneId);
      this.socket.emit('dev_ack', { status: 'ok', message: 'Movement stopped' });
      logger.debug({ characterId: this.characterId }, 'Player stopped');
      return;
    }

    // Route based on method
    if (method === 'position' && position) {
      // Position-based movement: route to MovementSystem for tick-based pathing
      const started = await this.worldManager.startMovement(
        this.characterId,
        this.currentZoneId,
        startPosition,
        {
          speed: movementSpeed,
          targetPosition: { x: position.x, y: position.y, z: position.z },
          targetRange: 0.5, // Stop within 0.5m of target
        }
      );

      if (started) {
        this.socket.emit('dev_ack', { status: 'ok', message: 'Moving to position' });
        logger.debug({ characterId: this.characterId, targetPosition: position, speed: movementSpeed }, 'Player movement started (position)');
      } else {
        this.socket.emit('dev_ack', { status: 'error', message: 'Failed to start movement' });
      }
    } else if (method === 'heading' && heading !== undefined) {
      // Heading-based movement: route to MovementSystem
      const started = await this.worldManager.startMovement(
        this.characterId,
        this.currentZoneId,
        startPosition,
        {
          heading,
          speed: movementSpeed,
        }
      );

      if (started) {
        this.socket.emit('dev_ack', { status: 'ok', message: 'Moving by heading' });
        logger.debug({ characterId: this.characterId, heading, speed: movementSpeed }, 'Player movement started (heading)');
      } else {
        this.socket.emit('dev_ack', { status: 'error', message: 'Failed to start movement' });
      }
    } else {
      logger.warn({ characterId: this.characterId, method }, 'Invalid movement request');
      this.socket.emit('dev_ack', { status: 'error', message: 'Invalid movement request' });
    }
  }

  private async handleTeleport(data: { position: { x: number; y: number; z: number }; heading?: number }): Promise<void> {
    if (!this.characterId || !this.currentZoneId) return;

    const { position, heading } = data;

    if (!position) {
      logger.warn({ characterId: this.characterId }, 'Teleport request missing position');
      return;
    }

    // Stop any active movement first
    this.worldManager.stopMovement(this.characterId, this.currentZoneId);

    // Update position in database
    await CharacterService.updatePosition(this.characterId, {
      x: position.x,
      y: position.y,
      z: position.z,
      heading: heading !== undefined ? heading : undefined,
    });

    // Update position in WorldManager (triggers state_update broadcast)
    await this.worldManager.updatePlayerPosition(
      this.characterId,
      this.currentZoneId,
      position
    );

    this.socket.emit('dev_ack', { status: 'ok', message: 'Teleported' });
    logger.debug({
      characterId: this.characterId,
      position,
      heading,
    }, 'Player teleported');
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
    // Remove player from world manager
    if (this.characterId && this.currentZoneId) {
      await this.worldManager.removePlayerFromZone(this.characterId, this.currentZoneId);
    }

    // Cleanup any resources
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
