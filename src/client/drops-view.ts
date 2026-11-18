// Weapons on the floor, drawn with the same models and skins the players carry: lying on their
// side wherever they came to rest, turning as they fly. Online the server sends where each one
// is 32 times a second; in between they are eased toward it.

import * as THREE from 'three';
import type { Sim } from '../sim/game';
import { looseGun } from './characters';

interface Item {
  weapon: string;
  pivot: THREE.Group;
  cans: THREE.Object3D[];
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Half the height of the box a dropped gun is swept as: its middle rests this far off the floor. */
const REST_OFF = 0.03;

const _box = new THREE.Box3();
const _part = new THREE.Box3();
const _c = new THREE.Vector3();

export class DropsView {
  readonly group = new THREE.Group();
  private items = new Map<number, Item>();

  private make(weapon: string, id: number): Item | null {
    const gun = looseGun(weapon);
    if (!gun) return null;
    // On its side, either side up; then moved so it is centred over the pivot and rests on it.
    const lay = new THREE.Group();
    lay.add(gun);
    lay.rotation.x = id % 2 ? -Math.PI / 2 : Math.PI / 2;
    lay.updateMatrixWorld(true);
    // (measured by what is shown: not the parts left off it, nor a suppressor it may not wear)
    const cans = (gun.userData['cans'] as THREE.Object3D[] | undefined) ?? [];
    for (const c of cans) c.visible = false;
    _box.makeEmpty();
    lay.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      _part.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
      _box.union(_part);
    });
    _box.getCenter(_c);
    lay.position.set(-_c.x, -_box.min.y, -_c.z);
    const pivot = new THREE.Group();
    pivot.add(lay);
    gun.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
    this.group.add(pivot);
    return { weapon, pivot, cans, x: 0, y: 0, z: 0, yaw: 0 };
  }

  update(sim: Sim, dt: number): void {
    const live = new Set<number>();
    const k = 1 - Math.exp(-dt * 24);
    for (const d of sim.drops) {
      let it = this.items.get(d.id);
      if (it && it.weapon !== d.weapon.def.id) { this.drop(d.id); it = undefined; }
      if (!it) {
        const made = this.make(d.weapon.def.id, d.id);
        if (!made) continue;
        it = made;
        it.x = d.pos.x; it.y = d.pos.y; it.z = d.pos.z; it.yaw = d.yaw;
        this.items.set(d.id, it);
      }
      live.add(d.id);
      // Eased toward where the simulation has it; a jump of more than a couple of metres is taken at once.
      if (Math.hypot(d.pos.x - it.x, d.pos.y - it.y, d.pos.z - it.z) > 2.5) { it.x = d.pos.x; it.y = d.pos.y; it.z = d.pos.z; }
      it.x += (d.pos.x - it.x) * k; it.y += (d.pos.y - it.y) * k; it.z += (d.pos.z - it.z) * k;
      let dy = d.yaw - it.yaw;
      dy = ((dy + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      it.yaw += dy * k;
      it.pivot.position.set(it.x, it.y - REST_OFF, it.z);
      it.pivot.rotation.y = it.yaw;
      for (const c of it.cans) c.visible = d.weapon.quiet;
    }
    for (const id of [...this.items.keys()]) if (!live.has(id)) this.drop(id);
  }

  private drop(id: number): void {
    const it = this.items.get(id);
    if (!it) return;
    this.group.remove(it.pivot);
    this.items.delete(id);
  }

  clear(): void {
    for (const id of [...this.items.keys()]) this.drop(id);
  }
}
