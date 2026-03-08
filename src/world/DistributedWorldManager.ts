import { logger } from '@/utils/logger';
import { AccountService, CharacterService, CompanionService, MobService, ZoneService, InventoryService, LootService, WalletService, prisma } from '@/database';
import { randomUUID } from 'crypto';
import type { LootSessionStartPayload, LootItemResultPayload, LootSessionEndPayload, LootSessionItem } from '@/network/protocol/types';
import { ZoneManager } from './ZoneManager';
import { MovementSystem, type MovementStartEvent } from './MovementSystem';
import { MessageBus, MessageType, ZoneRegistry, type MessageEnvelope, type ClientMessagePayload } from '@/messaging';
import { NPCAIController, LLMService, getBaselineForArchetype, mergePartialSettings } from '@/ai';
import type { CompanionCombatSettings } from '@/ai';
import { T1_ABILITIES, resolveAbilitiesFromLoadout } from '@/combat/AbilityData';
import { ARCHETYPE_MODIFIERS } from '@/ai/CompanionArchetypeModifiers';
import type { CompanionArchetype } from '@/ai/CompanionCombatSettings';
import { canCompanionSlotActive, canCompanionSlotPassive } from '@/ai/CompanionAbilityValidator';
import { BehaviorTreeExecutor, type BehaviorNode, type BehaviorAction } from '@/ai/behaviors/BehaviorTreeExecutor';
import { type ConditionContext, type PlantInfo } from '@/ai/behaviors/ConditionEvaluator';
import { DEFAULT_HARVEST_TREE } from '@/ai/behaviors/HarvestBehavior';
import { CompanionTaskService } from '@/ai/CompanionTaskService';
import { CommandRegistry, CommandParser, CommandExecutor, registerAllCommands, setArenaManager, setVaultManager } from '@/commands';
import { ArenaManager } from '@/arena/ArenaManager';
import { VaultManager, TEST_VAULT_TEMPLATE } from '@/vault';
import type { VaultScalingModifiers, VaultTemplateDefinition } from '@/vault';
import { getWallSegments, getSpawnPositions, tileGridToJSON, type VaultTileGridData } from '@/vault/VaultTileGrid';
import { CollisionLayer } from '@/physics/types';
import type { PhysicsEntity } from '@/physics/types';
import type { CommandContext, CommandEvent } from '@/commands/types';
import type { Character, Companion, Prisma } from '@prisma/client';
import { StatCalculator } from '@/game/stats/StatCalculator';
import {
  unlockAbility,
  slotActiveAbility,
  slotPassiveAbility,
  getAbilitySummary,
  getNodeInfo,
  listWebNodes,
  parsePassiveLoadout,
  loadAbilityState,
  getNode,
} from '@/game/abilities/tree';
import { PASSIVE_WEB_MAP } from '@/game/abilities/tree/PassiveWeb';
import { CombatManager } from '@/combat/CombatManager';
import { AbilitySystem } from '@/combat/AbilitySystem';
import { DamageCalculator } from '@/combat/DamageCalculator';
import { buildCombatNarrative } from '@/combat/CombatNarratives';
import type { ActiveBuff, CombatAbilityDefinition, CombatStats, DamageProfileSegment, PhysicalDamageType } from '@/combat/types';
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
import { ScriptedObjectController, type ScriptedObjectControllerCallbacks } from '@/scripting/ScriptedObjectController';
import { ScriptedObjectService } from '@/scripting/ScriptedObjectService';
import { ObjectVerbScriptService } from '@/scripting/ObjectVerbScriptService';
import {
  GuildService,
  GuildBeaconService,
  LibraryBeaconService,
  GuildChatBridge,
  FoundingCeremonyManager,
  EmberClockSystem,
  getEmberClockSystem,
  resetEmberClockSystem,
  LibraryAssaultSystem,
  getLibraryAssaultSystem,
  resetLibraryAssaultSystem,
  isPointInPolygon,
  interpolatePolygonTier,
  distance2D,
  type BeaconStateChange,
  type NarrativeStep,
  type Point2D,
  type TieredPoint,
} from '@/guild';

const FEET_TO_METERS = 0.3048;
const PHYSICS_DEBUG = process.env.PHYSICS_DEBUG === 'true';
const COMBAT_EVENT_RANGE_METERS = 45.72; // 150 feet

