import { logger } from '@/utils/logger';
import { CharacterService, CompanionService, ZoneService } from '@/database';
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
import type { CombatAbilityDefinition, CombatStats } from '@/combat/types';
import type { MovementSpeed, Vector3 } from '@/network/protocol/types';

const FEET_TO_METERS = 0.3048;
const COMBAT_EVENT_RANGE_METERS = 45.72; // 150 feet

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

    // Set up movement completion callback
    this.movementSystem.setMovementCompleteCallback(
      (characterId, reason, finalPosition) => this.onMovementComplete(characterId, reason, finalPosition)
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

      // Register with movement system for entity lookups
      this.movementSystem.registerZoneManager(zone.id, zoneManager);

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
      return;
    }

    zoneManager.addPlayer(character, socketId, isMachine ?? false);
    this.characterToZone.set(character.id, character.zoneId);

    // Update player location in registry
    await this.zoneRegistry.updatePlayerLocation(character.id, character.zoneId, socketId);

    // Calculate and send proximity roster
    await this.sendProximityRosterToEntity(character.id);

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
      return;
    }

    // Get current position from zone manager or database
    const entity = zoneManager.getEntity(characterId);
    if (!entity) {
      logger.warn({ characterId, zoneId }, 'Entity not found for movement');
      return;
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
      return;
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
      return;
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
      return;
    }

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const entity = zoneManager.getEntity(characterId);
    if (!entity || !entity.socketId) {
      logger.warn({ characterId, zoneId }, 'Command sender not found in zone');
      return;
    }

    const character = await CharacterService.findById(characterId);
    if (!character) {
      logger.warn({ characterId }, 'Command sender not found in database');
      return;
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

  private async executeCombatAction(
    zoneManager: ZoneManager,
    attackerEntity: { id: string; position: { x: number; y: number; z: number }; type: 'player' | 'npc' | 'companion' },
    targetEntity: { id: string; position: { x: number; y: number; z: number }; type: 'player' | 'npc' | 'companion' },
    ability: CombatAbilityDefinition,
    options?: { isAutoAttack?: boolean }
  ): Promise<void> {
    const isAutoAttack = options?.isAutoAttack ?? false;
    const characterId = attackerEntity.id;
    const targetId = targetEntity.id;
    const now = Date.now();

    const attackerSnapshot = await this.getCombatSnapshot(characterId, attackerEntity);
    const targetSnapshot = await this.getCombatSnapshot(targetId, targetEntity);
    if (!attackerSnapshot || !targetSnapshot) return;

    if (!this.validateRange(attackerEntity.position, targetEntity.position, ability)) {
      await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
        eventType: 'combat_error',
        timestamp: now,
        narrative: `Target out of range.`,
        eventTypeData: { reason: 'out_of_range', attackerId: characterId },
      });
      return;
    }

    const cooldownRemaining = this.combatManager.getCooldownRemaining(characterId, ability.id, now);
    if (cooldownRemaining > 0) {
      await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
        eventType: 'combat_error',
        timestamp: now,
        narrative: `Ability on cooldown.`,
        eventTypeData: { reason: 'cooldown', attackerId: characterId },
      });
      return;
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
        return;
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
        return;
      }
    }

    if (!this.canPayCosts(attackerSnapshot, ability)) {
      await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
        eventType: 'combat_error',
        timestamp: now,
        narrative: `Not enough resources.`,
        eventTypeData: { reason: 'insufficient_resources', attackerId: characterId },
      });
      return;
    }

    await this.applyCosts(attackerSnapshot, ability);
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

    this.combatManager.setCooldown(characterId, ability.id, ability.cooldown * 1000, now);
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
      const scalingValue = this.getScalingValue(attackerSnapshot, ability);
      const result = this.damageCalculator.calculate(
        ability,
        attackerSnapshot.stats,
        targetSnapshot.stats,
        scalingValue
      );

      if (!result.hit) {
        await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
          eventType: 'combat_miss',
          timestamp: now,
          eventTypeData: { attackerId: characterId, targetId, abilityId: ability.id },
        });
        return;
      }

      const newHp = Math.max(0, targetSnapshot.currentHealth - result.amount);
      await this.updateHealth(targetSnapshot, newHp);

      await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
        eventType: 'combat_hit',
        timestamp: now,
        eventTypeData: {
          attackerId: characterId,
          targetId,
          abilityId: ability.id,
          outcome: result.outcome,
          amount: result.amount,
          baseDamage: result.baseDamage,
          mitigatedDamage: result.mitigatedDamage,
        },
      });

      if (newHp <= 0) {
        zoneManager.setEntityAlive(targetId, false);
        zoneManager.setEntityCombatState(targetId, false);

        // Clear auto-attack for the dying target and all entities targeting it
        this.combatManager.clearAutoAttackTarget(targetId);
        this.combatManager.clearAutoAttacksOnTarget(targetId);

        await this.broadcastNearbyUpdate(zoneManager.getZone().id);

        await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
          eventType: 'combat_death',
          timestamp: now,
          eventTypeData: { targetId },
        });

        if (!targetSnapshot.isPlayer) {
          await this.scheduleMobRespawn(targetId, zoneManager.getZone().id, targetSnapshot.maxHealth);
        }
      }
    }
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

      return {
        entityId,
        isPlayer: true,
        currentHealth: character.currentHp,
        maxHealth: character.maxHp,
        currentStamina: character.currentStamina,
        currentMana: character.currentMana,
        coreStats,
        stats: this.buildCombatStats(derived),
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

    return {
      entityId,
      isPlayer: false,
      currentHealth: companion.currentHealth,
      maxHealth: companion.maxHealth,
      currentStamina: 0,
      currentMana: 0,
      coreStats,
      stats: this.buildCombatStats(derived),
    };
  }

  private buildCombatStats(derived: {
    attackRating: number;
    defenseRating: number;
    physicalAccuracy: number;
    evasion: number;
    damageAbsorption: number;
    glancingBlowChance: number;
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
      criticalHitChance: 5,
      penetratingBlowChance: 5,
      deflectedBlowChance: 5,
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

  private async scheduleMobRespawn(companionId: string, zoneId: string, maxHealth: number): Promise<void> {
    if (this.respawnTimers.has(companionId)) return;

    const companion = await CompanionService.findById(companionId);
    if (!companion || !companion.tag?.startsWith('mob.')) return;

    const timer = setTimeout(async () => {
      try {
        await CompanionService.updateStatus(companionId, { currentHealth: maxHealth, isAlive: true });
        const zoneManager = this.zones.get(zoneId);
        if (zoneManager) {
          zoneManager.setEntityAlive(companionId, true);
          zoneManager.setEntityCombatState(companionId, false);
          await this.broadcastNearbyUpdate(zoneId);
        }
      } finally {
        this.respawnTimers.delete(companionId);
      }
    }, 120000);

    this.respawnTimers.set(companionId, timer);
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

    // Clear previous roster so next send includes full data as delta.
    this.previousRosters.delete(characterId);

    await this.sendProximityRosterToEntity(characterId);
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

    // Build state_update message
    const stateUpdate = {
      timestamp: Date.now(),
      entities: {
        updated: [{
          id: characterId,
          name: entity.name,
          type: entity.type,
          position,
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
    const expired = this.combatManager.update(deltaTime, () => 0);
    if (expired.length > 0) {
      void this.handleCombatTimeouts(expired);
    }

    // Process auto-attacks for entities whose weapon timer is ready
    void this.processAutoAttacks();

    // Broadcast combat gauges to players in combat
    void this.broadcastCombatGauges();

    // Update movement system
    const positionUpdates = this.movementSystem.update(deltaTime);
    if (positionUpdates.size > 0) {
      void this.handleMovementUpdates(positionUpdates);
    }
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

  /**
   * Cleanup on shutdown
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down distributed world manager');

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
  }
}
