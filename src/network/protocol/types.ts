/**
 * Protocol message type definitions
 * Based on PROTOCOL.md specification
 */

// Base message structure
export interface BaseMessage {
  type: string;
  payload: unknown;
  timestamp?: number;
  sequence?: number;
}

// Client capabilities
export interface ClientCapabilities {
  graphics: boolean;
  audio: boolean;
  input: string[];
  maxUpdateRate: number; // Updates per second
}

// Client types
export type ClientType = 'text' | '2d' | '3d' | 'vr';

// ========== Handshake ==========

export interface HandshakeMessage {
  type: 'handshake';
  payload: {
    protocolVersion: string;
    clientType: ClientType;
    clientVersion: string;
    capabilities: ClientCapabilities;
    isMachine?: boolean; // true for AI-controlled clients (airlock, bots)
  };
}

export interface HandshakeAckMessage {
  type: 'handshake_ack';
  payload: {
    protocolVersion: string;
    serverVersion: string;
    compatible: boolean;
    sessionId: string;
    timestamp: number;
    requiresAuth: boolean;
  };
}

// ========== Authentication ==========

export type AuthMethod = 'guest' | 'credentials' | 'token' | 'airlock';

export interface AuthMessage {
  type: 'auth';
  payload: {
    method: AuthMethod;
    guestName?: string;
    username?: string;
    email?: string;        // Alternative to username
    password?: string;
    token?: string;
    airlockKey?: string;
    airlockId?: string;
    clientVersion?: string;
    capabilities?: {
      llm?: boolean;
      multiSession?: boolean;
    };
  };
}

export interface CharacterInfo {
  id: string;
  name: string;
  level: number;
  lastPlayed: number;
  location: string;
  cosmetics?: Record<string, unknown>;
}

export interface AuthSuccessMessage {
  type: 'auth_success';
  payload: {
    accountId: string;
    token: string;
    characters: CharacterInfo[];
    canCreateCharacter: boolean;
    maxCharacters: number;
    // Guest session info
    isEphemeral?: boolean;  // true = guest session, character wiped on logout
    ephemeralMessage?: string;  // "You are logged in as Guest_abc123. Character will be deleted on logout."
    // Airlock session info
    airlockSessionId?: string;
    expiresAt?: number;
    canInhabit?: boolean;
    maxConcurrentInhabits?: number;
  };
}

export interface AuthErrorMessage {
  type: 'auth_error';
  payload: {
    reason: string;
    message: string;
    canRetry: boolean;
  };
}

// Registration flow: server asks client to confirm username for new account
export interface AuthConfirmNameMessage {
  type: 'auth_confirm_name';
  payload: {
    username: string;
    message: string;  // "Create account with username 'foo'?"
  };
}

// Registration flow: client confirms they want to create the account
export interface AuthNameConfirmedMessage {
  type: 'auth_name_confirmed';
  payload: {
    username: string;
    password: string;
    confirmed: boolean;  // true = create account, false = cancel
  };
}

// ========== Character Selection/Creation ==========

export interface CharacterSelectMessage {
  type: 'character_select';
  payload: {
    characterId: string;
  };
}

// Character creation flow: server asks client to confirm character name
export interface CharacterConfirmNameMessage {
  type: 'character_confirm_name';
  payload: {
    name: string;
    message: string;  // "Create character named 'Shadowblade'?"
  };
}

// Character creation flow: client confirms they want to create the character
export interface CharacterNameConfirmedMessage {
  type: 'character_name_confirmed';
  payload: {
    name: string;
    confirmed: boolean;  // true = create character, false = cancel
  };
}

export interface CompanionCreateData {
  name: string;
  personalityType?: string;
  archetype?: string;
  traits?: string[];
  goals?: string[];
  description?: string;
  systemPrompt?: string;
}

export interface CharacterCreateMessage {
  type: 'character_create';
  payload: {
    name: string;
    appearance: {
      description: string;
      movementProfile?: 'terrestrial' | 'amphibious' | 'aquatic';
      speciesId?: string;
    };
    companion?: CompanionCreateData;
  };
}

export interface CharacterDeleteMessage {
  type: 'character_delete';
  payload: {
    characterId: string;
  };
}

