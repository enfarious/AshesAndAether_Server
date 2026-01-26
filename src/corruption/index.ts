// Corruption System exports
export {
  // Config types
  type CorruptionState,
  type ZoneCorruptionTag,
  type CommunityObjectType,
  type ForbiddenActionType,
  type ContributionSourceType,
  type CorruptionConfig,
  type CorruptionStateThreshold,
  type CorruptionBenefitBand,
  type PartyReductionThreshold,
  type PartyFieldReductionConfig,
  type TimeOfDayConfig,

  // Config functions
  loadCorruptionConfig,
  getCorruptionConfig,
  reloadCorruptionConfig,
  getCorruptionState,
  getZoneCorruptionRate,
  getZoneCorruptionRateWithTime,
  getIsolationCorruptionRate,
  getWealthCorruptionRate,
  getForbiddenActionCorruption,
  getCorruptionBenefits,
  clampCorruption,
  isNightTime,
  getZoneNightMultiplier,
  getPartyFieldReductionMultiplier,
  isFieldCorruptionSource,
} from './CorruptionConfig';

export {
  // Service types
  type CorruptionUpdate,
  type CorruptionResult,
  type CharacterCorruptionData,

  // Service class
  CorruptionService,
} from './CorruptionService';

export {
  // System types
  type CorruptionBroadcastCallback,
  type CommunityCheckCallback,
  type PartySizeCallback,
  type ZoneCorruptionData,

  // System class and singleton
  CorruptionSystem,
  getCorruptionSystem,
  resetCorruptionSystem,
} from './CorruptionSystem';
