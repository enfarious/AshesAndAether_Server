import { Socket } from 'socket.io';
import bcrypt from 'bcryptjs';
import { logger } from '@/utils/logger';
import { AccountService, CharacterService, ZoneService } from '@/database';
import { StatCalculator } from '@/game/stats/StatCalculator';
import { PhysicsSystem } from '@/physics/PhysicsSystem';
import { SpawnPointService } from '@/world/SpawnPointService';
import { WorldManager } from '@/world/WorldManager';
import {
  ClientType,
  ClientCapabilities,
  AuthMessage,
  AuthSuccessMessage,
  AuthErrorMessage,
  CharacterSelectMessage,
  CharacterCreateMessage,
  CharacterDeleteMessage,
  CharacterUpdateMessage,
  CharacterListRequestMessage,
  CharacterListMessage,
  CharacterRosterDeltaMessage,
  CharacterErrorMessage,
  WorldEntryMessage,
  MoveMessage,
  ChatMessage,
  InteractMessage,
  CombatActionMessage,
  MovementSpeed,
} from './protocol/types';
import type { Character } from '@prisma/client';

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
  private maxCharacters: number = 0;

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

    this.socket.on('character_delete', (data: CharacterDeleteMessage['payload']) => {
      if (!this.authenticated) {
        this.sendError('NOT_AUTHENTICATED', 'Must authenticate before deleting character');
        return;
      }
      this.handleCharacterDelete(data);
    });

    this.socket.on('character_update', (data: CharacterUpdateMessage['payload']) => {
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
    this.maxCharacters = 1;

    // Get existing characters (should be empty for new guest)
    const characters = await CharacterService.findByAccountId(account.id);

    const characterSummaries = await Promise.all(
      characters.map(char => this.buildCharacterInfo(char))
    );

    const response: AuthSuccessMessage['payload'] = {
      accountId: account.id,
      token: 'guest-token', // No real token for guests
      characters: characterSummaries,
      canCreateCharacter: true,
      maxCharacters: this.maxCharacters, // Guests can only have one character
    };

    this.socket.emit('auth_success', response);
    logger.info(`Guest authenticated: ${this.socket.id} as ${guestName} (Account: ${account.id})`);
  }

  private async authenticateCredentials(identifier: string, password: string): Promise<void> {
    // Find account by email or username
    let account = await AccountService.findByEmail(identifier);
    if (!account) {
      account = await AccountService.findByUsername(identifier);
    }

    if (!account) {
      throw new Error('Invalid credentials');
    }

    // Verify password
    const passwordValid = await bcrypt.compare(password, account.passwordHash);
    if (!passwordValid) {
      throw new Error('Invalid credentials');
    }

    // Load characters
    const characters = await CharacterService.findByAccountId(account.id);
    const characterInfos: CharacterInfo[] = characters.map(char => ({
      id: char.id,
      name: char.name,
      level: char.level,
      lastPlayed: char.updatedAt.getTime(),
      location: char.zoneId,
    }));

    this.authenticated = true;
    this.accountId = account.id;
    this.maxCharacters = 10; // TODO: Make configurable

    const response: AuthSuccessMessage['payload'] = {
      accountId: this.accountId,
      token: 'jwt-token-todo', // TODO: Generate actual JWT
      characters: characterInfos,
      canCreateCharacter: characters.length < this.maxCharacters,
      maxCharacters: this.maxCharacters,
    };

    this.socket.emit('auth_success', response);
    logger.info(`Credentials authenticated: ${this.socket.id} for account ${this.accountId} (${account.email})`);
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

    const name = (data.name || '').trim();
    if (!name) {
      this.sendCharacterError('INVALID_NAME', 'Character name is required', 'create');
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

    const cosmetics = data.appearance ? { appearance: data.appearance } : undefined;
    
    // Create character in starter zone with proper spawn point
    const starterZoneId = 'USA_NY_Stephentown';
    const spawn = SpawnPointService.getStarterSpawn(starterZoneId);
    
    if (!spawn) {
      this.sendCharacterError('SERVER_ERROR', 'No spawn point available', 'create');
      return;
    }
    
    const character = await CharacterService.createCharacter({
      accountId: this.accountId,
      name,
      zoneId: starterZoneId,
      positionX: spawn.position.x,
      positionY: spawn.position.y,
      positionZ: spawn.position.z,
      cosmetics,
    });

    this.characterId = character.id;
    logger.info(`Created character: ${character.name} (ID: ${character.id})`);

    await this.sendCharacterRosterDelta({
      added: [await this.buildCharacterInfo(character)],
      ...this.buildRosterLimits(characters.length + 1),
    });

    // Send world entry message
    await this.enterWorld();
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

    // Load character with zone data from database
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
    // Give any pending database operations a chance to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Save character position before cleanup (for respawn on next login)
    if (this.characterId) {
      const character = await CharacterService.findById(this.characterId);
      if (character) {
        await CharacterService.updatePosition(this.characterId, {
          x: character.positionX,
          y: character.positionY,
          z: character.positionZ,
          saveLastPosition: true, // Save as lastPosition for respawn recovery
        });
      }
    }

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
