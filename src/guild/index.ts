// ── Guild System Barrel Exports ──

// Services
export { GuildService, type GuildCreateResult, type GuildMemberResult, type GuildInfoResult } from './GuildService';
export {
  GuildBeaconService,
  type BeaconLightResult,
  type BeaconFuelResult,
  type BeaconInfo,
  type BeaconStateChange,
} from './GuildBeaconService';
export {
  LibraryBeaconService,
  type AssaultType,
  type LibraryInfo,
} from './LibraryBeaconService';

// Tick Systems
export {
  EmberClockSystem,
  getEmberClockSystem,
  resetEmberClockSystem,
  type BeaconStateChangeCallback,
  type EmberClockAnnouncementCallback,
} from './EmberClockSystem';
export {
  LibraryAssaultSystem,
  getLibraryAssaultSystem,
  resetLibraryAssaultSystem,
  type AssaultStartCallback,
  type AssaultResolvedCallback,
} from './LibraryAssaultSystem';

// Founding Ceremony
export {
  FoundingCeremonyManager,
  type CeremonyState,
  type NarrativeStep,
  type NarrativeCallback,
  type CeremonyCompleteCallback,
} from './FoundingCeremony';

// Guild Chat
export {
  GuildChatBridge,
  type GuildChatPayload,
  type GuildChatDeliveryCallback,
} from './GuildChatBridge';

// Geometry
export {
  computeConvexHull,
  isPointInPolygon,
  polygonsOverlap,
  computePolygonArea,
  interpolatePolygonTier,
  distance2D,
  type Point2D,
  type TieredPoint,
} from './geometry';
