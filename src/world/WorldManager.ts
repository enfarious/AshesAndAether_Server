import { logger } from '@/utils/logger';
import { Zone } from './Zone';

/**
 * Manages the entire game world, zones, and world state
 */
export class WorldManager {
  private zones: Map<string, Zone> = new Map();
  private activeZones: Set<string> = new Set();

  async initialize(): Promise<void> {
    logger.info('Initializing world manager...');

    // TODO: Load zones from database
    // For now, create a test zone
    await this.createTestZone();

    logger.info(`World manager initialized with ${this.zones.size} zones`);
  }

  private async createTestZone(): Promise<void> {
    const testZone = new Zone({
      id: 'test-zone-1',
      name: 'Starting Forest',
      description: 'A dense, dark forest where new characters begin their journey',
      worldX: 0,
      worldY: 0,
      sizeX: 1000,
      sizeY: 1000,
      sizeZ: 100,
      terrainType: 'forest',
    });

    await testZone.initialize();
    this.zones.set(testZone.getId(), testZone);
    this.activeZones.add(testZone.getId());

    logger.info(`Created test zone: ${testZone.getName()}`);
  }

  update(deltaTime: number): void {
    // Update all active zones
    for (const zoneId of this.activeZones) {
      const zone = this.zones.get(zoneId);
      if (zone) {
        zone.update(deltaTime);
      }
    }
  }

  getZone(zoneId: string): Zone | undefined {
    return this.zones.get(zoneId);
  }

  getAllZones(): Zone[] {
    return Array.from(this.zones.values());
  }

  activateZone(zoneId: string): void {
    if (this.zones.has(zoneId)) {
      this.activeZones.add(zoneId);
      logger.debug(`Activated zone: ${zoneId}`);
    }
  }

  deactivateZone(zoneId: string): void {
    this.activeZones.delete(zoneId);
    logger.debug(`Deactivated zone: ${zoneId}`);
  }
}
