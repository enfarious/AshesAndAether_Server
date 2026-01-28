/**
 * PopulationPipeline - Processes population data for ruin scoring.
 *
 * Uses historical population density to determine where ruins should appear.
 * Higher pre-cataclysm population = more ruins, more damage, more corruption.
 *
 * Data source: GHS-POP (Global Human Settlement Population)
 * Attribution: European Commission, Joint Research Centre (JRC)
 */

import { type TileAddress, tileAddressToId } from '../TileAddress';
import { tileToLatLonBounds, haversineDistance, getTileCenter } from '../TileUtils';
import { TileBuildJobType } from '../TileService';
import { BaseTilePipeline, type PipelineResult } from './TilePipeline';

/**
 * Population and ruin scoring data for a tile
 */
export interface TilePopulationData {
  /** Tile ID */
  tileId: string;
  /** Estimated historical population in this tile */
  population: number;
  /** Population density (people per km²) */
  populationDensity: number;
  /** Ruin score (0-1): derived from log(population) */
  ruinScore: number;
  /** Damage score (0-1): how destroyed the ruins are */
  damageScore: number;
  /** Corruption score (0-1): supernatural corruption level */
  corruptionScore: number;
  /** Settlement type classification */
  settlementType: SettlementType;
  /** Data source */
  source: 'ghs-pop' | 'generated';
}

/**
 * Settlement type classification
 */
export enum SettlementType {
  /** Uninhabited wilderness */
  WILDERNESS = 'WILDERNESS',
  /** Rural area with sparse population */
  RURAL = 'RURAL',
  /** Small town or village */
  VILLAGE = 'VILLAGE',
  /** Suburban area */
  SUBURBAN = 'SUBURBAN',
  /** Urban area */
  URBAN = 'URBAN',
  /** Dense urban core / city center */
  URBAN_CORE = 'URBAN_CORE',
  /** Major metropolitan area */
  METROPOLIS = 'METROPOLIS',
}

/**
 * Configuration for population pipeline
 */
export interface PopulationPipelineConfig {
  /** Whether to use generated data instead of fetching */
  useGeneratedData: boolean;
  /** Maximum ruin score (for tuning) */
  maxRuinScore: number;
  /** Base corruption modifier (added to damage-based corruption) */
  baseCorruptionModifier: number;
  /** Known city centers for procedural generation */
  cityCenters: Array<{ lat: number; lon: number; population: number; name: string }>;
}

const DEFAULT_CONFIG: PopulationPipelineConfig = {
  useGeneratedData: true,
  maxRuinScore: 1.0,
  baseCorruptionModifier: 0.1, // 10% base corruption everywhere
  // Major cities for procedural population distribution
  cityCenters: [
    // US East Coast
    { lat: 40.7128, lon: -74.006, population: 8_336_817, name: 'New York' },
    { lat: 42.3601, lon: -71.0589, population: 675_647, name: 'Boston' },
    { lat: 39.9526, lon: -75.1652, population: 1_584_064, name: 'Philadelphia' },
    { lat: 38.9072, lon: -77.0369, population: 689_545, name: 'Washington DC' },
    // US West Coast
    { lat: 34.0522, lon: -118.2437, population: 3_979_576, name: 'Los Angeles' },
    { lat: 37.7749, lon: -122.4194, population: 883_305, name: 'San Francisco' },
    { lat: 47.6062, lon: -122.3321, population: 737_015, name: 'Seattle' },
    // Europe
    { lat: 51.5074, lon: -0.1278, population: 8_982_000, name: 'London' },
    { lat: 48.8566, lon: 2.3522, population: 2_161_000, name: 'Paris' },
    { lat: 52.52, lon: 13.405, population: 3_645_000, name: 'Berlin' },
    // Asia
    { lat: 35.6762, lon: 139.6503, population: 13_960_000, name: 'Tokyo' },
    { lat: 31.2304, lon: 121.4737, population: 24_280_000, name: 'Shanghai' },
  ],
};

/**
 * Population thresholds for settlement classification
 */
const SETTLEMENT_THRESHOLDS = {
  [SettlementType.WILDERNESS]: 0,
  [SettlementType.RURAL]: 10,
  [SettlementType.VILLAGE]: 100,
  [SettlementType.SUBURBAN]: 1000,
  [SettlementType.URBAN]: 5000,
  [SettlementType.URBAN_CORE]: 10000,
  [SettlementType.METROPOLIS]: 25000,
};

/**
 * PopulationPipeline - Processes population data for ruin scoring
 */
export class PopulationPipeline extends BaseTilePipeline {
  jobType = TileBuildJobType.POPULATION_FETCH;
  name = 'PopulationPipeline';

  private config: PopulationPipelineConfig;

