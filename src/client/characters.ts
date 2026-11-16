// Third-person players: a skinned soldier driven by authored animation clips.
// Legs follow the direction of travel, the torso follows the aim, the weapon sits at the
// shoulder pointing exactly where the player is aiming, and both arms are solved onto
// its grips with two-bone inverse kinematics.

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { Player } from '../sim/types';
import { lerp } from '../sim/math';
import { eyeHeight } from '../sim/movement';
import { WEAPON_LOOK, getCharacters, type CharacterAssets, type WorldGun } from './assets';
import { WORLD_GUN_FINISH, applyFinish, roleOf, tagGunSpace, type Role } from './finish';
import { SKINS } from './skins';

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
  gunMats: Map<string, THREE.Material>;
  /** Where the hands go on each gun, worked out once from its model. */
  holds: Map<string, Hold>;
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
  // (the model's own run bounds: its head drops a quarter of a metre every stride. The jog is level.)
  add('run', pick('jogF', 'run'));
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
  return { assets, clips, death: pick('death', 'deathB', 'deathFront'), mats, gunMats: new Map(), holds: new Map() };
}

/** Which weapon each world gun model belongs to (each model is used by one weapon). */
const WEAPON_OF_GUN: Record<string, string> = {};
for (const [id, look] of Object.entries(WEAPON_LOOK)) WEAPON_OF_GUN[look.world] = id;

/** Other players' guns are always shown cool and full. */
const AT_REST = { heat: { value: 0 }, ammo: { value: 1 } };

/** Dress one world gun (a fresh clone, not yet attached) in its weapon's skin. */
function dressGun(s: Shared, key: string, obj: THREE.Object3D): void {
  const skin = SKINS[WEAPON_OF_GUN[key] ?? ''];
  obj.updateMatrixWorld(true);
  const parts: { mesh: THREE.Mesh; role: Role }[] = [];
  const gunBox = new THREE.Box3(), cellBox = new THREE.Box3();
  obj.traverse((o) => {
    // Optional attachments are stored in these files but not fitted.
    // (the 9A-91's suppressor is part of the gun)
    if (/^(silencer|foregrip|light)(_\d+)?$/.test(o.name) && key !== 'a91') o.visible = false;
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // (the lit mark in a sight's window is for the eye behind it)
    if (/crosshair/i.test((mesh.material as THREE.Material).name)) {
      mesh.visible = false;
      return;
    }
    mesh.castShadow = false;
    const role = roleOf(mesh.name);
    parts.push({ mesh, role });
    if (!skin || !o.visible) return;
    tagGunSpace(mesh, mesh.matrixWorld, gunBox);
    if (role === 'cell') tagGunSpace(mesh, mesh.matrixWorld, cellBox);
  });
  const length = new THREE.Vector2(gunBox.min.x, gunBox.max.x);
  const cell = cellBox.isEmpty() ? new THREE.Vector2(0, 1) : new THREE.Vector2(cellBox.min.y, cellBox.max.y);
  for (const { mesh, role } of parts) {
    const src = mesh.material as THREE.Material;
    const id = `${key}|${src.uuid}|${role}`;
    let m = s.gunMats.get(id);
    if (!m) {
      const wear = skin ? { skin, role, length, cell, ...AT_REST } : undefined;
      s.gunMats.set(id, (m = applyFinish(src, WORLD_GUN_FINISH, [mesh], wear)));
    }
    mesh.material = m;
  }
}

/** Where the hands go on a gun: the middle of each palm, in the gun's own space, and its rear end. */
interface Hold {
  grip: THREE.Vector3;
  support: THREE.Vector3;
  butt: number;
}

