import { logger } from '@/utils/logger';
import { Vector3 } from '@/utils/Vector3';

export interface ZoneConfig {
  id: string;
  name: string;
  description?: string;
  worldX: number;
  worldY: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  terrainType: string;
}

/**
 * Represents a zone (area) in the game world
 */
export class Zone {
  private id: string;
  private name: string;
  private description?: string;
  private worldPosition: { x: number; y: number };
  private size: Vector3;
  private terrainType: string;

  // Entities in this zone
  private entities: Set<string> = new Set();

  // Time tracking
  private timeOfDay: number = 0.5; // 0.0 = midnight, 0.5 = noon, 1.0 = midnight
  private weather: string = 'clear';

  constructor(config: ZoneConfig) {
    this.id = config.id;
    this.name = config.name;
    this.description = config.description;
    this.worldPosition = { x: config.worldX, y: config.worldY };
    this.size = new Vector3(config.sizeX, config.sizeY, config.sizeZ);
    this.terrainType = config.terrainType;
  }

  async initialize(): Promise<void> {
    logger.info(`Initializing zone: ${this.name} (${this.id})`);

    // TODO: Load navmesh data
    // TODO: Load static objects/NPCs
    // TODO: Initialize spatial index

    logger.debug(`Zone ${this.name} initialized with size ${this.size}`);
  }

  update(deltaTime: number): void {
    // Update time of day (full day cycle in 24 minutes = 1440 seconds)
    this.timeOfDay += deltaTime / 1440;
    if (this.timeOfDay >= 1.0) {
      this.timeOfDay -= 1.0;
    }

    // TODO: Update entities in zone
    // TODO: Update weather
    // TODO: Update environmental effects
  }

  getId(): string {
    return this.id;
  }

  getName(): string {
    return this.name;
  }

  getDescription(): string | undefined {
    return this.description;
  }

  getSize(): Vector3 {
    return this.size.clone();
  }

  getWorldPosition(): { x: number; y: number } {
    return { ...this.worldPosition };
  }

  getTimeOfDay(): number {
    return this.timeOfDay;
  }

  getWeather(): string {
    return this.weather;
  }

  addEntity(entityId: string): void {
    this.entities.add(entityId);
  }

  removeEntity(entityId: string): void {
    this.entities.delete(entityId);
  }

  getEntityCount(): number {
    return this.entities.size;
  }

  isPositionValid(position: Vector3): boolean {
    return (
      position.x >= 0 &&
      position.x <= this.size.x &&
      position.y >= 0 &&
      position.y <= this.size.y &&
      position.z >= 0 &&
      position.z <= this.size.z
    );
  }
}
