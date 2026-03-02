/**
 * TileDataRouter - REST API for serving tile terrain data to external services.
 *
 * Exposes tile pipeline data (elevation, navmesh, biome, ruins, water) via HTTP
 * so the wildlife simulation and other external consumers can fetch terrain info.
 *
 * All data is read from BlobStorage using hashes stored in WorldTile DB records.
 * Supports ETag caching based on content hashes.
 */

import { Router, type Request, type Response } from 'express';
import { TileService } from './TileService';
import { getDefaultBlobStorage } from './pipelines/BlobStorage';
import { ElevationPipeline } from './pipelines/ElevationPipeline';
import { NavmeshPipeline } from './pipelines/NavmeshPipeline';
import { BiomePipeline } from './pipelines/BiomePipeline';
import { RuinGenPipeline } from './pipelines/RuinGenPipeline';
import { tileToLatLonBounds } from './TileUtils';
import { tileAddressFromId } from './TileAddress';
import { logger } from '@/utils/logger';
import { prisma } from '@/database';

/**
 * Create the tile data API router.
 */
export function createTileDataRouter(): Router {
  const router = Router();
  const storage = getDefaultBlobStorage();

  /**
   * GET /api/tiles
   * List all tiles with metadata, bounds, and data availability.
   */
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const tiles = await prisma.worldTile.findMany({
        select: {
          id: true,
          z: true,
          x: true,
          y: true,
          state: true,
          elevationHash: true,
          navmeshHash: true,
          biomeHash: true,
          ruinLayoutHash: true,
          waterHash: true,
          ruinScore: true,
          damageScore: true,
          corruptionScore: true,
        },
      });

      const result = tiles.map((tile) => {
        const address = tileAddressFromId(tile.id);
        const bounds = address ? tileToLatLonBounds(address) : null;

        return {
          id: tile.id,
          z: tile.z,
          x: tile.x,
          y: tile.y,
          state: tile.state,
          bounds,
          scores: {
            ruin: tile.ruinScore,
            damage: tile.damageScore,
            corruption: tile.corruptionScore,
          },
          layers: {
            elevation: !!tile.elevationHash,
            navmesh: !!tile.navmeshHash,
            biome: !!tile.biomeHash,
            ruins: !!tile.ruinLayoutHash,
            water: !!tile.waterHash,
          },
          hashes: {
            elevation: tile.elevationHash,
            navmesh: tile.navmeshHash,
            biome: tile.biomeHash,
            ruins: tile.ruinLayoutHash,
            water: tile.waterHash,
          },
        };
      });

      res.json({ tiles: result, count: result.length });
    } catch (error) {
      logger.error({ error }, '[TileDataRouter] Failed to list tiles');
      res.status(500).json({ error: 'Failed to list tiles' });
    }
  });

  /**
   * GET /api/tiles/:tileId
   * Get all layers combined for a single tile.
   */
  router.get('/:tileId', async (req: Request, res: Response) => {
    try {
      const { tileId } = req.params;
      const tile = await TileService.getTile(tileId);

      if (!tile) {
        res.status(404).json({ error: 'tile_not_found', tileId });
        return;
      }

      const address = tileAddressFromId(tileId);
      const bounds = address ? tileToLatLonBounds(address) : null;

      // Build combined ETag from all layer hashes
      const hashParts = [
        tile.elevationHash,
        tile.navmeshHash,
        tile.biomeHash,
        tile.ruinLayoutHash,
        tile.waterHash,
      ].filter(Boolean).join(':');

      if (hashParts) {
        res.setHeader('ETag', hashParts);
        if (req.header('if-none-match') === hashParts) {
          res.status(304).end();
          return;
        }
      }

      // Load all available layers
      const [elevation, navmesh, biome, ruins] = await Promise.all([
        loadElevation(tile.elevationHash),
        loadNavmesh(tile.navmeshHash),
        loadBiome(tile.biomeHash),
        loadRuins(tile.ruinLayoutHash),
      ]);

      res.json({
        tileId,
        bounds,
        state: tile.state,
        scores: {
          ruin: tile.ruinScore,
          damage: tile.damageScore,
          corruption: tile.corruptionScore,
        },
        elevation,
        navmesh,
        biome,
        ruins,
      });
    } catch (error) {
      logger.error({ error }, '[TileDataRouter] Failed to get tile data');
      res.status(500).json({ error: 'Failed to get tile data' });
    }
  });

  /**
   * GET /api/tiles/:tileId/elevation
   * Get elevation heightmap grid for a tile.
   */
  router.get('/:tileId/elevation', async (req: Request, res: Response) => {
    await serveTileLayer(req, res, 'elevationHash', loadElevation);
  });

  /**
   * GET /api/tiles/:tileId/navmesh
   * Get walkability/movement cost grid for a tile.
   */
  router.get('/:tileId/navmesh', async (req: Request, res: Response) => {
    await serveTileLayer(req, res, 'navmeshHash', loadNavmesh);
  });

  /**
   * GET /api/tiles/:tileId/biome
   * Get biome distribution for a tile.
   */
  router.get('/:tileId/biome', async (req: Request, res: Response) => {
    await serveTileLayer(req, res, 'biomeHash', loadBiome);
  });

  /**
   * GET /api/tiles/:tileId/ruins
   * Get structure placements and road network for a tile.
   */
  router.get('/:tileId/ruins', async (req: Request, res: Response) => {
    await serveTileLayer(req, res, 'ruinLayoutHash', loadRuins);
  });

  /**
   * GET /api/tiles/:tileId/water
   * Get water feature data for a tile.
   */
  router.get('/:tileId/water', async (req: Request, res: Response) => {
    await serveTileLayer(req, res, 'waterHash', loadWater);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  type HashField = 'elevationHash' | 'navmeshHash' | 'biomeHash' | 'ruinLayoutHash' | 'waterHash';

  /**
   * Generic handler for serving a single tile layer with ETag caching.
   */
  async function serveTileLayer(
    req: Request,
    res: Response,
    hashField: HashField,
    loader: (hash: string | null) => Promise<unknown>,
  ): Promise<void> {
    try {
      const { tileId } = req.params;
      const tile = await TileService.getTile(tileId);

      if (!tile) {
        res.status(404).json({ error: 'tile_not_found', tileId });
        return;
      }

      const hash = tile[hashField] as string | null;
      if (!hash) {
        res.status(404).json({ error: 'layer_not_generated', tileId, layer: hashField });
        return;
      }

      // ETag caching
      res.setHeader('ETag', hash);
      if (req.header('if-none-match') === hash) {
        res.status(304).end();
        return;
      }

      const data = await loader(hash);
      if (!data) {
        res.status(404).json({ error: 'blob_not_found', tileId, hash });
        return;
      }

      res.json(data);
    } catch (error) {
      logger.error({ error }, `[TileDataRouter] Failed to serve ${hashField}`);
      res.status(500).json({ error: `Failed to serve ${hashField}` });
    }
  }

  /**
   * Load and deserialize elevation data from blob storage.
   */
  async function loadElevation(hash: string | null): Promise<unknown> {
    if (!hash) return null;
    const buffer = await storage.get(hash);
    if (!buffer) return null;
    return ElevationPipeline.deserializeElevationData(buffer);
  }

  /**
   * Load and deserialize navmesh data from blob storage.
   */
  async function loadNavmesh(hash: string | null): Promise<unknown> {
    if (!hash) return null;
    const buffer = await storage.get(hash);
    if (!buffer) return null;
    return NavmeshPipeline.deserializeNavmesh(buffer);
  }

  /**
   * Load and deserialize biome data from blob storage.
   */
  async function loadBiome(hash: string | null): Promise<unknown> {
    if (!hash) return null;
    const buffer = await storage.get(hash);
    if (!buffer) return null;
    return BiomePipeline.deserializeBiomeData(buffer);
  }

  /**
   * Load and deserialize ruin layout from blob storage.
   */
  async function loadRuins(hash: string | null): Promise<unknown> {
    if (!hash) return null;
    const buffer = await storage.get(hash);
    if (!buffer) return null;
    return RuinGenPipeline.deserializeRuinLayout(buffer);
  }

  /**
   * Load water data from blob storage.
   * Water is stored as plain JSON.
   */
  async function loadWater(hash: string | null): Promise<unknown> {
    if (!hash) return null;
    const buffer = await storage.get(hash);
    if (!buffer) return null;
    return JSON.parse(buffer.toString('utf-8'));
  }

  return router;
}