/** Work out a gun's hold from its trigger and its shape (`obj` is a copy of it standing in the scene). */
function holdOf(s: Shared, key: string, gun: WorldGun, obj: THREE.Object3D): Hold {
  const known = s.holds.get(key);
  if (known) return known;
  const [tx, ty] = gun.trigger;
  // The palm on a pistol grip is behind and below the trigger; on a stock's wrist, behind it.
  const grip = gun.wrist ? new THREE.Vector3(tx - 0.075, ty, 0) : new THREE.Vector3(tx - 0.05, ty - 0.045, 0);
  obj.updateMatrixWorld(true);
  const toGun = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const each = (visit: (x: number, y: number, z: number) => void): void => {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      const pos = mesh.geometry.getAttribute('position');
      if (!pos) return;
      m.copy(toGun).multiply(mesh.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        _d.fromBufferAttribute(pos, i).applyMatrix4(m);
        visit(_d.x, _d.y, _d.z);
      }
    });
  };
  let butt = Infinity, front = -Infinity;
  each((x) => { if (x < butt) butt = x; if (x > front) front = x; });
  let support: THREE.Vector3;
  if (gun.carry === 'pistol') {
    // The other hand wraps the first, a little lower and to the left.
    support = new THREE.Vector3(grip.x + 0.005, grip.y - 0.02, -0.014);
  } else {
    // Under the fore-end: the underside of the model at that point along it.
    const at = Math.min(tx + (gun.fore ?? (gun.carry === 'smg' ? 0.16 : 0.22)), front - 0.07);
    let under = Infinity;
    each((x, y, z) => { if (Math.abs(x - at) < 0.03 && Math.abs(z) < 0.05 && y < under) under = y; });
    support = new THREE.Vector3(at, (under === Infinity ? ty : under) - 0.012, 0);
  }
  const hold = { grip, support, butt: butt === Infinity ? tx - 0.3 : butt };
  s.holds.set(key, hold);
  return hold;
}

/** The knife: where its grip is held relative to the chest, in the aim frame. */
const KNIFE_CARRY: [number, number, number] = [0.24, -0.08, -0.36];
/** The middle of the palm in a hand bone's own space (for the right hand; mirrored in x for the left). */
const PALM = new THREE.Vector3(-0.022, 0.075, 0.003);
/** How far the torso is turned (the off shoulder forward) with a gun held in both hands at the shoulder. */
const BLADED = -0.3;

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
/** How far (radians from upright) a torso may lean before the posture pass straightens it. */
const UPRIGHT = 0.3;
const _X = new THREE.Vector3(1, 0, 0);
const _hy = new THREE.Vector3(), _hp = new THREE.Vector3(), _hz = new THREE.Vector3(), _wrist = new THREE.Vector3();
const _hq = new THREE.Quaternion();
const _m = new THREE.Matrix4();
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
  /** The joints of the four fingers and how each lies when the hand is relaxed. */
  fingers?: { bone: THREE.Object3D; rest: THREE.Quaternion }[];
}

