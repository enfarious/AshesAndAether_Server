import { logger } from '@/utils/logger';
import { CharacterService, CompanionService, MobService, ZoneService } from '@/database';
import { ZoneManager } from './ZoneManager';
import { MovementSystem, type MovementStartEvent } from './MovementSystem';
import { MessageBus, MessageType, ZoneRegistry, type MessageEnvelope, type ClientMessagePayload } from '@/messaging';
import { NPCAIController, LLMService } from '@/ai';
import { CommandRegistry, CommandParser, CommandExecutor, registerAllCommands } from '@/commands';
import type { CommandContext, CommandEvent } from '@/commands/types';
import type { Character, Companion } from '@prisma/client';
import { StatCalculator } from '@/game/stats/StatCalculator';
import { CombatManager } from '@/combat/CombatManager';
import { AbilitySystem } from '@/combat/AbilitySystem';
import { DamageCalculator } from '@/combat/DamageCalculator';
import { buildCombatNarrative } from '@/combat/CombatNarratives';
import type { CombatAbilityDefinition, CombatStats, DamageProfileSegment, PhysicalDamageType } from '@/combat/types';
import type { DamageType } from '@/game/abilities/AbilityTypes';
import type { MovementSpeed, Vector3 } from '@/network/protocol/types';
import { WildlifeManager, type BiomeType } from '@/wildlife';
import { PartyService } from '@/party/PartyService';
import { buildDamageProfiles, getPrimaryDamageType, getPrimaryPhysicalType, getWeaponDefinition } from '@/items/WeaponData';
import { buildQualityBiasMultipliers, type QualityBiasMultipliers } from '@/items/ArmorData';
import {
  CorruptionSystem,
  getCorruptionConfig,
  getCorruptionBenefits,
  type CorruptionState,
  type ZoneCorruptionData,
} from '@/corruption';
import { MarketBridge } from '@/market/MarketBridge';

const FEET_TO_METERS = 0.3048;
const COMBAT_EVENT_RANGE_METERS = 45.72; // 150 feet

const BIOME_FALLBACK: BiomeType = 'forest';
const PARTY_MAX_MEMBERS = 5;
const PARTY_STATUS_INTERVAL_MS = 1000;

/**
 * Distributed World Manager - manages zones across multiple servers
 *
 * This version uses Redis pub/sub for inter-server communication
 * instead of direct Socket.IO access
 */
export class DistributedWorldManager {
  private zones: Map<string, ZoneManager> = new Map();
  private characterToZone: Map<string, string> = new Map();
  private companionToZone: Map<string, string> = new Map();
  private npcControllers: Map<string, NPCAIController> = new Map(); // companionId -> controller
  private llmService: LLMService;
  private recentChatMessages: Map<string, { sender: string; channel: string; message: string; timestamp: number }[]> = new Map(); // zoneId -> messages
  private proximityRosterHashes: Map<string, string> = new Map(); // characterId -> roster hash (for dirty checking - legacy)
  private previousRosters: Map<string, any> = new Map(); // characterId -> previous roster (for delta calculation)
  private combatManager: CombatManager;
  private abilitySystem: AbilitySystem;
  private damageCalculator: DamageCalculator;
  private respawnTimers: Map<string, NodeJS.Timeout> = new Map();
  private movementSystem: MovementSystem;
  private attackSpeedBonusCache: Map<string, number> = new Map();
  private wildlifeManagers: Map<string, WildlifeManager> = new Map();
  private partyService: PartyService;
  private partyResourceCache: Map<string, { currentStamina: number; maxStamina: number; currentMana: number; maxMana: number }> = new Map();
  private lastPartyStatusBroadcastAt: number = 0;

  // Corruption system
  private corruptionSystem: CorruptionSystem;
  private zoneCorruptionTags: Map<string, string> = new Map(); // zoneId -> corruptionTag

  // Market system
  private marketBridge: MarketBridge;

  // Command system
  private commandRegistry: CommandRegistry;
  private commandParser: CommandParser;
  private commandExecutor: CommandExecutor | null = null;

  constructor(
    private messageBus: MessageBus,
    private zoneRegistry: ZoneRegistry,
    private serverId: string,
    private assignedZoneIds: string[] = [] // Zones this server should manage
  ) {
    this.llmService = new LLMService();
    this.combatManager = new CombatManager();
    this.abilitySystem = new AbilitySystem();
    this.damageCalculator = new DamageCalculator();
    this.movementSystem = new MovementSystem();
    this.partyService = new PartyService(this.messageBus.getRedisClient());

    // Set up movement completion callback
    this.movementSystem.setMovementCompleteCallback(
      (characterId, reason, finalPosition) => this.onMovementComplete(characterId, reason, finalPosition)
    );

    // Initialize corruption system
    this.corruptionSystem = new CorruptionSystem();

    // Initialize market bridge
    this.marketBridge = new MarketBridge(this.messageBus);
    this.corruptionSystem.setBroadcastCallback(
      (characterId, corruption, state, previousState, delta) =>
        this.broadcastCorruptionUpdate(characterId, corruption, state, previousState, delta)
    );
    this.corruptionSystem.setCommunityCheckCallback(
      (characterId, zoneId) => this.isCharacterInCommunity(characterId, zoneId)
    );
    this.corruptionSystem.setPartySizeCallback(
      (characterId) => this.getCharacterPartySize(characterId)
    );

    // Initialize command system
    this.commandRegistry = new CommandRegistry();
    this.commandParser = new CommandParser();
    registerAllCommands(this.commandRegistry);

    logger.info({ commandCount: this.commandRegistry.getCount() }, 'Command system initialized');
  }

  /**
   * Initialize world manager - load assigned zones
   */
  async initialize(): Promise<void> {
    logger.info({ serverId: this.serverId, zoneCount: this.assignedZoneIds.length }, 'Initializing distributed world manager');

    // If no zones assigned, load all zones (for single-server mode)
    if (this.assignedZoneIds.length === 0) {
      const allZones = await ZoneService.findAll();
      this.assignedZoneIds = allZones.map(z => z.id);
      logger.info('No zone assignment specified - loading all zones (single-server mode)');
    }

    // Load and initialize assigned zones
    for (const zoneId of this.assignedZoneIds) {
      const zone = await ZoneService.findById(zoneId);
      if (!zone) {
        logger.warn({ zoneId }, 'Assigned zone not found in database');
        continue;
      }

      const zoneManager = new ZoneManager(zone);
      await zoneManager.initialize();
      this.zones.set(zone.id, zoneManager);

      // Cache zone corruption tag
      this.zoneCorruptionTags.set(zone.id, (zone as any).corruptionTag || 'WILDS');

      // Register with movement system for entity lookups
      this.movementSystem.registerZoneManager(zone.id, zoneManager);

      // Initialize wildlife manager for this zone
      const biomeType = this.resolveBiomeType(zone.terrainType);
      const wildlifeManager = new WildlifeManager(zone.id, biomeType);
      wildlifeManager.setCallbacks({
        onEntitySpawn: (entity) => {
          zoneManager.addWildlife({
            id: entity.id,
            name: entity.name,
            speciesId: entity.speciesId,
            position: entity.position,
            sprite: entity.speciesId,
            heading: entity.heading,
          });
          void this.broadcastNearbyUpdate(zone.id);
        },
        onEntityUpdate: (entity) => {
          zoneManager.updateWildlife(
            entity.id,
            entity.position,
            entity.heading,
            entity.currentBehavior
          );
          void this.broadcastNearbyUpdate(zone.id);
        },
        onEntityDeath: (entity) => {
          zoneManager.removeWildlife(entity.id);
          void this.broadcastNearbyUpdate(zone.id);
        },
      });
      wildlifeManager.setDataProviders({
        getPlayersInRange: (position, range) => zoneManager.getPlayerPositions()
          .filter(player => {
            const dx = player.position.x - position.x;
            const dy = player.position.y - position.y;
            const dz = player.position.z - position.z;
            return Math.sqrt(dx * dx + dy * dy + dz * dz) <= range;
          }),
        getTimeOfDay: () => 12,
      });
      this.wildlifeManagers.set(zone.id, wildlifeManager);

      // Initialize NPC AI controllers for this zone
      await this.initializeNPCsForZone(zoneId);

      // Register zone in registry
      await this.zoneRegistry.assignZone(zoneId, this.serverId);
    }

    // Subscribe to zone input messages
    await this.subscribeToZoneMessages();

    // Initialize command executor (needs Redis from MessageBus)
    this.commandExecutor = new CommandExecutor(
      this.commandRegistry,
      this.commandParser,
      this.messageBus.getRedisClient()
    );

    // Start market bridge for market commands
    await this.marketBridge.start();

    logger.info(
      {
        zoneCount: this.zones.size,
        npcCount: this.npcControllers.size,
        commandCount: this.commandRegistry.getCount(),
      },
      'Distributed world manager initialized'
    );
  }

  /**
   * Initialize NPC AI controllers for a zone
   */
  private async initializeNPCsForZone(zoneId: string): Promise<void> {
    const companions = await ZoneService.getCompanionsInZone(zoneId);

    for (const companion of companions) {
      const controller = new NPCAIController(companion);
      this.npcControllers.set(companion.id, controller);
      logger.debug({ companionId: companion.id, name: companion.name, zone: zoneId }, 'NPC AI controller initialized');
    }
  }

  /**
   * Subscribe to Redis channels for zone events
   */
  private async subscribeToZoneMessages(): Promise<void> {
    // Subscribe to all zones this server manages
    for (const zoneId of this.zones.keys()) {
      const channel = `zone:${zoneId}:input`;
      await this.messageBus.subscribe(channel, (message) => this.handleZoneMessage(message));
    }

    logger.info({ zones: Array.from(this.zones.keys()) }, 'Subscribed to zone input channels');
  }

  /**
   * Handle incoming zone message from Redis
   */
  private handleZoneMessage(message: MessageEnvelope): void {
    switch (message.type) {
      case MessageType.PLAYER_JOIN_ZONE:
        this.handlePlayerJoinZone(message);
        break;
      case MessageType.PLAYER_LEAVE_ZONE:
        this.handlePlayerLeaveZone(message);
        break;
      case MessageType.PLAYER_MOVE:
        this.handlePlayerMove(message);
        break;
      case MessageType.PLAYER_CHAT:
        this.handlePlayerChat(message);
        break;
      case MessageType.PLAYER_COMBAT_ACTION:
        this.handlePlayerCombatAction(message);
        break;
      case MessageType.PLAYER_COMMAND:
        this.handlePlayerCommand(message);
        break;
      case MessageType.PLAYER_PROXIMITY_REFRESH:
        this.handlePlayerProximityRefresh(message);
        break;
      case MessageType.NPC_INHABIT:
        this.handleNpcInhabit(message);
        break;
      case MessageType.NPC_RELEASE:
        this.handleNpcRelease(message);
        break;
      case MessageType.NPC_CHAT:
        this.handleNpcChat(message);
        break;
      default:
        logger.warn({ type: message.type }, 'Unhandled message type');
    }
  }

  /**
   * Handle player joining a zone
   */
  private async handlePlayerJoinZone(message: MessageEnvelope): Promise<void> {
    const { character, socketId, isMachine } = message.payload as {
      character: Character;
      socketId: string;
      isMachine?: boolean;
    };
    const zoneManager = this.zones.get(character.zoneId);

    if (!zoneManager) {
      logger.error({ characterId: character.id, zoneId: character.zoneId }, 'Cannot add player - zone not managed by this server');
      return null;
    }

    zoneManager.addPlayer(character, socketId, isMachine ?? false);
    this.characterToZone.set(character.id, character.zoneId);
    this.partyResourceCache.set(character.id, {
      currentStamina: character.currentStamina,
      maxStamina: character.maxStamina,
      currentMana: character.currentMana,
      maxMana: character.maxMana,
    });

    // Update player location in registry
    await this.zoneRegistry.updatePlayerLocation(character.id, character.zoneId, socketId);

    // Send a full state snapshot to the joining player for resync
    await this.sendFullCharacterState(zoneManager, character, socketId);

    // Send party roster on zone entry to refresh client-side state
    const partyId = await this.partyService.getPartyIdForMember(character.id);
    if (partyId) {
      await this.sendPartyRosterToMember(partyId, character.id);
    }

    // Clear any stale roster baseline and send a full proximity roster on entry
    this.previousRosters.delete(character.id);
    await this.sendFullProximityRosterToEntity(character.id);

    // Broadcast proximity updates to nearby players
    await this.broadcastNearbyUpdate(character.zoneId);

    logger.info({ characterId: character.id, zoneId: character.zoneId }, 'Player joined zone');
  }

  /**
   * Handle player leaving a zone
   */
  private async handlePlayerLeaveZone(message: MessageEnvelope): Promise<void> {
    const { characterId, zoneId } = message.payload as { characterId: string; zoneId: string };
    const zoneManager = this.zones.get(zoneId);

    if (!zoneManager) return;

    // Stop any active movement
    if (this.movementSystem.isMoving(characterId)) {
      this.movementSystem.stopMovement({ characterId, zoneId });
    }

    zoneManager.removePlayer(characterId);
    this.characterToZone.delete(characterId);

    // Clean up proximity roster data
    this.proximityRosterHashes.delete(characterId);
    this.previousRosters.delete(characterId);
    this.attackSpeedBonusCache.delete(characterId);

    // Clean up corruption tracking
    this.corruptionSystem.removeCharacter(characterId);
    this.partyResourceCache.delete(characterId);

    // Remove from registry
    await this.zoneRegistry.removePlayer(characterId);

    // Broadcast proximity updates
    await this.broadcastNearbyUpdate(zoneId);

    logger.info({ characterId, zoneId }, 'Player left zone');
  }

