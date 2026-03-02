import { ElevationService } from '@/world/terrain/ElevationService';
import { WaterService } from '@/world/terrain/WaterService';
import type { Vector3 } from '@/network/protocol/types';
import type {
  BoundingVolume,
  BoundingSphere,
  BoundingBox,
  WallSegment,
  CollisionResult,
  RaycastResult,
  TerrainCollision,
  PhysicsEntity,
  PhysicsQueryOptions,
  MovementValidationOptions,
  MovementValidation,
  LineOfSightResult,
} from './types';
import { CollisionLayer } from './types';

/**
 * Lightweight physics system for MMO constraints
 * Focuses on collision detection, line-of-sight, and terrain interaction
 */
export class PhysicsSystem {
  private elevationService: ElevationService | null;
  private waterService: WaterService | null;
  private entities: Map<string, PhysicsEntity> = new Map();
  private staticEntities: Map<string, PhysicsEntity> = new Map();

  /**
   * @param flat  When true, skip elevation/water loading (e.g. village instances
   *              that use a flat y=0 ground plane instead of real DEM terrain).
   */
  constructor(flat = false) {
    if (flat) {
      this.elevationService = null;
      this.waterService = null;
      return;
    }

    // Try to load elevation data
    this.elevationService = ElevationService.tryLoad();
    if (!this.elevationService) {
      console.warn('PhysicsSystem: Elevation data not available, terrain collision disabled');
    }

    this.waterService = WaterService.tryLoad();
    if (!this.waterService) {
      console.warn('PhysicsSystem: Water data not available, water checks simplified');
    }
  }

  /**
   * Whether elevation data was successfully loaded.
   * If false, getTerrainCollision always returns elevation=0 and physics won't work.
   */
  hasElevationService(): boolean {
    return this.elevationService !== null;
  }

  /**
   * Register a physics entity
   */
  registerEntity(entity: PhysicsEntity): void {
    if (entity.type === 'static') {
      this.staticEntities.set(entity.id, entity);
    } else {
      this.entities.set(entity.id, entity);
    }
  }

  /**
   * Unregister a physics entity
   */
  unregisterEntity(entityId: string): void {
    this.entities.delete(entityId);
    this.staticEntities.delete(entityId);
  }

  /**
   * Update entity position and bounding volume
   */
  updateEntity(entityId: string, position: Vector3): void {
    const entity = this.entities.get(entityId) || this.staticEntities.get(entityId);
    if (entity) {
      entity.position = { ...position };
      // Update bounding volume position if it's a sphere
      if ('center' in entity.boundingVolume) {
        entity.boundingVolume.center = { ...position };
      } else if ('min' in entity.boundingVolume && 'max' in entity.boundingVolume) {
        // For bounding boxes, we'd need to recalculate min/max based on new center
        // For simplicity, assuming entities are spheres for now
      }
    }
  }

  /**
   * Check collision between two bounding volumes
   */
  private checkBoundingVolumeCollision(
    vol1: BoundingVolume,
    vol2: BoundingVolume
  ): CollisionResult {
    // Sphere vs Sphere
    if ('center' in vol1 && 'center' in vol2) {
      return this.checkSphereSphereCollision(vol1, vol2);
    }

    // Sphere vs Box
    if ('center' in vol1 && 'min' in vol2) {
      return this.checkSphereBoxCollision(vol1, vol2);
    }

    // Box vs Sphere
    if ('min' in vol1 && 'center' in vol2) {
      return this.checkSphereBoxCollision(vol2, vol1);
    }

    // Box vs Box
    if ('min' in vol1 && 'min' in vol2) {
      return this.checkBoxBoxCollision(vol1, vol2);
    }

    // Sphere vs WallSegment
    if ('center' in vol1 && 'ax' in vol2) {
      return this.checkSphereWallCollision(vol1, vol2 as WallSegment);
    }

    // WallSegment vs Sphere
    if ('ax' in vol1 && 'center' in vol2) {
      return this.checkSphereWallCollision(vol2, vol1 as WallSegment);
    }

    return { collided: false };
  }

