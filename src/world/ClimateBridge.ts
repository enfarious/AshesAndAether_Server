/**
 * ClimateBridge — translates the game server's built-in day/night cycle
 * into the ClimateSnapshot format expected by the wildlife sim and
 * publishes it to Redis.
 *
 * This bridge DEFERS to `climate_sim` when it is running.  It detects
 * the external sim by checking the freshness of `climate:snapshot:{zoneId}`.
 * If that key was updated within the last 5 seconds, the external sim
 * is considered active and this bridge stays silent.
 *
 * Channels used:
 *   - `climate:zone:{zoneId}`    (pubsub — wildlife sim subscribes here)
 *   - `climate:snapshot:{zoneId}` (key   — cache for initial sync)
 */

import { logger } from '@/utils/logger';
import type { RedisClientType } from 'redis';

// ── Types matching the wildlife sim's ClimateSnapshot ──────────────────────

interface ClimateSnapshot {
  zone_id: string;
  day_of_year: number;
  time_of_day: number;       // 0–24
  year: number;
  season: 'spring' | 'summer' | 'fall' | 'winter';
  temperature: number;        // -1 to 1
  day_length: number;         // hours
  is_night: boolean;
  growth_rate: number;        // 0–1.5
  timestamp: number;          // unix ms
}

// ── ClimateBridge class ────────────────────────────────────────────────────

export class ClimateBridge {
  private lastPublishMs: number = 0;
  private externalSimActive: boolean = false;
  private lastExternalCheckMs: number = 0;
  private publishCount: number = 0;

  /** Don't check external sim more than once every 10 seconds. */
  private static readonly EXTERNAL_CHECK_INTERVAL = 10000;
  /** If the external sim's snapshot is older than this, consider it dead. */
  private static readonly EXTERNAL_STALE_THRESHOLD = 5000;
  /** Publish at ~1 Hz like climate_sim does. */
  private static readonly PUBLISH_INTERVAL = 1000;

  /**
   * Simulated year state.
   * The real climate_sim tracks full years/days. We approximate from
   * timeOfDay (0–1, wraps each 24-min cycle). We count wraps as days.
   */
  private dayCounter: number = 80;  // start late March, like climate_sim default
  private lastTimeOfDay: number = -1;
  private yearCounter: number = 1;

  /** Latitude for temperature calculations (same default as climate_sim). */
  private latitude: number = 42.0;

  constructor(
    private zoneId: string,
    private redisClient: RedisClientType,
  ) {
    logger.info({ zoneId }, 'ClimateBridge: created for zone');
  }

  /**
   * Called each server tick with the normalised time-of-day (0–1) and
   * weather string from ZoneManager.
   */
  async tick(timeOfDayNormalized: number, weather: string): Promise<void> {
    const now = Date.now();

    // Periodically check if climate_sim is running
    if (now - this.lastExternalCheckMs > ClimateBridge.EXTERNAL_CHECK_INTERVAL) {
      this.lastExternalCheckMs = now;
      await this.checkExternalSim(now);
    }

    // If external sim is active, stay silent
    if (this.externalSimActive) return;

    // Throttle to ~1 Hz
    if (now - this.lastPublishMs < ClimateBridge.PUBLISH_INTERVAL) return;
    this.lastPublishMs = now;

    // Track day wraps (timeOfDay goes 0→1 repeating)
    if (this.lastTimeOfDay >= 0 && timeOfDayNormalized < this.lastTimeOfDay - 0.5) {
      this.dayCounter += 1;
      if (this.dayCounter > 365) {
        this.dayCounter = 1;
        this.yearCounter += 1;
      }
    }
    this.lastTimeOfDay = timeOfDayNormalized;

    const snapshot = this.buildSnapshot(timeOfDayNormalized, weather, now);
    const json = JSON.stringify(snapshot);

    try {
      await Promise.all([
        this.redisClient.publish(`climate:zone:${this.zoneId}`, json),
        this.redisClient.set(`climate:snapshot:${this.zoneId}`, json),
      ]);
      this.publishCount++;
      if (this.publishCount === 1) {
        logger.info({ zoneId: this.zoneId, season: snapshot.season, day: snapshot.day_of_year },
          'ClimateBridge: first climate snapshot published');
      }
    } catch (err) {
      logger.warn({ err, zoneId: this.zoneId }, 'ClimateBridge: failed to publish');
    }
  }

