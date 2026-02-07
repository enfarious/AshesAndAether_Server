import type { Vector3 } from '@/network/protocol/types';

/**
 * Physics system types for collision detection, raycasting, and terrain interaction
 */

// Bounding volume types
export interface BoundingSphere {
  center: Vector3;
  radius: number;
}

export interface BoundingBox {
  min: Vector3;
  max: Vector3;
}

export type BoundingVolume = BoundingSphere | BoundingBox;

// Collision detection results
export interface CollisionResult {
  collided: boolean;
  point?: Vector3; // Point of collision
  normal?: Vector3; // Surface normal at collision point
  distance?: number; // Distance to collision
}

// Raycast results
export interface RaycastResult {
  hit: boolean;
  point?: Vector3; // Intersection point
  normal?: Vector3; // Surface normal
  distance?: number; // Distance from ray origin to hit
  entityId?: string; // Entity that was hit (if applicable)
}

// Terrain collision types
export interface TerrainCollision {
  elevation: number; // Ground elevation at position
  isWater: boolean; // Whether position is underwater
  surfaceNormal?: Vector3; // Terrain surface normal
}

// Physics entity representation
export interface PhysicsEntity {
  id: string;
  position: Vector3;
  boundingVolume: BoundingVolume;
  type: 'static' | 'dynamic'; // Static objects don't move, dynamic do
  collisionLayer: CollisionLayerMask;
}

// Collision layers for filtering
export const CollisionLayer = {
  TERRAIN: 1 << 0,
  ENTITIES: 1 << 1,
  STRUCTURES: 1 << 2,
  WATER: 1 << 3,
} as const;

export type CollisionLayerMask = (typeof CollisionLayer)[keyof typeof CollisionLayer];

// Physics query options
export interface PhysicsQueryOptions {
  layers?: CollisionLayerMask; // Which layers to check
  excludeEntityIds?: string[]; // Entities to ignore
  maxDistance?: number; // Maximum distance for raycasts
}

export interface MovementValidationOptions {
  allowUnderwater?: boolean;
  waterSurfaceLevel?: number;
  maxUnderwaterDepth?: number;
  maxUnderwaterSeconds?: number;
  currentUnderwaterSeconds?: number;
}

// Movement validation result
export interface MovementValidation {
  valid: boolean;
  adjustedPosition?: Vector3; // Position after physics constraints
  collision?: CollisionResult;
  reason?: string; // Why movement was invalid
}

// Line of sight result
export interface LineOfSightResult {
  clear: boolean; // Whether LOS is clear
  distance?: number; // Distance to first obstruction
  obstruction?: Vector3; // Point of obstruction
}