  /**
   * Sphere-sphere collision detection
   */
  private checkSphereSphereCollision(sphere1: BoundingSphere, sphere2: BoundingSphere): CollisionResult {
    const dx = sphere2.center.x - sphere1.center.x;
    const dy = sphere2.center.y - sphere1.center.y;
    const dz = sphere2.center.z - sphere1.center.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const combinedRadius = sphere1.radius + sphere2.radius;

    if (distance <= combinedRadius) {
      // Calculate collision point and normal
      const overlap = combinedRadius - distance;
      const normal = distance > 0 ? {
        x: dx / distance,
        y: dy / distance,
        z: dz / distance,
      } : { x: 0, y: 1, z: 0 }; // Default up if spheres are at same position

      const point = {
        x: sphere1.center.x + normal.x * sphere1.radius,
        y: sphere1.center.y + normal.y * sphere1.radius,
        z: sphere1.center.z + normal.z * sphere1.radius,
      };

      return {
        collided: true,
        point,
        normal,
        distance: overlap,
      };
    }

    return { collided: false };
  }

  /**
   * Sphere-box collision detection
   */
  private checkSphereBoxCollision(sphere: BoundingSphere, box: BoundingBox): CollisionResult {
    // Find closest point on box to sphere center
    const closest = {
      x: Math.max(box.min.x, Math.min(sphere.center.x, box.max.x)),
      y: Math.max(box.min.y, Math.min(sphere.center.y, box.max.y)),
      z: Math.max(box.min.z, Math.min(sphere.center.z, box.max.z)),
    };

    const dx = sphere.center.x - closest.x;
    const dy = sphere.center.y - closest.y;
    const dz = sphere.center.z - closest.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (distance <= sphere.radius) {
      const normal = distance > 0 ? {
        x: dx / distance,
        y: dy / distance,
        z: dz / distance,
      } : { x: 0, y: 1, z: 0 };

      return {
        collided: true,
        point: closest,
        normal,
        distance: sphere.radius - distance,
      };
    }

    return { collided: false };
  }

  /**
   * Box-box collision detection (AABB)
   */
  private checkBoxBoxCollision(box1: BoundingBox, box2: BoundingBox): CollisionResult {
    const overlapX = Math.min(box1.max.x, box2.max.x) - Math.max(box1.min.x, box2.min.x);
    const overlapY = Math.min(box1.max.y, box2.max.y) - Math.max(box1.min.y, box2.min.y);
    const overlapZ = Math.min(box1.max.z, box2.max.z) - Math.max(box1.min.z, box2.min.z);

    if (overlapX > 0 && overlapY > 0 && overlapZ > 0) {
      // Find smallest overlap for collision normal
      const minOverlap = Math.min(overlapX, overlapY, overlapZ);
      let normal: Vector3;

      if (minOverlap === overlapX) {
        normal = box1.max.x > box2.max.x ? { x: 1, y: 0, z: 0 } : { x: -1, y: 0, z: 0 };
      } else if (minOverlap === overlapY) {
        normal = box1.max.y > box2.max.y ? { x: 0, y: 1, z: 0 } : { x: 0, y: -1, z: 0 };
      } else {
        normal = box1.max.z > box2.max.z ? { x: 0, y: 0, z: 1 } : { x: 0, y: 0, z: -1 };
      }

      const point = {
        x: (Math.max(box1.min.x, box2.min.x) + Math.min(box1.max.x, box2.max.x)) / 2,
        y: (Math.max(box1.min.y, box2.min.y) + Math.min(box1.max.y, box2.max.y)) / 2,
        z: (Math.max(box1.min.z, box2.min.z) + Math.min(box1.max.z, box2.max.z)) / 2,
      };

      return {
        collided: true,
        point,
        normal,
        distance: minOverlap,
      };
    }

    return { collided: false };
  }

