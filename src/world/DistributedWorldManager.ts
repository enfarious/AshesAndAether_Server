import { logger } from '@/utils/logger';
import { AccountService, CharacterService, CompanionService, MobService, ZoneService, InventoryService, LootService, prisma } from '@/database';
import { randomUUID } from 'crypto';
import type { LootSessionStartPayload, LootItemResultPayload, LootSessionEndPayload, LootSessionItem } from '@/network/protocol/types';
import { ZoneManager } from './ZoneManager';
import { MovementSystem, type MovementStartEvent } from './MovementSystem';
import { MessageBus, MessageType, ZoneRegistry, type MessageEnvelope, type ClientMessagePayload } from '@/messaging';
import { NPCAIController, LLMService } from '@/ai';
import { CommandRegistry, CommandParser, CommandExecutor, registerAllCommands, setArenaManager } from '@/commands';
import { ArenaManager } from '@/arena/ArenaManager';
import type { CommandContext, CommandEvent } from '@/commands/types';
import type { Character, Companion } from '@prisma/client';
import { StatCalculator } from '@/game/stats/StatCalculator';
import {
  unlockAbility,
  slotActiveAbility,
  slotPassiveAbility,
  getAbilitySummary,
  getNodeInfo,
  listWebNodes,
} from '@/game/abilities/tree';
import { CombatManager } from '@/combat/CombatManager';
import { AbilitySystem } from '@/combat/AbilitySystem';
import { DamageCalculator } from '@/combat/DamageCalculator';
import { buildCombatNarrative } from '@/combat/CombatNarratives';
import type { CombatAbilityDefinition, CombatStats, DamageProfileSegment, PhysicalDamageType } from '@/combat/types';
import type { DamageType } from '@/game/abilities/AbilityTypes';
import type { MovementSpeed, Vector3 } from '@/network/protocol/types';
import { WildlifeManager, getSpecies, type BiomeType } from '@/wildlife';
import { WildlifeBridge, type IWildlifeWorld, type PlayerPositionMessage } from '@/wildlife/WildlifeBridge';
import { FloraManager } from '@/wildlife/flora/FloraManager';
import { getPlantSpecies } from '@/wildlife/flora/species';
import { MobWanderSystem } from './MobWanderSystem';
import { WeatherBridge } from './WeatherBridge';
import { ClimateBridge } from './ClimateBridge';
import { PartyService } from '@/party/PartyService';
import { buildDamageProfiles, getPrimaryDamageType, getPrimaryPhysicalType, getWeaponDefinition, getWeaponRange, UNARMED_RANGE } from '@/items/WeaponData';
import { buildQualityBiasMultipliers, type QualityBiasMultipliers } from '@/items/ArmorData';
import {
  CorruptionSystem,
  getCorruptionConfig,
  getCorruptionBenefits,
  type CorruptionState,
  type ZoneCorruptionData,
} from '@/corruption';
import { MarketBridge } from '@/market/MarketBridge';
import { SpawnPointService } from '@/world/SpawnPointService';
import { VillageService } from '@/village';

const FEET_TO_METERS = 0.3048;
const PHYSICS_DEBUG = process.env.PHYSICS_DEBUG === 'true';
const COMBAT_EVENT_RANGE_METERS = 45.72; // 150 feet

// ── Range-check geometry ───────────────────────────────────────────────────
// Every entity is registered with a 0.5 m bounding sphere.
// Effective melee reach = arm reach past the sphere edge + both radii + weapon.
const ENTITY_RADIUS = 0.5; // metres — matches PhysicsSystem bounding sphere
const BASE_REACH    = 1.0; // metres — arm reach beyond sphere edge (H2H baseline)

const BIOME_FALLBACK: BiomeType = 'forest';
const PARTY_MAX_MEMBERS = 5;
const PARTY_STATUS_INTERVAL_MS = 1000;

/** Map WildlifeManager behavior strings to client animation action names. */
function _wildlifeBehaviorToAnimation(behavior: string): string {
  switch (behavior) {
    case 'fleeing':
    case 'hunting':
      return 'running';
    case 'wandering':
    case 'foraging':
    case 'stalking':
    case 'seeking_mate':
    case 'migrating':
      return 'walking';
    case 'dead':
    case 'dying':
      return 'dead';
    default:
      // idle, resting, eating, drinking, mating, defending, attacking
      return 'idle';
  }
}

/**
 * Distributed World Manager - manages zones across multiple servers
 *
 * This version uses Redis pub/sub for inter-server communication
 * instead of direct Socket.IO access
 */
export class DistributedWorldManager implements IWildlifeWorld {
  private zones: Map<string, ZoneManager> = new Map();
  private zoneBiomes: Map<string, BiomeType> = new Map();
  private characterToZone: Map<string, string> = new Map();
  private companionToZone: Map<string, string> = new Map();
  private npcControllers: Map<string, NPCAIController> = new Map(); // companionId -> controller
  private llmService: LLMService;
  private wildlifeBridge: WildlifeBridge | null = null;
  private recentChatMessages: Map<string, { sender: string; channel: string; message: string; timestamp: number }[]> = new Map(); // zoneId -> messages
  private proximityRosterHashes: Map<string, string> = new Map(); // characterId -> roster hash (for dirty checking - legacy)
  private previousRosters: Map<string, any> = new Map(); // characterId -> previous roster (for delta calculation)
  private combatManager: CombatManager;
  private abilitySystem: AbilitySystem;
  private damageCalculator: DamageCalculator;
  private respawnTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Timestamps (ms) of the last /unstuck use per characterId — enforces cooldown. */
  private readonly unstuckCooldowns = new Map<string, number>();
  private movementSystem: MovementSystem;
  private attackSpeedBonusCache: Map<string, number> = new Map();
  private wildlifeManagers: Map<string, WildlifeManager> = new Map();
  private floraManagers:   Map<string, FloraManager>    = new Map();
  private mobWanderSystems: Map<string, MobWanderSystem> = new Map();
  private weatherBridges:  Map<string, WeatherBridge>  = new Map();
  private climateBridges:  Map<string, ClimateBridge>  = new Map();
  private partyService: PartyService;
  private partyResourceCache: Map<string, { currentStamina: number; maxStamina: number; currentMana: number; maxMana: number }> = new Map();
  private lastPartyStatusBroadcastAt: number = 0;
  private physicsLogAccumulator: number = 0;
  /** Last broadcast environment key per zone — used to suppress no-op broadcasts. */
  private lastEnvKeys: Map<string, string> = new Map();
  /** Accumulated seconds since the ZoneRegistry env value was last refreshed (even without a bucket change). */
  private envRegistryRefreshAccum: number = 0;
  /** Refresh ZoneRegistry env every 60 s so stale mid-bucket values don't persist. */
  private static readonly ENV_REGISTRY_REFRESH_SECS = 60;

  // Corruption system
  private corruptionSystem: CorruptionSystem;
  private zoneCorruptionTags: Map<string, string> = new Map(); // zoneId -> corruptionTag

  // Market system
  private marketBridge: MarketBridge;

  // ── Village instance system ──────────────────────────────────────────────
  private villageInstances: Map<string, {
    zoneManager: ZoneManager;
    ownerCharacterId: string;
    playerCount: number;
    idleTimer: NodeJS.Timeout | null;
  }> = new Map();

  // Command system
  private commandRegistry: CommandRegistry;
  private commandParser: CommandParser;
  private commandExecutor: CommandExecutor | null = null;

  // Arena system
  private arenaManager: ArenaManager;

  // ── Loot system ────────────────────────────────────────────────────────────
  /** characterId → socketId for targeted loot messages */
  private _charToSocket: Map<string, string> = new Map();
  /** characterId → character level cache for XP scaling */
  private _charLevel: Map<string, number> = new Map();

  // ── Wildlife position broadcast ─────────────────────────────────────────
  /**
   * Per-zone queue of wildlife entity updates collected during the current
   * tick.  Flushed once per tick as a single batched state_update so we
   * don't spam clients with one packet per animal per 500 ms.
   */
  private _pendingWildlifeUpdates: Map<string, Array<{
    id: string; name: string; type: 'wildlife';
    position: { x: number; y: number; z: number };
    heading: number; currentAction: string;
    movementDuration: number; movementSpeed: number;
  }>> = new Map();

  /** per-mob damage log: mobId → { firstAttackerId, damages, killerId, zoneId } */
  private _damageLog: Map<string, {
    firstAttackerId: string;
    damages:         Map<string, number>;
    killerId:        string;
    zoneId:          string;
  }> = new Map();