  constructor(config: Partial<PopulationPipelineConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async process(tile: TileAddress, _inputHash?: string): Promise<PipelineResult> {
    this.log(tile, 'Processing population data');

    try {
      let populationData: TilePopulationData;

      if (this.config.useGeneratedData) {
        populationData = this.generatePopulationData(tile);
      } else {
        // TODO: Implement actual GHS-POP data fetching
        populationData = this.generatePopulationData(tile);
      }

      // Serialize and store
      const buffer = Buffer.from(JSON.stringify(populationData), 'utf-8');
      const hash = await this.storage.put(buffer);

      this.log(
        tile,
        `Stored population data: ${populationData.settlementType}, ` +
          `ruin=${populationData.ruinScore.toFixed(2)}, ` +
          `damage=${populationData.damageScore.toFixed(2)}, ` +
          `corruption=${populationData.corruptionScore.toFixed(2)}`
      );

      return this.success(hash, {
        ruinScore: populationData.ruinScore,
        damageScore: populationData.damageScore,
        corruptionScore: populationData.corruptionScore,
        settlementType: populationData.settlementType,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(tile, `Failed: ${message}`);
      return this.failure(message);
    }
  }

  /**
   * Generate procedural population data based on distance to known cities
   */
  private generatePopulationData(tile: TileAddress): TilePopulationData {
    const center = getTileCenter(tile);
    const bounds = tileToLatLonBounds(tile);

    // Calculate tile area in km²
    const latDiff = bounds.north - bounds.south;
    const lonDiff = bounds.east - bounds.west;
    const tileAreaKm2 = latDiff * 111 * lonDiff * 111 * Math.cos((center.lat * Math.PI) / 180);

    // Find nearest city and calculate population influence
    let totalPopulationInfluence = 0;

    for (const city of this.config.cityCenters) {
      const distance = haversineDistance(center.lat, center.lon, city.lat, city.lon) / 1000; // km

      // Population influence falls off with distance
      // Using inverse square law with cutoff
      if (distance < 500) {
        // Within 500km of city
        const influence = city.population * Math.exp(-distance / 50); // Exponential decay
        totalPopulationInfluence += influence;
      }
    }

    // Estimate population in this tile
    // Scale factor to get reasonable numbers
    const population = Math.round(totalPopulationInfluence / 10000);
    const populationDensity = tileAreaKm2 > 0 ? population / tileAreaKm2 : 0;

    // Calculate scores
    const ruinScore = this.calculateRuinScore(population);
    const damageScore = this.calculateDamageScore(ruinScore);
    const corruptionScore = this.calculateCorruptionScore(damageScore);
    const settlementType = this.classifySettlement(populationDensity);

    return {
      tileId: tileAddressToId(tile),
      population,
      populationDensity,
      ruinScore,
      damageScore,
      corruptionScore,
      settlementType,
      source: 'generated',
    };
  }

  /**
   * Calculate ruin score from population
   * Uses log scale: more people = more ruins, but with diminishing returns
   */
  private calculateRuinScore(population: number): number {
    if (population <= 0) return 0;

    // log10(population) / log10(max_expected_population)
    // Assuming max ~10 million for a very dense tile
    const maxLogPop = Math.log10(10_000_000);
    const logPop = Math.log10(population + 1);

    return Math.min(this.config.maxRuinScore, logPop / maxLogPop);
  }

  /**
   * Calculate damage score from ruin score
   * Higher ruin areas tend to have more damage (collapsed buildings, etc.)
   */
  private calculateDamageScore(ruinScore: number): number {
    // Damage increases faster than linearly with ruins
    // (dense urban areas are harder hit)
    return Math.pow(ruinScore, 1.5);
  }

  /**
   * Calculate corruption score from damage
   * Damaged areas attract supernatural corruption
   */
  private calculateCorruptionScore(damageScore: number): number {
    // Base corruption + damage-based corruption
    const baseCorruption = this.config.baseCorruptionModifier;
    const damageCorruption = damageScore * 0.6; // 60% of damage becomes corruption

    return Math.min(1.0, baseCorruption + damageCorruption);
  }

  /**
   * Classify settlement type based on population density
   */
  private classifySettlement(density: number): SettlementType {
    if (density >= SETTLEMENT_THRESHOLDS[SettlementType.METROPOLIS]) {
      return SettlementType.METROPOLIS;
    }
    if (density >= SETTLEMENT_THRESHOLDS[SettlementType.URBAN_CORE]) {
      return SettlementType.URBAN_CORE;
    }
    if (density >= SETTLEMENT_THRESHOLDS[SettlementType.URBAN]) {
      return SettlementType.URBAN;
    }
    if (density >= SETTLEMENT_THRESHOLDS[SettlementType.SUBURBAN]) {
      return SettlementType.SUBURBAN;
    }
    if (density >= SETTLEMENT_THRESHOLDS[SettlementType.VILLAGE]) {
      return SettlementType.VILLAGE;
    }
    if (density >= SETTLEMENT_THRESHOLDS[SettlementType.RURAL]) {
      return SettlementType.RURAL;
    }
    return SettlementType.WILDERNESS;
  }

  /**
   * Deserialize population data from storage
   */
  static deserializePopulationData(buffer: Buffer): TilePopulationData {
    return JSON.parse(buffer.toString('utf-8'));
  }
}