export interface CharacterUpdateMessage {
  type: 'character_update';
  payload: {
    characterId: string;
    name?: string;
    cosmetics?: Record<string, unknown> | null;
  };
}

export interface CharacterListRequestMessage {
  type: 'character_list_request';
  payload: {
    timestamp: number;
  };
}

export interface CharacterListMessage {
  type: 'character_list';
  payload: {
    characters: CharacterInfo[];
    maxCharacters: number;
    emptySlots: number;
    canCreateCharacter: boolean;
  };
}

export interface CharacterInfoUpdate extends Partial<CharacterInfo> {
  id: string;
}

export interface CharacterRosterDeltaMessage {
  type: 'character_roster_delta';
  payload: {
    added?: CharacterInfo[];
    removed?: string[];
    updated?: CharacterInfoUpdate[];
    maxCharacters?: number;
    emptySlots?: number;
    canCreateCharacter?: boolean;
  };
}

export interface CharacterErrorMessage {
  type: 'character_error';
  payload: {
    code: string;
    message: string;
    action: 'create' | 'delete' | 'list' | 'select' | 'update' | 'unknown';
  };
}

// ========== Ability Tree ==========

/**
 * Static node metadata sent once in world_entry.abilityManifest so the
 * client can render the full ability tree without a separate round-trip.
 */
export interface AbilityNodeSummary {
  id:               string;
  web:              'active' | 'passive';
  sector:           string;
  tier:             number;       // 1–4
  name:             string;
  description:      string;
  cost:             number;       // AP cost
  adjacentTo:       string[];     // neighbour node IDs
  // Active effect data (active-web nodes only)
  effectDescription?: string;
  staminaCost?:       number;
  manaCost?:          number;
  cooldown?:          number;     // seconds
  castTime?:          number;     // seconds (0 = instant)
  targetType?:        string;     // 'self' | 'enemy' | 'ally' | 'aoe'
  range?:             number;     // metres
  // Passive bonuses (passive-web nodes only)
  statBonuses?: Record<string, number>;
  questGate?:   string;           // feat ID required (T4 capstones)
}

/** Emitted after every unlock / slot operation so the client stays in sync. */
export interface AbilityUpdatePayload {
  unlockedActiveNodes:  string[];
  unlockedPassiveNodes: string[];
  activeLoadout:        (string | null)[];  // 8 slots
  passiveLoadout:       (string | null)[];  // 8 slots
  abilityPoints:        number;
  success:              boolean;
  message:              string;
}

// ========== World Entry ==========

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

// ========== Stats ==========

export interface CoreStats {
  strength: number;
  vitality: number;
  dexterity: number;
  agility: number;
  intelligence: number;
  wisdom: number;
}

export interface DerivedStats {
  // Resources
  maxHp: number;
  maxStamina: number;
  maxMana: number;
  carryingCapacity: number;

  // Physical Combat
  attackRating: number;
  defenseRating: number;
  physicalAccuracy: number;
  evasion: number;
  damageAbsorption: number;
  glancingBlowChance: number;

  // Magic Combat
  magicAttack: number;
  magicDefense: number;
  magicAccuracy: number;
  magicEvasion: number;
  magicAbsorption: number;

  // Speed & Timing
  initiative: number;
  movementSpeed: number;
  attackSpeedBonus: number;
}

export interface CharacterState {
  id: string;
  name: string;
  level: number;
  experience: number;
  abilityPoints: number;
  statPoints: number;
  isAlive: boolean;

  // Position
  position: Vector3;
  heading: number;  // 0-360 degrees, 0 = north, 90 = east, 180 = south, 270 = west
  rotation: Vector3;  // Full 3D rotation for VR/3D clients (pitch, yaw, roll)
  currentSpeed?: 'walk' | 'jog' | 'run' | 'stop';

  // Stats
  coreStats: CoreStats;
  derivedStats: DerivedStats;

  // Current Resources
  health: { current: number; max: number };
  stamina: { current: number; max: number };
  mana: { current: number; max: number };

  // Corruption system
  corruption: CorruptionStatus;
  corruptionBenefits: CorruptionBenefits;

  // Progression
  unlockedFeats: string[];  // Array of feat IDs
  unlockedAbilities: { activeNodes: string[]; passiveNodes: string[]; apSpent: number };

