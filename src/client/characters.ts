// Third-person players: a skinned soldier driven by authored animation clips.
// Legs follow the direction of travel, the torso follows the aim, the weapon sits at the
// shoulder pointing exactly where the player is aiming, and both arms are solved onto
// its grips with two-bone inverse kinematics.

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { Player } from '../sim/types';
import { lerp } from '../sim/math';
import { WEAPON_LOOK, getCharacters, type CharacterAssets, type WorldGun } from './assets';
import { WORLD_GUN_FINISH, applyFinish } from './finish';

const TEAM_HEX = [0xff7a2e, 0x35e0ff];
/** Body: a slight warm or cool cast. Accents (pads, cap, headset): a strong team colour. */
const TEAM_TINT: [number, number, number][] = [[1.28, 1.12, 0.92], [0.95, 1.12, 1.3]];
const TEAM_ACCENT: [number, number, number][] = [[2.2, 1.0, 0.45], [0.5, 1.5, 2.2]];

interface Shared {
  assets: CharacterAssets;
  clips: Map<string, THREE.AnimationClip>;
  death: THREE.AnimationClip | null;
  /** One material set per team, shared by every character on it. */
  mats: Map<THREE.Material, THREE.Material>[];
  gunMats: Map<THREE.Material, THREE.Material>;
}

let shared: Shared | null = null;

function prepare(assets: CharacterAssets): Shared {
  const clips = new Map<string, THREE.AnimationClip>();
  const pick = (name: string, ...fallbacks: string[]): THREE.AnimationClip | null => {
    for (const n of [name, ...fallbacks]) {
      const c = assets.clips.get(n);
      if (c) return c;
    }
    return null;
  };
  const add = (key: string, clip: THREE.AnimationClip | null): void => {
    if (clip) clips.set(key, clip);
  };
  add('idle', pick('idle'));
  add('walk', pick('walk', 'walkF'));
  add('run', pick('run', 'jogF'));
  add('crouchIdle', pick('crouchIdle'));
  add('crouchWalk', pick('crouchWalk', 'crouchF'));
  add('air', pick('jumpLoop'));

  const mats: Map<THREE.Material, THREE.Material>[] = [new Map(), new Map()];
  assets.model.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as THREE.MeshStandardMaterial;
    // Animated limbs leave the bind-pose bounds; widen them once on the shared geometry.
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    if (mesh.geometry.boundingSphere && !mesh.geometry.userData['widened']) {
      mesh.geometry.boundingSphere.radius *= 2.2;
      mesh.geometry.userData['widened'] = true;
    }
    for (let team = 0; team < 2; team++) {
      if (mats[team]!.has(src)) continue;
      const m = src.clone();
      const accent = /Pads|Cap|Headphones/i.test(src.name);
      const t = (accent ? TEAM_ACCENT : TEAM_TINT)[team]!;
      m.color.setRGB(m.color.r * t[0], m.color.g * t[1], m.color.b * t[2]);
      m.metalness = Math.min(m.metalness ?? 0, 0.3);
      // Only the accents glow, faintly, so a silhouette still reads in deep shadow.
      m.emissive = new THREE.Color(TEAM_HEX[team]!);
      m.emissiveIntensity = accent ? 0.22 : 0.012;
      mats[team]!.set(src, m);
    }
  });
  return { assets, clips, death: pick('death', 'deathB', 'deathFront'), mats, gunMats: new Map() };
}

function gunMaterial(s: Shared, src: THREE.Material, mesh: THREE.Mesh): THREE.Material {
  let m = s.gunMats.get(src);
  if (!m) s.gunMats.set(src, (m = applyFinish(src, WORLD_GUN_FINISH, [mesh])));
  return m;
}

/** How each kind of weapon is carried: grip position relative to the chest, in the aim frame. */
const CARRY: Record<string, { grip: [number, number, number]; twoHanded: boolean }> = {
  rifle: { grip: [0.15, 0.1, -0.3], twoHanded: true },
  smg: { grip: [0.14, 0.1, -0.34], twoHanded: true },
  pistol: { grip: [0.06, 0.2, -0.52], twoHanded: true },
  knife: { grip: [0.24, -0.08, -0.36], twoHanded: false },
};

const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _t = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _aimQ = new THREE.Quaternion();
const _groupQ = new THREE.Quaternion();
const _HALF_PI_Y = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
const _BLADE = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2.4, 0, 0));

/** Turn `bone` (by a world-space rotation) so the direction from `from` to `tip` becomes `want`. */
function aimBone(bone: THREE.Object3D, from: THREE.Vector3, tip: THREE.Vector3, want: THREE.Vector3): void {
  _d.copy(tip).sub(from);
  if (_d.lengthSq() < 1e-10 || !bone.parent) return;
  _q2.setFromUnitVectors(_d.normalize(), want);
  bone.parent.getWorldQuaternion(_q3);
  _q1.copy(_q3).invert().multiply(_q2).multiply(_q3);
  bone.quaternion.premultiply(_q1);
  bone.updateMatrixWorld(true);
}

