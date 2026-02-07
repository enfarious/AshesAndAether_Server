import fs from 'fs';
import path from 'path';

type TerrainMetadata = {
  originLat: number;
  originLon: number;
  pixelSizeDeg: number;
  width: number;
  height: number;
  units: 'meters';
  nodata: number | null;
  center?: {
    lat: number;
    lon: number;
    radiusMeters: number;
  };
};

export class ElevationService {
  private metadata: TerrainMetadata;
  private data: Float32Array;

  private constructor(metadata: TerrainMetadata, data: Float32Array) {
    this.metadata = metadata;
    this.data = data;
  }

  static tryLoad(
    metaPath: string = path.join('data', 'terrain', 'usa_ny_stephentown_dem.json'),
    binPath: string = path.join('data', 'terrain', 'usa_ny_stephentown_dem.bin')
  ): ElevationService | null {
    if (!fs.existsSync(metaPath) || !fs.existsSync(binPath)) {
      return null;
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as TerrainMetadata;
    const buffer = fs.readFileSync(binPath);
    const data = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    return new ElevationService(meta, data);
  }

  getElevationMeters(lat: number, lon: number): number | null {
    const { originLat, originLon, pixelSizeDeg, width, height } = this.metadata;
    const col = (lon - originLon) / pixelSizeDeg;
    const row = (originLat - lat) / pixelSizeDeg;

    if (col < 0 || row < 0 || col >= width - 1 || row >= height - 1) {
      return null;
    }

    const col0 = Math.floor(col);
    const row0 = Math.floor(row);
    const col1 = col0 + 1;
    const row1 = row0 + 1;

    const q11 = this.sample(row0, col0);
    const q21 = this.sample(row0, col1);
    const q12 = this.sample(row1, col0);
    const q22 = this.sample(row1, col1);

    if (q11 === null || q21 === null || q12 === null || q22 === null) {
      return null;
    }

    const x = col - col0;
    const y = row - row0;
    const r1 = q11 * (1 - x) + q21 * x;
    const r2 = q12 * (1 - x) + q22 * x;
    return r1 * (1 - y) + r2 * y;
  }

  /**
   * Get the terrain metadata for coordinate transformations
   */
  getMetadata(): TerrainMetadata {
    return this.metadata;
  }

  private sample(row: number, col: number): number | null {
    const { width } = this.metadata;
    const index = row * width + col;
    const value = this.data[index];
    if (!Number.isFinite(value)) {
      return null;
    }
    return value;
  }
}