  // Loadouts (8 active, 8 passive, 4 special)
  activeLoadout:  (string | null)[];  // 8 slots
  passiveLoadout: (string | null)[];  // 8 slots
  specialLoadout: string[];           // 4 ability IDs (from equipment)
}

export interface ZoneInfo {
  id: string;
  name: string;
  description: string;
  weather: string;
  timeOfDay: string;
  /** Normalised 0–1 time of day (0 = midnight, 0.25 = 6 am, 0.5 = noon). */
  timeOfDayValue?: number;
  lighting: string;
  contentRating: ContentRating;  // Zone's content rating
}

export interface Entity {
  id: string;
  type: string;
  name: string;
  position: Vector3;
  description: string;
  isAlive?: boolean;
  health?: { current: number; max: number };
  interactive?: boolean;
  hostile?: boolean;
  animation?: string;
  // Nameplate data — mob/NPC identification and display
  tag?: string;         // Stable mob type identifier (e.g. "mob.rat.1")
  level?: number;       // Used for chevron indicator relative to player level
  faction?: string;     // "hostile" | "neutral" | "friendly" — nameplate color
  notorious?: boolean;  // True for Notorious Monsters — shows "??" + special marker
  
  // For 3D client animation/interpolation
  currentAction?: AnimationAction;                    // Current animation state
  movementDuration?: number;                          // How long movement takes (milliseconds)
  movementSpeed?: number;                             // Movement speed in m/s (for interpolation)
  heading?: number;                                   // Direction facing (0-360 degrees)
  modelAsset?: string;                                 // GLB asset path (e.g. "village/building_market.glb")
  modelScale?: number;                                 // Uniform scale for GLB model (default 1)
}

export interface Exit {
  direction: string;
  name: string;
  description: string;
}

export interface WorldEntryMessage {
  type: 'world_entry';
  payload: {
    characterId: string;
    timestamp: number;
    character: CharacterState;
    zone: ZoneInfo;
    entities: Entity[];
    exits: Exit[];
    /** Static node definitions — sent once so the client can render the tree. */
    abilityManifest: AbilityNodeSummary[];
    /** True for guest (ephemeral) sessions — client uses this to show /register prompt. */
    isGuest?: boolean;
  };
}

// ========== Guest Registration ==========

export interface RegisterAccountMessage {
  type: 'register_account';
  payload: {
    username: string;
    email: string;
    password: string;
  };
}

export interface RegisterResultMessage {
  type: 'register_result';
  payload: {
    success: boolean;
    username?: string;
    error?: string;
  };
}

// ========== State Updates ==========

export interface EntityUpdates {
  updated?: Partial<Entity>[];
  added?: Entity[];
  removed?: string[]; // Entity IDs
}

export interface StatusEffect {
  id: string;
  name: string;
  duration: number;
}

// ── Enmity list (threat indicator for combat HUD) ──────────────────────────
/** Threat level indicator: red = top target, yellow = allied target, blue = low threat */
export type EnmityLevel = 'red' | 'yellow' | 'blue';

export interface EnmityEntry {
  entityId: string;           // Mob's entity ID
  name: string;               // Mob display name
  level: EnmityLevel;         // Threat indicator color
}

export interface StateUpdateMessage {
  type: 'state_update';
  payload: {
    timestamp: number;
    entities?: EntityUpdates;
    character?: {
      health?: { current: number; max: number };
      stamina?: { current: number; max: number };
      mana?: { current: number; max: number };
      effects?: StatusEffect[];
      // Progression updates (XP gain / level-up)
      experience?: number;
      level?: number;
      abilityPoints?: number;
      statPoints?: number;
      isAlive?: boolean;
    };
    // Combat gauges (self only - private to the player)
    combat?: {
      atb?: { current: number; max: number };           // ATB gauge (0-200, or higher with gear)
      autoAttack?: { current: number; max: number };    // Weapon swing timer (0-weaponSpeed)
      inCombat?: boolean;
      autoAttackTarget?: string;                        // Entity ID of current target
      specialCharges?: Record<string, number>;          // Builder/consumer charges (e.g., {"combo_point": 3})
      /** Mobs that have this player on their enmity list.
       *  Red = targeting you, Yellow = targeting your ally, Blue = you're attacking it. */
      enmityList?: EnmityEntry[];
    };
    // Allied combat gauges (party/alliance members - ATB only, no auto-attack)
    allies?: Array<{
      entityId: string;
      atb?: { current: number; max: number };
      staminaPct?: number;
      manaPct?: number;
    }>;
    zone?: Partial<ZoneInfo>;
  };
}

