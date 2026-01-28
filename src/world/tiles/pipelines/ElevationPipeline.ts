/**
 * ElevationPipeline - Fetches elevation data from SRTM/OpenTopography.
 *
 * Uses OpenTopography Global Bathymetry and Topography API for elevation data.
 * Falls back to generating placeholder data if API is unavailable.
 *
 * Data source: SRTM GL3 (90m) or SRTM GL1 (30m) via OpenTopography
 * Attribution: NASA SRTM, OpenTopography
 */

import { type TileAddress, tileAddressToId } from '../TileAddress';
import { tileToLatLonBounds } from '../TileUtils';
import { TileBuildJobType } from '../TileService';
import { BaseTilePipeline, type PipelineResult } from './TilePipeline';

/**
 * Elevation data for a tile
 */
export interface TileElevationData {
  /** Tile ID */
  tileId: string;
  /** Width of the elevation grid */
  width: number;
  /** Height of the elevation grid */
  height: number;
  /** Minimum elevation in meters */
  minElevation: number;
  /** Maximum elevation in meters */
  maxElevation: number;
  /** Mean elevation in meters */
  meanElevation: number;
  /** Elevation values (row-major, in meters) */
  elevations: number[];
  /** Data source */
  source: 'srtm' | 'generated' | 'cached';
}

/**
 * Configuration for elevation pipeline
 */
export interface ElevationPipelineConfig {
  /** Grid resolution (points per tile edge) */
  resolution: number;
  /** OpenTopography API key (optional, increases rate limits) */
  apiKey?: string;
  /** Whether to use generated data instead of fetching */
  useGeneratedData: boolean;
  /** Timeout for API requests in ms */
  requestTimeout: number;
}

const DEFAULT_CONFIG: ElevationPipelineConfig = {
  resolution: 64, // 64x64 grid per tile
  useGeneratedData: true, // Start with generated for development
  requestTimeout: 30000,
};

/**
 * ElevationPipeline - Fetches and processes elevation data
 */
export class ElevationPipeline extends BaseTilePipeline {
  jobType = TileBuildJobType.ELEVATION_FETCH;
  name = 'ElevationPipeline';

  private config: ElevationPipelineConfig;

