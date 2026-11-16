// First-person weapons. Each weapon is an authored pack (gun + arms + hand-made
// animation) played by name; spring-driven sway, bob, recoil and landing motion are
// layered on top so the gun reacts to the player's own movement.

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { WeaponDef } from '../sim/weapons';
import { PACKS, WEAPON_LOOK, getWeapon, loadWeapon, type PackInfo, type WeaponFiles, type WeaponLook } from './assets';
import { ARMS_FINISH, BLADE_FINISH, FINISH_TIME, applyFinish, gunFinish, roleOf, tagGunSpace, type Role, type Skin, type SkinWear } from './finish';
import { SIDE_GLOW, SKINS, SUIT, SUIT_GLOW } from './skins';

/** Damped spring used for all secondary motion. */
export class Spring {
  x = 0;
  v = 0;
  constructor(private k: number, private c: number) {}
  step(target: number, dt: number): number {
    const n = dt > 1 / 90 ? 2 : 1;
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (-this.k * (this.x - target) - this.c * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  kick(impulse: number): void {
    this.v += impulse;
  }
}

/** The glass of a scope: dark, and a mirror for the sky. */
function lensMaterial(src: THREE.Material): THREE.Material {
  const m = src.clone() as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial) return m;
  m.map = null;
  m.color.set(0x0a1016);
  m.metalness = 1;
  m.metalnessMap = null;
  m.roughness = 0.06;
  m.roughnessMap = null;
  m.envMapIntensity = 2.2;
  return m;
}

// (matched whole: a rifle's "handguard" and "charging_handle" are not hands)
const isReticle = (m: THREE.Material): boolean => /crosshair/i.test(m.name);
/** The mark in a sight's window: the sight's own picture of it, lit in the gun's colour. */
function reticleMaterial(src: THREE.Material, colour: number): THREE.Material {
  return new THREE.MeshBasicMaterial({
    map: (src as THREE.MeshStandardMaterial).map ?? null, color: new THREE.Color(colour).multiplyScalar(0.9),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
}
const isArms = (m: THREE.Material): boolean => /^(arms?|hands?|gloves?|sleeves?)$/i.test(m.name);
const isLens = (m: THREE.Material): boolean => /lens/i.test(m.name);

/** Every pair of arms wears the same finish, and every gun its skin (see finish.ts). */
function finishFor(src: THREE.Material, team: number, meshes: readonly THREE.Mesh[], wear?: SkinWear): THREE.Material {
  if (isLens(src)) return lensMaterial(src);
  if (isArms(src)) return applyFinish(src, ARMS_FINISH, meshes, wear);
  if (/^knife$/i.test(src.name)) return applyFinish(src, BLADE_FINISH, meshes, wear);
  return applyFinish(src, gunFinish(team), meshes, wear);
}

/** Eye-space axes (muzzle down -z) to gun-space axes (muzzle along +x). */
const EYE_TO_GUN = new THREE.Matrix4().set(0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1);

/** The state a gun's skin reacts to: heat from firing, and how full the magazine is. */
export interface SkinLive {
  heat: { value: number };
  ammo: { value: number };
  /** The light of the thread in the player's sleeves: their side's colour. */
  suitGlow: THREE.Color;
}
/** The sleeves do not heat up or count rounds. */
const SUIT_STATE = { heat: { value: 0 }, ammo: { value: 1 } };

const _v = new THREE.Vector3();
const _fq = new THREE.Quaternion();
const _swing = new THREE.Matrix4(), _turn = new THREE.Matrix4(), _back = new THREE.Matrix4();
const UNIT = new THREE.Vector2(0, 1);

const EMPTY = new THREE.BufferGeometry();
const pieceOf = (name: string): string => name.replace(/_\d+$/, '');

/** One weapon's instance: an arm pack with its gun, its own skeleton, materials and animation state. */
class Rig {
  /** Eye space: x right, y up, the muzzle away down -z, metres. */
  readonly root = new THREE.Group();
  /** Muzzle tip at rest, in `root` space. */
  readonly muzzle = new THREE.Vector3(0.08, -0.08, -0.6);
  private mixer: THREE.AnimationMixer;
  private length: number;
  private skip: Set<string>;
  /** The root of the left arm, moved to fit the hand to guns the pack was not drawn for. */
  private leftArm: THREE.Object3D | null = null;
  private leftArmRest = new THREE.Vector3();
  /** Where the left hand is moved to while it holds the gun, and while it handles the magazine (the arm's own space). */
  private holdShift = new THREE.Vector3();
  private magShift = new THREE.Vector3();
  /** The reload ends by working the action. */
  private rack: boolean;
  /** A break-action's barrels: what holds them, how they sit closed, and the hinge they swing on. */
  private hinged: { holder: THREE.Object3D; closed: THREE.Matrix4 }[] = [];
  private hinge: { at: THREE.Vector3; angle: number } | null = null;
  /**
   * Blending between movements. The clips are sampled, not played, so going from one to
   * another (or back to the start of the same one) would jump: instead the pose is eased
   * from where the joints were to where the new movement puts them.
   */
  private driven: THREE.Object3D[] = [];
  private fromP: THREE.Vector3[] = [];
  private fromQ: THREE.Quaternion[] = [];
  private fade = 0;
  private fadeFor = 0;
  private lastClip = '';
  private lastK = 0;
  /** The pose last shown, and where the wrists were in it: a clip that cuts a hand from one place to another is eased too. */
  private shownP: THREE.Vector3[] = [];
  private shownQ: THREE.Quaternion[] = [];
  private wrists: { bone: THREE.Object3D; was: THREE.Vector3 }[] = [];
  private frame = 1 / 60;
  /**
   * Taming a firing movement drawn for a heavier shot than this game's: the whole pack is moved
   * back against part of the gun's travel, so the hands stay exactly on the gun.
   */
  private pack: THREE.Object3D;
  private packRest = new THREE.Vector3();
  private gunRoot: THREE.Object3D | null = null;
  private gunRest = new THREE.Vector3();
  private tame = 0;
  private tameTo = 0;
  /** A pump-action's fore-end: what holds it, and how far the left arm goes back with it (the arm's own space). */
  private pumped: { holder: THREE.Object3D; closed: THREE.Matrix4 }[] = [];
  private pumpTravel = 0;
  private pumpShift = new THREE.Vector3();
  /** How far through pumping at the end of a reload (0 = not). */
  reloadPump = 0;
  /** Bolts and slides that no animation moves: thrown back by hand, here, with every shot. */
  private bolts: { holder: THREE.Object3D; closed: THREE.Matrix4 }[] = [];

  /**
   * @param team the side the weapon belongs to (-1 = both), which tints its bare finish
   * @param skin the paint the gun wears, if any
   */
  constructor(files: WeaponFiles, readonly info: PackInfo, look: WeaponLook, team: number, skin: Skin | undefined, live: SkinLive) {
    this.skip = new Set(look.skip ?? []);
    this.rack = !!look.rack && 'bolt' in info.clips;
    const scene = SkeletonUtils.clone(files.pack.scene);
    this.pack = scene;
    this.packRest.copy(scene.position);
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.fromArray(info.view);
    holder.add(scene);
    this.root.add(holder);
    const hold = look.hold ?? info.hold;
    if (look.scale) holder.matrix.premultiply(new THREE.Matrix4().makeScale(look.scale, look.scale, look.scale));
    holder.matrix.premultiply(new THREE.Matrix4().makeTranslation(hold[0], hold[1], hold[2]));

    const joints = new Map<string, THREE.Object3D>();
    scene.traverse((o) => {
      if (!joints.has(o.name)) joints.set(o.name, o);
    });

    this.mixer = new THREE.AnimationMixer(scene);
    const clip = files.pack.animations[0]!;
    this.length = clip.duration;
    this.mixer.clipAction(clip).play();
    const seen = new Set<THREE.Object3D>();
    for (const track of clip.tracks) {
      const node = THREE.PropertyBinding.findNode(scene, THREE.PropertyBinding.parseTrackName(track.name).nodeName) as THREE.Object3D | undefined;
      if (node && !seen.has(node)) {
        seen.add(node);
        this.driven.push(node);
        this.fromP.push(new THREE.Vector3());
        this.fromQ.push(new THREE.Quaternion());
        this.shownP.push(node.position.clone());
        this.shownQ.push(node.quaternion.clone());
        if (/^[LR]_wrist/.test(node.name)) this.wrists.push({ bone: node, was: new THREE.Vector3() });
      }
    }

    // The joint that carries the whole gun, and where it rests.
    if (info.fireTravel !== undefined && info.clips['idle']) {
      let node = joints.get('base') ?? null;
      while (node && !seen.has(node)) node = node.parent;
      if (node) {
        this.mixer.setTime(info.clips['idle'][0] / info.fps);
        this.gunRoot = node;
        holder.worldToLocal(node.getWorldPosition(this.gunRest));
      }
    }

    /** Where each gun mesh sits on the gun (its own geometry to gun space) and what part it is. */
    const onGun = new Map<THREE.Mesh, { toGun: THREE.Matrix4; role: Role }>();

    // The pack's own magazine: where the animation's hands expect one to be.
    const ownCell: { mesh: THREE.Mesh; geo: THREE.BufferGeometry }[] = [];
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && roleOf(mesh.name) === 'cell') ownCell.push({ mesh, geo: mesh.geometry });
    });
    /** How the mounted gun was seated: its size and where it was moved (gun space). */
    let seatSize = 1;
    const seatMove = new THREE.Vector3();

    // ---- mount a separate gun on the skeleton, piece by piece ----------------------
    const mount = look.mount;
    if (mount && files.gun && info.frame) {
      // The pack's own gun, if it has one, makes way.
      if (info.ownGun) {
        const own = new Set(info.ownGun);
        scene.traverse((o) => {
          if (!own.has(pieceOf(o.name))) return;
          const strip = (m: THREE.Object3D): void => { if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).geometry = EMPTY; };
          strip(o);
          for (const c of o.children) strip(c);
        });
      }
      // A joint's place is where the first frame of the animation puts it.
      this.mixer.setTime(0);
      scene.updateMatrixWorld(true);
      const placeOf = (joint: THREE.Object3D): THREE.Matrix4 =>
        new THREE.Matrix4().copy(scene.matrixWorld).invert().multiply(joint.matrixWorld);

      const gun = files.gun.scene.clone(true);
      const size = mount.size ?? 1;
      const move = new THREE.Vector3(...(mount.nudge ?? [0, 0, 0]));
      seatSize = size;
      seatMove.copy(move);
      const seat = new THREE.Matrix4().compose(move, new THREE.Quaternion(), new THREE.Vector3(size, size, size));
      const gunSpace = new THREE.Matrix4().fromArray(info.frame).invert().multiply(seat);
      const swings = new Set(mount.hinge?.pieces ?? []);
      if (mount.hinge) this.hinge = { at: new THREE.Vector3(...mount.hinge.at), angle: mount.hinge.angle };
      const hang = (piece: THREE.Object3D, on: string): void => {
        const j = joints.get(on);
        if (!j) return;
        const h = new THREE.Group();
        h.matrixAutoUpdate = false;
        h.matrix.copy(placeOf(j)).invert().multiply(gunSpace);
        h.add(piece);
        j.add(h);
        const name = pieceOf(piece.name);
        if (swings.has(name)) this.hinged.push({ holder: h, closed: h.matrix.clone() });
        else if (mount.pump && name === mount.pump.piece) this.pumped.push({ holder: h, closed: h.matrix.clone() });
        // (a bolt riding the gun's body, or a slide whose firing movement this weapon leaves out)
        else if (/^(bolt|slide)$/.test(name) && (on === mount.ride['base'] || this.skip.has('fire'))) this.bolts.push({ holder: h, closed: h.matrix.clone() });
      };
      const pieces: THREE.Mesh[] = [];
      gun.traverse((o) => { if ((o as THREE.Mesh).isMesh) pieces.push(o as THREE.Mesh); });
      const hide = new Set(mount.hide ?? []);
      for (const piece of pieces) {
        const name = pieceOf(piece.name);
        if (hide.has(name)) continue;
        const joint = mount.ride[name] ?? mount.ride['base']!;
        piece.updateMatrix();
        onGun.set(piece, { toGun: piece.matrix.clone(), role: roleOf(name) });
        hang(piece, joint);
      }
    }