// ========== Player Actions ==========

export type MoveMethod = 'heading' | 'position' | 'compass';
export type MovementSpeed = 'walk' | 'jog' | 'run' | 'stop';
export type CompassDirection = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

// Animation and action states for 3D client
export type AnimationAction = 
  // Idle states
  | 'idle'
  | 'sitting'
  | 'emoting'
  // Movement states
  | 'walking'
  | 'running'
  | 'jumping'
  // Combat states
  | 'attacking'
  | 'casting'
  | 'channeling'
  | 'hit'
  | 'knockback'
  | 'dying'
  | 'dead'
  // Social states
  | 'talking'
  | 'trading';

export interface MoveMessage {
  type: 'move';
  payload: {
    method: MoveMethod;

    // For heading method (all clients)
    speed?: MovementSpeed;    // walk, jog, run, stop
    heading?: number;          // 0-360 degrees (optional, uses current if omitted)

    // For compass method (text clients, converted to heading)
    compass?: CompassDirection; // N, NE, E, SE, S, SW, W, NW

    // For position method (direct position - 3D/VR clients)
    position?: Vector3;

    timestamp: number;
  };
}

export type CommunicationChannel = 'say' | 'shout' | 'emote' | 'cfh' | 'whisper' | 'party' | 'world' | 'guild' | 'companion';

export interface ChatMessage {
  type: 'chat';
  payload: {
    channel: CommunicationChannel;
    message: string;
    target?: string; // For whispers
    timestamp: number;
  };
}

export interface CommunicationReceived {
  type: 'communication';
  payload: {
    channel: 'say' | 'shout' | 'emote' | 'cfh';
    senderId: string;
    senderName: string;
    senderType: 'player' | 'npc' | 'companion' | 'scripted_object';
    content: string;
    distance: number;  // Actual distance from receiver in feet
    timestamp: number;
  };
}

export type InteractionAction = 'talk' | 'trade' | 'attack' | 'use' | 'examine';

export interface InteractMessage {
  type: 'interact';
  payload: {
    targetId: string;
    action: InteractionAction;
    timestamp: number;
  };
}

export interface CombatActionMessage {
  type: 'combat_action';
  payload: {
    abilityId: string;
    targetId: string;
    position?: Vector3; // For AoE
    timestamp: number;
  };
}

export interface CommandMessage {
  type: 'command';
  payload: {
    command: string;
    timestamp: number;
  };
}

export interface InhabitRequestMessage {
  type: 'inhabit_request';
  payload: {
    airlockSessionId: string;
    npcId?: string;
    npcTag?: string;
    intent?: string;
    ttlMs?: number;
  };
}

export interface InhabitGrantedMessage {
  type: 'inhabit_granted';
  payload: {
    inhabitId: string;
    npcId: string;
    displayName: string;
    zoneId: string;
    expiresAt: number;
  };
}

export interface InhabitDeniedMessage {
  type: 'inhabit_denied';
  payload: {
    reason: string;
  };
}

export interface InhabitReleaseMessage {
  type: 'inhabit_release';
  payload: {
    inhabitId: string;
    reason?: string;
  };
}

export interface InhabitPingMessage {
  type: 'inhabit_ping';
  payload: {
    inhabitId: string;
  };
}

export interface InhabitRevokedMessage {
  type: 'inhabit_revoked';
  payload: {
    inhabitId: string;
    reason: string;
  };
}

export interface InhabitChatMessage {
  type: 'inhabit_chat';
  payload: {
    inhabitId: string;
    channel: CommunicationChannel;
    message: string;
    timestamp: number;
  };
}

export interface ProximityRefreshMessage {
  type: 'proximity_refresh';
  payload: {
    timestamp: number;
  };
}

// ========== Events ==========

export interface VisualEffect {
  effect: string;
  position: Vector3;
}

