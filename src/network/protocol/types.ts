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

export interface CharacterState {
  id: string;
  name: string;
  position: Vector3;
  rotation: Vector3;
  health: { current: number; max: number };
  stamina: { current: number; max: number };
  stats: Record<string, number>;
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

export type MoveMethod = 'direction' | 'position' | 'path';

export interface MoveMessage {
  type: 'move';
  payload: {
    method: MoveMethod;
    direction?: string; // For text clients
    position?: Vector3; // For graphical clients
    timestamp: number;
  };
}

export type ChatChannel = 'say' | 'yell' | 'whisper' | 'party' | 'world';

export interface ChatMessage {
  type: 'chat';
  payload: {
    channel: ChatChannel;
    message: string;
    target?: string; // For whispers
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
  | DisconnectMessage;

export type ServerMessage =
  | HandshakeAckMessage
  | AuthSuccessMessage
  | AuthErrorMessage
  | WorldEntryMessage
  | StateUpdateMessage
  | EventMessage
  | PongMessage
  | ErrorMessage;