  /**
   * Handle player movement
   */
  private async handlePlayerMove(message: MessageEnvelope): Promise<void> {
    const { characterId, zoneId, method, position, heading, speed } = message.payload as {
      characterId: string;
      zoneId: string;
      method?: 'position' | 'heading' | 'compass';
      position?: { x: number; y: number; z: number };
      heading?: number;
      speed?: MovementSpeed;
    };

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    // Handle stop
    if (speed === 'stop') {
      this.movementSystem.stopMovement({ characterId, zoneId });
      logger.debug({ characterId }, 'Player stopped');
      return null;
    }

    // Get current position from zone manager or database
    const entity = zoneManager.getEntity(characterId);
    if (!entity) {
      logger.warn({ characterId, zoneId }, 'Entity not found for movement');
      return null;
    }

    const startPosition = entity.position;
    const movementSpeed: MovementSpeed = speed || 'walk';

    // Route based on method
    if (method === 'position' && position) {
      // Position-based movement: move toward target coordinates
      const started = await this.movementSystem.startMovement({
        characterId,
        zoneId,
        startPosition,
        speed: movementSpeed,
        targetPosition: { x: position.x, y: position.y, z: position.z },
        targetRange: 0.5, // Stop within 0.5m of target
      });

      if (started) {
        logger.debug({ characterId, targetPosition: position, speed: movementSpeed }, 'Player movement started (position)');
      }
    } else if (method === 'heading' && heading !== undefined) {
      // Heading-based movement: move in a direction
      const started = await this.movementSystem.startMovement({
        characterId,
        zoneId,
        startPosition,
        heading,
        speed: movementSpeed,
        targetRange: 5,
      });

      if (started) {
        logger.debug({ characterId, heading, speed: movementSpeed }, 'Player movement started (heading)');
      }
    } else if (position) {
      // Legacy: direct position update (teleport) - for backwards compatibility
      zoneManager.updatePlayerPosition(characterId, position);

      // Update database
      await CharacterService.updatePosition(characterId, {
        x: position.x,
        y: position.y,
        z: position.z,
      });

      // Broadcast state_update
      await this.broadcastPositionUpdate(characterId, zoneId, position);

      // Send updated proximity roster to the player
      await this.sendProximityRosterToEntity(characterId);

      // Broadcast to nearby players
      await this.broadcastNearbyUpdate(zoneId);

      logger.debug({ characterId, position }, 'Player teleported (legacy)');
    } else {
      logger.warn({ characterId, method, position, heading }, 'Invalid movement request');
    }
  }

