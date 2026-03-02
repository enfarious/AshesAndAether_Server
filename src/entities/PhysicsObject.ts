/**
 * PhysicsObject — base for anything that occupies space and is subject to physics.
 *
 * bPhysicsEnabled = true  → zone server applies gravity, collision, etc. each tick
 * bPhysicsEnabled = false → static/decorative; never ticked by physics (e.g. furniture)
 */

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export class PhysicsObject {
  readonly id: string;
  position: Vector3;
  velocity: Vector3;
  bPhysicsEnabled: boolean;

  constructor(id: string, position: Vector3, bPhysicsEnabled = true) {
    this.id = id;
    this.position = { ...position };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.bPhysicsEnabled = bPhysicsEnabled;
  }
}
