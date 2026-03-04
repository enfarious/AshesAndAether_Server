/**
 * geometry.ts — Pure math utilities for guild beacon polygon system.
 * Convex hull, point-in-polygon, overlap detection, area computation,
 * and inverse-distance-weighted tier interpolation.
 */

export interface Point2D {
  x: number;
  z: number;
}

export interface TieredPoint extends Point2D {
  tier: number;
}

/**
 * Compute the convex hull of a set of 2D points using Graham scan.
 * Returns vertices in counter-clockwise order.
 * For 3-5 beacon points this is trivial but correct for any N >= 3.
 */
export function computeConvexHull(points: Point2D[]): Point2D[] {
  if (points.length < 3) return [...points];

  // Find the bottom-most (then left-most) point as pivot
  let pivot = points[0];
  for (let i = 1; i < points.length; i++) {
    if (points[i].z < pivot.z || (points[i].z === pivot.z && points[i].x < pivot.x)) {
      pivot = points[i];
    }
  }

  // Sort by polar angle relative to pivot
  const sorted = points
    .filter((p) => p !== pivot)
    .sort((a, b) => {
      const angleA = Math.atan2(a.z - pivot.z, a.x - pivot.x);
      const angleB = Math.atan2(b.z - pivot.z, b.x - pivot.x);
      if (angleA !== angleB) return angleA - angleB;
      // Same angle: closer point first
      const distA = (a.x - pivot.x) ** 2 + (a.z - pivot.z) ** 2;
      const distB = (b.x - pivot.x) ** 2 + (b.z - pivot.z) ** 2;
      return distA - distB;
    });

  const hull: Point2D[] = [pivot];
  for (const p of sorted) {
    while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) {
      hull.pop();
    }
    hull.push(p);
  }

  return hull;
}

/** Cross product of vectors (O→A) and (O→B). Positive = CCW turn. */
function cross(o: Point2D, a: Point2D, b: Point2D): number {
  return (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
}

/**
 * Ray-casting point-in-polygon test.
 * Returns true if the point is inside the polygon (vertices in any winding order).
 */
export function isPointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
  if (polygon.length < 3) return false;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const zi = polygon[i].z;
    const xj = polygon[j].x;
    const zj = polygon[j].z;

    const intersect =
      zi > point.z !== zj > point.z &&
      point.x < ((xj - xi) * (point.z - zi)) / (zj - zi) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

/**
 * Check if two convex polygons overlap.
 * Uses separating axis theorem (SAT) — if no separating axis exists, they overlap.
 */
export function polygonsOverlap(a: Point2D[], b: Point2D[]): boolean {
  if (a.length < 3 || b.length < 3) return false;

  // Check all edge normals of both polygons as separating axes
  const polygons = [a, b];
  for (const poly of polygons) {
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      // Edge normal (perpendicular)
      const nx = poly[j].z - poly[i].z;
      const nz = -(poly[j].x - poly[i].x);

      // Project both polygons onto this axis
      let minA = Infinity, maxA = -Infinity;
      for (const p of a) {
        const proj = p.x * nx + p.z * nz;
        minA = Math.min(minA, proj);
        maxA = Math.max(maxA, proj);
      }

      let minB = Infinity, maxB = -Infinity;
      for (const p of b) {
        const proj = p.x * nx + p.z * nz;
        minB = Math.min(minB, proj);
        maxB = Math.max(maxB, proj);
      }

      // If projections don't overlap on this axis, polygons are separated
      if (maxA < minB || maxB < minA) return false;
    }
  }

  return true;
}

/**
 * Compute the area of a simple polygon using the shoelace formula.
 * Returns absolute area in square units (square meters if coords are in meters).
 */
export function computePolygonArea(vertices: Point2D[]): number {
  if (vertices.length < 3) return 0;

  let area = 0;
  for (let i = 0; i < vertices.length; i++) {
    const j = (i + 1) % vertices.length;
    area += vertices[i].x * vertices[j].z;
    area -= vertices[j].x * vertices[i].z;
  }

  return Math.abs(area) / 2;
}

/**
 * Inverse-distance-weighted tier interpolation for the per-vertex gradient system.
 *
 * Given a point inside a polygon and the tiered vertices, compute the effective
 * corruption-clearing tier at that point. Closer to a high-tier vertex = stronger clearing.
 *
 * Uses IDW with power parameter p=2 (inverse square distance).
 * Returns a float tier value (e.g., 3.7 means between T3 and T4 clearing).
 *
 * Edge case: if the point is exactly on a vertex, returns that vertex's tier.
 */
export function interpolatePolygonTier(point: Point2D, vertices: TieredPoint[]): number {
  if (vertices.length === 0) return 0;
  if (vertices.length === 1) return vertices[0].tier;

  const EPSILON = 0.01; // meters — snap-to-vertex threshold
  let weightSum = 0;
  let tierSum = 0;

  for (const v of vertices) {
    const dx = point.x - v.x;
    const dz = point.z - v.z;
    const distSq = dx * dx + dz * dz;

    // If we're essentially on the vertex, return its tier directly
    if (distSq < EPSILON * EPSILON) return v.tier;

    // IDW weight: 1/d^2
    const weight = 1 / distSq;
    weightSum += weight;
    tierSum += weight * v.tier;
  }

  return tierSum / weightSum;
}

/**
 * Euclidean distance between two 2D points.
 */
export function distance2D(a: Point2D, b: Point2D): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}