export interface EventMessage {
  type: 'event';
  payload: {
    eventType: string;
    timestamp: number;
    narrative?: string; // For text clients
    animation?: string; // For graphical clients
    sound?: string;
    visual?: VisualEffect;
    [key: string]: unknown; // Event-specific data
  };
}

// ========== Connection Health ==========

export interface PingMessage {
  type: 'ping';
  payload: {
    timestamp: number;
  };
}

export interface PongMessage {
  type: 'pong';
  payload: {
    clientTimestamp: number;
    serverTimestamp: number;
  };
}

// ========== Disconnection ==========

export interface DisconnectMessage {
  type: 'disconnect';
  payload: {
    reason: string;
  };
}

// ========== Errors ==========

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'fatal';

export interface ErrorMessage {
  type: 'error';
  payload: {
    code: string;
    message: string;
    severity: ErrorSeverity;
    originalMessage?: unknown;
  };
}

// ========== Corruption System ==========

export type CorruptionState = 'CLEAN' | 'STAINED' | 'WARPED' | 'LOST';

export interface CorruptionStatus {
  current: number;           // 0-100 corruption value
  state: CorruptionState;    // Current threshold band
  isolationMinutes: number;  // Time isolated from community
  contributionPoints: number; // Accumulated contribution
}

export interface CorruptionUpdateMessage {
  type: 'corruption_update';
  payload: {
    corruption: number;           // Current corruption (0-100)
    state: CorruptionState;       // Current state band
    previousState?: CorruptionState; // Only present if state changed
    delta: number;                // Change amount (positive = gain, negative = reduction)
    reason?: string;              // Human-readable reason for change
    timestamp: number;
  };
}

// Corruption benefits (sent on state change or world entry)
export interface CorruptionBenefits {
  cacheDetectionBonus: number;   // Percentage bonus (0, 5, 15, 30)
  hazardResistBonus: number;     // Percentage bonus (0, 0, 10, 25)
  deadSystemInterface: boolean;  // Can interact with dead AI terminals
}

// ========== Content Ratings ==========

export type ContentRating = 'T' | 'M' | 'AO';  // Teen (13+), Mature (17+), Adults Only (18+)

export interface ContentRatingInfo {
  rating: ContentRating;
  name: string;
  description: string;
  ageRequirement: number;
}

export const CONTENT_RATINGS: Record<ContentRating, ContentRatingInfo> = {
  T: {
    rating: 'T',
    name: 'Teen',
    description: 'Fantasy violence, mild blood, mild profanity, suggestive themes',
    ageRequirement: 13,
  },
  M: {
    rating: 'M',
    name: 'Mature',
    description: 'Intense violence, blood and gore, strong profanity, sexual themes',
    ageRequirement: 17,
  },
  AO: {
    rating: 'AO',
    name: 'Adults Only',
    description: 'Graphic violence, explicit content, extreme themes',
    ageRequirement: 18,
  },
};

// ========== Movement Helpers ==========

// Compass direction to heading conversion
export const COMPASS_TO_HEADING: Record<CompassDirection, number> = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

// Speed multipliers for movement calculations
export const SPEED_MULTIPLIERS: Record<MovementSpeed, number> = {
  walk: 1.0,
  jog: 2.0,
  run: 3.5,
  stop: 0.0,
};

// Text-specific movement info sent to text clients
export interface TextMovementInfo {
  availableDirections: CompassDirection[];  // Valid directions from navmesh
  currentHeading: number;                   // Current facing direction (0-360)
  currentSpeed: MovementSpeed;              // Current movement speed
}

// ========== Proximity & Perception ==========

// Communication ranges in feet
export const COMMUNICATION_RANGES = {
  touch: 5,
  say: 20,
  shout: 150,
  emote: 150,
  see: 150,
  hear: 150,
  cfh: 250,  // Call for Help
} as const;

export interface ProximityEntity {
  id: string;
  name: string;
  type: 'player' | 'npc' | 'companion' | 'mob' | 'wildlife' | 'scripted_object';
  isMachine: boolean;  // true = AI/NPC, false = human player
  isAlive: boolean;
  bearing: number;     // 0-360 degrees (0=North, 90=East, 180=South, 270=West)
  elevation: number;   // -90 to 90 degrees (negative=down, positive=up)
  range: number;       // Distance in feet
  // Wildlife-specific (optional)
  speciesId?: string;
  sprite?: string;
}

