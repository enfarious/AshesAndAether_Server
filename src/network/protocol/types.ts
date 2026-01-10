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

export type AuthMethod = 'guest' | 'credentials' | 'token';

export interface AuthMessage {
  type: 'auth';
  payload: {
    method: AuthMethod;
    guestName?: string;
    username?: string;
    password?: string;
    token?: string;
  };
}

export interface CharacterInfo {
  id: string;
  name: string;
  level: number;
  lastPlayed: number;
  location: string;
}

export interface AuthSuccessMessage {
  type: 'auth_success';
  payload: {
    accountId: string;
    token: string;
    characters: CharacterInfo[];
    canCreateCharacter: boolean;
    maxCharacters: number;
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

// ========== Character Selection/Creation ==========

export interface CharacterSelectMessage {
  type: 'character_select';
  payload: {
    characterId: string;
  };
}

export interface CharacterCreateMessage {
  type: 'character_create';
  payload: {
    name: string;
    appearance: {
      description: string;
    };
    // Additional character creation data can be added here
  };
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

  // Progression
  unlockedFeats: string[];  // Array of feat IDs
  unlockedAbilities: string[];  // Array of ability IDs

  // Loadouts (8 active, 8 passive, 4 special)
  activeLoadout: string[];  // 8 ability IDs
  passiveLoadout: string[];  // 8 ability IDs
  specialLoadout: string[];  // 4 ability IDs (from equipment)
}

export interface ZoneInfo {
  id: string;
  name: string;
  description: string;
  weather: string;
  timeOfDay: string;
  lighting: string;
  contentRating: ContentRating;  // Zone's content rating
}

export interface Entity {
  id: string;
  type: string;
  name: string;
  position: Vector3;
  description: string;
  interactive?: boolean;
  hostile?: boolean;
  animation?: string;
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

export interface StateUpdateMessage {
  type: 'state_update';
  payload: {
    timestamp: number;
    entities?: EntityUpdates;
    character?: {
      health?: { current: number; max: number };
      stamina?: { current: number; max: number };
      effects?: StatusEffect[];
    };
    zone?: Partial<ZoneInfo>;
  };
}

// ========== Player Actions ==========

export type MoveMethod = 'heading' | 'position' | 'compass';
export type MovementSpeed = 'walk' | 'jog' | 'run' | 'stop';
export type CompassDirection = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

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

export type CommunicationChannel = 'say' | 'shout' | 'emote' | 'cfh' | 'whisper' | 'party' | 'world';

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
    senderType: 'player' | 'npc' | 'companion';
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

export interface ProximityChannel {
  count: number;              // Total entities in range
  sample?: string[];          // Present ONLY if count <= 3 (array of entity names)
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
    currentAction?: string;     // "standing", "sitting", "fighting"
    inCombat: boolean;
    afk: boolean;

    // Interaction flags
    interactive: boolean;
    acceptsWhispers: boolean;
    acceptsGroupInvites: boolean;
  };
  timestamp: number;
}

// ========== Union Type for All Messages ==========

export type ClientMessage =
  | HandshakeMessage
  | AuthMessage
  | CharacterSelectMessage
  | CharacterCreateMessage
  | MoveMessage
  | ChatMessage
  | InteractMessage
  | CombatActionMessage
  | PingMessage
  | DisconnectMessage
  | PlayerPeekRequest;

export type ServerMessage =
  | HandshakeAckMessage
  | AuthSuccessMessage
  | AuthErrorMessage
  | WorldEntryMessage
  | StateUpdateMessage
  | EventMessage
  | PongMessage
  | ErrorMessage
  | ProximityRosterMessage
  | CommunicationReceived
  | PlayerPeekResponse;