interface Arm {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  hand: THREE.Object3D;
  finger: THREE.Object3D | null;
  l1: number;
  l2: number;
}

/** Two-bone IK: put the hand on `target`, bending the elbow toward `pole` (both world space). */
function solveArm(arm: Arm, target: THREE.Vector3, pole: THREE.Vector3, fingers: THREE.Vector3): void {
  const { upper, lower, hand, l1, l2 } = arm;
  upper.getWorldPosition(_a);
  _b.copy(target).sub(_a);
  const d = Math.min(Math.max(_b.length(), 0.05), l1 + l2 - 0.005);
  _b.normalize();
  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  const sinA = Math.sqrt(1 - cosA * cosA);
  // Elbow direction: the pole with its component along the arm removed.
  _c.copy(pole).addScaledVector(_b, -pole.dot(_b));
  if (_c.lengthSq() < 1e-8) _c.set(0, -1, 0);
  _c.normalize();
  // want (shoulder -> elbow)
  _t.copy(_b).multiplyScalar(cosA).addScaledVector(_c, sinA).normalize();
  lower.getWorldPosition(_c);
  aimBone(upper, _a, _c, _t);
  // then forearm -> the reachable point along the line to the target
  _t.copy(_b).multiplyScalar(d).add(_a);
  lower.getWorldPosition(_a);
  hand.getWorldPosition(_c);
  _b.copy(_t).sub(_a).normalize();
  aimBone(lower, _a, _c, _b);
  if (arm.finger) {
    hand.getWorldPosition(_a);
    arm.finger.getWorldPosition(_c);
    aimBone(hand, _a, _c, fingers);
  }
}

export class CharacterView {
  /** Positioned at the player's feet and turned to their aim yaw (forward is -Z). */
  readonly group = new THREE.Group();
  /** World position of the weapon's muzzle, for tracers and flashes. */
  readonly muzzle = new THREE.Vector3();

  private rig: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private deathAction: THREE.AnimationAction | null = null;
  private spine: THREE.Object3D | null = null;
  private spineRest = new THREE.Quaternion();
  private chest: THREE.Object3D | null = null;
  private armR: Arm | null = null;
  private armL: Arm | null = null;
  private meshes: THREE.Mesh[] = [];

  private gunHolder = new THREE.Group();
  private guns = new Map<string, THREE.Object3D>();
  private gun: WorldGun | null = null;
  private gunKey = '';

  private marker: THREE.Mesh;
  private placeholder: THREE.Mesh;
  private team = -1;
  private yaw = 0;
  private pitch = 0;
  private legYaw = 0;
  private dead = false;
  private hidden = true;