  /**
   * Sphere vs infinite-height wall segment collision (2D XZ check).
   *
   * Finds the closest point on segment AB to the sphere centre projected into
   * the XZ plane.  If that 2D distance is less than the sphere radius the
   * player is inside (or touching) the wall, regardless of Y elevation —
   * walls block at every height.
   *
   * This replaces AABB-per-edge for building walls and eliminates the phantom
   * blocking that AABB corners produce on diagonal wall segments.
   */
  private checkSphereWallCollision(sphere: BoundingSphere, wall: WallSegment): CollisionResult {
    const dx = wall.bx - wall.ax;
    const dz = wall.bz - wall.az;
    const lenSq = dx * dx + dz * dz;

    if (lenSq === 0) return { collided: false }; // Degenerate zero-length segment

    // Parameter t ∈ [0,1] of the closest point on segment to sphere centre (XZ)
    const t = Math.max(0, Math.min(1,
      ((sphere.center.x - wall.ax) * dx + (sphere.center.z - wall.az) * dz) / lenSq,
    ));

    // Closest point on segment
    const closestX = wall.ax + t * dx;
    const closestZ = wall.az + t * dz;

    // 2D distance from sphere centre to closest wall point
    const cx = sphere.center.x - closestX;
    const cz = sphere.center.z - closestZ;
    const dist2D = Math.sqrt(cx * cx + cz * cz);

    if (dist2D <= sphere.radius) {
      let nx: number, nz: number;
      if (dist2D > 0) {
        nx = cx / dist2D;
        nz = cz / dist2D;
      } else {
        // Sphere centre is on the wall line — use wall perpendicular
        const len = Math.sqrt(lenSq);
        nx = -dz / len;
        nz =  dx / len;
      }

      return {
        collided: true,
        point:    { x: closestX, y: sphere.center.y, z: closestZ },
        normal:   { x: nx, y: 0, z: nz },
        distance: sphere.radius - dist2D,
      };
    }

    return { collided: false };
  }

  /**
   * Perform raycast against entities and terrain
   */
  raycast(
    origin: Vector3,
    direction: Vector3,
    maxDistance: number = 100,
    options: PhysicsQueryOptions = {}
  ): RaycastResult {
    const layers = options.layers ?? (
      CollisionLayer.TERRAIN |
      CollisionLayer.ENTITIES |
      CollisionLayer.STRUCTURES |
      CollisionLayer.WATER
    );
    const excludeIds = options.excludeEntityIds ?? [];

    let closestHit: RaycastResult | null = null;
    let closestDistance = maxDistance;

    // Raycast against entities
    if (layers & CollisionLayer.ENTITIES) {
      for (const entity of [...this.entities.values(), ...this.staticEntities.values()]) {
        if (excludeIds.includes(entity.id)) continue;

        const hit = this.raycastBoundingVolume(origin, direction, entity.boundingVolume, maxDistance);
        if (hit.hit && hit.distance! < closestDistance) {
          closestHit = { ...hit, entityId: entity.id };
          closestDistance = hit.distance!;
        }
      }
    }

    // Raycast against terrain
    if (layers & CollisionLayer.TERRAIN) {
      const terrainHit = this.raycastTerrain(origin, direction, maxDistance);
      if (terrainHit.hit && terrainHit.distance! < closestDistance) {
        closestHit = terrainHit;
        closestDistance = terrainHit.distance!;
      }
    }

    return closestHit || { hit: false };
  }

  /**
   * Raycast against a bounding volume
   */
  private raycastBoundingVolume(
    origin: Vector3,
    direction: Vector3,
    volume: BoundingVolume,
    maxDistance: number
  ): RaycastResult {
    if ('ax' in volume) {
      return this.raycastWall(origin, direction, volume as WallSegment, maxDistance);
    }
    if ('center' in volume) {
      return this.raycastSphere(origin, direction, volume, maxDistance);
    }
    return this.raycastBox(origin, direction, volume, maxDistance);
  }

