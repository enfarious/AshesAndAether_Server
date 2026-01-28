/**
 * BiomePipeline - Classifies biomes from land cover data.
 *
 * Maps real-world land cover to game biomes for spawn tables and visuals.
 *
 * Data source: ESA WorldCover (10m resolution)
 * Attribution: ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data
 */

import { type TileAddress, tileAddressToId } from '../TileAddress';
import { getTileCenter } from '../TileUtils';
import { TileBuildJobType } from '../TileService';
import { BaseTilePipeline, type PipelineResult } from './TilePipeline';

/**
 * Game biome types
 */
export enum BiomeType {
  /** Dense forest */
  FOREST = 'FOREST',
  /** Scrubland / shrubs */
  SCRUB = 'SCRUB',
  /** Open grassland */
  GRASSLAND = 'GRASSLAND',
  /** Wetland / marsh */
  MARSH = 'MARSH',
  /** Arid desert */
  DESERT = 'DESERT',
  /** Rocky / barren terrain */
  ROCKY = 'ROCKY',
  /** Snowy / arctic tundra */
  TUNDRA = 'TUNDRA',
  /** Urban ruins */
  RUINS = 'RUINS',
  /** Open water */
  WATER = 'WATER',
  /** Coastal area */
  COASTAL = 'COASTAL',
  /** Agricultural / farmland */
  FARMLAND = 'FARMLAND',
}

/**
 * ESA WorldCover land cover classes
 * https://worldcover2021.esa.int/data/docs/WorldCover_PUM_V2.0.pdf
 */
export enum ESALandCover {
  TREE_COVER = 10,
  SHRUBLAND = 20,
  GRASSLAND = 30,
  CROPLAND = 40,
  BUILT_UP = 50,
  BARE_SPARSE = 60,
  SNOW_ICE = 70,
  PERMANENT_WATER = 80,
  HERBACEOUS_WETLAND = 90,
  MANGROVES = 95,
  MOSS_LICHEN = 100,
}

/**
 * Mapping from ESA classes to game biomes
 */
export const ESA_TO_BIOME: Record<ESALandCover, BiomeType> = {
  [ESALandCover.TREE_COVER]: BiomeType.FOREST,
  [ESALandCover.SHRUBLAND]: BiomeType.SCRUB,
  [ESALandCover.GRASSLAND]: BiomeType.GRASSLAND,
  [ESALandCover.CROPLAND]: BiomeType.FARMLAND,
  [ESALandCover.BUILT_UP]: BiomeType.RUINS,
  [ESALandCover.BARE_SPARSE]: BiomeType.ROCKY,
  [ESALandCover.SNOW_ICE]: BiomeType.TUNDRA,
  [ESALandCover.PERMANENT_WATER]: BiomeType.WATER,
  [ESALandCover.HERBACEOUS_WETLAND]: BiomeType.MARSH,
  [ESALandCover.MANGROVES]: BiomeType.MARSH,
  [ESALandCover.MOSS_LICHEN]: BiomeType.TUNDRA,
};

/**
 * Biome data for a tile
 */
export interface TileBiomeData {
  /** Tile ID */
  tileId: string;
  /** Dominant biome type */
  dominantBiome: BiomeType;
  /** Distribution of biomes (biome -> percentage 0-1) */
  biomeDistribution: Record<BiomeType, number>;
  /** Whether tile has water */
  hasWater: boolean;
  /** Whether tile is coastal (land + water) */
  isCoastal: boolean;
  /** Average temperature modifier (-1 to 1) */
  temperatureModifier: number;
  /** Moisture level (0-1) */
  moistureLevel: number;
  /** Data source */
  source: 'worldcover' | 'generated';
}

/**
 * Configuration for biome pipeline
 */
export interface BiomePipelineConfig {
  /** Whether to use generated data instead of fetching */
  useGeneratedData: boolean;
  /** Resolution of biome sampling grid */
  sampleResolution: number;
}