/** Close the fingers of a hand round what it holds (0 = as modelled, 1 = a fist). */
function curl(arm: Arm, by: number): void {
  if (!arm.fingers) return;
  _q2.setFromAxisAngle(_X, by * 0.85);
  for (const f of arm.fingers) f.bone.quaternion.copy(f.rest).multiply(_q2);
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
  private pelvis: THREE.Object3D | null = null;
  private neck: THREE.Object3D | null = null;
  private neckRest = new THREE.Quaternion();
  /** How far the torso is turned for the weapon in hand, and the kick of its last shot (1 -> 0). */
  private blade = 0;
  private kick = 0;
  /** Being hit: how far into the jerk (1 -> 0), which side it came on, and whether it was the head. */
  private flinch = 0;
  private flinchSide = 1;
  private flinchHead = false;
  private waist: THREE.Object3D | null = null;
  private head: THREE.Object3D | null = null;
  private legs: { chain: Arm; knee: THREE.Vector3; foot: THREE.Vector3; turn: THREE.Quaternion }[] = [];
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
      const fingers: { bone: THREE.Object3D; rest: THREE.Quaternion }[] = [];
      for (const f of ['index', 'middle', 'ring', 'pinky']) {
        for (const j of ['01', '02', '03']) {
          const bone = bones.get(`${f}_${j}_${s}`);
          if (bone) fingers.push({ bone, rest: bone.quaternion.clone() });
        }
      }
      return { upper, lower, hand, finger: bones.get(`middle_01_${s}`) ?? null, l1, l2, fingers };
    };
    this.neck = bones.get('neck_01') ?? null;
    if (this.neck) this.neckRest.copy(this.neck.quaternion);
    this.armR = arm('r');
    this.armL = arm('l');
    this.pelvis = bones.get('pelvis') ?? null;
    this.waist = bones.get('spine_01') ?? null;
    this.head = bones.get('Head') ?? bones.get('head') ?? null;
    for (const side of ['l', 'r']) {
      const upper = bones.get(`thigh_${side}`), lower = bones.get(`calf_${side}`), hand = bones.get(`foot_${side}`);
      if (!upper || !lower || !hand) continue;
      const l1 = upper.getWorldPosition(_a).distanceTo(lower.getWorldPosition(_b));
      const l2 = lower.getWorldPosition(_a).distanceTo(hand.getWorldPosition(_b));
      this.legs.push({ chain: { upper, lower, hand, finger: null, l1, l2 }, knee: new THREE.Vector3(), foot: new THREE.Vector3(), turn: new THREE.Quaternion() });
    }

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
      dressGun(shared, key, obj);
      this.gunHolder.add(obj);
      this.guns.set(key, obj);
    }
    obj.visible = true;
  }

  /**
   * Put the head where the game says it is. The hit boxes stand upright on the player's own
   * spot, with the head at eye height; the clips lean, bob and squat as they please (the
   * crouch sits a quarter of a metre under the crouched eye). So after each frame of
   * animation the hips are moved until the head is over the player's spot at `headY`, and the
   * legs are bent again to leave the feet where the clip had them.
   */
  private posture(headY: number): void {
    const pelvis = this.pelvis, head = this.head;
    if (!pelvis?.parent || !head || this.legs.length < 2) return;
    this.group.updateMatrixWorld(true);
    for (const leg of this.legs) {
      leg.chain.lower.getWorldPosition(leg.knee);
      leg.chain.hand.getWorldPosition(leg.foot);
      leg.chain.hand.getWorldQuaternion(leg.turn);
    }
    // A torso bent far over (the crouch clips hunch) is stood most of the way up, and the head
    // tipped back down by as much so it still looks ahead.
    const waist = this.waist;
    if (waist?.parent) {
      pelvis.getWorldPosition(_a);
      _d.copy(head.getWorldPosition(_b)).sub(_a).normalize();
      const lean = Math.acos(Math.min(1, Math.max(-1, _d.y))) - UPRIGHT;
      if (lean > 0) {
        _t.set(-_d.z, 0, _d.x).normalize();
        const turn = (bone: THREE.Object3D, by: number): void => {
          _q2.setFromAxisAngle(_t, by);
          bone.parent!.getWorldQuaternion(_q3);
          bone.quaternion.premultiply(_q1.copy(_q3).invert().multiply(_q2).multiply(_q3));
          bone.updateMatrixWorld(true);
        };
        turn(waist, lean * 0.8);
        turn(head, -lean * 0.55);
      }
    }
    // How far the head is from where it should be, in the world.
    head.getWorldPosition(_a);
    this.group.getWorldPosition(_b);
    _c.set((_b.x - _a.x) * 0.85, (_b.y + headY - _a.y) * 0.85, (_b.z - _a.z) * 0.85);
    _c.y = Math.min(0.45, Math.max(-0.08, _c.y));
    const flat = Math.hypot(_c.x, _c.z);
    if (flat > 0.4) { _c.x *= 0.4 / flat; _c.z *= 0.4 / flat; }
    // Move the hips by that much (in their parent's own space).
    pelvis.getWorldPosition(_a).add(_c);
    pelvis.parent.worldToLocal(_a);
    pelvis.position.copy(_a);
    pelvis.updateMatrixWorld(true);
    for (const leg of this.legs) {
      // Knees keep bending the way the clip bent them.
      leg.chain.upper.getWorldPosition(_a);
      _pole.copy(leg.knee).sub(_a).addScaledVector(_d.copy(leg.foot).sub(_a), -0.5);
      solveArm(leg.chain, leg.foot, _pole, _fwd);
      const foot = leg.chain.hand;
      foot.parent!.getWorldQuaternion(_q3);
      foot.quaternion.copy(_q3.invert()).multiply(leg.turn);
      foot.updateMatrixWorld(true);
    }
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
    this.neck?.quaternion.copy(this.neckRest);
    this.mixer.update(dt);
    if (p.onGround) this.posture(eyeHeight(p) - 0.03);

    // ---- torso follows the aim -----------------------------------------------------
    this.group.updateMatrixWorld(true);
    const groupQ = this.group.getWorldQuaternion(_groupQ);
    if (this.spine?.parent) {
      // A rotation expressed in the group's axes (undo the leg twist, then pitch),
      // re-expressed in the spine's parent space.
      const held = p.weapons[p.active]?.def;
      const shouldered = !!held && held.kind !== 'pistol' && held.kind !== 'knife';
      this.blade += ((shouldered ? BLADED : 0) - this.blade) * Math.min(1, dt * 8);
      // (a hit throws the shoulders back and round, away from the side it landed on)
      this.flinch *= Math.exp(-dt * 7);
      const jerk = this.flinch;
      _e.set(
        THREE.MathUtils.clamp(this.pitch, -1.1, 1.1) * 0.7 + jerk * (this.flinchHead ? 0.2 : 0.3),
        -this.legYaw + this.blade - this.flinchSide * jerk * (this.flinchHead ? 0.18 : 0.42),
        this.flinchSide * jerk * 0.14,
      );
      _q2.setFromEuler(_e).premultiply(groupQ).multiply(_q3.copy(groupQ).invert()); // world-space delta
      this.spine.parent.getWorldQuaternion(_q3);
      _q1.copy(_q3).invert().multiply(_q2).multiply(_q3);
      this.spine.quaternion.premultiply(_q1);
      this.spine.updateMatrixWorld(true);
      // The head keeps looking where the player looks while the shoulders are turned
      // (and is snapped back by a round that hits it).
      const snap = this.flinchHead ? jerk : 0;
      if (this.neck?.parent && (Math.abs(this.blade) > 1e-3 || snap > 1e-3)) {
        _e.set(snap * 0.55, -this.blade - this.flinchSide * snap * 0.3, this.flinchSide * snap * 0.2);
        _q2.setFromEuler(_e).premultiply(groupQ).multiply(_q3.copy(groupQ).invert());
        this.neck.parent.getWorldQuaternion(_q3);
        this.neck.quaternion.premultiply(_q1.copy(_q3).invert().multiply(_q2).multiply(_q3));
        this.neck.updateMatrixWorld(true);
      }
    }

    // ---- weapon at the shoulder, pointing along the aim ---------------------------------
    const def = p.weapons[p.active]?.def;
    this.setGun(def ? (WEAPON_LOOK[def.id]?.world ?? 'ak') : 'ak');
    const gun = this.gun;
    this.kick *= Math.exp(-dt * 16);
    if (gun && this.chest) {
      const obj = this.guns.get(this.gunKey)!;
      // Aim frame in the group's space: gun +x maps onto the group's forward (-Z).
      _e.set(this.pitch + this.kick * 0.045, 0, 0);
      const aimQ = _aimQ.setFromEuler(_e);
      this.chest.getWorldPosition(_a);
      this.group.worldToLocal(_a);
      obj.quaternion.copy(aimQ).multiply(gun.blade ? _BLADE : _HALF_PI_Y);
      _fwd.set(0, 0, -1).applyQuaternion(aimQ).applyQuaternion(groupQ);
      if (gun.blade || !this.armR || !this.armL) {
        // One-handed: the grip out to the right of the chest.
        const at = gun.grip ?? [0, 0, 0];
        _b.set(KNIFE_CARRY[0], KNIFE_CARRY[1], KNIFE_CARRY[2]).applyQuaternion(aimQ).add(_a);
        obj.position.set(at[0], at[1], at[2]).applyQuaternion(obj.quaternion).negate().add(_b);
        obj.updateMatrixWorld(true);
        if (this.armR) {
          _t.set(at[0], at[1], at[2]);
          obj.localToWorld(_t);
          _pole.set(0.5, -1, 0.25).applyQuaternion(groupQ);
          solveArm(this.armR, _t, _pole, _fwd);
          curl(this.armR, 0.75);
        }
      } else {
        const hold = holdOf(shared!, this.gunKey, gun, obj);
        const pistol = gun.carry === 'pistol';
        const size = obj.scale.x;
        // The line the gun lies along, and how far down it the grip sits: a long gun's butt in
        // the shoulder, a pistol out in front of the face.
        const lineX = pistol ? 0.02 : 0.085, lineY = pistol ? 0.2 : 0.115;
        const want = pistol ? -0.4 : 0.07 - (hold.grip.x - hold.butt) * size;
        const reachR = (this.armR.l1 + this.armR.l2) * 0.96 + 0.055, reachL = (this.armL.l1 + this.armL.l2) * 0.96 + 0.055;
        let z = want;
        for (let i = 0; i < 4; i++) {
          _b.set(lineX, lineY, z + this.kick * 0.035).applyQuaternion(aimQ).add(_a);
          obj.position.copy(hold.grip).multiplyScalar(size).applyQuaternion(obj.quaternion).negate().add(_b);
          obj.updateMatrixWorld(true);
          // Pull it in until both hands can reach where they hold it.
          const overL = obj.localToWorld(_t.copy(hold.support)).distanceTo(this.armL.upper.getWorldPosition(_c)) - reachL;
          const overR = obj.localToWorld(_t.copy(hold.grip)).distanceTo(this.armR.upper.getWorldPosition(_c)) - reachR;
          const over = Math.max(overL, overR);
          if (over <= 0.002 || z >= want + 0.22) break;
          z = Math.min(want + 0.22, z + over * 1.1);
        }

        // Right hand: round the grip, palm inward, the hand tipped up along it.
        const tip = gun.wrist ? 0.15 : 0.42;
        _t.copy(hold.grip);
        obj.localToWorld(_t);
        _pole.set(0.55, -1, 0.3).applyQuaternion(groupQ);
        this.placeHand(this.armR, 1, _t, _hy.set(0, Math.sin(tip), -Math.cos(tip)), _hp.set(-1, 0, 0), aimQ, groupQ, _pole, pistol ? 0.5 : 0.62);
        // Left hand: under the fore-end with the palm up, or wrapped round the other on a pistol.
        _t.copy(hold.support);
        obj.localToWorld(_t);
        _pole.set(-0.5, -1, 0.15).applyQuaternion(groupQ);
        if (pistol) this.placeHand(this.armL, -1, _t, _hy.set(0.2, 0.36, -0.91), _hp.set(1, 0.15, 0), aimQ, groupQ, _pole, 0.55);
        else this.placeHand(this.armL, -1, _t, _hy.set(0.5, 0.1, -0.86), _hp.set(0.3, 1, 0), aimQ, groupQ, _pole, 0.8);
      }
      this.muzzle.set(gun.muzzle[0], gun.muzzle[1], gun.muzzle[2]);
      obj.localToWorld(this.muzzle);
    } else {
      this.muzzle.set(x, y + 1.4, z);
    }
  }

  /**
   * This player was hit: their body shows it.
   * @param side which side of them the round landed on (1 = their right)
   * @param hard how hard (1 = about half their health)
   */
  hurt(side: number, hard: number, head: boolean): void {
    this.flinch = Math.min(1, Math.max(this.flinch, 0.62 + hard * 0.5));
    this.flinchSide = side;
    this.flinchHead = head;
  }

  /** This player fired: their gun kicks. */
  shot(): void {
    this.kick = 1;
  }

  /**
   * Put a hand on the gun: the middle of its palm on `palm` (world), its fingers lying along
   * `along` and its palm facing `facing` (both in the aim frame), fingers curled by `grip`.
   */
  private placeHand(
    arm: Arm, side: 1 | -1, palm: THREE.Vector3, along: THREE.Vector3, facing: THREE.Vector3,
    aimQ: THREE.Quaternion, groupQ: THREE.Quaternion, pole: THREE.Vector3, grip: number,
  ): void {
    // The hand bone's own axes: y runs to the fingers; the palm faces -x on the right hand, +x on the left.
    const y = along.normalize().applyQuaternion(aimQ).applyQuaternion(groupQ);
    const xAxis = facing.applyQuaternion(aimQ).applyQuaternion(groupQ).multiplyScalar(-side);
    xAxis.addScaledVector(y, -xAxis.dot(y)).normalize();
    const zAxis = _hz.crossVectors(xAxis, y);
    _m.makeBasis(xAxis, y, zAxis);
    const turn = _hq.setFromRotationMatrix(_m);
    // The wrist is where it must be for the palm to land on its mark.
    _d.set(PALM.x * side, PALM.y, PALM.z).applyQuaternion(turn);
    _wrist.copy(palm).sub(_d);
    const finger = arm.finger;
    arm.finger = null;
    solveArm(arm, _wrist, pole, _fwd);
    arm.finger = finger;
    arm.hand.parent!.getWorldQuaternion(_q3);
    arm.hand.quaternion.copy(_q3.invert()).multiply(turn);
    arm.hand.updateMatrixWorld(true);
    curl(arm, grip);
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