  /**
   * Ray vs infinite-height wall segment (2D XZ intersection).
   *
   * Projects both the ray and the wall into the XZ plane and solves for the
   * parametric intersection.  Returns a hit when the ray crosses the segment
   * within [0, maxDistance].
   */
  private raycastWall(
    origin: Vector3,
    direction: Vector3,
    wall: WallSegment,
    maxDistance: number,
  ): RaycastResult {
    const wdx = wall.bx - wall.ax;
    const wdz = wall.bz - wall.az;

    // 2D cross product of ray direction and wall direction
    const denom = direction.x * wdz - direction.z * wdx;
    if (Math.abs(denom) < 1e-10) return { hit: false }; // Ray parallel to wall

    // t = how far along the ray the intersection occurs
    const t = ((wall.ax - origin.x) * wdz - (wall.az - origin.z) * wdx) / denom;
    // s = how far along the wall segment (0..1)
    const s = ((wall.ax - origin.x) * direction.z - (wall.az - origin.z) * direction.x) / denom;

    if (t < 0 || t > maxDistance || s < 0 || s > 1) return { hit: false };

    const point: Vector3 = {
      x: origin.x + direction.x * t,
      y: origin.y + direction.y * t,
      z: origin.z + direction.z * t,
    };

    // Wall normal perpendicular to wall in XZ, pointing toward ray origin
    const wLen = Math.sqrt(wdx * wdx + wdz * wdz);
    let nx = -wdz / wLen;
    let nz =  wdx / wLen;
    if (nx * direction.x + nz * direction.z > 0) { nx = -nx; nz = -nz; }

    return {
      hit: true,
      point,
      normal:   { x: nx, y: 0, z: nz },
      distance: t,
    };
  }

  /**
   * Ray-sphere intersection
   */
  private raycastSphere(
    origin: Vector3,
    direction: Vector3,
    sphere: BoundingSphere,
    maxDistance: number
  ): RaycastResult {
    const oc = {
      x: origin.x - sphere.center.x,
      y: origin.y - sphere.center.y,
      z: origin.z - sphere.center.z,
    };

    const a = direction.x * direction.x + direction.y * direction.y + direction.z * direction.z;
    const b = 2 * (oc.x * direction.x + oc.y * direction.y + oc.z * direction.z);
    const c = oc.x * oc.x + oc.y * oc.y + oc.z * oc.z - sphere.radius * sphere.radius;

    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return { hit: false };

    const sqrtD = Math.sqrt(discriminant);
    const t1 = (-b - sqrtD) / (2 * a);
    const t2 = (-b + sqrtD) / (2 * a);

    let t = t1;
    if (t < 0) t = t2;
    if (t < 0 || t > maxDistance) return { hit: false };

    const point = {
      x: origin.x + direction.x * t,
      y: origin.y + direction.y * t,
      z: origin.z + direction.z * t,
    };

    const normal = {
      x: (point.x - sphere.center.x) / sphere.radius,
      y: (point.y - sphere.center.y) / sphere.radius,
      z: (point.z - sphere.center.z) / sphere.radius,
    };

    return {
      hit: true,
      point,
      normal,
      distance: t,
    };
  }

  /**
   * Ray-box intersection (AABB)
   */
  private raycastBox(
    origin: Vector3,
    direction: Vector3,
    box: BoundingBox,
    maxDistance: number
  ): RaycastResult {
    const invDir = {
      x: direction.x !== 0 ? 1 / direction.x : Infinity,
      y: direction.y !== 0 ? 1 / direction.y : Infinity,
      z: direction.z !== 0 ? 1 / direction.z : Infinity,
    };

    const t1 = (box.min.x - origin.x) * invDir.x;
    const t2 = (box.max.x - origin.x) * invDir.x;
    const t3 = (box.min.y - origin.y) * invDir.y;
    const t4 = (box.max.y - origin.y) * invDir.y;
    const t5 = (box.min.z - origin.z) * invDir.z;
    const t6 = (box.max.z - origin.z) * invDir.z;

    const tmin = Math.max(Math.max(Math.min(t1, t2), Math.min(t3, t4)), Math.min(t5, t6));
    const tmax = Math.min(Math.min(Math.max(t1, t2), Math.max(t3, t4)), Math.max(t5, t6));

    if (tmax < 0 || tmin > tmax || tmin > maxDistance) return { hit: false };

    const t = tmin < 0 ? tmax : tmin;
    const point = {
      x: origin.x + direction.x * t,
      y: origin.y + direction.y * t,
      z: origin.z + direction.z * t,
    };

    // Calculate normal based on which face was hit
    const epsilon = 0.0001;
    let normal: Vector3 = { x: 0, y: 0, z: 0 };

    if (Math.abs(point.x - box.min.x) < epsilon) normal.x = -1;
    else if (Math.abs(point.x - box.max.x) < epsilon) normal.x = 1;
    else if (Math.abs(point.y - box.min.y) < epsilon) normal.y = -1;
    else if (Math.abs(point.y - box.max.y) < epsilon) normal.y = 1;
    else if (Math.abs(point.z - box.min.z) < epsilon) normal.z = -1;
    else if (Math.abs(point.z - box.max.z) < epsilon) normal.z = 1;

    return {
      hit: true,
      point,
      normal,
      distance: t,
    };
  }

