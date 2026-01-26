import * as fs from 'fs';
import * as path from 'path';

// Corruption state thresholds
export type CorruptionState = 'CLEAN' | 'STAINED' | 'WARPED' | 'LOST';

// Zone tags that affect corruption gain
export type ZoneCorruptionTag =
  | 'WILDS'
  | 'RUINS_CITY_EDGE'
  | 'OLD_CITY_CORE'
  | 'MOUNTAIN_HOLD'
  | 'DEEP_LAB'
  | 'WARD_ZONE'
  | 'CURSED_RESORT'
  | 'DEEP_ROADS';

// Community object types that count as "in community"
export type CommunityObjectType =
  | 'CAMPFIRE'
  | 'SHRINE'
  | 'MARKET'
  | 'COMMUNITY_CENTER'
  | 'TAVERN'
  | 'GARDEN_PLOT';

// Forbidden action event types
export type ForbiddenActionType =
  | 'BETRAYAL_PK_ALLY'
  | 'LOOT_COMMUNITY_STORE'
  | 'DEEP_LAB_ARTIFACT_ACTIVATE'
  | 'AETHER_SIPHON_RITUAL'
  | 'INSTALL_FORBIDDEN_AUGMENT';

// Contribution source types
export type ContributionSourceType =
  | 'DONATE_TO_TOWN_STORAGE'
  | 'REPAIR_STRUCTURE'
  | 'BUILD_STRUCTURE'
  | 'CRAFT_FOR_OTHER_PLAYER_CONFIRMED'
  | 'ESCORT_MISSION_COMPLETE'
  | 'RESCUE_MISSION_COMPLETE';

// Config interfaces matching corruption-config.example.json
export interface CorruptionStateThreshold {
  name: CorruptionState;
  min: number;
  max: number;
}

export interface ZoneTagConfig {
  corruption_per_minute: number;
  night_multiplier?: number;
  notes?: string;
}

// Party field reduction thresholds
export interface PartyReductionThreshold {
  min_members: number;
  reduction_percent: number;
  notes?: string;
}

// Party field reduction config
export interface PartyFieldReductionConfig {
  enabled: boolean;
  applies_to: string[];  // ["zone", "isolation", "entity_exposure"]
  excludes: string[];    // ["wealth", "forbidden_actions"]
  thresholds: PartyReductionThreshold[];
}

// Time of day config
export interface TimeOfDayConfig {
  enabled: boolean;
  night_hours: {
    start: number;  // Hour (0-23)
    end: number;    // Hour (0-23)
  };
  notes?: string;
}

export interface CommunityDetectionConfig {
  settlement_boundary_enabled: boolean;
  nearby_player_radius_meters: number;
  nearby_player_min_count: number;
  community_object_radius_meters: number;
  community_object_types: CommunityObjectType[];
}

export interface IsolationRampEntry {
  after_minutes_isolated: number;
  corruption_per_minute: number;
}

export interface IsolationConfig {
  grace_minutes: number;
  ramp: IsolationRampEntry[];
}

export interface WealthBand {
  min_multiplier_of_threshold: number;
  max_multiplier_of_threshold: number | null;
  corruption_per_minute: number;
}

export interface WealthConfig {
  enabled: boolean;
  wealth_score_cache_seconds: number;
  threshold: number;
  bands: WealthBand[];
}

export interface ContributionConversion {
  points: number;
  corruption_delta: number;
}

export interface ContributionBuffConfig {
  enabled: boolean;
  per_award_multiplier: number;
  duration_seconds: number;
}

export interface ContributionConfig {
  enabled: boolean;
  points_to_corruption_reduction: ContributionConversion;
  wealth_gain_multiplier_buff: ContributionBuffConfig;
  sources: ContributionSourceType[];
}

export interface ForbiddenActionEvent {
  event_type: ForbiddenActionType;
  corruption_add: number;
}

export interface ForbiddenActionsConfig {
  enabled: boolean;
  events: ForbiddenActionEvent[];
}

export interface CorruptionBenefitBand {
  state: CorruptionState;
  cache_detection_bonus_pct: number;
  hazard_resist_bonus_pct: number;
  dead_system_interface: boolean;
}

export interface BenefitsConfig {
  enabled: boolean;
  bands: CorruptionBenefitBand[];
}

export interface TownPricingByState {
  CLEAN: number | null;
  STAINED: number | null;
  WARPED: number | null;
  LOST: number | null;
}

export interface TownRuleSet {
  max_corruption_allowed?: number;
  min_corruption_required?: number;
  pricing_multiplier_by_state: TownPricingByState;
  refuse_service_if_lost?: boolean;
  cleansing_available?: boolean;
}