// ── Range-check geometry ───────────────────────────────────────────────────
// Every entity is registered with a 0.5 m bounding sphere.
// Effective melee reach = arm reach past the sphere edge + both radii + weapon + buffer.
const ENTITY_RADIUS      = 0.5; // metres — matches PhysicsSystem bounding sphere
const BASE_REACH         = 1.0; // metres — arm reach beyond sphere edge (H2H baseline)
const MELEE_RANGE_BUFFER = 1.0; // metres — gameplay buffer so you don't have to be nose-to-nose

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
  /** Last companion_status broadcast time per companion ID (throttle ~1s). */
  private _companionStatusLastSent = new Map<string, { time: number; state: string }>();
  private companionBehaviorExecutors: Map<string, BehaviorTreeExecutor> = new Map(); // companionId -> task executor
  private companionTaskService: CompanionTaskService = new CompanionTaskService();
  private llmService: LLMService;
  private wildlifeBridge: WildlifeBridge | null = null;
  private recentChatMessages: Map<string, { sender: string; channel: string; message: string; timestamp: number }[]> = new Map(); // zoneId -> messages
  private companionChatHistory: Map<string, { sender: string; channel: string; message: string }[]> = new Map(); // companionId -> conversation
  private proximityRosterHashes: Map<string, string> = new Map(); // characterId -> roster hash (for dirty checking - legacy)
  private previousRosters: Map<string, any> = new Map(); // characterId -> previous roster (for delta calculation)
  private combatManager: CombatManager;
  private abilitySystem: AbilitySystem;
  private damageCalculator: DamageCalculator;
  private respawnTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Timestamps (ms) of the last /unstuck use per characterId — enforces cooldown. */
  private readonly unstuckCooldowns = new Map<string, number>();
  /** Timestamps (ms) of the last /return use per characterId — enforces cooldown. */
  private readonly returnCooldowns = new Map<string, number>();
  private movementSystem: MovementSystem;
  private attackSpeedBonusCache: Map<string, number> = new Map();
  private wildlifeManagers: Map<string, WildlifeManager> = new Map();
  private floraManagers:   Map<string, FloraManager>    = new Map();
  private mobWanderSystems: Map<string, MobWanderSystem> = new Map();
  private weatherBridges:  Map<string, WeatherBridge>  = new Map();
  private climateBridges:  Map<string, ClimateBridge>  = new Map();
  private scriptedObjectControllers: Map<string, ScriptedObjectController> = new Map();
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

  // ── Guild system ────────────────────────────────────────────────────────
  private emberClockSystem: EmberClockSystem;
  private libraryAssaultSystem: LibraryAssaultSystem;
  private foundingCeremony: FoundingCeremonyManager;
  private guildChatBridge: GuildChatBridge;
  /** Cache of lit beacons per zone for beacon check callback. Refreshed on state changes. */
  private litBeaconCache: Map<string, Array<{ id: string; guildId: string; worldX: number; worldZ: number; tier: number; effectRadius: number }>> = new Map();
  /** Cache of active guild polygons for corruption check. Refreshed on state changes. */
  private activePolygonCache: Array<{
    guildId: string;
    vertices: Point2D[];
    beaconTiers: TieredPoint[];
  }> = [];
  /** Accumulator for beacon HP/MP regen tick (seconds). */
  private beaconRegenAccumulator = 0;
  private static readonly BEACON_REGEN_INTERVAL_S = 5;
  private static readonly BEACON_HP_REGEN_BASE_PCT = 0.02; // 2% of maxHP per tick
  private static readonly BEACON_MP_REGEN_BASE_PCT = 0.03; // 3% of maxMana per tick

  /** Passive stamina regen accumulator (seconds). */
  private staminaRegenAccumulator = 0;
  private static readonly STAMINA_REGEN_INTERVAL_S = 3;
  private static readonly STAMINA_REGEN_BASE_PCT = 0.01; // 1% of maxStamina per tick

  /** Cache of civic anchors per zone for regen proximity checks. */
  private civicAnchorCache: Map<string, Array<{ worldX: number; worldZ: number; wardRadius: number; type: string }>> = new Map();
  /** Cache of library beacons per zone for regen proximity checks. */
  private libraryBeaconCache: Map<string, Array<{ worldX: number; worldZ: number; catchmentRadius: number; isOnline: boolean }>> = new Map();

  /** Pending guild invites: targetCharacterId → { guildId, guildName, guildTag, inviterId, inviterName } */
  private pendingGuildInvites: Map<string, { guildId: string; guildName: string; guildTag: string; inviterId: string; inviterName: string; expiresAt: number }> = new Map();

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

  // Vault system
  private vaultManager!: VaultManager;
  private vaultInstances: Map<string, {
    zoneManager: ZoneManager;
    instanceId: string;
    playerCount: number;
    idleTimer: NodeJS.Timeout | null;
  }> = new Map();

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
    this.corruptionSystem.setBeaconCheckCallback(
      (characterId, zoneId, position) => this.checkBeaconZone(characterId, zoneId, position)
    );

    // Initialize guild systems
    this.foundingCeremony = new FoundingCeremonyManager();
    this.guildChatBridge = new GuildChatBridge(this.messageBus);

    this.emberClockSystem = getEmberClockSystem();
    this.emberClockSystem.setStateChangeCallback((change) => this.handleBeaconStateChange(change));
    this.emberClockSystem.setAnnouncementCallback((announcement) => {
      void this.broadcastEmberClockAnnouncement(announcement);
    });

    this.libraryAssaultSystem = getLibraryAssaultSystem();
    this.libraryAssaultSystem.setAssaultStartCallback((data) => {
      void this.broadcastLibraryAssaultStart(data);
    });
    this.libraryAssaultSystem.setAssaultResolvedCallback((data) => {
      void this.broadcastLibraryAssaultResolved(data);
    });

    // Guild chat delivery — forward messages to online members in this server
    this.guildChatBridge.setDeliveryCallback((guildId, payload) => {
      void this.deliverGuildChat(guildId, payload);
    });

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

    // Initialize vault system
    this.vaultManager = new VaultManager(
      // broadcast: send an event to specific character IDs via the gateway
      (_instanceId, recipientIds, event, data) => {
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
      // spawnMob: create a mob entity in the vault zone
      async (zoneId, mobTag, position, level, scalingModifiers, wanderRadius) => {
        return this.spawnVaultMob(zoneId, mobTag, position, level, scalingModifiers, wanderRadius);
      },
      // createZone: spin up vault zone instance
      async (instanceId, vaultTemplate) => {
        return this.spinUpVaultInstance(instanceId, vaultTemplate);
      },
      // destroyZone: tear down vault zone instance
      async (zoneId) => {
        await this.tearDownVaultInstance(zoneId);
      },
      // ejectPlayer: send player back to their return point
      async (characterId) => {
        await this.ejectPlayerFromVault(characterId);
      },
      // awardGold: give completion gold to a participant
      async (characterId, amount) => {
        await WalletService.addGold(characterId, amount, 'vault_completion');
      },
    );
    setVaultManager(this.vaultManager);
    logger.info('Vault system initialized');
  }

  /**
   * Initialize world manager - load assigned zones
   */
  async initialize(): Promise<void> {
    logger.info({ serverId: this.serverId, zoneCount: this.assignedZoneIds.length }, 'Initializing distributed world manager');

    // Clean up stale ephemeral zone assignments left by a previous run of this
    // server (e.g. crash/restart).  The serverId is static ('zoneserver-1'), so
    // the heartbeat check passes even though the vault/village instances are gone.
    const staleAssignments = await this.zoneRegistry.getAllZoneAssignments();
    for (const assignment of staleAssignments) {
      if (assignment.serverId !== this.serverId) continue;
      if (assignment.zoneId.startsWith('vault:') || assignment.zoneId.startsWith('village:')) {
        logger.info({ zoneId: assignment.zoneId }, 'Cleaning up stale ephemeral zone assignment from previous server run');
        await this.zoneRegistry.unassignZone(assignment.zoneId);
      }
    }

    // If no zones assigned, load all zones (for single-server mode)
    if (this.assignedZoneIds.length === 0) {
      const allZones = await ZoneService.findAll();
      // Filter out village and vault zones — they are spun up on demand, not at startup
      this.assignedZoneIds = allZones.filter(z =>
        !VillageService.isVillageZone(z.id) && !VaultManager.isVaultZone(z.id)
      ).map(z => z.id);
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

      // Initialize scripted object controller for this zone
      {
        const soZoneId = zone.id;
        const soZoneManager = zoneManager;
        const soCallbacks: ScriptedObjectControllerCallbacks = {
          onSay: (objectId, objectName, message, position) => {
            void this.broadcastScriptedObjectMessage(soZoneId, objectId, objectName, 'say', message, position);
          },
          onEmote: (objectId, objectName, message, position) => {
            void this.broadcastScriptedObjectMessage(soZoneId, objectId, objectName, 'emote', message, position);
          },
          onNotifyOwner: (characterId, message) => {
            void this.sendSystemMessageToCharacter(characterId, message);
          },
          getNearbyEntities: (position, rangeMeters) => {
            const entities = soZoneManager.getEntitiesInRangeForCombat(position, rangeMeters);
            return entities
              .filter(e => e.type !== 'scripted_object' && e.type !== 'structure')
              .map(e => {
                const dx = e.position.x - position.x;
                const dy = e.position.y - position.y;
                const dz = e.position.z - position.z;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                return { id: e.id, name: e.name, type: e.type, distance: Math.round(dist * 100) / 100 };
              });
          },
          getTimeOfDay: () => soZoneManager.getTimeOfDayNormalized(),
          getWeather: () => soZoneManager.getWeather(),
          getZoneInfo: () => {
            const z = soZoneManager.getZone();
            return { id: z.id, name: z.name, contentRating: z.contentRating || 'T' };
          },
        };
        const soController = new ScriptedObjectController(soZoneId, soCallbacks);
        void soController.loadFromDatabase().then(() => {
          // After loading, also register entities in ZoneManager for proximity roster
          for (const obj of soController['instances'].values()) {
            soZoneManager.addScriptedObject({
              id: obj.id,
              name: obj.name,
              description: obj.description,
              position: obj.position,
            });
          }
        });
        this.scriptedObjectControllers.set(soZoneId, soController);
      }

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

      // ── Static world fixtures (dungeon entrances, interactive objects) ───────
      if (zoneId === 'USA_NY_Stephentown') {
        zoneManager.addScriptedObject({
          id: 'dungeon_entrance_stephentown_01',
          name: 'Ancient Dungeon Entrance',
          description: 'A weathered stone archway leads down into darkness. Strange runes flicker faintly along its edges.',
          position: { x: 80, y: 0, z: 45 },
          interactive: true,
          modelAsset: 'dungeon/Dungeon_Entrance_01.glb',
          modelScale: 3,
        });
        logger.info({ zoneId }, 'Spawned dungeon entrance fixture');
      }

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

    // Load beacon caches and restore expired libraries
    await this.refreshBeaconCaches();
    await LibraryBeaconService.checkAndRestoreExpired();
    logger.info('Guild beacon caches loaded');

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
      const controller = new NPCAIController(
        companion, null,
        this._buildCompanionTriggerCallback(companion),
      );
      this.npcControllers.set(companion.id, controller);
      this.companionToZone.set(companion.id, zoneId);

      // Compute max mana/stamina from companion stats for HUD resource bars
      const zm = this.zones.get(zoneId);
      if (zm) {
        const cStats = (companion.stats as Record<string, number>) || {};
        const derived = StatCalculator.calculateDerivedStats({
          strength: cStats.strength ?? 10, vitality: cStats.vitality ?? 10,
          dexterity: cStats.dexterity ?? 10, agility: cStats.agility ?? 10,
          intelligence: cStats.intelligence ?? 10, wisdom: cStats.wisdom ?? 10,
        }, companion.level);
        zm.setEntityResources(companion.id, {
          currentMana: derived.maxMana, maxMana: derived.maxMana,
          currentStamina: derived.maxStamina, maxStamina: derived.maxStamina,
        });
      }

      // Resume behavior tree if companion was in TASKED mode with a stored tree
      if (companion.behaviorState === 'tasked' && companion.behaviorTree) {
        try {
          const tree = companion.behaviorTree as unknown as BehaviorNode;
          this.companionBehaviorExecutors.set(companion.id, new BehaviorTreeExecutor(tree));
          logger.debug({ companionId: companion.id, task: companion.taskDescription }, 'Companion behavior tree resumed');
        } catch {
          logger.warn({ companionId: companion.id }, 'Failed to resume companion behavior tree');
        }
      }

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
      case MessageType.COMPANION_SPAWN:
        void this.handleCompanionSpawn(message);
        break;
      case MessageType.EDITOR_ACTION:
        void this.handleEditorAction(message);
        break;
      case MessageType.COMPANION_SETTINGS_UPDATE:
        void this.handleCompanionSettingsUpdate(message);
        break;
      case MessageType.COMPANION_SOCIAL_ACTION:
        void this.handleCompanionSocialAction(message);
        break;
      default:
        logger.warn({ type: message.type }, 'Unhandled message type');
    }
  }

  /**
   * Handle editor messages routed from gateway.
   */
  private async handleEditorAction(message: MessageEnvelope): Promise<void> {
    const { action, editorId, source } = message.payload as {
      action: string;
      editorId: string;
      source?: string;
    };

    switch (action) {
      case 'save':
        await this.handleEditorSave(editorId, source ?? '');
        break;
      case 'compile':
        await this.handleEditorCompile(editorId, source ?? '');
        break;
      case 'revert':
        await this.handleEditorRevert(editorId);
        break;
      case 'close':
        this.handleEditorClose(editorId);
        break;
      default:
        logger.warn({ action, editorId }, 'Unknown editor action');
    }
  }

  /**
   * Dynamically register a newly created player companion in a running zone.
   */
  async registerCompanionInZone(companion: Companion, zoneId: string): Promise<void> {
    const zm = this.zones.get(zoneId);
    if (!zm) {
      logger.warn({ companionId: companion.id, zoneId }, 'Cannot register companion — zone not managed');
      return;
    }

    zm.addCompanion(companion);

    // ── Level sync: companion always matches owner ──────────────────────
    const ownerCharId = companion.ownerCharacterId;
    let ownerLevel = ownerCharId ? this._charLevel.get(ownerCharId) : undefined;
    if (!ownerLevel && ownerCharId) {
      // Fallback: load from DB if not cached
      try {
        const ownerChar = await prisma.character.findUnique({ where: { id: ownerCharId }, select: { level: true } });
        if (ownerChar) ownerLevel = ownerChar.level;
      } catch { /* ignore */ }
    }
    if (ownerLevel && companion.level !== ownerLevel) {
      await this.syncCompanionLevel(companion, ownerLevel, zm);
    }

    // Compute max mana/stamina from companion stats so the HUD can show resource bars
    const compStats = (companion.stats as Record<string, number>) || {};
    const derived = StatCalculator.calculateDerivedStats({
      strength: compStats.strength ?? 10, vitality: compStats.vitality ?? 10,
      dexterity: compStats.dexterity ?? 10, agility: compStats.agility ?? 10,
      intelligence: compStats.intelligence ?? 10, wisdom: compStats.wisdom ?? 10,
    }, companion.level);

    // ── Archetype modifiers: apply stat buffs/debuffs ───────────────────
    const archetype = (companion.archetype ?? 'opportunist') as CompanionArchetype;
    const archetypeMod = ARCHETYPE_MODIFIERS[archetype] ?? ARCHETYPE_MODIFIERS.opportunist;
    const mods = archetypeMod.statMods;

    // Apply HP bonus from archetype and update zone entity
    const archetypeHpBonus = mods.maxHp ?? 0;
    if (archetypeHpBonus !== 0) {
      const adjustedMaxHp = companion.maxHealth + archetypeHpBonus;
      const adjustedCurrentHp = Math.min(companion.currentHealth + archetypeHpBonus, adjustedMaxHp);
      zm.setEntityHealth(companion.id, adjustedCurrentHp, adjustedMaxHp);
    }

    zm.setEntityResources(companion.id, {
      currentMana: derived.maxMana, maxMana: derived.maxMana,
      currentStamina: derived.maxStamina, maxStamina: derived.maxStamina,
    });

    // Apply threat and heal potency multipliers to combat state
    if (mods.threatMultiplier !== undefined) {
      this.combatManager.setThreatMultiplier(companion.id, mods.threatMultiplier);
    }
    if (mods.healPotencyMult !== undefined) {
      this.combatManager.setHealPotencyMult(companion.id, mods.healPotencyMult);
    }

    const controller = new NPCAIController(
      companion, null,
      this._buildCompanionTriggerCallback(companion),
    );

    // ── Ability resolution: loadout > legacy abilityIds > archetype defaults ──
    const companionActiveLoadout = companion.activeLoadout as { slots: (string | null)[] } | null;
    let resolvedAbilities: CombatAbilityDefinition[] = [];

    if (companionActiveLoadout?.slots?.some(s => s !== null)) {
      // Use the companion's active loadout to resolve abilities
      resolvedAbilities = resolveAbilitiesFromLoadout(companionActiveLoadout.slots);
    } else {
      // Fall back to legacy abilityIds or archetype defaults
      let abilityIds = companion.abilityIds ?? [];
      if (abilityIds.length === 0) {
        const defaultAbilities: Record<string, string[]> = {
          scrappy_fighter: ['mend', 'power_strike'],
          cautious_healer: ['mend', 'embolden'],
          opportunist:     ['mend', 'shadow_bolt', 'ensnare'],
          tank:            ['mend', 'provoke'],
        };
        abilityIds = defaultAbilities[archetype] ?? ['mend'];
        void CompanionService.updateCombatConfig(companion.id, { abilityIds });
        logger.info({ companionId: companion.id, archetype, abilityIds }, 'Assigned default abilities to companion');
      }
      resolvedAbilities = T1_ABILITIES.filter(a => abilityIds.includes(a.id));
    }

    if (resolvedAbilities.length > 0) controller.setAbilities(resolvedAbilities);
    this.npcControllers.set(companion.id, controller);
    this.companionToZone.set(companion.id, zoneId);

    void this.publishZoneEntities(zoneId, zm);
    logger.info({
      companionId: companion.id, name: companion.name, zoneId,
      level: companion.level, archetype, archetypeBuff: archetypeMod.label,
    }, 'Player companion registered in running zone');
  }

  /**
   * Sync a companion's level and stats to match a target level.
   * Scales core stats proportionally and recomputes derived stats.
   */
  private async syncCompanionLevel(companion: Companion, targetLevel: number, zm: ZoneManager): Promise<void> {
    const currentStats = (companion.stats as Record<string, number>) || {};
    // Base stats at level 1, then +2 per level for each core stat
    const baseStats = {
      strength:     (currentStats.strength ?? 8),
      vitality:     (currentStats.vitality ?? 10),
      dexterity:    (currentStats.dexterity ?? 10),
      agility:      (currentStats.agility ?? 10),
      intelligence: (currentStats.intelligence ?? 8),
      wisdom:       (currentStats.wisdom ?? 8),
    };
    // Scale: each stat gets +2 per level beyond 1
    const levelBonus = (targetLevel - 1) * 2;
    const scaledStats = {
      strength:     baseStats.strength + levelBonus,
      vitality:     baseStats.vitality + levelBonus,
      dexterity:    baseStats.dexterity + levelBonus,
      agility:      baseStats.agility + levelBonus,
      intelligence: baseStats.intelligence + levelBonus,
      wisdom:       baseStats.wisdom + levelBonus,
    };
    const derived = StatCalculator.calculateDerivedStats(scaledStats, targetLevel);
    const newMaxHealth = derived.maxHp;
    // Scale current HP proportionally
    const hpRatio = companion.maxHealth > 0 ? companion.currentHealth / companion.maxHealth : 1;
    const newCurrentHealth = Math.max(1, Math.round(newMaxHealth * hpRatio));

    // Update DB
    await CompanionService.updateLevel(companion.id, targetLevel, scaledStats, newMaxHealth, newCurrentHealth);

    // Update in-memory companion object
    (companion as { level: number }).level = targetLevel;
    (companion as { stats: Record<string, number> }).stats = scaledStats;
    (companion as { maxHealth: number }).maxHealth = newMaxHealth;
    (companion as { currentHealth: number }).currentHealth = newCurrentHealth;

    // Update zone entity
    const entity = zm.getEntity(companion.id);
    if (entity) {
      (entity as { level: number }).level = targetLevel;
      (entity as { currentHealth: number }).currentHealth = newCurrentHealth;
      (entity as { maxHealth: number }).maxHealth = newMaxHealth;
    }

    logger.info({
      companionId: companion.id, oldLevel: companion.level, newLevel: targetLevel,
    }, 'Companion level synced to owner');
  }

  /**
   * When a player levels up, find their companion and sync its level.
   */
  private async syncCompanionOnLevelUp(characterId: string, newLevel: number): Promise<void> {
    // Find companion by iterating companionToZone and checking ownership
    for (const [companionId, zoneId] of this.companionToZone.entries()) {
      const zm = this.zones.get(zoneId);
      if (!zm) continue;
      const entity = zm.getEntity(companionId);
      if (!entity || entity.type !== 'companion') continue;

      // Look up the companion's owner
      const comp = zm.getCompanions().find(c => c.id === companionId);
      if (!comp) continue;

      // We need to load the companion from DB to check ownership
      const companion = await CompanionService.findById(companionId);
      if (!companion || companion.ownerCharacterId !== characterId) continue;
      if (companion.level >= newLevel) continue;

      await this.syncCompanionLevel(companion, newLevel, zm);

      // Notify owner
      await this._sendToSocket(characterId, 'event', {
        eventType: 'companion_level_up',
        level: newLevel,
        message: `Your companion has reached level ${newLevel}!`,
      });

      // Update the entity in the zone for HUD display
      void this.publishZoneEntities(zoneId, zm);
      break; // One companion per character
    }
  }

  private async handleCompanionSpawn(message: MessageEnvelope): Promise<void> {
    const { companionId, zoneId } = message.payload as { companionId: string; zoneId: string };

    const companion = await CompanionService.findById(companionId);
    if (!companion) {
      logger.error({ companionId }, 'Companion not found for spawn');
      return;
    }

    await this.registerCompanionInZone(companion, zoneId);
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

    // ── Vault instance tracking ──
    if (VaultManager.isVaultZone(character.zoneId)) {
      const vaultInst = this.vaultInstances.get(character.zoneId);
      if (vaultInst) {
        if (vaultInst.idleTimer) { clearTimeout(vaultInst.idleTimer); vaultInst.idleTimer = null; }
        vaultInst.playerCount++;
      }
      this.vaultManager.handlePlayerJoin(character.id);
    }

    // ── Re-spawn or teleport owned companion ──
    // Companions despawn when the owner leaves; re-spawn them at the owner's
    // position when the owner enters a zone so the companion follows naturally.
    // If the companion already exists (server didn't cycle), teleport it to the
    // owner instead of silently leaving it wherever it was.
    try {
      const ownedCompanion = await CompanionService.findByOwnerCharacter(character.id);
      if (ownedCompanion) {
        const ownerPos = {
          x: character.positionX,
          y: character.positionY,
          z: character.positionZ,
        };

        if (!this.npcControllers.has(ownedCompanion.id)) {
          // Companion not registered — full re-spawn at owner position
          await CompanionService.updatePosition(ownedCompanion.id, {
            zoneId: character.zoneId,
            positionX: ownerPos.x,
            positionY: ownerPos.y,
            positionZ: ownerPos.z,
          });
          const refreshed = await CompanionService.findById(ownedCompanion.id);
          if (refreshed) {
            await this.registerCompanionInZone(refreshed, character.zoneId);
            this._pushCompanionConfig(character.id, refreshed);
            logger.info({ companionId: refreshed.id, ownerId: character.id, zoneId: character.zoneId },
              'Companion re-spawned — owner entered zone');
          }
        } else {
          // Companion already registered — teleport it to the owner
          const zm = this.zones.get(character.zoneId);
          if (zm) {
            const heading = 0;
            zm.updateCompanionPosition(ownedCompanion.id, ownerPos, heading);
            void this.broadcastPositionUpdate(ownedCompanion.id, character.zoneId, ownerPos, 0, 0);
            logger.info({ companionId: ownedCompanion.id, ownerId: character.id },
              'Companion teleported to owner on login');
          }
          // Push config so the CompanionHUD populates immediately
          this._pushCompanionConfig(character.id, ownedCompanion);
        }
      }
    } catch (err) {
      logger.warn({ err, characterId: character.id }, 'Failed to re-spawn/teleport companion on zone entry');
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

    // ── Despawn owned companions so they don't follow other players ──
    const removedIds: string[] = [characterId];
    for (const [companionId, cZoneId] of this.companionToZone.entries()) {
      if (cZoneId !== zoneId) continue;
      const ctrl = this.npcControllers.get(companionId);
      if (!ctrl) continue;
      if (ctrl.getCompanion().ownerCharacterId !== characterId) continue;

      // Remove from zone, controller maps, behavior executor, and chat history
      zoneManager.removeCompanion(companionId);
      this.npcControllers.delete(companionId);
      this.companionToZone.delete(companionId);
      this.companionBehaviorExecutors.delete(companionId);
      this.companionChatHistory.delete(companionId);
      removedIds.push(companionId);

      logger.info({ companionId, ownerId: characterId, zoneId }, 'Companion despawned — owner left zone');
    }

    // Tell remaining clients to remove this player + their companion entities
    const removePayload = {
      timestamp: Date.now(),
      entities: { removed: removedIds },
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

    // ── Vault instance tracking: handle disconnect ──
    if (VaultManager.isVaultZone(zoneId)) {
      const vaultInstLeave = this.vaultInstances.get(zoneId);
      if (vaultInstLeave) {
        vaultInstLeave.playerCount = Math.max(0, vaultInstLeave.playerCount - 1);
      }
      this.vaultManager.handleDisconnect(characterId);
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
        modelAsset: struct.catalog.modelAsset,
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
    this.movementQueue.delete(zoneId);

    logger.info({ zoneId }, 'Village instance torn down');
  }

  // ── Vault instance management ─────────────────────────────────────────────

  /**
   * Spin up a vault zone instance. Creates a Zone DB record and ZoneManager,
   * following the village spin-up pattern.
   */
  private async spinUpVaultInstance(
    instanceId: string,
    template: VaultTemplateDefinition,
  ): Promise<string> {
    const zoneId = VaultManager.vaultZoneId(instanceId);

    // Already running?
    if (this.vaultInstances.has(zoneId)) {
      return zoneId;
    }

    // Create Zone DB record with unique negative world coordinates
    const coords = VaultManager.vaultWorldCoords(instanceId);

    await prisma.zone.create({
      data: {
        id: zoneId,
        name: template.name,
        description: template.description,
        worldX: coords.worldX,
        worldY: coords.worldY,
        sizeX: template.zoneDimensions.sizeX,
        sizeY: template.zoneDimensions.sizeY,
        sizeZ: template.zoneDimensions.sizeZ,
        terrainType: 'vault',
        weatherEnabled: false,
        timeOfDayEnabled: false,
        corruptionTag: 'DEEP_LAB',
        isWarded: false,
      },
    });

    const zone = await ZoneService.findById(zoneId);
    if (!zone) throw new Error('Failed to create vault zone record');

    const zoneManager = new ZoneManager(zone);
    await zoneManager.initialize();

    // Vault zones use static indoor lighting (unaffected by time-of-day)
    zoneManager.setLightingOverride('vault');

    // Subscribe to the vault zone's input channel
    const channel = `zone:${zoneId}:input`;
    await this.messageBus.subscribe(channel, (msg: MessageEnvelope) => this.handleZoneMessage(msg));

    // Register in zone maps
    this.zones.set(zoneId, zoneManager);
    this.movementSystem.registerZoneManager(zoneId, zoneManager);
    this.vaultInstances.set(zoneId, {
      zoneManager,
      instanceId,
      playerCount: 0,
      idleTimer: null,
    });

    // Register in ZoneRegistry so gateway can find it
    await this.zoneRegistry.assignZone(zoneId, this.serverId);

    // Create a wander system for vault mobs (mobs are added as they spawn)
    this.mobWanderSystems.set(zoneId, new MobWanderSystem());

    // Publish entities to Redis for world_entry
    await this.publishZoneEntities(zoneId, zoneManager);

    // Write environment
    await this.zoneRegistry.setZoneEnvironment(zoneId, {
      timeOfDay: zoneManager.getTimeOfDayString(),
      timeOfDayValue: zoneManager.getTimeOfDayNormalized(),
      weather: zoneManager.getWeather(),
      lighting: zoneManager.getLighting(),
    });

    logger.info({ zoneId, instanceId, vaultName: template.name }, 'Vault instance spun up');
    return zoneId;
  }

  /**
   * Tear down a vault zone instance. Cleans up all resources and deletes the
   * Zone DB record (vault zones are transient, unlike village zones).
   */
  private async tearDownVaultInstance(zoneId: string): Promise<void> {
    const inst = this.vaultInstances.get(zoneId);
    if (!inst) return;
    if (inst.idleTimer) clearTimeout(inst.idleTimer);

    // Unsubscribe from Redis channel
    const channel = `zone:${zoneId}:input`;
    await this.messageBus.unsubscribe(channel);

    // Unregister from ZoneRegistry
    await this.zoneRegistry.unassignZone(zoneId);

    // Remove from local maps
    this.zones.delete(zoneId);
    this.movementSystem.unregisterZoneManager(zoneId);
    this.vaultInstances.delete(zoneId);
    this.movementQueue.delete(zoneId);
    this.mobWanderSystems.delete(zoneId);

    // Delete the transient Zone DB record
    try {
      await prisma.zone.delete({ where: { id: zoneId } });
    } catch (err) {
      logger.warn({ zoneId, err }, 'Failed to delete vault zone record (may already be gone)');
    }

    // Clean up tile grid from Redis
    const vaultInstanceId = VaultManager.extractInstanceId(zoneId);
    if (vaultInstanceId) {
      await this.zoneRegistry.deleteVaultTileGrid(vaultInstanceId).catch(() => {});
    }

    logger.info({ zoneId }, 'Vault instance torn down');
  }

  /** Expose tile grid data for the HTTP endpoint. */
  getVaultTileGrid(instanceId: string): VaultTileGridData | null {
    return this.vaultManager.getTileGrid(instanceId);
  }

  /** Per-mob-type loot table + gold mapping for vault mobs. */
  private static readonly VAULT_LOOT_MAP: Record<string, { lootTableId: string; goldDrop: number }> = {
    'vault.construct.overlord': { lootTableId: 'loot-table-vault-boss',     goldDrop: 50 },
    'vault.construct.overseer': { lootTableId: 'loot-table-vault-overseer', goldDrop: 30 },
    // drone + sentinel default to 'loot-table-vault-construct', goldDrop 10
  };

  /**
   * Spawn a mob entity inside a vault zone with scaled stats.
   * Returns the entity ID for tracking by VaultManager.
   */
  private async spawnVaultMob(
    zoneId: string,
    mobTag: string,
    position: { x: number; y: number; z: number },
    level: number,
    scaling: VaultScalingModifiers,
    wanderRadius?: number,
  ): Promise<string> {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) throw new Error(`Zone ${zoneId} not found for vault mob spawn`);

    // Base stats for vault mobs (scaled by level and difficulty)
    const baseHp = Math.round((150 + level * 50) * scaling.mobHpMultiplier);
    const entityId = `vault-mob:${randomUUID()}`;

    // Derive family/species from mobTag (e.g. "mob.drone" → family "drone", species "drone")
    const tagParts = mobTag.split('.');
    const mobFamily = tagParts[1] ?? 'construct';
    const mobSpecies = tagParts.slice(1).join('_') || 'construct';

    // Create mob in DB for combat system compatibility
    const mob = await prisma.mob.create({
      data: {
        id: entityId,
        name: mobTag.split('.').pop() ?? 'Construct',
        tag: `${mobTag}.${entityId.slice(-8)}`, // Unique tag per spawn
        family: mobFamily,
        species: mobSpecies,
        level,
        stats: {
          strength:     8 + level * 2,
          vitality:     10 + level * 2,
          dexterity:    6 + level,
          agility:      6 + level,
          intelligence: 4 + level,
          wisdom:       4 + level,
        },
        currentHealth: baseHp,
        maxHealth: baseHp,
        isAlive: true,
        zoneId,
        positionX: position.x,
        positionY: position.y,
        positionZ: position.z,
        faction: 'hostile',
        aiType: 'aggressive',
        aggroRadius: 15.0,
        respawnTime: 0, // Vault mobs don't respawn
        lootTableId: DistributedWorldManager.VAULT_LOOT_MAP[mobTag]?.lootTableId ?? 'loot-table-vault-construct',
        goldDrop: DistributedWorldManager.VAULT_LOOT_MAP[mobTag]?.goldDrop ?? 10,
      },
    });

    // Add to zone manager using existing spawnMob method
    zoneManager.spawnMob(mob);

    // Register with wander system using room-scaled radius so mobs roam their room.
    // wanderRadius is derived from the room's larger dimension (half the max side).
    // noLeash = true: vault mobs are fully corrupted — they aggro and chase until
    // death with no leash or max-chase-distance limit.
    const mobWanderRadius = wanderRadius ?? 8;
    const wanderSys = this.mobWanderSystems.get(zoneId);
    if (wanderSys) {
      wanderSys.register(entityId, position, mobWanderRadius, true);
    }

    logger.debug({ entityId, mobTag, level, zoneId, hp: baseHp }, 'Vault mob spawned');
    return entityId;
  }

  /**
   * Eject a player from a vault back to their saved return point.
   * Used on vault failure/timeout.
   */
  private async ejectPlayerFromVault(characterId: string): Promise<void> {
    const character = await CharacterService.findById(characterId);
    if (!character) return;

    let destZoneId = character.returnZoneId;
    let destX = character.returnPositionX ?? 0;
    let destY = character.returnPositionY ?? 0;
    let destZ = character.returnPositionZ ?? 0;

    // Fallback to Stephentown if no return point or return point is inside another instance
    if (!destZoneId || VillageService.isVillageZone(destZoneId) || VaultManager.isVaultZone(destZoneId)) {
      const fallbackZone = 'USA_NY_Stephentown';
      const spawn = SpawnPointService.getStarterSpawn(fallbackZone);
      destZoneId = fallbackZone;
      destX = spawn?.position?.x ?? 0;
      destY = spawn?.position?.y ?? 265;
      destZ = spawn?.position?.z ?? 0;
    }

    await VillageService.updateCharacterZone(characterId, destZoneId, destX, destY, destZ);
    await VillageService.clearReturnPoint(characterId);

    // Send zone transfer to gateway
    const socketId = this._charToSocket.get(characterId);
    if (socketId) {
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId,
        socketId,
        payload: {
          socketId,
          event: 'zone_transfer',
          data: { zoneId: destZoneId },
        },
        timestamp: Date.now(),
      });
    }
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

    // Root check: prevent movement if entity is rooted
    if (speed !== 'stop' && this.combatManager.isRooted(characterId)) {
      return;
    }

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
        this.movementSystem.refreshHeartbeat(characterId);
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
      channel: 'say' | 'shout' | 'emote' | 'cfh' | 'touch' | 'party' | 'companion';
      text: string;
    };

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    // ── Companion chat: private channel to player's companion ────────────
    if (channel === 'companion') {
      logger.info({ characterId, zoneId, text, socketId: message.socketId }, '[handlePlayerChat] routing to companion chat');
      await this.handleCompanionChat(characterId, zoneId, text, message.socketId!);
      return;
    }

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
    const { characterId, zoneId, command, currentTarget, focusTarget } = message.payload as {
      characterId: string;
      zoneId: string;
      command: string;
      currentTarget?: string;
      focusTarget?: string;
    };

    if (!this.commandExecutor) {
      logger.warn('Command executor not initialized');
      return null;
    }

    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) {
      // Zone doesn't exist on this server — if it's an ephemeral zone (vault/village)
      // that died (e.g. server restart), rescue the player instead of silently dropping.
      const isEphemeral = zoneId.startsWith('vault:') || zoneId.startsWith('village:');
      if (isEphemeral) {
        const socketId = (message.payload as any).socketId ?? message.socketId;
        if (socketId) {
          await this.rescueFromDeadZone(characterId, zoneId, socketId, command);
        }
      }
      return;
    }

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

    // Detect guest accounts (non-bcrypt hash with guest- prefix) and GM role
    const account = await AccountService.findByIdWithCharacters(character.accountId);
    const isGuest = account?.passwordHash.startsWith('guest-') ?? false;
    const isGM = account?.role === 'gm' || account?.role === 'admin';

    const context: CommandContext = {
      characterId,
      characterName: character.name,
      accountId: character.accountId,
      zoneId,
      position: entity.position,
      heading: character.heading,
      inCombat: entity.inCombat || false,
      currentTarget,
      focusTarget,
      socketId: entity.socketId,
      isGuest,
      isGM,
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
            data: result.data,
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
            data: result.data,
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
            data: result.data,
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

          const targetEntity = this.resolveCombatTarget(zoneManager, target, context);
          if (!targetEntity) {
            // Provide context-aware error for subtarget tokens
            const tokenErrors: Record<string, string> = {
              '<t>':  'No target selected.',
              '<ft>': 'No focus target set. Press F to set one.',
              '<bt>': 'Not auto-attacking anything.',
              '<tt>': "Current target isn't attacking anything.",
              '<me>': 'Self not found in zone.',
            };
            const tokenKey = target.trim().toLowerCase();
            const error = tokenErrors[tokenKey] ?? `Target '${target}' not found.`;
            return { success: false, error };
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

          // Root check: prevent movement if entity is rooted
          if (this.combatManager.isRooted(context.characterId)) {
            return {
              success: false,
              error: 'You are rooted and cannot move!',
            };
          }

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
          // Legacy companion cycling — handled client-side or by airlock control.
          break;
        }
        case 'companion_status': {
          const statusResult = await this.processCompanionStatus(context.characterId);
          overrideResponse = statusResult;
          break;
        }
        case 'companion_follow': {
          await this.processCompanionFollow(context.characterId);
          break;
        }
        case 'companion_detach': {
          await this.processCompanionDetach(context.characterId);
          break;
        }
        case 'companion_task': {
          const { description } = event.data as { description: string };
          const taskResult = await this.processCompanionTask(context.characterId, description);
          overrideResponse = taskResult;
          break;
        }
        case 'companion_harvest': {
          const harvestResult = await this.processCompanionHarvest(context.characterId);
          overrideResponse = harvestResult;
          break;
        }
        case 'companion_recall': {
          await this.processCompanionRecall(context.characterId);
          break;
        }
        case 'companion_report': {
          const reportResult = await this.processCompanionReport(context.characterId);
          overrideResponse = reportResult;
          break;
        }
        case 'companion_set_archetype': {
          const { archetype } = event.data as { archetype: string };
          overrideResponse = await this.processCompanionSetArchetype(context.characterId, archetype);
          break;
        }
        case 'companion_configure': {
          const { settings } = event.data as { settings: Partial<CompanionCombatSettings> };
          overrideResponse = await this.processCompanionConfigure(context.characterId, settings);
          break;
        }
        case 'companion_set_abilities': {
          const { abilityIds } = event.data as { abilityIds: string[] };
          overrideResponse = await this.processCompanionSetAbilities(context.characterId, abilityIds);
          break;
        }
        case 'companion_get_config': {
          overrideResponse = await this.processCompanionGetConfig(context.characterId);
          break;
        }

        // ── Companion loadout management ────────────────────────────────
        case 'companion_view_active_loadout': {
          overrideResponse = await this.processCompanionViewLoadout(context.characterId, 'active');
          break;
        }
        case 'companion_view_passive_loadout': {
          overrideResponse = await this.processCompanionViewLoadout(context.characterId, 'passive');
          break;
        }
        case 'companion_slot_active': {
          const { slotIndex, nodeId } = event.data as { slotIndex: number; nodeId: string };
          overrideResponse = await this.processCompanionSlotAbility(context.characterId, 'active', slotIndex, nodeId);
          break;
        }
        case 'companion_slot_passive': {
          const { slotIndex, nodeId } = event.data as { slotIndex: number; nodeId: string };
          overrideResponse = await this.processCompanionSlotAbility(context.characterId, 'passive', slotIndex, nodeId);
          break;
        }
        case 'companion_unslot_active': {
          const { slotIndex } = event.data as { slotIndex: number };
          overrideResponse = await this.processCompanionUnslotAbility(context.characterId, 'active', slotIndex);
          break;
        }
        case 'companion_unslot_passive': {
          const { slotIndex } = event.data as { slotIndex: number };
          overrideResponse = await this.processCompanionUnslotAbility(context.characterId, 'passive', slotIndex);
          break;
        }

        // ── Scripted Object commands ──────────────────────────────────────
        case 'scripted_object_place': {
          const { name } = event.data as { name: string };
          overrideResponse = await this.processScriptedObjectPlace(context.characterId, context.zoneId, context.position, name);
          break;
        }
        case 'scripted_object_edit': {
          const { target } = event.data as { target: string };
          overrideResponse = await this.processScriptedObjectEdit(context.characterId, target);
          break;
        }
        case 'scripted_object_script': {
          const { objectId, scriptSource } = event.data as { objectId: string; scriptSource: string };
          overrideResponse = await this.processScriptedObjectScript(context.characterId, context.zoneId, objectId, scriptSource);
          break;
        }
        case 'scripted_object_pickup': {
          const { target } = event.data as { target: string };
          overrideResponse = await this.processScriptedObjectPickup(context.characterId, context.zoneId, target);
          break;
        }
        case 'scripted_object_inspect': {
          const { target } = event.data as { target: string };
          overrideResponse = await this.processScriptedObjectInspect(context.characterId, target);
          break;
        }
        case 'scripted_object_list': {
          overrideResponse = await this.processScriptedObjectList(context.characterId);
          break;
        }
        case 'scripted_object_activate': {
          const { target } = event.data as { target: string };
          overrideResponse = await this.processScriptedObjectActivate(context.characterId, context.zoneId, target);
          break;
        }
        case 'scripted_object_deactivate': {
          const { target } = event.data as { target: string };
          overrideResponse = await this.processScriptedObjectDeactivate(context.characterId, context.zoneId, target);
          break;
        }
        case 'scripted_object_verbs': {
          const { target } = event.data as { target: string };
          overrideResponse = await this.processScriptedObjectVerbs(context.characterId, target);
          break;
        }
        case 'scripted_object_do_verb': {
          const { target, verb } = event.data as { target: string; verb: string };
          overrideResponse = await this.processScriptedObjectDoVerb(
            context.characterId, context.zoneId, target, verb,
          );
          break;
        }

        // ── Script Editor commands ──────────────────────────────────────────
        case 'editor_open_request': {
          const { objectRef, verb } = event.data as { objectRef: string; verb: string };
          overrideResponse = await this.processEditorOpenRequest(
            context.characterId, context.zoneId, context.socketId, objectRef, verb,
          );
          break;
        }
        case 'editor_undo_request': {
          const { objectRef, verb } = event.data as { objectRef: string; verb: string };
          overrideResponse = await this.processEditorUndoRequest(
            context.characterId, context.zoneId, context.socketId, objectRef, verb,
          );
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
        case 'use_item': {
          // Sync resource changes + inventory after /use command
          const { characterId: useCharId, resource, value, maxHp, maxStamina, maxMana } = event.data as {
            characterId: string;
            resource: string;
            value: number;
            maxHp: number;
            maxStamina: number;
            maxMana: number;
          };

          // Update zone entity's in-memory health so state_update broadcasts pick it up
          if (resource === 'health') {
            zoneManager.setEntityHealth(useCharId, value, maxHp);
          }

          // Push resource update to client immediately (don't wait for next tick)
          const useResources: { health?: { current: number; max: number }; stamina?: { current: number; max: number }; mana?: { current: number; max: number } } = {};
          if (resource === 'health')  useResources.health  = { current: value, max: maxHp };
          if (resource === 'stamina') useResources.stamina = { current: value, max: maxStamina };
          if (resource === 'mana')    useResources.mana    = { current: value, max: maxMana };
          await this.sendCharacterResourcesUpdate(zoneManager, useCharId, useResources);

          // Push updated inventory (quantity decremented / item removed)
          const invPayload = await InventoryService.buildPayload(useCharId, 1);
          const useSocketId = zoneManager.getSocketIdForCharacter(useCharId);
          if (useSocketId) {
            await this.messageBus.publish('gateway:output', {
              type: MessageType.CLIENT_MESSAGE,
              characterId: useCharId,
              socketId: useSocketId,
              payload: { socketId: useSocketId, event: 'inventory_update', data: invPayload } as ClientMessagePayload,
              timestamp: Date.now(),
            });
          }
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
        case 'return_home': {
          const returnResult = await this.processReturnCommand(
            context.characterId,
            context.zoneId,
            context.socketId,
          );
          overrideResponse = { success: returnResult.success, message: returnResult.message };
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

        case 'village_catalog': {
          // Forward structured catalog to the client for the BuildPanel
          await this.messageBus.publish('gateway:output', {
            type: MessageType.CLIENT_MESSAGE,
            characterId: context.characterId,
            socketId: context.socketId,
            payload: {
              socketId: context.socketId,
              event: 'village_catalog',
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

        // ── Vault system events ────────────────────────────────────────
        // ── GM tool events ──────────────────────────────────────────
        case 'gm_inventory_refresh': {
          const { characterId: gmCharId } = event.data as { characterId: string };
          const gmInvPayload = await InventoryService.buildPayload(gmCharId, 1);
          await this._sendToSocket(gmCharId, 'inventory_update', gmInvPayload);
          break;
        }
        case 'gm_state_refresh': {
          const { characterId: gmStateCharId } = event.data as { characterId: string };
          const gmChar = await CharacterService.findById(gmStateCharId);
          if (gmChar) {
            // Push full character state update
            await this._sendToSocket(gmStateCharId, 'state_update', {
              timestamp: Date.now(),
              character: {
                level:         gmChar.level,
                experience:    gmChar.experience,
                abilityPoints: gmChar.abilityPoints,
                statPoints:    gmChar.statPoints,
              },
            });
            // Push resource update
            const gmEntity = zoneManager.getEntity(gmStateCharId);
            if (gmEntity) {
              zoneManager.setEntityHealth(gmStateCharId, gmChar.currentHp, gmChar.maxHp);
            }
            await this.sendCharacterResourcesUpdate(zoneManager, gmStateCharId, {
              health:  { current: gmChar.currentHp,      max: gmChar.maxHp },
              stamina: { current: gmChar.currentStamina,  max: gmChar.maxStamina },
              mana:    { current: gmChar.currentMana,     max: gmChar.maxMana },
            });
          }
          break;
        }

        case 'vault_enter': {
          try {
            // Check not already in a vault or village
            if (VaultManager.isVaultZone(context.zoneId)) {
              overrideResponse = { success: false, error: 'You are already inside a vault.' };
              break;
            }
            if (VillageService.isVillageZone(context.zoneId)) {
              overrideResponse = { success: false, error: 'You cannot enter a vault from inside a village.' };
              break;
            }

            const template = TEST_VAULT_TEMPLATE;

            // Check player has a vault key in inventory
            const keyItems = await prisma.inventoryItem.findMany({
              where: {
                characterId: context.characterId,
                template: {
                  tags: { some: { tag: { name: template.requiredKeyTag } } },
                },
              },
            });

            if (keyItems.length === 0) {
              overrideResponse = {
                success: false,
                error: `You need a ${template.name} key to enter. Assemble one with /vault assemble.`,
              };
              break;
            }

            // Consume the key
            await prisma.inventoryItem.delete({ where: { id: keyItems[0].id } });

            // Get party members (or just the solo player)
            const partyId = await this.partyService.getPartyIdForMember(context.characterId);
            let partyMembers: Array<{ id: string; name: string }> = [
              { id: context.characterId, name: context.characterName },
            ];

            if (partyId) {
              const partyInfo = await this.partyService.getPartyInfo(partyId);
              if (partyInfo && partyInfo.members.length > 1) {
                // Fetch names for all party members
                const chars = await prisma.character.findMany({
                  where: { id: { in: partyInfo.members } },
                  select: { id: true, name: true },
                });
                partyMembers = chars.map(c => ({ id: c.id, name: c.name }));
              }
            }

            // Create vault instance
            const instanceId = await this.vaultManager.createInstance(
              context.characterId,
              context.characterName,
              partyMembers,
              template,
            );

            const vaultZoneId = VaultManager.vaultZoneId(instanceId);

            // ── Register wall collision from tile grid ──────────────────
            const tileGrid = this.vaultManager.getTileGrid(instanceId);
            if (tileGrid) {
              const vaultZoneMgr = this.zones.get(vaultZoneId);
              if (vaultZoneMgr) {
                const wallSegs = getWallSegments(tileGrid);
                const physics = vaultZoneMgr.getPhysicsSystem();
                for (let i = 0; i < wallSegs.length; i++) {
                  const seg = wallSegs[i]!;
                  physics.registerEntity({
                    id: `vault_wall_${i}`,
                    position: { x: (seg.ax + seg.bx) / 2, y: 0, z: (seg.az + seg.bz) / 2 },
                    boundingVolume: seg,
                    type: 'static',
                    collisionLayer: CollisionLayer.STRUCTURES,
                  } as PhysicsEntity);
                }
                logger.info(
                  { vaultZoneId, wallCount: wallSegs.length },
                  'Vault wall collision registered',
                );
              }

              // Persist tile grid to Redis so the gateway can serve it
              await this.zoneRegistry.setVaultTileGrid(instanceId, JSON.stringify(tileGridToJSON(tileGrid)));
            }

            // ── Derive player spawn positions from tile grid ────────────
            let playerSpawns: Array<{ x: number; y: number; z: number }>;
            if (tileGrid?.roomCenters?.[0]) {
              // Multi-room: spawn near Room 0 center, constrained to room bounds
              playerSpawns = getSpawnPositions(tileGrid, tileGrid.roomCenters[0], partyMembers.length, 2, 18);
            } else if (tileGrid) {
              // Single-room: spawn near entrance
              playerSpawns = getSpawnPositions(tileGrid, tileGrid.entrance, partyMembers.length, 2);
            } else {
              playerSpawns = template.rooms[0]!.spawnPositions.player;
            }

            // Save return points and transfer all party members
            for (const member of partyMembers) {
              const memberChar = await CharacterService.findById(member.id);
              if (!memberChar) continue;

              // Save return point
              await VillageService.saveReturnPoint(
                member.id, memberChar.zoneId,
                memberChar.positionX, memberChar.positionY, memberChar.positionZ,
              );

              // Get player spawn position
              const spawnPos = playerSpawns[
                partyMembers.indexOf(member) % playerSpawns.length
              ]!;

              // Update character zone to vault
              await VillageService.updateCharacterZone(
                member.id, vaultZoneId,
                spawnPos.x, spawnPos.y, spawnPos.z,
              );

              // Track vault player count
              const vaultInst = this.vaultInstances.get(vaultZoneId);
              if (vaultInst) vaultInst.playerCount++;

              // Send zone transfer to each member's gateway
              const memberSocketId = this._charToSocket.get(member.id);
              if (memberSocketId) {
                await this.messageBus.publish('gateway:output', {
                  type: MessageType.CLIENT_MESSAGE,
                  characterId: member.id,
                  socketId: memberSocketId,
                  payload: {
                    socketId: memberSocketId,
                    event: 'zone_transfer',
                    data: { zoneId: vaultZoneId },
                  },
                  timestamp: Date.now(),
                });
              }
            }

            // Spawn first room mobs
            const instance = this.vaultManager.getInstanceForCharacter(context.characterId);
            if (instance) {
              await this.vaultManager.spawnRoom(instance.instanceId, 0);
            }

            overrideResponse = {
              success: true,
              message: `Entering ${template.name}... Key consumed.`,
            };
          } catch (err: any) {
            overrideResponse = { success: false, error: err.message };
          }
          break;
        }

        case 'vault_leave': {
          try {
            const character = await CharacterService.findById(context.characterId);

            // Determine destination: saved return point, or Stephentown as fallback
            let destZoneId = character?.returnZoneId ?? null;
            let destX = character?.returnPositionX ?? 0;
            let destY = character?.returnPositionY ?? 0;
            let destZ = character?.returnPositionZ ?? 0;

            if (!destZoneId || VillageService.isVillageZone(destZoneId) || VaultManager.isVaultZone(destZoneId)) {
              const fallbackZone = 'USA_NY_Stephentown';
              const spawn = SpawnPointService.getStarterSpawn(fallbackZone);
              destZoneId = fallbackZone;
              destX = spawn?.position?.x ?? 0;
              destY = spawn?.position?.y ?? 265;
              destZ = spawn?.position?.z ?? 0;
            }

            // ── Despawn owned companions BEFORE vault cleanup ──────────────
            // removeParticipant() may trigger vault instance teardown which
            // deletes the zone. If the zone is gone when handlePlayerLeaveZone
            // fires, companion cleanup never runs and the controller lingers —
            // causing handlePlayerJoinZone to take the wrong (teleport) branch.
            const vaultZm = this.zones.get(context.zoneId);
            if (vaultZm) {
              const removedCompIds: string[] = [];
              for (const [companionId, cZoneId] of this.companionToZone.entries()) {
                if (cZoneId !== context.zoneId) continue;
                const ctrl = this.npcControllers.get(companionId);
                if (!ctrl) continue;
                if (ctrl.getCompanion().ownerCharacterId !== context.characterId) continue;

                // Exit combat cleanly if in-flight
                if (ctrl.inCombat) ctrl.exitCombat();

                vaultZm.removeCompanion(companionId);
                this.npcControllers.delete(companionId);
                this.companionToZone.delete(companionId);
                this.companionBehaviorExecutors.delete(companionId);
                this.companionChatHistory.delete(companionId);
                removedCompIds.push(companionId);

                logger.info({ companionId, ownerId: context.characterId, zoneId: context.zoneId },
                  'Companion despawned — owner leaving vault');
              }

              // Notify remaining vault players that companion entities are gone
              if (removedCompIds.length > 0) {
                const removePayload = {
                  timestamp: Date.now(),
                  entities: { removed: removedCompIds },
                };
                for (const [charId, charZoneId] of this.characterToZone.entries()) {
                  if (charZoneId !== context.zoneId || charId === context.characterId) continue;
                  const socketId = vaultZm.getSocketIdForCharacter(charId);
                  if (!socketId) continue;
                  await this.messageBus.publish('gateway:output', {
                    type: MessageType.CLIENT_MESSAGE,
                    characterId: charId,
                    socketId,
                    payload: { socketId, event: 'state_update', data: removePayload },
                    timestamp: Date.now(),
                  });
                }
              }
            }

            // Remove from vault manager tracking (may destroy the vault zone)
            this.vaultManager.removeParticipant(context.characterId);

            // Decrement vault player count
            const vaultInst = this.vaultInstances.get(context.zoneId);
            if (vaultInst) {
              vaultInst.playerCount = Math.max(0, vaultInst.playerCount - 1);
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

            overrideResponse = {
              success: true,
              message: 'You have left the vault.',
            };
          } catch (err: any) {
            overrideResponse = { success: false, error: err.message };
          }
          break;
        }

        case 'vault_assemble': {
          try {
            const template = TEST_VAULT_TEMPLATE;

            // Check proximity to civic anchor (library or townhall)
            const anchors = await prisma.civicAnchor.findMany({
              where: { zoneId: context.zoneId, isActive: true },
            });

            let nearAnchor = false;
            for (const anchor of anchors) {
              const dx = context.position.x - anchor.worldX;
              const dz = context.position.z - anchor.worldZ;
              const dist = Math.sqrt(dx * dx + dz * dz);
              if (dist <= anchor.wardRadius) {
                nearAnchor = true;
                break;
              }
            }

            if (!nearAnchor) {
              overrideResponse = {
                success: false,
                error: 'You must be near a town hall or library workbench to assemble a vault key.',
              };
              break;
            }

            // Count fragments in inventory
            const fragmentItems = await prisma.inventoryItem.findMany({
              where: {
                characterId: context.characterId,
                template: {
                  tags: { some: { tag: { name: template.requiredFragmentTag } } },
                },
              },
              orderBy: { quantity: 'desc' },
            });

            // Calculate total fragment quantity (they're stackable)
            let totalFragments = 0;
            for (const item of fragmentItems) {
              totalFragments += item.quantity;
            }

            if (totalFragments < template.fragmentsRequired) {
              overrideResponse = {
                success: false,
                error: `You need ${template.fragmentsRequired} fragments to assemble a key (you have ${totalFragments}).`,
              };
              break;
            }

            // Consume fragments (remove from stacks)
            let remaining = template.fragmentsRequired;
            for (const item of fragmentItems) {
              if (remaining <= 0) break;
              if (item.quantity <= remaining) {
                remaining -= item.quantity;
                await prisma.inventoryItem.delete({ where: { id: item.id } });
              } else {
                await prisma.inventoryItem.update({
                  where: { id: item.id },
                  data: { quantity: item.quantity - remaining },
                });
                remaining = 0;
              }
            }

            // Find key template
            const keyTemplate = await prisma.itemTemplate.findFirst({
              where: { tags: { some: { tag: { name: template.requiredKeyTag } } } },
            });

            if (!keyTemplate) {
              overrideResponse = { success: false, error: 'Key template not found. Contact an admin.' };
              break;
            }

            // Create key in inventory
            await prisma.inventoryItem.create({
              data: {
                characterId: context.characterId,
                itemTemplateId: keyTemplate.id,
                quantity: 1,
              },
            });

            overrideResponse = {
              success: true,
              message: `Assembled a ${keyTemplate.name}! Use /vault enter to begin.`,
            };
          } catch (err: any) {
            overrideResponse = { success: false, error: err.message };
          }
          break;
        }

        case 'vault_fragments': {
          try {
            const template = TEST_VAULT_TEMPLATE;

            const fragmentItems = await prisma.inventoryItem.findMany({
              where: {
                characterId: context.characterId,
                template: {
                  tags: { some: { tag: { name: template.requiredFragmentTag } } },
                },
              },
            });

            let totalFragments = 0;
            for (const item of fragmentItems) {
              totalFragments += item.quantity;
            }

            // Also check for assembled keys
            const keyItems = await prisma.inventoryItem.findMany({
              where: {
                characterId: context.characterId,
                template: {
                  tags: { some: { tag: { name: template.requiredKeyTag } } },
                },
              },
            });

            const lines = [
              `--- Vault Fragments ---`,
              `Nanotech Lab Fragments: ${totalFragments}/${template.fragmentsRequired}`,
              `Nanotech Lab Keys: ${keyItems.length}`,
            ];

            if (totalFragments >= template.fragmentsRequired) {
              lines.push('You have enough fragments! Use /vault assemble near a workbench.');
            }

            overrideResponse = { success: true, message: lines.join('\n') };
          } catch (err: any) {
            overrideResponse = { success: false, error: err.message };
          }
          break;
        }

        // ── Guild events ──────────────────────────────────────────────
        case 'guild_create_init': {
          const { name, tag } = event.data as { name: string; tag: string };

          // Validate name and tag
          const nameCheck = GuildService.validateName(name);
          if (!nameCheck.valid) return { success: false, error: nameCheck.error! };
          const tagCheck = GuildService.validateTag(tag);
          if (!tagCheck.valid) return { success: false, error: tagCheck.error! };

          const nameAvail = await GuildService.isNameAvailable(name);
          if (!nameAvail) return { success: false, error: `Guild name "${name}" is already taken.` };
          const tagAvail = await GuildService.isTagAvailable(tag);
          if (!tagAvail) return { success: false, error: `Guild tag "${tag}" is already taken.` };

          // Check founder isn't already in a guild
          const existingMembership = await GuildService.getMembership(context.characterId);
          if (existingMembership) return { success: false, error: 'You are already in a guild.' };

          // Find 2 nearest players as co-founders (within 15m)
          const allEntities = zoneManager.getAllEntities();
          const nearbyPlayers = allEntities.filter(e =>
            e.type === 'player' && e.id !== context.characterId &&
            distance2D({ x: e.position.x, z: e.position.z }, { x: context.position.x, z: context.position.z }) <= 15
          );
          if (nearbyPlayers.length < 2) {
            return { success: false, error: 'You need 2 other players nearby to found a guild (3 total required).' };
          }

          // Check co-founders are unguilded
          const coFounders = nearbyPlayers.slice(0, 2);
          for (const cf of coFounders) {
            const cfMembership = await GuildService.getMembership(cf.id);
            if (cfMembership) return { success: false, error: `${cf.name} is already in a guild.` };
          }

          // Start ceremony
          const err = this.foundingCeremony.startCeremony({
            founderId: context.characterId,
            founderName: context.characterName,
            coFounderIds: coFounders.map(cf => cf.id),
            coFounderNames: coFounders.map(cf => cf.name),
            guildName: name,
            guildTag: tag,
            zoneId: zoneManager.getZone().id,
          });

          if (err) return { success: false, error: err };

          // Notify co-founders they need to /guild accept
          for (const cf of coFounders) {
            const sid = this._charToSocket.get(cf.id);
            if (sid) {
              void this.messageBus.publish('gateway:output', {
                type: MessageType.CLIENT_MESSAGE,
                characterId: cf.id,
                socketId: sid,
                payload: {
                  socketId: sid,
                  event: 'guild_founding_narrative',
                  data: {
                    step: 0,
                    totalSteps: 1,
                    narrative: `${context.characterName} invites you to co-found the guild "${name}" [${tag}]. Type /guild accept to consent.`,
                  },
                },
                timestamp: Date.now(),
              });
            }
          }

          overrideResponse = {
            success: true,
            message: `Founding ceremony initiated for "${name}" [${tag}]. Waiting for ${coFounders.map(cf => cf.name).join(' and ')} to /guild accept.`,
          };
          break;
        }

        case 'guild_accept_founding': {
          const consentResult = this.foundingCeremony.recordConsent(context.characterId);

          if (typeof consentResult === 'string') {
            return { success: false, error: consentResult };
          }

          if (consentResult === null) {
            overrideResponse = { success: true, message: 'Consent recorded. Waiting for remaining co-founders...' };
            break;
          }

          // All consented — execute ceremony
          const ceremony = consentResult;
          void this.foundingCeremony.executeCeremony(
            ceremony.founderId,
            (charIds, step) => {
              // Narrative callback — send to all founders
              for (const charId of charIds) {
                const sid = this._charToSocket.get(charId);
                if (sid) {
                  void this.messageBus.publish('gateway:output', {
                    type: MessageType.CLIENT_MESSAGE,
                    characterId: charId,
                    socketId: sid,
                    payload: {
                      socketId: sid,
                      event: 'guild_founding_narrative',
                      data: { step: step.step, totalSteps: step.totalSteps, narrative: step.narrative },
                    },
                    timestamp: Date.now(),
                  });
                }
              }
            },
            async (completeResult) => {
              // Completion callback — send guild update to all founders
              if (completeResult.success && completeResult.guildId) {
                const guildInfo = await GuildService.getGuildInfo(completeResult.guildId);
                for (const charId of completeResult.founderIds) {
                  const sid = this._charToSocket.get(charId);
                  if (sid) {
                    void this.messageBus.publish('gateway:output', {
                      type: MessageType.CLIENT_MESSAGE,
                      characterId: charId,
                      socketId: sid,
                      payload: {
                        socketId: sid,
                        event: 'guild_update',
                        data: guildInfo,
                      },
                      timestamp: Date.now(),
                    });
                  }
                }
                // Subscribe to guild chat
                void this.guildChatBridge.subscribeGuild(completeResult.guildId);
              } else {
                for (const charId of completeResult.founderIds) {
                  const sid = this._charToSocket.get(charId);
                  if (sid) {
                    void this.messageBus.publish('gateway:output', {
                      type: MessageType.CLIENT_MESSAGE,
                      characterId: charId,
                      socketId: sid,
                      payload: {
                        socketId: sid,
                        event: 'command_response',
                        data: { success: false, error: completeResult.error ?? 'Guild creation failed.' },
                      },
                      timestamp: Date.now(),
                    });
                  }
                }
              }
            },
          );

          overrideResponse = { success: true, message: 'All founders have consented. The ceremony begins...' };
          break;
        }

        case 'guild_invite': {
          const { targetName } = event.data as { targetName: string };
          const membership = await GuildService.getMembership(context.characterId);
          if (!membership) return { success: false, error: 'You are not in a guild.' };

          // Find target character in any zone
          let targetId: string | null = null;
          let targetSocketId: string | null = null;
          for (const [charId, zId] of this.characterToZone) {
            const zm = this.zones.get(zId);
            if (!zm) continue;
            const entity = zm.getEntity(charId);
            if (entity && entity.name.toLowerCase() === targetName.toLowerCase()) {
              targetId = charId;
              targetSocketId = this._charToSocket.get(charId) ?? null;
              break;
            }
          }

          if (!targetId) return { success: false, error: `Player '${targetName}' is not online.` };

          // Check target isn't already guilded
          const targetMembership = await GuildService.getMembership(targetId);
          if (targetMembership) return { success: false, error: `${targetName} is already in a guild.` };

          const guild = await GuildService.findById(membership.guildId);
          if (!guild) return { success: false, error: 'Guild not found.' };

          // Store invite
          this.pendingGuildInvites.set(targetId, {
            guildId: guild.id,
            guildName: guild.name,
            guildTag: guild.tag,
            inviterId: context.characterId,
            inviterName: context.characterName,
            expiresAt: Date.now() + 5 * 60 * 1000,
          });

          // Send invite to target
          if (targetSocketId) {
            void this.messageBus.publish('gateway:output', {
              type: MessageType.CLIENT_MESSAGE,
              characterId: targetId,
              socketId: targetSocketId,
              payload: {
                socketId: targetSocketId,
                event: 'guild_invite',
                data: {
                  guildId: guild.id,
                  guildName: guild.name,
                  guildTag: guild.tag,
                  inviterName: context.characterName,
                },
              },
              timestamp: Date.now(),
            });
          }

          overrideResponse = { success: true, message: `Guild invite sent to ${targetName}.` };
          break;
        }

        case 'guild_leave': {
          const membership = await GuildService.getMembership(context.characterId);
          if (!membership) return { success: false, error: 'You are not in a guild.' };

          const isGM = await GuildService.isGuildmaster(membership.guildId, context.characterId);
          if (isGM) return { success: false, error: 'Guildmaster cannot leave. Transfer leadership first with /guild promote, or /guild disband.' };

          const removeResult = await GuildService.removeMember(membership.guildId, context.characterId);
          if (!removeResult.success) return { success: false, error: removeResult.error };

          overrideResponse = { success: true, message: 'You have left the guild.' };
          break;
        }

        case 'guild_kick': {
          const { targetName } = event.data as { targetName: string };
          const membership = await GuildService.getMembership(context.characterId);
          if (!membership) return { success: false, error: 'You are not in a guild.' };

          const isGM = await GuildService.isGuildmaster(membership.guildId, context.characterId);
          if (!isGM) return { success: false, error: 'Only the Guildmaster can kick members.' };

          // Find target by name in guild members
          const members = await GuildService.getMembers(membership.guildId);
          const target = members.find(m => m.characterName.toLowerCase() === targetName.toLowerCase());
          if (!target) return { success: false, error: `Player '${targetName}' is not in your guild.` };
          if (target.characterId === context.characterId) return { success: false, error: 'You cannot kick yourself.' };

          const removeResult = await GuildService.removeMember(membership.guildId, target.characterId);
          if (!removeResult.success) return { success: false, error: removeResult.error };

          // Notify the kicked player
          const kickedSid = this._charToSocket.get(target.characterId);
          if (kickedSid) {
            void this.messageBus.publish('gateway:output', {
              type: MessageType.CLIENT_MESSAGE,
              characterId: target.characterId,
              socketId: kickedSid,
              payload: {
                socketId: kickedSid,
                event: 'guild_update',
                data: { removed: true, reason: 'kicked' },
              },
              timestamp: Date.now(),
            });
          }

          overrideResponse = { success: true, message: `${targetName} has been kicked from the guild.` };
          break;
        }

        case 'guild_info': {
          const { targetGuild } = event.data as { targetGuild: string | null };
          let guildId: string | null = null;

          if (targetGuild) {
            // Look up by name or tag
            const byTag = await GuildService.findByTag(targetGuild);
            if (byTag) guildId = byTag.id;
            else {
              const byName = await GuildService.findByName(targetGuild);
              if (byName) guildId = byName.id;
            }
          } else {
            const membership = await GuildService.getMembership(context.characterId);
            if (membership) guildId = membership.guildId;
          }

          if (!guildId) return { success: false, error: targetGuild ? `Guild '${targetGuild}' not found.` : 'You are not in a guild.' };

          const info = await GuildService.getGuildInfo(guildId);
          if (!info) return { success: false, error: 'Guild not found.' };

          const beaconCount = await GuildBeaconService.getGuildBeaconCount(guildId);
          const bonuses = await GuildBeaconService.getGuildBeaconBonuses(guildId);

          const g = info.guild;
          overrideResponse = {
            success: true,
            message: [
              `--- ${g.name} [${g.tag}] ---`,
              g.motto ? `Motto: "${g.motto}"` : null,
              g.description ? `Description: ${g.description}` : null,
              `Members: ${g.memberCount}`,
              `Guildmaster: ${g.guildmasterId}`,
              `Beacons: ${beaconCount}/${GuildService.getMaxBeacons(g.memberCount)}`,
              bonuses.corruptionResistPercent > 0 ? `Corruption Resist: ${bonuses.corruptionResistPercent.toFixed(1)}%` : null,
              bonuses.xpBonusPercent > 0 ? `XP Bonus: ${bonuses.xpBonusPercent.toFixed(1)}%` : null,
              `Founded: ${new Date(g.foundedAt).toLocaleDateString()}`,
            ].filter(Boolean).join('\n'),
          };
          break;
        }

        case 'guild_members': {
          const membership = await GuildService.getMembership(context.characterId);
          if (!membership) return { success: false, error: 'You are not in a guild.' };

          const members = await GuildService.getMembers(membership.guildId);
          const guild = await GuildService.findById(membership.guildId);
          const lines = [`--- ${guild?.name ?? 'Guild'} Members (${members.length}) ---`];
          for (const m of members) {
            const charName = m.characterName;
            const isGM = m.characterId === guild?.guildmasterId;
            const online = this.characterToZone.has(m.characterId);
            lines.push(`  ${isGM ? '[GM] ' : ''}${charName}${online ? ' (online)' : ''}`);
          }

          overrideResponse = { success: true, message: lines.join('\n') };
          break;
        }

        case 'guild_transfer_gm': {
          const { targetName } = event.data as { targetName: string };
          const membership = await GuildService.getMembership(context.characterId);
          if (!membership) return { success: false, error: 'You are not in a guild.' };

          const isGM = await GuildService.isGuildmaster(membership.guildId, context.characterId);
          if (!isGM) return { success: false, error: 'Only the Guildmaster can transfer leadership.' };

          const members = await GuildService.getMembers(membership.guildId);
          const target = members.find(m => m.characterName.toLowerCase() === targetName.toLowerCase());
          if (!target) return { success: false, error: `Player '${targetName}' is not in your guild.` };

          const transferResult = await GuildService.transferGuildmaster(membership.guildId, context.characterId, target.characterId);
          if (!transferResult.success) return { success: false, error: transferResult.error };

          overrideResponse = { success: true, message: `Guildmaster transferred to ${targetName}.` };
          break;
        }

        case 'guild_disband': {
          const membership = await GuildService.getMembership(context.characterId);
          if (!membership) return { success: false, error: 'You are not in a guild.' };

          const isGM = await GuildService.isGuildmaster(membership.guildId, context.characterId);
          if (!isGM) return { success: false, error: 'Only the Guildmaster can disband the guild.' };

          // Notify all online members before disbanding
          const members = await GuildService.getMembers(membership.guildId);
          const guild = await GuildService.findById(membership.guildId);

          await GuildService.disbandGuild(membership.guildId, context.characterId);

          for (const m of members) {
            if (m.characterId === context.characterId) continue;
            const sid = this._charToSocket.get(m.characterId);
            if (sid) {
              void this.messageBus.publish('gateway:output', {
                type: MessageType.CLIENT_MESSAGE,
                characterId: m.characterId,
                socketId: sid,
                payload: {
                  socketId: sid,
                  event: 'guild_update',
                  data: { removed: true, reason: 'disbanded' },
                },
                timestamp: Date.now(),
              });
            }
          }

          // Unsubscribe from guild chat
          void this.guildChatBridge.unsubscribeGuild(membership.guildId);

          // Refresh beacon caches since beacons were extinguished
          void this.refreshBeaconCaches();

          overrideResponse = { success: true, message: `Guild "${guild?.name ?? 'Unknown'}" has been disbanded.` };
          break;
        }

        case 'guild_motto': {
          const { text } = event.data as { text: string };
          const membership = await GuildService.getMembership(context.characterId);
          if (!membership) return { success: false, error: 'You are not in a guild.' };

          const mottoResult = await GuildService.updateMotto(membership.guildId, text);
          if (!mottoResult.success) return { success: false, error: mottoResult.error };

          overrideResponse = { success: true, message: `Guild motto set to: "${text}"` };
          break;
        }

        case 'guild_description': {
          const { text } = event.data as { text: string };
          const membership = await GuildService.getMembership(context.characterId);
          if (!membership) return { success: false, error: 'You are not in a guild.' };

          const descResult = await GuildService.updateDescription(membership.guildId, text);
          if (!descResult.success) return { success: false, error: descResult.error };

          overrideResponse = { success: true, message: 'Guild description updated.' };
          break;
        }

        case 'guild_chat': {
          const { message } = event.data as { message: string };
          const membership = await GuildService.getMembership(context.characterId);
          if (!membership) return { success: false, error: 'You are not in a guild.' };

          const guild = await GuildService.findById(membership.guildId);
          if (!guild) return { success: false, error: 'Guild not found.' };

          void this.guildChatBridge.publishChat({
            guildId: guild.id,
            guildTag: guild.tag,
            senderId: context.characterId,
            senderName: context.characterName,
            message,
            timestamp: Date.now(),
          });

          break;
        }

        // ── Beacon events ──────────────────────────────────────────────
        case 'beacon_light': {
          const membership = await GuildService.getMembership(context.characterId);
          if (!membership) return { success: false, error: 'You must be in a guild to light a beacon.' };

          // Check guild hasn't reached max beacons
          const guild = await GuildService.findById(membership.guildId);
          if (!guild) return { success: false, error: 'Guild not found.' };
          const currentCount = await GuildBeaconService.getGuildBeaconCount(membership.guildId);
          const maxBeacons = GuildService.getMaxBeacons(guild.memberCount);
          if (currentCount >= maxBeacons) {
            return { success: false, error: `Your guild has reached its beacon limit (${maxBeacons}). Recruit more members to unlock more.` };
          }

          // Find nearest world point
          const zoneId = zoneManager.getZone().id;
          const nearest = await GuildBeaconService.findNearestWorldPoint(zoneId, context.position, 30);
          if (!nearest) return { success: false, error: 'No world point nearby. Move to a beacon site and try again.' };

          // Check point is available
          const isAvailable = await GuildBeaconService.isWorldPointAvailable(nearest.id);
          if (!isAvailable) return { success: false, error: 'This world point already has an active beacon.' };

          // TODO: Check inventory for Soul Ember + initial fuel wood
          // For alpha, skip inventory check and use default fuel

          const lightResult = await GuildBeaconService.lightBeacon({
            guildId: membership.guildId,
            worldPointId: nearest.id,
            lightedByCharacterId: context.characterId,
            initialFuelHours: 12, // Default starting fuel
          });

          if (!lightResult.success) return { success: false, error: lightResult.error };

          // Recompute polygons and refresh caches
          void GuildBeaconService.recomputePolygons(membership.guildId);
          void this.refreshBeaconCaches();

          overrideResponse = {
            success: true,
            message: `Beacon lit at ${nearest.name}! Tier ${nearest.tierHint} — ${lightResult.beacon?.fuelRemaining.toFixed(1)}h of fuel remaining.`,
          };
          break;
        }

        case 'beacon_fuel': {
          const membership = await GuildService.getMembership(context.characterId);
          if (!membership) return { success: false, error: 'You must be in a guild to fuel a beacon.' };

          // Find nearest guild beacon
          const zoneId = zoneManager.getZone().id;
          const litBeacons = await GuildBeaconService.findLitBeaconsInZone(zoneId);
          const guildBeacons = litBeacons.filter(b => b.guildId === membership.guildId);

          let nearestBeacon: typeof guildBeacons[0] | null = null;
          let nearestDist = Infinity;
          for (const b of guildBeacons) {
            const d = distance2D(
              { x: context.position.x, z: context.position.z },
              { x: b.worldX, z: b.worldZ }
            );
            if (d < nearestDist && d <= 30) {
              nearestDist = d;
              nearestBeacon = b;
            }
          }

          if (!nearestBeacon) return { success: false, error: 'No guild beacon nearby. Move closer to one of your beacons.' };

          // TODO: Check inventory for fuel wood of correct tier, consume it
          // For alpha, add default fuel amount
          const fuelType = 'common_wood';
          const fuelResult = await GuildBeaconService.fuelBeacon({
            beaconId: nearestBeacon.id,
            characterId: context.characterId,
            fuelType,
            quantity: 1,
          });

          if (!fuelResult.success) return { success: false, error: fuelResult.error };

          overrideResponse = {
            success: true,
            message: `Fuel added! Beacon now has ${fuelResult.fuelRemaining?.toFixed(1)}h of fuel.`,
          };
          break;
        }

        case 'beacon_info': {
          const zoneId = zoneManager.getZone().id;
          const litBeacons = await GuildBeaconService.findLitBeaconsInZone(zoneId);

          let nearestBeacon: typeof litBeacons[0] | null = null;
          let nearestDist = Infinity;
          for (const b of litBeacons) {
            const d = distance2D(
              { x: context.position.x, z: context.position.z },
              { x: b.worldX, z: b.worldZ }
            );
            if (d < nearestDist) {
              nearestDist = d;
              nearestBeacon = b;
            }
          }

          if (!nearestBeacon) return { success: false, error: 'No beacons found in this zone.' };

          const info = await GuildBeaconService.getBeaconInfo(nearestBeacon.id);
          if (!info) return { success: false, error: 'Beacon not found.' };

          overrideResponse = {
            success: true,
            message: [
              `--- Beacon: ${info.worldPointName} ---`,
              `Guild: [${info.guildTag}]`,
              `Tier: ${info.tier}`,
              `Status: ${info.isLit ? 'LIT' : 'DARK'}`,
              info.isLit ? `Fuel: ${info.fuelRemaining.toFixed(1)}h / ${info.fuelCapacity}h` : null,
              info.emberClockStartedAt ? `Ember Clock: active (started ${new Date(info.emberClockStartedAt).toLocaleString()})` : null,
              `Distance: ${nearestDist.toFixed(0)}m`,
            ].filter(Boolean).join('\n'),
          };
          break;
        }

        case 'beacon_list': {
          const membership = await GuildService.getMembership(context.characterId);
          if (!membership) return { success: false, error: 'You are not in a guild.' };

          const beacons = await GuildBeaconService.findBeaconsByGuild(membership.guildId);
          const guild = await GuildService.findById(membership.guildId);
          const maxBeacons = GuildService.getMaxBeacons(guild?.memberCount ?? 0);

          if (beacons.length === 0) {
            overrideResponse = { success: true, message: `No beacons lit. (${0}/${maxBeacons} slots)` };
            break;
          }

          const lines = [`--- Guild Beacons (${beacons.length}/${maxBeacons}) ---`];
          for (const b of beacons) {
            const wp = await GuildBeaconService.findWorldPointById(b.worldPointId);
            lines.push(`  ${wp?.name ?? 'Unknown'} — T${b.tier} — ${b.isLit ? `${b.fuelRemaining.toFixed(1)}h fuel` : 'DARK'}`);
          }

          overrideResponse = { success: true, message: lines.join('\n') };
          break;
        }

        case 'beacon_extinguish': {
          const membership = await GuildService.getMembership(context.characterId);
          if (!membership) return { success: false, error: 'You are not in a guild.' };

          const isGM = await GuildService.isGuildmaster(membership.guildId, context.characterId);
          if (!isGM) return { success: false, error: 'Only the Guildmaster can extinguish beacons.' };

          // Find nearest guild beacon
          const zoneId = zoneManager.getZone().id;
          const litBeacons = await GuildBeaconService.findLitBeaconsInZone(zoneId);
          const guildBeacons = litBeacons.filter(b => b.guildId === membership.guildId);

          let nearestBeacon: typeof guildBeacons[0] | null = null;
          let nearestDist = Infinity;
          for (const b of guildBeacons) {
            const d = distance2D(
              { x: context.position.x, z: context.position.z },
              { x: b.worldX, z: b.worldZ }
            );
            if (d < nearestDist && d <= 30) {
              nearestDist = d;
              nearestBeacon = b;
            }
          }

          if (!nearestBeacon) return { success: false, error: 'No guild beacon nearby to extinguish.' };

          await GuildBeaconService.extinguishBeacon(nearestBeacon.id);

          // Recompute polygons and refresh caches
          void GuildBeaconService.recomputePolygons(membership.guildId);
          void this.refreshBeaconCaches();

          overrideResponse = { success: true, message: 'Beacon extinguished.' };
          break;
        }

        // ── Library events ──────────────────────────────────────────────
        case 'library_info': {
          const zoneId = zoneManager.getZone().id;
          const libraries = await LibraryBeaconService.findByZoneId(zoneId);

          let nearest: Awaited<ReturnType<typeof LibraryBeaconService.findById>> | null = null;
          let nearestDist = Infinity;
          for (const lib of libraries) {
            const d = distance2D(
              { x: context.position.x, z: context.position.z },
              { x: lib.worldX, z: lib.worldZ }
            );
            if (d < nearestDist) {
              nearestDist = d;
              nearest = lib;
            }
          }

          if (!nearest) return { success: false, error: 'No libraries found in this zone.' };

          const info = await LibraryBeaconService.getLibraryInfo(nearest.id);
          if (!info) return { success: false, error: 'Library not found.' };

          overrideResponse = {
            success: true,
            message: [
              `--- Library: ${info.name} ---`,
              `Status: ${info.isOnline ? 'ONLINE' : 'OFFLINE'}`,
              !info.isOnline && info.offlineReason ? `Reason: ${info.offlineReason}` : null,
              !info.isOnline && info.offlineUntil ? `Restores: ${new Date(info.offlineUntil).toLocaleString()}` : null,
              `Catchment: ${info.catchmentRadius}m`,
              `Assaults repelled: ${info.assaultCount - info.failedDefenseCount}`,
              `Distance: ${nearestDist.toFixed(0)}m`,
            ].filter(Boolean).join('\n'),
          };
          break;
        }

        case 'library_list': {
          const zoneId = zoneManager.getZone().id;
          const libraries = await LibraryBeaconService.findByZoneId(zoneId);

          if (libraries.length === 0) {
            overrideResponse = { success: true, message: 'No libraries in this zone.' };
            break;
          }

          const lines = [`--- Libraries in Zone (${libraries.length}) ---`];
          for (const lib of libraries) {
            const d = distance2D(
              { x: context.position.x, z: context.position.z },
              { x: lib.worldX, z: lib.worldZ }
            );
            lines.push(`  ${lib.name} — ${lib.isOnline ? 'ONLINE' : 'OFFLINE'} — ${d.toFixed(0)}m away`);
          }

          overrideResponse = { success: true, message: lines.join('\n') };
          break;
        }

        case 'library_defend': {
          const zoneId = zoneManager.getZone().id;
          const libraries = await LibraryBeaconService.findByZoneId(zoneId);

          // Find the nearest library with an active assault
          let registered = false;
          for (const lib of libraries) {
            const assault = this.libraryAssaultSystem.getActiveAssault(lib.id);
            if (assault) {
              registered = this.libraryAssaultSystem.registerDefender(lib.id, context.characterId);
              break;
            }
          }

          if (!registered) {
            return { success: false, error: 'No active library assault in this zone to defend against.' };
          }

          overrideResponse = { success: true, message: 'Registered as library defender. Defeat the assault mobs to protect the library!' };
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

  private resolveCombatTarget(
    zoneManager: ZoneManager,
    target: string,
    context?: CommandContext,
  ) {
    if (!target) return null;

    // ── Subtarget token resolution ──────────────────────────────────────────
    const token = target.trim().toLowerCase();
    switch (token) {
      case '<t>': {
        // Current target — entity the client has selected
        if (!context?.currentTarget) return null;
        const e = zoneManager.getEntity(context.currentTarget);
        return e && e.isAlive ? e : null;
      }
      case '<ft>': {
        // Focus target — secondary pinned target
        if (!context?.focusTarget) return null;
        const e = zoneManager.getEntity(context.focusTarget);
        return e && e.isAlive ? e : null;
      }
      case '<bt>': {
        // Battle target — the mob/entity the player is auto-attacking
        const btId = this.combatManager.getAutoAttackTarget(context?.characterId ?? '');
        if (!btId) return null;
        const e = zoneManager.getEntity(btId);
        return e && e.isAlive ? e : null;
      }
      case '<tt>': {
        // Target's target — what the current target is attacking
        const tId = context?.currentTarget;
        if (!tId) return null;
        const ttId = this.combatManager.getAutoAttackTarget(tId);
        if (!ttId) return null;
        const e = zoneManager.getEntity(ttId);
        return e && e.isAlive ? e : null;
      }
      case '<me>': {
        // Self-target
        if (!context) return null;
        const e = zoneManager.getEntity(context.characterId);
        return e && e.isAlive ? e : null;
      }
    }

    // ── Standard ID / name resolution ───────────────────────────────────────
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

    const enmity = this.combatManager.getEnmityTable();

    // Seed proximity threat so the mob has an initial threat entry
    if (!enmity.hasTable(targetEntity.id)) {
      enmity.addRawThreat(targetEntity.id, attackerEntity.id, enmity.config.proximityThreat);
    }

    const now = Date.now();
    this.combatManager.startCombat(targetEntity.id, now);

    // If mob has no target yet, pick from top threat (usually the first attacker)
    if (!this.combatManager.hasAutoAttackTarget(targetEntity.id)) {
      const top = enmity.getTopThreat(targetEntity.id);
      this.combatManager.setAutoAttackTarget(targetEntity.id, top?.entityId ?? attackerEntity.id);
    }
    // If mob already has a target, the CombatManager.update() threat evaluation handles switching
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
      // Only broadcast range errors for player-initiated actions (skip companion/mob noise)
      if (attackerEntity.type === 'player') {
        await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
          eventType: 'combat_error',
          timestamp: now,
          narrative: `Target out of range.`,
          eventTypeData: { reason: 'out_of_range', attackerId: characterId },
        });
      }
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
      if (ability.targetType === 'enemy') {
        this.combatManager.recordHostileAction(targetId, now);
      }

      const attackerStarted = this.combatManager.startCombat(characterId, now);
      const targetStarted = ability.targetType === 'enemy'
        ? this.combatManager.startCombat(targetId, now)
        : false;

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
    const isHostile = ability.targetType === 'enemy';
    this.combatManager.recordHostileAction(characterId, now);
    if (isHostile) {
      this.combatManager.recordHostileAction(targetId, now);
    }

    const attackerStarted = this.combatManager.startCombat(characterId, now);
    const targetStarted = isHostile
      ? this.combatManager.startCombat(targetId, now)
      : false;

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
    // Only trigger retaliation for hostile (enemy-targeted) abilities.
    if (isHostile) {
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
      let baseDamageOverride = (ability.id === 'basic_attack' && weaponData?.baseDamage)
        ? weaponData.baseDamage
        : undefined;

      // Power Strike: consume next-attack buff and add bonus damage
      const nextAtkBuff = this.combatManager.consumeNextAttackBuff(characterId);
      if (nextAtkBuff) {
        const flatBonus = nextAtkBuff.specialData?.flatBonus ?? 0;
        const scalingBonus = nextAtkBuff.specialData?.scalingBonus ?? 0;
        const totalBonus = flatBonus + scalingBonus;
        baseDamageOverride = (baseDamageOverride ?? ability.damage!.amount) + totalBonus;
      }

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

        // Mirror health into ZoneManager so publishZoneEntities and companion AI stay current
        zoneManager.setEntityHealth(targetData.entityId, newHp, targetData.maxHealth);

        // Root-break: if target is rooted, check if damage breaks the root
        this.combatManager.checkRootBreak(target.id, result.amount);

        // Generate enmity threat on mobs/wildlife from damage dealt
        if ((target.type as string) === 'mob' || (target.type as string) === 'wildlife') {
          if (resolvedAbility.threatModifier) {
            this.combatManager.generateAbilityThreat(target.id, characterId, resolvedAbility, result.amount);
          } else {
            this.combatManager.generateDamageThreat(target.id, characterId, result.amount);
          }
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

          // Clear enmity: remove this entity's threat table and purge it from all other tables
          this.combatManager.getEnmityTable().clearTable(targetData.entityId);
          this.combatManager.getEnmityTable().removeEntityFromAllTables(targetData.entityId);

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
            const deadMobZoneId = zoneManager.getZone().id;
            void this._resolveMobLoot(targetData.entityId, deadMobZoneId);

            // Vault mob death: notify VaultManager for room clear tracking
            if (VaultManager.isVaultZone(deadMobZoneId)) {
              this.vaultManager.reportMobDeath(targetData.entityId, deadMobZoneId);
              // Vault mobs don't respawn — but still need to despawn after death animation
              const vaultMobId = targetData.entityId;
              const vaultZoneId = deadMobZoneId;
              setTimeout(async () => {
                const zm = this.zones.get(vaultZoneId);
                if (zm) {
                  zm.removeMob(vaultMobId);
                  await this.broadcastEntityRemoved(vaultZoneId, vaultMobId);
                  await this.broadcastNearbyUpdate(vaultZoneId);
                  await this.publishZoneEntities(vaultZoneId, zm);
                }
              }, 2500);
            } else {
              await this.scheduleMobRespawn(targetData.entityId, deadMobZoneId, targetData.maxHealth);
            }
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

    // ── Healing path ──────────────────────────────────────────────────────────
    if (ability.healing) {
      const healSnapshot = await this.getCombatSnapshot(targetId, targetEntity);
      if (!healSnapshot) return { hit: false };

      const scalingStat = ability.healing.scalingStat;
      const scalingValue = scalingStat ? (attackerSnapshot.coreStats[scalingStat] ?? 0) : 0;
      const baseHeal = ability.healing.amount + scalingValue * (ability.healing.scalingMultiplier ?? 0);
      const healPotency = this.combatManager.getHealPotencyMult(characterId);
      const healAmount = Math.floor(baseHeal * healPotency);
      const newHp = Math.min(healSnapshot.maxHealth, healSnapshot.currentHealth + healAmount);
      await this.updateHealth(healSnapshot, newHp);

      // Mirror health into ZoneManager so companion AI can track ally HP
      zoneManager.setEntityHealth(targetId, newHp, healSnapshot.maxHealth);

      // Healing generates threat on all mobs engaged with the healer or heal target
      {
        const enmity = this.combatManager.getEnmityTable();
        const mobsFromTarget = enmity.getMobsThreatenedBy(targetId);
        const mobsFromHealer = enmity.getMobsThreatenedBy(characterId);
        const relevantMobs = new Set([...mobsFromTarget, ...mobsFromHealer]);
        for (const mobId of relevantMobs) {
          this.combatManager.generateHealingThreat(mobId, characterId, healAmount);
        }
      }

      if (healSnapshot.isPlayer) {
        await this.sendCharacterResourcesUpdate(zoneManager, targetId, {
          health: { current: newHp, max: healSnapshot.maxHealth },
        });
      }
      const targetEntityPos = zoneManager.getEntity(targetId)?.position ?? attackerEntity.position;
      await this.broadcastEntityHealthUpdate(zoneManager, targetEntityPos, targetId, {
        current: newHp,
        max: healSnapshot.maxHealth,
      });

      const targetName = zoneManager.getEntity(targetId)?.name ?? 'target';
      await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
        eventType: 'combat_heal',
        timestamp: now,
        narrative: `${attackerName} heals ${targetName} for ${healAmount} HP.`,
        eventTypeData: {
          attackerId: characterId,
          targetId,
          abilityId: ability.id,
          amount: healAmount,
          floatText: `+${healAmount}`,
        },
      });

      return { hit: true };
    }

    // ── Provoke (taunt) ───────────────────────────────────────────────────────
    if (ability.id === 'provoke') {
      this.combatManager.setTaunt(targetId, characterId, 4000, now); // 4 seconds
      // Dump large threat so tank stays on top after taunt expires
      this.combatManager.generateAbilityThreat(targetId, characterId, ability, 0);
      const targetName = zoneManager.getEntity(targetId)?.name ?? 'target';
      await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
        eventType: 'combat_effect',
        timestamp: now,
        narrative: `${attackerName} provokes ${targetName}!`,
        eventTypeData: {
          attackerId: characterId,
          targetId,
          abilityId: ability.id,
          effectType: 'taunt',
          duration: 4,
        },
      });
      return { hit: true };
    }

    // ── Embolden (stat buff) ──────────────────────────────────────────────────
    if (ability.id === 'embolden') {
      this.combatManager.addBuff(targetId, {
        id: 'embolden',
        sourceId: characterId,
        expiresAt: now + 10_000, // 10 seconds
        statMods: { attackRating: 10, magicAttack: 8 },
      });

      // Buff application generates flat threat on all mobs engaged with the target
      {
        const enmity = this.combatManager.getEnmityTable();
        const relevantMobs = enmity.getMobsThreatenedBy(targetId);
        for (const mobId of relevantMobs) {
          this.combatManager.generateFlatThreat(mobId, characterId, enmity.config.buffBaseThreat);
        }
      }

      const targetName = zoneManager.getEntity(targetId)?.name ?? 'target';
      await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
        eventType: 'combat_effect',
        timestamp: now,
        narrative: `${attackerName} emboldens ${targetName}!`,
        eventTypeData: {
          attackerId: characterId,
          targetId,
          abilityId: ability.id,
          effectType: 'buff',
          duration: 10,
          statMods: { attackRating: 10, magicAttack: 8 },
        },
      });
      return { hit: true };
    }

    // ── Ensnare (root) ────────────────────────────────────────────────────────
    if (ability.id === 'ensnare') {
      this.combatManager.setRoot(targetId, 3000, 20, now); // 3s, breaks at 20 damage
      // Immediately halt any in-progress movement
      this.movementSystem.stopMovement({ characterId: targetId, zoneId: zoneManager.getZone().id });
      const targetName = zoneManager.getEntity(targetId)?.name ?? 'target';
      await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
        eventType: 'combat_effect',
        timestamp: now,
        narrative: `${attackerName} ensnares ${targetName}!`,
        eventTypeData: {
          attackerId: characterId,
          targetId,
          abilityId: ability.id,
          effectType: 'root',
          duration: 3,
        },
      });
      return { hit: true };
    }

    // ── Power Strike (next-attack buff) ───────────────────────────────────────
    if (ability.id === 'power_strike') {
      const strValue = attackerSnapshot.coreStats.strength ?? 0;
      this.combatManager.addBuff(characterId, {
        id: 'power_strike',
        sourceId: characterId,
        expiresAt: now + 10_000, // 10 seconds
        special: 'next_attack_bonus',
        specialData: { flatBonus: 10, scalingBonus: Math.floor(strValue * 0.5) },
        consumeOnHit: true,
      });
      await this.broadcastCombatEvent(zoneManager.getZone().id, attackerEntity.position, {
        eventType: 'combat_effect',
        timestamp: now,
        narrative: `${attackerName} readies a Power Strike!`,
        eventTypeData: {
          attackerId: characterId,
          targetId: characterId,
          abilityId: ability.id,
          effectType: 'buff',
          duration: 10,
        },
      });
      return { hit: true };
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

      const baseStats = this.buildCombatStats(derived);

      // Apply passive ability tree bonuses from slotted passive nodes
      const passiveLoadout = parsePassiveLoadout(character.passiveLoadout);
      for (const nodeId of passiveLoadout.slots) {
        if (!nodeId) continue;
        const node = PASSIVE_WEB_MAP.get(nodeId);
        if (!node?.statBonus) continue;
        for (const [key, val] of Object.entries(node.statBonus)) {
          if (typeof val === 'number' && key in baseStats) {
            (baseStats as unknown as Record<string, number>)[key] += val;
          }
        }
      }

      // Apply active buff stat modifiers
      const buffMods = this.combatManager.getBuffStatMods(entityId);
      if (buffMods) {
        for (const [key, val] of Object.entries(buffMods)) {
          if (key in baseStats && typeof val === 'number') {
            (baseStats as unknown as Record<string, number>)[key] += val;
          }
        }
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
        stats: baseStats,
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

      const compStats = this.buildCombatStats(derived);
      const compBuffMods = this.combatManager.getBuffStatMods(entityId);
      if (compBuffMods) {
        for (const [key, val] of Object.entries(compBuffMods)) {
          if (key in compStats && typeof val === 'number') {
            (compStats as unknown as Record<string, number>)[key] += val;
          }
        }
      }

      // Read current mana/stamina from in-memory ZoneManager entity
      const compZoneId = this.companionToZone.get(entityId);
      const compEntity = compZoneId ? this.zones.get(compZoneId)?.getEntity(entityId) : null;

      return {
        entityId,
        isPlayer: false,
        currentHealth: companion.currentHealth,
        maxHealth: companion.maxHealth,
        currentStamina: compEntity?.currentStamina ?? derived.maxStamina,
        currentMana: compEntity?.currentMana ?? derived.maxMana,
        maxStamina: compEntity?.maxStamina ?? derived.maxStamina,
        maxMana: compEntity?.maxMana ?? derived.maxMana,
        coreStats,
        stats: compStats,
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

    // Abilities with an explicit range > melee use that range directly (e.g. shadow bolt 30 m).
    // Melee abilities (range <= 2) use weapon reach + body radii + arm reach.
    const isMelee = !ability.range || ability.range <= 2;
    const weaponReach    = weaponRange ?? UNARMED_RANGE;
    const effectiveRange = isMelee
      ? BASE_REACH + ENTITY_RADIUS + ENTITY_RADIUS + weaponReach + MELEE_RANGE_BUFFER
      : ability.range + ENTITY_RADIUS + ENTITY_RADIUS;

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
    if (!isAutoAttack && ability.staminaCost && snapshot.currentStamina < ability.staminaCost) return false;
    if (ability.manaCost && snapshot.currentMana < ability.manaCost) return false;
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

    // Companion/mob: deduct health to DB, deduct mana/stamina in-memory via ZoneManager
    if (healthCost > 0) {
      await CompanionService.updateStatus(snapshot.entityId, {
        currentHealth: newHealth,
        isAlive: newHealth > 0,
      });
    }
    if (staminaCost > 0 || manaCost > 0) {
      // Find the companion's zone and update in-memory resources
      const compZoneId = this.companionToZone.get(snapshot.entityId);
      if (compZoneId) {
        const zm = this.zones.get(compZoneId);
        if (zm) {
          zm.setEntityResources(snapshot.entityId, {
            currentStamina: Math.max(0, snapshot.currentStamina - staminaCost),
            currentMana: Math.max(0, snapshot.currentMana - manaCost),
          });
        }
      }
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
    // Snap Y to server terrain — the Rust sim may not have real elevation data.
    data.position = this._snapWildlifeY(zm, data.position);
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
    // Snap Y to server terrain — the Rust sim may not have real elevation data.
    const snapped = this._snapWildlifeY(zm, position);
    zm.updateWildlife(entityId, snapped, heading, behavior);
  }

  removeWildlifeFromZone(zoneId: string, entityId: string): void {
    const zm = this.zones.get(zoneId);
    if (!zm) return;
    zm.removeWildlife(entityId);
    void this.broadcastNearbyUpdate(zoneId);
  }

  /**
   * Snap a wildlife position's Y to the server's terrain elevation.
   *
   * The Rust wildlife sim may not have real elevation data (the navmesh
   * cells can have zero elevation when the ElevationPipeline hasn't run),
   * so it falls back to procedural hills that don't match the GLB terrain.
   * This method uses the same applyGravity that the server uses for
   * players, mobs, and companions so wildlife walk on the correct surface.
   */
  private _snapWildlifeY(
    zm: any,
    position: { x: number; y: number; z: number },
  ): { x: number; y: number; z: number } {
    const physics = zm.getPhysicsSystem?.();
    if (!physics) return position;
    return physics.applyGravity(position);
  }

  despawnLocalWildlifeAndFlora(zoneId: string): void {
    const zm = this.zones.get(zoneId);
    if (!zm) return;

    // Despawn server-spawned wildlife
    const wm = this.wildlifeManagers.get(zoneId);
    if (wm) {
      const removedIds = wm.despawnAll();
      for (const id of removedIds) {
        zm.removeWildlife(id);
      }
      if (removedIds.length > 0) {
        void this.broadcastNearbyUpdate(zoneId);
      }
    }

    // Despawn server-spawned flora
    const fm = this.floraManagers.get(zoneId);
    if (fm) {
      const removedPlantIds = fm.despawnAll();
      for (const plantId of removedPlantIds) {
        void this._broadcastPlantRemoved(zoneId, plantId);
      }
    }
  }

  getAllActiveZoneIds(): string[] {
    return [...this.zones.keys()];
  }

  getZoneBiome(zoneId: string): string {
    return this.zoneBiomes.get(zoneId) ?? BIOME_FALLBACK;
  }

  getZoneBounds(zoneId: string): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
    const zm = this.zones.get(zoneId);
    if (!zm) return null;
    const zone = zm.getZone();
    const halfX = zone.sizeX / 2;
    const halfZ = zone.sizeZ / 2;
    return {
      min: { x: zone.worldX - halfX, y: 0, z: zone.worldY - halfZ },
      max: { x: zone.worldX + halfX, y: zone.sizeY, z: zone.worldY + halfZ },
    };
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
    // Snap Y to server terrain so wildlife walk on the actual ground surface.
    const zm = this.zones.get(zoneId);
    const snapped = zm ? this._snapWildlifeY(zm, position) : position;
    const stateUpdate = {
      timestamp: Date.now(),
      entities: {
        updated: [{ id: entityId, name, type: 'wildlife', position: snapped, heading, currentAction: animation, movementDuration: 520, movementSpeed: speed }],
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

  // ── IWildlifeWorld — plant management ───────────────────────────────────

  addExternalPlant(
    zoneId: string,
    plantId: string,
    speciesId: string,
    position: { x: number; y: number; z: number },
    stage: string,
  ): void {
    const fm = this.floraManagers.get(zoneId);
    if (!fm) return;

    // Snap Y to server terrain, same as wildlife.
    const zm = this.zones.get(zoneId);
    const snapped = zm ? this._snapWildlifeY(zm, position) : position;

    fm.addExternalPlant(plantId, speciesId, snapped, stage);
  }

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
    // Snap Y to server terrain — plant positions from the Rust sim or
    // FloraManager may not match the GLB terrain surface.
    const zm = this.zones.get(zoneId);
    const snapped = zm ? this._snapWildlifeY(zm, position) : position;
    const speciesData = getPlantSpecies(speciesId);
    const entity = {
      id:          plantId,
      type:        'plant',
      name:        speciesData?.name ?? speciesId,
      position:    snapped,
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
      modelAsset:  s.modelAsset,
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
        modelAsset: s.catalog.modelAsset,
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

  /**
   * Rescue a player stuck in a dead ephemeral zone (vault/village whose server
   * instance no longer exists). Sends them to their saved return point or
   * Stephentown as a fallback, regardless of what command they ran.
   */
  private async rescueFromDeadZone(
    characterId: string,
    deadZoneId: string,
    socketId: string,
    command: string,
  ): Promise<void> {
    const character = await CharacterService.findById(characterId);

    let destZoneId = character?.returnZoneId ?? null;
    let destX = character?.returnPositionX ?? 0;
    let destY = character?.returnPositionY ?? 0;
    let destZ = character?.returnPositionZ ?? 0;

    // If return point is missing or itself an ephemeral zone, fall back to starter
    if (!destZoneId || destZoneId.startsWith('vault:') || destZoneId.startsWith('village:')) {
      const fallbackZone = 'USA_NY_Stephentown';
      const spawn = SpawnPointService.getStarterSpawn(fallbackZone);
      destZoneId = fallbackZone;
      destX = spawn?.position?.x ?? 12;
      destY = spawn?.position?.y ?? 265;
      destZ = spawn?.position?.z ?? -18;
    }

    await VillageService.updateCharacterZone(characterId, destZoneId, destX, destY, destZ);
    await VillageService.clearReturnPoint(characterId);

    logger.info({ characterId, from: deadZoneId, to: destZoneId }, '[DWM] Rescued player from dead ephemeral zone');

    // Send zone transfer to move the client
    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId,
      socketId,
      payload: {
        socketId,
        event: 'zone_transfer',
        data: { zoneId: destZoneId },
      },
      timestamp: Date.now(),
    });

    // Also send a command response so the player sees feedback
    await this.sendCommandResponse(socketId, command, {
      success: true,
      message: 'Instance no longer exists — returning you to safety.',
    });
  }

  private async processReturnCommand(
    characterId: string,
    zoneId: string,
    socketId?: string,
  ): Promise<{ success: boolean; message: string }> {
    const COOLDOWN_MS = 30 * 60 * 1_000; // 30 minutes
    const now = Date.now();
    const last = this.returnCooldowns.get(characterId) ?? 0;

    if (now - last < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - (now - last)) / 1_000);
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      const label = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      return { success: false, message: `You can't use /return yet — wait ${label}.` };
    }

    // Determine destination — if in a village/vault instance, transfer back to
    // the saved return point (where the player was before entering).
    const isEphemeral = VillageService.isVillageZone(zoneId) || VaultManager.isVaultZone(zoneId);

    if (isEphemeral) {
      const character = await CharacterService.findById(characterId);

      let destZoneId = character?.returnZoneId ?? null;
      let destX = character?.returnPositionX ?? 0;
      let destY = character?.returnPositionY ?? 0;
      let destZ = character?.returnPositionZ ?? 0;

      // If return point is missing or itself an ephemeral zone, fall back to starter
      if (!destZoneId || destZoneId.startsWith('vault:') || destZoneId.startsWith('village:')) {
        const fallbackZone = 'USA_NY_Stephentown';
        const spawn = SpawnPointService.getStarterSpawn(fallbackZone);
        destZoneId = fallbackZone;
        destX = spawn?.position?.x ?? 12;
        destY = spawn?.position?.y ?? 265;
        destZ = spawn?.position?.z ?? -18;
      }

      await VillageService.updateCharacterZone(characterId, destZoneId, destX, destY, destZ);
      await VillageService.clearReturnPoint(characterId);

      if (socketId) {
        await this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          characterId,
          socketId,
          payload: {
            socketId,
            event: 'zone_transfer',
            data: { zoneId: destZoneId },
          },
          timestamp: Date.now(),
        });
      }

      this.returnCooldowns.set(characterId, now);
      logger.info({ characterId, from: zoneId, to: destZoneId }, '[DWM] /return (zone transfer)');
      return { success: true, message: 'Returning to where you were…' };
    }

    // Same-zone teleport
    const zm = this.zones.get(zoneId);
    if (!zm) return { success: false, message: 'Zone not available.' };

    zm.updatePlayerPosition(characterId, dest);
    await CharacterService.updatePosition(characterId, dest);

    await this.broadcastPositionUpdate(characterId, zoneId, dest);
    await this.broadcastNearbyUpdate(zoneId);

    this.returnCooldowns.set(characterId, now);
    logger.info({ characterId, zoneId, dest }, '[DWM] /return applied');

    return { success: true, message: `You have returned to ${spawn?.name ?? 'Town Hall'}.` };
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

              // ── Companion level sync on player level-up ────────────────
              try {
                await this.syncCompanionOnLevelUp(memberId, xpResult.newLevel);
              } catch (syncErr) {
                logger.warn({ err: syncErr, memberId }, '[XP] Failed to sync companion level');
              }
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
  /** Per-NPC cooldown: minimum seconds between LLM ambient chat calls. */
  private static readonly NPC_CHAT_COOLDOWN_MS = 30_000;
  /** Per-NPC last-response timestamps. */
  private npcChatCooldowns: Map<string, number> = new Map();

  private async triggerNPCResponses(zoneId: string, messageOrigin: { x: number; y: number; z: number }, range: number): Promise<void> {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const recentMessages = this.recentChatMessages.get(zoneId) || [];
    const contextMessages = recentMessages.slice(-5).map(m => ({
      sender: m.sender, channel: m.channel, message: m.message,
    }));

    const nearbyNPCs = await this.getNearbyNPCs(zoneId, messageOrigin, range);
    const redis = this.messageBus.getRedisClient();
    const now = Date.now();

    for (const companion of nearbyNPCs) {
      // Skip player-controlled companions
      if (this.companionToZone.has(companion.id)) continue;

      // Skip airlock-inhabited NPCs — the external AI hears chat and responds itself
      const inhabitId = await redis.get(`airlock:npc:${companion.id}`);
      if (inhabitId) continue;

      const controller = this.npcControllers.get(companion.id);
      if (!controller) continue;

      // Per-NPC cooldown — prevent spamming LLM on every chat message
      const lastCall = this.npcChatCooldowns.get(companion.id) ?? 0;
      if (now - lastCall < DistributedWorldManager.NPC_CHAT_COOLDOWN_MS) continue;

      const result = zoneManager.calculateProximityRoster(companion.id);
      if (!result) continue;

      this.npcChatCooldowns.set(companion.id, now);
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

    // Per-NPC cooldown (shorter for /talk since it's intentional)
    const now = Date.now();
    const lastCall = this.npcChatCooldowns.get(npcId) ?? 0;
    if (now - lastCall < 10_000) return;

    const nearbyNPCs = await this.getNearbyNPCs(zoneId, messageOrigin, range);
    const companion = nearbyNPCs.find(c => c.id === npcId);
    if (!companion) return;

    this.npcChatCooldowns.set(npcId, now);

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
   * Handle private companion chat — player talks to their own companion via /cc.
   * The message is sent to the companion's LLM and the reply goes back to the
   * owner only (not proximity-broadcast).
   */
  private async handleCompanionChat(
    characterId: string,
    zoneId: string,
    text: string,
    socketId: string,
  ): Promise<void> {
    logger.info({ characterId, zoneId, text, socketId }, '[CompanionChat] handleCompanionChat entered');

    // ── Find the player's companion in this zone ──────────────────────────
    let companionId: string | null = null;
    for (const [cId, cZone] of this.companionToZone.entries()) {
      if (cZone !== zoneId) continue;
      const ctrl = this.npcControllers.get(cId);
      if (!ctrl) continue;
      if (ctrl.getCompanion().ownerCharacterId === characterId) {
        companionId = cId;
        break;
      }
    }

    logger.info({ companionId, companionToZoneSize: this.companionToZone.size }, '[CompanionChat] companion lookup result');

    if (!companionId) {
      // No companion in zone — tell the player
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId,
        socketId,
        payload: {
          socketId,
          event: 'chat',
          data: {
            channel: 'system',
            sender: '',
            senderId: '',
            message: 'You don\'t have a companion in this zone.',
            timestamp: Date.now(),
          },
        } as ClientMessagePayload,
        timestamp: Date.now(),
      });
      return;
    }

    const controller = this.npcControllers.get(companionId)!;
    const companion = controller.getCompanion();

    // ── Build conversation context ────────────────────────────────────────
    const history = this.companionChatHistory.get(companionId) ?? [];

    // Add the player's message to history
    const { CharacterService } = await import('@/database');
    const sender = await CharacterService.findById(characterId);
    const senderName = sender?.name ?? 'Player';

    const playerMsg = { sender: senderName, channel: 'companion', message: text };
    history.push(playerMsg);

    // Cap at 10 entries
    while (history.length > 10) history.shift();
    this.companionChatHistory.set(companionId, history);

    // ── Call LLM (dedicated companion chat path — no SAY:/SHOUT: format) ─
    logger.info({ companionId, companionName: companion.name, historyLen: history.length }, '[CompanionChat] calling LLM');
    try {
      const response = await this.llmService.generateCompanionChat(
        companion,
        senderName,
        history,
      );

      logger.info({ companionId, hasMessage: !!response.message, message: response.message?.slice(0, 80) }, '[CompanionChat] LLM response');

      const ownerSocketId = this._charToSocket.get(characterId) ?? socketId;

      if (!response.message) {
        // LLM not configured or returned empty — send fallback
        logger.info({ companionId, characterId, ownerSocketId }, '[CompanionChat] no message, sending fallback');
        await this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          characterId,
          socketId: ownerSocketId,
          payload: {
            socketId: ownerSocketId,
            event: 'chat',
            data: {
              channel: 'companion',
              sender: companion.name,
              senderId: companion.id,
              message: `*${companion.name} looks at you but doesn't seem to know what to say.*`,
              timestamp: Date.now(),
            },
          } as ClientMessagePayload,
          timestamp: Date.now(),
        });
        return;
      }

      // Add companion's reply to history
      history.push({ sender: companion.name, channel: 'companion', message: response.message });
      while (history.length > 10) history.shift();

      // ── Send response ONLY to the owner ────────────────────────────────
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId,
        socketId: ownerSocketId,
        payload: {
          socketId: ownerSocketId,
          event: 'chat',
          data: {
            channel: 'companion',
            sender: companion.name,
            senderId: companion.id,
            message: response.message,
            timestamp: Date.now(),
          },
        } as ClientMessagePayload,
        timestamp: Date.now(),
      });

      logger.debug({
        companionId: companion.id,
        ownerId: characterId,
      }, 'Companion replied via /cc');

    } catch (error) {
      logger.error({ error, companionId: companion.id }, 'Companion chat LLM response failed');

      // Let the player know something went wrong
      const ownerSocketId = this._charToSocket.get(characterId) ?? socketId;
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId,
        socketId: ownerSocketId,
        payload: {
          socketId: ownerSocketId,
          event: 'chat',
          data: {
            channel: 'system',
            sender: '',
            senderId: '',
            message: `${companion.name} seems confused and doesn't respond.`,
            timestamp: Date.now(),
          },
        } as ClientMessagePayload,
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
    position: Vector3,
    overrideMovementSpeed?: number,
    overrideMovementDuration?: number,
  ): Promise<void> {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const entity = zoneManager.getEntity(characterId);
    if (!entity) return;

    // Get animation and movement data
    const animationLockSystem = zoneManager.getAnimationLockSystem();
    const movementSystem = this.movementSystem;
    
    const animationState = animationLockSystem?.getState(characterId);
    const movementDuration = overrideMovementDuration ?? movementSystem.getMovementDuration(characterId);
    const movementSpeed = overrideMovementSpeed ?? movementSystem.getMovementSpeed(characterId);
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
    // Update combat system (ATB, cooldowns, combat timeouts, buff ticks/expiry)
    const combatResult = this.combatManager.update(
      deltaTime,
      (entityId) => this.attackSpeedBonusCache.get(entityId) ?? 0
    );
    if (combatResult.expiredCombatants.length > 0) {
      void this.handleCombatTimeouts(combatResult.expiredCombatants);
    }
    if (combatResult.buffTicks.length > 0) {
      void this.processBuffTicks(combatResult.buffTicks);
    }
    if (combatResult.expiredBuffs.length > 0) {
      void this.broadcastBuffExpiries(combatResult.expiredBuffs);
    }

    // Process queued combat actions (cast times)
    void this.processQueuedCombatActions();

    // Process auto-attacks for entities whose weapon timer is ready
    void this.processAutoAttacks();

    // Broadcast combat gauges to players in combat
    void this.broadcastCombatGauges();

    // Update movement system — queue player position snapshots for batched broadcast.
    const positionUpdates = this.movementSystem.update(deltaTime);
    if (positionUpdates.size > 0) {
      this.handleMovementUpdates(positionUpdates);
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

    // Update scripted object controllers (Lua heartbeat, proximity events, timers)
    for (const controller of this.scriptedObjectControllers.values()) {
      controller.update(deltaTime, now);
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
      // Provide a steering callback so mobs navigate around buildings instead
      // of walking straight into walls and relying solely on wall-push.
      const physics = zm.getPhysicsSystem();
      const steerFn = (pos: { x: number; y: number; z: number }, heading: number) =>
        physics.steerAroundWalls(pos, heading, 4.0, 0.5);
      const { moves, leashBroken, stuckRequests } = wanderSystem.update(deltaTime, steerFn);

      // ── 3. Handle leash breaks — mob chased too far, pull it back ────────
      for (const id of leashBroken) {
        const entity = zm.getEntity(id);
        if (entity) {
          this.combatManager.clearAutoAttackTarget(id);
          this.combatManager.clearQueuedActionsForEntity(id);
          this.combatManager.getEnmityTable().clearTable(id);
          zm.setEntityCombatState(id, false);
          // wanderSystem already transitioned the mob to 'returning'
        }
      }

      // ── 4. Apply position updates (wander, chase, and return all emit moves)
      let anyMoved = leashBroken.length > 0; // combat-state change counts as a zone update
      for (const { id, position, heading } of moves) {
        const entity = zm.getEntity(id);
        if (!entity) continue;
        if (!entity.isAlive) continue; // Don't move corpses — wander system will be unregistered at despawn

        // Root check: rooted mobs can't move — keep wander system in sync
        // with the actual (unchanged) position so it doesn't desync.
        if (this.combatManager.isRooted(id)) {
          wanderSystem.updateCurrentPosition(id, entity.position);
          continue;
        }

        // Resolve candidate position against building walls before terrain snap,
        // so mobs obey the same structure collisions players do.
        const wallResolved = physics.resolveAgainstStructures(position, 0.5);
        const snapped = zm.updateMobPosition(id, wallResolved, heading);
        // Feed the terrain-snapped Y back so the next tick uses the actual
        // ground elevation and mobs don't float or clip terrain.
        wanderSystem.updateCurrentPosition(id, snapped);
        // Queue for batched broadcast (flushed by _flushMovementQueue at end of tick).
        this._queueEntityBroadcast(id, zoneId, snapped);
        anyMoved = true;
      }

      // ── 5. Unstick mobs that geometry has trapped after MAX_STUCK_PICKS attempts
      for (const id of stuckRequests) {
        const entity = zm.getEntity(id);
        if (!entity || !entity.isAlive) continue;
        const nudged  = physics.nudgeToUnstuck(entity.position, 0.5);
        const snapped = zm.updateMobPosition(id, nudged, entity.heading ?? 0);
        wanderSystem.updateCurrentPosition(id, snapped);
        // Queue for batched broadcast.
        this._queueEntityBroadcast(id, zoneId, snapped);
        anyMoved = true;
        logger.debug({ mobId: id, zoneId, nudged }, '[MobWander] Geometry unstuck applied');
      }

      if (anyMoved) void this.publishZoneEntities(zoneId, zm);
    }

    // ── Update companion combat AI ────────────────────────────────────────
    void this.tickCompanionCombat(deltaTime);

    // ── Update companion behavior trees (TASKED + ACTIVE following) ──────
    void this.tickCompanionBehavior(deltaTime);

    if (now - this.lastPartyStatusBroadcastAt >= PARTY_STATUS_INTERVAL_MS) {
      void this.broadcastPartyStatus();
      this.lastPartyStatusBroadcastAt = now;
    }

    // Tick physics (gravity/freefall) for NPCs, mobs, and wildlife
    for (const [zoneId, zoneManager] of this.zones) {
      const physicsMoved = zoneManager.tickPhysics(deltaTime);
      if (physicsMoved.length > 0) {
        for (const { id, position } of physicsMoved) {
          // Queue for batched broadcast (flushed below).
          this._queueEntityBroadcast(id, zoneId, position);
        }
        // Keep Redis entity snapshot current so world_entry gets correct positions
        void this.publishZoneEntities(zoneId, zoneManager);
      }
    }

    // ── Flush all queued entity position broadcasts ──────────────────────
    // ONE batched state_update per zone per recipient, containing every
    // entity that moved this tick (players, mobs, physics).  This replaces
    // the old pattern of N individual broadcastPositionUpdate() calls that
    // flooded the message bus and caused mobs to freeze during WASD movement.
    void this._flushMovementQueue();

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

    // Update ember clock system (guild beacon fuel ticks)
    this.emberClockSystem.update();

    // Passive stamina regen — ticks every 3s for all players
    this.staminaRegenAccumulator += deltaTime;
    if (this.staminaRegenAccumulator >= DistributedWorldManager.STAMINA_REGEN_INTERVAL_S) {
      this.staminaRegenAccumulator = 0;
      void this.tickStaminaRegen();
    }

    // Beacon proximity regen (HP + MP) — ticks every 5s
    this.beaconRegenAccumulator += deltaTime;
    if (this.beaconRegenAccumulator >= DistributedWorldManager.BEACON_REGEN_INTERVAL_S) {
      this.beaconRegenAccumulator = 0;
      void this.tickBeaconRegen();
    }

    // Update library assault system (assault trigger checks)
    this.libraryAssaultSystem.update();

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
  /** Counter for throttling enmity list broadcasts (every N ticks). */
  private enmityBroadcastCounter = 0;

  /** Batched entity movement broadcasting.
   *
   *  ALL position-changing sources (player movement, mob wander, physics)
   *  queue snapshots into movementQueue during the tick.  At the end of
   *  update(), _flushMovementQueue() sends ONE combined state_update per
   *  zone per recipient, dramatically reducing message-bus throughput.
   *
   *  Previously, mob positions were broadcast individually (one Redis
   *  publish per mob per player per tick).  When player WASD movement added
   *  extra async messages (proximity rosters, nearby updates), the message
   *  bus became congested and mob updates were delayed — causing mobs to
   *  appear frozen on the client while the player held WASD keys.
   *
   *  The queue stores the *latest* snapshot per entity — intermediate ticks
   *  just overwrite the previous entry, so no unbounded growth.
   *
   *  Proximity rosters are also flushed on the same cadence. */
  private movementBroadcastTickCounter = 0;
  private static readonly MOVEMENT_BROADCAST_INTERVAL = 1; // every tick (~50 ms at 20 TPS → 20 Hz)

  /** Per-zone queue of entity snapshots accumulated since last flush. */
  private movementQueue = new Map<string, Map<string, {
    id: string; name: string; type: string;
    position: Vector3; heading?: number;
    movementDuration?: number; movementSpeed?: number;
    currentAction?: string;
  }>>();
  /**
   * Queue an entity position snapshot for batched broadcasting.
   * Used by player movement (handleMovementUpdates), mob wander, and
   * physics ticks.  The queue is flushed once per tick by
   * _flushMovementQueue(), producing ONE combined state_update per zone
   * per recipient — dramatically reducing Redis message-bus throughput.
   */
  private _queueEntityBroadcast(
    entityId: string,
    zoneId: string,
    position: Vector3,
    overrideHeading?: number,
    overrideMovementDuration?: number,
    overrideMovementSpeed?: number,
  ): void {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const entity = zoneManager.getEntity(entityId);
    if (!entity) return;

    const animationState = zoneManager.getAnimationLockSystem()?.getState(entityId);
    const heading = overrideHeading
      ?? this.movementSystem.getHeading(entityId)
      ?? entity.heading;
    const movementDuration = overrideMovementDuration
      ?? this.movementSystem.getMovementDuration(entityId);
    const movementSpeed = overrideMovementSpeed
      ?? this.movementSystem.getMovementSpeed(entityId);

    let zoneQueue = this.movementQueue.get(zoneId);
    if (!zoneQueue) {
      zoneQueue = new Map();
      this.movementQueue.set(zoneId, zoneQueue);
    }
    // Overwrite — we only care about the latest snapshot per entity.
    zoneQueue.set(entityId, {
      id: entityId,
      name: entity.name,
      type: entity.type,
      position,
      heading,
      movementDuration,
      movementSpeed,
      currentAction: animationState?.currentAction,
    });
  }

  /**
   * Flush the movementQueue — send one batched state_update per zone per
   * recipient, then fire proximity rosters for player entities only.
   *
   * Called once per tick from update(), AFTER all movement sources (player
   * movement, mob wander, physics) have queued their snapshots.
   */
  private async _flushMovementQueue(): Promise<void> {
    this.movementBroadcastTickCounter++;
    if (this.movementBroadcastTickCounter < DistributedWorldManager.MOVEMENT_BROADCAST_INTERVAL) {
      return; // keep accumulating
    }
    this.movementBroadcastTickCounter = 0;

    const zoneUpdates = new Set<string>();

    for (const [zoneId, entityMap] of this.movementQueue) {
      if (entityMap.size === 0) continue;

      const zoneManager = this.zones.get(zoneId);
      if (!zoneManager) { entityMap.clear(); continue; }

      zoneUpdates.add(zoneId);

      // Build one batched state_update containing ALL moving entities in this zone.
      const updatedEntities = Array.from(entityMap.values());
      const now = Date.now();

      // Send to every player in the zone, filtering out their OWN entity.
      // Sending a player their own stale position causes client-side prediction
      // to fight the reconciliation loop (anchor/jitter).
      for (const [charId, charZoneId] of this.characterToZone.entries()) {
        if (charZoneId !== zoneId) continue;
        const socketId = zoneManager.getSocketIdForCharacter(charId);
        if (!socketId) continue;

        // Exclude self — the player trusts their own prediction during movement.
        const filtered = updatedEntities.filter(e => e.id !== charId);
        if (filtered.length === 0) continue; // nothing to send

        await this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          characterId: charId,
          socketId,
          payload: {
            socketId,
            event: 'state_update',
            data: { timestamp: now, entities: { updated: filtered } },
          },
          timestamp: now,
        });
      }

      // Proximity rosters only for player entities (mobs/NPCs don't have sockets).
      for (const characterId of entityMap.keys()) {
        if (this.characterToZone.has(characterId)) {
          await this.sendProximityRosterToEntity(characterId);
        }
      }

      entityMap.clear();
    }

    // Zone-wide proximity roster refresh for affected zones.
    for (const zoneId of zoneUpdates) {
      await this.broadcastNearbyUpdate(zoneId);
    }
  }

  private static readonly ENMITY_BROADCAST_INTERVAL = 10; // every 10 ticks (~500 ms at 20 TPS)

  private async broadcastCombatGauges(): Promise<void> {
    const entitiesInCombat = this.combatManager.getEntitiesInCombat();

    // Enmity list is moderately expensive — throttle to every ~500 ms
    this.enmityBroadcastCounter++;
    const includeEnmity = this.enmityBroadcastCounter >= DistributedWorldManager.ENMITY_BROADCAST_INTERVAL;
    if (includeEnmity) this.enmityBroadcastCounter = 0;

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
      const effects = this.serializeEffectsForEntity(entityId);
      const stateUpdate: Record<string, unknown> = {
        timestamp: Date.now(),
        combat: {
          atb: combatState.atb,
          autoAttack: combatState.autoAttack,
          inCombat: combatState.inCombat,
          autoAttackTarget: combatState.autoAttackTarget,
          ...(hasCharges && { specialCharges: combatState.specialCharges }),
          ...(includeEnmity && { enmityList: this.buildEnmityList(entityId, zoneId, zoneManager) }),
        },
        // Include active effects (buffs/debuffs/CC) for HUD display
        ...(effects.length > 0 && { character: { effects } }),
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

  // ── Status effect serialization & tick processing ─────────────────────────

  /**
   * Serialize an entity's active buffs + CC states into the StatusEffect[]
   * format expected by the client HUD (character.effects in state_update).
   */
  private serializeEffectsForEntity(entityId: string): Array<{ id: string; name: string; duration: number; type?: 'buff' | 'debuff' }> {
    const now = Date.now();
    const effects: Array<{ id: string; name: string; duration: number; type?: 'buff' | 'debuff' }> = [];

    // Active buffs from CombatManager
    const buffs = this.combatManager.getBuffs(entityId);
    for (const b of buffs) {
      if (b.expiresAt <= now) continue;
      effects.push({
        id: b.id,
        name: DistributedWorldManager.buffDisplayName(b.id),
        duration: Math.max(0, Math.ceil((b.expiresAt - now) / 1000)),
        type: b.tickDamage ? 'debuff' : 'buff',
      });
    }

    // Synthesize CC states (taunt/root) tracked outside activeBuffs
    const cc = this.combatManager.getCCState(entityId);
    if (cc.tauntExpiresAt) {
      effects.push({
        id: 'taunted',
        name: 'Taunted',
        duration: Math.max(0, Math.ceil((cc.tauntExpiresAt - now) / 1000)),
        type: 'debuff',
      });
    }
    if (cc.rootExpiresAt) {
      effects.push({
        id: 'rooted',
        name: 'Rooted',
        duration: Math.max(0, Math.ceil((cc.rootExpiresAt - now) / 1000)),
        type: 'debuff',
      });
    }

    return effects;
  }

  private static buffDisplayName(buffId: string): string {
    return buffId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  /**
   * Process DoT/HoT buff ticks — apply damage or healing and broadcast events.
   */
  private async processBuffTicks(ticks: Array<{ entityId: string; buff: ActiveBuff }>): Promise<void> {
    for (const { entityId, buff } of ticks) {
      // Find which zone this entity is in
      const zoneId = this.characterToZone.get(entityId) ?? this.findZoneForEntity(entityId);
      if (!zoneId) continue;
      const zoneManager = this.zones.get(zoneId);
      if (!zoneManager) continue;
      const entity = zoneManager.getEntity(entityId);
      if (!entity || !entity.isAlive) continue;

      const entityName = entity.name ?? entityId;
      const now = Date.now();

      // ── DoT tick ──
      if (buff.tickDamage) {
        const currentHp = entity.health?.current ?? 0;
        const maxHp = entity.health?.max ?? 1;
        const newHp = Math.max(0, currentHp - buff.tickDamage.amount);
        zoneManager.setEntityHealth(entityId, newHp, maxHp);

        // DoT ticks generate threat from the original caster
        if (entity.type === 'mob' || entity.type === 'wildlife') {
          this.combatManager.generateDamageThreat(entityId, buff.sourceId, buff.tickDamage.amount);
        }

        await this.broadcastEntityHealthUpdate(zoneManager, entity.position, entityId, {
          current: newHp,
          max: maxHp,
        });

        // Send resource update to player if applicable
        const socketId = zoneManager.getSocketIdForCharacter(entityId);
        if (socketId) {
          await this.sendCharacterResourcesUpdate(zoneManager, entityId, {
            health: { current: newHp, max: maxHp },
          });
        }

        await this.broadcastCombatEvent(zoneId, entity.position, {
          eventType: 'combat_dot',
          timestamp: now,
          narrative: `${entityName} takes ${buff.tickDamage.amount} ${buff.tickDamage.type} damage from ${DistributedWorldManager.buffDisplayName(buff.id)}.`,
          eventTypeData: {
            targetId: entityId,
            sourceId: buff.sourceId,
            abilityId: buff.id,
            amount: buff.tickDamage.amount,
            damageType: buff.tickDamage.type,
            floatText: `-${buff.tickDamage.amount}`,
          },
        });
      }

      // ── HoT tick ──
      if (buff.tickHeal) {
        const currentHp = entity.health?.current ?? 0;
        const maxHp = entity.health?.max ?? 1;
        const healAmount = Math.min(buff.tickHeal, maxHp - currentHp);
        if (healAmount > 0) {
          const newHp = currentHp + healAmount;
          zoneManager.setEntityHealth(entityId, newHp, maxHp);

          await this.broadcastEntityHealthUpdate(zoneManager, entity.position, entityId, {
            current: newHp,
            max: maxHp,
          });

          const socketId = zoneManager.getSocketIdForCharacter(entityId);
          if (socketId) {
            await this.sendCharacterResourcesUpdate(zoneManager, entityId, {
              health: { current: newHp, max: maxHp },
            });
          }

          await this.broadcastCombatEvent(zoneId, entity.position, {
            eventType: 'combat_hot',
            timestamp: now,
            narrative: `${entityName} heals for ${healAmount} from ${DistributedWorldManager.buffDisplayName(buff.id)}.`,
            eventTypeData: {
              targetId: entityId,
              sourceId: buff.sourceId,
              abilityId: buff.id,
              amount: healAmount,
              floatText: `+${healAmount}`,
            },
          });
        }
      }
    }
  }

  /**
   * Broadcast buff expiry events so clients can clean up HUD badges immediately.
   */
  private async broadcastBuffExpiries(expiries: Array<{ entityId: string; buff: ActiveBuff }>): Promise<void> {
    for (const { entityId, buff } of expiries) {
      const zoneId = this.characterToZone.get(entityId) ?? this.findZoneForEntity(entityId);
      if (!zoneId) continue;
      const zoneManager = this.zones.get(zoneId);
      if (!zoneManager) continue;
      const entity = zoneManager.getEntity(entityId);
      if (!entity) continue;

      const entityName = entity.name ?? entityId;

      await this.broadcastCombatEvent(zoneId, entity.position, {
        eventType: 'combat_effect',
        timestamp: Date.now(),
        narrative: `${DistributedWorldManager.buffDisplayName(buff.id)} fades from ${entityName}.`,
        eventTypeData: {
          targetId: entityId,
          abilityId: buff.id,
          effectType: 'buff_expire',
        },
      });
    }
  }

  // ── Enmity list ────────────────────────────────────────────────────────────

  /**
   * Build the enmity list for a player: all mobs involved with this player
   * or their allies, classified by threat level.
   *
   *   Red    – mob is auto-attacking this player (top enmity)
   *   Yellow – mob is auto-attacking player's companion or party member
   *   Blue   – player is attacking this mob, but mob is focused elsewhere
   */
  private buildEnmityList(
    playerId: string,
    zoneId: string,
    zoneManager: ZoneManager,
  ): Array<{ entityId: string; name: string; level: 'red' | 'yellow' | 'blue' }> {
    const playerEntity = zoneManager.getEntity(playerId);
    if (!playerEntity) return [];

    // Collect ally IDs (companions + party members) for yellow classification
    const allyIds = new Set<string>();
    for (const [compId, ctrl] of this.npcControllers) {
      if (ctrl.getCompanion().ownerCharacterId === playerId) {
        allyIds.add(compId);
      }
    }
    // Party members — synchronous lookup from cached party state
    // (partyService calls Redis, which is async; to avoid async in a hot path
    //  we pre-cache party membership in a later pass. For now, companions only.)
    // TODO: cache partyMembers set and include here

    // What the player is auto-attacking
    const playerTarget = this.combatManager.getAutoAttackTarget(playerId);
    const enmity = this.combatManager.getEnmityTable();

    // Scan nearby entities for mobs/wildlife in combat
    const nearby = zoneManager.getEntitiesInRangeForCombat(playerEntity.position, 30, playerId);
    const entries: Array<{ entityId: string; name: string; level: 'red' | 'yellow' | 'blue' }> = [];
    const seen = new Set<string>();

    for (const entity of nearby) {
      if (entity.type !== 'mob' && entity.type !== 'wildlife') continue;
      if (!entity.isAlive) continue;
      if (!this.combatManager.isInCombat(entity.id)) continue;
      if (seen.has(entity.id)) continue;

      const mobTarget = this.combatManager.getAutoAttackTarget(entity.id);
      const topThreat = enmity.getTopThreat(entity.id);

      if (mobTarget === playerId || topThreat?.entityId === playerId) {
        // Red — mob is targeting this player or player is top threat
        entries.push({ entityId: entity.id, name: entity.name, level: 'red' });
        seen.add(entity.id);
      } else if (
        (mobTarget && allyIds.has(mobTarget)) ||
        (topThreat && allyIds.has(topThreat.entityId))
      ) {
        // Yellow — mob is targeting or top-threatening player's companion/party member
        entries.push({ entityId: entity.id, name: entity.name, level: 'yellow' });
        seen.add(entity.id);
      } else if (enmity.getThreat(entity.id, playerId) > 0 || playerTarget === entity.id) {
        // Blue — player has threat on this mob but isn't top, or is attacking it
        entries.push({ entityId: entity.id, name: entity.name, level: 'blue' });
        seen.add(entity.id);
      }
      // else: mob in combat but not involved with this player — skip
    }

    // Also check if any mob outside the nearby scan is targeting this player
    // (covers edge cases where mob is >30m but still auto-attacking)
    const attackersOfPlayer = this.combatManager.getAttackersOf(playerId);
    for (const attackerId of attackersOfPlayer) {
      if (seen.has(attackerId)) continue;
      const entity = zoneManager.getEntity(attackerId);
      if (!entity || !entity.isAlive) continue;
      if (entity.type !== 'mob' && entity.type !== 'wildlife') continue;
      entries.push({ entityId: entity.id, name: entity.name, level: 'red' });
      seen.add(entity.id);
    }

    // Sort: red first, then yellow, then blue
    const order = { red: 0, yellow: 1, blue: 2 };
    entries.sort((a, b) => order[a.level] - order[b.level]);

    return entries;
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

      // Clear auto-attack if target is more than 100m away
      {
        const tdx = targetEntity.position.x - attackerEntity.position.x;
        const tdz = targetEntity.position.z - attackerEntity.position.z;
        if (Math.sqrt(tdx * tdx + tdz * tdz) > 100) {
          this.combatManager.clearAutoAttackTarget(attackerId);
          // Only notify players — companion/mob range drops are silent
          if (attackerEntity.type === 'player') {
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
                    reason: 'target_out_of_range',
                    narrative: 'Your target is too far away.',
                    timestamp: Date.now(),
                  },
                },
                timestamp: Date.now(),
              });
            }
          }
          continue;
        }
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
   * Handle position updates from movement system — queue only, no flush.
   *
   * Updates zone-manager positions immediately (synchronous), then queues
   * entity snapshots into movementQueue.  The actual broadcast happens later
   * in _flushMovementQueue() which runs once per tick after ALL movement
   * sources (player, mob, physics) have contributed their snapshots.
   */
  private handleMovementUpdates(updates: Map<string, Vector3>): void {
    for (const [characterId, position] of updates) {
      const zoneId = this.characterToZone.get(characterId);
      if (!zoneId) continue;

      const zoneManager = this.zones.get(zoneId);
      if (!zoneManager) continue;

      // Update zone-manager position immediately (combat/AI needs this now).
      zoneManager.updatePlayerPosition(characterId, position);

      // Snapshot into the broadcast queue.
      this._queueEntityBroadcast(characterId, zoneId, position);
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

    // Remove any stale queued snapshot so the next flush doesn't overwrite
    // this authoritative final position with an outdated mid-movement frame.
    this.movementQueue.get(zoneId)?.delete(characterId);

    // Broadcast final position update with idle animation state (immediate)
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

  // ══════════════════════════════════════════════════════════════════════════
  // Companion Combat AI Tick
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Tick all companion combat controllers.
   *
   * For each companion currently in combat (or near hostile entities),
   * runs the behavior tree and applies movement + ability outputs.
   */
  private async tickCompanionCombat(deltaTime: number): Promise<void> {
    for (const [companionId, controller] of this.npcControllers) {
      const zoneId = this.companionToZone.get(companionId);
      if (!zoneId) continue;

      const zm = this.zones.get(zoneId);
      if (!zm) continue;

      const companionEntity = zm.getEntity(companionId);
      if (!companionEntity || !companionEntity.isAlive) continue;

      // Detect hostile entities nearby
      const nearbyEntities = zm.getEntitiesInRangeForCombat(companionEntity.position, 30, companionId);
      const hostiles = nearbyEntities.filter(e =>
        e.isAlive && (e.type === 'mob' || (e.faction === 'hostile'))
      );

      // ── Build attacker set for defensive mode ──────────────────────────
      const ownerCharId = controller.getCompanion().ownerCharacterId;
      const attackerIds = new Set<string>();
      if (ownerCharId) {
        for (const id of this.combatManager.getAttackersOf(ownerCharId)) attackerIds.add(id);
      }
      for (const id of this.combatManager.getAttackersOf(companionId)) attackerIds.add(id);
      controller.setAttackerIds(attackerIds);

      // ── Engagement gate (3-state: aggressive / defensive / passive) ──
      if (!controller.inCombat) {
        if (hostiles.length > 0) {
          // Filter through engagement rules
          const engageable: typeof hostiles = [];
          for (const enemy of hostiles) {
            const shouldFight = controller.shouldEngage(
              { id: enemy.id, name: enemy.name, family: enemy.family, species: enemy.species, level: enemy.level },
            );
            if (shouldFight) engageable.push(enemy);
          }

          if (engageable.length > 0) {
            controller.enterCombat();
            this.combatManager.startCombat(companionId, Date.now());
            zm.setEntityCombatState(companionId, true);
          }
        }
      } else if (hostiles.length === 0) {
        // No enemies left — exit combat
        controller.exitCombat();
        zm.setEntityCombatState(companionId, false);
        // Send final status update so HUD reflects idle state
        this._broadcastCompanionStatus(companionId, companionEntity, controller);
        continue;
      }

      if (!controller.inCombat) continue;

      // Filter enemies to only those the companion should fight (re-check for new mobs)
      const engagedEnemies = hostiles.filter(e =>
        controller.shouldEngage({ id: e.id, name: e.name, family: e.family, species: e.species, level: e.level }),
      );

      // Build combat context for the behavior tree
      const combatContext = this.buildCompanionCombatContext(
        companionId, companionEntity, zm, engagedEnemies, nearbyEntities,
      );

      // Tick the behavior tree
      const result = await controller.updateCombat(combatContext, deltaTime);

      // Ensure auto-attack is set on the engagement target so the companion
      // deals weapon damage even if its abilities are all ally-targeted (healer).
      const engagementTarget = controller.getCurrentTargetId();
      if (engagementTarget && !this.combatManager.hasAutoAttackTarget(companionId)) {
        this.combatManager.setAutoAttackTarget(companionId, engagementTarget);
      }

      // Apply movement intent — compute step from heading+speed, steer around buildings, wall-resolve
      if (result.movement) {
        const physics = zm.getPhysicsSystem();
        const step = result.movement.speed * deltaTime;
        let heading = result.movement.heading;
        if (heading < 0) heading += 360;
        const steered = physics.steerAroundWalls(companionEntity.position, heading, 4.0, 0.5);
        const finalHeading = (steered !== null && steered !== heading) ? steered : heading;
        const rad = (finalHeading * Math.PI) / 180;
        const newPos = {
          x: companionEntity.position.x + Math.sin(rad) * step,
          y: companionEntity.position.y,
          z: companionEntity.position.z + Math.cos(rad) * step,
        };
        const wallResolved = physics.resolveAgainstStructures(newPos, 0.5);
        const snapped = zm.updateCompanionPosition(companionId, wallResolved, finalHeading);
        // movementDuration spans ~3 ticks so the client interpolates smoothly
        // instead of restarting mid-lerp every tick.
        void this.broadcastPositionUpdate(companionId, zoneId, snapped, result.movement.speed, 150);
      }

      // Apply ability action output
      if (result.abilityAction) {
        const abilityDef = controller.getAbilities().find(a => a.id === result.abilityAction!.abilityId);
        if (abilityDef) {
          controller.recordAbilityUse(abilityDef.id, abilityDef.name);
        }
        void this.executeCompanionAbility(
          companionId, zoneId, result.abilityAction.abilityId, result.abilityAction.targetId, controller,
        );
      }

      // ── Companion status broadcast (throttled ~1s or on state change) ──
      this._broadcastCompanionStatus(companionId, companionEntity, controller);
    }
  }

  /**
   * Send a lightweight companion_status event to the owner, throttled to ~1s
   * or immediately on behavior state change.
   */
  private _broadcastCompanionStatus(
    companionId: string,
    entity: {
      currentHealth?: number; maxHealth?: number; isAlive?: boolean;
      currentMana?: number; maxMana?: number;
      currentStamina?: number; maxStamina?: number;
    },
    controller: NPCAIController,
  ): void {
    const now = Date.now();
    const behaviorState = controller.getBehaviorTreeState();
    const prev = this._companionStatusLastSent.get(companionId);
    const stateChanged = !prev || prev.state !== behaviorState;

    if (!stateChanged && prev && now - prev.time < 1000) return;

    this._companionStatusLastSent.set(companionId, { time: now, state: behaviorState });

    const ownerCharId = controller.getCompanion().ownerCharacterId;
    const socketId = this._charToSocket.get(ownerCharId);
    if (!socketId) return;

    const settings = controller.getCurrentSettings();
    const lastAbility = controller.lastAbilityUsed;
    const payload = {
      companionId,
      currentHealth:  entity.currentHealth ?? 0,
      maxHealth:      entity.maxHealth ?? 0,
      currentMana:    entity.currentMana ?? 0,
      maxMana:        entity.maxMana ?? 0,
      currentStamina: entity.currentStamina ?? 0,
      maxStamina:     entity.maxStamina ?? 0,
      isAlive:        entity.isAlive ?? true,
      behaviorState,
      engagementMode: settings.engagementMode,
      llmPending:     controller.llmPending,
      lastAbility:    lastAbility ? {
        abilityId:   lastAbility.abilityId,
        abilityName: lastAbility.abilityName,
        timestamp:   lastAbility.timestamp,
      } : null,
    };

    void this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId: ownerCharId,
      socketId,
      payload: { socketId, event: 'companion_status', data: payload },
      timestamp: now,
    });
  }

  /**
   * Build the CombatContext for a companion's behavior tree tick.
   */
  private buildCompanionCombatContext(
    companionId: string,
    companionEntity: ReturnType<ZoneManager['getEntity']> & {},
    zm: ZoneManager,
    enemies: ReturnType<ZoneManager['getEntitiesInRangeForCombat']>,
    allNearby: ReturnType<ZoneManager['getEntitiesInRangeForCombat']>,
  ) {
    const controller = this.npcControllers.get(companionId)!;

    // Find the owner — must be the actual owner, not just any nearby player
    const ownerCharId = controller.getCompanion().ownerCharacterId;
    const ownerEntity = ownerCharId
      ? (allNearby.find(e => e.id === ownerCharId && e.isAlive) ?? null)
      : null;

    // Find allies (other companions + players)
    const allies = allNearby.filter(e =>
      e.isAlive && e.id !== companionId && (e.type === 'player' || e.type === 'companion')
    );

    // Map enemies to CombatEntity format
    const mappedEnemies = enemies.map(e => ({
      id: e.id,
      name: e.name,
      type: e.type as 'mob' | 'wildlife',
      position: e.position,
      isAlive: e.isAlive,
      inCombat: e.inCombat,
      currentHealth: e.currentHealth,
      maxHealth: e.maxHealth,
      level: e.level,
      tag: e.tag,
      family: e.family,
      species: e.species,
      faction: e.faction,
    }));

    const mappedAllies = allies.map(e => ({
      id: e.id,
      name: e.name,
      type: e.type as 'player' | 'companion',
      position: e.position,
      isAlive: e.isAlive,
      inCombat: e.inCombat,
      currentHealth: e.currentHealth,
      maxHealth: e.maxHealth,
    }));

    const mappedOwner = ownerEntity ? {
      id: ownerEntity.id,
      name: ownerEntity.name,
      type: 'player' as const,
      position: ownerEntity.position,
      isAlive: ownerEntity.isAlive,
      inCombat: ownerEntity.inCombat,
      currentHealth: ownerEntity.currentHealth,
      maxHealth: ownerEntity.maxHealth,
    } : null;

    // Get cooldown state from CombatManager
    const now = Date.now();
    const abilities = controller.getAbilities();
    const cooldowns = new Map<string, number>();
    for (const ability of abilities) {
      const remaining = this.combatManager.getCooldownRemaining(companionId, ability.id, now);
      if (remaining > 0) cooldowns.set(ability.id, remaining);
    }

    const combatState = this.combatManager.getCombatState(companionId);
    const atbCurrent = combatState?.atb.current ?? 0;

    return {
      self: {
        id: companionId,
        position: companionEntity.position,
        currentHealth: companionEntity.currentHealth ?? 100,
        maxHealth: companionEntity.maxHealth ?? 100,
      },
      owner: mappedOwner,
      enemies: mappedEnemies,
      allies: mappedAllies,
      abilities,
      cooldowns,
      atbCurrent,
      hasAutoAttackTarget: this.combatManager.hasAutoAttackTarget(companionId),
      currentMana: companionEntity.currentMana ?? 0,
      maxMana: companionEntity.maxMana ?? 0,
      currentStamina: companionEntity.currentStamina ?? 0,
      maxStamina: companionEntity.maxStamina ?? 0,
      enmityTable: this.combatManager.getEnmityTable(),
    };
  }

  /**
   * Execute a companion's chosen ability against a target.
   * Validates ATB, cooldowns, range — then queues or executes.
   */
  private async executeCompanionAbility(
    companionId: string,
    zoneId: string,
    abilityId: string,
    targetId: string,
    _controller: NPCAIController,
  ): Promise<void> {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const companionEntity = zoneManager.getEntity(companionId);
    const targetEntity = zoneManager.getEntity(targetId);
    if (!companionEntity?.isAlive || !targetEntity?.isAlive) return;

    // Resolve the ability through AbilitySystem (same path as player abilities)
    const ability = await this.abilitySystem.getAbility(abilityId);
    if (!ability) return;

    // Set auto-attack target if not already set (before executeCombatAction
    // so companion enters melee loop even if the ability itself is ranged)
    if (ability.targetType !== 'ally' && !this.combatManager.hasAutoAttackTarget(companionId)) {
      this.combatManager.setAutoAttackTarget(companionId, targetId);
    }

    // Delegate to the full combat pipeline (handles ATB, cooldown, range,
    // damage calc, narrative broadcast, death processing, etc.)
    await this.executeCombatAction(
      zoneManager,
      { id: companionEntity.id, position: companionEntity.position, type: companionEntity.type as 'companion' },
      { id: targetEntity.id,   position: targetEntity.position,   type: targetEntity.type as 'player' | 'npc' | 'companion' | 'mob' | 'wildlife' },
      ability,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Companion Behavior (TASKED + ACTIVE modes)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Tick companion behavior trees (TASKED) and follow logic (ACTIVE).
   * Called every game tick right after tickCompanionCombat.
   */
  private async tickCompanionBehavior(deltaTime: number): Promise<void> {
    const now = Date.now();

    for (const [companionId, controller] of this.npcControllers) {
      // Skip companions currently in combat (combat BT takes priority)
      if (controller.inCombat) continue;

      const zoneId = this.companionToZone.get(companionId);
      if (!zoneId) continue;

      const zm = this.zones.get(zoneId);
      if (!zm) continue;

      const companionEntity = zm.getEntity(companionId);
      if (!companionEntity || !companionEntity.isAlive) continue;

      const companion = controller.getCompanion();
      const state = companion.behaviorState ?? 'detached';

      if (state === 'tasked') {
        await this.tickCompanionTask(companionId, companionEntity, zm, zoneId, now);
      } else if (state === 'active') {
        await this.tickCompanionFollow(companionId, companionEntity, zm, zoneId, deltaTime);
      }
      // 'detached' — do nothing
    }
  }

  /**
   * Tick a TASKED companion's behavior tree.
   */
  private async tickCompanionTask(
    companionId: string,
    companionEntity: ReturnType<ZoneManager['getEntity']> & {},
    zm: ZoneManager,
    zoneId: string,
    now: number,
  ): Promise<void> {
    const executor = this.companionBehaviorExecutors.get(companionId);
    if (!executor) {
      // No executor → reset to detached
      await CompanionService.updateBehaviorState(companionId, {
        behaviorState: 'detached',
        behaviorTree: null,
        taskDescription: null,
      });
      return;
    }

    // Build condition context for the tree
    const flora = this.floraManagers.get(zoneId);
    const nearbyPlants: PlantInfo[] = flora
      ? flora.getHarvestablePlantsInRange(companionEntity.position, 50)
      : [];

    const ctx: ConditionContext = {
      companionId,
      position: companionEntity.position,
      zoneId,
      nearbyPlants,
      inventoryItemCount: 0, // TODO: wire companion inventory
      inventoryCapacity: 20,
      healthRatio: (companionEntity.maxHealth ?? 100) > 0
        ? (companionEntity.currentHealth ?? 100) / (companionEntity.maxHealth ?? 100)
        : 1,
    };

    const result = executor.tick(ctx, now);

    // Process action output
    if (result.action) {
      await this.executeCompanionBehaviorAction(companionId, companionEntity, zm, zoneId, result.action, ctx);
    }

    // Check for completion
    if (result.status === 'success') {
      logger.info({ companionId }, '[CompanionBehavior] Task completed successfully');
      this.companionBehaviorExecutors.delete(companionId);
      await CompanionService.updateBehaviorState(companionId, {
        behaviorState: 'detached',
        behaviorTree: null,
        taskDescription: null,
      });
    } else if (result.status === 'failure') {
      logger.info({ companionId }, '[CompanionBehavior] Task failed');
      this.companionBehaviorExecutors.delete(companionId);
      await CompanionService.updateBehaviorState(companionId, {
        behaviorState: 'detached',
        behaviorTree: null,
        taskDescription: null,
      });
    }
  }

  /**
   * Execute a behavior tree action output (e.g. /harvest, /move).
   */
  private async executeCompanionBehaviorAction(
    companionId: string,
    companionEntity: ReturnType<ZoneManager['getEntity']> & {},
    zm: ZoneManager,
    zoneId: string,
    action: BehaviorAction,
    ctx: ConditionContext,
  ): Promise<void> {
    switch (action.command) {
      case '/harvest': {
        // Find nearest harvestable plant and harvest it
        const flora = this.floraManagers.get(zoneId);
        if (!flora) break;

        const plants = flora.getHarvestablePlantsInRange(companionEntity.position, 10);
        if (plants.length === 0) break;

        const nearest = plants[0]; // Already sorted by distance
        const items = flora.harvest(nearest.id, companionId);
        if (items && items.length > 0) {
          const totalItems = items.reduce((sum, i) => sum + i.quantity, 0);
          await CompanionService.updateBehaviorState(companionId, {
            harvestsCompleted: { increment: 1 },
            itemsGathered: { increment: totalItems },
            lastHarvestAt: new Date(),
          });
          logger.debug({ companionId, plantId: nearest.id, items }, '[CompanionBehavior] Harvest completed');
        }
        break;
      }

      case '/move': {
        // Move toward target — for now, move toward nearest harvestable plant
        const target = action.args?.target as string | undefined;
        let targetPos: { x: number; y: number; z: number } | null = null;

        if (target === 'nearestHarvestablePlant' && ctx.nearbyPlants.length > 0) {
          targetPos = ctx.nearbyPlants[0].position;
        }

        if (targetPos) {
          const dx = targetPos.x - companionEntity.position.x;
          const dz = targetPos.z - companionEntity.position.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist > 1.5) {
            const speed = 5.0 * 0.05; // 5 m/s * ~50ms tick (walk pace for autonomous tasks)
            const step = Math.min(speed, dist);
            const physics = zm.getPhysicsSystem();

            // Steer around buildings
            let heading = Math.atan2(dx / dist, dz / dist) * (180 / Math.PI);
            if (heading < 0) heading += 360;
            const steered = physics.steerAroundWalls(companionEntity.position, heading, 4.0, 0.5);
            if (steered !== null) heading = steered;

            const rad = (heading * Math.PI) / 180;
            const newPos = {
              x: companionEntity.position.x + Math.sin(rad) * step,
              y: companionEntity.position.y,
              z: companionEntity.position.z + Math.cos(rad) * step,
            };
            const resolved = physics.resolveAgainstStructures(newPos, 0.5);
            const snapped = zm.updateCompanionPosition(companionId, resolved, heading);
            void this.broadcastPositionUpdate(companionId, zoneId, snapped, 5.0, 75);
          }
        }
        break;
      }

      case '/tell': {
        const message = action.args?.message as string | undefined;
        if (message) {
          logger.info({ companionId, message }, '[CompanionBehavior] Companion says');
          // TODO: broadcast as NPC chat message
        }
        break;
      }

      case '/stop': {
        // Stop current task
        this.companionBehaviorExecutors.delete(companionId);
        await CompanionService.updateBehaviorState(companionId, {
          behaviorState: 'detached',
          behaviorTree: null,
          taskDescription: null,
        });
        break;
      }
    }
  }

  /**
   * Tick ACTIVE companion — follow the owner.
   */
  private async tickCompanionFollow(
    companionId: string,
    companionEntity: ReturnType<ZoneManager['getEntity']> & {},
    zm: ZoneManager,
    zoneId: string,
    deltaTime: number,
  ): Promise<void> {
    const controller = this.npcControllers.get(companionId);
    if (!controller) return;

    const companion = controller.getCompanion();
    const ownerCharId = companion.ownerCharacterId;

    // Find owner entity — only follow the actual owner, never another player
    if (!ownerCharId) return;
    const ownerEntity = zm.getEntity(ownerCharId);
    if (!ownerEntity || !ownerEntity.isAlive) return;

    const dx = ownerEntity.position.x - companionEntity.position.x;
    const dz = ownerEntity.position.z - companionEntity.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist > 5.0) {
      // Slightly faster than owner so the companion catches up instead of drifting behind
      const ownerSpeed = this.movementSystem.getMovementSpeed(ownerCharId) ?? 5.0;
      const speed = ownerSpeed * 1.15; // +15% to close gaps
      const step = Math.min(speed * deltaTime, dist);
      const physics = zm.getPhysicsSystem();

      // Steer around buildings
      let heading = Math.atan2(dx / dist, dz / dist) * (180 / Math.PI);
      if (heading < 0) heading += 360;
      const steered = physics.steerAroundWalls(companionEntity.position, heading, 4.0, 0.5);
      if (steered !== null) heading = steered;

      const rad = (heading * Math.PI) / 180;
      const newPos = {
        x: companionEntity.position.x + Math.sin(rad) * step,
        y: companionEntity.position.y,
        z: companionEntity.position.z + Math.cos(rad) * step,
      };
      const resolved = physics.resolveAgainstStructures(newPos, 0.5);
      const snapped = zm.updateCompanionPosition(companionId, resolved, heading);
      void this.broadcastPositionUpdate(companionId, zoneId, snapped, speed, 150);
    }
  }

  // ── Companion command handlers ────────────────────────────────────────────

  /** Sync in-memory controller state after a DB write. */
  private patchControllerState(companionId: string, fields: Partial<Companion>): void {
    const controller = this.npcControllers.get(companionId);
    if (controller) controller.patchCompanion(fields);
  }

  /**
   * Find the player's companion. Returns the first companion owned by this
   * character, or the first NPC companion in the character's zone as fallback.
   */
  private async findPlayerCompanion(characterId: string): Promise<{ companion: Companion; zoneId: string } | null> {
    const owned = await CompanionService.findByOwnerCharacter(characterId);
    if (owned) {
      const zoneId = this.companionToZone.get(owned.id);
      if (zoneId) return { companion: owned, zoneId };
    }

    return null;
  }

  private async processCompanionStatus(characterId: string): Promise<{ success: boolean; message?: string; data?: unknown }> {
    const found = await this.findPlayerCompanion(characterId);
    if (!found) return { success: false, message: 'No companion found.' };

    const { companion } = found;
    const state = companion.behaviorState ?? 'detached';
    const parts = [
      `${companion.name} — Mode: ${state.toUpperCase()}`,
    ];
    if (companion.taskDescription) parts.push(`Task: ${companion.taskDescription}`);
    parts.push(`Harvests: ${companion.harvestsCompleted}, Items gathered: ${companion.itemsGathered}`);

    return {
      success: true,
      message: parts.join('\n'),
      data: {
        companionId: companion.id,
        name: companion.name,
        behaviorState: state,
        taskDescription: companion.taskDescription,
        harvestsCompleted: companion.harvestsCompleted,
        itemsGathered: companion.itemsGathered,
      },
    };
  }

  private async processCompanionFollow(characterId: string): Promise<void> {
    const found = await this.findPlayerCompanion(characterId);
    if (!found) return;

    const { companion } = found;
    this.companionBehaviorExecutors.delete(companion.id);
    await CompanionService.updateBehaviorState(companion.id, {
      behaviorState: 'active',
      behaviorTree: null,
      taskDescription: null,
    });
    this.patchControllerState(companion.id, { behaviorState: 'active', behaviorTree: null, taskDescription: null, ownerCharacterId: characterId });
    logger.info({ companionId: companion.id, characterId }, '[CompanionCommand] Follow');
  }

  private async processCompanionDetach(characterId: string): Promise<void> {
    const found = await this.findPlayerCompanion(characterId);
    if (!found) return;

    const { companion } = found;
    this.companionBehaviorExecutors.delete(companion.id);
    await CompanionService.updateBehaviorState(companion.id, {
      behaviorState: 'detached',
      behaviorTree: null,
      taskDescription: null,
    });
    this.patchControllerState(companion.id, { behaviorState: 'detached', behaviorTree: null, taskDescription: null });
    logger.info({ companionId: companion.id, characterId }, '[CompanionCommand] Detach');
  }

  private async processCompanionTask(
    characterId: string,
    description: string,
  ): Promise<{ success: boolean; message?: string }> {
    const found = await this.findPlayerCompanion(characterId);
    if (!found) return { success: false, message: 'No companion found.' };

    const { companion } = found;
    const result = await this.companionTaskService.generateTaskTree(companion, description, this.llmService);

    if (!result.tree) {
      return { success: false, message: result.rejection };
    }

    // Store tree and enter TASKED mode
    const taskAssignedAt = new Date();
    this.companionBehaviorExecutors.set(companion.id, new BehaviorTreeExecutor(result.tree));
    await CompanionService.updateBehaviorState(companion.id, {
      behaviorState: 'tasked',
      behaviorTree: result.tree as unknown as Prisma.InputJsonValue,
      taskDescription: description,
      taskAssignedAt,
    });
    this.patchControllerState(companion.id, { behaviorState: 'tasked', taskDescription: description, taskAssignedAt, ownerCharacterId: characterId });

    logger.info({ companionId: companion.id, description }, '[CompanionCommand] Task assigned');
    return { success: true, message: `${companion.name} is working on: "${description}"` };
  }

  private async processCompanionHarvest(
    characterId: string,
  ): Promise<{ success: boolean; message?: string }> {
    const found = await this.findPlayerCompanion(characterId);
    if (!found) return { success: false, message: 'No companion found.' };

    const { companion } = found;

    // Assign default harvest tree (no LLM call)
    const taskAssignedAt = new Date();
    this.companionBehaviorExecutors.set(companion.id, new BehaviorTreeExecutor(DEFAULT_HARVEST_TREE));
    await CompanionService.updateBehaviorState(companion.id, {
      behaviorState: 'tasked',
      behaviorTree: DEFAULT_HARVEST_TREE as unknown as Prisma.InputJsonValue,
      taskDescription: 'Harvesting nearby plants',
      taskAssignedAt,
    });
    this.patchControllerState(companion.id, { behaviorState: 'tasked', taskDescription: 'Harvesting nearby plants', taskAssignedAt, ownerCharacterId: characterId });

    logger.info({ companionId: companion.id }, '[CompanionCommand] Harvest assigned');
    return { success: true, message: `${companion.name} begins harvesting nearby plants.` };
  }

  private async processCompanionRecall(characterId: string): Promise<void> {
    const found = await this.findPlayerCompanion(characterId);
    if (!found) return;

    const { companion } = found;
    this.companionBehaviorExecutors.delete(companion.id);
    await CompanionService.updateBehaviorState(companion.id, {
      behaviorState: 'active',
      behaviorTree: null,
      taskDescription: null,
    });
    this.patchControllerState(companion.id, { behaviorState: 'active', behaviorTree: null, taskDescription: null, ownerCharacterId: characterId });
    logger.info({ companionId: companion.id, characterId }, '[CompanionCommand] Recall');
  }

  private async processCompanionReport(
    characterId: string,
  ): Promise<{ success: boolean; message?: string }> {
    const found = await this.findPlayerCompanion(characterId);
    if (!found) return { success: false, message: 'No companion found.' };

    const { companion } = found;
    const state = companion.behaviorState ?? 'detached';
    // Simple report — LLM-based report deferred to later iteration
    const report = [
      `${companion.name} reporting.`,
      `Current mode: ${state.toUpperCase()}.`,
      `Harvests completed: ${companion.harvestsCompleted}.`,
      `Items gathered: ${companion.itemsGathered}.`,
    ];
    if (companion.taskDescription) {
      report.push(`Current task: ${companion.taskDescription}.`);
    }

    return { success: true, message: report.join(' ') };
  }

  // ── Companion management (manual / non-LLM) ─────────────────────────────

  private async processCompanionSetArchetype(
    characterId: string,
    archetype: string,
  ): Promise<{ success: boolean; message?: string }> {
    const valid = ['scrappy_fighter', 'cautious_healer', 'opportunist', 'tank'];
    if (!valid.includes(archetype)) {
      return { success: false, message: `Invalid archetype. Choose: ${valid.join(', ')}` };
    }

    const found = await this.findPlayerCompanion(characterId);
    if (!found) return { success: false, message: 'No companion found.' };

    const { companion } = found;
    const baseline = getBaselineForArchetype(archetype);

    // Update DB
    await CompanionService.updateCombatConfig(companion.id, {
      archetype,
      combatSettings: baseline as unknown as Prisma.InputJsonValue,
    });

    // Update in-memory controller
    const controller = this.npcControllers.get(companion.id);
    if (controller) {
      controller.resetToArchetype(archetype);
      controller.patchCompanion({ archetype } as Partial<Companion>);
    }

    this._pushCompanionConfig(characterId, { ...companion, archetype });
    return { success: true, message: `Companion archetype changed to ${archetype}.` };
  }

  private async processCompanionConfigure(
    characterId: string,
    settings: Partial<CompanionCombatSettings>,
  ): Promise<{ success: boolean; message?: string }> {
    const found = await this.findPlayerCompanion(characterId);
    if (!found) return { success: false, message: 'No companion found.' };

    const { companion } = found;
    const controller = this.npcControllers.get(companion.id);
    if (!controller) return { success: false, message: 'Companion AI not active.' };

    const merged = mergePartialSettings(controller.getCurrentSettings(), settings);
    controller.applyManualSettings(merged);

    // Persist
    await CompanionService.updateCombatConfig(companion.id, {
      combatSettings: merged as unknown as Prisma.InputJsonValue,
    });

    this._pushCompanionConfig(characterId, companion);
    return { success: true, message: 'Combat settings updated.' };
  }

  private async processCompanionSetAbilities(
    characterId: string,
    abilityIds: string[],
  ): Promise<{ success: boolean; message?: string }> {
    // Validate against T1 ability list
    const validIds = new Set(T1_ABILITIES.map(a => a.id));
    const invalid = abilityIds.filter(id => !validIds.has(id));
    if (invalid.length > 0) {
      return { success: false, message: `Unknown abilities: ${invalid.join(', ')}` };
    }

    const found = await this.findPlayerCompanion(characterId);
    if (!found) return { success: false, message: 'No companion found.' };

    const { companion } = found;

    // Update DB
    await CompanionService.updateCombatConfig(companion.id, { abilityIds });

    // Update controller
    const controller = this.npcControllers.get(companion.id);
    if (controller) {
      const resolved = T1_ABILITIES.filter(a => abilityIds.includes(a.id));
      controller.setAbilities(resolved);
      controller.patchCompanion({ abilityIds } as Partial<Companion>);
    }

    this._pushCompanionConfig(characterId, { ...companion, abilityIds });
    return { success: true, message: `Companion abilities updated: ${abilityIds.join(', ') || 'none'}.` };
  }

  private async processCompanionGetConfig(
    characterId: string,
  ): Promise<{ success: boolean; message?: string }> {
    const found = await this.findPlayerCompanion(characterId);
    if (!found) return { success: false, message: 'No companion found.' };
    this._pushCompanionConfig(characterId, found.companion);
    return { success: true, message: '' };
  }

  /** Push full companion config to the owning client via the gateway. */
  private _pushCompanionConfig(characterId: string, companion: Companion): void {
    const socketId = this._charToSocket.get(characterId);
    if (!socketId) return;

    const controller = this.npcControllers.get(companion.id);
    const combatSettings = controller?.getCurrentSettings() ?? getBaselineForArchetype(companion.archetype ?? 'opportunist');
    const controllerAbilities = controller?.getAbilities() ?? [];

    // Build the ability manifest: all T1 abilities with enabled flag
    const enabledSet = new Set(companion.abilityIds ?? []);
    const abilities = T1_ABILITIES.map(a => ({
      id:          a.id,
      name:        a.name,
      description: a.description ?? '',
      enabled:     enabledSet.has(a.id),
      tags:        a.tags ?? [],
    }));

    // Look up live entity resources (mana/stamina) from the zone
    const compZoneId = this.companionToZone.get(companion.id);
    const compEntity = compZoneId ? this.zones.get(compZoneId)?.getEntity(companion.id) : null;

    // Compute derived combat stats for client display
    const compCoreStats = (companion.stats as Record<string, number>) || {};
    const coreStats = {
      strength: compCoreStats.strength ?? 10, vitality: compCoreStats.vitality ?? 10,
      dexterity: compCoreStats.dexterity ?? 10, agility: compCoreStats.agility ?? 10,
      intelligence: compCoreStats.intelligence ?? 10, wisdom: compCoreStats.wisdom ?? 10,
    };
    const archetype = (companion.archetype ?? 'opportunist') as import('@/ai/CompanionCombatSettings').CompanionArchetype;
    const derived = StatCalculator.calculateDerivedStats(coreStats, companion.level);
    const archetypeMods = ARCHETYPE_MODIFIERS[archetype]?.statMods ?? {};

    const derivedStats = {
      attackRating:      Math.round(derived.attackRating + (archetypeMods.attackRating ?? 0)),
      defenseRating:     Math.round((derived.defenseRating + (archetypeMods.defenseRating ?? 0)) * 10) / 10,
      magicAttack:       Math.round(derived.magicAttack),
      magicDefense:      Math.round(derived.magicDefense * 10) / 10,
      criticalHitChance: Math.round((derived.criticalHitChance + (archetypeMods.criticalHitChance ?? 0)) * 10) / 10,
      evasion:           Math.round(derived.evasion),
      movementSpeed:     Math.round(derived.movementSpeed * 10) / 10,
      healPotencyMult:   archetypeMods.healPotencyMult ?? 1.0,
      threatMultiplier:  archetypeMods.threatMultiplier ?? 1.0,
    };

    const payload = {
      companionId:       companion.id,
      name:              companion.name,
      level:             companion.level,
      currentHealth:     companion.currentHealth,
      maxHealth:         companion.maxHealth,
      currentMana:       compEntity?.currentMana ?? 0,
      maxMana:           compEntity?.maxMana ?? 0,
      currentStamina:    compEntity?.currentStamina ?? 0,
      maxStamina:        compEntity?.maxStamina ?? 0,
      isAlive:           companion.isAlive,
      archetype:         companion.archetype ?? 'opportunist',
      behaviorState:     companion.behaviorState ?? 'detached',
      taskDescription:   companion.taskDescription ?? null,
      combatSettings,
      abilities,
      harvestsCompleted: companion.harvestsCompleted,
      itemsGathered:     companion.itemsGathered,
      coreStats,
      derivedStats,
      personalityType:   companion.personalityType || null,
      traits:            (companion.traits as string[]) ?? [],
      description:       companion.description || null,
    };

    void this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId,
      socketId,
      payload: { socketId, event: 'companion_config', data: payload },
      timestamp: Date.now(),
    });
  }

  // ── Companion BYOLLM trigger + handler system ──────────────────────────

  /**
   * Build an onTrigger callback for a companion. When the NPCAIController
   * evaluates a trigger condition, this callback assembles the full payload
   * and emits it to the companion owner's socket.
   */
  private _buildCompanionTriggerCallback(
    companion: import('@prisma/client').Companion,
  ): import('@/ai/NPCAIController').OnTriggerCallback {
    return (type, triggerReason, _snapshot) => {
      if (type === 'combat') {
        this._emitCombatTrigger(companion.id, triggerReason as import('@/ai/CompanionCombatTrigger').TriggerReason);
      } else {
        this._emitSocialTrigger(companion.id, triggerReason as 'player_spoke' | 'entity_nearby' | 'zone_change' | 'idle');
      }
    };
  }

  /**
   * Build and emit a companion_combat_trigger to the owner client.
   */
  private _emitCombatTrigger(
    companionId: string,
    triggerReason: import('@/ai/CompanionCombatTrigger').TriggerReason,
  ): void {
    const controller = this.npcControllers.get(companionId);
    if (!controller) return;

    const companion = controller.getCompanion();
    const ownerCharId = companion.ownerCharacterId;
    if (!ownerCharId) return;

    const socketId = this._charToSocket.get(ownerCharId);
    if (!socketId) return;

    const zoneId = this.companionToZone.get(companionId);
    if (!zoneId) return;

    const zm = this.zones.get(zoneId);
    if (!zm) return;

    const companionEntity = zm.getEntity(companionId);
    if (!companionEntity) return;

    // Build the companion context
    const maxHp = companionEntity.maxHealth ?? 100;
    const maxMana = companionEntity.maxMana ?? 0;
    const maxStamina = companionEntity.maxStamina ?? 0;

    // Find owner entity
    const ownerEntity = zm.getEntity(ownerCharId);

    // Get all nearby entities for party/enemy info
    const nearbyEntities = zm.getEntitiesInRangeForCombat(companionEntity.position, 30, companionId);
    const hostiles = nearbyEntities.filter(e => e.isAlive && (e.type === 'mob' || e.faction === 'hostile'));

    // Build party array (allies including owner)
    const partyMembers: Array<{ id: string; name: string; healthRatio: number; role: string }> = [];
    for (const e of nearbyEntities) {
      if (!e.isAlive || e.id === companionId) continue;
      if (e.type === 'player' || e.type === 'companion') {
        partyMembers.push({
          id: e.id,
          name: e.name,
          healthRatio: (e.maxHealth ?? 1) > 0 ? (e.currentHealth ?? 1) / (e.maxHealth ?? 1) : 1,
          role: e.type === 'companion' ? 'companion' : 'player',
        });
      }
    }

    // Build enemy array
    const enemies = hostiles.map(e => ({
      id: e.id,
      name: e.name,
      species: e.species ?? null,
      family: e.family ?? null,
      level: e.level ?? 1,
      healthRatio: (e.maxHealth ?? 1) > 0 ? (e.currentHealth ?? 1) / (e.maxHealth ?? 1) : 1,
      isTaunted: this.combatManager.getAutoAttackTarget(e.id) === companionId,
      isRooted: false, // placeholder — wire when CC status system exists
    }));

    // Build enmity table
    const enmityTable = this.combatManager.getEnmityTable();
    const enmity: Array<{ targetId: string; attackers: string[] }> = [];
    for (const enemy of hostiles) {
      const threatList = enmityTable.getSortedThreats(enemy.id);
      if (threatList.length > 0) {
        enmity.push({
          targetId: enemy.id,
          attackers: threatList.map(t => t.entityId),
        });
      }
    }

    const payload = {
      companionId,
      triggerReason,
      companion: {
        id: companion.id,
        name: companion.name,
        archetype: companion.archetype ?? 'opportunist',
        personalityType: companion.personalityType ?? null,
        currentSettings: controller.getCurrentSettings(),
        healthRatio: maxHp > 0 ? (companionEntity.currentHealth ?? maxHp) / maxHp : 1,
        manaRatio: maxMana > 0 ? (companionEntity.currentMana ?? 0) / maxMana : 0,
        staminaRatio: maxStamina > 0 ? (companionEntity.currentStamina ?? 0) / maxStamina : 0,
      },
      partner: {
        id: ownerCharId,
        name: ownerEntity?.name ?? 'Unknown',
        healthRatio: ownerEntity
          ? ((ownerEntity.maxHealth ?? 1) > 0 ? (ownerEntity.currentHealth ?? 1) / (ownerEntity.maxHealth ?? 1) : 1)
          : 1,
        inCombat: ownerEntity?.inCombat ?? false,
      },
      party: partyMembers,
      enemies,
      enmity,
      fightDurationSec: controller.inCombat
        ? (Date.now() - controller.fightStartTime) / 1000
        : 0,
      playerCommand: null as string | null, // player commands are handled inline
    };

    void this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId: ownerCharId,
      socketId,
      payload: { socketId, event: 'companion_combat_trigger', data: payload },
      timestamp: Date.now(),
    });

    logger.debug({ companionId, triggerReason }, '[BYOLLM] Combat trigger emitted to client');
  }

  /**
   * Build and emit a companion_social_trigger to the owner client.
   */
  private _emitSocialTrigger(
    companionId: string,
    triggerReason: 'player_spoke' | 'entity_nearby' | 'zone_change' | 'idle',
  ): void {
    const controller = this.npcControllers.get(companionId);
    if (!controller) return;

    const companion = controller.getCompanion();
    const ownerCharId = companion.ownerCharacterId;
    if (!ownerCharId) return;

    const socketId = this._charToSocket.get(ownerCharId);
    if (!socketId) return;

    const zoneId = this.companionToZone.get(companionId);
    if (!zoneId) return;

    const zm = this.zones.get(zoneId);
    if (!zm) return;

    // Build zone info
    const zone = zm.getZone();
    const companionEntity = zm.getEntity(companionId);

    // Proximity summary — count nearby entities in each channel range
    const position = companionEntity?.position ?? { x: 0, y: 0, z: 0 };
    const nearbyEntities = zm.getEntitiesInRangeForCombat(position, 30, companionId);
    const players = nearbyEntities.filter(e => e.type === 'player' && e.isAlive);

    const payload = {
      companionId,
      triggerReason,
      companion: {
        id: companion.id,
        name: companion.name,
        archetype: companion.archetype ?? 'opportunist',
        personalityType: companion.personalityType ?? null,
      },
      zone: {
        id: zone.id,
        name: zone.name,
        description: zone.description ?? '',
        contentRating: (zone.contentRating ?? 'T') as 'T' | 'M' | 'AO',
        lighting: zm.getLighting(),
        weather: zm.getWeather(),
      },
      proximitySummary: {
        sayCount: players.length,
        shoutCount: 0, // TODO: wider-range count if needed
        partyCount: 0, // TODO: wire party system
      },
    };

    void this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId: ownerCharId,
      socketId,
      payload: { socketId, event: 'companion_social_trigger', data: payload },
      timestamp: Date.now(),
    });

    logger.debug({ companionId, triggerReason }, '[BYOLLM] Social trigger emitted to client');
  }

  /**
   * Handle incoming companion_settings_update from client (BYOLLM response).
   * Validates shape, applies to companion's behavior tree settings.
   */
  private async handleCompanionSettingsUpdate(message: MessageEnvelope): Promise<void> {
    const characterId = message.characterId;
    if (!characterId) return;

    const payload = message.payload as {
      companionId?: string;
      settings?: Partial<CompanionCombatSettings>;
    };
    if (!payload?.companionId || !payload?.settings) {
      logger.warn({ characterId }, '[BYOLLM] Invalid companion_settings_update payload');
      return;
    }

    // Verify the companion belongs to this character
    const controller = this.npcControllers.get(payload.companionId);
    if (!controller) return;

    const companion = controller.getCompanion();
    if (companion.ownerCharacterId !== characterId) {
      logger.warn({ characterId, companionId: payload.companionId }, '[BYOLLM] Settings update from non-owner');
      return;
    }

    // Apply settings — same path as manual panel settings
    const current = controller.getCurrentSettings();
    const merged = mergePartialSettings(current, payload.settings);
    controller.applyManualSettings(merged);

    logger.info({
      companionId: payload.companionId,
      settingsUpdate: payload.settings,
    }, '[BYOLLM] Combat settings update applied from client LLM');
  }

  /**
   * Handle incoming companion_social_action from client (BYOLLM response).
   * Validates action is plausible, then executes (broadcast chat/emote or move).
   */
  private async handleCompanionSocialAction(message: MessageEnvelope): Promise<void> {
    const characterId = message.characterId;
    if (!characterId) return;

    const payload = message.payload as {
      companionId?: string;
      action?: 'say' | 'emote' | 'move';
      message?: string;
      bearing?: number;
      distance?: number;
    };
    if (!payload?.companionId || !payload?.action) {
      logger.warn({ characterId }, '[BYOLLM] Invalid companion_social_action payload');
      return;
    }

    // Verify ownership
    const controller = this.npcControllers.get(payload.companionId);
    if (!controller) return;

    const companion = controller.getCompanion();
    if (companion.ownerCharacterId !== characterId) {
      logger.warn({ characterId, companionId: payload.companionId }, '[BYOLLM] Social action from non-owner');
      return;
    }

    // Verify companion is alive and in a zone
    const zoneId = this.companionToZone.get(payload.companionId);
    if (!zoneId) return;

    const zm = this.zones.get(zoneId);
    if (!zm) return;

    const companionEntity = zm.getEntity(payload.companionId);
    if (!companionEntity?.isAlive) return;

    // Execute the action
    switch (payload.action) {
      case 'say':
      case 'emote': {
        if (!payload.message) return;
        // Broadcast as companion chat/emote in say range (15m)
        const channel = payload.action === 'say' ? 'say' : 'emote';
        void this.broadcastChatFromCharacter(
          zm, payload.companionId, companion.name,
          companionEntity.position, channel as 'say' | 'emote',
          payload.message, 15,
        );
        break;
      }
      case 'move': {
        // Enqueue a short movement in the given bearing
        if (payload.bearing === undefined) return;
        const distance = Math.min(payload.distance ?? 5, 10); // cap at 10m
        const rad = (payload.bearing * Math.PI) / 180;
        const newPos = {
          x: companionEntity.position.x + Math.sin(rad) * distance,
          y: companionEntity.position.y,
          z: companionEntity.position.z + Math.cos(rad) * distance,
        };
        const physics = zm.getPhysicsSystem();
        const wallResolved = physics.resolveAgainstStructures(newPos, 0.5);
        const snapped = zm.updateCompanionPosition(payload.companionId, wallResolved, payload.bearing);
        void this.broadcastPositionUpdate(payload.companionId, zoneId, snapped, 2.0, 500);
        break;
      }
    }

    logger.debug({
      companionId: payload.companionId,
      action: payload.action,
    }, '[BYOLLM] Social action executed from client LLM');
  }

  // ── Companion loadout handlers ──────────────────────────────────────────

  private async processCompanionViewLoadout(
    characterId: string,
    web: 'active' | 'passive',
  ): Promise<{ success: boolean; message?: string }> {
    const found = await this.findPlayerCompanion(characterId);
    if (!found) return { success: false, message: 'No companion found.' };

    const { companion } = found;
    const loadoutRaw = web === 'active' ? companion.activeLoadout : companion.passiveLoadout;
    const loadout = (loadoutRaw as { slots: (string | null)[] } | null)?.slots ?? Array(8).fill(null);

    // Load owner's unlocked abilities for display
    const ownerState = await loadAbilityState(characterId);
    const unlockedNodes = web === 'active'
      ? (ownerState?.unlocked.activeNodes ?? [])
      : (ownerState?.unlocked.passiveNodes ?? []);

    // Resolve node names for display
    const slots = loadout.map((nodeId: string | null, idx: number) => {
      if (!nodeId) return { slot: idx, nodeId: null, name: '(empty)' };
      const node = getNode(nodeId);
      return { slot: idx, nodeId, name: node?.name ?? nodeId };
    });

    const available = unlockedNodes
      .filter(nid => {
        const node = getNode(nid);
        return node && node.tier <= 3; // No T4 for companions
      })
      .map(nid => {
        const node = getNode(nid)!;
        return { nodeId: nid, name: node.name, tier: node.tier, sector: node.sector };
      });

    // Send to client
    const socketId = this._charToSocket.get(characterId);
    if (socketId) {
      void this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId,
        socketId,
        payload: {
          socketId,
          event: `companion_${web}_loadout`,
          data: { companionId: companion.id, web, slots, available },
        },
        timestamp: Date.now(),
      });
    }

    const filledCount = loadout.filter((s: string | null) => s !== null).length;
    return { success: true, message: `${web === 'active' ? 'Active' : 'Passive'} loadout: ${filledCount}/8 slots filled.` };
  }

  private async processCompanionSlotAbility(
    characterId: string,
    web: 'active' | 'passive',
    slotIndex: number,
    nodeId: string,
  ): Promise<{ success: boolean; message?: string }> {
    const found = await this.findPlayerCompanion(characterId);
    if (!found) return { success: false, message: 'No companion found.' };

    const { companion } = found;

    // Load owner's unlocked abilities for validation
    const ownerState = await loadAbilityState(characterId);
    if (!ownerState) return { success: false, message: 'Could not load ability state.' };

    // Validate
    const result = web === 'active'
      ? canCompanionSlotActive(nodeId, slotIndex, ownerState.unlocked)
      : canCompanionSlotPassive(nodeId, slotIndex, ownerState.unlocked);

    if (!result.ok) return { success: false, message: result.reason };

    // Update loadout
    const loadoutRaw = web === 'active' ? companion.activeLoadout : companion.passiveLoadout;
    const slots = (loadoutRaw as { slots: (string | null)[] } | null)?.slots?.slice() ?? Array(8).fill(null);
    slots[slotIndex] = nodeId;
    const newLoadout = { slots };

    // Persist
    const updateData = web === 'active'
      ? { activeLoadout: newLoadout }
      : { passiveLoadout: newLoadout };
    await CompanionService.updateLoadouts(companion.id, updateData);

    // If active, re-resolve abilities and update controller
    if (web === 'active') {
      const resolved = resolveAbilitiesFromLoadout(slots);
      const controller = this.npcControllers.get(companion.id);
      if (controller && resolved.length > 0) controller.setAbilities(resolved);
    }

    const nodeName = getNode(nodeId)?.name ?? nodeId;
    return { success: true, message: `Slotted ${nodeName} into ${web} slot ${slotIndex + 1}.` };
  }

  private async processCompanionUnslotAbility(
    characterId: string,
    web: 'active' | 'passive',
    slotIndex: number,
  ): Promise<{ success: boolean; message?: string }> {
    const found = await this.findPlayerCompanion(characterId);
    if (!found) return { success: false, message: 'No companion found.' };

    const { companion } = found;

    if (slotIndex < 0 || slotIndex >= 8) {
      return { success: false, message: 'Slot index must be 0-7.' };
    }

    const loadoutRaw = web === 'active' ? companion.activeLoadout : companion.passiveLoadout;
    const slots = (loadoutRaw as { slots: (string | null)[] } | null)?.slots?.slice() ?? Array(8).fill(null);

    const removedId = slots[slotIndex];
    if (!removedId) return { success: false, message: `${web === 'active' ? 'Active' : 'Passive'} slot ${slotIndex + 1} is already empty.` };

    slots[slotIndex] = null;
    const newLoadout = { slots };

    const updateData = web === 'active'
      ? { activeLoadout: newLoadout }
      : { passiveLoadout: newLoadout };
    await CompanionService.updateLoadouts(companion.id, updateData);

    // If active, re-resolve abilities
    if (web === 'active') {
      const resolved = resolveAbilitiesFromLoadout(slots);
      const controller = this.npcControllers.get(companion.id);
      if (controller) controller.setAbilities(resolved);
    }

    const nodeName = getNode(removedId)?.name ?? removedId;
    return { success: true, message: `Removed ${nodeName} from ${web} slot ${slotIndex + 1}.` };
  }

  // ── Scripted Object process methods ─────────────────────────────────────

  private async broadcastScriptedObjectMessage(
    zoneId: string,
    objectId: string,
    objectName: string,
    channel: 'say' | 'emote',
    message: string,
    position: { x: number; y: number; z: number },
  ): Promise<void> {
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;

    const range = channel === 'emote' ? 45.72 : 6.096; // emote 150ft, say 20ft
    const nearbySocketIds = zoneManager.getPlayerSocketIdsInRange(position, range);

    const formattedMessage = channel === 'emote'
      ? `${objectName} ${message}`
      : message;

    this.trackChatMessage(zoneId, objectName, channel, formattedMessage);

    for (const socketId of nearbySocketIds) {
      const clientMessage: ClientMessagePayload = {
        socketId,
        event: 'chat',
        data: {
          channel,
          sender: objectName,
          senderId: objectId,
          senderType: 'scripted_object',
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

  private async sendSystemMessageToCharacter(characterId: string, message: string): Promise<void> {
    const zoneId = this.characterToZone.get(characterId);
    if (!zoneId) return;
    const zoneManager = this.zones.get(zoneId);
    if (!zoneManager) return;
    const entity = zoneManager.getEntity(characterId);
    if (!entity?.socketId) return;

    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId,
      socketId: entity.socketId,
      payload: {
        socketId: entity.socketId,
        event: 'chat',
        data: {
          channel: 'system',
          sender: 'System',
          senderId: '',
          message,
          timestamp: Date.now(),
        },
      },
      timestamp: Date.now(),
    });
  }

  /** Resolve a scripted object by ID or name for the given owner. */
  private async resolveScriptedObject(
    characterId: string,
    target: string,
  ): Promise<{ success: false; message: string } | { success: true; object: any }> {
    // Try by ID first
    const byId = await ScriptedObjectService.findById(target);
    if (byId) {
      if (byId.ownerCharacterId !== characterId) {
        return { success: false, message: 'You do not own that object.' };
      }
      return { success: true, object: byId };
    }

    // Try by name among player's objects
    const owned = await ScriptedObjectService.findByOwner(characterId);
    const needle = target.toLowerCase();
    const byName = owned.find(o => o.name.toLowerCase() === needle);
    if (byName) return { success: true, object: byName };

    return { success: false, message: `Object "${target}" not found.` };
  }

  private async processScriptedObjectPlace(
    characterId: string,
    zoneId: string,
    position: { x: number; y: number; z: number },
    name: string,
  ): Promise<{ success: boolean; message?: string }> {
    const MAX_OBJECTS_PER_PLAYER = 10;
    const count = await ScriptedObjectService.countByOwner(characterId);
    if (count >= MAX_OBJECTS_PER_PLAYER) {
      return { success: false, message: `You can have at most ${MAX_OBJECTS_PER_PLAYER} scripted objects.` };
    }

    const obj = await ScriptedObjectService.create({
      name,
      ownerCharacterId: characterId,
      zoneId,
      positionX: position.x,
      positionY: position.y,
      positionZ: position.z,
    });

    // Add entity to zone
    const zoneManager = this.zones.get(zoneId);
    if (zoneManager) {
      zoneManager.addScriptedObject({
        id: obj.id,
        name: obj.name,
        position: { x: obj.positionX, y: obj.positionY, z: obj.positionZ },
      });
    }

    // Register with controller
    const controller = this.scriptedObjectControllers.get(zoneId);
    if (controller) {
      controller.registerObject({
        id: obj.id,
        name: obj.name,
        position: { x: obj.positionX, y: obj.positionY, z: obj.positionZ },
        ownerCharacterId: obj.ownerCharacterId,
        scriptSource: obj.scriptSource,
        stateData: {},
        isActive: true,
        errorCount: 0,
      });
    }

    logger.info({ objectId: obj.id, name, zoneId, characterId }, '[ScriptedObject] Placed');
    return { success: true, message: `Placed "${name}" (${obj.id}). Use /object script ${obj.id} <lua> to add a script.` };
  }

  private async processScriptedObjectEdit(
    characterId: string,
    target: string,
  ): Promise<{ success: boolean; message?: string; data?: any }> {
    const result = await this.resolveScriptedObject(characterId, target);
    if (!result.success) return result;

    const obj = result.object;
    const source = obj.scriptSource || '(empty)';
    return {
      success: true,
      message: `── Script for "${obj.name}" (${obj.id}) ──\n${source}\n── End of script ──`,
      data: { objectId: obj.id, name: obj.name, scriptSource: obj.scriptSource },
    };
  }

  private async processScriptedObjectScript(
    characterId: string,
    _zoneId: string,
    objectId: string,
    scriptSource: string,
  ): Promise<{ success: boolean; message?: string }> {
    const obj = await ScriptedObjectService.findById(objectId);
    if (!obj) return { success: false, message: `Object "${objectId}" not found.` };
    if (obj.ownerCharacterId !== characterId) return { success: false, message: 'You do not own that object.' };

    // Update in DB
    await ScriptedObjectService.updateScript(objectId, scriptSource);

    // Recompile in controller
    const controller = this.scriptedObjectControllers.get(obj.zoneId);
    if (controller) {
      const compileResult = controller.recompileObject(objectId, scriptSource);
      if (!compileResult.success) {
        return { success: false, message: `Compile error: ${compileResult.error}` };
      }
    }

    logger.info({ objectId, characterId }, '[ScriptedObject] Script updated');
    return { success: true, message: `Script updated for "${obj.name}".` };
  }

  private async processScriptedObjectPickup(
    characterId: string,
    zoneId: string,
    target: string,
  ): Promise<{ success: boolean; message?: string }> {
    const result = await this.resolveScriptedObject(characterId, target);
    if (!result.success) return result;

    const obj = result.object;

    // Remove from controller
    const controller = this.scriptedObjectControllers.get(obj.zoneId);
    if (controller) controller.removeObject(obj.id);

    // Remove from zone entity list
    const zoneManager = this.zones.get(obj.zoneId);
    if (zoneManager) zoneManager.removeScriptedObject(obj.id);

    // Delete from DB
    await ScriptedObjectService.delete(obj.id);

    logger.info({ objectId: obj.id, name: obj.name, characterId }, '[ScriptedObject] Picked up');
    return { success: true, message: `Picked up "${obj.name}".` };
  }

  private async processScriptedObjectInspect(
    characterId: string,
    target: string,
  ): Promise<{ success: boolean; message?: string; data?: any }> {
    const result = await this.resolveScriptedObject(characterId, target);
    if (!result.success) return result;

    const obj = result.object;
    const lines = [
      `"${obj.name}" (${obj.id})`,
      `Position: ${obj.positionX.toFixed(1)}, ${obj.positionY.toFixed(1)}, ${obj.positionZ.toFixed(1)}`,
      `Zone: ${obj.zoneId}`,
      `Active: ${obj.isActive ? 'Yes' : 'No'}`,
      `Errors: ${obj.errorCount}`,
    ];
    if (obj.lastErrorMsg) lines.push(`Last error: ${obj.lastErrorMsg}`);
    if (obj.description) lines.push(`Description: ${obj.description}`);
    lines.push(`Script: ${obj.scriptSource ? `${obj.scriptSource.length} bytes` : '(empty)'}`);

    return { success: true, message: lines.join('\n'), data: obj };
  }

  private async processScriptedObjectList(
    characterId: string,
  ): Promise<{ success: boolean; message?: string; data?: any }> {
    const objects = await ScriptedObjectService.findByOwner(characterId);
    if (objects.length === 0) {
      return { success: true, message: 'You have no scripted objects.' };
    }

    const lines = objects.map(o =>
      `  ${o.name} (${o.id}) — ${o.isActive ? 'active' : 'inactive'}${o.errorCount > 0 ? ` [${o.errorCount} errors]` : ''}`
    );
    return {
      success: true,
      message: `Your scripted objects (${objects.length}):\n${lines.join('\n')}`,
      data: objects.map(o => ({ id: o.id, name: o.name, isActive: o.isActive, zoneId: o.zoneId })),
    };
  }

  private async processScriptedObjectActivate(
    characterId: string,
    _zoneId: string,
    target: string,
  ): Promise<{ success: boolean; message?: string }> {
    const result = await this.resolveScriptedObject(characterId, target);
    if (!result.success) return result;

    const obj = result.object;
    await ScriptedObjectService.activate(obj.id);

    const controller = this.scriptedObjectControllers.get(obj.zoneId);
    if (controller) {
      const activateResult = controller.activateObject(obj.id);
      if (!activateResult.success) {
        return { success: false, message: `Activation failed: ${activateResult.error}` };
      }
    }

    logger.info({ objectId: obj.id, characterId }, '[ScriptedObject] Activated');
    return { success: true, message: `"${obj.name}" activated.` };
  }

  private async processScriptedObjectDeactivate(
    characterId: string,
    _zoneId: string,
    target: string,
  ): Promise<{ success: boolean; message?: string }> {
    const result = await this.resolveScriptedObject(characterId, target);
    if (!result.success) return result;

    const obj = result.object;
    await ScriptedObjectService.deactivate(obj.id);

    const controller = this.scriptedObjectControllers.get(obj.zoneId);
    if (controller) controller.deactivateObject(obj.id);

    logger.info({ objectId: obj.id, characterId }, '[ScriptedObject] Deactivated');
    return { success: true, message: `"${obj.name}" deactivated.` };
  }

  private async processScriptedObjectVerbs(
    characterId: string,
    target: string,
  ): Promise<{ success: boolean; message?: string }> {
    const result = await this.resolveScriptedObject(characterId, target);
    if (!result.success) return result;

    const obj = result.object;
    const verbScripts = await ObjectVerbScriptService.findByObject(obj.id);

    if (verbScripts.length === 0) {
      return { success: true, message: `"${obj.name}" has no verb scripts. Use /edit ${obj.name}:<verb> to create one.` };
    }

    const lines = verbScripts.map(vs =>
      `  ${vs.verb} (v${vs.version}) — ${vs.source.length} bytes`
    );
    return {
      success: true,
      message: `Verbs on "${obj.name}" (${verbScripts.length}):\n${lines.join('\n')}`,
    };
  }

  private async processScriptedObjectDoVerb(
    characterId: string,
    zoneId: string,
    target: string,
    verb: string,
  ): Promise<{ success: boolean; message?: string }> {
    const result = await this.resolveScriptedObject(characterId, target);
    if (!result.success) return result;

    const obj = result.object;

    // Ensure object is in the same zone
    if (obj.zoneId !== zoneId) {
      return { success: false, message: 'That object is not in your current zone.' };
    }

    const controller = this.scriptedObjectControllers.get(zoneId);
    if (!controller) {
      return { success: false, message: 'Script engine not available for this zone.' };
    }

    // Provide actor context to the Lua verb function
    const zm = this.zones.get(zoneId);
    const actor = zm?.getEntity(characterId);
    const actorContext = {
      actorId: characterId,
      actorName: actor?.name ?? 'Unknown',
      actorType: 'player',
    };

    const callResult = controller.callVerb(obj.id, verb, actorContext);
    if (!callResult.success) {
      return { success: false, message: callResult.error };
    }

    return { success: true, message: '' };
  }

  // ── Script Editor ─────────────────────────────────────────────────────

  /** Active editor sessions: editorId → session metadata */
  private editorSessions = new Map<string, {
    objectId: string;
    verb: string;
    characterId: string;
    socketId: string;
    verbScriptId: string | null; // null if creating new
  }>();

  private async processEditorOpenRequest(
    characterId: string,
    _zoneId: string,
    socketId: string,
    objectRef: string,
    verb: string,
  ): Promise<{ success: boolean; message?: string }> {
    const result = await this.resolveScriptedObject(characterId, objectRef);
    if (!result.success) return result;

    const obj = result.object;
    const readOnly = obj.ownerCharacterId !== characterId;

    // Find existing verb script or prepare blank stub
    let verbScript = await ObjectVerbScriptService.findByObjectAndVerb(obj.id, verb);
    let source = '';
    let version = 0;
    let verbScriptId: string | null = null;

    if (verbScript) {
      source = verbScript.source;
      version = verbScript.version;
      verbScriptId = verbScript.id;
    } else if (!readOnly) {
      // New verb — show blank template
      source = `function ${verb}(ctx)\n  -- Your code here\nend`;
      version = 0;
    } else {
      return { success: false, message: `Verb "${verb}" does not exist on "${obj.name}".` };
    }

    // Create editor session
    const editorId = `ed-${randomUUID()}`;
    this.editorSessions.set(editorId, {
      objectId: obj.id,
      verb,
      characterId,
      socketId,
      verbScriptId,
    });

    // Send editor_open to client
    const zoneManager = this.zones.get(obj.zoneId);
    const entity = zoneManager?.getEntity(characterId);
    if (entity?.socketId) {
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId,
        socketId: entity.socketId,
        payload: {
          socketId: entity.socketId,
          event: 'editor_open',
          data: {
            editorId,
            objectId: obj.id,
            objectName: obj.name,
            verb,
            source,
            language: 'lua',
            readOnly,
            version,
            origin: 'edit',
          },
        },
        timestamp: Date.now(),
      });
    }

    return { success: true, message: verbScript ? `Editing ${obj.name}:${verb}` : `Creating new verb "${verb}" on "${obj.name}"` };
  }

  private async processEditorUndoRequest(
    characterId: string,
    _zoneId: string,
    socketId: string,
    objectRef: string,
    verb: string,
  ): Promise<{ success: boolean; message?: string }> {
    const result = await this.resolveScriptedObject(characterId, objectRef);
    if (!result.success) return result;

    const obj = result.object;
    if (obj.ownerCharacterId !== characterId) {
      return { success: false, message: 'You do not own that object.' };
    }

    const verbScript = await ObjectVerbScriptService.findByObjectAndVerb(obj.id, verb);
    if (!verbScript) {
      return { success: false, message: `Verb "${verb}" does not exist on "${obj.name}".` };
    }

    const restored = await ObjectVerbScriptService.undo(verbScript.id);
    if (!restored) {
      return { success: false, message: `No previous version to restore for ${obj.name}:${verb}` };
    }

    // Hot-swap in controller
    const controller = this.scriptedObjectControllers.get(obj.zoneId);
    if (controller) {
      const compileResult = controller.recompileVerb(obj.id, verb, restored.source);
      if (!compileResult.success) {
        return { success: false, message: `Undo succeeded but recompile failed: ${compileResult.error}` };
      }
    }

    // Send editor_open with the restored source so player can see it
    const zoneManager = this.zones.get(obj.zoneId);
    const entity = zoneManager?.getEntity(characterId);
    if (entity?.socketId) {
      const editorId = `ed-${randomUUID()}`;
      this.editorSessions.set(editorId, {
        objectId: obj.id,
        verb,
        characterId,
        socketId: entity.socketId,
        verbScriptId: restored.id,
      });

      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId,
        socketId: entity.socketId,
        payload: {
          socketId: entity.socketId,
          event: 'editor_open',
          data: {
            editorId,
            objectId: obj.id,
            objectName: obj.name,
            verb,
            source: restored.source,
            language: 'lua',
            readOnly: false,
            version: restored.version,
            origin: 'undo',
          },
        },
        timestamp: Date.now(),
      });
    }

    logger.info({ objectId: obj.id, verb, characterId }, '[ScriptEditor] Undo');
    return { success: true, message: `Rolled back ${obj.name}:${verb} to v${restored.version}. Editor opened with restored source.` };
  }

  /**
   * Handle editor_save from client (routed via gateway).
   * Compiles, persists with history, and hot-swaps.
   */
  async handleEditorSave(editorId: string, source: string): Promise<void> {
    const session = this.editorSessions.get(editorId);
    if (!session) return;

    const { objectId, verb, characterId, socketId, verbScriptId } = session;

    // Compile-check first
    const controller = this.scriptedObjectControllers.get(
      (await ScriptedObjectService.findById(objectId))?.zoneId ?? '',
    );

    const compileResult = controller
      ? controller.checkCompileVerb(objectId, verb, source)
      : { success: true, errors: [], warnings: [] };

    if (!compileResult.success) {
      // Send error result
      await this.messageBus.publish('gateway:output', {
        type: MessageType.CLIENT_MESSAGE,
        characterId,
        socketId,
        payload: {
          socketId,
          event: 'editor_result',
          data: {
            editorId,
            success: false,
            errors: compileResult.errors,
            warnings: compileResult.warnings,
          },
        },
        timestamp: Date.now(),
      });
      return;
    }

    // Persist with version history
    let updatedScript;
    if (verbScriptId) {
      updatedScript = await ObjectVerbScriptService.saveWithHistory(verbScriptId, source, characterId);
    } else {
      // Create new verb script
      updatedScript = await ObjectVerbScriptService.create({
        objectId,
        verb,
        source,
        authorId: characterId,
      });
      session.verbScriptId = updatedScript.id;
    }

    // Hot-swap in controller
    if (controller) {
      controller.recompileVerb(objectId, verb, source);
    }

    // Send success result
    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId,
      socketId,
      payload: {
        socketId,
        event: 'editor_result',
        data: {
          editorId,
          success: true,
          version: updatedScript.version,
          errors: [],
          warnings: compileResult.warnings,
        },
      },
      timestamp: Date.now(),
    });

    logger.info({ objectId, verb, characterId, version: updatedScript.version }, '[ScriptEditor] Save');
  }

  /**
   * Handle editor_compile from client (compile-check only, no persist).
   */
  async handleEditorCompile(editorId: string, source: string): Promise<void> {
    const session = this.editorSessions.get(editorId);
    if (!session) return;

    const { objectId, verb, characterId, socketId } = session;

    const obj = await ScriptedObjectService.findById(objectId);
    const controller = obj ? this.scriptedObjectControllers.get(obj.zoneId) : null;

    const compileResult = controller
      ? controller.checkCompileVerb(objectId, verb, source)
      : { success: true, errors: [], warnings: [] };

    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId,
      socketId,
      payload: {
        socketId,
        event: 'editor_result',
        data: {
          editorId,
          success: compileResult.success,
          errors: compileResult.errors,
          warnings: compileResult.warnings,
        },
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Handle editor_revert from client — send back the last-saved source.
   */
  async handleEditorRevert(editorId: string): Promise<void> {
    const session = this.editorSessions.get(editorId);
    if (!session) return;

    const { objectId, verb, characterId, socketId, verbScriptId } = session;

    let source = '';
    let version = 0;
    if (verbScriptId) {
      const vs = await ObjectVerbScriptService.findById(verbScriptId);
      if (vs) {
        source = vs.source;
        version = vs.version;
      }
    } else {
      source = `function ${verb}(ctx)\n  -- Your code here\nend`;
    }

    const obj = await ScriptedObjectService.findById(objectId);

    await this.messageBus.publish('gateway:output', {
      type: MessageType.CLIENT_MESSAGE,
      characterId,
      socketId,
      payload: {
        socketId,
        event: 'editor_open',
        data: {
          editorId,
          objectId,
          objectName: obj?.name ?? 'Unknown',
          verb,
          source,
          language: 'lua',
          readOnly: false,
          version,
          origin: 'edit',
        },
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Handle editor_close from client — clean up session.
   */
  handleEditorClose(editorId: string): void {
    this.editorSessions.delete(editorId);
  }

  // ══════════════════════════════════════════════════════════════════════════

  private async handleCombatTimeouts(expired: string[]): Promise<void> {
    for (const entityId of expired) {
      const zoneId = this.characterToZone.get(entityId) || this.companionToZone.get(entityId);
      if (!zoneId) continue;
      const zoneManager = this.zones.get(zoneId);
      if (!zoneManager) continue;
      const entity = zoneManager.getEntity(entityId);
      if (!entity) continue;

      // Clear auto-attack and threat table when combat times out
      this.combatManager.clearAutoAttackTarget(entityId);
      this.combatManager.clearQueuedActionsForEntity(entityId);
      this.combatManager.getEnmityTable().clearTable(entityId);

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
      // Villages are safe havens — skip corruption entirely.
      // No zone gain, no isolation gain, no wealth gain. Corruption stays flat.
      if (zoneId.startsWith('village:')) continue;

      const corruptionTag = this.zoneCorruptionTags.get(zoneId) || 'WILDS';
      const characterIds: string[] = [];
      const characterPositions = new Map<string, { x: number; z: number }>();

      // Get all player character IDs in this zone
      for (const [charId, charZoneId] of this.characterToZone.entries()) {
        if (charZoneId === zoneId) {
          characterIds.push(charId);
          // Collect positions for beacon zone checks
          const entity = zoneManager.getEntity(charId);
          if (entity) {
            characterPositions.set(charId, { x: entity.position.x, z: entity.position.z });
          }
        }
      }

      if (characterIds.length > 0) {
        data.push({
          zoneId,
          corruptionTag,
          characterIds,
          characterPositions,
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

  // ── Guild System Helpers ────────────────────────────────────────────────

  /**
   * Check if a character position is within a beacon zone or polygon for corruption purposes.
   */
  private checkBeaconZone(
    _characterId: string,
    zoneId: string,
    position: { x: number; z: number },
  ): {
    inBeaconRadius: boolean;
    inPolygon: boolean;
    polygonEffectiveTier: number;
    guildCorruptionResistPercent: number;
  } {
    const result = {
      inBeaconRadius: false,
      inPolygon: false,
      polygonEffectiveTier: 0,
      guildCorruptionResistPercent: 0,
    };

    // Check lit beacons in this zone
    const beacons = this.litBeaconCache.get(zoneId);
    if (beacons) {
      for (const b of beacons) {
        const d = distance2D(position, { x: b.worldX, z: b.worldZ });
        if (d <= b.effectRadius) {
          result.inBeaconRadius = true;
          break;
        }
      }
    }

    // Check active polygons
    for (const poly of this.activePolygonCache) {
      if (isPointInPolygon(position, poly.vertices)) {
        result.inPolygon = true;
        result.polygonEffectiveTier = interpolatePolygonTier(position, poly.beaconTiers);
        break;
      }
    }

    return result;
  }

  /**
   * Passive stamina regen — all living players, always, regardless of location.
   * 1% of maxStamina every 3s ≈ 20%/min.
   */
  private async tickStaminaRegen(): Promise<void> {
    for (const [characterId, zoneId] of this.characterToZone) {
      const zm = this.zones.get(zoneId);
      if (!zm) continue;

      const entity = zm.getEntity(characterId);
      if (!entity || !entity.isAlive) continue;

      const character = await CharacterService.findById(characterId);
      if (!character || !character.isAlive) continue;
      if (character.currentStamina >= character.maxStamina) continue;

      const regenAmount = Math.ceil(character.maxStamina * DistributedWorldManager.STAMINA_REGEN_BASE_PCT);
      const newStamina = Math.min(character.maxStamina, character.currentStamina + regenAmount);
      if (newStamina === character.currentStamina) continue;

      await CharacterService.updateResources(characterId, { currentStamina: newStamina });

      await this.sendCharacterResourcesUpdate(zm, characterId, {
        health: { current: character.currentHp, max: character.maxHp },
        stamina: { current: newStamina, max: character.maxStamina },
        mana: { current: character.currentMana, max: character.maxMana },
      });
    }
  }

  /**
   * Periodic beacon regen tick — restores HP and MP for players within range
   * of a lit guild beacon, civic townhall (T3), or library beacon (T2).
   * Regen scales with the highest effective tier found:
   *   tier 1 = 1x, tier 2 = 1.5x, tier 3 = 2x, tier 4 = 2.5x, tier 5 = 3x
   */
  private async tickBeaconRegen(): Promise<void> {
    for (const [characterId, zoneId] of this.characterToZone) {
      const zm = this.zones.get(zoneId);
      if (!zm) continue;

      const entity = zm.getEntity(characterId);
      if (!entity || !entity.isAlive) continue;

      // ── Find highest effective tier from any regen source ──
      let bestTier = 0;

      // 1. Guild beacons (use their actual tier)
      const beacons = this.litBeaconCache.get(zoneId);
      if (beacons) {
        for (const b of beacons) {
          const dx = entity.position.x - b.worldX;
          const dz = entity.position.z - b.worldZ;
          if (dx * dx + dz * dz <= b.effectRadius * b.effectRadius && b.tier > bestTier) {
            bestTier = b.tier;
          }
        }
      }

      // 2. Townhalls count as T3, libraries count as T2
      const anchors = this.civicAnchorCache.get(zoneId);
      if (anchors) {
        for (const a of anchors) {
          const dx = entity.position.x - a.worldX;
          const dz = entity.position.z - a.worldZ;
          if (dx * dx + dz * dz <= a.wardRadius * a.wardRadius) {
            const anchorTier = a.type === 'TOWNHALL' ? 3 : 2;
            if (anchorTier > bestTier) bestTier = anchorTier;
          }
        }
      }

      // 3. Library beacons (online only) count as T2
      const libs = this.libraryBeaconCache.get(zoneId);
      if (libs) {
        for (const lib of libs) {
          if (!lib.isOnline) continue;
          const dx = entity.position.x - lib.worldX;
          const dz = entity.position.z - lib.worldZ;
          if (dx * dx + dz * dz <= lib.catchmentRadius * lib.catchmentRadius) {
            if (2 > bestTier) bestTier = 2;
          }
        }
      }

      if (bestTier === 0) continue;

      // Read current resources from DB
      const character = await CharacterService.findById(characterId);
      if (!character || !character.isAlive) continue;

      const hpFull = character.currentHp >= character.maxHp;
      const mpFull = character.currentMana >= character.maxMana;
      if (hpFull && mpFull) continue;

      // Scale: tier 1 → 1x, tier 5 → 3x
      const tierMultiplier = 0.5 + bestTier * 0.5;

      let newHp = character.currentHp;
      let newMana = character.currentMana;

      if (!hpFull) {
        const hpRegen = Math.ceil(character.maxHp * DistributedWorldManager.BEACON_HP_REGEN_BASE_PCT * tierMultiplier);
        newHp = Math.min(character.maxHp, character.currentHp + hpRegen);
      }

      if (!mpFull) {
        const mpRegen = Math.ceil(character.maxMana * DistributedWorldManager.BEACON_MP_REGEN_BASE_PCT * tierMultiplier);
        newMana = Math.min(character.maxMana, character.currentMana + mpRegen);
      }

      if (newHp === character.currentHp && newMana === character.currentMana) continue;

      // Persist to DB
      await CharacterService.updateResources(characterId, {
        currentHp: newHp,
        currentMana: newMana,
      });

      // Update in-memory entity health
      zm.setEntityHealth(characterId, newHp, character.maxHp);

      // Notify the player's client
      await this.sendCharacterResourcesUpdate(zm, characterId, {
        health: { current: newHp, max: character.maxHp },
        stamina: { current: character.currentStamina, max: character.maxStamina },
        mana: { current: newMana, max: character.maxMana },
      });

      // Broadcast health to nearby players
      await this.broadcastEntityHealthUpdate(zm, entity.position, characterId, {
        current: newHp,
        max: character.maxHp,
      });
    }
  }

  /**
   * Refresh cached lit beacons and polygons. Called on beacon state changes.
   */
  private async refreshBeaconCaches(): Promise<void> {
    // Refresh lit beacons per zone
    this.litBeaconCache.clear();
    for (const zoneId of this.zones.keys()) {
      const beacons = await GuildBeaconService.findLitBeaconsInZone(zoneId);
      this.litBeaconCache.set(zoneId, beacons.map(b => ({
        id: b.id,
        guildId: b.guildId,
        worldX: b.worldX,
        worldZ: b.worldZ,
        tier: b.tier,
        effectRadius: b.effectRadius,
      })));
    }

    // Refresh polygon cache
    const polygons = await GuildBeaconService.getActivePolygons();
    this.activePolygonCache = polygons.map(p => ({
      guildId: p.guildId,
      vertices: (p.vertices as any) as Point2D[],
      beaconTiers: ((p as any).beaconTiers ?? []) as TieredPoint[],
    }));

    // Refresh civic anchor cache (townhalls + libraries) for regen
    this.civicAnchorCache.clear();
    for (const zoneId of this.zones.keys()) {
      const anchors = await prisma.civicAnchor.findMany({
        where: { zoneId, isActive: true },
        select: { worldX: true, worldZ: true, wardRadius: true, type: true },
      });
      if (anchors.length > 0) {
        this.civicAnchorCache.set(zoneId, anchors);
      }
    }

    // Refresh library beacon cache for regen
    this.libraryBeaconCache.clear();
    for (const zoneId of this.zones.keys()) {
      const libs = await LibraryBeaconService.findByZoneId(zoneId);
      if (libs.length > 0) {
        this.libraryBeaconCache.set(zoneId, libs.map(l => ({
          worldX: l.worldX,
          worldZ: l.worldZ,
          catchmentRadius: l.catchmentRadius,
          isOnline: l.isOnline,
        })));
      }
    }
  }

  /**
   * Handle beacon state change (lit → dark or dark → lit).
   */
  private handleBeaconStateChange(change: BeaconStateChange): void {
    logger.info(
      { beaconId: change.beaconId, guildId: change.guildId, newState: change.newState },
      'Beacon state changed'
    );

    // Refresh cached data
    void this.refreshBeaconCaches();

    // Broadcast beacon alert to guild members
    void (async () => {
      const members = await GuildService.getMembers(change.guildId);
      const alertType = change.newState === 'DARK' ? 'EXTINGUISHED' : 'RELIT';
      const message = change.newState === 'DARK'
        ? `A guild beacon has gone dark!`
        : `A guild beacon has been relit!`;

      for (const m of members) {
        const sid = this._charToSocket.get(m.characterId);
        if (sid) {
          void this.messageBus.publish('gateway:output', {
            type: MessageType.CLIENT_MESSAGE,
            characterId: m.characterId,
            socketId: sid,
            payload: {
              socketId: sid,
              event: 'beacon_alert',
              data: {
                alertType,
                beaconId: change.beaconId,
                message,
                timestamp: Date.now(),
              },
            },
            timestamp: Date.now(),
          });
        }
      }
    })();
  }

  /**
   * Broadcast ember clock announcement to appropriate scope.
   */
  private async broadcastEmberClockAnnouncement(announcement: {
    beaconId: string;
    guildId: string;
    hoursRemaining: number;
    message: string;
    scope: 'guild' | 'zone' | 'zone_wide' | 'server_wide';
  }): Promise<void> {
    const recipients: string[] = [];

    switch (announcement.scope) {
      case 'guild': {
        const members = await GuildService.getMembers(announcement.guildId);
        for (const m of members) {
          if (this._charToSocket.has(m.characterId)) {
            recipients.push(m.characterId);
          }
        }
        break;
      }
      case 'zone':
      case 'zone_wide':
      case 'server_wide': {
        // For zone+ scope, broadcast to all online characters
        for (const charId of this.characterToZone.keys()) {
          if (this._charToSocket.has(charId)) {
            recipients.push(charId);
          }
        }
        break;
      }
    }

    for (const charId of recipients) {
      const sid = this._charToSocket.get(charId);
      if (sid) {
        void this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          characterId: charId,
          socketId: sid,
          payload: {
            socketId: sid,
            event: 'beacon_alert',
            data: {
              alertType: announcement.hoursRemaining <= 1 ? 'CRITICAL_FUEL' : 'LOW_FUEL',
              beaconId: announcement.beaconId,
              hoursRemaining: announcement.hoursRemaining,
              message: announcement.message,
              timestamp: Date.now(),
            },
          },
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * Deliver guild chat message to online guild members on this server.
   */
  private async deliverGuildChat(
    guildId: string,
    payload: { guildId: string; guildTag: string; senderId: string; senderName: string; message: string; timestamp: number },
  ): Promise<void> {
    const members = await GuildService.getMembers(guildId);
    for (const m of members) {
      const sid = this._charToSocket.get(m.characterId);
      if (sid) {
        void this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          characterId: m.characterId,
          socketId: sid,
          payload: {
            socketId: sid,
            event: 'chat',
            data: {
              channel: 'guild',
              sender: payload.senderName,
              senderId: payload.senderId,
              guildTag: payload.guildTag,
              message: payload.message,
              timestamp: payload.timestamp,
            },
          },
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * Broadcast library assault start to zone players.
   */
  private async broadcastLibraryAssaultStart(data: {
    libraryId: string;
    libraryName: string;
    assaultType: string;
    zoneId: string;
    position: { x: number; y: number; z: number };
    message: string;
  }): Promise<void> {
    for (const [charId, zId] of this.characterToZone) {
      if (zId !== data.zoneId) continue;
      const sid = this._charToSocket.get(charId);
      if (sid) {
        void this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          characterId: charId,
          socketId: sid,
          payload: {
            socketId: sid,
            event: 'library_assault',
            data: {
              phase: 'started',
              libraryId: data.libraryId,
              libraryName: data.libraryName,
              assaultType: data.assaultType,
              message: data.message,
              timestamp: Date.now(),
            },
          },
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * Broadcast library assault resolution.
   */
  private async broadcastLibraryAssaultResolved(data: {
    libraryId: string;
    libraryName: string;
    assaultType: string;
    wasDefended: boolean;
    offlineHours: number;
    message: string;
  }): Promise<void> {
    // Broadcast to all online players (assault resolution is server-wide news)
    for (const charId of this.characterToZone.keys()) {
      const sid = this._charToSocket.get(charId);
      if (sid) {
        void this.messageBus.publish('gateway:output', {
          type: MessageType.CLIENT_MESSAGE,
          characterId: charId,
          socketId: sid,
          payload: {
            socketId: sid,
            event: 'library_assault',
            data: {
              phase: 'resolved',
              libraryId: data.libraryId,
              libraryName: data.libraryName,
              assaultType: data.assaultType,
              wasDefended: data.wasDefended,
              offlineHours: data.offlineHours,
              message: data.message,
              timestamp: Date.now(),
            },
          },
          timestamp: Date.now(),
        });
      }
    }
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
        // Per-entity interactive override (dungeon entrances, clickable fixtures)
        ...(e.interactive  !== undefined && { interactive:  e.interactive }),
        // GLB model asset path for 3D clients
        ...(e.modelAsset   !== undefined && { modelAsset:   e.modelAsset }),
        ...(e.modelScale   !== undefined && { modelScale:   e.modelScale }),
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

    // Clear guild systems
    resetEmberClockSystem();
    resetLibraryAssaultSystem();
    await this.guildChatBridge.cleanup();
    this.litBeaconCache.clear();
    this.activePolygonCache = [];
    this.pendingGuildInvites.clear();

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

    // Flush scripted object state and destroy VMs
    for (const controller of this.scriptedObjectControllers.values()) {
      await controller.destroy();
    }
    this.scriptedObjectControllers.clear();

    void this.wildlifeBridge?.stop();
    this.wildlifeBridge = null;
  }
}