const DEFAULT_CONFIG: BiomePipelineConfig = {
  useGeneratedData: true,
  sampleResolution: 16, // 16x16 samples per tile
};

/**
 * BiomePipeline - Classifies biomes from land cover data
 */
export class BiomePipeline extends BaseTilePipeline {
  jobType = TileBuildJobType.BIOME_FETCH;
  name = 'BiomePipeline';

  private config: BiomePipelineConfig;

  constructor(config: Partial<BiomePipelineConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async process(tile: TileAddress, _inputHash?: string): Promise<PipelineResult> {
    this.log(tile, 'Processing biome data');

    try {
      let biomeData: TileBiomeData;

      if (this.config.useGeneratedData) {
        biomeData = this.generateBiomeData(tile);
      } else {
        // TODO: Implement actual ESA WorldCover data fetching
        biomeData = this.generateBiomeData(tile);
      }

      // Serialize and store
      const buffer = Buffer.from(JSON.stringify(biomeData), 'utf-8');
      const hash = await this.storage.put(buffer);

      this.log(
        tile,
        `Stored biome data: ${biomeData.dominantBiome}, ` +
          `coastal=${biomeData.isCoastal}, ` +
          `temp=${biomeData.temperatureModifier.toFixed(2)}`
      );

      return this.success(hash, {
        dominantBiome: biomeData.dominantBiome,
        isCoastal: biomeData.isCoastal,
        hasWater: biomeData.hasWater,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(tile, `Failed: ${message}`);
      return this.failure(message);
    }
  }

  /**
   * Generate procedural biome data based on location
   */
  private generateBiomeData(tile: TileAddress): TileBiomeData {
    const center = getTileCenter(tile);

    // Temperature based on latitude (simplified)
    const temperatureModifier = this.calculateTemperature(center.lat);

    // Moisture based on pseudo-noise and proximity to water
    const moistureLevel = this.calculateMoisture(center.lat, center.lon);

    // Determine biome based on temperature and moisture
    const biomeDistribution = this.calculateBiomeDistribution(
      temperatureModifier,
      moistureLevel,
      center.lat,
      center.lon
    );

    // Find dominant biome
    let dominantBiome = BiomeType.GRASSLAND;
    let maxPercent = 0;
    for (const [biome, percent] of Object.entries(biomeDistribution)) {
      if (percent > maxPercent) {
        maxPercent = percent;
        dominantBiome = biome as BiomeType;
      }
    }

    // Determine water presence
    const hasWater = biomeDistribution[BiomeType.WATER] > 0.05;
    const isCoastal =
      hasWater &&
      (biomeDistribution[BiomeType.WATER] < 0.8 ||
        this.isNearCoast(center.lat, center.lon));

    // Adjust for coastal areas
    if (isCoastal && dominantBiome !== BiomeType.WATER) {
      biomeDistribution[BiomeType.COASTAL] = 0.1;
      dominantBiome = BiomeType.COASTAL;
    }

    return {
      tileId: tileAddressToId(tile),
      dominantBiome,
      biomeDistribution,
      hasWater,
      isCoastal,
      temperatureModifier,
      moistureLevel,
      source: 'generated',
    };
  }

  /**
   * Calculate temperature modifier based on latitude
   */
  private calculateTemperature(lat: number): number {
    // Simple latitude-based temperature
    // 0 at equator, -1 at poles
    const absLat = Math.abs(lat);

    // Temperature ranges from 1 (equator) to -1 (poles)
    return 1 - (absLat / 90) * 2;
  }

  /**
   * Calculate moisture level based on location
   */
  private calculateMoisture(lat: number, lon: number): number {
    // Base moisture from pseudo-noise
    const noise = this.pseudoNoise(lat * 0.1, lon * 0.1);
    let moisture = (noise + 1) / 2; // 0 to 1

    // Coastal areas are more moist
    if (this.isNearCoast(lat, lon)) {
      moisture = Math.min(1, moisture + 0.3);
    }

    // Equatorial regions tend to be more moist
    const latFactor = 1 - Math.abs(lat) / 90;
    moisture = moisture * 0.7 + latFactor * 0.3;

    return moisture;
  }

  /**
   * Calculate biome distribution based on temperature and moisture
   */
  private calculateBiomeDistribution(
    temp: number,
    moisture: number,
    lat: number,
    lon: number
  ): Record<BiomeType, number> {
    const distribution: Record<BiomeType, number> = {
      [BiomeType.FOREST]: 0,
      [BiomeType.SCRUB]: 0,
      [BiomeType.GRASSLAND]: 0,
      [BiomeType.MARSH]: 0,
      [BiomeType.DESERT]: 0,
      [BiomeType.ROCKY]: 0,
      [BiomeType.TUNDRA]: 0,
      [BiomeType.RUINS]: 0,
      [BiomeType.WATER]: 0,
      [BiomeType.COASTAL]: 0,
      [BiomeType.FARMLAND]: 0,
    };

    // Water check (simplified ocean/lake detection)
    if (this.isWater(lat, lon)) {
      distribution[BiomeType.WATER] = 1.0;
      return distribution;
    }

    // Tundra in cold regions
    if (temp < -0.5) {
      distribution[BiomeType.TUNDRA] = 0.6;
      distribution[BiomeType.ROCKY] = 0.3;
      distribution[BiomeType.GRASSLAND] = 0.1;
      return distribution;
    }

    // Desert in hot, dry regions
    if (temp > 0.5 && moisture < 0.3) {
      distribution[BiomeType.DESERT] = 0.7;
      distribution[BiomeType.ROCKY] = 0.2;
      distribution[BiomeType.SCRUB] = 0.1;
      return distribution;
    }

    // Forest in moist regions
    if (moisture > 0.6 && temp > -0.3) {
      distribution[BiomeType.FOREST] = 0.7;
      distribution[BiomeType.MARSH] = moisture > 0.8 ? 0.2 : 0.1;
      distribution[BiomeType.GRASSLAND] = 0.1;
      return distribution;
    }

    // Marsh in very wet areas
    if (moisture > 0.8) {
      distribution[BiomeType.MARSH] = 0.6;
      distribution[BiomeType.FOREST] = 0.3;
      distribution[BiomeType.GRASSLAND] = 0.1;
      return distribution;
    }

    // Default: grassland with mixed biomes
    distribution[BiomeType.GRASSLAND] = 0.4;
    distribution[BiomeType.SCRUB] = 0.3;
    distribution[BiomeType.FOREST] = 0.2;
    distribution[BiomeType.FARMLAND] = 0.1;

    return distribution;
  }

  /**
   * Simple check if location is likely water (ocean)
   */
  private isWater(lat: number, lon: number): boolean {
    // Very simplified ocean detection
    // Real implementation would use actual coastline data

    // Atlantic Ocean (rough bounds)
    if (lon > -80 && lon < -10 && lat > -60 && lat < 60) {
      if (lon < -40) return true; // Western Atlantic
    }

    // Pacific Ocean (rough)
    if ((lon > 120 || lon < -100) && lat > -60 && lat < 60) {
      const noise = this.pseudoNoise(lat * 0.2, lon * 0.2);
      return noise > 0.3;
    }

    return false;
  }

  /**
   * Check if location is near a coast
   */
  private isNearCoast(lat: number, lon: number): boolean {
    // Simplified coastal detection
    // Check if any nearby point is water
    const offsets = [
      [0.5, 0],
      [-0.5, 0],
      [0, 0.5],
      [0, -0.5],
    ];

    for (const [dlat, dlon] of offsets) {
      if (this.isWater(lat + dlat, lon + dlon)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Simple deterministic pseudo-noise function
   */
  private pseudoNoise(x: number, y: number): number {
    const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return (n - Math.floor(n)) * 2 - 1;
  }

  /**
   * Deserialize biome data from storage
   */
  static deserializeBiomeData(buffer: Buffer): TileBiomeData {
    return JSON.parse(buffer.toString('utf-8'));
  }
}