  /**
   * Handle player chat message
   */
  private async handlePlayerChat(message: MessageEnvelope): Promise<void> {
    const { characterId, zoneId, channel, text } = message.payload as {
      characterId: string;
      zoneId: string;
      channel: 'say' | 'shout' | 'emote' | 'cfh' | 'touch';
      text: string;
    };

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    // Get sender character from database
    const { CharacterService } = await import('@/database');
    const sender = await CharacterService.findById(characterId);
    if (!sender) {
      logger.warn({ characterId }, 'Sender character not found for chat');
      return null;
    }

    // Determine range based on channel
    const ranges = {
      touch: 1.524,   // ~5 feet
      say: 6.096,     // 20 feet
      shout: 45.72,   // 150 feet
      emote: 45.72,   // 150 feet
      cfh: 76.2,      // 250 feet
    };

    const range = ranges[channel];
    const senderPosition = {
      x: sender.positionX,
      y: sender.positionY,
      z: sender.positionZ,
    };

    // Get nearby player socket IDs
    const nearbySocketIds = zoneManager.getPlayerSocketIdsInRange(senderPosition, range, characterId);
    const nearbyCompanionSocketIds = zoneManager.getCompanionSocketIdsInRange(senderPosition, range, characterId);

    // Format message based on channel
    let formattedMessage = text;
    if (channel === 'emote') {
      formattedMessage = `${sender.name} ${text}`;
    }

    // Broadcast chat message to nearby players
    for (const socketId of nearbySocketIds) {
      const clientMessage: ClientMessagePayload = {
        socketId,
        event: 'chat',
        data: {
          channel,
          sender: sender.name,
          senderId: characterId,
          message: formattedMessage,
          timestamp: Date.now(),
        },
      };

      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId: '', // Don't know recipient ID from socket ID
        socketId,
        payload: clientMessage,
        timestamp: Date.now(),
      });
    }

    for (const socketId of nearbyCompanionSocketIds) {
      const clientMessage: ClientMessagePayload = {
        socketId,
        event: 'chat',
        data: {
          channel,
          sender: sender.name,
          senderId: characterId,
          message: formattedMessage,
          timestamp: Date.now(),
        },
      };

      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId: '',
        socketId,
        payload: clientMessage,
        timestamp: Date.now(),
      });
    }

    // Track message for NPC AI context
    this.trackChatMessage(zoneId, sender.name, channel, formattedMessage);

    // Trigger NPC responses
    await this.triggerNPCResponses(zoneId, senderPosition, range);

    logger.debug({ characterId, channel, recipientCount: nearbySocketIds.length }, 'Chat message broadcast');
  }

  private async handlePlayerCombatAction(message: MessageEnvelope): Promise<void> {
    const { characterId, zoneId, abilityId, targetId } = message.payload as {
      characterId: string;
      zoneId: string;
      abilityId: string;
      targetId: string;
    };

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const attackerEntity = zoneManager.getEntity(characterId);
    if (!attackerEntity || !attackerEntity.isAlive) return;

    const targetEntity = zoneManager.getEntity(targetId);
    if (!targetEntity || !targetEntity.isAlive) {
      await this.broadcastCombatEvent(zoneId, attackerEntity.position, {
        eventType: 'combat_error',
        timestamp: Date.now(),
        narrative: `Target not found.`,
        eventTypeData: { reason: 'target_not_found', attackerId: characterId },
      });
      return null;
    }

    const ability =
      (await this.abilitySystem.getAbility(abilityId)) || this.abilitySystem.getDefaultAbility();

    logger.debug({ characterId, targetId, abilityId: ability.id }, 'Combat action received');

    await this.executeCombatAction(
      zoneManager,
      attackerEntity,
      targetEntity,
      ability
    );
  }

  private async handlePlayerCommand(message: MessageEnvelope): Promise<void> {
    const { characterId, zoneId, command } = message.payload as {
      characterId: string;
      zoneId: string;
      command: string;
    };

    if (!this.commandExecutor) {
      logger.warn('Command executor not initialized');
      return null;
    }

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const entity = zoneManager.getEntity(characterId);
    if (!entity || !entity.socketId) {
      logger.warn({ characterId, zoneId }, 'Command sender not found in zone');
      return null;
    }

    const character = await CharacterService.findById(characterId);
    if (!character) {
      logger.warn({ characterId }, 'Command sender not found in database');
      return null;
    }

    const context: CommandContext = {
      characterId,
      characterName: character.name,
      accountId: character.accountId,
      zoneId,
      position: entity.position,
      heading: character.heading,
      inCombat: entity.inCombat || false,
      socketId: entity.socketId,
    };

    const result = await this.commandExecutor.execute(command, context);
    const processed = await this.processCommandResult(result, context, zoneManager);

    await this.sendCommandResponse(context.socketId, command, processed);
  }

  private async processCommandResult(
    result: { success: boolean; message?: string; error?: string; data?: any; events?: CommandEvent[] },
    context: CommandContext,
    zoneManager: ZoneManager
  ): Promise<{ success: boolean; message?: string; error?: string; data?: any }> {
    if (!result.success || !result.events || result.events.length === 0) {
      return {
        success: result.success,
        message: result.message,
        error: result.error,
        data: result.data,
      };
    }

    let overrideResponse: { success: boolean; message?: string; error?: string; data?: any } | null = null;

    for (const event of result.events) {
      switch (event.type) {
        case 'speech': {
          const { channel, message, range, position } = event.data as {
            channel: 'say' | 'shout' | 'emote' | 'cfh' | 'touch';
            message: string;
            range: number;
            position: { x: number; y: number; z: number };
          };

          const rangeMeters = range * FEET_TO_METERS;
          await this.broadcastChatFromCharacter(
            zoneManager,
            context.characterId,
            context.characterName,
            position,
            channel,
            message,
            rangeMeters
          );
          break;
        }
        case 'emote': {
          const { action, position, range } = event.data as {
            action: string;
            position: { x: number; y: number; z: number };
            range: number;
          };

          const rangeMeters = range * FEET_TO_METERS;
          const messageText = `${context.characterName} ${action}`;

          await this.broadcastChatFromCharacter(
            zoneManager,
            context.characterId,
            context.characterName,
            position,
            'emote',
            messageText,
            rangeMeters
          );
          break;
        }
        case 'private_message': {
          const { targetName, message } = event.data as {
            targetName: string;
            message: string;
          };

          const sent = await this.sendPrivateMessage(
            context.characterId,
            context.characterName,
            targetName,
            message
          );

          if (!sent) {
            return {
              success: false,
              error: `Player '${targetName}' is not available.`,
            };
          }
          break;
        }
        case 'perception': {
          const { perceptionType, target } = event.data as {
            perceptionType: string;
            target?: string | null;
          };

          if (perceptionType !== 'look') {
            return {
              success: false,
              error: `Perception '${perceptionType}' is not supported yet.`,
            };
          }

          if (target) {
            const response = this.describeLookTarget(zoneManager, context, target);
            if (!response) {
              return {
                success: false,
                error: `Target '${target}' not found.`,
              };
            }

            overrideResponse = {
              success: true,
              message: response.message,
              data: response.data,
            };
          } else {
            const response = this.describeLookArea(zoneManager, context);
            if (!response) {
              return {
                success: false,
                error: 'Nothing to examine here.',
              };
            }

            overrideResponse = {
              success: true,
              message: response.message,
              data: response.data,
            };
          }
          break;
        }
        case 'party_action': {
          const { action, target } = event.data as { action: string; target?: string | null };
          const response = await this.handlePartyAction(context, action, target ?? null);
          if (!response.success) {
            return response;
          }
          overrideResponse = response;
          break;
        }
        case 'market_order_create': {
          const response = await this.marketBridge.createSellOrder(event.data as {
            characterId: string;
            regionId: string;
            inventoryItemId: string;
            quantity: number;
            pricePerUnit: number;
            orderScope: 'REGIONAL' | 'WORLD';
            stallId?: string;
            worldSlotIndex?: number;
          });
          if (!response.success) {
            return { success: false, error: response.error ?? 'Failed to create order' };
          }
          overrideResponse = {
            success: true,
            message: `Order created successfully (ID: ${response.orderId?.slice(0, 8)})`,
          };
          break;
        }
        case 'market_order_fill': {
          const response = await this.marketBridge.fillOrder(event.data as {
            buyerId: string;
            orderId: string;
            quantity?: number;
          });
          if (!response.success) {
            return { success: false, error: response.error ?? 'Failed to complete purchase' };
          }
          overrideResponse = {
            success: true,
            message: 'Purchase completed successfully!',
          };
          break;
        }
        case 'market_order_cancel': {
          const response = await this.marketBridge.cancelOrder(event.data as {
            characterId: string;
            orderId: string;
          });
          if (!response.success) {
            return { success: false, error: response.error ?? 'Failed to cancel order' };
          }
          overrideResponse = {
            success: true,
            message: 'Order cancelled. Items returned to inventory.',
          };
          break;
        }
        case 'combat_action': {
          const { abilityId, abilityName, target, setAutoAttack } = event.data as {
            abilityId?: string;
            abilityName?: string;
            target?: string;
            setAutoAttack?: boolean;
          };

          if (!target) {
            return {
              success: false,
              error: 'Combat action missing target.',
            };
          }

          const targetEntity = this.resolveCombatTarget(zoneManager, target);
          if (!targetEntity) {
            return {
              success: false,
              error: `Target '${target}' not found.`,
            };
          }

          const attackerEntity = zoneManager.getEntity(context.characterId);
          if (!attackerEntity || !attackerEntity.isAlive) {
            return {
              success: false,
              error: 'You are not present in the zone.',
            };
          }

          let ability: CombatAbilityDefinition | null = null;
          if (abilityId) {
            ability = (await this.abilitySystem.getAbility(abilityId)) || this.abilitySystem.getDefaultAbility();
          } else if (abilityName) {
            ability = await this.abilitySystem.getAbilityByName(abilityName);
            if (!ability) {
              return {
                success: false,
                error: `Ability '${abilityName}' not found.`,
              };
            }
          } else {
            return {
              success: false,
              error: 'Combat action missing ability.',
            };
          }

          // Set auto-attack target if this is basic_attack (unless explicitly disabled)
          // Auto-attack continues until target dies, player stops, or combat ends
          if (ability.id === 'basic_attack' && setAutoAttack !== false) {
            this.combatManager.setAutoAttackTarget(context.characterId, targetEntity.id);
          }

          await this.executeCombatAction(
            zoneManager,
            attackerEntity,
            targetEntity,
            ability
          );
          break;
        }
        case 'movement_start': {
          const { heading, speed, distance, target, targetRange, startPosition } = event.data as {
            heading?: number;
            speed: MovementSpeed;
            distance?: number;
            target?: string;
            targetRange: number;
            startPosition: Vector3;
          };

          // Physics validation: Check if movement is physically possible
          const zoneManager = this.zones.get(context.zoneId);
          if (zoneManager) {
            // Get current entity position for physics validation
            const entity = zoneManager.getEntity(context.characterId);
            if (entity) {
              // Simple physics check: prevent extreme movements that could be exploits
              if (distance && distance > 1000) { // 1000m limit for any single movement
                return {
                  success: false,
                  error: 'Movement distance too extreme.',
                };
              }

              // Additional physics validation could be added here
              // - Terrain collision checks
              // - Entity collision prevention
              // - Line-of-sight validation for targeted movement
            }
          }

          const movementEvent: MovementStartEvent = {
            characterId: context.characterId,
            zoneId: context.zoneId,
            startPosition,
            heading,
            speed,
            distance,
            target,
            targetRange,
          };

          const started = await this.movementSystem.startMovement(movementEvent);
          if (!started) {
            return {
              success: false,
              error: 'Failed to start movement. Target may not exist.',
            };
          }

          // Update character heading in database if we have one
          if (heading !== undefined) {
            await CharacterService.updatePosition(context.characterId, {
              ...startPosition,
              heading,
            });
          }
          break;
        }
        case 'movement_stop': {
          // Stop any active movement
          this.movementSystem.stopMovement({
            characterId: context.characterId,
            zoneId: context.zoneId,
          });
          break;
        }
        case 'auto_attack_stop': {
          // Stop auto-attacking
          this.combatManager.clearAutoAttackTarget(context.characterId);
          break;
        }
        case 'item_use': {
          // Item system not wired yet; accept command for now.
          break;
        }
        case 'equipment_changed': {
          await this.refreshEquipmentState(context.characterId);
          break;
        }
        case 'companion_command': {
          // Companion cycling is handled client-side or by airlock control.
          break;
        }
        default:
          return {
            success: false,
            error: `Command event '${event.type}' is not supported yet.`,
          };
      }
    }

    if (overrideResponse) {
      return overrideResponse;
    }

    return {
      success: result.success,
      message: result.message,
      error: result.error,
      data: result.data,
    };
  }

  private async broadcastChatFromCharacter(
    zoneManager: ZoneManager,
    characterId: string,
    characterName: string,
    position: { x: number; y: number; z: number },
    channel: 'say' | 'shout' | 'emote' | 'cfh' | 'touch',
    message: string,
    rangeMeters: number
  ): Promise<void> {
    const nearbySocketIds = zoneManager.getPlayerSocketIdsInRange(position, rangeMeters, characterId);
    const nearbyCompanionSocketIds = zoneManager.getCompanionSocketIdsInRange(position, rangeMeters, characterId);

    for (const socketId of nearbySocketIds) {
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId: '',
        socketId,
        payload: {
          socketId,
          event: 'chat',
          data: {
            channel,
            sender: characterName,
            senderId: characterId,
            message,
            timestamp: Date.now(),
          },
        },
        timestamp: Date.now(),
      });
    }

    for (const socketId of nearbyCompanionSocketIds) {
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId: '',
        socketId,
        payload: {
          socketId,
          event: 'chat',
          data: {
            channel,
            sender: characterName,
            senderId: characterId,
            message,
            timestamp: Date.now(),
          },
        },
        timestamp: Date.now(),
      });
    }

    this.trackChatMessage(zoneManager.getZone().id, characterName, channel, message);
    await this.triggerNPCResponses(zoneManager.getZone().id, position, rangeMeters);
  }

  private async sendPrivateMessage(
    senderId: string,
    senderName: string,
    targetName: string,
    message: string
  ): Promise<boolean> {
    const target = await CharacterService.findByName(targetName);
    if (!target) return false;

    const location = await this.zoneRegistry.getPlayerLocation(target.id);
    if (!location) return false;

    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId: target.id,
      socketId: location.socketId,
      payload: {
        socketId: location.socketId,
        event: 'chat',
        data: {
          channel: 'whisper',
          sender: senderName,
          senderId,
          message,
          timestamp: Date.now(),
        },
      },
      timestamp: Date.now(),
    });

    return true;
  }

  private async sendCommandResponse(
    socketId: string,
    command: string,
    response: { success: boolean; message?: string; error?: string; data?: any }
  ): Promise<void> {
    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      socketId,
      payload: {
        socketId,
        event: 'command_response',
        data: {
          success: response.success,
          command,
          message: response.message,
          error: response.error,
          data: response.data,
          timestamp: Date.now(),
        },
      },
      timestamp: Date.now(),
    });
  }

  private resolveCombatTarget(zoneManager: ZoneManager, target: string) {
    if (!target) return null;
    const direct = zoneManager.getEntity(target);
    if (direct && direct.isAlive) return direct;
    const byName = zoneManager.findEntityByName(target);
    return byName && byName.isAlive ? byName : null;
  }

  private resolveBiomeType(terrainType?: string | null): BiomeType {
    const normalized = (terrainType || '').toLowerCase();
    const candidates: BiomeType[] = [
      'forest',
      'grassland',
      'desert',
      'tundra',
      'swamp',
      'mountain',
      'coastal',
      'freshwater',
      'ocean',
      'urban',
      'underground',
    ];

    if (candidates.includes(normalized as BiomeType)) {
      return normalized as BiomeType;
    }

    if (normalized.includes('grass') || normalized.includes('plain')) return 'grassland';
    if (normalized.includes('swamp') || normalized.includes('marsh')) return 'swamp';
    if (normalized.includes('mountain') || normalized.includes('hill')) return 'mountain';
    if (normalized.includes('coast') || normalized.includes('shore')) return 'coastal';
    if (normalized.includes('fresh') || normalized.includes('lake') || normalized.includes('river')) return 'freshwater';
    if (normalized.includes('ocean') || normalized.includes('sea')) return 'ocean';
    if (normalized.includes('urban') || normalized.includes('city') || normalized.includes('town')) return 'urban';
    if (normalized.includes('underground') || normalized.includes('cave')) return 'underground';

    return BIOME_FALLBACK;
  }

  private async sendCharacterResourcesUpdate(
    zoneManager: ZoneManager,
    characterId: string,
    resources: {
      health?: { current: number; max: number };
      stamina?: { current: number; max: number };
      mana?: { current: number; max: number };
    }
  ): Promise<void> {
    const socketId = zoneManager.getSocketIdForCharacter(characterId);
    if (!socketId) return;

    if (resources.stamina && resources.mana) {
      this.partyResourceCache.set(characterId, {
        currentStamina: resources.stamina.current,
        maxStamina: resources.stamina.max,
        currentMana: resources.mana.current,
        maxMana: resources.mana.max,
      });
    }

    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId,
      socketId,
      payload: {
        socketId,
        event: 'state_update',
        data: {
          timestamp: Date.now(),
          character: resources,
        },
      },
      timestamp: Date.now(),
    });
  }

  private async sendFullCharacterState(
    zoneManager: ZoneManager,
    character: Character,
    socketId: string
  ): Promise<void> {
    this.partyResourceCache.set(character.id, {
      currentStamina: character.currentStamina,
      maxStamina: character.maxStamina,
      currentMana: character.currentMana,
      maxMana: character.maxMana,
    });
    const stateUpdate = {
      timestamp: Date.now(),
      character: {
        health: { current: character.currentHp, max: character.maxHp },
        stamina: { current: character.currentStamina, max: character.maxStamina },
        mana: { current: character.currentMana, max: character.maxMana },
      },
      combat: {
        inCombat: character.isAlive ? this.combatManager.isInCombat(character.id) : false,
      },
    };

    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId: character.id,
      socketId,
      payload: {
        socketId,
        event: 'state_update',
        data: stateUpdate,
      },
      timestamp: Date.now(),
    });
  }

  private async broadcastEntityHealthUpdate(
    zoneManager: ZoneManager,
    origin: Vector3,
    entityId: string,
    health: { current: number; max: number }
  ): Promise<void> {
    const nearbyPlayers = zoneManager.getPlayerSocketIdsInRange(origin, COMBAT_EVENT_RANGE_METERS);
    const nearbyCompanions = zoneManager.getCompanionSocketIdsInRange(origin, COMBAT_EVENT_RANGE_METERS);

    const payload = {
      timestamp: Date.now(),
      entities: {
        updated: [
          {
            id: entityId,
            health,
          },
        ],
      },
    };

    for (const socketId of [...nearbyPlayers, ...nearbyCompanions]) {
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        socketId,
        payload: {
          socketId,
          event: 'state_update',
          data: payload,
        },
        timestamp: Date.now(),
      });
    }
  }

  private async broadcastPartyStatus(): Promise<void> {
    const processed = new Set<string>();

    for (const memberId of this.characterToZone.keys()) {
      if (processed.has(memberId)) continue;

      const partyId = await this.partyService.getPartyIdForMember(memberId);
      if (!partyId) continue;

      const party = await this.partyService.getPartyInfo(partyId);
      if (!party) continue;

      for (const partyMember of party.members) {
        processed.add(partyMember);
      }

      for (const partyMember of party.members) {
        const location = await this.zoneRegistry.getPlayerLocation(partyMember);
        if (!location) continue;

        const allies = party.members
          .filter(id => id !== partyMember)
          .map(id => {
            const resources = this.partyResourceCache.get(id);
            const staminaPct = resources && resources.maxStamina > 0
              ? Math.round((resources.currentStamina / resources.maxStamina) * 100)
              : undefined;
            const manaPct = resources && resources.maxMana > 0
              ? Math.round((resources.currentMana / resources.maxMana) * 100)
              : undefined;
            const atb = this.combatManager.getAtbState(id) || undefined;

            return {
              entityId: id,
              staminaPct,
              manaPct,
              atb,
            };
          });

        await this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          socketId: location.socketId,
          payload: {
            socketId: location.socketId,
            event: 'state_update',
            data: {
              timestamp: Date.now(),
              allies,
            },
          },
          timestamp: Date.now(),
        });
      }
    }
  }

  private maybeRetaliate(
    targetEntity: { id: string; type: 'player' | 'npc' | 'companion' },
    attackerEntity: { id: string; type: 'player' | 'npc' | 'companion' }
  ): void {
    if (targetEntity.id === attackerEntity.id) return;
    if (this.combatManager.hasAutoAttackTarget(targetEntity.id)) return;
    this.combatManager.setAutoAttackTarget(targetEntity.id, attackerEntity.id);
  }

  private async handlePartyAction(
    context: CommandContext,
    action: string,
    target: string | null
  ): Promise<{ success: boolean; message?: string; error?: string; data?: any }> {
    const normalized = action.toLowerCase();

    if (normalized === 'list') {
      const partyId = await this.partyService.getPartyIdForMember(context.characterId);
      if (!partyId) {
        return { success: false, error: 'You are not in a party.' };
      }
      const party = await this.partyService.getPartyInfo(partyId);
      if (!party) {
        return { success: false, error: 'Party not found.' };
      }
      const members = await Promise.all(
        party.members.map(async (memberId) => {
          const character = await CharacterService.findById(memberId);
          return character?.name || memberId;
        })
      );

      return {
        success: true,
        message: `Party members: ${members.join(', ')}`,
        data: { partyId, leaderId: party.leaderId, members },
      };
    }

    if (normalized === 'invite') {
      if (!target) {
        return { success: false, error: 'Usage: /party invite <target>' };
      }

      const targetCharacter = await this.resolveOnlineCharacterForInvite(context, target);
      if (!targetCharacter) {
        return { success: false, error: `Target '${target}' not found or is offline.` };
      }

      if (targetCharacter.id === context.characterId) {
        return { success: false, error: 'You cannot invite yourself.' };
      }

      const existingParty = await this.partyService.getPartyIdForMember(targetCharacter.id);
      if (existingParty) {
        return { success: false, error: `${targetCharacter.name} is already in a party.` };
      }

      const party = await this.partyService.ensurePartyForLeader(context.characterId);
      if (party.members.length >= PARTY_MAX_MEMBERS) {
        return { success: false, error: 'Your party is full.' };
      }

      const location = await this.zoneRegistry.getPlayerLocation(targetCharacter.id);
      if (!location) {
        return { success: false, error: `${targetCharacter.name} is not online.` };
      }

      const invite = await this.partyService.createInvite(context.characterId, targetCharacter.id);
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        socketId: location.socketId,
        payload: {
          socketId: location.socketId,
          event: 'event',
          data: {
            eventType: 'party_invite',
            timestamp: Date.now(),
            fromId: context.characterId,
            fromName: context.characterName,
            partyId: invite.partyId,
            expiresAt: invite.expiresAt,
          },
        },
        timestamp: Date.now(),
      });

      return {
        success: true,
        message: `Party invite sent to ${targetCharacter.name}.`,
      };
    }

    if (normalized === 'accept' || normalized === 'decline') {
      const invite = await this.partyService.getInvite(context.characterId);
      if (!invite) {
        return { success: false, error: 'No pending party invite.' };
      }

      const fromCharacter = await CharacterService.findById(invite.fromId);
      const fromName = fromCharacter?.name || invite.fromId;

      if (normalized === 'decline') {
        await this.partyService.clearInvite(context.characterId);
        return { success: true, message: `Declined party invite from ${fromName}.` };
      }

      const existingParty = await this.partyService.getPartyIdForMember(context.characterId);
      if (existingParty) {
        return { success: false, error: 'You are already in a party.' };
      }

      const party = await this.partyService.getPartyInfo(invite.partyId);
      if (!party) {
        return { success: false, error: 'Party no longer exists.' };
      }

      if (party.members.length >= PARTY_MAX_MEMBERS) {
        return { success: false, error: 'Party is full.' };
      }

      await this.partyService.addMember(invite.partyId, context.characterId);
      await this.partyService.clearInvite(context.characterId);

      await this.notifyPartyMembers(invite.partyId, {
        eventType: 'party_joined',
        timestamp: Date.now(),
        memberId: context.characterId,
        memberName: context.characterName,
      });
      await this.sendPartyRoster(invite.partyId);

      return {
        success: true,
        message: `Joined ${fromName}'s party.`,
      };
    }

    if (normalized === 'leave') {
      const partyId = await this.partyService.getPartyIdForMember(context.characterId);
      if (!partyId) {
        return { success: false, error: 'You are not in a party.' };
      }

      const party = await this.partyService.getPartyInfo(partyId);
      if (!party) {
        return { success: false, error: 'Party not found.' };
      }

      await this.partyService.removeMember(partyId, context.characterId);

      if (party.leaderId === context.characterId) {
        const updated = await this.partyService.getPartyInfo(partyId);
        if (updated && updated.members.length > 0) {
          await this.partyService.setLeader(partyId, updated.members[0]);
        } else {
          await this.partyService.disband(partyId);
        }
      }

      await this.notifyPartyMembers(partyId, {
        eventType: 'party_left',
        timestamp: Date.now(),
        memberId: context.characterId,
        memberName: context.characterName,
      });
      await this.sendPartyRoster(partyId);

      return { success: true, message: 'You left the party.' };
    }

    if (normalized === 'kick') {
      if (!target) {
        return { success: false, error: 'Usage: /party kick <target>' };
      }

      const partyId = await this.partyService.getPartyIdForMember(context.characterId);
      if (!partyId) {
        return { success: false, error: 'You are not in a party.' };
      }

      const party = await this.partyService.getPartyInfo(partyId);
      if (!party) {
        return { success: false, error: 'Party not found.' };
      }

      if (party.leaderId !== context.characterId) {
        return { success: false, error: 'Only the party leader can kick members.' };
      }

      const targetCharacter = await this.resolveCharacterByNameOrId(target);
      if (!targetCharacter) {
        return { success: false, error: `Target '${target}' not found.` };
      }

      if (!party.members.includes(targetCharacter.id)) {
        return { success: false, error: `${targetCharacter.name} is not in your party.` };
      }

      await this.partyService.removeMember(partyId, targetCharacter.id);

      await this.notifyPartyMembers(partyId, {
        eventType: 'party_kicked',
        timestamp: Date.now(),
        memberId: targetCharacter.id,
        memberName: targetCharacter.name,
      });
      await this.sendPartyRoster(partyId);

      return { success: true, message: `${targetCharacter.name} was removed from the party.` };
    }

    if (normalized === 'lead') {
      if (!target) {
        return { success: false, error: 'Usage: /party lead <target>' };
      }

      const partyId = await this.partyService.getPartyIdForMember(context.characterId);
      if (!partyId) {
        return { success: false, error: 'You are not in a party.' };
      }

      const party = await this.partyService.getPartyInfo(partyId);
      if (!party) {
        return { success: false, error: 'Party not found.' };
      }

      if (party.leaderId !== context.characterId) {
        return { success: false, error: 'Only the party leader can promote a new leader.' };
      }

      const targetCharacter = await this.resolveCharacterByNameOrId(target);
      if (!targetCharacter) {
        return { success: false, error: `Target '${target}' not found.` };
      }

      if (!party.members.includes(targetCharacter.id)) {
        return { success: false, error: `${targetCharacter.name} is not in your party.` };
      }

      if (targetCharacter.id === party.leaderId) {
        return { success: false, error: `${targetCharacter.name} is already the party leader.` };
      }

      await this.partyService.setLeader(partyId, targetCharacter.id);

      await this.sendPartyRoster(partyId);

      return { success: true, message: `${targetCharacter.name} is now the party leader.` };
    }

    return { success: false, error: `Unknown party action '${action}'.` };
  }

  private async resolveCharacterByNameOrId(nameOrId: string): Promise<Character | null> {
    const direct = await CharacterService.findById(nameOrId);
    if (direct) return direct;
    return CharacterService.findByName(nameOrId);
  }

  private async resolveOnlineCharacterForInvite(
    context: CommandContext,
    nameOrId: string
  ): Promise<Character | null> {
    const direct = await CharacterService.findById(nameOrId);
    if (direct) {
      const location = await this.zoneRegistry.getPlayerLocation(direct.id);
      return location ? direct : null;
    }

    const zoneId = this.characterToZone.get(context.characterId);
    const zoneManager = zoneId ? this.zones.get(zoneId) : null;
    if (zoneManager) {
      const entity = zoneManager.findEntityByName(nameOrId);
      if (entity?.type === 'player') {
        const location = await this.zoneRegistry.getPlayerLocation(entity.id);
        if (location) {
          return CharacterService.findById(entity.id);
        }
      }
    }

    const byName = await CharacterService.findByName(nameOrId);
    if (!byName) return null;
    const location = await this.zoneRegistry.getPlayerLocation(byName.id);
    return location ? byName : null;
  }

  private async notifyPartyMembers(
    partyId: string,
    event: { eventType: string; timestamp: number; memberId?: string; memberName?: string }
  ): Promise<void> {
    const party = await this.partyService.getPartyInfo(partyId);
    if (!party) return;

    await Promise.all(
      party.members.map(async (memberId) => {
        const location = await this.zoneRegistry.getPlayerLocation(memberId);
        if (!location) return;
        await this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          socketId: location.socketId,
          payload: {
            socketId: location.socketId,
            event: 'event',
            data: event,
          },
          timestamp: Date.now(),
        });
      })
    );
  }

  private async sendPartyRoster(partyId: string): Promise<void> {
    const party = await this.partyService.getPartyInfo(partyId);
    if (!party) return;

    const members = await Promise.all(
      party.members.map(async (memberId) => {
        const character = await CharacterService.findById(memberId);
        return {
          id: memberId,
          name: character?.name || memberId,
        };
      })
    );

    await Promise.all(
      party.members.map(async (memberId) => {
        const location = await this.zoneRegistry.getPlayerLocation(memberId);
        if (!location) return;
        await this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          socketId: location.socketId,
          payload: {
            socketId: location.socketId,
            event: 'event',
            data: {
              eventType: 'party_roster',
              timestamp: Date.now(),
              partyId,
              leaderId: party.leaderId,
              members,
            },
          },
          timestamp: Date.now(),
        });
      })
    );
  }

  private async sendPartyRosterToMember(partyId: string, memberId: string): Promise<void> {
    const party = await this.partyService.getPartyInfo(partyId);
    if (!party) return;

    const members = await Promise.all(
      party.members.map(async (id) => {
        const character = await CharacterService.findById(id);
        return {
          id,
          name: character?.name || id,
        };
      })
    );

    const location = await this.zoneRegistry.getPlayerLocation(memberId);
    if (!location) return;

    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      socketId: location.socketId,
      payload: {
        socketId: location.socketId,
        event: 'event',
        data: {
          eventType: 'party_roster',
          timestamp: Date.now(),
          partyId,
          leaderId: party.leaderId,
          members,
        },
      },
      timestamp: Date.now(),
    });
  }

  private async sendCombatEventToEntity(
    zoneManager: ZoneManager,
    entityId: string,
    event: {
      eventType: string;
      timestamp: number;
      narrative?: string;
      eventTypeData?: Record<string, unknown>;
    }
  ): Promise<void> {
    const socketId = zoneManager.getSocketIdForEntity(entityId);
    if (!socketId) return;

    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      socketId,
      payload: {
        socketId,
        event: 'event',
        data: {
          eventType: event.eventType,
          timestamp: event.timestamp,
          narrative: event.narrative,
          ...event.eventTypeData,
        },
      },
      timestamp: Date.now(),
    });
  }

  private getDeathFloatText(
    kind: 'kill' | 'die'
  ): {
    text: string;
    colorKey: string;
    scale: number;
    shake: number;
  } {
    if (kind === 'kill') {
      return { text: 'KILL', colorKey: 'player.color.kill', scale: 1.35, shake: 0.2 };
    }
    return { text: 'YOU DIED', colorKey: 'player.color.die', scale: 1.8, shake: 0.4 };
  }

  private getCombatFloatTextForTarget(
    result: { critical: boolean; penetrating: boolean; deflected: boolean; glancing: boolean; amount?: number }
  ): {
    text: string;
    colorKey: string;
    scale: number;
    shake: number;
  } {
    const amount = result.amount ?? 0;
    const crit = result.critical;
    const pen = result.penetrating;
    const deflect = result.deflected;
    const glance = result.glancing;

    if (crit && pen) {
      return { text: `${amount}!`, colorKey: 'player.color.take_damage', scale: 1.5, shake: 0.5 };
    }
    if (crit) {
      return { text: `${amount}!`, colorKey: 'player.color.take_damage', scale: 1.3, shake: 0.4 };
    }
    if (pen) {
      return { text: `${amount}`, colorKey: 'player.color.take_damage', scale: 1.15, shake: 0.2 };
    }
    if (deflect) {
      return { text: `${amount}`, colorKey: 'player.color.take_damage', scale: 0.95, shake: 0 };
    }
    if (glance) {
      return { text: `${amount}`, colorKey: 'player.color.take_damage', scale: 0.9, shake: 0 };
    }

    return { text: `${amount}`, colorKey: 'player.color.take_damage', scale: 1.05, shake: 0.1 };
  }

  private getCombatFloatText(
    kind: 'hit' | 'miss',
    result?: { critical: boolean; penetrating: boolean; deflected: boolean; glancing: boolean; amount?: number }
  ): {
    text: string;
    colorKey: string;
    scale: number;
    shake: number;
  } {
    if (kind === 'miss') {
      return { text: 'MISS', colorKey: 'player.color.miss', scale: 0.9, shake: 0 };
    }

    const amount = result?.amount ?? 0;
    const crit = result?.critical;
    const pen = result?.penetrating;
    const deflect = result?.deflected;
    const glance = result?.glancing;

    if (crit && pen) {
      return { text: `${amount}!`, colorKey: 'player.color.crit_pen', scale: 1.6, shake: 0.6 };
    }
    if (crit) {
      return { text: `${amount}!`, colorKey: 'player.color.crit', scale: 1.35, shake: 0.4 };
    }
    if (pen) {
      return { text: `${amount}`, colorKey: 'player.color.penetrate', scale: 1.2, shake: 0.2 };
    }
    if (deflect) {
      return { text: `${amount}`, colorKey: 'player.color.deflect', scale: 0.95, shake: 0 };
    }
    if (glance) {
      return { text: `${amount}`, colorKey: 'player.color.glance', scale: 0.9, shake: 0 };
    }

    return { text: `${amount}`, colorKey: 'player.color.hit', scale: 1.0, shake: 0.1 };
  }

  private describeLookArea(
    zoneManager: ZoneManager,
    context: CommandContext
  ): { message: string; data: any } | null {
    const zone = zoneManager.getZone();
    const rosterResult = zoneManager.calculateProximityRoster(context.characterId);
    if (!rosterResult) return null;

    const see = rosterResult.roster.channels.see;
    const sample = see.sample ?? [];
    const previewNames = see.entities.slice(0, 5).map(entity => entity.name);

    let seeMessage = 'You see no one nearby.';
    if (see.count > 0) {
      if (sample.length > 0) {
        seeMessage = `You see ${sample.join(', ')}.`;
      } else {
        const previewText = previewNames.length > 0
          ? ` Nearby: ${previewNames.join(', ')}${see.count > previewNames.length ? '...' : ''}.`
          : '';
        seeMessage = `You see ${see.count} figures nearby.${previewText}`;
      }
    }

    const description = zone.description ? zone.description.trim() : '';
    const base = description || 'There is not much to note here.';
    const message = `You are in ${zone.name}. ${base} ${seeMessage}`;

    return {
      message,
      data: {
        type: 'look',
        zone: {
          id: zone.id,
          name: zone.name,
          description: zone.description || '',
        },
        nearby: {
          count: see.count,
          sample,
          preview: previewNames,
        },
      },
    };
  }

  private describeLookTarget(
    zoneManager: ZoneManager,
    context: CommandContext,
    target: string
  ): { message: string; data: any } | null {
    const entity = zoneManager.getEntity(target) || zoneManager.findEntityByName(target);
    if (!entity) return null;

    const dx = entity.position.x - context.position.x;
    const dy = entity.position.y - context.position.y;
    const dz = entity.position.z - context.position.z;
    const range = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 100) / 100;

    const statusParts: string[] = [];
    statusParts.push(entity.isAlive ? 'alive' : 'dead');
    if (entity.inCombat) {
      statusParts.push('in combat');
    }

    const statusText = statusParts.length > 0 ? ` and ${statusParts.join(', ')}` : '';
    const message = `${entity.name} (${entity.type}) is ${range}m away${statusText}.`;

    return {
      message,
      data: {
        type: 'look',
        target: {
          id: entity.id,
          name: entity.name,
          entityType: entity.type,
          isAlive: entity.isAlive,
          inCombat: entity.inCombat ?? false,
          range,
        },
      },
    };
  }

  private async executeCombatAction(
    zoneManager: ZoneManager,
    attackerEntity: { id: string; position: { x: number; y: number; z: number }; type: 'player' | 'npc' | 'companion' },
    targetEntity: { id: string; position: { x: number; y: number; z: number }; type: 'player' | 'npc' | 'companion' },
    ability: CombatAbilityDefinition,
    options?: { isAutoAttack?: boolean; isQueued?: boolean }
  ): Promise<{ hit: boolean } | null> {
    const isAutoAttack = options?.isAutoAttack ?? false;
    const isQueued = options?.isQueued ?? false;
    const characterId = attackerEntity.id;
    const targetId = targetEntity.id;
    const now = Date.now();

    // Check animation locks - can character perform this action?
    const animationLockSystem = zoneManager.getAnimationLockSystem();
    if (animationLockSystem && !animationLockSystem.canPerformAction(characterId)) {
      await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
        eventType: 'combat_error',
        timestamp: now,
        narrative: `You can't do that yet.`,
        eventTypeData: { reason: 'animation_locked', attackerId: characterId },
      });
      return null;
    }

    const attackerSnapshot = await this.getCombatSnapshot(characterId, attackerEntity);
    const targetSnapshot = await this.getCombatSnapshot(targetId, targetEntity);
    if (!attackerSnapshot || !targetSnapshot) return null;

    if (!this.validateRange(attackerEntity.position, targetEntity.position, ability)) {
      await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
        eventType: 'combat_error',
        timestamp: now,
        narrative: `Target out of range.`,
        eventTypeData: { reason: 'out_of_range', attackerId: characterId },
      });
      return null;
    }

    const cooldownRemaining = this.combatManager.getCooldownRemaining(characterId, ability.id, now);
    if (cooldownRemaining > 0) {
      await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
        eventType: 'combat_error',
        timestamp: now,
        narrative: `Ability on cooldown.`,
        eventTypeData: { reason: 'cooldown', attackerId: characterId },
      });
      return null;
    }

    // Auto-attacks don't use ATB - they run on weapon speed timer
    if (!isAutoAttack && !ability.isFree && ability.atbCost > 0) {
      if (!this.combatManager.canSpendAtb(characterId, ability.atbCost)) {
        await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
          eventType: 'combat_error',
          timestamp: now,
          narrative: `Not enough ATB.`,
          eventTypeData: { reason: 'atb_low', attackerId: characterId },
        });
        return null;
      }
    }

    // Consumer abilities require special charges
    if (ability.consumesCharge) {
      const hasCharges = this.combatManager.canSpendSpecialCharge(
        characterId,
        ability.consumesCharge.chargeType,
        ability.consumesCharge.amount
      );
      if (!hasCharges) {
        const currentCharges = this.combatManager.getSpecialCharges(
          characterId,
          ability.consumesCharge.chargeType
        );
        await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
          eventType: 'combat_error',
          timestamp: now,
          narrative: `Not enough ${ability.consumesCharge.chargeType} (need ${ability.consumesCharge.amount}, have ${currentCharges}).`,
          eventTypeData: {
            reason: 'charges_low',
            attackerId: characterId,
            chargeType: ability.consumesCharge.chargeType,
            required: ability.consumesCharge.amount,
            current: currentCharges,
          },
        });
        return null;
      }
    }

    if (!this.canPayCosts(attackerSnapshot, ability)) {
      await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
        eventType: 'combat_error',
        timestamp: now,
        narrative: `Not enough resources.`,
        eventTypeData: { reason: 'insufficient_resources', attackerId: characterId },
      });
      return null;
    }

    const castTime = ability.castTime ?? 0;
    if (!isAutoAttack && !isQueued && castTime > 0) {
      const actionId = `${characterId}-${now}-${Math.random().toString(36).slice(2, 8)}`;
      const readyAt = now + castTime * 1000;

      this.combatManager.enqueueAction({
        actionId,
        attackerId: characterId,
        targetId,
        ability,
        queuedAt: now,
        readyAt,
        castTime,
      });

      this.combatManager.recordHostileAction(characterId, now);
      this.combatManager.recordHostileAction(targetId, now);

      const attackerStarted = this.combatManager.startCombat(characterId, now);
      const targetStarted = this.combatManager.startCombat(targetId, now);

      if (attackerStarted) {
        zoneManager.setEntityCombatState(characterId, true);
      }
      if (targetStarted) {
        zoneManager.setEntityCombatState(targetId, true);
      }

      if (attackerStarted || targetStarted) {
        await this.broadcastNearbyUpdate(zoneManager.getZone().id);
        await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
          eventType: 'combat_start',
          timestamp: now,
          eventTypeData: { attackerId: characterId, targetId },
        });
      }

      return null;
    }

    await this.applyCosts(attackerSnapshot, ability);
    if (attackerSnapshot.isPlayer) {
      const healthCost = ability.healthCost || 0;
      const staminaCost = ability.staminaCost || 0;
      const manaCost = ability.manaCost || 0;
      const nextHealth = Math.max(1, attackerSnapshot.currentHealth - healthCost);
      const nextStamina = Math.max(0, attackerSnapshot.currentStamina - staminaCost);
      const nextMana = Math.max(0, attackerSnapshot.currentMana - manaCost);
      await this.sendCharacterResourcesUpdate(zoneManager, characterId, {
        health: { current: nextHealth, max: attackerSnapshot.maxHealth },
        stamina: { current: nextStamina, max: attackerSnapshot.maxStamina },
        mana: { current: nextMana, max: attackerSnapshot.maxMana },
      });
    }
    // Auto-attacks don't spend ATB
    if (!isAutoAttack && !ability.isFree) {
      this.combatManager.spendAtb(characterId, ability.atbCost);
    }

    // Builder abilities generate special charges
    if (ability.buildsCharge) {
      this.combatManager.addSpecialCharge(
        characterId,
        ability.buildsCharge.chargeType,
        ability.buildsCharge.amount
      );
    }

    // Consumer abilities spend special charges
    if (ability.consumesCharge) {
      this.combatManager.spendSpecialCharge(
        characterId,
        ability.consumesCharge.chargeType,
        ability.consumesCharge.amount
      );
    }

    const effectDelayMs = ability.effectDuration ? ability.effectDuration * 1000 : 0;
    this.combatManager.setCooldown(characterId, ability.id, ability.cooldown * 1000 + effectDelayMs, now);
    this.combatManager.recordHostileAction(characterId, now);
    this.combatManager.recordHostileAction(targetId, now);

    const attackerStarted = this.combatManager.startCombat(characterId, now);
    const targetStarted = this.combatManager.startCombat(targetId, now);

    if (attackerStarted) {
      zoneManager.setEntityCombatState(characterId, true);
    }
    if (targetStarted) {
      zoneManager.setEntityCombatState(targetId, true);
    }

    // Set animation lock and state for the ability
    if (animationLockSystem) {
      const lockConfig = animationLockSystem.getAbilityLockConfig(ability.id);
      let animationAction: AnimationAction = 'attacking';
      
      // Determine animation type from ability
      if (ability.damage?.type === 'magic' || ability.manaCost > 0) {
        animationAction = 'casting';
      } else if (lockConfig?.lockDuration > 1000) {
        animationAction = 'channeling';
      }
      
      animationLockSystem.setState(characterId, animationAction, lockConfig);
    }

    if (attackerStarted || targetStarted) {
      await this.broadcastNearbyUpdate(zoneManager.getZone().id);
      await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
        eventType: 'combat_start',
        timestamp: now,
        eventTypeData: { attackerId: characterId, targetId },
      });
    }

    if (!isAutoAttack) {
      this.maybeRetaliate(targetEntity, attackerEntity);
    }

    await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
      eventType: 'combat_action',
      timestamp: now,
      eventTypeData: {
        attackerId: characterId,
        targetId,
        abilityId: ability.id,
        abilityName: ability.name,
      },
    });

    if (ability.damage) {
      const targets = this.getCombatTargets(zoneManager, attackerEntity, targetEntity, ability);
      if (targets.length === 0) {
        return { hit: false };
      }

      const weaponData = attackerSnapshot.weapon ?? null;
      const weaponProfiles = ability.id === 'basic_attack' ? (weaponData?.damageProfiles ?? null) : null;
      const primaryDamageType = weaponData?.primaryDamageType;
      const primaryPhysicalType = ability.damage?.type === 'physical'
        ? (weaponData?.primaryPhysicalType ?? ability.damage?.physicalType)
        : ability.damage?.physicalType;
      const resolvedDamageType = (ability.id === 'basic_attack' && primaryDamageType)
        ? primaryDamageType
        : ability.damage?.type;
      const resolvedAbility = (ability.damage && (primaryPhysicalType || resolvedDamageType))
        ? {
          ...ability,
          damage: {
            ...ability.damage,
            ...(resolvedDamageType && { type: resolvedDamageType }),
            ...(primaryPhysicalType && { physicalType: primaryPhysicalType }),
          },
        }
        : ability;
      const baseDamageOverride = (ability.id === 'basic_attack' && weaponData?.baseDamage)
        ? weaponData.baseDamage
        : undefined;

      const scalingValue = this.getScalingValue(attackerSnapshot, ability);
      const damageScale = this.getMultiTargetScale(targets.length);
      const snapshots = new Map<string, typeof targetSnapshot>([[targetId, targetSnapshot]]);
      let anyHit = false;

      for (const target of targets) {
        let targetData = snapshots.get(target.id);
        if (!targetData) {
          targetData = await this.getCombatSnapshot(target.id, { type: target.type });
          if (!targetData) continue;
          snapshots.set(target.id, targetData);
        }

        const result = this.damageCalculator.calculate(
          resolvedAbility,
          attackerSnapshot.stats,
          targetData.stats,
          scalingValue,
          {
            damageMultiplier: damageScale,
            damageProfiles: weaponProfiles ?? undefined,
            baseDamageOverride,
            qualityBiasMultipliers: targetData.armorQualityMultipliers,
            attackerPosition: attackerEntity.position,
            defenderPosition: target.position,
            physicsSystem: zoneManager.getPhysicsSystem(),
          }
        );

        if (!result.hit) {
          const missTarget = zoneManager.getEntity(targetData.entityId);
          const missNarrative = buildCombatNarrative('miss', {
            attackerName: attackerEntity.name,
            targetName: missTarget?.name ?? 'target',
            ability: resolvedAbility,
          });
          await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
            eventType: 'combat_miss',
            timestamp: now,
            narrative: missNarrative,
            eventTypeData: {
              attackerId: characterId,
              targetId: targetData.entityId,
              abilityId: ability.id,
              floatText: this.getCombatFloatText('miss'),
            },
          });
          continue;
        }

        anyHit = true;
        const newHp = Math.max(0, targetData.currentHealth - result.amount);
        await this.updateHealth(targetData, newHp);
        
        // Set target animation to 'hit'
        if (animationLockSystem) {
          animationLockSystem.setState(targetData.entityId, 'hit');
        }
        
        if (targetData.isPlayer) {
          await this.sendCharacterResourcesUpdate(zoneManager, targetData.entityId, {
            health: { current: newHp, max: targetData.maxHealth },
            stamina: { current: targetData.currentStamina, max: targetData.maxStamina },
            mana: { current: targetData.currentMana, max: targetData.maxMana },
          });
        }
        await this.broadcastEntityHealthUpdate(zoneManager, targetEntity.position, targetData.entityId, {
          current: newHp,
          max: targetData.maxHealth,
        });

        const hitTarget = zoneManager.getEntity(targetData.entityId);
        const hitNarrative = buildCombatNarrative('hit', {
          attackerName: attackerEntity.name,
          targetName: hitTarget?.name ?? 'target',
          ability: resolvedAbility,
          result,
        });
        await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
          eventType: 'combat_hit',
          timestamp: now,
          narrative: hitNarrative,
          eventTypeData: {
            attackerId: characterId,
            targetId: targetData.entityId,
            abilityId: ability.id,
            damageType: resolvedAbility.damage?.type ?? 'physical',
            physicalType: resolvedAbility.damage?.physicalType,
            outcome: result.outcome,
            critical: result.critical,
            deflected: result.deflected,
            penetrating: result.penetrating,
            glancing: result.glancing,
            quality: result.quality,
            qualityMultiplier: result.qualityMultiplier,
            amount: result.amount,
            baseDamage: result.baseDamage,
            mitigatedDamage: result.mitigatedDamage,
            damageBreakdown: result.damageBreakdown,
            floatText: this.getCombatFloatText('hit', result),
            floatTextTarget: this.getCombatFloatTextForTarget(result),
          },
        });

        if (newHp <= 0) {
          zoneManager.setEntityAlive(targetData.entityId, false);
          zoneManager.setEntityCombatState(targetData.entityId, false);
          
          // Set dying → dead animation sequence
          if (animationLockSystem) {
            animationLockSystem.setState(targetData.entityId, 'dying', {
              lockDuration: 2000,          // 2s death animation
              lockType: 'hard',
              allowMovementDuring: false,
            });
            // Transition to 'dead' after death animation
            setTimeout(() => {
              animationLockSystem.setState(targetData.entityId, 'dead');
            }, 2000);
          }

          // Clear auto-attack for the dying target and all entities targeting it
          this.combatManager.clearAutoAttackTarget(targetData.entityId);
          this.combatManager.clearAutoAttacksOnTarget(targetData.entityId);

          await this.broadcastNearbyUpdate(zoneManager.getZone().id);

          await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
            eventType: 'combat_death',
            timestamp: now,
            eventTypeData: { targetId: targetData.entityId },
          });

          await this.sendCombatEventToEntity(zoneManager, characterId, {
            eventType: 'combat_death',
            timestamp: now,
            eventTypeData: {
              targetId: targetData.entityId,
              floatText: this.getDeathFloatText('kill'),
            },
          });

          await this.sendCombatEventToEntity(zoneManager, targetData.entityId, {
            eventType: 'combat_death',
            timestamp: now,
            eventTypeData: {
              targetId: targetData.entityId,
              floatText: this.getDeathFloatText('die'),
            },
          });

          if (!targetData.isPlayer) {
            await this.scheduleMobRespawn(targetData.entityId, zoneManager.getZone().id, targetData.maxHealth);
          }
        }
      }

      return { hit: anyHit };
    }

    return { hit: true };
  }

  private async broadcastCombatEvent(
    zoneId: string,
    origin: { x: number; y: number; z: number },
    event: {
      eventType: string;
      timestamp: number;
      narrative?: string;
      eventTypeData?: Record<string, unknown>;
    }
  ): Promise<void> {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const nearbyPlayers = zoneManager.getPlayerSocketIdsInRange(
      origin,
      COMBAT_EVENT_RANGE_METERS
    );
    const nearbyCompanions = zoneManager.getCompanionSocketIdsInRange(
      origin,
      COMBAT_EVENT_RANGE_METERS
    );

    const payload = {
      eventType: event.eventType,
      timestamp: event.timestamp,
      narrative: event.narrative,
      ...event.eventTypeData,
    };

    for (const socketId of [...nearbyPlayers, ...nearbyCompanions]) {
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        socketId,
        payload: {
          socketId,
          event: 'event',
          data: payload,
        },
        timestamp: Date.now(),
      });
    }
  }

  private async getCombatSnapshot(
    entityId: string,
    entity: { type: 'player' | 'npc' | 'companion' }
  ): Promise<{
    entityId: string;
    isPlayer: boolean;
    currentHealth: number;
    maxHealth: number;
    maxStamina: number;
    maxMana: number;
    currentStamina: number;
    currentMana: number;
    stats: CombatStats;
    coreStats: {
      strength: number;
      vitality: number;
      dexterity: number;
      agility: number;
      intelligence: number;
      wisdom: number;
    };
    armorQualityMultipliers?: QualityBiasMultipliers;
    weapon?: {
      baseDamage?: number;
      speed?: number;
      damageProfiles?: DamageProfileSegment[] | null;
      primaryPhysicalType?: PhysicalDamageType;
      primaryDamageType?: DamageType;
    } | null;
  } | null> {
    if (entity.type === 'player') {
      const character = await CharacterService.findById(entityId);
      if (!character) return null;

      const coreStats = {
        strength: character.strength,
        vitality: character.vitality,
        dexterity: character.dexterity,
        agility: character.agility,
        intelligence: character.intelligence,
        wisdom: character.wisdom,
      };

      const derived = StatCalculator.calculateDerivedStats(coreStats, character.level);
      this.attackSpeedBonusCache.set(entityId, derived.attackSpeedBonus);
      const weaponData = await this.getEquippedWeaponData(entityId);
      const armorQualityMultipliers = await this.getArmorQualityMultipliers(entityId);
      if (weaponData?.speed) {
        this.combatManager.setWeaponSpeed(entityId, weaponData.speed);
      }

      return {
        entityId,
        isPlayer: true,
        currentHealth: character.currentHp,
        maxHealth: character.maxHp,
        currentStamina: character.currentStamina,
        currentMana: character.currentMana,
        maxStamina: character.maxStamina,
        maxMana: character.maxMana,
        coreStats,
        stats: this.buildCombatStats(derived),
        armorQualityMultipliers,
        weapon: weaponData,
      };
    }

    const companion = await CompanionService.findById(entityId);
    if (!companion) return null;

    const stats = (companion.stats as Record<string, number>) || {};
    const coreStats = {
      strength: stats.strength ?? 10,
      vitality: stats.vitality ?? 10,
      dexterity: stats.dexterity ?? 10,
      agility: stats.agility ?? 10,
      intelligence: stats.intelligence ?? 10,
      wisdom: stats.wisdom ?? 10,
    };
    const derived = StatCalculator.calculateDerivedStats(coreStats, companion.level);
    this.attackSpeedBonusCache.set(entityId, derived.attackSpeedBonus);

    return {
      entityId,
      isPlayer: false,
      currentHealth: companion.currentHealth,
      maxHealth: companion.maxHealth,
      currentStamina: 0,
      currentMana: 0,
      maxStamina: 0,
      maxMana: 0,
      coreStats,
      stats: this.buildCombatStats(derived),
    };
  }

  private async getEquippedWeaponData(
    characterId: string
  ): Promise<{
    baseDamage?: number;
    speed?: number;
    damageProfiles?: DamageProfileSegment[] | null;
    primaryPhysicalType?: PhysicalDamageType;
    primaryDamageType?: DamageType;
  } | null> {
    const equipped = await CharacterService.findEquippedHandItems(characterId);
    if (equipped.length === 0) return null;

    const right = equipped.find(item => item.equipSlot === 'right_hand');
    const left = equipped.find(item => item.equipSlot === 'left_hand');
    const weaponItem = right || left;
    if (!weaponItem) return null;

    const weapon = getWeaponDefinition(weaponItem.template.properties);
    if (!weapon) return null;

    const profiles = buildDamageProfiles(weapon);
    const primaryPhysicalType = getPrimaryPhysicalType(profiles);

    return {
      baseDamage: weapon.baseDamage,
      speed: weapon.speed,
      damageProfiles: profiles,
      primaryPhysicalType,
      primaryDamageType: getPrimaryDamageType(profiles),
    };
  }

  private async refreshEquipmentState(characterId: string): Promise<void> {
    const weaponData = await this.getEquippedWeaponData(characterId);
    if (weaponData?.speed) {
      this.combatManager.setWeaponSpeed(characterId, weaponData.speed);
    } else {
      this.combatManager.resetWeaponSpeed(characterId);
    }
  }

  private async getArmorQualityMultipliers(characterId: string): Promise<QualityBiasMultipliers> {
    const equipped = await CharacterService.findEquippedItems(characterId);
    const propertiesList = equipped.map(item => item.template.properties);
    return buildQualityBiasMultipliers(propertiesList);
  }

  private buildCombatStats(derived: {
    attackRating: number;
    defenseRating: number;
    physicalAccuracy: number;
    evasion: number;
    damageAbsorption: number;
    glancingBlowChance: number;
    criticalHitChance: number;
    penetratingBlowChance: number;
    deflectedBlowChance: number;
    magicAttack: number;
    magicDefense: number;
    magicAccuracy: number;
    magicEvasion: number;
    magicAbsorption: number;
  }): CombatStats {
    return {
      attackRating: derived.attackRating,
      defenseRating: derived.defenseRating,
      physicalAccuracy: derived.physicalAccuracy,
      evasion: derived.evasion,
      damageAbsorption: derived.damageAbsorption,
      glancingBlowChance: derived.glancingBlowChance,
      magicAttack: derived.magicAttack,
      magicDefense: derived.magicDefense,
      magicAccuracy: derived.magicAccuracy,
      magicEvasion: derived.magicEvasion,
      magicAbsorption: derived.magicAbsorption,
      criticalHitChance: derived.criticalHitChance,
      penetratingBlowChance: derived.penetratingBlowChance,
      deflectedBlowChance: derived.deflectedBlowChance,
    };
  }

  private validateRange(
    source: { x: number; y: number; z: number },
    target: { x: number; y: number; z: number },
    ability: CombatAbilityDefinition
  ): boolean {
    if (ability.targetType === 'self') return true;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const dz = target.z - source.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return distance <= ability.range;
  }

  private getMultiTargetScale(targetCount: number): number {
    if (targetCount <= 1) return 1;
    return (1 + 0.1 * (targetCount - 1)) / targetCount;
  }

  private getCombatTargets(
    zoneManager: ZoneManager,
    attacker: { id: string; position: { x: number; y: number; z: number }; type: 'player' | 'npc' | 'companion' | 'mob' },
    target: { id: string; position: { x: number; y: number; z: number }; type: 'player' | 'npc' | 'companion' | 'mob' },
    ability: CombatAbilityDefinition
  ): Array<{ id: string; position: { x: number; y: number; z: number }; type: 'player' | 'npc' | 'companion' | 'mob' }> {
    if (ability.targetType === 'self') {
      return [{ id: attacker.id, position: attacker.position, type: attacker.type }];
    }

    if (ability.targeting?.shape === 'cone') {
      return this.getConeTargets(zoneManager, attacker, target, ability);
    }

    if (ability.targeting?.shape === 'line') {
      return this.getLineTargets(zoneManager, attacker, target, ability);
    }

    if (ability.aoeRadius && ability.aoeRadius > 0) {
      const entities = zoneManager.getEntitiesInRangeForCombat(target.position, ability.aoeRadius, attacker.id);
      return entities.filter(entity => entity.type === 'player' || entity.type === 'companion' || entity.type === 'mob');
    }

    return [{ id: target.id, position: target.position, type: target.type }];
  }

  private getConeTargets(
    zoneManager: ZoneManager,
    attacker: { id: string; position: { x: number; y: number; z: number } },
    target: { id: string; position: { x: number; y: number; z: number } },
    ability: CombatAbilityDefinition
  ): Array<{ id: string; position: { x: number; y: number; z: number }; type: 'player' | 'npc' | 'companion' | 'mob' }> {
    const length = ability.targeting?.length ?? ability.range;
    const angleDegrees = ability.targeting?.angle ?? 45;
    const halfAngle = (angleDegrees * Math.PI) / 360;

    const direction = this.normalizeVector({
      x: target.position.x - attacker.position.x,
      y: target.position.y - attacker.position.y,
      z: target.position.z - attacker.position.z,
    });

    const entities = zoneManager.getEntitiesInRangeForCombat(attacker.position, length, attacker.id);
    return entities
      .filter(entity => entity.type === 'player' || entity.type === 'companion' || entity.type === 'mob')
      .filter(entity => {
        const toEntity = {
          x: entity.position.x - attacker.position.x,
          y: entity.position.y - attacker.position.y,
          z: entity.position.z - attacker.position.z,
        };
        const distance = Math.sqrt(toEntity.x * toEntity.x + toEntity.y * toEntity.y + toEntity.z * toEntity.z);
        if (distance === 0) return false;
        const normalized = this.normalizeVector(toEntity);
        const dot = this.clamp(this.dotVector(normalized, direction), -1, 1);
        const angle = Math.acos(dot);
        return angle <= halfAngle;
      });
  }

  private getLineTargets(
    zoneManager: ZoneManager,
    attacker: { id: string; position: { x: number; y: number; z: number } },
    target: { id: string; position: { x: number; y: number; z: number } },
    ability: CombatAbilityDefinition
  ): Array<{ id: string; position: { x: number; y: number; z: number }; type: 'player' | 'npc' | 'companion' | 'mob' }> {
    const length = ability.targeting?.length ?? ability.range;
    const width = ability.targeting?.width ?? 1;

    const direction = this.normalizeVector({
      x: target.position.x - attacker.position.x,
      y: target.position.y - attacker.position.y,
      z: target.position.z - attacker.position.z,
    });

    const entities = zoneManager.getEntitiesInRangeForCombat(attacker.position, length, attacker.id);
    return entities
      .filter(entity => entity.type === 'player' || entity.type === 'companion' || entity.type === 'mob')
      .filter(entity => {
        const toEntity = {
          x: entity.position.x - attacker.position.x,
          y: entity.position.y - attacker.position.y,
          z: entity.position.z - attacker.position.z,
        };
        const projection = this.dotVector(toEntity, direction);
        if (projection < 0 || projection > length) return false;
        const closestPoint = {
          x: attacker.position.x + direction.x * projection,
          y: attacker.position.y + direction.y * projection,
          z: attacker.position.z + direction.z * projection,
        };
        const dx = entity.position.x - closestPoint.x;
        const dy = entity.position.y - closestPoint.y;
        const dz = entity.position.z - closestPoint.z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        return distance <= width / 2;
      });
  }

  private normalizeVector(vector: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const magnitude = Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
    if (magnitude === 0) return { x: 0, y: 0, z: 0 };
    return {
      x: vector.x / magnitude,
      y: vector.y / magnitude,
      z: vector.z / magnitude,
    };
  }

  private dotVector(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private getScalingValue(
    snapshot: { coreStats: Record<string, number> },
    ability: CombatAbilityDefinition
  ): number {
    const stat = ability.damage?.scalingStat;
    if (!stat) return 0;
    return snapshot.coreStats[stat] || 0;
  }

  private canPayCosts(
    snapshot: { currentHealth: number; currentStamina: number; currentMana: number; isPlayer: boolean },
    ability: CombatAbilityDefinition
  ): boolean {
    if (ability.healthCost && snapshot.currentHealth <= ability.healthCost) return false;
    if (ability.staminaCost && snapshot.isPlayer && snapshot.currentStamina < ability.staminaCost) return false;
    if (ability.manaCost && snapshot.isPlayer && snapshot.currentMana < ability.manaCost) return false;
    return true;
  }

  private async applyCosts(
    snapshot: { entityId: string; isPlayer: boolean; currentHealth: number; currentStamina: number; currentMana: number },
    ability: CombatAbilityDefinition
  ): Promise<void> {
    const healthCost = ability.healthCost || 0;
    const staminaCost = ability.staminaCost || 0;
    const manaCost = ability.manaCost || 0;

    const newHealth = Math.max(1, snapshot.currentHealth - healthCost);
    if (snapshot.isPlayer) {
      await CharacterService.updateResources(snapshot.entityId, {
        currentHp: newHealth,
        currentStamina: Math.max(0, snapshot.currentStamina - staminaCost),
        currentMana: Math.max(0, snapshot.currentMana - manaCost),
        isAlive: newHealth > 0,
      });
      return;
    }

    if (healthCost > 0) {
      await CompanionService.updateStatus(snapshot.entityId, {
        currentHealth: newHealth,
        isAlive: newHealth > 0,
      });
    }
  }

  private async updateHealth(
    snapshot: { entityId: string; isPlayer: boolean },
    newHealth: number
  ): Promise<void> {
    if (snapshot.isPlayer) {
      await CharacterService.updateResources(snapshot.entityId, { currentHp: newHealth, isAlive: newHealth > 0 });
    } else {
      await CompanionService.updateStatus(snapshot.entityId, {
        currentHealth: newHealth,
        isAlive: newHealth > 0,
      });
    }
  }

  private async scheduleMobRespawn(mobId: string, zoneId: string, _maxHealth: number): Promise<void> {
    if (this.respawnTimers.has(mobId)) return;

    const mob = await MobService.findById(mobId);
    if (!mob) return;

    const timer = setTimeout(async () => {
      try {
        await MobService.respawn(mobId);
        const zoneManager = this.zones.get(zoneId);
        if (zoneManager) {
          zoneManager.setEntityAlive(mobId, true);
          zoneManager.setEntityCombatState(mobId, false);
          await this.broadcastNearbyUpdate(zoneId);
        }
      } finally {
        this.respawnTimers.delete(mobId);
      }
    }, mob.respawnTime * 1000);

    this.respawnTimers.set(mobId, timer);
  }

  private async handleNpcInhabit(message: MessageEnvelope): Promise<void> {
    const { companionId, zoneId, socketId } = message.payload as {
      companionId: string;
      zoneId: string;
      socketId: string;
    };

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) {
      logger.warn({ companionId, zoneId }, 'Cannot inhabit NPC - zone not managed');
      return;
    }

    zoneManager.setCompanionSocketId(companionId, socketId);
    this.companionToZone.set(companionId, zoneId);

    this.previousRosters.delete(companionId);
    await this.sendProximityRosterToEntity(companionId);
  }

  private async handleNpcRelease(message: MessageEnvelope): Promise<void> {
    const { companionId, zoneId } = message.payload as {
      companionId: string;
      zoneId: string;
    };

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    zoneManager.setCompanionSocketId(companionId, null);
    this.companionToZone.delete(companionId);
    this.previousRosters.delete(companionId);
    this.attackSpeedBonusCache.delete(companionId);
  }

  private async handleNpcChat(message: MessageEnvelope): Promise<void> {
    const { companionId, zoneId, channel, text } = message.payload as {
      companionId: string;
      zoneId: string;
      channel: 'say' | 'shout' | 'emote' | 'cfh' | 'touch';
      text: string;
    };

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const { CompanionService } = await import('@/database');
    const companion = await CompanionService.findById(companionId);
    if (!companion) {
      logger.warn({ companionId }, 'Companion not found for NPC chat');
      return;
    }

    const ranges = {
      touch: 1.524,
      say: 6.096,
      shout: 45.72,
      emote: 45.72,
      cfh: 76.2,
    };

    const range = ranges[channel];
    const speakerPosition = {
      x: companion.positionX,
      y: companion.positionY,
      z: companion.positionZ,
    };

    const nearbyPlayerSocketIds = zoneManager.getPlayerSocketIdsInRange(
      speakerPosition,
      range,
      companionId
    );
    const nearbyCompanionSocketIds = zoneManager.getCompanionSocketIdsInRange(
      speakerPosition,
      range,
      companionId
    );

    let formattedMessage = text;
    if (channel === 'emote') {
      formattedMessage = `${companion.name} ${text}`;
    }

    for (const socketId of nearbyPlayerSocketIds) {
      const clientMessage: ClientMessagePayload = {
        socketId,
        event: 'chat',
        data: {
          channel,
          sender: companion.name,
          senderId: companionId,
          message: formattedMessage,
          timestamp: Date.now(),
        },
      };

      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId: '',
        socketId,
        payload: clientMessage,
        timestamp: Date.now(),
      });
    }

    for (const socketId of nearbyCompanionSocketIds) {
      const clientMessage: ClientMessagePayload = {
        socketId,
        event: 'chat',
        data: {
          channel,
          sender: companion.name,
          senderId: companionId,
          message: formattedMessage,
          timestamp: Date.now(),
        },
      };

      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId: '',
        socketId,
        payload: clientMessage,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Handle a player-requested proximity roster refresh
   */
  private async handlePlayerProximityRefresh(message: MessageEnvelope): Promise<void> {
    const { characterId, zoneId } = message.payload as {
      characterId: string;
      zoneId: string;
    };

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    // Send a full proximity roster snapshot on refresh.
    await this.sendFullProximityRosterToEntity(characterId);
    logger.debug({ characterId, zoneId }, 'Proximity roster refresh sent');
  }

  /**
   * Track recent chat messages for NPC AI context
   */
  private trackChatMessage(zoneId: string, sender: string, channel: string, message: string): void {
    if (!this.recentChatMessages.has(zoneId)) {
      this.recentChatMessages.set(zoneId, []);
    }

    const messages = this.recentChatMessages.get(zoneId)!;
    messages.push({ sender, channel, message, timestamp: Date.now() });

    // Keep only last 20 messages, cleanup old ones (>5 min)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    this.recentChatMessages.set(
      zoneId,
      messages.filter(m => m.timestamp > fiveMinutesAgo).slice(-20)
    );
  }

  /**
   * Trigger NPC AI responses for NPCs in range of the message
   */
  private async triggerNPCResponses(zoneId: string, messageOrigin: { x: number; y: number; z: number }, range: number): Promise<void> {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    // Get recent messages for this zone
    const recentMessages = this.recentChatMessages.get(zoneId) || [];
    const contextMessages = recentMessages.slice(-5).map(m => ({
      sender: m.sender,
      channel: m.channel,
      message: m.message,
    }));

    // Find NPCs in range
    const nearbyNPCs = await this.getNearbyNPCs(zoneId, messageOrigin, range);

    // Trigger AI response for each nearby NPC
    for (const companion of nearbyNPCs) {
      if (this.companionToZone.has(companion.id)) {
        continue;
      }
      const controller = this.npcControllers.get(companion.id);
      if (!controller) continue;

      // Calculate proximity roster for this NPC (no hash needed for NPCs - they don't get roster updates)
      const result = zoneManager.calculateProximityRoster(companion.id);
      if (!result) continue;

      // Generate and broadcast NPC response
      this.handleNPCResponse(companion, result.roster, contextMessages, zoneId);
    }
  }

  /**
   * Get NPCs near a position
   */
  private async getNearbyNPCs(zoneId: string, position: { x: number; y: number; z: number }, range: number): Promise<Companion[]> {
    const companions = await ZoneService.getCompanionsInZone(zoneId);

    return companions.filter(companion => {
      const dx = companion.positionX - position.x;
      const dy = companion.positionY - position.y;
      const dz = companion.positionZ - position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      return distance <= range;
    });
  }

  /**
   * Handle NPC AI response (async, doesn't block)
   */
  private async handleNPCResponse(
    companion: Companion,
    proximityRoster: any,
    recentMessages: { sender: string; channel: string; message: string }[],
    zoneId: string
  ): Promise<void> {
    try {
      const response = await this.llmService.generateNPCResponse(
        companion,
        proximityRoster,
        recentMessages,
        [] // TODO: Load conversation history from database
      );

      if (response.action === 'none') return;

      // Broadcast NPC response
      await this.broadcastNPCMessage(companion, response, zoneId);

      logger.debug({
        companionId: companion.id,
        action: response.action,
        channel: response.channel,
      }, 'NPC responded');

    } catch (error) {
      logger.error({ error, companionId: companion.id }, 'NPC AI response failed');
    }
  }

  /**
   * Broadcast NPC chat/emote message
   */
  private async broadcastNPCMessage(companion: Companion, response: any, zoneId: string): Promise<void> {
    if (!response.message) return;

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const ranges = {
      say: 6.096,     // 20 feet
      shout: 45.72,   // 150 feet
      emote: 45.72,   // 150 feet
    };

    const range = ranges[response.channel as keyof typeof ranges] || 6.096;
    const npcPosition = {
      x: companion.positionX,
      y: companion.positionY,
      z: companion.positionZ,
    };

    // Get nearby player socket IDs
    const nearbySocketIds = zoneManager.getPlayerSocketIdsInRange(npcPosition, range);

    // Format message
    let formattedMessage = response.message;
    if (response.channel === 'emote') {
      formattedMessage = `${companion.name} ${response.message}`;
    }

    // Track NPC message
    this.trackChatMessage(zoneId, companion.name, response.channel, formattedMessage);

    // Broadcast to nearby players
    for (const socketId of nearbySocketIds) {
      const clientMessage: ClientMessagePayload = {
        socketId,
        event: 'chat',
        data: {
          channel: response.channel,
          sender: companion.name,
          senderId: companion.id,
          message: formattedMessage,
          timestamp: Date.now(),
        },
      };

      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId: '',
        socketId,
        payload: clientMessage,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Send proximity roster delta to a specific player (only if changed)
   */
  private async sendProximityRosterToEntity(entityId: string): Promise<void> {
    const zoneId = this.characterToZone.get(entityId) || this.companionToZone.get(entityId);
    if (!zoneId) return;

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    // Get previous roster for delta calculation
    const previousRoster = this.previousRosters.get(entityId);

    // Calculate delta
    const result = zoneManager.calculateProximityRosterDelta(entityId, previousRoster);

    // If result is null, roster hasn't changed - don't send
    if (!result) {
      return;
    }

    const { delta, roster } = result;

    // Store new roster for next delta calculation
    this.previousRosters.set(entityId, roster);

    const socketId = zoneManager.getSocketIdForEntity(entityId);
    if (!socketId) return;

    // Publish delta message to Gateway
    const clientMessage: ClientMessagePayload = {
      socketId,
      event: 'proximity_roster_delta',
      data: {
        ...delta,
        timestamp: Date.now(),
      },
    };

    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId: entityId,
      socketId,
      payload: clientMessage,
      timestamp: Date.now(),
    });
  }

  /**
   * Send a full proximity roster snapshot to a specific player
   */
  private async sendFullProximityRosterToEntity(entityId: string): Promise<void> {
    const zoneId = this.characterToZone.get(entityId) || this.companionToZone.get(entityId);
    if (!zoneId) return;

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const result = zoneManager.calculateProximityRoster(entityId);
    if (!result) return;

    const { roster } = result;

    // Store roster as baseline for future deltas
    this.previousRosters.set(entityId, roster);

    const socketId = zoneManager.getSocketIdForEntity(entityId);
    if (!socketId) return;

    const clientMessage: ClientMessagePayload = {
      socketId,
      event: 'proximity_roster',
      data: {
        ...roster,
        timestamp: Date.now(),
      },
    };

    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId: entityId,
      socketId,
      payload: clientMessage,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast proximity roster updates to all nearby players in a zone
   */
  private async broadcastNearbyUpdate(zoneId: string): Promise<void> {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    // Send updated rosters to all players in the zone
    for (const [characterId, charZoneId] of this.characterToZone.entries()) {
      if (charZoneId === zoneId) {
        await this.sendProximityRosterToEntity(characterId);
      }
    }

    for (const [companionId, compZoneId] of this.companionToZone.entries()) {
      if (compZoneId === zoneId) {
        await this.sendProximityRosterToEntity(companionId);
      }
    }
  }

  /**
   * Broadcast position update (state_update) to all players in the zone
   */
  private async broadcastPositionUpdate(
    characterId: string,
    zoneId: string,
    position: Vector3
  ): Promise<void> {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const entity = zoneManager.getEntity(characterId);
    if (!entity) return;

    // Get animation and movement data
    const animationLockSystem = zoneManager.getAnimationLockSystem();
    const movementSystem = this.movementSystem;
    
    const animationState = animationLockSystem?.getState(characterId);
    const movementDuration = movementSystem.getMovementDuration(characterId);
    const movementSpeed = movementSystem.getMovementSpeed(characterId);
    const heading = movementSystem.getHeading(characterId);

    // Build state_update message with animation data
    const stateUpdate = {
      timestamp: Date.now(),
      entities: {
        updated: [{
          id: characterId,
          name: entity.name,
          type: entity.type,
          position,
          heading,
          movementDuration,
          movementSpeed,
          currentAction: animationState?.currentAction,
        }],
      },
    };

    // Send to all players in the zone via gateway
    for (const [charId, charZoneId] of this.characterToZone.entries()) {
      if (charZoneId === zoneId) {
        const socketId = zoneManager.getSocketIdForCharacter(charId);
        if (socketId) {
          await this.messageBus.publish('gateway:output', {
            type: MessageType.CLIENT_MESSAGE,
            characterId: charId,
            socketId,
            payload: {
              socketId,
              event: 'state_update',
              data: stateUpdate,
            },
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  /**
   * Add a player to a zone (called from Gateway via message bus)
   */
  async addPlayerToZone(character: Character, socketId: string, isMachine: boolean = false): Promise<void> {
    // Publish to the zone's input channel
    const channel = `zone:${character.zoneId}:input`;

    await this.messageBus.publish(channel, {
      type: MessageType.PLAYER_JOIN_ZONE,
      zoneId: character.zoneId,
      characterId: character.id,
      socketId,
      payload: { character, socketId, isMachine },
      timestamp: Date.now(),
    });
  }

  /**
   * Remove a player from a zone
   */
  async removePlayerFromZone(characterId: string, zoneId: string): Promise<void> {
    const channel = `zone:${zoneId}:input`;

    await this.messageBus.publish(channel, {
      type: MessageType.PLAYER_LEAVE_ZONE,
      zoneId,
      characterId,
      payload: { characterId, zoneId },
      timestamp: Date.now(),
    });
  }

  /**
   * Update player position
   */
  async updatePlayerPosition(
    characterId: string,
    zoneId: string,
    position: { x: number; y: number; z: number }
  ): Promise<void> {
    const channel = `zone:${zoneId}:input`;

    await this.messageBus.publish(channel, {
      type: MessageType.PLAYER_MOVE,
      zoneId,
      characterId,
      payload: { characterId, zoneId, position },
      timestamp: Date.now(),
    });
  }

  /**
   * Record last speaker for proximity tracking
   */
  recordLastSpeaker(zoneId: string, listenerId: string, speakerName: string): void {
    const zoneManager = this.zones.get(zoneId);
    if (zoneManager) {
      zoneManager.recordLastSpeaker(listenerId, speakerName);
    }
  }

  /**
   * Get socket IDs of players in range (for broadcasting messages)
   */
  getPlayersInRange(
    zoneId: string,
    position: { x: number; y: number; z: number },
    range: number,
    excludeCharacterId?: string
  ): string[] {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return [];

    return zoneManager.getPlayerSocketIdsInRange(position, range, excludeCharacterId);
  }

  /**
   * Update tick - called by game loop
   */
  update(deltaTime: number): void {
    // Update combat system (ATB, cooldowns, combat timeouts)
    const expired = this.combatManager.update(
      deltaTime,
      (entityId) => this.attackSpeedBonusCache.get(entityId) ?? 0
    );
    if (expired.length > 0) {
      void this.handleCombatTimeouts(expired);
    }

    // Process queued combat actions (cast times)
    void this.processQueuedCombatActions();

    // Process auto-attacks for entities whose weapon timer is ready
    void this.processAutoAttacks();

    // Broadcast combat gauges to players in combat
    void this.broadcastCombatGauges();

    // Update movement system
    const positionUpdates = this.movementSystem.update(deltaTime);
    if (positionUpdates.size > 0) {
      void this.handleMovementUpdates(positionUpdates);
    }

    // Update wildlife simulation
    const now = Date.now();
    for (const wildlifeManager of this.wildlifeManagers.values()) {
      wildlifeManager.update(deltaTime, now);
    }

    if (now - this.lastPartyStatusBroadcastAt >= PARTY_STATUS_INTERVAL_MS) {
      void this.broadcastPartyStatus();
      this.lastPartyStatusBroadcastAt = now;
    }

    // Update corruption system (manages its own tick interval internally)
    this.corruptionSystem.update(this.getZoneCorruptionData());
  }

  /**
   * Broadcast combat gauges (ATB, auto-attack timer) to players
   * - Self: Gets full combat state (ATB + auto-attack timer)
   * - Party/Alliance: Gets ATB only (no auto-attack info)
   * - Enemies: Get nothing
   */
  private async broadcastCombatGauges(): Promise<void> {
    const entitiesInCombat = this.combatManager.getEntitiesInCombat();

    for (const entityId of entitiesInCombat) {
      // Only broadcast to players (not NPCs/companions for now)
      const zoneId = this.characterToZone.get(entityId);
      if (!zoneId) continue;

      const zoneManager = this.zones.get(zoneId);
      if (!zoneManager) continue;

      const socketId = zoneManager.getSocketIdForCharacter(entityId);
      if (!socketId) continue;

      // Get combat state for self
      const combatState = this.combatManager.getCombatState(entityId);
      if (!combatState) continue;

      // Build state_update with combat gauges
      // Only include specialCharges if there are any (avoid empty object)
      const hasCharges = Object.keys(combatState.specialCharges).length > 0;
      const stateUpdate = {
        timestamp: Date.now(),
        combat: {
          atb: combatState.atb,
          autoAttack: combatState.autoAttack,
          inCombat: combatState.inCombat,
          autoAttackTarget: combatState.autoAttackTarget,
          ...(hasCharges && { specialCharges: combatState.specialCharges }),
        },
        // TODO: Add party/alliance ATB when party system is implemented
        // allies: this.getPartyMemberAtb(entityId),
      };

      // Send to self
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId: entityId,
        socketId,
        payload: {
          socketId,
          event: 'state_update',
          data: stateUpdate,
        },
        timestamp: Date.now(),
      });
    }
  }

  private async processQueuedCombatActions(): Promise<void> {
    const readyActions = this.combatManager.getReadyActions(Date.now());
    if (readyActions.length === 0) return;

    for (const action of readyActions) {
      const zoneId = this.characterToZone.get(action.attackerId) || this.companionToZone.get(action.attackerId);
      if (!zoneId) {
        continue;
      }

      const zoneManager = this.zones.get(zoneId);
      if (!zoneManager) {
        continue;
      }

      const attackerEntity = zoneManager.getEntity(action.attackerId);
      const targetEntity = zoneManager.getEntity(action.targetId);

      if (!attackerEntity || !attackerEntity.isAlive) {
        if (targetEntity) {
          await this.broadcastCombatEvent(zoneId, targetEntity.position, {
            eventType: 'combat_error',
            timestamp: Date.now(),
            narrative: 'Attacker not available.',
            eventTypeData: { reason: 'attacker_missing', attackerId: action.attackerId },
          });
        }
        continue;
      }

      if (!targetEntity || !targetEntity.isAlive) {
        await this.broadcastCombatEvent(zoneId, attackerEntity.position, {
          eventType: 'combat_error',
          timestamp: Date.now(),
          narrative: 'Target not available.',
          eventTypeData: { reason: 'target_not_found', attackerId: action.attackerId },
        });
        continue;
      }

      await this.executeCombatAction(
        zoneManager,
        {
          id: attackerEntity.id,
          position: attackerEntity.position,
          type: attackerEntity.type,
        },
        {
          id: targetEntity.id,
          position: targetEntity.position,
          type: targetEntity.type,
        },
        action.ability,
        { isQueued: true }
      );
    }
  }

  /**
   * Process auto-attacks for all entities whose weapon timer is ready
   * Auto-attack runs on weapon speed, separate from ATB (which is for abilities)
   */
  private async processAutoAttacks(): Promise<void> {
    const basicAttack = this.abilitySystem.getDefaultAbility();
    const readyAttackers = this.combatManager.getAutoAttackersReady();

    for (const { attackerId, targetId } of readyAttackers) {
      // Find which zone the attacker is in
      const zoneId = this.characterToZone.get(attackerId) || this.companionToZone.get(attackerId);
      if (!zoneId) {
        this.combatManager.clearAutoAttackTarget(attackerId);
        continue;
      }

      const zoneManager = this.zones.get(zoneId);
      if (!zoneManager) {
        this.combatManager.clearAutoAttackTarget(attackerId);
        continue;
      }

      const attackerEntity = zoneManager.getEntity(attackerId);
      const targetEntity = zoneManager.getEntity(targetId);

      // Clear auto-attack if attacker or target no longer exists/is dead
      if (!attackerEntity || !attackerEntity.isAlive) {
        this.combatManager.clearAutoAttackTarget(attackerId);
        continue;
      }

      if (!targetEntity || !targetEntity.isAlive) {
        this.combatManager.clearAutoAttackTarget(attackerId);
        // Notify attacker that target is gone
        const socketId = zoneManager.getSocketIdForEntity(attackerId);
        if (socketId) {
          await this.messageBus.publish('gateway:output', {
            type: MessageType.CLIENT_MESSAGE,
            characterId: attackerId,
            socketId,
            payload: {
              socketId,
              event: 'event',
              data: {
                eventType: 'auto_attack_stopped',
                reason: 'target_dead',
                narrative: 'Your target is no longer alive.',
                timestamp: Date.now(),
              },
            },
            timestamp: Date.now(),
          });
        }
        continue;
      }

      // Reset the weapon timer before executing (so next attack waits full duration)
      this.combatManager.resetAutoAttackTimer(attackerId);

      // Execute the auto-attack (does NOT consume ATB - auto-attacks are free)
      await this.executeCombatAction(
        zoneManager,
        {
          id: attackerEntity.id,
          position: attackerEntity.position,
          type: attackerEntity.type,
        },
        {
          id: targetEntity.id,
          position: targetEntity.position,
          type: targetEntity.type,
        },
        basicAttack,
        { isAutoAttack: true }
      );
    }
  }

  /**
   * Handle position updates from movement system
   */
  private async handleMovementUpdates(updates: Map<string, Vector3>): Promise<void> {
    const zoneUpdates = new Set<string>();

    for (const [characterId, position] of updates) {
      const zoneId = this.characterToZone.get(characterId);
      if (!zoneId) continue;

      const zoneManager = this.zones.get(zoneId);
      if (!zoneManager) continue;

      // Update position in zone manager
      zoneManager.updatePlayerPosition(characterId, position);
      zoneUpdates.add(zoneId);

      // Broadcast state_update to all players in the zone
      await this.broadcastPositionUpdate(characterId, zoneId, position);

      // Send proximity roster to moving player
      await this.sendProximityRosterToEntity(characterId);
    }

    // Broadcast proximity roster updates to all affected zones
    for (const zoneId of zoneUpdates) {
      await this.broadcastNearbyUpdate(zoneId);
    }
  }

  /**
   * Called when movement completes (reached destination, stopped, etc.)
   */
  private async onMovementComplete(
    characterId: string,
    reason: 'command' | 'distance_reached' | 'target_reached' | 'target_lost' | 'boundary',
    finalPosition: Vector3
  ): Promise<void> {
    const zoneId = this.characterToZone.get(characterId);
    if (!zoneId) return;

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    // Update position one final time
    zoneManager.updatePlayerPosition(characterId, finalPosition);

    // Broadcast final position update with idle animation state
    await this.broadcastPositionUpdate(characterId, zoneId, finalPosition);

    // Get socket ID to notify player
    const socketId = zoneManager.getSocketIdForCharacter(characterId);
    if (socketId) {
      // Build narrative message based on reason
      let narrative: string;
      switch (reason) {
        case 'distance_reached':
          narrative = 'You arrive at your destination.';
          break;
        case 'target_reached':
          narrative = 'You reach your target.';
          break;
        case 'target_lost':
          narrative = 'You stop moving. Target lost.';
          break;
        case 'boundary':
          narrative = 'You stop at the zone boundary.';
          break;
        default:
          narrative = 'You stop moving.';
      }

      // Send movement complete event to player
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId,
        socketId,
        payload: {
          socketId,
          event: 'event',
          data: {
            eventType: 'movement_complete',
            reason,
            narrative,
            position: finalPosition,
            timestamp: Date.now(),
          },
        },
        timestamp: Date.now(),
      });
    }

    // Final proximity update
    await this.sendProximityRosterToEntity(characterId);
    await this.broadcastNearbyUpdate(zoneId);

    logger.debug({ characterId, reason, position: finalPosition }, 'Movement completed');
  }

  private async handleCombatTimeouts(expired: string[]): Promise<void> {
    for (const entityId of expired) {
      const zoneId = this.characterToZone.get(entityId) || this.companionToZone.get(entityId);
      if (!zoneId) continue;
      const zoneManager = this.zones.get(zoneId);
      if (!zoneManager) continue;
      const entity = zoneManager.getEntity(entityId);
      if (!entity) continue;

      // Clear auto-attack when combat times out
      this.combatManager.clearAutoAttackTarget(entityId);
      this.combatManager.clearQueuedActionsForEntity(entityId);

      zoneManager.setEntityCombatState(entityId, false);
      await this.broadcastNearbyUpdate(zoneId);
      await this.broadcastCombatEvent(zoneId, entity.position, {
        eventType: 'combat_end',
        timestamp: Date.now(),
        eventTypeData: { entityId },
      });
    }
  }

  /**
   * Get world statistics
   */
  getStats(): { totalZones: number; loadedZones: number; totalPlayers: number } {
    let totalPlayers = 0;

    for (const zoneManager of this.zones.values()) {
      totalPlayers += zoneManager.getPlayerCount();
    }

    return {
      totalZones: this.zones.size,
      loadedZones: this.zones.size,
      totalPlayers,
    };
  }

  // ========== Corruption System Helpers ==========

  /**
   * Get zone corruption data for all managed zones
   */
  private getZoneCorruptionData(): ZoneCorruptionData[] {
    const data: ZoneCorruptionData[] = [];

    for (const [zoneId, zoneManager] of this.zones.entries()) {
      const corruptionTag = this.zoneCorruptionTags.get(zoneId) || 'WILDS';
      const characterIds: string[] = [];

      // Get all player character IDs in this zone
      for (const [charId, charZoneId] of this.characterToZone.entries()) {
        if (charZoneId === zoneId) {
          characterIds.push(charId);
        }
      }

      if (characterIds.length > 0) {
        data.push({
          zoneId,
          corruptionTag,
          characterIds,
        });
      }
    }

    return data;
  }

  /**
   * Check if a character is currently "in community" for corruption purposes
   * A character is in community if they are near other players (within radius, min count)
   */
  private isCharacterInCommunity(characterId: string, zoneId: string): boolean {
    const config = getCorruptionConfig();
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return false;

    const character = zoneManager.getEntity(characterId);
    if (!character) return false;

    const radiusMeters = config.community_detection.nearby_player_radius_meters;
    const minCount = config.community_detection.nearby_player_min_count;

    // Get nearby entities (use getEntitiesInRange which excludes the character automatically)
    const nearbyEntities = zoneManager.getEntitiesInRange(
      character.position,
      radiusMeters / FEET_TO_METERS, // Convert to feet for internal spatial system
      characterId // Exclude self
    );

    // Filter for players only
    const nearbyPlayers = nearbyEntities.filter(e => e.type === 'player');

    return nearbyPlayers.length >= minCount;
  }

  /**
   * Get party size for a character (for corruption field reduction)
   * Returns 1 for solo players, up to 5 for full party
   */
  private async getCharacterPartySize(characterId: string): Promise<number> {
    try {
      const partyId = await this.partyService.getPartyIdForMember(characterId);
      if (!partyId) {
        return 1; // Solo player
      }

      const partyInfo = await this.partyService.getPartyInfo(partyId);
      if (!partyInfo) {
        return 1;
      }

      return partyInfo.members.length;
    } catch (error) {
      // Default to solo on error
      return 1;
    }
  }

  /**
   * Broadcast corruption update to a specific character
   */
  private async broadcastCorruptionUpdate(
    characterId: string,
    corruption: number,
    state: CorruptionState,
    previousState: CorruptionState | null,
    delta: number
  ): Promise<void> {
    const zoneId = this.characterToZone.get(characterId);
    if (!zoneId) return;

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const socketId = zoneManager.getSocketIdForCharacter(characterId);
    if (!socketId) return;

    const message: any = {
      type: 'corruption_update',
      payload: {
        corruption,
        state,
        delta,
        timestamp: Date.now(),
      },
    };

    // Include previous state only on state change
    if (previousState !== null) {
      message.payload.previousState = previousState;
      message.payload.reason = `State changed from ${previousState} to ${state}`;

      // Also send updated benefits on state change
      const benefits = getCorruptionBenefits(state);
      if (benefits) {
        message.payload.benefits = {
          cacheDetectionBonus: benefits.cache_detection_bonus_pct,
          hazardResistBonus: benefits.hazard_resist_bonus_pct,
          deadSystemInterface: benefits.dead_system_interface,
        };
      }
    }

    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId,
      socketId,
      payload: {
        socketId,
        event: 'corruption_update',
        data: message.payload,
      },
      timestamp: Date.now(),
    });

    // Log state changes
    if (previousState !== null) {
      logger.info(
        { characterId, previousState, newState: state, corruption },
        'Character corruption state changed'
      );
    }
  }

  /**
   * Apply a forbidden action corruption spike to a character
   * Call this from game logic when a forbidden action occurs
   */
  async applyForbiddenCorruption(
    characterId: string,
    eventType: string,
    reason?: string
  ): Promise<void> {
    await this.corruptionSystem.applyForbiddenAction(characterId, eventType, reason);
  }

  /**
   * Add contribution points to a character (from community actions)
   */
  async addCharacterContribution(
    characterId: string,
    points: number,
    source: string
  ): Promise<void> {
    await this.corruptionSystem.addContribution(characterId, points, source);
  }

  /**
   * Get corruption system reference for external access
   */
  getCorruptionSystem(): CorruptionSystem {
    return this.corruptionSystem;
  }

  /**
   * Cleanup on shutdown
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down distributed world manager');

    // Clear corruption system
    this.corruptionSystem.clear();

    // Clear all active movements (persists final positions)
    this.movementSystem.clearAll();

    for (const timer of this.respawnTimers.values()) {
      clearTimeout(timer);
    }
    this.respawnTimers.clear();

    // Unregister zone managers from movement system
    for (const zoneId of this.zones.keys()) {
      this.movementSystem.unregisterZoneManager(zoneId);
      await this.zoneRegistry.unassignZone(zoneId);
    }

    this.zones.clear();
    this.characterToZone.clear();
    this.companionToZone.clear();
    this.wildlifeManagers.clear();
    this.zoneCorruptionTags.clear();
  }
}
