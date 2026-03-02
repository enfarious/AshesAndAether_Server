/**
 * Container — a PhysicsObject that can hold items/inventory.
 * Middle tier in the hierarchy; not a living thing but can be physical.
 */

import { PhysicsObject, type Vector3 } from './PhysicsObject';

export class Container extends PhysicsObject {
  readonly name: string;

  constructor(id: string, name: string, position: Vector3, bPhysicsEnabled = true) {
    super(id, position, bPhysicsEnabled);
    this.name = name;
  }
}