  constructor(config: Partial<ElevationPipelineConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async process(tile: TileAddress, _inputHash?: string): Promise<PipelineResult> {
    this.log(tile, 'Processing elevation data');

    try {
      let elevationData: TileElevationData;

      if (this.config.useGeneratedData) {
        elevationData = this.generateElevationData(tile);
      } else {
        elevationData = await this.fetchElevationData(tile);
      }

      // Serialize and store
      const buffer = this.serializeElevationData(elevationData);
      const hash = await this.storage.put(buffer);

      this.log(tile, `Stored elevation data (${buffer.length} bytes, hash: ${hash.slice(0, 8)})`);

      return this.success(hash, {
        minElevation: elevationData.minElevation,
        maxElevation: elevationData.maxElevation,
        meanElevation: elevationData.meanElevation,
        source: elevationData.source,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(tile, `Failed: ${message}`);
      return this.failure(message);
    }
  }

  /**
   * Generate procedural elevation data based on tile coordinates
   * Uses noise-like function seeded by tile position
   */
  private generateElevationData(tile: TileAddress): TileElevationData {
    const bounds = tileToLatLonBounds(tile);
    const { resolution } = this.config;
    const elevations: number[] = [];

    let minElev = Infinity;
    let maxElev = -Infinity;
    let sumElev = 0;

    // Generate elevation using simple deterministic noise
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        // Interpolate lat/lon within tile
        const lat = bounds.north - (y / (resolution - 1)) * (bounds.north - bounds.south);
        const lon = bounds.west + (x / (resolution - 1)) * (bounds.east - bounds.west);

        // Generate elevation using layered pseudo-noise
        const elevation = this.generateElevation(lat, lon, tile.z);

        elevations.push(elevation);
        minElev = Math.min(minElev, elevation);
        maxElev = Math.max(maxElev, elevation);
        sumElev += elevation;
      }
    }

    return {
      tileId: tileAddressToId(tile),
      width: resolution,
      height: resolution,
      minElevation: minElev,
      maxElevation: maxElev,
      meanElevation: sumElev / elevations.length,
      elevations,
      source: 'generated',
    };
  }

  /**
   * Generate a single elevation value using deterministic pseudo-noise
   */
  private generateElevation(lat: number, lon: number, _zoom: number): number {
    // Multi-octave noise for terrain-like appearance
    let elevation = 0;
    let amplitude = 200; // Base amplitude in meters
    let frequency = 0.1;

    for (let octave = 0; octave < 4; octave++) {
      elevation += this.pseudoNoise(lat * frequency, lon * frequency) * amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }

    // Add some variation based on absolute position
    const latFactor = Math.cos(lat * Math.PI / 180); // Lower at poles
    elevation *= (0.5 + 0.5 * latFactor);

    // Ensure reasonable range (sea level to ~1000m for development)
    elevation = Math.max(0, elevation + 100);

    return Math.round(elevation * 10) / 10; // Round to 0.1m
  }

  /**
   * Simple deterministic pseudo-noise function
   */
  private pseudoNoise(x: number, y: number): number {
    // Simple hash-based noise
    const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return (n - Math.floor(n)) * 2 - 1; // Range -1 to 1
  }

  /**
   * Fetch real elevation data from OpenTopography API
   */
  private async fetchElevationData(tile: TileAddress): Promise<TileElevationData> {
    const bounds = tileToLatLonBounds(tile);
    const { apiKey, requestTimeout } = this.config;

    // OpenTopography Global DEM API
    // https://portal.opentopography.org/apidocs/
    const url = new URL('https://portal.opentopography.org/API/globaldem');
    url.searchParams.set('demtype', 'SRTMGL3'); // 90m SRTM
    url.searchParams.set('south', bounds.south.toString());
    url.searchParams.set('north', bounds.north.toString());
    url.searchParams.set('west', bounds.west.toString());
    url.searchParams.set('east', bounds.east.toString());
    url.searchParams.set('outputFormat', 'AAIGrid'); // ASCII grid format

    if (apiKey) {
      url.searchParams.set('API_Key', apiKey);
    }

    this.debug(tile, `Fetching from OpenTopography: ${url.toString()}`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), requestTimeout);

      const response = await fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          'User-Agent': 'AshesAndAether-Server/1.0',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`OpenTopography API error: ${response.status} ${response.statusText}`);
      }

      const text = await response.text();
      return this.parseArcAsciiGrid(tile, text);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Request timed out');
      }
      throw error;
    }
  }

  /**
   * Parse Arc/Info ASCII Grid format
   */
  private parseArcAsciiGrid(tile: TileAddress, text: string): TileElevationData {
    const lines = text.trim().split('\n');
    const header: Record<string, number> = {};

    // Parse header
    let dataStartLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const match = line.match(/^(\w+)\s+([\d.-]+)/);
      if (match) {
        header[match[1].toLowerCase()] = parseFloat(match[2]);
        dataStartLine = i + 1;
      } else {
        break;
      }
    }

    const ncols = header['ncols'] || 0;
    const nrows = header['nrows'] || 0;
    const nodata = header['nodata_value'] ?? -9999;

    // Parse elevation values
    const elevations: number[] = [];
    let minElev = Infinity;
    let maxElev = -Infinity;
    let sumElev = 0;
    let count = 0;

    for (let i = dataStartLine; i < lines.length; i++) {
      const values = lines[i].trim().split(/\s+/).map(Number);
      for (const val of values) {
        const elevation = val === nodata ? 0 : val;
        elevations.push(elevation);
        if (val !== nodata) {
          minElev = Math.min(minElev, elevation);
          maxElev = Math.max(maxElev, elevation);
          sumElev += elevation;
          count++;
        }
      }
    }

    return {
      tileId: tileAddressToId(tile),
      width: ncols,
      height: nrows,
      minElevation: minElev === Infinity ? 0 : minElev,
      maxElevation: maxElev === -Infinity ? 0 : maxElev,
      meanElevation: count > 0 ? sumElev / count : 0,
      elevations,
      source: 'srtm',
    };
  }

  /**
   * Serialize elevation data to binary format
   */
  private serializeElevationData(data: TileElevationData): Buffer {
    // Format: JSON header + binary elevation array
    const header = JSON.stringify({
      tileId: data.tileId,
      width: data.width,
      height: data.height,
      minElevation: data.minElevation,
      maxElevation: data.maxElevation,
      meanElevation: data.meanElevation,
      source: data.source,
    });

    const headerBuffer = Buffer.from(header, 'utf-8');
    const headerLengthBuffer = Buffer.alloc(4);
    headerLengthBuffer.writeUInt32LE(headerBuffer.length);

    // Store elevations as float32
    const elevationsBuffer = Buffer.alloc(data.elevations.length * 4);
    for (let i = 0; i < data.elevations.length; i++) {
      elevationsBuffer.writeFloatLE(data.elevations[i], i * 4);
    }

    return Buffer.concat([headerLengthBuffer, headerBuffer, elevationsBuffer]);
  }

  /**
   * Deserialize elevation data from binary format
   */
  static deserializeElevationData(buffer: Buffer): TileElevationData {
    const headerLength = buffer.readUInt32LE(0);
    const headerJson = buffer.slice(4, 4 + headerLength).toString('utf-8');
    const header = JSON.parse(headerJson);

    const elevationsBuffer = buffer.slice(4 + headerLength);
    const elevations: number[] = [];
    for (let i = 0; i < elevationsBuffer.length / 4; i++) {
      elevations.push(elevationsBuffer.readFloatLE(i * 4));
    }

    return {
      ...header,
      elevations,
    };
  }
}