  /**
   * Raycast against terrain
   */
  private raycastTerrain(origin: Vector3, direction: Vector3, maxDistance: number): RaycastResult {
    if (!this.elevationService) return { hit: false };

    // Simple terrain raycast - assumes downward ray for ground collision
    // For full terrain raycasting, would need more complex heightmap intersection
    if (direction.y >= 0) return { hit: false }; // Only downward rays hit terrain

    // Find intersection with horizontal plane at terrain height
    // This is simplified - real implementation would sample heightmap along ray
    const terrainHeight = 0; // Assume sea level for now, would query elevation service
    const t = (terrainHeight - origin.y) / direction.y;

    if (t < 0 || t > maxDistance) return { hit: false };

    const point = {
      x: origin.x + direction.x * t,
      y: terrainHeight,
      z: origin.z + direction.z * t,
    };

    return {
      hit: true,
      point,
      normal: { x: 0, y: 1, z: 0 }, // Up normal for ground
      distance: t,
    };
  }

  /**
   * Get terrain collision info at position
   */
  getTerrainCollision(position: Vector3): TerrainCollision {
    if (!this.elevationService) {
      return {
        elevation: 0,
        isWater: false,
      };
    }

    // Convert world coordinates to lat/lon.
    // World origin = zone centre (manifest origin lat/lon).
    // X = East (+) / West (-)  →  longitude increases with X
    // Z = South (+) / North (-) →  latitude DECREASES as Z increases
    //   (screen-up = -Z = northward = higher latitude)
    const metadata = this.elevationService.getMetadata();
    const centerLat = metadata.center?.lat ?? metadata.originLat;
    const centerLon = metadata.center?.lon ?? metadata.originLon;

    const metersPerDegreeLat = 111320;
    const metersPerDegreeLon = 111320 * Math.cos((centerLat * Math.PI) / 180);

    // Z increasing = moving south = latitude decreasing → subtract Z offset
    const lat = centerLat - position.z / metersPerDegreeLat;
    const lon = centerLon + position.x / metersPerDegreeLon;

    const elevation = this.elevationService.getElevationMeters(lat, lon) ?? 0;
    const isWater = this.waterService ? this.waterService.isWater(lat, lon) : elevation < 0;

    return {
      elevation,
      isWater,
      surfaceNormal: { x: 0, y: 1, z: 0 }, // Flat ground normal
    };
  }