export interface TownRulesConfig {
  enabled: boolean;
  default_goodly_town: TownRuleSet;
  neutral_trade_town: TownRuleSet;
  corrupted_camp: TownRuleSet;
}

export interface DebugConfig {
  audit_events_enabled: boolean;
  audit_sample_rate: number;
  log_zone_changes: boolean;
}

export interface SystemConfig {
  name: string;
  version: string;
  tick_interval_seconds: number;
  corruption_min: number;
  corruption_max: number;
}

// Full config structure
export interface CorruptionConfig {
  system: SystemConfig;
  thresholds: {
    states: CorruptionStateThreshold[];
  };
  zone_tags: Record<ZoneCorruptionTag, ZoneTagConfig>;
  party_field_reduction: PartyFieldReductionConfig;
  time_of_day: TimeOfDayConfig;
  community_detection: CommunityDetectionConfig;
  isolation: IsolationConfig;
  wealth: WealthConfig;
  contribution: ContributionConfig;
  forbidden_actions: ForbiddenActionsConfig;
  benefits: BenefitsConfig;
  town_rules: TownRulesConfig;
  debug: DebugConfig;
}

// Default config values (fallback if file not found)
const DEFAULT_CONFIG: CorruptionConfig = {
  system: {
    name: 'Ashes & Aether Corruption System',
    version: '1.0',
    tick_interval_seconds: 60,
    corruption_min: 0,
    corruption_max: 100,
  },
  thresholds: {
    states: [
      { name: 'CLEAN', min: 0, max: 24 },
      { name: 'STAINED', min: 25, max: 49 },
      { name: 'WARPED', min: 50, max: 74 },
      { name: 'LOST', min: 75, max: 100 },
    ],
  },
  zone_tags: {
    WILDS: { corruption_per_minute: 0.0, night_multiplier: 1.0 },
    RUINS_CITY_EDGE: { corruption_per_minute: 0.02, night_multiplier: 1.5 },
    OLD_CITY_CORE: { corruption_per_minute: 0.06, night_multiplier: 1.5 },
    MOUNTAIN_HOLD: { corruption_per_minute: 0.10, night_multiplier: 1.5 },
    DEEP_LAB: { corruption_per_minute: 0.18, night_multiplier: 1.0 },
    WARD_ZONE: { corruption_per_minute: -0.05, night_multiplier: 1.0 },
    CURSED_RESORT: { corruption_per_minute: 0.04, night_multiplier: 2.5 },
    DEEP_ROADS: { corruption_per_minute: 0.12, night_multiplier: 1.0 },
  },
  party_field_reduction: {
    enabled: true,
    applies_to: ['zone', 'isolation', 'entity_exposure'],
    excludes: ['wealth', 'forbidden_actions'],
    thresholds: [
      { min_members: 2, reduction_percent: 10 },
      { min_members: 3, reduction_percent: 30 },
      { min_members: 4, reduction_percent: 50 },
      { min_members: 5, reduction_percent: 70 },
    ],
  },
  time_of_day: {
    enabled: true,
    night_hours: { start: 20, end: 6 },
  },
  community_detection: {
    settlement_boundary_enabled: true,
    nearby_player_radius_meters: 35.0,
    nearby_player_min_count: 3,
    community_object_radius_meters: 25.0,
    community_object_types: ['CAMPFIRE', 'SHRINE', 'MARKET', 'COMMUNITY_CENTER', 'TAVERN', 'GARDEN_PLOT'],
  },
  isolation: {
    grace_minutes: 10,
    ramp: [
      { after_minutes_isolated: 10, corruption_per_minute: 0.01 },
      { after_minutes_isolated: 30, corruption_per_minute: 0.02 },
      { after_minutes_isolated: 120, corruption_per_minute: 0.03 },
    ],
  },
  wealth: {
    enabled: true,
    wealth_score_cache_seconds: 300,
    threshold: 10000,
    bands: [
      { min_multiplier_of_threshold: 0, max_multiplier_of_threshold: 1, corruption_per_minute: 0.0 },
      { min_multiplier_of_threshold: 1, max_multiplier_of_threshold: 2, corruption_per_minute: 0.01 },
      { min_multiplier_of_threshold: 2, max_multiplier_of_threshold: 5, corruption_per_minute: 0.03 },
      { min_multiplier_of_threshold: 5, max_multiplier_of_threshold: null, corruption_per_minute: 0.06 },
    ],
  },
  contribution: {
    enabled: true,
    points_to_corruption_reduction: { points: 100, corruption_delta: -1.0 },
    wealth_gain_multiplier_buff: { enabled: true, per_award_multiplier: 0.9, duration_seconds: 86400 },
    sources: [
      'DONATE_TO_TOWN_STORAGE',
      'REPAIR_STRUCTURE',
      'BUILD_STRUCTURE',
      'CRAFT_FOR_OTHER_PLAYER_CONFIRMED',
      'ESCORT_MISSION_COMPLETE',
      'RESCUE_MISSION_COMPLETE',
    ],
  },
  forbidden_actions: {
    enabled: true,
    events: [
      { event_type: 'BETRAYAL_PK_ALLY', corruption_add: 5 },
      { event_type: 'LOOT_COMMUNITY_STORE', corruption_add: 8 },
      { event_type: 'DEEP_LAB_ARTIFACT_ACTIVATE', corruption_add: 10 },
      { event_type: 'AETHER_SIPHON_RITUAL', corruption_add: 12 },
      { event_type: 'INSTALL_FORBIDDEN_AUGMENT', corruption_add: 15 },
    ],
  },
  benefits: {
    enabled: true,
    bands: [
      { state: 'CLEAN', cache_detection_bonus_pct: 0, hazard_resist_bonus_pct: 0, dead_system_interface: false },
      { state: 'STAINED', cache_detection_bonus_pct: 5, hazard_resist_bonus_pct: 0, dead_system_interface: false },
      { state: 'WARPED', cache_detection_bonus_pct: 15, hazard_resist_bonus_pct: 10, dead_system_interface: true },
      { state: 'LOST', cache_detection_bonus_pct: 30, hazard_resist_bonus_pct: 25, dead_system_interface: true },
    ],
  },
  town_rules: {
    enabled: true,
    default_goodly_town: {
      max_corruption_allowed: 50,
      pricing_multiplier_by_state: { CLEAN: 1.0, STAINED: 1.1, WARPED: 1.3, LOST: null },
      refuse_service_if_lost: true,
      cleansing_available: true,
    },
    neutral_trade_town: {
      max_corruption_allowed: 75,
      pricing_multiplier_by_state: { CLEAN: 1.0, STAINED: 1.05, WARPED: 1.15, LOST: 1.35 },
      refuse_service_if_lost: false,
      cleansing_available: false,
    },
    corrupted_camp: {
      min_corruption_required: 50,
      pricing_multiplier_by_state: { CLEAN: null, STAINED: null, WARPED: 1.0, LOST: 0.9 },
      cleansing_available: false,
    },
  },
  debug: {
    audit_events_enabled: true,
    audit_sample_rate: 1.0,
    log_zone_changes: true,
  },
};

