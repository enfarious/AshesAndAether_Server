/**
 * WeatherBridge — translates the game server's built-in weather system
 * into the WeatherSnapshot format expected by the wildlife sim and
 * publishes it to Redis.
 *
 * The wildlife sim subscribes to `weather:zone:{zoneId}` (pubsub) and
 * primes its cache from `weather:snapshot:{zoneId}` (key).
 *
 * This bridge acts as the fallback weather provider. If a dedicated
 * weather microservice is later added, it would publish to the same
 * channels and this bridge would defer (similar to ClimateBridge).
 */

import { logger } from '@/utils/logger';
import type { RedisClientType } from 'redis';
import { randomUUID } from 'crypto';

// ── Types matching the wildlife sim's WeatherSnapshot ──────────────────────
// Rust expects:  WeatherEvent { event_type: WeatherEventType, ... }
// where WeatherEventType is #[serde(tag = "type")] — so event_type is an
// object with a "type" discriminator plus variant-specific fields.

type WeatherEventType =
  | { type: 'Storm';   intensity: number; radius: number }
  | { type: 'Tornado'; intensity: number; radius: number; direction: number; speed: number }
  | { type: 'Rain';    intensity: number; duration_seconds: number }
  | { type: 'Wind';    speed: number; direction: number; gust_factor: number }
  | { type: 'Fog';     density: number; visibility: number };

interface WeatherEvent {
  id: string;
  event_type: WeatherEventType;
  position: [number, number, number];
  start_time_ms: number;
  duration_ms: number;
  is_active: boolean;
}

interface WeatherSnapshot {
  zone_id: string;
  timestamp_ms: number;
  active_events: WeatherEvent[];
  base_wind_speed: number;
  base_wind_direction: number;
  precipitation: number;
  cloud_cover: number;
  visibility: number;
}

// ── Mapping from server weather strings to snapshot values ──────────────────

interface WeatherProfile {
  precipitation: number;
  cloud_cover: number;
  visibility: number;
  base_wind_speed: number;
}

const WEATHER_PROFILES: Record<string, WeatherProfile> = {
  clear:  { precipitation: 0.0,  cloud_cover: 0.1,  visibility: 1.0,  base_wind_speed: 1.0 },
  cloudy: { precipitation: 0.0,  cloud_cover: 0.6,  visibility: 0.85, base_wind_speed: 2.0 },
  fog:    { precipitation: 0.0,  cloud_cover: 0.8,  visibility: 0.25, base_wind_speed: 0.5 },
  mist:   { precipitation: 0.05, cloud_cover: 0.5,  visibility: 0.5,  base_wind_speed: 0.8 },
  rain:   { precipitation: 0.6,  cloud_cover: 0.85, visibility: 0.6,  base_wind_speed: 3.0 },
  storm:  { precipitation: 0.9,  cloud_cover: 0.95, visibility: 0.3,  base_wind_speed: 8.0 },
};

// ── WeatherBridge class ────────────────────────────────────────────────────

export class WeatherBridge {
  private lastWeather: string = '';
  private lastPublishMs: number = 0;
  private windDirection: number = Math.random() * 360;
  private stormEvent: WeatherEvent | null = null;

  /** Minimum interval between publishes (ms). */
  private static readonly MIN_PUBLISH_INTERVAL = 5000;
  /** Force a refresh publish even if nothing changed (ms). */
  private static readonly FORCE_REFRESH_INTERVAL = 30000;
  /** Don't check external sim more than once every 10 seconds. */
  private static readonly EXTERNAL_CHECK_INTERVAL = 10000;
  /** If the external sim's snapshot is older than this, consider it dead. */
  private static readonly EXTERNAL_STALE_THRESHOLD = 15000;

  private publishCount: number = 0;
  private externalSimActive: boolean = false;
  private lastExternalCheckMs: number = 0;

  constructor(
    private zoneId: string,
    private redisClient: RedisClientType,
    private boundsMin: { x: number; z: number },
    private boundsMax: { x: number; z: number },
  ) {
    logger.info({ zoneId }, 'WeatherBridge: created for zone');
  }