  /**
   * Validate movement considering physics constraints
   */
  validateMovement(
    entityId: string,
    fromPosition: Vector3,
    toPosition: Vector3,
    entityRadius: number = 0.5,
    options: MovementValidationOptions = {}
  ): MovementValidation {
    void fromPosition;
    // Check terrain collision
    const terrainCollision = this.getTerrainCollision(toPosition);
    const waterSurfaceLevel = options.waterSurfaceLevel ?? (terrainCollision.isWater ? terrainCollision.elevation : 0);
    const allowUnderwater = options.allowUnderwater ?? false;
    const maxUnderwaterDepth = options.maxUnderwaterDepth;
    const maxUnderwaterSeconds = options.maxUnderwaterSeconds;
    const currentUnderwaterSeconds = options.currentUnderwaterSeconds ?? 0;

    if (terrainCollision.isWater && !allowUnderwater && toPosition.y < waterSurfaceLevel) {
      return {
        valid: false,
        adjustedPosition: {
          ...toPosition,
          y: waterSurfaceLevel,
        },
        reason: 'water_surface_block',
      };
    }

    if (terrainCollision.isWater && allowUnderwater && toPosition.y < waterSurfaceLevel) {
      const depth = waterSurfaceLevel - toPosition.y;
      if (maxUnderwaterDepth !== undefined && depth > maxUnderwaterDepth) {
        return {
          valid: false,
          adjustedPosition: {
            ...toPosition,
            y: waterSurfaceLevel - maxUnderwaterDepth,
          },
          reason: 'underwater_depth_limit',
        };
      }

      if (maxUnderwaterSeconds !== undefined && currentUnderwaterSeconds >= maxUnderwaterSeconds) {
        return {
          valid: false,
          adjustedPosition: {
            ...toPosition,
            y: waterSurfaceLevel,
          },
          reason: 'underwater_time_limit',
        };
      }
    }

    if (toPosition.y < terrainCollision.elevation) {
      // Hit ground - snap to terrain
      return {
        valid: false,
        adjustedPosition: {
          ...toPosition,
          y: terrainCollision.elevation,
        },
        reason: 'terrain_collision',
      };
    }

    // Check entity collisions
    const movingEntity = this.entities.get(entityId);
    if (movingEntity) {
      for (const [otherId, otherEntity] of [...this.entities, ...this.staticEntities]) {
        if (otherId === entityId) continue;

        const collision = this.checkBoundingVolumeCollision(
          { center: toPosition, radius: entityRadius },
          otherEntity.boundingVolume
        );

        if (collision.collided) {
          return {
            valid: false,
            collision,
            reason: 'entity_collision',
          };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Push a position out of any intersecting structure walls (2D XZ, infinite height).
   *
   * Iterates every registered WallSegment static entity and applies a separation
   * impulse for each penetration.  Multiple passes converge quickly for typical
   * building layouts.  Y is passed through unchanged.
   *
   * Used by the mob wander system so NPCs / mobs respect building walls the same
   * way players do.
   */
  resolveAgainstStructures(position: Vector3, radius: number): Vector3 {
    let rx = position.x;
    let rz = position.z;

    for (const entity of this.staticEntities.values()) {
      const vol = entity.boundingVolume;
      if (!('ax' in vol)) continue; // Only WallSegment entities

      const wall = vol as WallSegment;
      const dx   = wall.bx - wall.ax;
      const dz   = wall.bz - wall.az;
      const lenSq = dx * dx + dz * dz;
      if (lenSq === 0) continue;

      const t = Math.max(0, Math.min(1,
        ((rx - wall.ax) * dx + (rz - wall.az) * dz) / lenSq,
      ));

      const closestX = wall.ax + t * dx;
      const closestZ = wall.az + t * dz;

      const cx     = rx - closestX;
      const cz     = rz - closestZ;
      const dist2D = Math.sqrt(cx * cx + cz * cz);

      if (dist2D < radius) {
        if (dist2D > 0) {
          const penetration = radius - dist2D;
          rx += (cx / dist2D) * penetration;
          rz += (cz / dist2D) * penetration;
        } else {
          // Exactly on the wall line — push along wall perpendicular
          const len = Math.sqrt(lenSq);
          rx += (-dz / len) * radius;
          rz += ( dx / len) * radius;
        }
      }
    }

    return { x: rx, y: position.y, z: rz };
  }

  /**
   * Nudge an entity that is embedded in or pressed against building geometry to
   * a nearby clear position so physics can resume normally.
   *
   * Strategy: run resolveAgainstStructures with progressively larger radii (2×,
   * 3×, 4× the entity radius) to push the entity away from every nearby wall,
   * then lift it 1 m above its current Y so gravity / terrain-snap can drop it
   * cleanly to the ground surface.
   *
   * This is used by MobWanderSystem's stuckRequests handler and the /unstuck
   * player command.
   */
  nudgeToUnstuck(position: Vector3, radius: number): Vector3 {
    let pos: Vector3 = { ...position };
    // Each pass uses a larger effective radius, pushing the entity progressively
    // further from any wall it may be clipping through.
    for (const r of [radius * 2, radius * 3, radius * 4]) {
      pos = this.resolveAgainstStructures(pos, r);
    }
    // Lift 1 m so physics/terrain-snap drops the entity to the actual surface
    // rather than leaving it floating at the pre-nudge elevation.
    return { x: pos.x, y: pos.y + 1.0, z: pos.z };
  }

  /**
   * Check line of sight between two positions
   */
  checkLineOfSight(
    from: Vector3,
    to: Vector3,
    excludeEntityIds: string[] = []
  ): LineOfSightResult {
    const direction = {
      x: to.x - from.x,
      y: to.y - from.y,
      z: to.z - from.z,
    };

    const distance = Math.sqrt(direction.x * direction.x + direction.y * direction.y + direction.z * direction.z);
    if (distance === 0) return { clear: true };

    // Normalize direction
    const normalizedDir = {
      x: direction.x / distance,
      y: direction.y / distance,
      z: direction.z / distance,
    };

    const raycast = this.raycast(from, normalizedDir, distance, {
      layers: CollisionLayer.TERRAIN | CollisionLayer.ENTITIES | CollisionLayer.STRUCTURES,
      excludeEntityIds,
      maxDistance: distance,
    });

    if (raycast.hit) {
      return {
        clear: false,
        distance: raycast.distance,
        obstruction: raycast.point,
      };
    }

    return { clear: true };
  }

  /**
   * Tick physics for a single entity that has bPhysicsEnabled=true.
   *
   * Applies real gravity:
   *   - Accumulates downward velocity each tick (9.81 m/s²)
   *   - Moves entity by velocity * deltaTime
   *   - If the new position is at or below terrain, snaps to ground and
   *     zeros vertical velocity (landed)
   *
   * Returns { position, velocity, landed } — caller stores them back.
   */
  tickPhysics(
    position: Vector3,
    velocity: Vector3,
    deltaTime: number
  ): { position: Vector3; velocity: Vector3; landed: boolean } {
    const GRAVITY = -9.81; // m/s²
    const terminalVelocity = -55; // m/s — roughly human terminal velocity

    // Accumulate gravity
    const newVy = Math.max(terminalVelocity, velocity.y + GRAVITY * deltaTime);
    const newVelocity = { ...velocity, y: newVy };

    // Integrate position
    const newPosition: Vector3 = {
      x: position.x + newVelocity.x * deltaTime,
      y: position.y + newVelocity.y * deltaTime,
      z: position.z + newVelocity.z * deltaTime,
    };

    // Floor check
    const terrain = this.getTerrainCollision(newPosition);
    if (newPosition.y <= terrain.elevation) {
      return {
        position: { ...newPosition, y: terrain.elevation },
        velocity: { ...newVelocity, y: 0 },
        landed: true,
      };
    }

    return { position: newPosition, velocity: newVelocity, landed: false };
  }

  /**
   * Apply gravity to a position - pulls entities down to terrain level
   * Returns adjusted position (y may be lowered to terrain elevation)
   */
  applyGravity(position: Vector3): Vector3 {
    if (!this.elevationService) return position;

    const terrainCollision = this.getTerrainCollision(position);

    // Bidirectional snap — keep entities on the terrain surface whether
    // they're above (floating) or below (clipped).  The server is
    // authoritative on Y; stale DB values and movement ticks both need
    // to land cleanly on the heightmap.
    if (position.y !== terrainCollision.elevation) {
      return { ...position, y: terrainCollision.elevation };
    }

    return position;
  }

  /**
   * Create bounding sphere for entity
   */
  static createBoundingSphere(center: Vector3, radius: number): BoundingSphere {
    return { center: { ...center }, radius };
  }

  /**
   * Create bounding box for entity
   */
  static createBoundingBox(min: Vector3, max: Vector3): BoundingBox {
    return { min: { ...min }, max: { ...max } };
  }
}