// Singleton config instance
let loadedConfig: CorruptionConfig | null = null;

/**
 * Load corruption config from JSON file
 * Falls back to defaults if file not found or invalid
 */
export function loadCorruptionConfig(configPath?: string): CorruptionConfig {
  const filePath = configPath || process.env.CORRUPTION_CONFIG_PATH || './config/corruption.json';

  try {
    const resolvedPath = path.resolve(filePath);
    const rawData = fs.readFileSync(resolvedPath, 'utf-8');
    const parsed = JSON.parse(rawData) as CorruptionConfig;

    // Basic validation
    if (!parsed.system || !parsed.thresholds || !parsed.zone_tags) {
      console.warn(`[CorruptionConfig] Invalid config structure in ${resolvedPath}, using defaults`);
      loadedConfig = DEFAULT_CONFIG;
      return DEFAULT_CONFIG;
    }

    console.log(`[CorruptionConfig] Loaded config from ${resolvedPath} (v${parsed.system.version})`);
    loadedConfig = parsed;
    return parsed;
  } catch (error) {
    console.warn(`[CorruptionConfig] Could not load config from ${filePath}, using defaults:`, error);
    loadedConfig = DEFAULT_CONFIG;
    return DEFAULT_CONFIG;
  }
}

/**
 * Get the currently loaded config (loads defaults if not yet loaded)
 */
export function getCorruptionConfig(): CorruptionConfig {
  if (!loadedConfig) {
    return loadCorruptionConfig();
  }
  return loadedConfig;
}

/**
 * Reload config from disk (for hot reload)
 */
export function reloadCorruptionConfig(configPath?: string): CorruptionConfig {
  loadedConfig = null;
  return loadCorruptionConfig(configPath);
}

/**
 * Get corruption state from numeric value
 */
export function getCorruptionState(corruption: number): CorruptionState {
  const config = getCorruptionConfig();
  const clamped = Math.max(config.system.corruption_min, Math.min(config.system.corruption_max, corruption));

  for (const state of config.thresholds.states) {
    if (clamped >= state.min && clamped <= state.max) {
      return state.name;
    }
  }

  // Fallback (should never happen with valid config)
  return 'CLEAN';
}

/**
 * Get zone corruption gain per minute
 */