    // Arms that came without textures borrow the same maker's from another pack.
    let borrowedArms: THREE.Material | null = null;
    files.arms?.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && !Array.isArray(m) && isArms(m) && (m as THREE.MeshStandardMaterial).map) borrowedArms = m;
    });

    this.pose('idle', 0);
    scene.updateMatrixWorld(true);

    // A gun that came inside the pack: its parts are placed as the idle pose holds them.
    const packToGun = info.frame
      ? new THREE.Matrix4().fromArray(info.frame)
      : new THREE.Matrix4().copy(EYE_TO_GUN).multiply(new THREE.Matrix4().fromArray(info.view));
    const fromScene = new THREE.Matrix4().copy(scene.matrixWorld).invert();

    const meshes: THREE.Mesh[] = [];
    const gunBox = new THREE.Box3(), cellBox = new THREE.Box3();
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Hands swing well outside their rest bounds during reloads.
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      meshes.push(mesh);
      const src = mesh.material as THREE.Material;
      if (isReticle(src)) {
        mesh.material = reticleMaterial(src, skin?.glow ?? 0xff4030);
        mesh.renderOrder = 4;
        meshes.pop();
        return;
      }
      if (isArms(src)) {
        // The suit's weave is laid out on the arms as modelled (before the skeleton poses them).
        tagGunSpace(mesh, new THREE.Matrix4().copy(packToGun).multiply(fromScene).multiply(mesh.matrixWorld));
        return;
      }
      if (!skin || isLens(src) || mesh.geometry === EMPTY) return;
      let place = onGun.get(mesh);
      if (!place) {
        place = { toGun: new THREE.Matrix4().copy(packToGun).multiply(fromScene).multiply(mesh.matrixWorld), role: roleOf(mesh.name) };
        onGun.set(mesh, place);
      }
      tagGunSpace(mesh, place.toGun, gunBox);
      if (place.role === 'cell') tagGunSpace(mesh, place.toGun, cellBox);
    });
    const length = new THREE.Vector2(gunBox.min.x, gunBox.max.x);
    const cell = cellBox.isEmpty() ? new THREE.Vector2(0, 1) : new THREE.Vector2(cellBox.min.y, cellBox.max.y);

    // ---- fit the left hand to this gun ---------------------------------------------------
    // The arms were animated round the pack's own gun. Another gun's fore-end and magazine
    // are somewhere else, so the whole left arm is shifted: onto the fore-end while it holds
    // the gun, and onto the magazine while it changes it (the shoulder end is out of view).
    this.leftArm = [...joints.values()].find((j) => /^L_arm/.test(j.name)) ?? null;
    if (this.leftArm?.parent && mount) {
      this.leftArmRest.copy(this.leftArm.position);
      const gunToArm = new THREE.Matrix3().setFromMatrix4(
        new THREE.Matrix4().copy(this.leftArm.parent.matrixWorld).invert().multiply(scene.matrixWorld).multiply(new THREE.Matrix4().copy(packToGun).invert()),
      );
      if (look.support) this.holdShift.set(...look.support).applyMatrix3(gunToArm);
      if (mount.pump) {
        this.pumpTravel = mount.pump.travel;
        this.pumpShift.set(-mount.pump.travel * seatSize, 0, 0).applyMatrix3(gunToArm);
      }
      const packBox = new THREE.Box3();
      for (const { mesh, geo } of ownCell) {
        const pos = geo.getAttribute('position');
        if (!pos) continue;
        const toGun = new THREE.Matrix4().copy(packToGun).multiply(fromScene).multiply(mesh.matrixWorld);
        for (let i = 0; i < pos.count; i += 4) packBox.expandByPoint(_v.fromBufferAttribute(pos, i).applyMatrix4(toGun));
      }
      if (!packBox.isEmpty() && !cellBox.isEmpty()) {
        const mine = cellBox.getCenter(new THREE.Vector3()).multiplyScalar(seatSize).add(seatMove);
        this.magShift.copy(mine).sub(packBox.getCenter(_v)).applyMatrix3(gunToArm);
      }
    } else {
      this.leftArm = null;
    }

    // One material for each source material and each part of the gun that wears it.
    const wearers = new Map<string, { src: THREE.Material; role: Role | null; list: THREE.Mesh[] }>();
    for (const mesh of meshes) {
      let src = mesh.material as THREE.Material;
      if (borrowedArms && isArms(src) && !(src as THREE.MeshStandardMaterial).map) src = borrowedArms;
      const role = onGun.get(mesh)?.role ?? null;
      const key = `${src.uuid}|${role}`;
      const w = wearers.get(key);
      if (w) w.list.push(mesh);
      else wearers.set(key, { src, role, list: [mesh] });
    }
    for (const { src, role, list } of wearers.values()) {
      const wear: SkinWear | undefined = isArms(src)
        ? { skin: SUIT, role: 'body', length: UNIT, cell: UNIT, ...SUIT_STATE, glow: live.suitGlow }
        : skin && role ? { skin, role, length, cell, heat: live.heat, ammo: live.ammo } : undefined;
      const finished = finishFor(src, team, list, wear);
      for (const mesh of list) mesh.material = finished;
    }

    // Find the muzzle: the centroid of the vertices furthest down -z in the rest pose.
    this.root.updateMatrixWorld(true);
    let minZ = Infinity;
    const pts: number[] = [];
    for (const mesh of meshes) {
      const pos = mesh.geometry.getAttribute('position');
      if (!pos) continue;
      const step = Math.max(1, Math.floor(pos.count / 4000));
      for (let i = 0; i < pos.count; i += step) {
        mesh.getVertexPosition(i, _v).applyMatrix4(mesh.matrixWorld);
        pts.push(_v.x, _v.y, _v.z);
        if (_v.z < minZ) minZ = _v.z;
      }
    }
    if (pts.length > 0) {
      let sx = 0, sy = 0, c = 0;
      for (let i = 0; i < pts.length; i += 3) {
        if (pts[i + 2]! < minZ + 0.025) { sx += pts[i]!; sy += pts[i + 1]!; c++; }
      }
      if (c > 0) this.muzzle.set(sx / c, sy / c, minZ);
    }
  }

  has(clip: string): boolean {
    return clip in this.info.clips && !this.skip.has(clip);
  }
  seconds(clip: string): number {
    const r = this.info.clips[clip];
    return r ? (r[1] - r[0]) / this.info.fps : 0;
  }
  /** Stand in one movement, `k` of the way through it (0..1). */
  pose(clip: string, k: number): void {
    const r = this.info.clips[clip] ?? this.info.clips['idle'] ?? [0, 0];
    k = k < 0 ? 0 : k > 1 ? 1 : k;
    const t = (r[0] + (r[1] - r[0]) * k) / this.info.fps;
    // A new movement, or the same one begun again: ease into it from the pose now shown.
    // (A shot's own kick is let through almost at once; a change of movement takes a tenth of a second.)
    const again = clip === this.lastClip && k < this.lastK - 0.15;
    if (this.lastClip && (clip !== this.lastClip || again)) {
      for (let i = 0; i < this.driven.length; i++) {
        this.fromP[i]!.copy(this.driven[i]!.position);
        this.fromQ[i]!.copy(this.driven[i]!.quaternion);
      }
      this.fadeFor = this.fade = clip === 'fire' ? 0.03 : again ? 0.05 : 0.11;
    }
    this.lastClip = clip;
    this.lastK = k;
    const arm = this.leftArm;
    if (arm) arm.position.copy(this.leftArmRest);
    this.mixer.setTime(Math.min(this.length - 1e-4, t));
    if (arm) {
      // On the fore-end, except in the middle of a reload, when the hand is on the magazine.
      const u = clip === 'reload' ? THREE.MathUtils.smoothstep(k, 0.02, 0.14) * (1 - THREE.MathUtils.smoothstep(k, 0.86, 0.98)) : 0;
      arm.position.addScaledVector(this.holdShift, 1 - u).addScaledVector(this.magShift, u);
    }
    // A hand that the clip moves faster than a hand can go (they are cut from place to place
    // where the animator's own camera could not see) is eased from where it was instead.
    if (this.lastClip && this.fade <= 0) {
      let cut = false;
      for (const wrist of this.wrists) {
        wrist.bone.updateWorldMatrix(true, false);
        _v.setFromMatrixPosition(wrist.bone.matrixWorld);
        if (_v.distanceTo(wrist.was) > Math.max(0.09, CUT_SPEED * this.frame)) cut = true;
      }
      if (cut) {
        for (let i = 0; i < this.driven.length; i++) {
          this.fromP[i]!.copy(this.shownP[i]!);
          this.fromQ[i]!.copy(this.shownQ[i]!);
        }
        this.fadeFor = this.fade = 0.1;
      }
    }
    if (this.fade > 0) {
      const w = 1 - this.fade / this.fadeFor, ease = w * w * (3 - 2 * w);
      for (let i = 0; i < this.driven.length; i++) {
        const node = this.driven[i]!;
        node.position.lerpVectors(this.fromP[i]!, node.position, ease);
        _fq.copy(node.quaternion);
        node.quaternion.copy(this.fromQ[i]!).slerp(_fq, ease);
      }
    }
    for (let i = 0; i < this.driven.length; i++) {
      this.shownP[i]!.copy(this.driven[i]!.position);
      this.shownQ[i]!.copy(this.driven[i]!.quaternion);
    }
    if (this.gunRoot) {
      this.tameTo = clip === 'fire' ? 1 - (this.info.fireTravel ?? 1) : 0;
      if (this.tameTo > this.tame) this.tame = this.tameTo;
      this.pack.position.copy(this.packRest);
      if (this.tame > 1e-3) {
        this.pack.parent!.worldToLocal(this.gunRoot.getWorldPosition(_v));
        this.pack.position.addScaledVector(_v.sub(this.gunRest), -this.tame);
      }
    }
    for (const wrist of this.wrists) {
      wrist.bone.updateWorldMatrix(true, false);
      wrist.was.setFromMatrixPosition(wrist.bone.matrixWorld);
    }
    if (this.hinge) this.swing(0);
  }
  /** Let `dt` seconds of any blend between movements pass. */
  advance(dt: number): void {
    this.frame = dt;
    if (this.fade > 0) this.fade = Math.max(0, this.fade - dt);
    if (this.tame > this.tameTo) this.tame = Math.max(this.tameTo, this.tame - dt * 5);
  }
  /** Forget the last movement: the next pose is shown as it is (a weapon just brought out). */
  cut(): void {
    this.fade = 0;
    this.lastClip = '';
  }
  /** Throw the bolt: `k` runs 0..1 through one shot (back fast, forward slower). */
  cycle(k: number): void {
    if (this.bolts.length === 0) return;
    const back = k <= 0 || k >= 1 ? 0 : k < 0.3 ? k / 0.3 : 1 - (k - 0.3) / 0.7;
    _swing.makeTranslation(-BOLT_TRAVEL * back, 0, 0);
    for (const { holder, closed } of this.bolts) holder.matrix.copy(closed).multiply(_swing);
  }
  /** Whether this gun is pumped by hand between shots. */
  get pumps(): boolean {
    return this.pumped.length > 0;
  }
  /** Work the pump: `k` runs 0..1 through one stroke, back and forward again, the left hand with it. Call after posing. */
  pump(k: number): void {
    if (this.pumped.length === 0) return;
    const back = k <= 0 || k >= 1 ? 0 : THREE.MathUtils.smoothstep(k, 0, 0.4) * (1 - THREE.MathUtils.smoothstep(k, 0.52, 1));
    _swing.makeTranslation(-this.pumpTravel * back, 0, 0);
    for (const { holder, closed } of this.pumped) holder.matrix.copy(closed).multiply(_swing);
    if (this.leftArm) this.leftArm.position.addScaledVector(this.pumpShift, back);
  }
  /** A break-action's barrels, swung `open` (0..1) of the way down. */
  private swing(open: number): void {
    if (!this.hinge) return;
    const { at, angle } = this.hinge;
    _swing.makeTranslation(at.x, at.y, at.z)
      .multiply(_turn.makeRotationZ(-angle * open))
      .multiply(_back.makeTranslation(-at.x, -at.y, -at.z));
    for (const { holder, closed } of this.hinged) holder.matrix.copy(closed).multiply(_swing);
  }
  /**
   * Stand `k` of the way through a reload that lasts `seconds`. Guns that end by working the
   * action play the magazine change and then the bolt, each at the speed it was animated at.
   * Returns how far through working the action it is (0 while it is not).
   */
  poseReload(k: number): number {
    this.reloadPump = 0;
    if (this.pumped.length > 0 && this.has('reload')) {
      // Loaded, then pumped once.
      const a = this.seconds('reload'), split = a / (a + PUMP_SECONDS);
      if (k < split) this.pose('reload', k / split);
      else {
        this.pose('idle', 0);
        this.reloadPump = (k - split) / (1 - split);
      }
      return 0;
    }
    if (!this.has('reload')) {
      // A break-action: both hands stay on the gun; it is broken open, emptied and shut
      // (the spring layer tips it down meanwhile).
      this.pose('idle', 0);
      this.swing(THREE.MathUtils.smoothstep(k, 0.08, 0.22) * (1 - THREE.MathUtils.smoothstep(k, 0.78, 0.9)));
      return 0;
    }
    if (!this.rack) {
      this.pose('reload', k);
      return 0;
    }
    const a = this.seconds('reload'), b = this.info.clips['bolt'] ? (this.info.clips['bolt'][1] - this.info.clips['bolt'][0]) / this.info.fps : 0;
    const split = a / (a + b);
    if (k < split) {
      this.pose('reload', k / split);
      return 0;
    }
    const through = (k - split) / (1 - split);
    this.pose('bolt', through);
    return through;
  }
}

function flashTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 2, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,240,1)');
  grad.addColorStop(0.25, 'rgba(255,214,120,0.9)');
  grad.addColorStop(0.6, 'rgba(255,140,40,0.35)');
  grad.addColorStop(1, 'rgba(255,90,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(255,230,170,0.8)';
  g.lineWidth = 5;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    g.beginPath();
    g.moveTo(64, 64);
    g.lineTo(64 + Math.cos(a) * 60, 64 + Math.sin(a) * 60);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface ViewState {
  def: WeaponDef;
  team: number;
  /** Look delta this frame (radians) for sway. */
  lookDX: number;
  lookDY: number;
  speed: number;
  maxSpeed: number;
  onGround: boolean;
  velY: number;
  crouch: number;
  drawT: number; // 1 = just started drawing .. 0 = ready
  reloadT: number; // 0 = not reloading, else progress 0..1
  /** How full the magazine is, 0..1. */
  ammo: number;
  /** Where the spray has pushed the aim: radians up and left of where the player is looking. */
  recoilPitch: number;
  recoilYaw: number;
  scoped: boolean;
  grappling: boolean;
  mantling: boolean;
}

const SHELLS = 8;
/** How far a bolt or slide is thrown back by a shot (metres). */
const BOLT_TRAVEL = 0.04;
/** How long one stroke of a pump takes. */
const PUMP_SECONDS = 0.42;
/** A wrist moving faster than this (metres a second) is a cut in the animation, not a movement. */
const CUT_SPEED = 7;
/** How much of the spray's push the gun itself shows (the camera shows the rest: see VIEW_PUNCH in game.ts). */
const GUN_FOLLOWS = 0.4;

export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
  /** Carries the spring motion; the active rig hangs under it. */
  private holder = new THREE.Group();
  private rigs = new Map<string, Rig>();
  private current: Rig | null = null;
  private currentId = '';
  private flash: THREE.Mesh;
  private flashLight: THREE.PointLight;
  private flashT = 0;
  private shells: { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3; life: number }[] = [];
  private shellI = 0;

  private swayX = new Spring(140, 18);
  private swayY = new Spring(140, 18);
  // (stiff: each shot is its own jolt, over before the next, not a slow lean)
  private kickZ = new Spring(1400, 52);
  private kickPitch = new Spring(1200, 48);
  private kickRoll = new Spring(1000, 44);
  private landY = new Spring(120, 13);
  private bobPhase = 0;
  private bobAmt = 0;
  /** The part of the recoil the camera does not show, which the gun shows instead. */
  private clearing = 0;
  private tipping = 0;
  private climb = 0;
  private drift = 0;
  private wasGround = true;
  private idleT = 0;

  /** Seconds since the current one-shot animation started (<0 = none). */
  private fireT = -1;
  /** Seconds since the last shot, for the bolt's throw (<0 = at rest). */
  private shotT = -1;
  private fireDur = 0.2;
  private boltDur = 0;
  private pumpDur = 0;
  /** A hand-worked gun has a spent case still in it, thrown out when the pump or bolt comes back. */
  private caseIn = false;
  private meleeT = -1;
  private meleeClip = 'cutA';
  private meleeI = 0;
  private inspectT = -1;

  /** Muzzle position in viewmodel-camera space (for tracers). */
  readonly muzzleWorld = new THREE.Vector3();
  /** What the guns' skins react to. */
  private live: SkinLive = { heat: { value: 0 }, ammo: { value: 1 }, suitGlow: new THREE.Color() };

  constructor() {
    // Lit like the level: cool sky light from above, a cool key over the left shoulder and a
    // dim warm kick from the right so shapes keep some separation.
    this.scene.add(new THREE.HemisphereLight(0xa9c1ee, 0x1c2028, 1.0));
    const key = new THREE.DirectionalLight(0xdbe7ff, 1.8);
    key.position.set(-0.6, 1, 0.5);
    const kick = new THREE.DirectionalLight(0xffc9a0, 0.4);
    kick.position.set(1, 0.2, 0.4);
    this.scene.add(key, kick);
    this.scene.add(this.holder);

    const fm = new THREE.MeshBasicMaterial({
      map: flashTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, toneMapped: false, side: THREE.DoubleSide,
    });
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), fm);
    this.flash.visible = false;
    this.flash.renderOrder = 10;
    this.scene.add(this.flash);
    this.flashLight = new THREE.PointLight(0xffc070, 0, 3);
    this.scene.add(this.flashLight);

    const shellGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
    const shellMat = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.3, metalness: 0.9 });
    for (let i = 0; i < SHELLS; i++) {
      const mesh = new THREE.Mesh(shellGeo, shellMat);
      mesh.scale.set(0.009, 0.024, 0.009);
      mesh.visible = false;
      this.scene.add(mesh);
      this.shells.push({ mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0 });
    }
  }

  private rig(def: WeaponDef): Rig | null {
    let r = this.rigs.get(def.id);
    if (r) return r;
    const look = WEAPON_LOOK[def.id];
    const files = look ? getWeapon(def.id) : null;
    if (!look || !files) {
      void loadWeapon(def.id);
      return null;
    }
    r = new Rig(files, PACKS[look.pack]!, look, def.team, SKINS[def.id], this.live);
    r.root.visible = false;
    this.holder.add(r.root);
    this.rigs.set(def.id, r);
    return r;
  }

  onShot(def: WeaponDef): void {
    const k = def.kick;
    this.kickZ.kick(4.4 * k);
    this.kickPitch.kick(5.8 * k);
    this.kickRoll.kick((Math.random() - 0.5) * 11 * k);
    this.swayX.kick((Math.random() - 0.5) * 0.2 * k);
    this.flashT = 0.045;
    this.flash.rotation.z = Math.random() * Math.PI * 2;
    // (kept small: a flash that fills the view hides the target the next round is meant for)
    const s = 0.42 + Math.random() * 0.22 + k * 0.1;
    this.flash.scale.set(s, s, s);
    this.inspectT = -1;
    this.fireT = 0;
    this.shotT = 0;
    // Each shot heats the gun; slow, heavy guns more per shot.
    this.live.heat.value = Math.min(1, this.live.heat.value + 0.07 + 0.12 * k);
    const r = this.current;
    const interval = 60 / def.rpm;
    if (r) {
      // Automatic fire restarts the clip every shot; slow guns play it in full, then cycle the bolt.
      this.fireDur = Math.min(r.seconds('fire') || 0.2, def.auto ? Math.max(0.09, interval * 1.6) : Math.max(0.12, interval * 0.95));
      this.boltDur = r.has('bolt') ? Math.max(0.3, interval - this.fireDur - 0.05) : 0;
      // (a pump is worked as the kick dies away, not after it)
      if (r.pumps) this.fireDur = Math.min(this.fireDur, 0.24);
      this.pumpDur = r.pumps ? Math.min(PUMP_SECONDS, Math.max(0.25, interval - this.fireDur - 0.06)) : 0;
    }
    const worked = !!r && (r.pumps || this.boltDur > 0);
    this.caseIn = worked;
    // (a break-action keeps its cases until it is opened)
    if (!worked && def.kind !== 'shotgun') this.ejectShell();
  }

  onMelee(): void {
    this.meleeT = 0;
    this.inspectT = -1;
    const order = ['cutA', 'cutB', 'cutA', 'stab'];
    this.meleeClip = order[this.meleeI++ % order.length]!;
  }

  /** Play the weapon inspect animation (cosmetic). */
  onInspect(): void {
    if (this.fireT < 0 && this.meleeT < 0) this.inspectT = 0;
  }

  private ejectShell(): void {
    const r = this.current;
    if (!r) return;
    const s = this.shells[this.shellI++ % SHELLS]!;
    s.mesh.visible = true;
    s.life = 0.6;
    s.mesh.position.set(r.muzzle.x + 0.01, r.muzzle.y + 0.02, r.muzzle.z * 0.3);
    this.holder.localToWorld(s.mesh.position);
    s.vel.set(1.0 + Math.random() * 0.5, 1.1 + Math.random() * 0.5, 0.15 + Math.random() * 0.3);
    s.spin.set(Math.random() * 20, Math.random() * 20, Math.random() * 20);
  }

  update(dt: number, st: ViewState): void {
    FINISH_TIME.value += dt;
    this.live.heat.value *= Math.exp(-dt * 1.9);
    this.live.ammo.value += (st.ammo - this.live.ammo.value) * Math.min(1, dt * 12);
    this.live.suitGlow.set(SIDE_GLOW[st.team] ?? 0x9fc4ff).multiplyScalar(SUIT_GLOW);
    const r = this.rig(st.def);
    if (this.currentId !== st.def.id) {
      if (this.current) this.current.root.visible = false;
      this.current = r;
      this.currentId = r ? st.def.id : '';
      this.fireT = this.meleeT = this.inspectT = -1;
      this.idleT = 0;
      r?.cut();
    }
    r?.advance(dt);
    if (r) r.root.visible = !st.scoped;

    // ---- authored animation: pick the movement and how far through it ----------
    let procDraw = 0;
    /** How far through working the action at the end of a reload (0 = not). */
    let racking = 0;
    /** How far the gun is tipped down and over for a reload that has no clip of its own (0..1). */
    let tipped = 0;
    let procInspect = 0;
    /** How far through a stroke of the pump (0 = not). */
    let pumping = 0;
    if (r) {
      this.idleT += dt;
      const reloading = st.reloadT > 0;
      if (reloading || st.drawT > 0) this.inspectT = -1;
      if (st.drawT > 0) {
        if (r.has('draw')) r.pose('draw', 1 - st.drawT);
        else { r.pose('idle', 0); procDraw = st.drawT; }
        this.fireT = this.meleeT = -1;
      } else if (reloading) {
        racking = r.poseReload(st.reloadT);
        pumping = r.reloadPump;
        if (!r.has('reload')) tipped = Math.sin(Math.PI * st.reloadT) ** 0.6;
        this.fireT = -1;
      } else if (this.meleeT >= 0) {
        this.meleeT += dt / 0.4;
        if (this.meleeT >= 1) this.meleeT = -1;
        else r.pose(r.has(this.meleeClip) ? this.meleeClip : 'melee', this.meleeT);
      } else if (this.fireT >= 0) {
        this.fireT += dt;
        if (this.fireT < this.fireDur) r.pose(r.has('fire') ? 'fire' : 'idle', r.has('fire') ? this.fireT / this.fireDur : 0);
        else if (this.boltDur > 0 && this.fireT < this.fireDur + this.boltDur) {
          const through = (this.fireT - this.fireDur) / this.boltDur;
          r.pose('bolt', through);
          if (this.caseIn && through > 0.42) { this.caseIn = false; this.ejectShell(); }
        } else if (this.pumpDur > 0 && this.fireT < this.fireDur + this.pumpDur) {
          r.pose('idle', 0);
          pumping = (this.fireT - this.fireDur) / this.pumpDur;
          if (this.caseIn && pumping > 0.36) { this.caseIn = false; this.ejectShell(); }
        } else this.fireT = -1;
      }
      if (st.drawT <= 0 && !reloading && this.meleeT < 0 && this.fireT < 0) {
        if (this.inspectT >= 0) {
          const dur = r.has('inspect') ? Math.min(4.5, r.seconds('inspect')) : 2.2;
          this.inspectT += dt / dur;
          if (this.inspectT >= 1) this.inspectT = -1;
          else if (r.has('inspect')) r.pose('inspect', this.inspectT);
          else { r.pose('idle', 0); procInspect = Math.sin(this.inspectT * Math.PI); }
        }
        // The packs' own idle loops rock visibly; hold the rest pose and breathe procedurally.
        if (this.inspectT < 0) r.pose('idle', 0);
      }
    }

    r?.pump(pumping);
    r?.cycle(this.shotT >= 0 ? this.shotT / 0.085 : 0);
    if (this.shotT >= 0) {
      this.shotT += dt;
      if (this.shotT > 0.085) this.shotT = -1;
    }

    // ---- spring layer --------------------------------------------------------------
    const sx = this.swayX.step(THREE.MathUtils.clamp(-st.lookDX * 1.6, -0.06, 0.06), dt);
    const sy = this.swayY.step(THREE.MathUtils.clamp(st.lookDY * 1.6, -0.05, 0.05), dt);

    const moveF = st.onGround ? Math.min(1, st.speed / Math.max(1, st.maxSpeed)) : 0;
    this.bobAmt += (moveF - this.bobAmt) * Math.min(1, dt * 9);
    this.bobPhase += dt * (5.5 + st.speed * 1.35) * (moveF > 0.05 ? 1 : 0);
    const bobX = Math.sin(this.bobPhase) * 0.0055 * this.bobAmt;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * 0.0065 * this.bobAmt + 0.003 * this.bobAmt;

    if (st.onGround && !this.wasGround) this.landY.kick(-Math.min(1.4, 0.25 + Math.abs(st.velY) * 0.08));
    this.wasGround = st.onGround;
    const air = st.onGround ? 0 : THREE.MathUtils.clamp(st.velY * 0.003, -0.025, 0.025);
    const land = this.landY.step(0, dt);

    const kz = this.kickZ.step(0, dt);
    const kp = this.kickPitch.step(0, dt);
    const kr = this.kickRoll.step(0, dt);
    // The camera follows part of the spray; the gun takes up the rest, so the muzzle points
    // where the rounds are actually going and can be seen climbing and walking sideways.
    const follow = Math.min(1, dt * 26);
    this.climb += (st.recoilPitch * GUN_FOLLOWS - this.climb) * follow;
    this.drift += (st.recoilYaw * GUN_FOLLOWS - this.drift) * follow;
    // Drawn by the springs: up from low and to the right, canted, straightening as it arrives.
    const drawE = procDraw * procDraw;

    const breath = Math.sin(this.idleT * 1.5) * 0.0012 * (1 - this.bobAmt);
    // While the action is worked the hand comes back past the eye: ease the gun away and down
    // for that moment, so a glove does not fill the corner of the view.
    const clear = racking > 0 ? Math.sin(Math.PI * Math.min(1, racking * 1.15)) : 0;
    this.clearing += (clear - this.clearing) * Math.min(1, dt * 14);
    this.tipping += (tipped - this.tipping) * Math.min(1, dt * 12);
    const h = this.holder;
    h.position.set(
      sx * 0.3 + bobX + drawE * 0.06 + procInspect * -0.05,
      sy * 0.3 + bobY + breath + land * 0.35 - air - drawE * 0.22 - this.clearing * 0.05 - this.tipping * 0.03 + st.crouch * 0.006 + procInspect * 0.03,
      kz * 0.3 + drawE * 0.05 - this.clearing * 0.17,
    );
    h.rotation.set(
      kp * 0.22 + this.climb + sy * 0.8 - drawE * 0.75 - this.tipping * 0.22 + air * 2 + procInspect * 0.25,
      sx * 1.0 + this.drift + bobX * 1.5 - drawE * 0.3 + procInspect * 0.9,
      kr * 0.16 - sx * 1.2 + st.crouch * 0.04 - drawE * 0.45 + this.tipping * 0.4 + procInspect * 0.6,
      'YXZ',
    );

    // ---- muzzle flash ------------------------------------------------------------------
    h.updateMatrixWorld(true);
    if (r) this.muzzleWorld.copy(r.muzzle);
    else this.muzzleWorld.set(0.1, -0.1, -0.6);
    h.localToWorld(this.muzzleWorld);
    if (this.flashT > 0) {
      this.flashT -= dt;
      this.flash.visible = !st.scoped && !!r;
      this.flash.position.copy(this.muzzleWorld);
      this.flash.position.z -= 0.03;
      this.flashLight.position.copy(this.muzzleWorld);
      this.flashLight.intensity = 2.5;
    } else {
      this.flash.visible = false;
      this.flashLight.intensity = 0;
    }

    for (const s of this.shells) {
      if (s.life <= 0) continue;
      s.life -= dt;
      s.vel.y -= 9.8 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.z += s.spin.z * dt;
      if (s.life <= 0) s.mesh.visible = false;
    }
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    // Keep the gun the same apparent size on tall (portrait) screens.
    this.camera.fov = aspect < 1 ? 78 : 62;
    this.camera.updateProjectionMatrix();
  }
}