export interface ProximityChannel {
  count: number;              // Total entities in range
  sample?: string[];          // Present ONLY if count <= 3 (array of entity names for social context)
  entities: ProximityEntity[]; // ALWAYS present - full list with spatial navigation data
  lastSpeaker?: string;       // Present ONLY if count <= 3 and someone spoke recently
}

export interface ProximityRosterMessage {
  type: 'proximity_roster';
  payload: {
    channels: {
      touch: ProximityChannel;   // ~5 feet
      say: ProximityChannel;     // 20 feet
      shout: ProximityChannel;   // 150 feet
      emote: ProximityChannel;   // 150 feet
      see: ProximityChannel;     // 150 feet
      hear: ProximityChannel;    // 150 feet
      cfh: ProximityChannel;     // 250 feet (Call for Help)
    };
    dangerState: boolean;  // true if in combat/danger (gates CFH usage)
  };
  timestamp: number;
}

// ========== Proximity Roster Delta Updates ==========

export interface ProximityEntityDelta {
  id: string;
  bearing?: number;      // Only present if changed
  elevation?: number;    // Only present if changed
  range?: number;        // Only present if changed
}

export interface ProximityChannelDelta {
  added?: ProximityEntity[];     // Entities that entered range
  removed?: string[];            // Entity IDs that left range
  updated?: ProximityEntityDelta[]; // Entities whose position changed
  count?: number;                // New count (if changed)
  sample?: string[];             // New sample array (if changed)
  lastSpeaker?: string | null;   // New lastSpeaker (if changed, null = cleared)
}

export interface ProximityRosterDeltaMessage {
  type: 'proximity_roster_delta';
  payload: {
    channels?: {
      touch?: ProximityChannelDelta;
      say?: ProximityChannelDelta;
      shout?: ProximityChannelDelta;
      emote?: ProximityChannelDelta;
      see?: ProximityChannelDelta;
      hear?: ProximityChannelDelta;
      cfh?: ProximityChannelDelta;
    };
    dangerState?: boolean;  // Only present if changed
  };
  timestamp: number;
}

export type AgeGroup = 'minor' | 'adult';

export interface PlayerPeekRequest {
  type: 'player_peek';
  payload: {
    targetName: string;  // or targetId
  };
}

export interface PlayerPeekResponse {
  type: 'player_peek_response';
  payload: {
    id: string;
    name: string;
    type: 'player' | 'npc' | 'companion';

    // Visual
    appearance: string;         // Description
    equipment?: string[];       // Visible equipment

    // Basic info
    level?: number;
    title?: string;
    guildName?: string;

    // Social context
    ageGroup?: AgeGroup;                    // Coarse, never exact
    pronouns?: string;                       // Player-provided (optional)
    contentAccessLevel?: ContentRating;     // For age-appropriate interaction

    // State
    currentAction?: AnimationAction;     // idle, running, attacking, casting, etc.
    inCombat: boolean;
    afk: boolean;

    // Interaction flags
    interactive: boolean;
    acceptsWhispers: boolean;
    acceptsGroupInvites: boolean;
  };
  timestamp: number;
}

// ========== Inventory ==========

export type EquipSlot =
  | 'head' | 'body' | 'hands' | 'legs' | 'feet'
  | 'necklace' | 'bracelet' | 'ring1' | 'ring2'
  | 'mainhand' | 'offhand'
  | 'mainhand2' | 'offhand2';

export const EQUIP_SLOTS: EquipSlot[] = [
  'head', 'body', 'hands', 'legs', 'feet',
  'necklace', 'bracelet', 'ring1', 'ring2',
  'mainhand', 'offhand', 'mainhand2', 'offhand2',
];

export interface ItemInfo {
  id:           string;
  templateId:   string;
  name:         string;
  description:  string;
  itemType:     string;   // 'weapon', 'armor', 'jewelry', 'consumable', 'misc', etc.
  quantity:     number;
  durability?:  number;
  properties?:  Record<string, unknown>;
  iconUrl?:     string;
  equipped:     boolean;
  equipSlot?:   EquipSlot;
}