export function getZoneCorruptionRate(zoneTag: string): number {
  const config = getCorruptionConfig();
  const tagConfig = config.zone_tags[zoneTag as ZoneCorruptionTag];
  return tagConfig?.corruption_per_minute ?? 0;
}

/**
 * Get isolation corruption rate based on minutes isolated
 */
export function getIsolationCorruptionRate(minutesIsolated: number): number {
  const config = getCorruptionConfig();

  if (minutesIsolated < config.isolation.grace_minutes) {
    return 0;
  }

  // Find highest applicable ramp entry
  let rate = 0;
  for (const entry of config.isolation.ramp) {
    if (minutesIsolated >= entry.after_minutes_isolated) {
      rate = entry.corruption_per_minute;
    }
  }

  return rate;
}

/**
 * Get wealth corruption rate based on wealth score
 */
export function getWealthCorruptionRate(wealthScore: number): number {
  const config = getCorruptionConfig();

  if (!config.wealth.enabled) {
    return 0;
  }

  const threshold = config.wealth.threshold;
  const multiplier = wealthScore / threshold;

  for (const band of config.wealth.bands) {
    const min = band.min_multiplier_of_threshold;
    const max = band.max_multiplier_of_threshold;

    if (multiplier >= min && (max === null || multiplier < max)) {
      return band.corruption_per_minute;
    }
  }

  return 0;
}

/**
 * Get forbidden action corruption spike
 */
export function getForbiddenActionCorruption(eventType: string): number {
  const config = getCorruptionConfig();

  if (!config.forbidden_actions.enabled) {
    return 0;
  }

  const event = config.forbidden_actions.events.find(e => e.event_type === eventType);
  return event?.corruption_add ?? 0;
}

/**
 * Get benefits for a corruption state
 */
export function getCorruptionBenefits(state: CorruptionState): CorruptionBenefitBand | null {
  const config = getCorruptionConfig();

  if (!config.benefits.enabled) {
    return null;
  }

  return config.benefits.bands.find(b => b.state === state) ?? null;
}

/**
 * Clamp corruption to valid range
 */
export function clampCorruption(value: number): number {
  const config = getCorruptionConfig();
  return Math.max(config.system.corruption_min, Math.min(config.system.corruption_max, value));
}

/**
 * Check if current time is night (applies night multipliers)
 */
export function isNightTime(hour?: number): boolean {
  const config = getCorruptionConfig();

  if (!config.time_of_day?.enabled) {
    return false;
  }

  const currentHour = hour ?? new Date().getHours();
  const { start, end } = config.time_of_day.night_hours;

  // Handle overnight spans (e.g., 20-6 means 8pm to 6am)
  if (start > end) {
    return currentHour >= start || currentHour < end;
  }
  return currentHour >= start && currentHour < end;
}

/**
 * Get night multiplier for a zone tag
 */
export function getZoneNightMultiplier(zoneTag: string): number {
  const config = getCorruptionConfig();
  const tagConfig = config.zone_tags[zoneTag as ZoneCorruptionTag];
  return tagConfig?.night_multiplier ?? 1.0;
}

/**
 * Get zone corruption rate with time-of-day modifier
 */
export function getZoneCorruptionRateWithTime(zoneTag: string, hour?: number): number {
  const baseRate = getZoneCorruptionRate(zoneTag);

  if (isNightTime(hour)) {
    const multiplier = getZoneNightMultiplier(zoneTag);
    return baseRate * multiplier;
  }

  return baseRate;
}

/**
 * Get party field corruption reduction multiplier (0.0 to 1.0)
 * Returns 1.0 (no reduction) for solo players
 * Returns 0.3 (70% reduction) for full party of 5
 */
export function getPartyFieldReductionMultiplier(partySize: number): number {
  const config = getCorruptionConfig();

  if (!config.party_field_reduction?.enabled || partySize <= 1) {
    return 1.0; // No reduction for solo
  }

  // Find highest applicable threshold
  let reductionPercent = 0;
  for (const threshold of config.party_field_reduction.thresholds) {
    if (partySize >= threshold.min_members) {
      reductionPercent = threshold.reduction_percent;
    }
  }

  // Convert percent reduction to multiplier (70% reduction = 0.3 multiplier)
  return 1.0 - (reductionPercent / 100);
}

/**
 * Check if a corruption source type is affected by party field reduction
 */
export function isFieldCorruptionSource(sourceType: string): boolean {
  const config = getCorruptionConfig();

  if (!config.party_field_reduction?.enabled) {
    return false;
  }

  // Check if explicitly excluded
  if (config.party_field_reduction.excludes.includes(sourceType)) {
    return false;
  }

  // Check if explicitly included
  return config.party_field_reduction.applies_to.includes(sourceType);
}
