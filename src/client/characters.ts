// Third-person player models: primitive-built operators with procedural locomotion.

import * as THREE from 'three';
import type { Player } from '../sim/types';
import { lerp } from '../sim/math';

const box = new THREE.BoxGeometry(1, 1, 1);
const headGeo = new THREE.SphereGeometry(0.135, 14, 10);

interface TeamMats {
  suit: THREE.MeshStandardMaterial;
  armor: THREE.MeshStandardMaterial;
  glow: THREE.MeshBasicMaterial;
}
const dark = new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.6, metalness: 0.5 });
const teamMats: TeamMats[] = [
  {
    suit: new THREE.MeshStandardMaterial({ color: 0x5a3a2a, roughness: 0.8, metalness: 0.1 }),
    armor: new THREE.MeshStandardMaterial({ color: 0xb5562a, roughness: 0.55, metalness: 0.35 }),
    glow: new THREE.MeshBasicMaterial({ color: 0xff7a2e, toneMapped: false }),
  },
  {
    suit: new THREE.MeshStandardMaterial({ color: 0x2a3d55, roughness: 0.8, metalness: 0.1 }),
    armor: new THREE.MeshStandardMaterial({ color: 0x2f7fa8, roughness: 0.55, metalness: 0.35 }),
    glow: new THREE.MeshBasicMaterial({ color: 0x35e0ff, toneMapped: false }),
  },
];

function part(parent: THREE.Object3D, m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(box, m);
  mesh.scale.set(w, h, d);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

export class CharacterView {
  readonly group = new THREE.Group();
  private upper = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private marker: THREE.Mesh;
  private team = -1;
  private phase = 0;
  private deathT = -1;
  private yaw = 0;
  private pitch = 0;
  /** World position of the gun muzzle, for tracers. */
  readonly muzzle = new THREE.Vector3();
  private muzzleLocal = new THREE.Object3D();

  constructor() {
    // Legs pivot at the hip.
    for (const [leg, x] of [[this.legL, -0.11], [this.legR, 0.11]] as const) {
      leg.position.set(x, 0.92, 0);
      this.meshes.push(part(leg, dark, 0.17, 0.5, 0.2, 0, -0.24, 0));
      this.meshes.push(part(leg, dark, 0.15, 0.46, 0.17, 0, -0.69, 0.01));
      this.meshes.push(part(leg, dark, 0.16, 0.08, 0.28, 0, -0.88, -0.05));
      this.group.add(leg);
    }
    this.upper.position.y = 0.92;
    this.group.add(this.upper);
    const u = this.upper;
    this.meshes.push(part(u, dark, 0.4, 0.2, 0.24, 0, 0.08, 0)); // hips
    this.meshes.push(part(u, dark, 0.46, 0.44, 0.28, 0, 0.4, 0)); // torso (team armour)
    this.meshes.push(part(u, dark, 0.5, 0.14, 0.3, 0, 0.58, 0)); // shoulders
    const head = new THREE.Mesh(headGeo, dark);
    head.position.set(0, 0.79, 0);
    u.add(head);
    this.meshes.push(head);
    this.meshes.push(part(u, dark, 0.2, 0.05, 0.06, 0, 0.8, -0.115)); // visor (glow)
    this.meshes.push(part(u, dark, 0.12, 0.24, 0.06, 0, 0.4, -0.15)); // chest light (glow)
    // Arms reaching forward to the weapon.
    const armR = part(u, dark, 0.11, 0.11, 0.5, 0.2, 0.42, -0.24);
    armR.rotation.y = 0.25;
    const armL = part(u, dark, 0.11, 0.11, 0.56, -0.17, 0.4, -0.3);
    armL.rotation.y = -0.45;
    this.meshes.push(armR, armL);
    // Weapon.
    this.meshes.push(part(u, dark, 0.06, 0.1, 0.62, 0.1, 0.4, -0.52));
    this.meshes.push(part(u, dark, 0.04, 0.16, 0.06, 0.1, 0.3, -0.5));
    this.muzzleLocal.position.set(0.1, 0.41, -0.86);
    u.add(this.muzzleLocal);

    // Marker above friendlies.
    this.marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.09), teamMats[0]!.glow);
    this.marker.position.y = 2.15;
    this.group.add(this.marker);
    this.group.visible = false;
  }

  private applyTeam(team: number): void {
    this.team = team;
    const t = teamMats[team]!;
    const m = this.meshes;
    // Indices follow construction order: 6 leg parts, hips, torso, shoulders, head, visor, chest light, arms, gun.
    for (let i = 0; i < 6; i++) m[i]!.material = i % 3 === 2 ? dark : t.suit;
    m[6]!.material = t.suit;
    m[7]!.material = t.armor;
    m[8]!.material = t.armor;
    m[9]!.material = t.suit;
    m[10]!.material = t.glow;
    m[11]!.material = t.glow;
    m[12]!.material = t.suit;
    m[13]!.material = t.suit;
    m[14]!.material = dark;
    m[15]!.material = dark;
    this.marker.material = t.glow;
  }

  update(p: Player, alpha: number, dt: number, friendly: boolean, hide: boolean): void {
    if (hide) {
      this.group.visible = false;
      return;
    }
    if (p.team !== this.team) this.applyTeam(p.team);

    if (!p.alive) {
      if (this.deathT < 0) {
        this.group.visible = false;
        return;
      }
      // Collapse backwards.
      this.deathT = Math.min(1, this.deathT + dt / 0.45);
      const e = 1 - (1 - this.deathT) * (1 - this.deathT);
      this.group.rotation.x = e * 1.5;
      this.group.position.y = p.pos.y + e * 0.12;
      this.marker.visible = false;
      return;
    }
    this.deathT = 0;
    this.group.visible = true;
    this.group.rotation.x = 0;

    const x = lerp(p.prevPos.x, p.pos.x, alpha);
    const y = lerp(p.prevPos.y, p.pos.y, alpha);
    const z = lerp(p.prevPos.z, p.pos.z, alpha);
    this.group.position.set(x, y, z);
    // Smooth facing so 64 Hz bot aim does not look jittery.
    let dy = p.yaw - this.yaw;
    dy = ((dy + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    const k = Math.min(1, dt * 22);
    this.yaw += dy * k;
    this.pitch += (p.pitch - this.pitch) * k;
    this.group.rotation.y = this.yaw;

    const crouch = lerp(p.prevCrouchT, p.crouchT, alpha);
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const moving = p.onGround && speed > 0.4;
    this.phase += dt * (4 + speed * 1.7) * (moving ? 1 : 0);
    const swing = moving ? Math.sin(this.phase) * Math.min(0.75, speed * 0.13) : 0;
    const air = p.onGround ? 0 : 0.35;
    this.legL.rotation.x = swing + air + crouch * 0.9;
    this.legR.rotation.x = -swing - air * 0.4 + crouch * 0.9;
    const drop = crouch * 0.42;
    this.legL.position.y = this.legR.position.y = 0.92 - drop;
    this.legL.scale.y = this.legR.scale.y = 1 - crouch * 0.42;
    this.upper.position.y = 0.92 - drop + (moving ? Math.abs(Math.cos(this.phase)) * 0.03 : 0);
    this.upper.rotation.x = THREE.MathUtils.clamp(this.pitch, -0.9, 0.9) * 0.7 - crouch * 0.12;
    this.marker.visible = friendly;

    this.muzzleLocal.getWorldPosition(this.muzzle);
  }

  hideCorpse(): void {
    this.deathT = -1;
    this.group.visible = false;
  }
}