export interface InventoryUpdatePayload {
  items:          ItemInfo[];                         // All non-equipped items (inventory)
  equipment:      Partial<Record<EquipSlot, ItemInfo>>; // Currently equipped items by slot
  activeWeaponSet: 1 | 2;
  timestamp:      number;
}

export interface InventoryUpdateMessage {
  type: 'inventory_update';
  payload: InventoryUpdatePayload;
}

export interface EquipItemMessage {
  type: 'equip_item';
  payload: {
    itemId:    string;
    slot:      EquipSlot;
    timestamp: number;
  };
}

export interface UnequipItemMessage {
  type: 'unequip_item';
  payload: {
    slot:      EquipSlot;
    timestamp: number;
  };
}

export interface WeaponSetSwapMessage {
  type: 'weapon_set_swap';
  payload: {
    timestamp: number;
  };
}

// ========== Loot ==========

export interface LootSessionItem {
  id:          string;   // session-scoped UUID for this roll slot
  templateId:  string;
  name:        string;
  itemType:    string;
  description: string;
  iconUrl?:    string;
  quantity:    number;
}

/** Zone → Client: loot session opened (solo or party NWP) */
export interface LootSessionStartPayload {
  sessionId:        string;
  mobName:          string;
  mode:             'solo' | 'party';
  items:            LootSessionItem[];
  gold:             number;           // total gold dropped
  goldPerMember:    number;           // floor(gold / partySize), 0 for solo
  expiresAt:        number;           // ms timestamp; party only (0 for solo)
}

/** Zone → Client: one item in a party session resolved */
export interface LootItemResultPayload {
  sessionId:  string;
  itemId:     string;
  itemName:   string;
  winnerId:   string | null;    // null = all passed
  winnerName: string | null;
  winRoll:    'need' | 'want' | null;
  rollValue:  number;           // 1–100 shown for party flavour
}

/** Zone → Client: party loot session fully resolved */
export interface LootSessionEndPayload {
  sessionId: string;
}

/** Client → Zone: cast a vote for one item in a party session */
export interface LootRollMessage {
  type: 'loot_roll';
  payload: {
    sessionId: string;
    itemId:    string;
    roll:      'need' | 'want' | 'pass';
  };
}

// ========== Script Editor ==========

/** Server → Client: open the script editor modal */
export interface EditorOpenMessage {
  type: 'editor_open';
  payload: {
    editorId: string;    // Unique session ID for this editing session
    objectId: string;
    objectName: string;
    verb: string;        // Verb being edited (e.g. "light", "onHeartbeat")
    source: string;      // Current Lua source
    language: 'lua';
    readOnly: boolean;
    version: number;     // Display-only version counter
    origin: 'edit' | 'ai' | 'template' | 'undo'; // How the editor was opened
  };
}

/** Client → Server: save script (compile + persist + hot-swap) */
export interface EditorSaveMessage {
  type: 'editor_save';
  payload: {
    editorId: string;
    source: string;
  };
}

/** Client → Server: compile-only check (no persist, no hot-swap) */
export interface EditorCompileMessage {
  type: 'editor_compile';
  payload: {
    editorId: string;
    source: string;
  };
}

/** Client → Server: revert to last saved source */
export interface EditorRevertMessage {
  type: 'editor_revert';
  payload: {
    editorId: string;
  };
}

/** Server → Client: result of save or compile */
export interface EditorResultMessage {
  type: 'editor_result';
  payload: {
    editorId: string;
    success: boolean;
    version?: number;    // New version number (on successful save only)
    errors: Array<{ line?: number; col?: number; message: string }>;
    warnings: Array<{ line?: number; message: string }>;
  };
}

/** Client → Server: close the editor */
export interface EditorCloseMessage {
  type: 'editor_close';
  payload: {
    editorId: string;
  };
}

// ========== Union Type for All Messages ==========

export type ClientMessage =
  | HandshakeMessage
  | AuthMessage
  | EquipItemMessage
  | UnequipItemMessage
  | WeaponSetSwapMessage
  | LootRollMessage
  | AuthNameConfirmedMessage
  | CharacterSelectMessage
  | CharacterCreateMessage
  | CharacterNameConfirmedMessage
  | CharacterDeleteMessage
  | CharacterUpdateMessage
  | CharacterListRequestMessage
  | MoveMessage
  | ChatMessage
  | InteractMessage
  | CombatActionMessage
  | CommandMessage
  | InhabitRequestMessage
  | InhabitReleaseMessage
  | InhabitPingMessage
  | InhabitChatMessage
  | ProximityRefreshMessage
  | PingMessage
  | DisconnectMessage
  | PlayerPeekRequest
  | EditorSaveMessage
  | EditorCompileMessage
  | EditorRevertMessage
  | EditorCloseMessage;