  /** Active NWP loot sessions: sessionId → session state */
  private _lootSessions: Map<string, {
    sessionId:       string;
    zoneId:          string;
    mobName:         string;
    memberCharIds:   string[];
    items: {
      id:          string;
      templateId:  string;
      name:        string;
      itemType:    string;
      description: string;
      iconUrl?:    string;
      quantity:    number;
      rolls:       Map<string, 'need' | 'want' | 'pass' | null>;
      resolved:    boolean;
    }[];
    gold:      number;
    expiresAt: number;
    timer:     NodeJS.Timeout;
  }> = new Map();

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
      (characterId, reason, finalPosition, source) => this.onMovementComplete(characterId, reason, finalPosition, source)
    );

    // Initialize corruption system
    this.corruptionSystem = new CorruptionSystem();

    // Initialize market bridge
    this.marketBridge = new MarketBridge(this.messageBus);

    // Start the Rust wildlife-sim bridge (connects to wildlife:events Redis channel)
    this.wildlifeBridge = new WildlifeBridge(this.messageBus, this);
    void this.wildlifeBridge.start();
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

    // Initialize arena system
    this.arenaManager = new ArenaManager(
      // broadcast: send an event to specific character IDs via the gateway
      (instanceId, recipientIds, event, data) => {
        for (const charId of recipientIds) {
          const sid = this._charToSocket.get(charId);
          if (!sid) continue;
          void this.messageBus.publish('gateway:output', {
            type: MessageType.CLIENT_MESSAGE,
            characterId: charId,
            socketId: sid,
            payload: { socketId: sid, event, data },
            timestamp: Date.now(),
          });
        }
      },
      // setCombatEnabled: placeholder — ArenaManager.isCombatEnabled() is the
      // query-side gate; this callback is for future CombatManager integration
      (_instanceId, _combatantIds, _enabled) => {
        // TODO: wire into CombatManager PvP gating when that system exists
      },
      // setAIActive: toggle NPC AI controllers on/off
      (entityId, active) => {
        const controller = this.npcControllers.get(entityId);
        if (controller) {
          logger.debug({ entityId, active }, 'Arena toggling AI');
          // NPCAIController doesn't have pause/resume yet — stub for now
        }
      },
    );
    setArenaManager(this.arenaManager);
    logger.info('Arena system initialized');
  }

  /**
   * Initialize world manager - load assigned zones
   */
  async initialize(): Promise<void> {
    logger.info({ serverId: this.serverId, zoneCount: this.assignedZoneIds.length }, 'Initializing distributed world manager');

    // If no zones assigned, load all zones (for single-server mode)
    if (this.assignedZoneIds.length === 0) {
      const allZones = await ZoneService.findAll();
      // Filter out village zones — they are spun up on demand, not at startup
      this.assignedZoneIds = allZones.filter(z => !VillageService.isVillageZone(z.id)).map(z => z.id);
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
      this.zoneBiomes.set(zone.id, biomeType);
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
          // Queue position update for batched broadcast this tick
          if (!this._pendingWildlifeUpdates.has(zone.id)) {
            this._pendingWildlifeUpdates.set(zone.id, []);
          }
          const species = getSpecies(entity.speciesId);
          const isFleeing = entity.currentBehavior === 'fleeing' || entity.currentBehavior === 'hunting';
          const entitySpeed = species
            ? (isFleeing ? species.baseSpeed * species.fleeSpeedMultiplier : species.baseSpeed)
            : 2.0;
          this._pendingWildlifeUpdates.get(zone.id)!.push({
            id: entity.id,
            name: entity.name,
            type: 'wildlife',
            position: entity.position,
            heading: entity.heading,
            currentAction: _wildlifeBehaviorToAnimation(entity.currentBehavior),
            movementDuration: 520,   // slightly longer than tick interval for smooth lerp
            movementSpeed: entitySpeed,
          });
        },
        onEntityDeath: (entity, killerId) => {
          zoneManager.removeWildlife(entity.id);
          void this.broadcastNearbyUpdate(zone.id);
          // Award loot to the player who killed it
          if (killerId && this._charToSocket.has(killerId)) {
            void this._awardWildlifeLoot(entity, killerId);
          }
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

      // Initialize flora manager for this zone
      const floraManager = new FloraManager(zone.id, biomeType);
      floraManager.setCallbacks({
        onPlantSpawn: (plant) => {
          // Notify clients of the new plant entity
          void this._broadcastPlantToZone(zone.id, plant.id, plant.speciesId, plant.position, plant.currentStage, 'added');
        },
        onPlantUpdate: (plant) => {
          void this._broadcastPlantToZone(zone.id, plant.id, plant.speciesId, plant.position, plant.currentStage, 'updated');
        },
        onPlantHarvest: (plant, harvesterId, items) => {
          // Award items to the harvester
          void this._awardHarvestItems(harvesterId, items);
          if (!plant.isAlive) {
            void this._broadcastPlantRemoved(zone.id, plant.id);
          } else {
            void this._broadcastPlantToZone(zone.id, plant.id, plant.speciesId, plant.position, plant.currentStage, 'updated');
          }
          // Notify Rust sim
          void this.wildlifeBridge?.reportPlantHarvest(plant.id, harvesterId);
        },
      });
      // Seed some plants immediately so the zone isn't bare at startup
      floraManager.seedInitialPlants();
      this.floraManagers.set(zone.id, floraManager);

      // Register all living mobs with the wander system
      const wanderSystem = new MobWanderSystem();
      for (const entity of zoneManager.getAllEntities()) {
        if (entity.type === 'mob' && entity.isAlive) {
          wanderSystem.register(entity.id, entity.position);
        }
      }
      this.mobWanderSystems.set(zone.id, wanderSystem);

      // Initialize weather & climate bridges for this zone
      {
        const halfX = zone.sizeX / 2;
        const halfZ = zone.sizeZ / 2;
        const boundsMin = { x: zone.worldX - halfX, z: zone.worldY - halfZ };
        const boundsMax = { x: zone.worldX + halfX, z: zone.worldY + halfZ };

        const redisClient = this.messageBus.getClient();
        const weatherBridge = new WeatherBridge(zone.id, redisClient, boundsMin, boundsMax);
        this.weatherBridges.set(zone.id, weatherBridge);

        const climateBridge = new ClimateBridge(zone.id, redisClient);
        this.climateBridges.set(zone.id, climateBridge);
      }

      // Initialize NPC AI controllers for this zone
      await this.initializeNPCsForZone(zoneId);

      // Register zone in registry
      await this.zoneRegistry.assignZone(zoneId, this.serverId);

      // Write live environment immediately so the gateway has a fresh timeOfDayValue
      // for any world_entry packets sent before the first bucket transition fires.
      await this.zoneRegistry.setZoneEnvironment(zoneId, {
        timeOfDay:      zoneManager.getTimeOfDayString(),
        timeOfDayValue: zoneManager.getTimeOfDayNormalized(),
        weather:        zoneManager.getWeather(),
        lighting:       zoneManager.getLighting(),
      });

      // Publish authoritative entity positions so the gateway can use them at world_entry
      await this.publishZoneEntities(zone.id, zoneManager);
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

    logger.info({ zones: Array.from(this.zones.keys()) }, '[DWM] Subscribed to zone input channels');
  }

  /**
   * Handle incoming zone message from Redis
   */
  private handleZoneMessage(message: MessageEnvelope): void {
    logger.info({ type: message.type, characterId: (message as any).characterId }, '[DWM] handleZoneMessage received');
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
      case MessageType.PLAYER_RESPAWN:
        void this.handlePlayerRespawn(message);
        break;
      case MessageType.PLAYER_ACTION: {
        const actionPayload = message.payload as { action?: string };
        if (actionPayload.action === 'loot_roll') {
          void this._handleLootRoll(message);
        } else if (actionPayload.action === 'village_place') {
          void this._handleVillagePlace(message);
        }
        break;
      }
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
    this._charToSocket.set(character.id, socketId);
    this._charLevel.set(character.id, character.level);
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

    // Send current plant entities so the client can render flora
    await this._sendPlantsToPlayer(character.id, character.zoneId);

    // Send structure entities for village zones (belt-and-suspenders — world_entry
    // should already include them, but this guarantees they appear)
    await this._sendStructuresToPlayer(character.id, character.zoneId);

    // Send village_state event for VillagePanel UI
    await this._sendVillageStateToPlayer(character.id, character.zoneId);

    // Correct the player's clock — world_entry may carry a stale timeOfDayValue from
    // ZoneRegistry (which only updates on bucket transitions, up to ~12 min intervals).
    // Sending the live value now overwrites it via applyZonePartial on the client.
    await this._sendEnvToPlayer(character.id, character.zoneId);

    // ── Entity exchange: make joining player and existing players see each other ──
    // The world_entry Redis snapshot intentionally excludes players (they move too
    // frequently), so we need to send them explicitly via state_update.
    await this._exchangePlayerEntities(character, zoneManager);

    // ── Village instance tracking ──
    const villageInst = this.villageInstances.get(character.zoneId);
    if (villageInst) {
      if (villageInst.idleTimer) { clearTimeout(villageInst.idleTimer); villageInst.idleTimer = null; }
      villageInst.playerCount++;
    }

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
    this._charToSocket.delete(characterId);
    this._charLevel.delete(characterId);

    // Clean up proximity roster data
    this.proximityRosterHashes.delete(characterId);
    this.previousRosters.delete(characterId);
    this.attackSpeedBonusCache.delete(characterId);

    // Clean up corruption tracking
    this.corruptionSystem.removeCharacter(characterId);
    this.partyResourceCache.delete(characterId);

    // Remove from registry
    await this.zoneRegistry.removePlayer(characterId);

    // Tell remaining clients to remove this player's entity from their scene
    const removePayload = {
      timestamp: Date.now(),
      entities: { removed: [characterId] },
    };
    for (const [charId, charZoneId] of this.characterToZone.entries()) {
      if (charZoneId !== zoneId) continue;
      const socketId = zoneManager.getSocketIdForCharacter(charId);
      if (!socketId) continue;
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId: charId,
        socketId,
        payload: { socketId, event: 'state_update', data: removePayload },
        timestamp: Date.now(),
      });
    }

    // Broadcast proximity updates
    await this.broadcastNearbyUpdate(zoneId);

    // ── Village instance tracking: tear down when empty ──
    const villageInstLeave = this.villageInstances.get(zoneId);
    if (villageInstLeave) {
      villageInstLeave.playerCount = Math.max(0, villageInstLeave.playerCount - 1);
      if (villageInstLeave.playerCount === 0) {
        villageInstLeave.idleTimer = setTimeout(() => {
          void this.tearDownVillageInstance(zoneId);
        }, 60_000);
      }
    }

    logger.info({ characterId, zoneId }, 'Player left zone');
  }

  // ── Village instance lifecycle ──────────────────────────────────────────

  /**
   * Spin up a village zone instance. Creates a lightweight ZoneManager with
   * the plot template terrain and placed structures as entities.
   */
  private async spinUpVillageInstance(ownerCharacterId: string): Promise<string> {
    const zoneId = VillageService.villageZoneId(ownerCharacterId);

    // Already running?
    if (this.villageInstances.has(zoneId)) {
      const inst = this.villageInstances.get(zoneId)!;
      if (inst.idleTimer) { clearTimeout(inst.idleTimer); inst.idleTimer = null; }
      // Refresh Redis entity snapshot so the gateway's enterWorld() picks up structures
      await this.publishZoneEntities(zoneId, inst.zoneManager);
      return zoneId;
    }

    const village = await VillageService.getVillage(ownerCharacterId);
    if (!village) throw new Error('Village not found');

    // The Zone DB record was created by VillageService.createVillage()
    const zone = await ZoneService.findById(zoneId);
    if (!zone) throw new Error('Village zone record not found in DB');

    const zoneManager = new ZoneManager(zone);
    await zoneManager.initialize();

    // Add placed structures as 'structure' entities
    for (const struct of village.structures) {
      zoneManager.addStructure({
        id: struct.id,
        name: struct.catalog.displayName,
        description: struct.catalog.description ?? undefined,
        position: { x: struct.positionX, y: struct.positionY, z: struct.positionZ },
      });
    }

    // Subscribe to the village zone's input channel
    const channel = `zone:${zoneId}:input`;
    await this.messageBus.subscribe(channel, (message: MessageEnvelope) => this.handleZoneMessage(message));

    // Register in zone maps
    this.zones.set(zoneId, zoneManager);
    this.movementSystem.registerZoneManager(zoneId, zoneManager);
    this.villageInstances.set(zoneId, {
      zoneManager,
      ownerCharacterId,
      playerCount: 0,
      idleTimer: null,
    });

    // Register in ZoneRegistry so gateway can find it
    await this.zoneRegistry.assignZone(zoneId, this.serverId);

    // Publish entities to Redis for world_entry
    await this.publishZoneEntities(zoneId, zoneManager);

    // Write environment so gateway has env data
    await this.zoneRegistry.setZoneEnvironment(zoneId, {
      timeOfDay: zoneManager.getTimeOfDayString(),
      timeOfDayValue: zoneManager.getTimeOfDayNormalized(),
      weather: zoneManager.getWeather(),
      lighting: zoneManager.getLighting(),
    });

    logger.info({ zoneId, owner: ownerCharacterId }, 'Village instance spun up');
    return zoneId;
  }

  /**
   * Tear down a village instance after idle timeout.
   */
  private async tearDownVillageInstance(zoneId: string): Promise<void> {
    const inst = this.villageInstances.get(zoneId);
    if (!inst) return;
    if (inst.idleTimer) clearTimeout(inst.idleTimer);

    // Don't tear down if players are still in it
    if (inst.playerCount > 0) return;

    // Unsubscribe from Redis channel
    const channel = `zone:${zoneId}:input`;
    await this.messageBus.unsubscribe(channel);

    // Unregister from ZoneRegistry
    await this.zoneRegistry.unassignZone(zoneId);

    // Remove from local maps
    this.zones.delete(zoneId);
    this.movementSystem.unregisterZoneManager(zoneId);
    this.villageInstances.delete(zoneId);

    logger.info({ zoneId }, 'Village instance torn down');
  }

  /**
   * Handle village_place action — player confirmed structure placement.
   */
  private async _handleVillagePlace(message: MessageEnvelope): Promise<void> {
    const { characterId, catalogId, posX, posZ, rotation } = message.payload as {
      characterId: string;
      catalogId: string;
      posX: number;
      posZ: number;
      rotation: number;
      action: string;
    };

    const zoneId = this.characterToZone.get(characterId);
    if (!zoneId || !VillageService.isVillageZone(zoneId)) return;

    const ownerCharId = VillageService.extractOwnerCharacterId(zoneId);
    if (ownerCharId !== characterId) {
      logger.warn({ characterId, zoneId }, 'Non-owner attempted to place structure');
      return;
    }

    const village = await VillageService.getVillage(characterId);
    if (!village) return;

    try {
      const structure = await VillageService.placeStructure(village.id, catalogId, posX, posZ, rotation);

      // Add entity to ZoneManager
      const zm = this.zones.get(zoneId);
      if (zm) {
        zm.addStructure({
          id: structure.id,
          name: structure.catalog.displayName,
          description: structure.catalog.description ?? undefined,
          position: { x: structure.positionX, y: structure.positionY, z: structure.positionZ },
        });
        await this.publishZoneEntities(zoneId, zm);
      }

      // If this is a market_stall, create the MarketStall DB record
      if (structure.catalog.name === 'market_stall') {
        try {
          // Find the region via the character's return zone (their overworld location)
          const character = await prisma.character.findUnique({
            where: { id: characterId },
            select: { name: true, returnZoneId: true },
          });
          const returnZoneId = character?.returnZoneId;
          const region = returnZoneId
            ? await prisma.region.findFirst({ where: { zoneIds: { has: returnZoneId } } })
            : await prisma.region.findFirst(); // fallback to any region

          if (region) {
            await VillageService.createMarketStall(
              structure.id,
              characterId,
              region.id,
              zoneId!,
              { x: structure.positionX, y: structure.positionY, z: structure.positionZ },
              character?.name,
            );
            logger.info({ characterId, stallRegion: region.name }, 'Market stall DB record created');
          }
        } catch (stallErr) {
          logger.error({ error: stallErr }, 'Failed to create market stall record (structure placed OK)');
        }
      }

      // Broadcast new entity to all players in the village
      const addedPayload = {
        timestamp: Date.now(),
        entities: {
          added: [{
            id: structure.id,
            name: structure.catalog.displayName,
            type: 'structure' as const,
            position: { x: structure.positionX, y: structure.positionY, z: structure.positionZ },
            isAlive: true,
          }],
        },
      };

      for (const [charId, charZoneId] of this.characterToZone.entries()) {
        if (charZoneId !== zoneId) continue;
        const sid = this._charToSocket.get(charId);
        if (!sid) continue;
        await this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          characterId: charId,
          socketId: sid,
          payload: { socketId: sid, event: 'state_update', data: addedPayload },
          timestamp: Date.now(),
        });
      }

      // Send success message to placer
      const sid = this._charToSocket.get(characterId);
      if (sid) {
        await this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          characterId,
          socketId: sid,
          payload: {
            socketId: sid,
            event: 'chat_message',
            data: {
              channel: 'system',
              message: `Placed ${structure.catalog.displayName}.`,
            },
          },
          timestamp: Date.now(),
        });
      }
    } catch (err: any) {
      const sid = this._charToSocket.get(characterId);
      if (sid) {
        await this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          characterId,
          socketId: sid,
          payload: {
            socketId: sid,
            event: 'chat_message',
            data: {
              channel: 'system',
              message: `Failed to place structure: ${err.message}`,
            },
          },
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * Handle player movement
   */
  private async handlePlayerMove(message: MessageEnvelope): Promise<void> {
    const { characterId, zoneId, method, position, heading, speed } = message.payload as {
      characterId: string;
      zoneId: string;
      method?: 'position' | 'heading' | 'compass' | 'continuous';
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
        source: 'direct', // Real-time socket move — no narrative on completion
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
        targetRange: 500, // large range — client sends explicit stop on key release
        source: 'direct', // Real-time socket move — no narrative on completion
      });

      if (started) {
        logger.debug({ characterId, heading, speed: movementSpeed }, 'Player movement started (heading)');
      }
    } else if (method === 'continuous' && heading !== undefined) {
      // Continuous movement: if already moving, just update heading + heartbeat.
      // Otherwise start fresh.  Client sends updates at ~10 Hz as a keepalive;
      // server auto-stops if heartbeat expires (see MovementSystem).
      if (this.movementSystem.isMoving(characterId)) {
        this.movementSystem.updateHeading(characterId, heading);
      } else {
        const started = await this.movementSystem.startMovement({
          characterId,
          zoneId,
          startPosition,
          heading,
          speed: movementSpeed,
          targetRange: 0,   // no target — runs until explicit stop or heartbeat timeout
          source: 'direct',
        });
        if (started) {
          // Enable heartbeat tracking for this movement
          this.movementSystem.refreshHeartbeat(characterId);
          logger.debug({ characterId, heading, speed: movementSpeed }, 'Continuous movement started');
        }
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
      channel: 'say' | 'shout' | 'emote' | 'cfh' | 'touch' | 'party';
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

    // ── Party chat: broadcast to all party members regardless of zone ────
    if (channel === 'party') {
      const partyId = await this.partyService.getPartyIdForMember(characterId);
      if (!partyId) {
        logger.warn({ characterId }, '[handlePlayerChat] Party chat but player has no party');
        return;
      }
      const party = await this.partyService.getPartyInfo(partyId);
      if (!party) return;

      const chatData = {
        channel: 'party',
        sender: sender.name,
        senderId: characterId,
        message: text,
        timestamp: Date.now(),
      };

      for (const memberId of party.members) {
        const location = await this.zoneRegistry.getPlayerLocation(memberId);
        if (!location) continue;
        await this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          characterId: memberId,
          socketId: location.socketId,
          payload: { socketId: location.socketId, event: 'chat', data: chatData },
          timestamp: Date.now(),
        });
      }
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

    // Echo the message back to the sender so they see their own chat
    const senderSocketId = this._charToSocket.get(characterId);
    if (senderSocketId) {
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId,
        socketId: senderSocketId,
        payload: {
          socketId: senderSocketId,
          event: 'chat',
          data: {
            channel,
            sender: sender.name,
            senderId: characterId,
            message: formattedMessage,
            timestamp: Date.now(),
          },
        },
        timestamp: Date.now(),
      });
    }

    // Track message for NPC AI context
    this.trackChatMessage(zoneId, sender.name, channel, formattedMessage);

    // Trigger NPC responses
    await this.triggerNPCResponses(zoneId, senderPosition, range);

    logger.debug({ characterId, channel, recipientCount: nearbySocketIds.length + 1 }, 'Chat message broadcast');
  }

  private async handlePlayerCombatAction(message: MessageEnvelope): Promise<void> {
    const { characterId, zoneId, abilityId, targetId } = message.payload as {
      characterId: string;
      zoneId: string;
      abilityId: string;
      targetId: string;
    };

    logger.info({ characterId, zoneId, abilityId, targetId }, '[DWM] handlePlayerCombatAction received');

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) {
      logger.warn({ zoneId, knownZones: Array.from(this.zones.keys()) }, '[DWM] combat_action: zoneManager not found');
      return;
    }

    const attackerEntity = zoneManager.getEntity(characterId);
    if (!attackerEntity || !attackerEntity.isAlive) {
      logger.warn({ characterId, found: !!attackerEntity, isAlive: attackerEntity?.isAlive }, '[DWM] combat_action: attacker not found or dead');
      return;
    }

    const targetEntity = zoneManager.getEntity(targetId);
    if (!targetEntity || !targetEntity.isAlive) {
      logger.warn({ targetId, found: !!targetEntity, isAlive: targetEntity?.isAlive }, '[DWM] combat_action: target not found or dead');
      await this.broadcastCombatEvent(zoneId, attackerEntity.position, {
        eventType: 'combat_error',
        timestamp: Date.now(),
        narrative: `Target not found.`,
        eventTypeData: { reason: 'target_not_found', attackerId: characterId },
      });
      return null;
    }

    // basic_attack = enter combat / set auto-attack target.
    // The auto-attack loop (processAutoAttacks) fires swings on weapon speed timer.
    // ATB charges in parallel while inCombat = true, based on character speed stats.
    if (abilityId === 'basic_attack') {
      const now = Date.now();

      // Resolve the ability first so we can use its range in the pre-combat gate.
      const basicAttack = this.abilitySystem.getDefaultAbility();

      // Populate attackSpeedBonusCache for this character so ATB charges correctly.
      // Also gives us the equipped weapon range for the pre-combat range gate below.
      const attackerSnapshot = await this.getCombatSnapshot(characterId, attackerEntity);

      // Range check before entering combat — use the same logic as validateRange so the
      // pre-combat gate is never stricter than the in-combat check.
      // (weapon range takes priority; ability range is the fallback for unarmed.)
      if (!this.validateRange(attackerEntity.position, targetEntity.position, basicAttack, attackerSnapshot?.weapon?.range)) {
        await this.broadcastCombatEvent(zoneId, attackerEntity.position, {
          eventType: 'combat_error',
          timestamp: now,
          narrative: 'Target out of range.',
          eventTypeData: { reason: 'out_of_range', attackerId: characterId },
        });
        return;
      }

      // Start combat state (enables ATB charging)
      this.combatManager.startCombat(characterId, now);

      // Set auto-attack target (enables weapon timer)
      this.combatManager.setAutoAttackTarget(characterId, targetId);

      // Mark both combatants as in combat in the zone (visibility / proximity effects)
      zoneManager.setEntityCombatState(characterId, true);
      zoneManager.setEntityCombatState(targetId, true);

      logger.info({ characterId, targetId }, '[DWM] basic_attack: entered combat, auto-attack target set');

      // Fire an immediate first swing — don't make the player wait a full weapon cycle
      await this.executeCombatAction(
        zoneManager,
        { id: attackerEntity.id, position: attackerEntity.position, type: attackerEntity.type },
        { id: targetEntity.id,   position: targetEntity.position,   type: targetEntity.type },
        basicAttack,
        { isAutoAttack: true }
      );

      // Reset the timer so the *next* auto-attack waits a full weapon-speed cycle
      this.combatManager.resetAutoAttackTimer(characterId);
      return;
    }

    // All other abilities: direct execution path
    const ability =
      (await this.abilitySystem.getAbility(abilityId)) || this.abilitySystem.getDefaultAbility();

    logger.info({ characterId, targetId, abilityId: ability.id }, '[DWM] combat_action: executing');

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

    // Detect guest accounts (non-bcrypt hash with guest- prefix)
    const account = await AccountService.findByIdWithCharacters(character.accountId);
    const isGuest = account?.passwordHash.startsWith('guest-') ?? false;

    const context: CommandContext = {
      characterId,
      characterName: character.name,
      accountId: character.accountId,
      zoneId,
      position: entity.position,
      heading: character.heading,
      inCombat: entity.inCombat || false,
      socketId: entity.socketId,
      isGuest,
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
          const { channel, message, range, position, npcId } = event.data as {
            channel: 'say' | 'shout' | 'emote' | 'cfh' | 'touch';
            message: string;
            range: number;
            position: { x: number; y: number; z: number };
            npcId?: string;
          };

          const rangeMeters = range * FEET_TO_METERS;
          await this.broadcastChatFromCharacter(
            zoneManager,
            context.characterId,
            context.characterName,
            position,
            channel,
            message,
            rangeMeters,
            npcId,
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
          logger.info(`[processCommandResult] private_message from ${context.characterName} → ${targetName}: "${message}"`);

          const sent = await this.sendPrivateMessage(
            context.characterId,
            context.characterName,
            targetName,
            message
          );

          if (!sent) {
            logger.warn(`[processCommandResult] private_message delivery failed — ${targetName} not available`);
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
          const { heading, speed, distance, target, targetRange, startPosition, targetPosition } = event.data as {
            heading?: number;
            speed: MovementSpeed;
            distance?: number;
            target?: string;
            targetRange: number;
            startPosition: Vector3;
            targetPosition?: { x: number; y?: number; z: number };
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
            targetPosition,
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
        case 'harvest': {
          const { plantId } = event.data as { plantId?: string };
          const harvestResult = await this.processHarvestCommand(
            context.characterId,
            context.zoneId,
            context.position,
            plantId,
          );
          overrideResponse = { success: harvestResult.success, message: harvestResult.message, data: harvestResult.data };
          break;
        }
        case 'unstuck': {
          const unstuckResult = await this.processUnstuckCommand(
            context.characterId,
            context.zoneId,
            context.position,
          );
          overrideResponse = { success: unstuckResult.success, message: unstuckResult.message };
          break;
        }
        case 'ability_unlock': {
          const { nodeId } = event.data as { nodeId: string };
          const unlockResult = await unlockAbility(context.characterId, nodeId);
          overrideResponse = {
            success: unlockResult.success,
            message: unlockResult.message,
            ...(unlockResult.remainingAp !== undefined && {
              data: { remainingAp: unlockResult.remainingAp },
            }),
          };
          break;
        }
        case 'ability_slot': {
          const { web, slotNumber, nodeId } = event.data as {
            web: 'active' | 'passive';
            slotNumber: number;
            nodeId: string;
          };
          const slotResult = web === 'active'
            ? await slotActiveAbility(context.characterId, slotNumber, nodeId)
            : await slotPassiveAbility(context.characterId, slotNumber, nodeId);
          overrideResponse = { success: slotResult.success, message: slotResult.message };
          break;
        }
        case 'ability_view': {
          const { view, web, nodeId } = event.data as {
            view: 'summary' | 'list' | 'info';
            web?: 'active' | 'passive';
            nodeId?: string;
          };
          if (view === 'summary') {
            const summary = await getAbilitySummary(context.characterId);
            if (!summary) {
              overrideResponse = { success: false, error: 'Character not found.' };
            } else {
              const activeSlots = summary.activeLoadout
                .map((n, i) => `  Slot ${i + 1}: ${n ?? '—'}`)
                .join('\n');
              const passiveSlots = summary.passiveLoadout
                .map((n, i) => `  Slot ${i + 1}: ${n ?? '—'}`)
                .join('\n');
              overrideResponse = {
                success: true,
                message: [
                  `Ability Points: ${summary.availableAp} available / ${summary.apSpent} spent`,
                  `Unlocked: ${summary.unlockedActive} active, ${summary.unlockedPassive} passive`,
                  `Active Loadout:\n${activeSlots}`,
                  `Passive Loadout:\n${passiveSlots}`,
                ].join('\n'),
              };
            }
          } else if (view === 'list') {
            const webName = web ?? 'active';
            const nodes = await listWebNodes(context.characterId, webName);
            const lines = nodes.map(n => {
              const unlocked = n.unlocked ? '[✓]' : '[ ]';
              return `${unlocked} T${n.tier} ${n.sector.padEnd(8)} ${n.name.padEnd(22)} (${n.cost} AP) — ${n.id}`;
            });
            overrideResponse = {
              success: true,
              message: `${webName.toUpperCase()} WEB:\n${lines.join('\n')}`,
            };
          } else if (view === 'info' && nodeId) {
            const info = await getNodeInfo(context.characterId, nodeId);
            if (!info) {
              overrideResponse = { success: false, error: `Node '${nodeId}' not found.` };
            } else {
              const statusTag = info.unlocked ? '[UNLOCKED]' : `[${info.cost} AP to unlock]`;
              const parts = [
                `${info.name} ${statusTag}`,
                `Web: ${info.web} | Sector: ${info.sector} | Tier: ${info.tier}`,
                `${info.description}`,
                ...(info.effect ? [`Effect: ${info.effect}`] : []),
                ...(info.questGate ? [`Quest required: ${info.questGate}`] : []),
                `Adjacent to: ${info.adjacentTo.join(', ')}`,
                `ID: ${info.id}`,
              ];
              overrideResponse = { success: true, message: parts.join('\n') };
            }
          } else {
            overrideResponse = { success: false, error: 'Invalid ability_view event.' };
          }
          break;
        }

        // ── Village system events ──────────────────────────────────────
        case 'village_enter': {
          const { targetCharacterId, targetPlayerName } = event.data as {
            targetCharacterId: string | null;
            targetPlayerName?: string;
          };

          let ownerCharId = targetCharacterId;

          // Resolve player name → character ID for /village visit
          if (!ownerCharId && targetPlayerName) {
            const target = await CharacterService.findByName(targetPlayerName);
            if (!target) {
              overrideResponse = { success: false, error: `Player '${targetPlayerName}' not found.` };
              break;
            }
            ownerCharId = target.id;
          }

          if (!ownerCharId) {
            overrideResponse = { success: false, error: 'Invalid village target.' };
            break;
          }

          // Verify village exists
          const village = await VillageService.getVillage(ownerCharId);
          if (!village) {
            overrideResponse = { success: false, error: "That player doesn't have a village." };
            break;
          }

          try {
            // Save return point
            await VillageService.saveReturnPoint(
              context.characterId, context.zoneId,
              context.position.x, context.position.y, context.position.z,
            );

            // Spin up village instance if needed
            const villageZoneId = await this.spinUpVillageInstance(ownerCharId);

            // Update character position to village spawn
            const template = village.template;
            await VillageService.updateCharacterZone(
              context.characterId, villageZoneId,
              template.spawnX, template.spawnY, template.spawnZ,
            );

            // Tell gateway to trigger zone transfer
            await this.messageBus.publish('gateway:output', {
              type: MessageType.CLIENT_MESSAGE,
              characterId: context.characterId,
              socketId: context.socketId,
              payload: {
                socketId: context.socketId,
                event: 'zone_transfer',
                data: { zoneId: villageZoneId },
              },
              timestamp: Date.now(),
            });
          } catch (err: any) {
            overrideResponse = { success: false, error: err.message };
          }
          break;
        }

        case 'village_leave': {
          const character = await CharacterService.findById(context.characterId);

          // Determine destination: saved return point, or Stephentown as fallback
          let destZoneId = character?.returnZoneId ?? null;
          let destX = character?.returnPositionX ?? 0;
          let destY = character?.returnPositionY ?? 0;
          let destZ = character?.returnPositionZ ?? 0;

          if (!destZoneId || VillageService.isVillageZone(destZoneId)) {
            const fallbackZone = 'USA_NY_Stephentown';
            const spawn = SpawnPointService.getStarterSpawn(fallbackZone);
            destZoneId = fallbackZone;
            destX = spawn?.position?.x ?? 0;
            destY = spawn?.position?.y ?? 265;
            destZ = spawn?.position?.z ?? 0;
          }

          await VillageService.updateCharacterZone(
            context.characterId, destZoneId,
            destX, destY, destZ,
          );
          await VillageService.clearReturnPoint(context.characterId);

          await this.messageBus.publish('gateway:output', {
            type: MessageType.CLIENT_MESSAGE,
            characterId: context.characterId,
            socketId: context.socketId,
            payload: {
              socketId: context.socketId,
              event: 'zone_transfer',
              data: { zoneId: destZoneId },
            },
            timestamp: Date.now(),
          });
          break;
        }

        case 'village_placement_mode': {
          // Forward placement mode info to the client
          await this.messageBus.publish('gateway:output', {
            type: MessageType.CLIENT_MESSAGE,
            characterId: context.characterId,
            socketId: context.socketId,
            payload: {
              socketId: context.socketId,
              event: 'village_placement_mode',
              data: event.data,
            },
            timestamp: Date.now(),
          });
          break;
        }

        case 'village_remove': {
          const { structureId } = event.data as { structureId: string };
          const ownerCharIdRemove = VillageService.extractOwnerCharacterId(context.zoneId);
          if (ownerCharIdRemove !== context.characterId) {
            overrideResponse = { success: false, error: 'You can only remove structures in your own village.' };
            break;
          }

          const villageForRemove = await VillageService.getVillage(context.characterId);
          if (!villageForRemove) {
            overrideResponse = { success: false, error: 'Village not found.' };
            break;
          }

          try {
            await VillageService.removeStructure(structureId, villageForRemove.id);

            // Remove entity from ZoneManager
            const zm = this.zones.get(context.zoneId);
            if (zm) {
              zm.removeStructure(structureId);
              await this.publishZoneEntities(context.zoneId, zm);
            }

            // Broadcast entity removal to all players in the village
            const rmPayload = { timestamp: Date.now(), entities: { removed: [structureId] } };
            for (const [charId, charZoneId] of this.characterToZone.entries()) {
              if (charZoneId !== context.zoneId) continue;
              const sid = this._charToSocket.get(charId);
              if (!sid) continue;
              await this.messageBus.publish('gateway:output', {
                type: MessageType.CLIENT_MESSAGE,
                characterId: charId,
                socketId: sid,
                payload: { socketId: sid, event: 'state_update', data: rmPayload },
                timestamp: Date.now(),
              });
            }

            overrideResponse = { success: true, message: 'Structure removed.' };
          } catch (err: any) {
            overrideResponse = { success: false, error: err.message };
          }
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
    rangeMeters: number,
    targetedNpcId?: string,
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

    if (targetedNpcId) {
      // Directed /talk — only the addressed NPC should respond.  Check airlock
      // inhabit first; if the NPC is being puppeted by an external AI the
      // airlock service will react naturally via its own chat listener.
      await this.triggerTargetedNPCResponse(
        zoneManager.getZone().id, targetedNpcId, position, rangeMeters,
      );
    } else {
      await this.triggerNPCResponses(zoneManager.getZone().id, position, rangeMeters);
    }
  }

  private async sendPrivateMessage(
    senderId: string,
    senderName: string,
    targetName: string,
    message: string
  ): Promise<boolean> {
    const target = await CharacterService.findByName(targetName);
    if (!target) {
      logger.warn(`[sendPrivateMessage] Target "${targetName}" not found in DB`);
      return false;
    }

    const location = await this.zoneRegistry.getPlayerLocation(target.id);
    if (!location) {
      logger.warn(`[sendPrivateMessage] Target "${targetName}" (${target.id}) has no active location — offline?`);
      return false;
    }

    logger.info(`[sendPrivateMessage] ${senderName} → ${targetName} (socket=${location.socketId}): "${message}"`);
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
      isAlive?: boolean;
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
    targetEntity: { id: string; type: 'player' | 'npc' | 'companion' | 'mob' | 'wildlife' },
    attackerEntity: { id: string; type: 'player' | 'npc' | 'companion' | 'mob' | 'wildlife' }
  ): void {
    if (targetEntity.id === attackerEntity.id) return;
    // Players retaliate manually; only NPCs/mobs/wildlife auto-retaliate.
    if (targetEntity.type === 'player' || targetEntity.type === 'companion') return;
    if (this.combatManager.hasAutoAttackTarget(targetEntity.id)) return;
    const now = Date.now();
    this.combatManager.startCombat(targetEntity.id, now);
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
    if (!entity) {
      // Plants live in FloraManager, not ZoneManager — check there as fallback
      return this._describePlantTarget(context, target);
    }

    // Use horizontal distance — consistent with melee range checks and avoids
    // Y-axis drift from differing terrain datasets inflating the displayed range.
    const dx = entity.position.x - context.position.x;
    const dz = entity.position.z - context.position.z;
    const range = Math.round(Math.sqrt(dx * dx + dz * dz) * 100) / 100;

    const statusParts: string[] = [];
    if (!entity.isAlive) {
      statusParts.push('dead');
    }
    if (entity.inCombat) {
      statusParts.push('in combat');
    }

    const statusSuffix = statusParts.length > 0 ? ` [${statusParts.join(', ')}]` : '';
    const header = `${entity.name} is ${range}m away${statusSuffix}.`;

    // Description — stored on the entity at spawn time from the database record.
    const description = (entity as any).description as string | undefined;
    const message = description
      ? `${header}\n${description}`
      : header;

    // Build a rich peek payload with everything the client can display.
    const peek: Record<string, unknown> = {
      id:          entity.id,
      name:        entity.name,
      entityType:  entity.type,
      isAlive:     entity.isAlive,
      inCombat:    entity.inCombat ?? false,
      range,
      description: description ?? null,
    };

    // Level — mobs/players/companions
    if (entity.level != null) {
      peek.level = entity.level;
    }

    // Health — percentage only (don't expose exact numbers to other players)
    if (entity.currentHealth != null && entity.maxHealth != null && entity.maxHealth > 0) {
      peek.healthPct = Math.round((entity.currentHealth / entity.maxHealth) * 100);
    }

    // Mob / wildlife specifics
    if (entity.type === 'mob' || entity.type === 'wildlife') {
      if (entity.faction)   peek.faction   = entity.faction;
      if (entity.notorious) peek.notorious = true;
      if (entity.tag)       peek.tag       = entity.tag;
    }

    return {
      message,
      data: {
        type: 'look',
        target: peek,
      },
    };
  }

  private _describePlantTarget(
    context: CommandContext,
    target: string
  ): { message: string; data: any } | null {
    const flora = this.floraManagers.get(context.zoneId);
    if (!flora) return null;

    const plant = flora.getPlant(target);
    if (!plant) return null;

    const species = getPlantSpecies(plant.speciesId);
    const name = species?.name ?? plant.speciesId;

    const dx = plant.position.x - context.position.x;
    const dz = plant.position.z - context.position.z;
    const range = Math.round(Math.sqrt(dx * dx + dz * dz) * 100) / 100;

    const header = `${name} is ${range}m away.`;
    const description = species?.description ?? null;
    const message = description ? `${header}\n${description}` : header;

    const peek: Record<string, unknown> = {
      id:          plant.id,
      name,
      entityType:  'plant',
      isAlive:     plant.isAlive,
      inCombat:    false,
      range,
      description,
      growthStage: plant.currentStage,
    };

    return {
      message,
      data: {
        type: 'look',
        target: peek,
      },
    };
  }

  private async executeCombatAction(
    zoneManager: ZoneManager,
    attackerEntity: { id: string; position: { x: number; y: number; z: number }; type: 'player' | 'npc' | 'companion' | 'mob' | 'wildlife' },
    targetEntity: { id: string; position: { x: number; y: number; z: number }; type: 'player' | 'npc' | 'companion' | 'mob' | 'wildlife' },
    ability: CombatAbilityDefinition,
    options?: { isAutoAttack?: boolean; isQueued?: boolean }
  ): Promise<{ hit: boolean } | null> {
    const isAutoAttack = options?.isAutoAttack ?? false;
    const isQueued = options?.isQueued ?? false;
    const characterId = attackerEntity.id;
    const targetId = targetEntity.id;
    const now = Date.now();
    // Resolve names once — attackerEntity only carries {id, position, type}.
    const attackerName = zoneManager.getEntity(characterId)?.name ?? 'Unknown';

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
    if (!attackerSnapshot || !targetSnapshot) {
      logger.warn(
        { characterId, targetId, attackerSnapshotNull: !attackerSnapshot, targetSnapshotNull: !targetSnapshot },
        '[DWM] executeCombatAction: snapshot null — aborting'
      );
      return null;
    }

    if (!this.validateRange(attackerEntity.position, targetEntity.position, ability, attackerSnapshot.weapon?.range)) {
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

    if (!this.canPayCosts(attackerSnapshot, ability, isAutoAttack)) {
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

    await this.applyCosts(attackerSnapshot, ability, isAutoAttack);
    if (attackerSnapshot.isPlayer) {
      const healthCost = ability.healthCost || 0;
      const staminaCost = isAutoAttack ? 0 : (ability.staminaCost || 0);
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

    // Always give non-player targets a chance to retaliate, even on auto-attacks.
    this.maybeRetaliate(targetEntity, attackerEntity);

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
            // Offset to eye-height (entities are positioned at floor level).
            attackerPosition: { ...attackerEntity.position, y: attackerEntity.position.y + 1.5 },
            defenderPosition: { ...target.position, y: target.position.y + 1.5 },
            physicsSystem: zoneManager.getPhysicsSystem(),
            excludeEntityIds: [characterId, target.id],
          }
        );

        if (!result.hit) {
          const missTarget = zoneManager.getEntity(targetData.entityId);
          const missNarrative = buildCombatNarrative('miss', {
            attackerName: attackerName,
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

        // Mirror health into ZoneManager so publishZoneEntities stays current
        if (!targetData.isPlayer) {
          zoneManager.setEntityHealth(targetData.entityId, newHp, targetData.maxHealth);
        }

        // Record damage for loot resolution (mobs only)
        if (!targetData.isPlayer && !targetData.isWildlife) {
          this._recordMobDamage(targetData.entityId, characterId, result.amount, zoneManager.getZone().id);
          if (newHp <= 0) this._setKiller(targetData.entityId, characterId);
        }

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
          attackerName: attackerName,
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

          const slainName = hitTarget?.name ?? 'the target';
          await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
            eventType: 'combat_death',
            timestamp: now,
            narrative: `${attackerName} has slain ${slainName}!`,
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

          // ── Eldritch tendril effect ─────────────────────────────────────────
          // Broadcast to all nearby observers so they see the corpse consumed.
          // Players / companions: slow 60-min dissolve (can be raised).
          // Mobs / wildlife: quick ~4-second dissolve.
          // Companions go through a separate damage path; here we only see players, mobs, wildlife.
          const isPlayerOrCompanion = targetData.isPlayer;
          const dissolveDurationSeconds = isPlayerOrCompanion ? 3600 : 4;
          const targetEntityPos = zoneManager.getEntity(targetData.entityId)?.position
            ?? attackerEntity.position;
          await this.broadcastCombatEvent(zoneManager.getZone().id, targetEntityPos, {
            eventType:      'entity_death',
            timestamp:      now,
            eventTypeData: {
              entityId:                targetData.entityId,
              entityType:              isPlayerOrCompanion ? 'player' : (targetData.isWildlife ? 'wildlife' : 'mob'),
              dissolveDurationSeconds,
              canBeRaised:             isPlayerOrCompanion,
              x:                       targetEntityPos.x,
              y:                       targetEntityPos.y,
              z:                       targetEntityPos.z,
            },
          });

          if (targetData.isWildlife) {
            // Wildlife lives in-memory only. Despawn after death animation;
            // WildlifeManager's killEntity fires its own respawn timer.
            const wildlifeId = targetData.entityId;
            const deadZoneId = zoneManager.getZone().id;
            setTimeout(async () => {
              for (const wm of this.wildlifeManagers.values()) {
                if (wm.getEntity(wildlifeId)) {
                  wm.killEntity(wildlifeId, characterId, 'combat');
                  break;
                }
              }
              const zm = this.zones.get(deadZoneId);
              if (zm) {
                zm.removeWildlife(wildlifeId);
                await this.broadcastEntityRemoved(deadZoneId, wildlifeId);
                await this.broadcastNearbyUpdate(deadZoneId);
              }
            }, 2500);
          } else if (!targetData.isPlayer) {
            // Resolve and distribute loot before despawning
            void this._resolveMobLoot(targetData.entityId, zoneManager.getZone().id);
            await this.scheduleMobRespawn(targetData.entityId, zoneManager.getZone().id, targetData.maxHealth);
          } else {
            // Player died — push isAlive:false so the client shows the death overlay.
            await this.sendCharacterResourcesUpdate(zoneManager, targetData.entityId, {
              health: { current: 0, max: targetData.maxHealth },
              isAlive: false,
            });

            // Auto-release to homepoint after 60 minutes if not raised.
            // The client timer is authoritative for the countdown display;
            // this is a server-side safety net only.
            const deadPlayerId = targetData.entityId;
            const deadZoneId   = zoneManager.getZone().id;
            if (!this.respawnTimers.has(deadPlayerId)) {
              const autoRelease = setTimeout(async () => {
                const zm2 = this.zones.get(deadZoneId);
                if (!zm2) return;
                const deadEntity = zm2.getEntity(deadPlayerId);
                if (!deadEntity || deadEntity.isAlive) return; // Already raised
                // Reuse handlePlayerRespawn via a synthetic envelope
                await this.handlePlayerRespawn({
                  characterId: deadPlayerId,
                } as import('@/messaging').MessageEnvelope);
              }, 60 * 60 * 1000);
              this.respawnTimers.set(deadPlayerId, autoRelease);
            }
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

    logger.info(
      { eventType: event.eventType, narrative: event.narrative, nearbyPlayers, nearbyCompanions, origin },
      '[DWM] broadcastCombatEvent'
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
    entity: { type: 'player' | 'npc' | 'companion' | 'mob' | 'wildlife' | string }
  ): Promise<{
    entityId: string;
    isPlayer: boolean;
    isMob?: boolean;
    isWildlife?: boolean;
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
      range?: number;
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

    if (entity.type === 'companion') {
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

    // mob — database-persisted entity, look up via MobService
    if (entity.type === 'mob') {
      const mob = await MobService.findById(entityId);
      if (!mob) {
        logger.warn({ entityId }, '[DWM] getCombatSnapshot: mob not found in database');
        return null;
      }

      const stats = (mob.stats as Record<string, number>) || {};
      const coreStats = {
        strength:     stats.strength     ?? 10,
        vitality:     stats.vitality     ?? 10,
        dexterity:    stats.dexterity    ?? 10,
        agility:      stats.agility      ?? 10,
        intelligence: stats.intelligence ?? 5,
        wisdom:       stats.wisdom       ?? 5,
      };
      const derived = StatCalculator.calculateDerivedStats(coreStats, mob.level);
      this.attackSpeedBonusCache.set(entityId, derived.attackSpeedBonus);

      return {
        entityId,
        isPlayer: false,
        isMob: true,
        currentHealth: mob.currentHealth,
        maxHealth: mob.maxHealth,
        currentStamina: 0,
        currentMana: 0,
        maxStamina: 0,
        maxMana: 0,
        coreStats,
        stats: this.buildCombatStats(derived),
      };
    }

    // wildlife / npc — look up live state from WildlifeManager
    for (const wm of this.wildlifeManagers.values()) {
      const we = wm.getEntity(entityId);
      if (!we) continue;

      const species = getSpecies(we.speciesId);
      if (!species) {
        logger.warn({ entityId, speciesId: we.speciesId }, '[DWM] getCombatSnapshot: species not found for wildlife entity');
        return null;
      }

      // Map species data to core stats so StatCalculator can derive combat ratings.
      // strength  → attack damage proxy (attackDamage * 0.8)
      // vitality  → health proxy (maxHealth / 5, minimum 1)
      // dex/agi   → level-scaled mobility/evasion
      const coreStats = {
        strength:     Math.max(1, Math.round(species.attackDamage * 0.8)),
        vitality:     Math.max(1, Math.round(species.maxHealth / 5)),
        dexterity:    Math.max(1, we.level + 8),
        agility:      Math.max(1, we.level + 8),
        intelligence: 5,
        wisdom:       5,
      };
      const derived = StatCalculator.calculateDerivedStats(coreStats, we.level);
      this.attackSpeedBonusCache.set(entityId, derived.attackSpeedBonus);

      return {
        entityId,
        isPlayer: false,
        isWildlife: true,
        currentHealth: we.currentHealth,
        maxHealth: we.maxHealth,
        currentStamina: 0,
        currentMana: 0,
        maxStamina: 0,
        maxMana: 0,
        coreStats,
        stats: this.buildCombatStats(derived),
      };
    }

    logger.warn({ entityId, entityType: entity.type }, '[DWM] getCombatSnapshot: entity not found in any lookup');
    return null;
  }

  private async getEquippedWeaponData(
    characterId: string
  ): Promise<{
    baseDamage?: number;
    speed?: number;
    range: number;
    damageProfiles?: DamageProfileSegment[] | null;
    primaryPhysicalType?: PhysicalDamageType;
    primaryDamageType?: DamageType;
  } | null> {
    const equipped = await CharacterService.findEquippedHandItems(characterId);
    if (equipped.length === 0) return null;

    const right = equipped.find(item => item.equipSlot === 'right_hand');
    const left  = equipped.find(item => item.equipSlot === 'left_hand');
    const weaponItem = right || left;
    if (!weaponItem) return null;

    const weapon = getWeaponDefinition(weaponItem.template.properties);
    if (!weapon) return null;

    const tags    = weaponItem.template.tags.map(t => t.tag.name);
    const profiles = buildDamageProfiles(weapon);
    const primaryPhysicalType = getPrimaryPhysicalType(profiles);

    return {
      baseDamage: weapon.baseDamage,
      speed:      weapon.speed,
      range:      getWeaponRange(weapon, tags),
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
    ability: CombatAbilityDefinition,
    weaponRange?: number,
  ): boolean {
    if (ability.targetType === 'self') return true;

    const weaponReach    = weaponRange ?? UNARMED_RANGE;
    const effectiveRange = BASE_REACH + ENTITY_RADIUS + ENTITY_RADIUS + weaponReach;

    // Use horizontal (XZ) distance for range validation.
    //
    // Why not 3D? Player Y comes from the client heightmap; mob Y is snapped to
    // the server's elevation service (a different terrain dataset).  Even a 1–2 m
    // discrepancy on any slope pushes the 3D distance over the melee threshold
    // while the player is visually standing right next to the target.  Horizontal
    // distance is the semantically correct metric for "can I reach this target?"
    // in a ground-based combat system.
    //
    // Vertical tolerance: prevent attacking through completely separate floors
    // (e.g. someone on a cliff 10 m above should not hit someone below).
    // The tolerance is generous (effectiveRange + 3 m) to absorb terrain slope.
    const dx = target.x - source.x;
    const dz = target.z - source.z;
    const dy = Math.abs(target.y - source.y);
    const horizontalDist  = Math.sqrt(dx * dx + dz * dz);
    const verticalAllowed = effectiveRange + 3.0; // metres

    if (PHYSICS_DEBUG) {
      logger.debug(
        { horizontalDist: horizontalDist.toFixed(2), dy: dy.toFixed(2), effectiveRange, verticalAllowed },
        '[validateRange] range check',
      );
    }

    return horizontalDist <= effectiveRange && dy <= verticalAllowed;
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
    ability: CombatAbilityDefinition,
    isAutoAttack = false,
  ): boolean {
    if (ability.healthCost && snapshot.currentHealth <= ability.healthCost) return false;
    // Auto-attacks never cost stamina — skip the stamina gate entirely so low
    // stamina never blocks the weapon timer from firing.
    if (!isAutoAttack && ability.staminaCost && snapshot.isPlayer && snapshot.currentStamina < ability.staminaCost) return false;
    if (ability.manaCost && snapshot.isPlayer && snapshot.currentMana < ability.manaCost) return false;
    return true;
  }

  private async applyCosts(
    snapshot: { entityId: string; isPlayer: boolean; currentHealth: number; currentStamina: number; currentMana: number },
    ability: CombatAbilityDefinition,
    isAutoAttack = false,
  ): Promise<void> {
    const healthCost = ability.healthCost || 0;
    // Auto-attacks don't drain stamina — force cost to 0 so the DB write is
    // consistent with the value we send to the client below.
    const staminaCost = isAutoAttack ? 0 : (ability.staminaCost || 0);
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
    snapshot: { entityId: string; isPlayer: boolean; isMob?: boolean; isWildlife?: boolean },
    newHealth: number
  ): Promise<void> {
    if (snapshot.isPlayer) {
      await CharacterService.updateResources(snapshot.entityId, { currentHp: newHealth, isAlive: newHealth > 0 });
    } else if (snapshot.isMob) {
      await MobService.updateStatus(snapshot.entityId, {
        currentHealth: newHealth,
        isAlive: newHealth > 0,
      });
    } else if (snapshot.isWildlife) {
      // Wildlife is in-memory only — update directly in WildlifeManager, no DB write
      for (const wm of this.wildlifeManagers.values()) {
        const we = wm.getEntity(snapshot.entityId);
        if (we) {
          we.currentHealth = newHealth;
          we.isAlive = newHealth > 0;
          break;
        }
      }
    } else {
      await CompanionService.updateStatus(snapshot.entityId, {
        currentHealth: newHealth,
        isAlive: newHealth > 0,
      });
    }
  }

  // ── Loot helpers ────────────────────────────────────────────────────────────

  private _recordMobDamage(mobId: string, attackerId: string, amount: number, zoneId: string): void {
    let entry = this._damageLog.get(mobId);
    if (!entry) {
      entry = { firstAttackerId: attackerId, damages: new Map(), killerId: attackerId, zoneId };
      this._damageLog.set(mobId, entry);
    }
    entry.damages.set(attackerId, (entry.damages.get(attackerId) ?? 0) + amount);
  }

  private _setKiller(mobId: string, attackerId: string): void {
    const entry = this._damageLog.get(mobId);
    if (entry) entry.killerId = attackerId;
  }

  /** Determine which characterId (or partyId) wins the loot. */
  private async _resolveLootWinner(mobId: string): Promise<{ winnerId: string; partyId: string | null }> {
    const entry = this._damageLog.get(mobId);
    if (!entry) return { winnerId: '', partyId: null };

    const isPresent = (id: string) => this.characterToZone.get(id) === entry.zoneId;

    // 1. First attacker still present
    let winnerId = isPresent(entry.firstAttackerId) ? entry.firstAttackerId : '';

    // 2. Highest damage dealer
    if (!winnerId) {
      const sorted = [...entry.damages.entries()].sort((a, b) => b[1] - a[1]);
      for (const [id] of sorted) {
        if (isPresent(id)) { winnerId = id; break; }
      }
    }

    // 3. Kill credit fallback
    if (!winnerId) winnerId = entry.killerId;

    const partyId = winnerId ? await this.partyService.getPartyIdForMember(winnerId) : null;
    return { winnerId, partyId };
  }

  /** Send a socket event directly to a connected player. */
  private async _sendToSocket(characterId: string, event: string, data: unknown): Promise<void> {
    const socketId = this._charToSocket.get(characterId);
    if (!socketId) return;
    await this.messageBus.publish('gateway:output', {
      type:      MessageType.CLIENT_MESSAGE,
      timestamp: Date.now(),
      payload:   { socketId, event, data } as ClientMessagePayload,
    });
  }

  // ── IWildlifeWorld facade — used by WildlifeBridge (Rust sim) ────────────

  addWildlifeToZone(
    zoneId: string,
    data: { id: string; name: string; speciesId: string; position: { x: number; y: number; z: number }; sprite: string; heading?: number },
  ): void {
    const zm = this.zones.get(zoneId);
    if (!zm) return;
    zm.addWildlife(data);
    void this.broadcastNearbyUpdate(zoneId);
  }

  updateWildlifeInZone(
    zoneId: string,
    entityId: string,
    position: { x: number; y: number; z: number },
    heading: number,
    behavior: string,
    _speed: number,
  ): void {
    const zm = this.zones.get(zoneId);
    if (!zm) return;
    zm.updateWildlife(entityId, position, heading, behavior);
  }

  removeWildlifeFromZone(zoneId: string, entityId: string): void {
    const zm = this.zones.get(zoneId);
    if (!zm) return;
    zm.removeWildlife(entityId);
    void this.broadcastNearbyUpdate(zoneId);
  }

  getAllActiveZoneIds(): string[] {
    return [...this.zones.keys()];
  }

  getZoneBiome(zoneId: string): string {
    return this.zoneBiomes.get(zoneId) ?? BIOME_FALLBACK;
  }

  getZoneTimeOfDayNormalized(zoneId: string): number {
    return this.zones.get(zoneId)?.getTimeOfDayNormalized() ?? 0.5;
  }

  getZonePlayerPositions(zoneId: string): PlayerPositionMessage[] {
    const results: PlayerPositionMessage[] = [];
    for (const [charId, charZoneId] of this.characterToZone.entries()) {
      if (charZoneId !== zoneId) continue;
      const zm = this.zones.get(zoneId);
      const entity = zm?.getEntity(charId);
      if (!entity) continue;
      results.push({ id: charId, zone_id: zoneId, position: entity.position });
    }
    return results;
  }

  async broadcastWildlifeMoveToClients(
    zoneId: string,
    entityId: string,
    name: string,
    position: { x: number; y: number; z: number },
    heading: number,
    animation: string,
    speed: number,
  ): Promise<void> {
    const stateUpdate = {
      timestamp: Date.now(),
      entities: {
        updated: [{ id: entityId, name, type: 'wildlife', position, heading, currentAction: animation, movementDuration: 520, movementSpeed: speed }],
      },
    };
    for (const [charId, charZoneId] of this.characterToZone.entries()) {
      if (charZoneId !== zoneId) continue;
      const zm = this.zones.get(zoneId);
      const socketId = zm?.getSocketIdForCharacter(charId);
      if (!socketId) continue;
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId: charId,
        socketId,
        payload: { socketId, event: 'state_update', data: stateUpdate } as ClientMessagePayload,
        timestamp: Date.now(),
      });
    }
  }

  // ── IWildlifeWorld — plant notification stubs ─────────────────────────────

  notifyPlantStageChange(plantId: string, newStage: string): void {
    // Find which zone this plant belongs to and update its FloraManager
    for (const [zoneId, flora] of this.floraManagers) {
      const plant = flora.getPlant(plantId);
      if (plant) {
        // Reflect stage change driven by Rust sim
        (plant as any).currentStage = newStage;
        void this._broadcastPlantToZone(zoneId, plant.id, plant.speciesId, plant.position, newStage, 'updated');
        return;
      }
    }
  }

  notifyPlantEaten(plantId: string, wildlifeId: string, foodValue: number): void {
    for (const [zoneId, flora] of this.floraManagers) {
      const plant = flora.getPlant(plantId);
      if (plant) {
        flora.eatPlant(plantId, wildlifeId);
        if (!plant.isAlive) {
          void this._broadcastPlantRemoved(zoneId, plantId);
        } else {
          void this._broadcastPlantToZone(zoneId, plant.id, plant.speciesId, plant.position, plant.currentStage, 'updated');
        }
        return;
      }
    }
  }

  // ── Flora broadcast helpers ────────────────────────────────────────────────

  /**
   * Send a plant entity add/update to all players in the zone.
   * mode 'added'   → entities.added   (new plant, client creates object)
   * mode 'updated' → entities.updated (stage change, client swaps model)
   */
  private async _broadcastPlantToZone(
    zoneId: string,
    plantId: string,
    speciesId: string,
    position: Vector3,
    stage: string,
    mode: 'added' | 'updated',
  ): Promise<void> {
    const speciesData = getPlantSpecies(speciesId);
    const entity = {
      id:          plantId,
      type:        'plant',
      name:        speciesData?.name ?? speciesId,
      position,
      description: speciesData?.description ?? '',
      isAlive:     true,
      interactive: true,
      currentAction: stage, // growth stage — used by client to select visual
    };
    const stateUpdate = {
      timestamp: Date.now(),
      entities: mode === 'added' ? { added: [entity] } : { updated: [entity] },
    };
    for (const [charId, charZoneId] of this.characterToZone.entries()) {
      if (charZoneId !== zoneId) continue;
      const zm = this.zones.get(zoneId);
      const socketId = zm?.getSocketIdForCharacter(charId);
      if (!socketId) continue;
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId: charId,
        socketId,
        payload: { socketId, event: 'state_update', data: stateUpdate } as ClientMessagePayload,
        timestamp: Date.now(),
      });
    }
  }

  private async _broadcastPlantRemoved(zoneId: string, plantId: string): Promise<void> {
    const stateUpdate = {
      timestamp: Date.now(),
      entities: { removed: [plantId] },
    };
    for (const [charId, charZoneId] of this.characterToZone.entries()) {
      if (charZoneId !== zoneId) continue;
      const zm = this.zones.get(zoneId);
      const socketId = zm?.getSocketIdForCharacter(charId);
      if (!socketId) continue;
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId: charId,
        socketId,
        payload: { socketId, event: 'state_update', data: stateUpdate } as ClientMessagePayload,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Push the live time-of-day + weather to a single player as a state_update.
   *
   * Called during handlePlayerJoinZone to correct the potentially stale timeOfDayValue
   * that the gateway wrote into the world_entry packet from ZoneRegistry.
   * ZoneRegistry is only updated on bucket transitions (up to ~12 min intervals), so
   * without this step the client's interpolated clock can be several minutes off.
   */
  private async _sendEnvToPlayer(characterId: string, zoneId: string): Promise<void> {
    const zm = this.zones.get(zoneId);
    if (!zm) return;
    const socketId = this._charToSocket.get(characterId);
    if (!socketId) return;

    const zonePartial = {
      timeOfDay:      zm.getTimeOfDayString(),
      timeOfDayValue: zm.getTimeOfDayNormalized(),
      weather:        zm.getWeather(),
      lighting:       zm.getLighting(),
    };

    await this.messageBus.publish('gateway:output', {
      type:        MessageType.CLIENT_MESSAGE,
      characterId,
      socketId,
      payload: {
        socketId,
        event: 'state_update',
        data:  { timestamp: Date.now(), zone: zonePartial },
      } as ClientMessagePayload,
      timestamp: Date.now(),
    });
  }

  /**
   * Send all alive plants in a zone to a newly-joined player.
   * Called from handlePlayerJoinZone.
   */
  private async _sendPlantsToPlayer(characterId: string, zoneId: string): Promise<void> {
    const flora = this.floraManagers.get(zoneId);
    if (!flora) return;
    const plants = flora.getAlivePlants();
    if (plants.length === 0) return;

    const zm = this.zones.get(zoneId);
    const socketId = zm?.getSocketIdForCharacter(characterId);
    if (!socketId) return;

    const added = plants.map(p => {
      const sd = getPlantSpecies(p.speciesId);
      return {
        id:            p.id,
        type:          'plant',
        name:          sd?.name ?? p.speciesId,
        position:      p.position,
        description:   sd?.description ?? '',
        isAlive:       true,
        interactive:   true,
        currentAction: p.currentStage, // growth stage
      };
    });

    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId,
      socketId,
      payload: {
        socketId,
        event: 'state_update',
        data: { timestamp: Date.now(), entities: { added } },
      } as ClientMessagePayload,
      timestamp: Date.now(),
    });
  }

  /**
   * Send structure entities to a newly-joined player in a village zone.
   * Called from handlePlayerJoinZone. Ensures structures are visible even
   * if the world_entry Redis snapshot missed them for any reason.
   */
  private async _sendStructuresToPlayer(characterId: string, zoneId: string): Promise<void> {
    if (!VillageService.isVillageZone(zoneId)) return;

    const zm = this.zones.get(zoneId);
    if (!zm) return;
    const socketId = zm.getSocketIdForCharacter(characterId);
    if (!socketId) return;

    const structures = zm.getAllEntities().filter(e => e.type === 'structure');
    if (structures.length === 0) return;

    const added = structures.map(s => ({
      id:          s.id,
      type:        'structure',
      name:        s.name,
      position:    s.position,
      description: s.description ?? '',
      isAlive:     true,
      interactive: false,
    }));

    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId,
      socketId,
      payload: {
        socketId,
        event: 'state_update',
        data: { timestamp: Date.now(), entities: { added } },
      } as ClientMessagePayload,
      timestamp: Date.now(),
    });
  }

  /**
   * Send village_state metadata to a newly-joined player for the VillagePanel UI.
   * Called from handlePlayerJoinZone.
   */
  private async _sendVillageStateToPlayer(characterId: string, zoneId: string): Promise<void> {
    if (!VillageService.isVillageZone(zoneId)) return;

    const ownerCharId = VillageService.extractOwnerCharacterId(zoneId);
    if (!ownerCharId) return;
    const village = await VillageService.getVillage(ownerCharId);
    if (!village) return;

    const zm = this.zones.get(zoneId);
    if (!zm) return;
    const socketId = zm.getSocketIdForCharacter(characterId);
    if (!socketId) return;

    const ownerChar = await CharacterService.findById(ownerCharId);

    const payload = {
      villageName:      village.name,
      ownerCharacterId: ownerCharId,
      ownerName:        ownerChar?.name ?? 'Unknown',
      templateName:     village.template.name,
      structures:       village.structures.map(s => ({
        id:        s.id,
        catalogId: s.catalogId,
        name:      s.catalog.displayName,
        position:  { x: s.positionX, y: s.positionY, z: s.positionZ },
        rotation:  s.rotation,
        sizeX:     s.catalog.sizeX,
        sizeZ:     s.catalog.sizeZ,
      })),
      maxStructures: village.template.maxStructures,
      gridSize:      village.template.gridSize,
      isOwner:       characterId === ownerCharId,
    };

    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId,
      socketId,
      payload: {
        socketId,
        event: 'village_state',
        data: payload,
      } as ClientMessagePayload,
      timestamp: Date.now(),
    });
  }

  /**
   * Process a /harvest command event.
   * Finds the nearest harvestable plant within 3 m and calls FloraManager.harvest().
   */
  /**
   * /unstuck — nudge a player clear of building geometry.
   *
   * Uses PhysicsSystem.nudgeToUnstuck() (multi-pass resolveAgainstStructures +
   * 1 m Y lift) so the entity lands cleanly on terrain after the nudge.
   * Enforces a 5-minute cooldown so it can't be abused for travel.
   */
  private async processUnstuckCommand(
    characterId: string,
    zoneId: string,
    position: Vector3,
  ): Promise<{ success: boolean; message: string }> {
    const COOLDOWN_MS = 5 * 60 * 1_000; // 5 minutes
    const now  = Date.now();
    const last = this.unstuckCooldowns.get(characterId) ?? 0;

    if (now - last < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - (now - last)) / 1_000);
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      const label = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      return { success: false, message: `You can't use /unstuck yet — wait ${label}.` };
    }

    const zm = this.zones.get(zoneId);
    if (!zm) return { success: false, message: 'Zone not available.' };

    const physics = zm.getPhysicsSystem();
    const nudged  = physics.nudgeToUnstuck(position, 0.5);

    // Update in-memory position and persist to DB
    zm.updatePlayerPosition(characterId, nudged);
    await CharacterService.updatePosition(characterId, nudged);

    // Broadcast new position to nearby players and refresh proximity roster
    await this.broadcastPositionUpdate(characterId, zoneId, nudged);
    await this.broadcastNearbyUpdate(zoneId);

    this.unstuckCooldowns.set(characterId, now);
    logger.info({ characterId, zoneId, nudged }, '[DWM] /unstuck applied');

    return { success: true, message: 'Nudging you to a nearby clear spot…' };
  }

  async processHarvestCommand(
    characterId: string,
    zoneId: string,
    position: Vector3,
    plantId?: string,
  ): Promise<{ success: boolean; message: string; data?: any }> {
    const flora = this.floraManagers.get(zoneId);
    if (!flora) return { success: false, message: 'No flora in this zone.' };

    let targetId = plantId;
    if (!targetId) {
      // Find nearest harvestable plant within 3 m
      const nearby = flora.getHarvestablePlantsNear(position, 3);
      if (nearby.length === 0) return { success: false, message: 'Nothing harvestable nearby.' };
      nearby.sort((a, b) => {
        const da = Math.hypot(a.position.x - position.x, a.position.z - position.z);
        const db = Math.hypot(b.position.x - position.x, b.position.z - position.z);
        return da - db;
      });
      targetId = nearby[0]!.id;
    } else {
      // Range check for direct-ID harvests (e.g. from target menu)
      const plant = flora.getPlant(targetId);
      if (plant) {
        const dx = plant.position.x - position.x;
        const dz = plant.position.z - position.z;
        if (Math.hypot(dx, dz) > 5) {
          return { success: false, message: 'Too far away to harvest.' };
        }
      }
    }

    const items = flora.harvest(targetId, characterId);
    if (!items) return { success: false, message: 'That cannot be harvested right now.' };

    // Items are awarded by the onPlantHarvest callback (fired inside flora.harvest),
    // which also sends inventory_update — no need to call _awardHarvestItems here.

    // Resolve plant display name from species
    const plant = flora.getPlant(targetId);
    const species = plant ? getPlantSpecies(plant.speciesId) : undefined;
    const plantName = species?.name ?? targetId;

    return {
      success: true,
      message: items.length > 0
        ? `You harvest: ${items.map(i => `${i.itemId} ×${i.quantity}`).join(', ')}.`
        : 'You harvest the plant but find nothing useful.',
      data: {
        type: 'harvest',
        plantName,
        items: items.map(i => ({ name: i.itemId, quantity: i.quantity })),
      },
    };
  }

  private async _awardHarvestItems(
    characterId: string,
    items: Array<{ itemId: string; quantity: number }>,
  ): Promise<void> {
    for (const item of items) {
      try {
        await InventoryService.addItemByTemplateTag(characterId, item.itemId, item.quantity);
      } catch (err) {
        logger.warn({ characterId, itemId: item.itemId, err }, '[Flora] Failed to award harvest item');
      }
    }
    // Send updated inventory
    const socketId = this._charToSocket.get(characterId);
    if (!socketId) return;
    try {
      const zm = this.zones.get(this.characterToZone.get(characterId) ?? '');
      const char = zm?.getEntity(characterId);
      if (!char) return;
      const activeWeaponSet = (char as any).activeWeaponSet ?? 0;
      const inventoryPayload = await InventoryService.buildPayload(characterId, activeWeaponSet);
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId,
        socketId,
        payload: { socketId, event: 'inventory_update', data: inventoryPayload } as ClientMessagePayload,
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.warn({ characterId, err }, '[Flora] Failed to send inventory update after harvest');
    }
  }

  private async _awardWildlifeLoot(
    entity: { speciesId: string; name: string },
    characterId: string,
  ): Promise<void> {
    const species = getSpecies(entity.speciesId);
    if (!species || species.lootTable.length === 0) return;

    // Roll loot from the species definition
    const items: Array<{ itemId: string; quantity: number }> = [];
    for (const entry of species.lootTable) {
      if (Math.random() > entry.chance) continue;
      const qty = Math.floor(
        Math.random() * (entry.quantity.max - entry.quantity.min + 1) + entry.quantity.min,
      );
      if (qty > 0) items.push({ itemId: entry.itemId, quantity: qty });
    }

    if (items.length === 0) return;

    // Award via the same path as flora harvesting
    await this._awardHarvestItems(characterId, items);

    // Notify chat
    const socketId = this._charToSocket.get(characterId);
    if (socketId) {
      const text = `You loot ${entity.name}: ${items.map(i => `${i.itemId} ×${i.quantity}`).join(', ')}.`;
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId,
        socketId,
        payload: {
          socketId,
          event: 'command_response',
          data: {
            success: true,
            message: text,
            data: {
              type: 'harvest',
              plantName: entity.name,
              items: items.map(i => ({ name: i.itemId, quantity: i.quantity })),
            },
          },
        } as ClientMessagePayload,
        timestamp: Date.now(),
      });
    }
  }

  // ── Wildlife position broadcast helpers ──────────────────────────────────

  /**
   * Flush all queued wildlife position updates as one batched state_update
   * per player per zone.  Called once per server tick after wildlife.update().
   */
  private async _flushWildlifePositionUpdates(): Promise<void> {
    for (const [zoneId, updates] of this._pendingWildlifeUpdates) {
      if (updates.length === 0) continue;

      const stateUpdate = {
        timestamp: Date.now(),
        entities: { updated: [...updates] },
      };

      for (const [charId, charZoneId] of this.characterToZone.entries()) {
        if (charZoneId !== zoneId) continue;
        const zoneManager = this.zones.get(zoneId);
        const socketId = zoneManager?.getSocketIdForCharacter(charId);
        if (!socketId) continue;

        await this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          characterId: charId,
          socketId,
          payload: { socketId, event: 'state_update', data: stateUpdate } as ClientMessagePayload,
          timestamp: Date.now(),
        });
      }

      // Clear after flush
      updates.length = 0;
    }
  }

  private async _resolveMobLoot(mobId: string, zoneId: string): Promise<void> {
    try {
      const mob = await MobService.findById(mobId);
      if (!mob) return;

      const rolledItems = mob.lootTableId ? await LootService.rollLoot(mob.lootTableId) : [];
      const gold        = (mob as unknown as { goldDrop?: number }).goldDrop ?? 0;

      const { winnerId, partyId } = await this._resolveLootWinner(mobId);

      // Capture damage participants for XP before clearing the log
      const damageLog     = this._damageLog.get(mobId);
      const allParticipants = damageLog ? [...damageLog.damages.keys()] : (winnerId ? [winnerId] : []);
      this._damageLog.delete(mobId);

      if (!winnerId) return; // No valid winner (everyone disconnected)

      const partyInfo   = partyId ? await this.partyService.getPartyInfo(partyId) : null;
      const memberIds   = partyInfo?.members ?? [winnerId];
      const isSolo      = memberIds.length <= 1;

      // ── XP award ───────────────────────────────────────────────────────────
      // Reference level = highest-level player among all damage participants.
      // Using the highest level as the reference penalises PL: a high-level
      // companion/player in the group pushes the ref level up, reducing XP for
      // everyone (exactly as intended).
      const mobLvl = mob.level ?? 1;
      let refLevel = mobLvl;
      for (const pid of allParticipants) {
        const charLvl = this._charLevel.get(pid);
        if (charLvl !== undefined && charLvl > refLevel) refLevel = charLvl;
      }

      const xpBase = mobLvl * 100;
      const diff   = refLevel - mobLvl;
      let xpMult: number;
      if (diff >= 10)     xpMult = 0;
      else if (diff > 0)  xpMult = Math.max(0,   1 - diff * 0.1);
      else                xpMult = Math.min(2.0,  1 + Math.abs(diff) * 0.15);
      const xpGrant = Math.round(xpBase * xpMult);

      if (xpGrant > 0) {
        for (const memberId of memberIds) {
          try {
            const xpResult = await CharacterService.awardXp(memberId, xpGrant);
            this._charLevel.set(memberId, xpResult.newLevel);
            await this._sendToSocket(memberId, 'state_update', {
              timestamp: Date.now(),
              character: {
                experience:    xpResult.newExperience,
                level:         xpResult.newLevel,
                abilityPoints: xpResult.abilityPoints,
                statPoints:    xpResult.statPoints,
              },
            });
            if (xpResult.levelsGained > 0) {
              await this._sendToSocket(memberId, 'event', {
                eventType: 'level_up',
                level:     xpResult.newLevel,
                message:   `You have reached level ${xpResult.newLevel}! You gain 1 ability point and 1 stat point.`,
              });
            } else {
              await this._sendToSocket(memberId, 'event', {
                eventType: 'xp_gain',
                xp:        xpGrant,
                message:   `${xpGrant} XP (${mob.name})`,
              });
            }
          } catch (err) {
            logger.warn({ err, memberId }, '[XP] Failed to award XP to character');
          }
        }
      }

      // Split gold — floor division, remainder sinks
      const goldEach = memberIds.length > 0 ? Math.floor(gold / memberIds.length) : 0;
      if (goldEach > 0) {
        await Promise.all(memberIds.map(id => LootService.awardGold(id, goldEach)));
      }

      const sessionItems: LootSessionItem[] = rolledItems.map(r => ({
        id:          randomUUID(),
        templateId:  r.templateId,
        name:        r.name,
        itemType:    r.itemType,
        description: r.description,
        iconUrl:     r.iconUrl ?? undefined,
        quantity:    r.quantity,
      }));

      if (isSolo) {
        // Award items immediately
        for (const ri of rolledItems) {
          await LootService.awardItemToCharacter(winnerId, ri);
        }
        // Rebuild inventory and push update
        const activeSet = 1; // TODO: pull from session registry if needed
        const invPayload = await InventoryService.buildPayload(winnerId, activeSet);
        await this._sendToSocket(winnerId, 'inventory_update', invPayload);

        const startPayload: LootSessionStartPayload = {
          sessionId: randomUUID(), mobName: mob.name, mode: 'solo',
          items: sessionItems, gold, goldPerMember: gold, expiresAt: 0,
        };
        await this._sendToSocket(winnerId, 'loot_session_start', startPayload);
        // End immediately for solo (client auto-dismisses)
        await this._sendToSocket(winnerId, 'loot_session_end', { sessionId: startPayload.sessionId } as LootSessionEndPayload);
        return;
      }

      // Party NWP session
      if (sessionItems.length === 0) {
        // No items to roll on — just send a gold-only notification and end
        const soloNotif: LootSessionStartPayload = {
          sessionId: randomUUID(), mobName: mob.name, mode: 'party',
          items: [], gold, goldPerMember: goldEach, expiresAt: 0,
        };
        for (const id of memberIds) {
          await this._sendToSocket(id, 'loot_session_start', soloNotif);
          await this._sendToSocket(id, 'loot_session_end', { sessionId: soloNotif.sessionId });
        }
        return;
      }

      const sessionId = randomUUID();
      const LOOT_TIMEOUT_MS = 60_000;
      const expiresAt = Date.now() + LOOT_TIMEOUT_MS;

      const sessionData = {
        sessionId, zoneId, mobName: mob.name, memberCharIds: memberIds,
        items: sessionItems.map(si => ({
          ...si,
          rolls:    new Map<string, 'need' | 'want' | 'pass' | null>(memberIds.map(id => [id, null])),
          resolved: false,
        })),
        gold, expiresAt,
        timer: setTimeout(() => this._expireLootSession(sessionId), LOOT_TIMEOUT_MS),
      };
      this._lootSessions.set(sessionId, sessionData);

      const startPayload: LootSessionStartPayload = {
        sessionId, mobName: mob.name, mode: 'party',
        items: sessionItems, gold, goldPerMember: goldEach, expiresAt,
      };
      for (const id of memberIds) {
        await this._sendToSocket(id, 'loot_session_start', startPayload);
      }
    } catch (err) {
      logger.error({ err, mobId }, '[Loot] Failed to resolve mob loot');
    }
  }

  private async _handleLootRoll(message: MessageEnvelope): Promise<void> {
    const { characterId, sessionId, itemId, roll } = message.payload as {
      characterId: string; sessionId: string; itemId: string; roll: 'need' | 'want' | 'pass';
    };

    const session = this._lootSessions.get(sessionId);
    if (!session) return;
    if (!session.memberCharIds.includes(characterId)) return;

    const item = session.items.find(i => i.id === itemId);
    if (!item || item.resolved) return;

    item.rolls.set(characterId, roll);

    // Check if all members have voted
    const allVoted = [...item.rolls.values()].every(r => r !== null);
    if (allVoted) await this._resolveSessionItem(session, item);
  }

  private async _resolveSessionItem(
    session: ReturnType<typeof this._lootSessions['get']> & object,
    item: { id: string; templateId: string; name: string; quantity: number; iconUrl?: string;
             description: string; itemType: string;
             rolls: Map<string, 'need' | 'want' | 'pass' | null>; resolved: boolean; }
  ): Promise<void> {
    item.resolved = true;

    // Group rolls by tier; highest tier wins (need > want, pass = skip)
    const byTier: { roll: 'need' | 'want'; charId: string; dice: number }[] = [];
    for (const [charId, r] of item.rolls.entries()) {
      if (r === 'need' || r === 'want') {
        byTier.push({ roll: r, charId, dice: Math.floor(Math.random() * 100) + 1 });
      }
    }

    let winnerId: string | null = null;
    let winnerName: string | null = null;
    let winRoll: 'need' | 'want' | null = null;
    let rollValue = 0;

    if (byTier.length > 0) {
      // Prefer 'need' tier, break ties by dice
      const needs  = byTier.filter(e => e.roll === 'need');
      const wants  = byTier.filter(e => e.roll === 'want');
      const pool   = needs.length > 0 ? needs : wants;
      const winner = pool.reduce((best, cur) => cur.dice > best.dice ? cur : best);
      winnerId   = winner.charId;
      winRoll    = winner.roll;
      rollValue  = winner.dice;

      const ri = { templateId: item.templateId, name: item.name, itemType: item.itemType,
                   description: item.description, iconUrl: item.iconUrl ?? null, quantity: item.quantity };
      await LootService.awardItemToCharacter(winnerId, ri);
      const invPayload = await InventoryService.buildPayload(winnerId, 1);
      await this._sendToSocket(winnerId, 'inventory_update', invPayload);
    }

    const result: LootItemResultPayload = {
      sessionId: session!.sessionId, itemId: item.id, itemName: item.name,
      winnerId, winnerName, winRoll, rollValue,
    };
    for (const id of session!.memberCharIds) {
      await this._sendToSocket(id, 'loot_item_result', result);
    }

    // Check if all items resolved
    if (session!.items.every(i => i.resolved)) {
      clearTimeout(session!.timer);
      this._lootSessions.delete(session!.sessionId);
      const end: LootSessionEndPayload = { sessionId: session!.sessionId };
      for (const id of session!.memberCharIds) {
        await this._sendToSocket(id, 'loot_session_end', end);
      }
    }
  }

  private async _expireLootSession(sessionId: string): Promise<void> {
    const session = this._lootSessions.get(sessionId);
    if (!session) return;

    // Auto-pass any unvoted items, then resolve them
    for (const item of session.items) {
      if (item.resolved) continue;
      for (const [charId, r] of item.rolls.entries()) {
        if (r === null) item.rolls.set(charId, 'pass');
      }
      await this._resolveSessionItem(session, item);
    }
  }

  private async scheduleMobRespawn(mobId: string, zoneId: string, _maxHealth: number): Promise<void> {
    if (this.respawnTimers.has(mobId)) return;

    const mob = await MobService.findById(mobId);
    if (!mob) return;

    const DESPAWN_DELAY_MS = 2500; // Enough for the death animation to finish
    const respawnMs = (mob.respawnTime ?? 30) * 1000;

    // Phase 1 — despawn after death animation
    setTimeout(async () => {
      const zm = this.zones.get(zoneId);
      if (zm) {
        zm.removeMob(mobId);
        // Remove from wander system so it isn't ticked while despawned
        this.mobWanderSystems.get(zoneId)?.unregister(mobId);
        // Tell clients to remove the entity from their scene
        await this.broadcastEntityRemoved(zoneId, mobId);
        await this.broadcastNearbyUpdate(zoneId);
        // Keep Redis entity snapshot current for new joiners
        await this.publishZoneEntities(zoneId, zm);
      }
    }, DESPAWN_DELAY_MS);

    // Phase 2 — respawn after despawn + respawn timer
    const respawnTimer = setTimeout(async () => {
      try {
        const respawnedMob = await MobService.respawn(mobId);
        const zm = this.zones.get(zoneId);
        if (zm) {
          zm.spawnMob(respawnedMob);
          // Re-register with wander system at the respawn position
          const spawnedEntity = zm.getEntity(respawnedMob.id);
          if (spawnedEntity) {
            this.mobWanderSystems.get(zoneId)?.register(respawnedMob.id, spawnedEntity.position);
          }
          // Tell clients to add the respawned entity to their scene
          await this.broadcastEntityAdded(zoneId, {
            id: respawnedMob.id,
            type: 'mob',
            name: respawnedMob.name,
            position: { x: respawnedMob.positionX, y: respawnedMob.positionY, z: respawnedMob.positionZ },
            isAlive: true,
            health: { current: respawnedMob.maxHealth, max: respawnedMob.maxHealth },
            hostile: true,
          });
          await this.broadcastNearbyUpdate(zoneId);
          await this.publishZoneEntities(zoneId, zm);
          logger.info({ mobId, name: respawnedMob.name, zoneId }, '[DWM] Mob respawned');
        }
      } finally {
        this.respawnTimers.delete(mobId);
      }
    }, DESPAWN_DELAY_MS + respawnMs);

    this.respawnTimers.set(mobId, respawnTimer);
  }

  /**
   * Handle player respawn request (triggered by pressing H on the client).
   * Restores the player to full HP, teleports them to a respawn point,
   * clears combat state, and sends an isAlive:true state update.
   */
  private async handlePlayerRespawn(message: MessageEnvelope): Promise<void> {
    const characterId = message.characterId;
    if (!characterId) return;

    const zoneId = this.characterToZone.get(characterId);
    if (!zoneId) return;

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const entity = zoneManager.getEntity(characterId);
    if (!entity || entity.isAlive) return; // Already alive — ignore duplicate requests

    // Cancel any pending 60-min auto-release timer
    if (this.respawnTimers.has(characterId)) {
      clearTimeout(this.respawnTimers.get(characterId)!);
      this.respawnTimers.delete(characterId);
    }

    const character = await CharacterService.findById(characterId);
    if (!character) return;

    const maxHp = character.maxHp ?? 100;
    const spawnPosition = SpawnPointService.getRespawnPosition(
      zoneId,
      entity.position.x,
      entity.position.y,
      entity.position.z
    );

    // Restore in DB
    await CharacterService.updateResources(characterId, { currentHp: maxHp, isAlive: true });

    // Update entity in zone
    zoneManager.setEntityAlive(characterId, true);
    zoneManager.teleportEntity(characterId, spawnPosition);
    zoneManager.setEntityCombatState(characterId, false);
    this.combatManager.clearAutoAttackTarget(characterId);
    this.combatManager.clearAutoAttacksOnTarget(characterId);

    // Tell the client they are alive again with full HP
    await this.sendCharacterResourcesUpdate(zoneManager, characterId, {
      health: { current: maxHp, max: maxHp },
      isAlive: true,
    });

    // Broadcast so nearby entities see the respawned player
    await this.broadcastNearbyUpdate(zoneId);

    logger.info({ characterId, zoneId, spawnPosition }, '[DWM] Player respawned');
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
   * Trigger NPC AI responses for NPCs in range of the message (ambient speech).
   * Skips NPCs that are player-controlled or currently inhabited by an airlock session.
   */
  private async triggerNPCResponses(zoneId: string, messageOrigin: { x: number; y: number; z: number }, range: number): Promise<void> {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const recentMessages = this.recentChatMessages.get(zoneId) || [];
    const contextMessages = recentMessages.slice(-5).map(m => ({
      sender: m.sender, channel: m.channel, message: m.message,
    }));

    const nearbyNPCs = await this.getNearbyNPCs(zoneId, messageOrigin, range);
    const redis = this.messageBus.getRedisClient();

    for (const companion of nearbyNPCs) {
      // Skip player-controlled companions
      if (this.companionToZone.has(companion.id)) continue;

      // Skip airlock-inhabited NPCs — the external AI hears chat and responds itself
      const inhabitId = await redis.get(`airlock:npc:${companion.id}`);
      if (inhabitId) continue;

      const controller = this.npcControllers.get(companion.id);
      if (!controller) continue;

      const result = zoneManager.calculateProximityRoster(companion.id);
      if (!result) continue;

      this.handleNPCResponse(companion, result.roster, contextMessages, zoneId);
    }
  }

  /**
   * Trigger an AI response for a single specifically-addressed NPC.
   * Used by the /talk command.  Checks airlock inhabit first; if the NPC is
   * being puppeted by an external AI the airlock service will react via its own
   * chat listener, so we skip the internal LLM call in that case.
   */
  private async triggerTargetedNPCResponse(
    zoneId: string,
    npcId: string,
    messageOrigin: { x: number; y: number; z: number },
    range: number,
  ): Promise<void> {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    // If an airlock session is currently inhabiting this NPC, it will respond
    // via its own socket listener — no internal LLM call needed.
    const redis = this.messageBus.getRedisClient();
    const inhabitId = await redis.get(`airlock:npc:${npcId}`);
    if (inhabitId) return;

    // Also skip player-controlled companions
    if (this.companionToZone.has(npcId)) return;

    const nearbyNPCs = await this.getNearbyNPCs(zoneId, messageOrigin, range);
    const companion = nearbyNPCs.find(c => c.id === npcId);
    if (!companion) return;

    const recentMessages = this.recentChatMessages.get(zoneId) || [];
    const contextMessages = recentMessages.slice(-5).map(m => ({
      sender: m.sender, channel: m.channel, message: m.message,
    }));

    const result = zoneManager.calculateProximityRoster(companion.id);
    if (!result) return;

    this.handleNPCResponse(companion, result.roster, contextMessages, zoneId);
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
   * Tell every player in a zone to remove an entity from their entity list.
   * Call this right after removeMob/removeWildlife so the client despawns it.
   */
  private async broadcastEntityRemoved(zoneId: string, entityId: string): Promise<void> {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const payload = {
      timestamp: Date.now(),
      entities: { removed: [entityId] },
    };

    for (const [charId, charZoneId] of this.characterToZone.entries()) {
      if (charZoneId !== zoneId) continue;
      const socketId = zoneManager.getSocketIdForCharacter(charId);
      if (!socketId) continue;
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId: charId,
        socketId,
        payload: { socketId, event: 'state_update', data: payload },
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Tell every player in a zone to add an entity to their entity list.
   * Call this right after spawnMob/spawnWildlife so the client renders it.
   */
  private async broadcastEntityAdded(
    zoneId: string,
    entity: { id: string; type: string; name: string; position: Vector3; isAlive: boolean; health?: { current: number; max: number }; hostile?: boolean }
  ): Promise<void> {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const payload = {
      timestamp: Date.now(),
      entities: { added: [entity] },
    };

    for (const [charId, charZoneId] of this.characterToZone.entries()) {
      if (charZoneId !== zoneId) continue;
      const socketId = zoneManager.getSocketIdForCharacter(charId);
      if (!socketId) continue;
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId: charId,
        socketId,
        payload: { socketId, event: 'state_update', data: payload },
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Exchange player entities on zone join:
   *  1. Send all existing player entities in the zone to the joiner.
   *  2. Announce the joiner to every other player already in the zone.
   */
  private async _exchangePlayerEntities(
    character: { id: string; name: string; zoneId: string },
    zoneManager: ZoneManager,
  ): Promise<void> {
    const zoneId   = character.zoneId;
    const joinerId = character.id;

    // Build a client-compatible Entity for a player entity.
    const toClientEntity = (e: { id: string; name: string; type: string; description?: string; position: Vector3; isAlive: boolean; heading?: number }) => ({
      id:          e.id,
      name:        e.name,
      type:        e.type,
      description: e.description ?? '',
      position:    e.position,
      isAlive:     e.isAlive,
      heading:     e.heading,
    });

    // ── 1. Send existing players to the joiner ────────────────────────────
    const existingPlayers = zoneManager.getAllEntities()
      .filter(e => e.type === 'player' && e.id !== joinerId);

    if (existingPlayers.length > 0) {
      const joinerSocket = zoneManager.getSocketIdForCharacter(joinerId);
      if (joinerSocket) {
        const payload = {
          timestamp: Date.now(),
          entities: { added: existingPlayers.map(toClientEntity) },
        };
        await this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          characterId: joinerId,
          socketId: joinerSocket,
          payload: { socketId: joinerSocket, event: 'state_update', data: payload },
          timestamp: Date.now(),
        });
        logger.info({ characterId: joinerId, count: existingPlayers.length },
          '[_exchangePlayerEntities] Sent existing players to joiner');
      }
    }

    // ── 2. Announce the joiner to everyone else ───────────────────────────
    const joinerEntity = zoneManager.getEntity(joinerId);
    if (joinerEntity) {
      const addedPayload = {
        timestamp: Date.now(),
        entities: { added: [toClientEntity(joinerEntity)] },
      };
      for (const [charId, charZoneId] of this.characterToZone.entries()) {
        if (charZoneId !== zoneId || charId === joinerId) continue;
        const socketId = zoneManager.getSocketIdForCharacter(charId);
        if (!socketId) continue;
        await this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          characterId: charId,
          socketId,
          payload: { socketId, event: 'state_update', data: addedPayload },
          timestamp: Date.now(),
        });
      }
      logger.info({ characterId: joinerId, zoneId },
        '[_exchangePlayerEntities] Announced joiner to existing players');
    }
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
    // MovementSystem only tracks headings for player/character movement; fall
    // back to the entity's own heading field for mobs, wildlife, etc.
    const heading = movementSystem.getHeading(characterId) ?? entity.heading;

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

    // Update wildlife simulation and flush batched position broadcasts.
    // Skip local managers when the external Rust wildlife sim is connected —
    // the bridge handles all entity state in that case.
    const now = Date.now();
    const externalWildlifeActive = this.wildlifeBridge?.isExternalSimActive() ?? false;
    if (!externalWildlifeActive) {
      for (const wildlifeManager of this.wildlifeManagers.values()) {
        wildlifeManager.update(deltaTime, now);
      }
    }
    void this._flushWildlifePositionUpdates();

    // Update flora growth / spawning (also managed by the Rust sim)
    if (!externalWildlifeActive) {
      for (const floraManager of this.floraManagers.values()) {
        floraManager.update(deltaTime, now);
      }
    }

    // Update mob wander / chase / return movement
    for (const [zoneId, wanderSystem] of this.mobWanderSystems) {
      const zm = this.zones.get(zoneId);
      if (!zm) continue;

      // ── 1. Inject / clear chase targets from CombatManager ───────────────
      // Do this before update() so the wander system has fresh target coords.
      for (const id of wanderSystem.getMobIds()) {
        const isInCombat = this.combatManager.isInCombat(id);

        if (isInCombat) {
          // Mob is actively in combat — feed the latest target position so it
          // chases a moving player.
          const targetId = this.combatManager.getAutoAttackTarget(id);
          if (targetId) {
            const targetEntity = zm.getEntity(targetId);
            if (targetEntity && targetEntity.isAlive) {
              wanderSystem.setChaseTarget(id, targetEntity.position);
            } else {
              // Target died or left the zone — end combat immediately
              wanderSystem.endChase(id);
              this.combatManager.clearAutoAttackTarget(id);
              this.combatManager.clearQueuedActionsForEntity(id);
              zm.setEntityCombatState(id, false);
            }
          }
        } else if (wanderSystem.getAIState(id) === 'chasing') {
          // combatManager.update() timed out this mob's combat but
          // handleCombatTimeouts skips mobs (no characterToZone entry).
          // Handle the cleanup here instead.
          wanderSystem.endChase(id);
          this.combatManager.clearAutoAttackTarget(id);
          this.combatManager.clearQueuedActionsForEntity(id);
          zm.setEntityCombatState(id, false);
        }
      }

      // ── 2. Tick the wander / chase / return system ───────────────────────
      const { moves, leashBroken, stuckRequests } = wanderSystem.update(deltaTime);

      // ── 3. Handle leash breaks — mob chased too far, pull it back ────────
      for (const id of leashBroken) {
        const entity = zm.getEntity(id);
        if (entity) {
          this.combatManager.clearAutoAttackTarget(id);
          this.combatManager.clearQueuedActionsForEntity(id);
          zm.setEntityCombatState(id, false);
          // wanderSystem already transitioned the mob to 'returning'
        }
      }

      // ── 4. Apply position updates (wander, chase, and return all emit moves)
      const physics = zm.getPhysicsSystem();
      let anyMoved = leashBroken.length > 0; // combat-state change counts as a zone update
      for (const { id, position, heading } of moves) {
        const entity = zm.getEntity(id);
        if (!entity) continue;
        if (!entity.isAlive) continue; // Don't move corpses — wander system will be unregistered at despawn
        // Resolve candidate position against building walls before terrain snap,
        // so mobs obey the same structure collisions players do.
        const wallResolved = physics.resolveAgainstStructures(position, 0.5);
        const snapped = zm.updateMobPosition(id, wallResolved, heading);
        // Feed the terrain-snapped Y back so the next tick uses the actual
        // ground elevation and mobs don't float or clip terrain.
        wanderSystem.updateCurrentPosition(id, snapped);
        void this.broadcastPositionUpdate(id, zoneId, snapped);
        anyMoved = true;
      }

      // ── 5. Unstick mobs that geometry has trapped after MAX_STUCK_PICKS attempts
      for (const id of stuckRequests) {
        const entity = zm.getEntity(id);
        if (!entity || !entity.isAlive) continue;
        const nudged  = physics.nudgeToUnstuck(entity.position, 0.5);
        const snapped = zm.updateMobPosition(id, nudged, entity.heading ?? 0);
        wanderSystem.updateCurrentPosition(id, snapped);
        void this.broadcastPositionUpdate(id, zoneId, snapped);
        anyMoved = true;
        logger.debug({ mobId: id, zoneId, nudged }, '[MobWander] Geometry unstuck applied');
      }

      if (anyMoved) void this.publishZoneEntities(zoneId, zm);
    }

    if (now - this.lastPartyStatusBroadcastAt >= PARTY_STATUS_INTERVAL_MS) {
      void this.broadcastPartyStatus();
      this.lastPartyStatusBroadcastAt = now;
    }

    // Tick physics (gravity/freefall) for NPCs, mobs, and wildlife
    for (const [zoneId, zoneManager] of this.zones) {
      const physicsMoved = zoneManager.tickPhysics(deltaTime);
      if (physicsMoved.length > 0) {
        for (const { id, position } of physicsMoved) {
          void this.broadcastPositionUpdate(id, zoneId, position);
        }
        // Keep Redis entity snapshot current so world_entry gets correct positions
        void this.publishZoneEntities(zoneId, zoneManager);
      }
    }

    // Log physics sample once per second — gated behind PHYSICS_DEBUG=true
    if (PHYSICS_DEBUG) {
      this.physicsLogAccumulator = (this.physicsLogAccumulator ?? 0) + deltaTime;
      if (this.physicsLogAccumulator >= 1.0) {
        this.physicsLogAccumulator = 0;
        for (const [zoneId, zoneManager] of this.zones) {
          const sample = zoneManager.getPhysicsSample();
          if (sample.length > 0) {
            logger.info({ zoneId, entities: sample }, '[Physics] Non-player entity positions (1s sample)');
          }
        }
      }
    }

    // Update corruption system (manages its own tick interval internally)
    this.corruptionSystem.update(this.getZoneCorruptionData());

    // Tick day/night cycle and weather for each zone; broadcast on change.
    // Also refresh ZoneRegistry every 60 s so joining players always get a
    // recent timeOfDayValue even if no bucket transition has fired recently.
    this.envRegistryRefreshAccum += deltaTime;
    const doRegistryRefresh = this.envRegistryRefreshAccum >= DistributedWorldManager.ENV_REGISTRY_REFRESH_SECS;
    if (doRegistryRefresh) this.envRegistryRefreshAccum = 0;

    for (const [zoneId, zm] of this.zones) {
      const changed = zm.tickEnvironment(deltaTime);
      if (changed) {
        const envKey = `${zm.getTimeOfDayString()}|${zm.getWeather()}`;
        if (this.lastEnvKeys.get(zoneId) !== envKey) {
          this.lastEnvKeys.set(zoneId, envKey);
          void this._broadcastZoneEnvironment(zoneId, zm);
          void this.zoneRegistry.setZoneEnvironment(zoneId, {
            timeOfDay:      zm.getTimeOfDayString(),
            timeOfDayValue: zm.getTimeOfDayNormalized(),
            weather:        zm.getWeather(),
            lighting:       zm.getLighting(),
          });
        }
      } else if (doRegistryRefresh) {
        // No bucket/weather change, but silently refresh the stored float so
        // any re-joining player gets a value no more than 60 s stale.
        void this.zoneRegistry.setZoneEnvironment(zoneId, {
          timeOfDay:      zm.getTimeOfDayString(),
          timeOfDayValue: zm.getTimeOfDayNormalized(),
          weather:        zm.getWeather(),
          lighting:       zm.getLighting(),
        });
      }

      // Publish weather & climate to Redis for external sims (wildlife, climate).
      // WeatherBridge always publishes; ClimateBridge defers if climate_sim is active.
      const wb = this.weatherBridges.get(zoneId);
      const cb = this.climateBridges.get(zoneId);
      if (wb) void wb.tick(zm.getWeather());
      if (cb) void cb.tick(zm.getTimeOfDayNormalized(), zm.getWeather());
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
   * Find the zone ID for any entity type (mob, wildlife, etc.) not in the
   * dedicated characterToZone / companionToZone maps.
   * Linear scan across zones — only called for non-player/companion entities.
   */
  private findZoneForEntity(entityId: string): string | undefined {
    for (const [zoneId, zoneManager] of this.zones) {
      if (zoneManager.getEntity(entityId)) return zoneId;
    }
    return undefined;
  }

  /**
   * Process auto-attacks for all entities whose weapon timer is ready
   * Auto-attack runs on weapon speed, separate from ATB (which is for abilities)
   */
  private async processAutoAttacks(): Promise<void> {
    const basicAttack = this.abilitySystem.getDefaultAbility();
    const readyAttackers = this.combatManager.getAutoAttackersReady();

    for (const { attackerId, targetId } of readyAttackers) {
      // Find which zone the attacker is in (covers players, companions, mobs, wildlife)
      const zoneId = this.characterToZone.get(attackerId)
        || this.companionToZone.get(attackerId)
        || this.findZoneForEntity(attackerId);
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
    finalPosition: Vector3,
    source: 'command' | 'direct' = 'command',
  ): Promise<void> {
    const zoneId = this.characterToZone.get(characterId);
    if (!zoneId) return;

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    // Update position one final time
    zoneManager.updatePlayerPosition(characterId, finalPosition);

    // Broadcast final position update with idle animation state
    await this.broadcastPositionUpdate(characterId, zoneId, finalPosition);

    // Only send narrative feedback for command-sourced movements.
    // Real-time WASD / TargetWindow Approach/Retreat moves use source='direct'
    // and produce no chat messages — they happen too frequently and have no
    // meaningful narrative content.
    if (source === 'command') {
      const socketId = zoneManager.getSocketIdForCharacter(characterId);
      if (socketId) {
        // Build narrative message based on reason
        let narrative: string;
        switch (reason) {
          case 'distance_reached':
            narrative = 'You arrive at your destination.';
            break;
          case 'target_reached':
            // Suppress during combat — the player is just repositioning mid-fight.
            if (this.combatManager.isInCombat(characterId)) return;
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
    }

    // Final proximity update
    await this.sendProximityRosterToEntity(characterId);
    await this.broadcastNearbyUpdate(zoneId);

    logger.debug({ characterId, reason, source, position: finalPosition }, 'Movement completed');
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
   * Publish authoritative entity positions for a zone to Redis.
   * Excludes players (they move too frequently and are tracked separately).
   */
  private async publishZoneEntities(zoneId: string, zoneManager: ZoneManager): Promise<void> {
    const entities = zoneManager.getAllEntities()
      .filter(e => e.type !== 'player')
      .map(e => ({
        id:          e.id,
        name:        e.name,
        type:        e.type,
        position:    e.position,
        isAlive:     e.isAlive,
        description: e.description,
        // Mob/NPC fields for client nameplate display
        ...(e.tag      !== undefined && { tag:      e.tag }),
        ...(e.level    !== undefined && { level:    e.level }),
        ...(e.faction  !== undefined && { faction:  e.faction }),
        ...(e.aiType   !== undefined && { aiType:   e.aiType }),
        ...(e.notorious                && { notorious: e.notorious }),
        // Health object for the HP bar (included whenever tracked — mobs/companions)
        ...(e.currentHealth !== undefined && e.maxHealth !== undefined && {
          health: { current: e.currentHealth, max: e.maxHealth },
        }),
      }));
    await this.zoneRegistry.setZoneEntities(zoneId, entities);
  }

  /**
   * Push the current zone environment (time of day + weather) to every player
   * in the zone via a partial state_update.  The client's SceneManager will
   * smoothly transition lighting / fog to match.
   */
  private async _broadcastZoneEnvironment(zoneId: string, zm: ZoneManager): Promise<void> {
    const socketIds = zm.getPlayerSocketIds();
    if (socketIds.length === 0) return;

    const zonePartial = {
      timeOfDay:      zm.getTimeOfDayString(),
      timeOfDayValue: zm.getTimeOfDayNormalized(),
      weather:        zm.getWeather(),
      lighting:       zm.getLighting(),
    };

    await Promise.all(socketIds.map(socketId =>
      this.messageBus.publish('gateway:output', {
        type:     MessageType.STATE_UPDATE,
        socketId,
        payload:  { zone: zonePartial },
      })
    ));
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

    void this.wildlifeBridge?.stop();
    this.wildlifeBridge = null;
  }
}
