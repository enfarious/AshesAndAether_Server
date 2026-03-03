import { Router, type Request, type Response } from 'express';
import { prisma } from '@/database';
import { getCorruptionConfig } from '@/corruption/CorruptionConfig';
import { logger } from '@/utils/logger';

/**
 * Create the civic anchor / corruption map API router.
 * Mounted at /api/map
 */
export function createCivicAnchorRouter(): Router {
  const router = Router();

  /**
   * GET /api/map/anchors
   * Returns all active civic anchors with positions and ward parameters.
   */
  router.get('/anchors', async (_req: Request, res: Response) => {
    try {
      const anchors = await prisma.civicAnchor.findMany({
        where: { isActive: true },
        select: {
          id: true,
          type: true,
          name: true,
          description: true,
          lat: true,
          lon: true,
          worldX: true,
          worldY: true,
          worldZ: true,
          wardRadius: true,
          wardStrength: true,
          zoneId: true,
          metadata: true,
        },
        orderBy: { type: 'asc' },
      });

      res.json({
        anchors,
        count: anchors.length,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error({ error }, '[CivicAnchorRouter] Failed to list anchors');
      res.status(500).json({ error: 'Failed to list anchors' });
    }
  });

  /**
   * GET /api/map/corruption-config
   * Returns corruption zone tag rates and gradient model for client-side rendering.
   */
  router.get('/corruption-config', (_req: Request, res: Response) => {
    try {
      const config = getCorruptionConfig();

      res.json({
        zoneTags: config.zone_tags,
        timeOfDay: config.time_of_day,
        gradientModel: {
          description: 'Corruption scales with distance from nearest ward anchor',
          bands: [
            {
              label: 'WARD_ZONE',
              rangeDesc: '0 to wardRadius',
              rate: config.zone_tags.WARD_ZONE.corruption_per_minute,
            },
            {
              label: 'WILDS',
              rangeDesc: 'wardRadius to 2x wardRadius',
              rate: config.zone_tags.WILDS.corruption_per_minute,
            },
            {
              label: 'RUINS_CITY_EDGE',
              rangeDesc: '2x to 4x wardRadius',
              rate: config.zone_tags.RUINS_CITY_EDGE.corruption_per_minute,
            },
            {
              label: 'OLD_CITY_CORE',
              rangeDesc: 'beyond 4x wardRadius',
              rate: config.zone_tags.OLD_CITY_CORE.corruption_per_minute,
            },
          ],
        },
      });
    } catch (error) {
      logger.error({ error }, '[CivicAnchorRouter] Failed to get corruption config');
      res.status(500).json({ error: 'Failed to get corruption config' });
    }
  });

  return router;
}