export type ServerMessage =
  | HandshakeAckMessage
  | InventoryUpdateMessage
  | AuthSuccessMessage
  | AuthErrorMessage
  | AuthConfirmNameMessage
  | CharacterListMessage
  | CharacterConfirmNameMessage
  | CharacterRosterDeltaMessage
  | CharacterErrorMessage
  | WorldEntryMessage
  | StateUpdateMessage
  | EventMessage
  | PongMessage
  | ErrorMessage
  | ProximityRosterMessage
  | ProximityRosterDeltaMessage
  | CommunicationReceived
  | PlayerPeekResponse
  | InhabitGrantedMessage
  | InhabitDeniedMessage
  | InhabitRevokedMessage
  | CorruptionUpdateMessage
  | EditorOpenMessage
  | EditorResultMessage
  | GuildUpdateMessage
  | GuildMemberListMessage
  | GuildInviteMessage
  | GuildChatReceivedMessage
  | GuildFoundingNarrativeMessage
  | BeaconUpdateMessage
  | BeaconAlertMessage
  | LibraryStatusMessage
  | LibraryAssaultAlertMessage;

// ========== Guild System ==========

export interface GuildUpdateMessage {
  type: 'guild_update';
  payload: {
    guildId: string;
    name: string;
    tag: string;
    description: string;
    motto: string;
    memberCount: number;
    maxBeacons: number;
    litBeaconCount: number;
    isGuildmaster: boolean;
    bonuses: {
      corruptionResistPercent: number;
      xpBonusPercent: number;
    };
  };
}

export interface GuildMemberListMessage {
  type: 'guild_member_list';
  payload: {
    guildId: string;
    guildTag: string;
    members: Array<{
      characterId: string;
      characterName: string;
      isGuildmaster: boolean;
      isOnline: boolean;
      joinedAt: number;
    }>;
  };
}

export interface GuildInviteMessage {
  type: 'guild_invite';
  payload: {
    guildId: string;
    guildName: string;
    guildTag: string;
    inviterId: string;
    inviterName: string;
  };
}

export interface GuildChatReceivedMessage {
  type: 'guild_chat';
  payload: {
    senderId: string;
    senderName: string;
    message: string;
    timestamp: number;
  };
}

export interface GuildFoundingNarrativeMessage {
  type: 'guild_founding_narrative';
  payload: {
    step: number;
    totalSteps: number;
    narrative: string;
  };
}

// ========== Beacon System ==========

export interface BeaconUpdateMessage {
  type: 'beacon_update';
  payload: {
    beaconId: string;
    worldPointName: string;
    tier: number;
    isLit: boolean;
    fuelRemaining: number;
    fuelCapacity: number;
    emberClockStartedAt: number | null;
    position: { x: number; y: number; z: number };
    zoneId: string;
    guildId: string;
    guildTag: string;
  };
}

export interface BeaconAlertMessage {
  type: 'beacon_alert';
  payload: {
    beaconId: string;
    alertType: 'LOW_FUEL' | 'CRITICAL_FUEL' | 'EXTINGUISHED' | 'RELIT';
    hoursRemaining: number;
    message: string;
    timestamp: number;
  };
}

// ========== Library Beacons ==========

export interface LibraryStatusMessage {
  type: 'library_status';
  payload: {
    libraryId: string;
    name: string;
    isOnline: boolean;
    offlineUntil: number | null;
    offlineReason: string | null;
    catchmentRadius: number;
    guildBeaconsInCatchment: number;
    position: { x: number; y: number; z: number };
  };
}

export interface LibraryAssaultAlertMessage {
  type: 'library_assault';
  payload: {
    libraryId: string;
    libraryName: string;
    assaultType: string;
    phase: 'started' | 'defended' | 'failed';
    defenderCount: number;
    message: string;
    timestamp: number;
  };
}