  private async checkExternalSim(now: number): Promise<void> {
    try {
      const raw = await this.redisClient.get(`climate:snapshot:${this.zoneId}`);
      if (raw) {
        const snapshot = JSON.parse(raw) as { timestamp?: number };
        if (snapshot.timestamp && now - snapshot.timestamp < ClimateBridge.EXTERNAL_STALE_THRESHOLD) {
          if (!this.externalSimActive) {
            logger.info({ zoneId: this.zoneId }, 'ClimateBridge: external climate_sim detected, deferring');
          }
          this.externalSimActive = true;
          return;
        }
      }
    } catch {
      // Redis read failure — fall through and act as provider
    }

    if (this.externalSimActive) {
      logger.info({ zoneId: this.zoneId }, 'ClimateBridge: external climate_sim gone, taking over');
    }
    this.externalSimActive = false;
  }

  private buildSnapshot(tod: number, weather: string, now: number): ClimateSnapshot {
    // Convert normalised 0–1 to hours 0–24
    const timeOfDay = tod * 24.0;

    // Season from day of year
    const season = this.seasonFromDay(this.dayCounter);

    // Temperature: -1 (cold) to 1 (hot)
    // Combines seasonal baseline + day/night variation + weather effect
    const seasonalBase = this.seasonalTemperature(season);
    const dayNightOffset = this.isNight(tod) ? -0.15 : 0.1;
    const weatherOffset = weather === 'storm' ? -0.1 : weather === 'rain' ? -0.05 : 0;
    const temperature = Math.max(-1, Math.min(1, seasonalBase + dayNightOffset + weatherOffset));

    // Day length (hours of sunlight) based on latitude and day of year
    const dayLength = this.calculateDayLength(this.dayCounter);

    // Growth rate: higher in spring/summer, during daylight, reduced in bad weather
    const seasonGrowth = season === 'spring' ? 1.2 : season === 'summer' ? 1.0 : season === 'fall' ? 0.6 : 0.1;
    const lightFactor = this.isNight(tod) ? 0.2 : 1.0;
    const weatherFactor = weather === 'storm' ? 0.5 : weather === 'rain' ? 0.8 : 1.0;
    const growthRate = seasonGrowth * lightFactor * weatherFactor;

    return {
      zone_id: this.zoneId,
      day_of_year: this.dayCounter,
      time_of_day: timeOfDay,
      year: this.yearCounter,
      season,
      temperature,
      day_length: dayLength,
      is_night: this.isNight(tod),
      growth_rate: growthRate,
      timestamp: now,
    };
  }

  private seasonFromDay(day: number): 'spring' | 'summer' | 'fall' | 'winter' {
    if (day >= 80 && day < 172)  return 'spring';
    if (day >= 172 && day < 264) return 'summer';
    if (day >= 264 && day < 355) return 'fall';
    return 'winter';
  }

  private seasonalTemperature(season: string): number {
    switch (season) {
      case 'summer': return 0.6;
      case 'spring': return 0.2;
      case 'fall':   return 0.0;
      case 'winter': return -0.4;
      default:       return 0.0;
    }
  }

  private isNight(tod: number): boolean {
    // Dawn ~4am (0.167) to dusk ~8pm (0.833)
    return tod < 0.167 || tod >= 0.833;
  }

  private calculateDayLength(dayOfYear: number): number {
    // Approximate day length based on latitude and day
    const latRad = this.latitude * Math.PI / 180;
    const declination = -23.44 * Math.cos(2 * Math.PI * (dayOfYear + 10) / 365) * Math.PI / 180;
    const hourAngle = Math.acos(
      Math.max(-1, Math.min(1, -Math.tan(latRad) * Math.tan(declination)))
    );
    return (2 * hourAngle * 24) / (2 * Math.PI);
  }
}