  constructor() {
    this.marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.08), new THREE.MeshBasicMaterial({ color: TEAM_HEX[0], toneMapped: false }));
    this.marker.position.y = 2.12;
    // Shown only until the soldier model has loaded.
    this.placeholder = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 1.1, 4, 10), new THREE.MeshStandardMaterial({ color: 0x556070, roughness: 0.8 }));
    this.placeholder.position.y = 0.9;
    this.group.add(this.marker, this.placeholder, this.gunHolder);
    this.group.visible = false;
  }

  private build(): boolean {
    const assets = getCharacters();
    if (!assets) return false;
    if (!shared || shared.assets !== assets) shared = prepare(assets);
    const rig = SkeletonUtils.clone(assets.model.scene);
    // The model faces +Z; players face -Z.
    rig.rotation.y = Math.PI;
    const bones = new Map<string, THREE.Object3D>();
    rig.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = false;
        this.meshes.push(mesh);
        mesh.userData['src'] = mesh.material;
      }
      bones.set(o.name, o);
    });
    this.spine = bones.get('spine_02') ?? null;
    if (this.spine) this.spineRest.copy(this.spine.quaternion);
    this.chest = bones.get('spine_03') ?? this.spine;
    rig.updateMatrixWorld(true);
    const arm = (s: 'l' | 'r'): Arm | null => {
      const upper = bones.get(`upperarm_${s}`), lower = bones.get(`lowerarm_${s}`), hand = bones.get(`hand_${s}`);
      if (!upper || !lower || !hand) return null;
      const l1 = upper.getWorldPosition(_a).distanceTo(lower.getWorldPosition(_b));
      const l2 = lower.getWorldPosition(_a).distanceTo(hand.getWorldPosition(_b));
      return { upper, lower, hand, finger: bones.get(`middle_01_${s}`) ?? null, l1, l2 };
    };
    this.armR = arm('r');
    this.armL = arm('l');

    this.mixer = new THREE.AnimationMixer(rig);
    for (const [key, clip] of shared.clips) {
      const a = this.mixer.clipAction(clip);
      a.enabled = true;
      a.setEffectiveWeight(key === 'idle' ? 1 : 0);
      a.play();
      this.actions.set(key, a);
    }
    if (shared.death) {
      this.deathAction = this.mixer.clipAction(shared.death);
      this.deathAction.setLoop(THREE.LoopOnce, 1);
      this.deathAction.clampWhenFinished = true;
    }
    this.rig = rig;
    this.group.add(rig);
    this.placeholder.visible = false;
    this.team = -1;
    return true;
  }

  private applyTeam(team: number): void {
    this.team = team;
    (this.marker.material as THREE.MeshBasicMaterial).color.setHex(TEAM_HEX[team]!);
    if (!shared) return;
    for (const mesh of this.meshes) {
      const m = shared.mats[team]!.get(mesh.userData['src'] as THREE.Material);
      if (m) mesh.material = m;
    }
  }

  private setGun(key: string): void {
    if (key === this.gunKey || !shared) return;
    this.gunKey = key;
    for (const g of this.guns.values()) g.visible = false;
    this.gun = shared.assets.guns.get(key) ?? null;
    if (!this.gun) return;
    let obj = this.guns.get(key);
    if (!obj) {
      obj = this.gun.scene.clone(true);
      obj.traverse((o) => {
        // Optional attachments are stored in these files but not fitted.
        if (/^(silencer|foregrip|light)(_\d+)?$/.test(o.name)) o.visible = false;
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.material = gunMaterial(shared!, mesh.material as THREE.Material, mesh);
          mesh.castShadow = false;
        }
      });
      this.gunHolder.add(obj);
      this.guns.set(key, obj);
    }
    obj.visible = true;
  }

  private play(name: string, timeScale: number, dt: number): void {
    // Blend toward the wanted clip; everything else fades out.
    const k = Math.min(1, dt * 9);
    for (const [key, a] of this.actions) {
      const target = key === name ? 1 : 0;
      const w = a.getEffectiveWeight();
      a.setEffectiveWeight(w + (target - w) * k);
      if (key === name) a.timeScale = timeScale;
    }
  }

  update(p: Player, alpha: number, dt: number, friendly: boolean, hide: boolean): void {
    if (hide) {
      this.group.visible = false;
      this.hidden = true;
      return;
    }
    if (!this.rig && !this.build() && !p.alive) {
      this.group.visible = false;
      return;
    }
    if (p.team !== this.team) this.applyTeam(p.team);

    if (!p.alive) {
      if (this.hidden && !this.dead) {
        this.group.visible = false;
        return;
      }
      if (!this.dead) {
        // Fall where they stood.
        this.dead = true;
        this.marker.visible = false;
        this.gunHolder.visible = false;
        for (const a of this.actions.values()) a.setEffectiveWeight(0);
        if (this.deathAction) {
          this.deathAction.reset();
          this.deathAction.setEffectiveWeight(1);
          this.deathAction.play();
        } else if (this.rig) {
          this.rig.rotation.x = -1.45;
        }
        this.placeholder.rotation.x = 1.5;
      }
      this.mixer?.update(dt);
      return;
    }

    if (this.dead || this.hidden) {
      // Respawned (or first shown): stand up again.
      this.dead = false;
      this.hidden = false;
      this.deathAction?.stop();
      if (this.rig) this.rig.rotation.x = 0;
      this.placeholder.rotation.x = 0;
      this.gunHolder.visible = true;
      this.yaw = p.yaw;
      this.pitch = p.pitch;
      this.legYaw = 0;
    }
    this.group.visible = true;
    this.marker.visible = friendly;

    const x = lerp(p.prevPos.x, p.pos.x, alpha);
    const y = lerp(p.prevPos.y, p.pos.y, alpha);
    const z = lerp(p.prevPos.z, p.pos.z, alpha);
    this.group.position.set(x, y, z);
    // Smooth facing so 64 Hz aim updates never look jittery.
    let dy = p.yaw - this.yaw;
    dy = ((dy + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    const k = Math.min(1, dt * 22);
    this.yaw += dy * k;
    this.pitch += (p.pitch - this.pitch) * k;
    this.group.rotation.y = this.yaw;

    if (!this.rig || !this.mixer) {
      this.muzzle.set(x, y + 1.4, z);
      return;
    }

    // ---- locomotion --------------------------------------------------------------
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const crouch = lerp(p.prevCrouchT, p.crouchT, alpha);
    // Turn the legs toward the direction of travel; walk backwards rather than spin round.
    let wantLeg = 0;
    let reverse = 1;
    if (speed > 0.6 && p.onGround) {
      const moveYaw = Math.atan2(-p.vel.x, -p.vel.z);
      let d = moveYaw - this.yaw;
      d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      if (d > Math.PI / 2 + 0.2) { d -= Math.PI; reverse = -1; }
      else if (d < -Math.PI / 2 - 0.2) { d += Math.PI; reverse = -1; }
      wantLeg = d;
    }
    this.legYaw += (wantLeg - this.legYaw) * Math.min(1, dt * 10);
    this.rig.rotation.y = Math.PI + this.legYaw;

    if (!p.onGround) this.play('air', 1, dt);
    else if (crouch > 0.5) {
      if (speed > 0.4) this.play('crouchWalk', reverse * Math.min(1.8, Math.max(0.5, speed / 1.5)), dt);
      else this.play('crouchIdle', 1, dt);
    } else if (speed > 3.6) this.play('run', reverse * Math.min(1.5, Math.max(0.7, speed / 5.4)), dt);
    else if (speed > 0.4) this.play('walk', reverse * Math.min(1.8, Math.max(0.6, speed / 1.9)), dt);
    else this.play('idle', 1, dt);
    // The aim twist below is added on top of the animated pose every frame, so start from a
    // known pose in case no playing clip drives this bone.
    this.spine?.quaternion.copy(this.spineRest);
    this.mixer.update(dt);

    // ---- torso follows the aim -----------------------------------------------------
    this.group.updateMatrixWorld(true);
    const groupQ = this.group.getWorldQuaternion(_groupQ);
    if (this.spine?.parent) {
      // A rotation expressed in the group's axes (undo the leg twist, then pitch),
      // re-expressed in the spine's parent space.
      _e.set(THREE.MathUtils.clamp(this.pitch, -1.1, 1.1) * 0.7, -this.legYaw, 0);
      _q2.setFromEuler(_e).premultiply(groupQ).multiply(_q3.copy(groupQ).invert()); // world-space delta
      this.spine.parent.getWorldQuaternion(_q3);
      _q1.copy(_q3).invert().multiply(_q2).multiply(_q3);
      this.spine.quaternion.premultiply(_q1);
      this.spine.updateMatrixWorld(true);
    }

    // ---- weapon at the shoulder, pointing along the aim ---------------------------------
    const def = p.weapons[p.active]?.def;
    this.setGun(def ? (WEAPON_LOOK[def.id]?.world ?? 'ak') : 'ak');
    const gun = this.gun;
    const carry = CARRY[gun?.carry ?? 'rifle']!;
    if (gun && this.chest) {
      const obj = this.guns.get(this.gunKey)!;
      // Aim frame in the group's space: gun +x maps onto the group's forward (-Z).
      _e.set(this.pitch, 0, 0);
      const aimQ = _aimQ.setFromEuler(_e);
      this.chest.getWorldPosition(_a);
      this.group.worldToLocal(_a);
      // Where the grip goes, then back off by the grip's own offset to place the model.
      _b.set(carry.grip[0], carry.grip[1], carry.grip[2]).applyQuaternion(aimQ).add(_a);
      obj.quaternion.copy(aimQ).multiply(gun.blade ? _BLADE : _HALF_PI_Y);
      obj.position.set(gun.grip[0], gun.grip[1], gun.grip[2]).applyQuaternion(obj.quaternion).negate().add(_b);
      obj.updateMatrixWorld(true);
      this.muzzle.set(gun.muzzle[0], gun.muzzle[1], gun.muzzle[2]);
      obj.localToWorld(this.muzzle);

      // ---- arms onto the weapon ---------------------------------------------------------
      _fwd.set(0, 0, -1).applyQuaternion(aimQ).applyQuaternion(groupQ);
      if (this.armR) {
        _t.set(gun.grip[0], gun.grip[1], gun.grip[2]);
        obj.localToWorld(_t);
        _pole.set(0.5, -1, 0.25).applyQuaternion(groupQ);
        solveArm(this.armR, _t, _pole, _fwd);
      }
      if (this.armL && carry.twoHanded) {
        _t.set(gun.support[0], gun.support[1], gun.support[2]);
        obj.localToWorld(_t);
        _pole.set(-0.45, -1, 0.1).applyQuaternion(groupQ);
        solveArm(this.armL, _t, _pole, _fwd);
      }
    } else {
      this.muzzle.set(x, y + 1.4, z);
    }
  }

  hideCorpse(): void {
    this.group.visible = false;
    this.hidden = true;
    if (this.dead) {
      this.dead = false;
      this.deathAction?.stop();
      if (this.rig) this.rig.rotation.x = 0;
      this.placeholder.rotation.x = 0;
    }
  }
}