  /**
   * Called each server tick with the current weather string from ZoneManager.
   * Publishes to Redis when weather changes or on a periodic refresh.
   */
  async tick(weather: string): Promise<void> {
    const now = Date.now();

    // Periodically check if an external weather sim is publishing
    if (now - this.lastExternalCheckMs > WeatherBridge.EXTERNAL_CHECK_INTERVAL) {
      this.lastExternalCheckMs = now;
      await this.checkExternalSim(now);
    }

    // If external sim is active, stay silent (defer)
    if (this.externalSimActive) return;

    const changed = weather !== this.lastWeather;
    const stale = now - this.lastPublishMs > WeatherBridge.FORCE_REFRESH_INTERVAL;

    if (!changed && !stale) return;
    if (now - this.lastPublishMs < WeatherBridge.MIN_PUBLISH_INTERVAL) return;

    this.lastWeather = weather;
    this.lastPublishMs = now;

    // Slowly drift wind direction
    this.windDirection = (this.windDirection + (Math.random() - 0.5) * 10 + 360) % 360;

    const snapshot = this.buildSnapshot(weather, now);
    const json = JSON.stringify(snapshot);

    try {
      await Promise.all([
        this.redisClient.publish(`weather:zone:${this.zoneId}`, json),
        this.redisClient.set(`weather:snapshot:${this.zoneId}`, json),
      ]);
      this.publishCount++;
      if (this.publishCount === 1) {
        logger.info({ zoneId: this.zoneId, weather },
          'WeatherBridge: first weather snapshot published');
      }
    } catch (err) {
      logger.warn({ err, zoneId: this.zoneId }, 'WeatherBridge: failed to publish');
    }
  }

  private async checkExternalSim(now: number): Promise<void> {
    try {
      const raw = await this.redisClient.get(`weather:snapshot:${this.zoneId}`);
      if (raw) {
        const snapshot = JSON.parse(raw) as { timestamp_ms?: number };
        if (snapshot.timestamp_ms && now - snapshot.timestamp_ms < WeatherBridge.EXTERNAL_STALE_THRESHOLD) {
          if (!this.externalSimActive) {
            logger.info({ zoneId: this.zoneId },
              'WeatherBridge: external weather sim detected, deferring');
          }
          this.externalSimActive = true;
          return;
        }
      }
    } catch {
      // Redis read failure — fall through and act as provider
    }

    if (this.externalSimActive) {
      logger.info({ zoneId: this.zoneId },
        'WeatherBridge: external weather sim gone, taking over');
    }
    this.externalSimActive = false;
  }

  private buildSnapshot(weather: string, now: number): WeatherSnapshot {
    const profile = WEATHER_PROFILES[weather] ?? WEATHER_PROFILES.clear;
    const events: WeatherEvent[] = [];

    // Generate storm event when weather is 'storm'
    if (weather === 'storm') {
      if (!this.stormEvent || !this.stormEvent.is_active) {
        // New storm — place it randomly within zone bounds
        const cx = this.boundsMin.x + Math.random() * (this.boundsMax.x - this.boundsMin.x);
        const cz = this.boundsMin.z + Math.random() * (this.boundsMax.z - this.boundsMin.z);
        this.stormEvent = {
          id: `storm_${randomUUID().slice(0, 8)}`,
          event_type: { type: 'Storm', intensity: 0.6 + Math.random() * 0.4, radius: 30 + Math.random() * 50 },
          position: [cx, 0, cz],
          start_time_ms: now,
          duration_ms: 60000 + Math.random() * 180000, // 1–4 minutes
          is_active: true,
        };
      }
      // Check if storm expired
      if (now - this.stormEvent.start_time_ms > this.stormEvent.duration_ms) {
        this.stormEvent.is_active = false;
      }
      if (this.stormEvent.is_active) {
        events.push(this.stormEvent);
      }
    } else {
      // Not storming — clear any old storm
      if (this.stormEvent) {
        this.stormEvent.is_active = false;
        this.stormEvent = null;
      }
    }

    // Rain event
    if (weather === 'rain' || weather === 'storm') {
      events.push({
        id: `rain_${this.zoneId}`,
        event_type: { type: 'Rain', intensity: weather === 'storm' ? 0.9 : 0.5, duration_seconds: 300 },
        position: [0, 0, 0],
        start_time_ms: now,
        duration_ms: 300000,
        is_active: true,
      });
    }

    // Fog event
    if (weather === 'fog' || weather === 'mist') {
      events.push({
        id: `fog_${this.zoneId}`,
        event_type: { type: 'Fog', density: weather === 'fog' ? 0.8 : 0.4, visibility: weather === 'fog' ? 0.25 : 0.5 },
        position: [0, 0, 0],
        start_time_ms: now,
        duration_ms: 300000,
        is_active: true,
      });
    }

    // Wind event (always present, varies by weather)
    events.push({
      id: `wind_${this.zoneId}`,
      event_type: { type: 'Wind', speed: profile.base_wind_speed, direction: this.windDirection, gust_factor: weather === 'storm' ? 2.5 : 1.2 },
      position: [0, 0, 0],
      start_time_ms: now,
      duration_ms: 300000,
      is_active: true,
    });

    return {
      zone_id: this.zoneId,
      timestamp_ms: now,
      active_events: events,
      base_wind_speed: profile.base_wind_speed,
      base_wind_direction: this.windDirection,
      precipitation: profile.precipitation,
      cloud_cover: profile.cloud_cover,
      visibility: profile.visibility,
    };
  }
}
