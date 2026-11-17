// First-person weapons. Each weapon is an authored pack (gun + arms + hand-made
// animation) played by name; spring-driven sway, bob, recoil and landing motion are
// layered on top so the gun reacts to the player's own movement.

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { WeaponDef } from '../sim/weapons';
import { PACKS, WEAPON_LOOK, getWeapon, loadWeapon, nadeMaterial, type PackInfo, type WeaponFiles, type WeaponLook } from './assets';
import { NadeRig, type NadeViewState } from './nade-view';
import { ARMS_TINT, BLADE_FINISH, FINISH_TIME, applyFinish, armsFinish, gunFinish, roleOf, tagGunSpace, type Role, type Skin, type SkinWear } from './finish';
import { SKINS } from './skins';
import { FLASH_KINDS, flashTexture } from './effects';
import { WornArms } from './worn-arms';
import {
  BOLT_RELOAD, BREAK_RELOAD, DRAW_HEAVY, DRAW_PISTOL, DRAW_RIFLE, INSPECT_KNIFE, INSPECT_PAIR, INSPECT_PISTOL, INSPECT_RIFLE, PISTOL_RELOAD, PISTOL_RELOAD_EMPTY, PUMP_LOADING, PUMP_RELOAD,
  PUMP_SHELLS, RIFLE_CLIP_ENDS, RIFLE_RACK, RIFLE_RELOAD, RIFLE_RELOAD_TAP, carryAt, type Foley, type Move,
} from './moves';

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
const isArms = (m: THREE.Material): boolean => /^(arms?|hands?|gloves?|sleeves?)$/i.test(m.name);
const isLens = (m: THREE.Material): boolean => /lens/i.test(m.name);

/** Every pair of arms wears the same finish, and every gun its skin (see finish.ts). */
function finishFor(src: THREE.Material, team: number, meshes: readonly THREE.Mesh[], wear?: SkinWear): THREE.Material {
  if (isLens(src)) return lensMaterial(src);
  if (isArms(src)) return applyFinish(src, ARMS_FINISH, meshes);
  if (/^knife$/i.test(src.name)) return applyFinish(src, BLADE_FINISH, meshes, wear);
  return applyFinish(src, gunFinish(team), meshes, wear);
}

/** Eye-space axes (muzzle down -z) to gun-space axes (muzzle along +x). */
const EYE_TO_GUN = new THREE.Matrix4().set(0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1);

/** The state a gun's skin reacts to: heat from firing, and how full the magazine is. */
export interface SkinLive {
  heat: { value: number };
  ammo: { value: number };
}
/** The dye of the player's sleeves and gloves: their side's (see ARMS_TINT). */
const ARMS_DYE = new THREE.Vector3(1, 1, 1);
const ARMS_FINISH = armsFinish(ARMS_DYE);

const _v = new THREE.Vector3();
const _fq = new THREE.Quaternion();
const _swing = new THREE.Matrix4(), _turn = new THREE.Matrix4(), _back = new THREE.Matrix4();
const _box = new THREE.Box3();
const STILL = [0, 0, 0, 0, 0, 0, 0] as const;
const _carried = new THREE.Vector3();
const _turned = new THREE.Euler();

const EMPTY = new THREE.BufferGeometry();
const pieceOf = (name: string): string => name.replace(/_\d+$/, '');

/** One weapon's instance: an arm pack with its gun, its own skeleton, materials and animation state. */
class Rig {
  /** Eye space: x right, y up, the muzzle away down -z, metres. */
  readonly root = new THREE.Group();
  /** Muzzle tip at rest, in `root` space. */
  readonly muzzle = new THREE.Vector3(0.08, -0.08, -0.6);
  /** Where spent cases leave the gun at rest, in `root` space: the right-hand face of the bolt or slide. */
  readonly port = new THREE.Vector3(0.1, -0.07, -0.3);
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
  /**
   * The clip's own pose as last sampled. The mixer writes a joint only when its value has
   * changed, so a movement held at one moment would otherwise leave the eased pose in place
   * and the blend would never arrive: the joints are put back to this before each sample.
   */
  private aimP: THREE.Vector3[] = [];
  private aimQ: THREE.Quaternion[] = [];
  /** The pose at rest, which a firing movement drawn for a heavier gun is held part-way back to. */
  private restP: THREE.Vector3[] = [];
  private restQ: THREE.Quaternion[] = [];
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
   * A suppressor that is fitted and taken off in play: what holds it and how it sits when on, the
   * middle of it and the way it unscrews (the gun's own space), and the muzzle with and without it.
   */
  private cans: { holder: THREE.Object3D; on: THREE.Matrix4 }[] = [];
  private canAt = new THREE.Vector3();
  private canOut = 0.12;
  private bare = new THREE.Vector3();
  private capped = new THREE.Vector3();
  /** How far the left arm goes to reach it, to draw it off, and to take it out of view (the arm's own space). */
  private canShift = new THREE.Vector3();
  private canDraw = new THREE.Vector3();
  private canAway = new THREE.Vector3();
  /** The suppressor is on the muzzle. */
  quiet = false;
  /** A gun in each hand: both muzzles, and which fires next. */
  private muzzles: [THREE.Vector3, THREE.Vector3] | null = null;
  private side = 0;
  /** The right wrist at rest, in `root` space: what the gun is turned about when a movement carries it. */
  readonly pivot = new THREE.Vector3(0.12, -0.16, -0.28);
  /** How this gun is loaded, which decides the movements it is shown with (see moves.ts). */
  readonly style: 'rifle' | 'bolt' | 'pistol' | 'pump' | 'break' | 'blade' | 'own';
  /** When, through each of the pack's own reloads, its moments are heard (found from how the joints move). */
  private heard = new Map<string, Move>();
  /** The left arm is moved by the clips themselves (so it is not put back to its rest place before each pose). */
  private armDriven = false;
  /** Where the left arm goes to take the hand off the gun and out of view (the arm's own space). */
  private awayShift = new THREE.Vector3();
  /**
   * The action worked by the left hand at the end of a reload: how far the arm goes to reach the
   * handle and to draw it back (the arm's own space), and how far the bolt travels (the gun's own).
   */
  private handRack = false;
  private rackShift = new THREE.Vector3();
  private rackDraw = new THREE.Vector3();
  private rackPull = 0;
  /** A tube magazine fed by hand: the arm at the loading port and down at the pouch, the shell it brings, and where the port is. */
  private loadShift = new THREE.Vector3();
  private fetchShift = new THREE.Vector3();
  private pushShift = new THREE.Vector3();
  private round: THREE.Mesh | null = null;
  private loadAt = new THREE.Vector3();
  /** A break-action's breech, where the hand changes the shells. */
  private breechShift = new THREE.Vector3();
  /** Our arms, posed after a pack's skeleton that came without any (see worn-arms.ts). */
  private worn: WornArms | null = null;
  /** How far through each part of a reload (0 = not in it): working the action, feeding shells, at the open breech. */
  reloadRack = 0;
  reloadLoad = 0;
  reloadBreech = 0;

  /**
   * @param team the side the weapon belongs to (-1 = both), which tints its bare finish
   * @param skin the paint the gun wears, if any
   */
  constructor(
    files: WeaponFiles, readonly info: PackInfo, look: WeaponLook, team: number, skin: Skin | undefined, live: SkinLive,
    suppressor?: { fitted: boolean },
  ) {
    this.skip = new Set(look.skip ?? []);
    const mounted = look.mount;
    // ('own': an automatic in a pack that was animated for one; its clips carry the gun themselves)
    this.style = look.pack === 'knife' ? 'blade' : mounted?.pump ? 'pump' : mounted?.hinge ? 'break' : look.pack === 'm9' ? 'pistol'
      : info.skinned || look.authored ? 'own' : mounted ? 'rifle' : 'bolt';
    this.handRack = this.style === 'rifle' && !!look.rack;
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

    // Where every joint stands in the file as loaded, in the pack's own space.
    scene.updateMatrixWorld(true);
    const sceneInv = new THREE.Matrix4().copy(scene.matrixWorld).invert();
    const joints = new Map<string, THREE.Object3D>();
    const filed = new Map<THREE.Object3D, THREE.Matrix4>();
    scene.traverse((o) => {
      if (!joints.has(o.name)) joints.set(o.name, o);
      filed.set(o, new THREE.Matrix4().copy(sceneInv).multiply(o.matrixWorld));
    });

    // A pack that is a skeleton and its animation only: the arms of another pack by the same
    // maker (the same rig, joint for joint) are bound to its joints.
    if (info.armsOf && files.arms) {
      const donor = SkeletonUtils.clone(files.arms.scene);
      donor.updateMatrixWorld(true);
      const named = new Map<string, THREE.Object3D>();
      scene.traverse((o) => { const n = pieceOf(o.name); if (!named.has(n)) named.set(n, o); });
      const arms: THREE.SkinnedMesh[] = [];
      donor.traverse((o) => {
        const mesh = o as THREE.SkinnedMesh;
        if (mesh.isSkinnedMesh && isArms(mesh.material as THREE.Material)) arms.push(mesh);
      });
      for (const mesh of arms) {
        // The arms keep their own bind pose: the same rig, so the same joints in the same places.
        const bones: THREE.Bone[] = [], inverses: THREE.Matrix4[] = [];
        // Joint for joint by name; the ends of the fingers and the palms, which the two files
        // name differently, by where they hang (the first joint under the same parent not yet taken).
        const match = new Map<THREE.Object3D, THREE.Object3D>();
        for (const b of mesh.skeleton.bones) { const j = named.get(pieceOf(b.name)); if (j) match.set(b, j); }
        const taken = new Set(match.values());
        for (const b of mesh.skeleton.bones) {
          if (match.has(b) || !b.parent) continue;
          const free = match.get(b.parent)?.children.find((c) => !taken.has(c) && !(c as THREE.Mesh).isMesh);
          if (free) { match.set(b, free); taken.add(free); }
        }
        mesh.skeleton.bones.forEach((b, i) => {
          bones.push((match.get(b) ?? b) as THREE.Bone);
          inverses.push(mesh.skeleton.boneInverses[i]!.clone());
        });
        scene.add(mesh);
        mesh.bind(new THREE.Skeleton(bones, inverses), mesh.bindMatrix);
      }
    }

    // A pack animated on another maker's skeleton, with no arms: ours are posed after it.
    if (info.wears && files.arms) {
      const by = PACKS[info.wears]!;
      const ours = SkeletonUtils.clone(files.arms.scene);
      // (only the arms: the gun that came in their file is left out)
      const drop: THREE.Object3D[] = [];
      ours.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && !((mesh as THREE.SkinnedMesh).isSkinnedMesh && isArms(mesh.material as THREE.Material))) drop.push(mesh);
      });
      for (const o of drop) o.removeFromParent();
      // (stood as their own pack stands them at rest, where it holds them)
      const still = new THREE.AnimationMixer(ours);
      still.clipAction(files.arms.animations[0]!).play();
      still.setTime(0);
      const place = new THREE.Group();
      place.matrixAutoUpdate = false;
      this.root.updateMatrixWorld(true);
      place.matrix.copy(scene.matrixWorld).invert().multiply(this.root.matrixWorld)
        .multiply(new THREE.Matrix4().makeTranslation(
          by.hold[0] + (info.shoulders?.[0] ?? 0), by.hold[1] + (info.shoulders?.[1] ?? 0), by.hold[2] + (info.shoulders?.[2] ?? 0),
        ))
        .multiply(new THREE.Matrix4().fromArray(by.view));
      place.add(ours);
      scene.add(place);
      this.root.updateMatrixWorld(true);
      const worn = new WornArms(scene, ours, this.root);
      if (worn.ok) this.worn = worn;
      else console.warn(`arms could not be matched to the ${info.file} skeleton`);
    }

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
        this.aimP.push(node.position.clone());
        this.aimQ.push(node.quaternion.clone());
        // (the wrist by every name the packs give it: L_wrist, l_wrist, hand_l, DEF-hand.L)
        if (/^([LR]_wrist|[lr]_wrist_\d|hand_[lr]_\d|DEF-hand[LR]_\d)/.test(node.name)) this.wrists.push({ bone: node, was: new THREE.Vector3() });
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
    /** The suppressor's meshes, and the room they take up on the gun (the model's own space). */
    const canMeshes = new Set<THREE.Mesh>();
    const canBox = new THREE.Box3();
    /** The room the gun's own bolt takes up (the model's own space). */
    const boltBox = new THREE.Box3();
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
      if (!info.skinned) {
        // Rigid packs: a joint's place is where the first frame of the animation puts it.
        this.mixer.setTime(0);
        scene.updateMatrixWorld(true);
      }
      const placeOf = (joint: THREE.Object3D): THREE.Matrix4 =>
        info.skinned ? filed.get(joint)! : new THREE.Matrix4().copy(scene.matrixWorld).invert().multiply(joint.matrixWorld);

      const gun = files.gun.scene.clone(true);
      const size = mount.size ?? 1;
      const move = new THREE.Vector3(...(mount.nudge ?? [0, 0, 0]));
      seatSize = size;
      seatMove.copy(move);
      const seat = new THREE.Matrix4().compose(move, new THREE.Quaternion(), new THREE.Vector3(size, size, size));
      const gunSpace = new THREE.Matrix4().fromArray(info.frame).invert().multiply(seat);
      const swings = new Set(mount.hinge?.pieces ?? []);
      if (mount.hinge) this.hinge = { at: new THREE.Vector3(...mount.hinge.at), angle: mount.hinge.angle };
      const hang = (piece: THREE.Object3D, on: string, by = on): void => {
        const n = joints.get(on), j = joints.get(by);
        if (!n || !j) return;
        const h = new THREE.Group();
        h.matrixAutoUpdate = false;
        h.matrix.copy(placeOf(j)).invert().multiply(gunSpace);
        h.add(piece);
        n.add(h);
        if (by !== on) return;
        const name = pieceOf(piece.name);
        if (swings.has(name)) this.hinged.push({ holder: h, closed: h.matrix.clone() });
        else if (mount.pump && name === mount.pump.piece) this.pumped.push({ holder: h, closed: h.matrix.clone() });
        // (a bolt riding the gun's body, or a slide whose firing movement this weapon leaves out)
        else if (/^(bolt|slide)$/.test(name) && (on === mount.ride['base'] || this.skip.has('fire'))) this.bolts.push({ holder: h, closed: h.matrix.clone() });
        else if (name === 'silencer') this.cans.push({ holder: h, on: h.matrix.clone() });
      };
      const pieces: THREE.Mesh[] = [];
      gun.traverse((o) => { if ((o as THREE.Mesh).isMesh) pieces.push(o as THREE.Mesh); });
      const hide = new Set(mount.hide ?? []);
      for (const piece of pieces) {
        const name = pieceOf(piece.name);
        if (hide.has(name) || (name === 'silencer' && !suppressor)) continue;
        const joint = mount.ride[name] ?? mount.ride['base']!;
        piece.updateMatrix();
        onGun.set(piece, { toGun: piece.matrix.clone(), role: roleOf(name) });
        if (name === 'mag' && mount.spare) {
          // The fresh magazine the left hand brings up.
          const spare = piece.clone(true);
          onGun.set(spare, onGun.get(piece)!);
          hang(spare, mount.spare[0], mount.spare[1]);
        }
        hang(piece, joint);
        if (mount.twin) {
          // The gun in the other hand: the same piece, placed as the first is, on the other hand's joint.
          const other = piece.clone(true);
          onGun.set(other, onGun.get(piece)!);
          hang(other, mount.twin[name] ?? mount.twin['base']!, joint);
        }
        if (name === 'silencer') {
          canMeshes.add(piece);
          piece.geometry.computeBoundingBox();
          canBox.union(_box.copy(piece.geometry.boundingBox!).applyMatrix4(piece.matrix));
        } else if (/^(bolt|slide)$/.test(name)) {
          piece.geometry.computeBoundingBox();
          boltBox.union(_box.copy(piece.geometry.boundingBox!).applyMatrix4(piece.matrix));
        }
      }
      if (mount.pump && look.loadAt) {
        // The shell the hand brings to the loading port (lying along the barrel).
        this.round = new THREE.Mesh(ROUND_GEO, ROUND_MAT);
        this.round.name = 'round';
        this.round.userData['prop'] = true;
        this.round.frustumCulled = false;
        this.round.visible = false;
        this.loadAt.set(...look.loadAt);
        hang(this.round, mount.ride['base']!);
      }
      if (!canBox.isEmpty()) {
        canBox.getCenter(this.canAt);
        // (drawn off by a little more than its own length, in the model's own units)
        this.canOut = (canBox.max.x - canBox.min.x) * 0.8;
      }
    }

    // Arms that came without textures borrow the same maker's from another pack.
    let borrowedArms: THREE.Material | null = null;
    files.arms?.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && !Array.isArray(m) && isArms(m) && (m as THREE.MeshStandardMaterial).map) borrowedArms = m;
    });

    // The pack's own reloads: when the magazine leaves and comes back, and when the bolt is
    // drawn and let go, read off the joints, so the sounds follow whatever the clip does.
    if (this.style === 'own' && mount) {
      const ride = mount.ride;
      const base = joints.get(ride['base'] ?? ''), mag = joints.get(ride['mag'] ?? ''), bolt = joints.get(ride['bolt'] ?? '');
      const barrels = joints.get(ride['barrels'] ?? ''), shells = joints.get(ride['shells'] ?? '');
      for (const name of ['reload', 'reloadEmpty']) {
        const range = info.clips[name];
        if (!range || !base) continue;
        const N = 80;
        const magAt: number[] = [], boltAt: number[] = [], shellAt: number[] = [], openBy: number[] = [];
        const inv = new THREE.Matrix4(), baseQ = new THREE.Quaternion(), partQ = new THREE.Quaternion();
        for (let i = 0; i <= N; i++) {
          this.mixer.setTime((range[0] + ((range[1] - range[0]) * i) / N) / info.fps);
          scene.updateMatrixWorld(true);
          inv.copy(base.matrixWorld).invert();
          const scale = base.getWorldScale(_v).x || 1;
          const from = (j: THREE.Object3D | undefined): number => (j ? j.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv).length() * scale : 0);
          magAt.push(from(mag));
          boltAt.push(from(bolt));
          shellAt.push(from(shells));
          // (how far the barrels are turned from the stock: a break-action broken open)
          if (barrels) openBy.push(base.getWorldQuaternion(baseQ).angleTo(barrels.getWorldQuaternion(partQ)));
        }
        const cues: [number, Foley, number][] = [[0.02, 'cloth', 0]];
        /** When a part first leaves where it starts, and when it last arrives where it ends up. */
        const moved = (at: number[], by: number): [number, number] | null => {
          let first = -1, last = -1;
          for (let i = 0; i <= N; i++) if (Math.abs(at[i]! - at[0]!) > by) { first = i; break; }
          for (let i = N; i >= 0; i--) if (Math.abs(at[i]! - at[N]!) > by) { last = i; break; }
          return first < 0 || last < first ? null : [first / N, Math.min(1, (last + 1) / N)];
        };
        const m = moved(magAt, 0.02), b = moved(boltAt, 0.008);
        if (m) cues.push([m[0], 'magout', 0.3], [m[1], 'magin', 0.6]);
        if (b) cues.push([b[0], 'boltback', 0.3], [b[1], 'boltfwd', 0.7]);
        if (barrels && openBy.length) {
          // (this pack breaks its gun open by only five degrees or so)
          const o = moved(openBy, 0.04);
          if (o) cues.push([o[0], 'open', 0.5], [o[1], 'close', 0.9]);
          const sh = moved(shellAt, 0.02);
          // (the spent shells come out once it is open, the fresh ones are heard going home before it shuts)
          const out = sh ? Math.max(sh[0], (o?.[0] ?? 0) + 0.05) : 0;
          if (sh) cues.push([out, 'shell', 0.25], [Math.max(out + 0.05, sh[1] - 0.06), 'shell', 0.3]);
        }
        // (a reload that ends with the pack's bolt movement: the clip is the first part of it)
        const part = this.rack ? this.seconds(name) / (this.seconds(name) + this.seconds('bolt')) : 1;
        if (part < 1) {
          for (const cue of cues) cue[0] *= part;
          cues.push([part + 0.3 * (1 - part), 'boltback', 0.4]);
        }
        cues.sort((p, q) => p[0] - q[0]);
        this.heard.set(name, { keys: [[0, STILL], [1, STILL]], cues });
      }
    }

    this.pose('idle', 0);
    for (const node of this.driven) {
      this.restP.push(node.position.clone());
      this.restQ.push(node.quaternion.clone());
    }
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
      if (!mesh.isMesh || mesh.userData['prop']) return;
      // Hands swing well outside their rest bounds during reloads.
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      meshes.push(mesh);
      const src = mesh.material as THREE.Material;
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
      // (a suppressor the gun does not come with is painted like the rest, but the paint is not laid out round it)
      tagGunSpace(mesh, place.toGun, canMeshes.has(mesh) && !suppressor?.fitted ? undefined : gunBox);
      if (place.role === 'cell') tagGunSpace(mesh, place.toGun, cellBox);
    });
    const length = new THREE.Vector2(gunBox.min.x, gunBox.max.x);
    const cell = cellBox.isEmpty() ? new THREE.Vector2(0, 1) : new THREE.Vector2(cellBox.min.y, cellBox.max.y);

    // ---- fit the left hand to this gun ---------------------------------------------------
    // The arms were animated round the pack's own gun. Another gun's fore-end and magazine
    // are somewhere else, so the whole left arm is shifted: onto the fore-end while it holds
    // the gun, and onto the magazine while it changes it (the shoulder end is out of view).
    this.leftArm = [...joints.values()].find((j) => /^L_arm/.test(j.name)) ?? null;
    const wrist = [...joints.values()].find((j) => /^L_wrist/.test(j.name));
    if (this.leftArm?.parent && wrist) {
      this.leftArmRest.copy(this.leftArm.position);
      this.armDriven = seen.has(this.leftArm);
      const gunToArm = new THREE.Matrix3().setFromMatrix4(
        new THREE.Matrix4().copy(this.leftArm.parent.matrixWorld).invert().multiply(scene.matrixWorld).multiply(new THREE.Matrix4().copy(packToGun).invert()),
      );
      /** Where the left wrist is while the hand holds the gun (gun space, as seated). */
      const hand = wrist.getWorldPosition(new THREE.Vector3()).applyMatrix4(new THREE.Matrix4().copy(packToGun).multiply(fromScene));
      if (look.support) hand.add(_v.set(...look.support));
      /** A point of the model, as the gun is seated. */
      const seated = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z).multiplyScalar(seatSize).add(seatMove);
      /** How far the arm goes to put the wrist `grip` from a point of the gun (the arm's own space). */
      const reach = (at: THREE.Vector3, grip: readonly number[] | undefined, out: THREE.Vector3): THREE.Vector3 =>
        out.set(at.x - hand.x + (grip?.[0] ?? 0), at.y - hand.y + (grip?.[1] ?? 0), at.z - hand.z + (grip?.[2] ?? 0)).applyMatrix3(gunToArm);
      this.awayShift.set(-0.08, -0.36, -0.04).applyMatrix3(gunToArm);
      if (look.support) this.holdShift.set(...look.support).applyMatrix3(gunToArm);
      if (mount?.pump) {
        this.pumpTravel = mount.pump.travel;
        this.pumpShift.set(-mount.pump.travel * seatSize, 0, 0).applyMatrix3(gunToArm);
      }
      if (this.round) {
        reach(seated(this.loadAt.x, this.loadAt.y, this.loadAt.z), info.loadGrip, this.loadShift);
        this.fetchShift.set(-0.05, -0.3, -0.03).applyMatrix3(gunToArm).add(this.loadShift);
        this.pushShift.set(0.035, 0.012, 0).applyMatrix3(gunToArm);
      }
      if (mount?.hinge) {
        const at = mount.hinge.at;
        reach(seated(at[0] - 0.05, at[1] + 0.035, at[2]), info.loadGrip, this.breechShift);
      }
      if (this.handRack) {
        // The handle of the action: where the weapon says, else on the right-hand face of the
        // gun's own bolt, else above the magazine (on the left for a release that is tapped).
        const at = look.rackAt ? seated(...look.rackAt)
          : !boltBox.isEmpty() ? seated((boltBox.min.x + boltBox.max.x) / 2, (boltBox.min.y + boltBox.max.y) / 2, boltBox.max.z)
          : !cellBox.isEmpty() ? seated((cellBox.min.x + cellBox.max.x) / 2, cellBox.max.y + 0.04, look.rackPull === 0 ? cellBox.min.z : cellBox.max.z)
          : null;
        if (at) {
          reach(at, info.rackGrip, this.rackShift);
          this.rackPull = look.rackPull ?? 0.055;
          this.rackDraw.set(-this.rackPull * seatSize, 0, 0).applyMatrix3(gunToArm);
        } else this.handRack = false;
      }
      if (this.cans.length > 0) {
        // The hand holds the gun by the fore-end; the suppressor is further along the same line.
        reach(seated(this.canAt.x, this.canAt.y, this.canAt.z), info.canGrip, this.canShift);
        this.canDraw.set(this.canOut * seatSize, 0, 0).applyMatrix3(gunToArm);
        this.canAway.set(-0.1, -0.3, -0.05).applyMatrix3(gunToArm);
      }
      const packBox = new THREE.Box3();
      for (const { mesh, geo } of ownCell) {
        const pos = geo.getAttribute('position');
        if (!pos) continue;
        const toGun = new THREE.Matrix4().copy(packToGun).multiply(fromScene).multiply(mesh.matrixWorld);
        for (let i = 0; i < pos.count; i += 4) packBox.expandByPoint(_v.fromBufferAttribute(pos, i).applyMatrix4(toGun));
      }
      if (mount && !packBox.isEmpty() && !cellBox.isEmpty()) {
        const mine = cellBox.getCenter(new THREE.Vector3()).multiplyScalar(seatSize).add(seatMove);
        this.magShift.copy(mine).sub(packBox.getCenter(_v)).applyMatrix3(gunToArm);
      }
    } else {
      this.leftArm = null;
      this.handRack = false;
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
      const wear: SkinWear | undefined = !isArms(src) && skin && role ? { skin, role, length, cell, heat: live.heat, ammo: live.ammo } : undefined;
      const finished = finishFor(src, team, list, wear);
      for (const mesh of list) mesh.material = finished;
    }

    // Find the muzzle: the centroid of the vertices furthest down -z in the rest pose.
    this.root.updateMatrixWorld(true);
    const pts: number[] = [], canPts: number[] = [];
    const action = new THREE.Box3(), well = new THREE.Box3();
    for (const mesh of meshes) {
      const pos = mesh.geometry.getAttribute('position');
      if (!pos) continue;
      const part = /^(bolt|slide)(_|$)/.test(mesh.name) ? action : /^(mag|clip)(_|$)/.test(mesh.name) ? well : null;
      const into = canMeshes.has(mesh) ? canPts : pts;
      const step = Math.max(1, Math.floor(pos.count / 4000));
      for (let i = 0; i < pos.count; i += step) {
        mesh.getVertexPosition(i, _v).applyMatrix4(mesh.matrixWorld);
        into.push(_v.x, _v.y, _v.z);
        part?.expandByPoint(_v);
      }
    }
    const tip = (points: number[], out: THREE.Vector3): boolean => {
      let minZ = Infinity;
      for (let i = 2; i < points.length; i += 3) if (points[i]! < minZ) minZ = points[i]!;
      let sx = 0, sy = 0, c = 0;
      for (let i = 0; i < points.length; i += 3) {
        if (points[i + 2]! < minZ + 0.025) { sx += points[i]!; sy += points[i + 1]!; c++; }
      }
      if (c > 0) out.set(sx / c, sy / c, minZ);
      return c > 0;
    };
    tip(pts, this.muzzle);
    if (mount?.twin) {
      // A gun in each hand: a muzzle each side of the middle, fired turn about.
      const right: number[] = [], left: number[] = [];
      for (let i = 0; i < pts.length; i += 3) (pts[i]! > this.muzzle.x ? right : left).push(pts[i]!, pts[i + 1]!, pts[i + 2]!);
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      if (tip(right, a) && tip(left, b)) this.muzzles = [a, b];
    }
    const grip = [...joints.values()].find((j) => /^(R_wrist|hand_r|DEF-handR|r_wrist)_\d/.test(j.name)) ?? [...joints.values()].find((j) => /^R_wrist/.test(j.name));
    if (grip) this.root.worldToLocal(grip.getWorldPosition(this.pivot));
    // (a gun in each hand is turned about the middle of the pair)
    const other = this.muzzles && [...joints.values()].find((j) => /^L_wrist/.test(j.name));
    if (other) this.pivot.add(this.root.worldToLocal(other.getWorldPosition(new THREE.Vector3()))).multiplyScalar(0.5);
    this.bare.copy(this.muzzle);
    if (!tip(canPts, this.capped)) this.capped.copy(this.bare);
    this.fit(0, !!suppressor?.fitted);
    // The ejection port: on the bolt or slide if the gun has one, else above the magazine.
    if (!action.isEmpty()) {
      this.port.set(action.max.x + 0.004, (action.min.y + action.max.y) / 2 + 0.004, action.min.z + (action.max.z - action.min.z) * 0.6);
    } else if (!well.isEmpty()) {
      this.port.set(Math.max(well.max.x, this.muzzle.x) + 0.012, this.muzzle.y, (well.min.z + well.max.z) / 2);
    } else {
      this.port.set(this.muzzle.x + 0.018, this.muzzle.y, this.muzzle.z * 0.5);
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
    for (let i = 0; i < this.driven.length; i++) {
      this.driven[i]!.position.copy(this.aimP[i]!);
      this.driven[i]!.quaternion.copy(this.aimQ[i]!);
    }
    if (arm && !this.armDriven) arm.position.copy(this.leftArmRest);
    this.mixer.setTime(Math.min(this.length - 1e-4, t));
    for (let i = 0; i < this.driven.length; i++) {
      this.aimP[i]!.copy(this.driven[i]!.position);
      this.aimQ[i]!.copy(this.driven[i]!.quaternion);
    }
    const turn = this.info.fireTurn;
    if (clip === 'fire' && turn !== undefined && this.restP.length === this.driven.length) {
      for (let i = 0; i < this.driven.length; i++) {
        const node = this.driven[i]!;
        node.position.lerpVectors(this.restP[i]!, node.position, turn);
        _fq.copy(node.quaternion);
        node.quaternion.copy(this.restQ[i]!).slerp(_fq, turn);
      }
    }
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
  /** Pose our arms after the pack's skeleton, where it came without any. Call once the frame's matrices are current. */
  follow(): void {
    this.worn?.follow();
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
  /**
   * The suppressor: on or off, or `k` (0..1) of the way through being fitted (`quiet` false) or
   * taken off (`quiet` true) by the left hand. Call after posing.
   */
  fit(k: number, quiet: boolean): void {
    this.quiet = quiet && k <= 0;
    this.muzzle.copy(this.muzzles ? this.muzzles[this.side]! : this.quiet ? this.capped : this.bare);
    if (this.cans.length === 0) return;
    const step = THREE.MathUtils.smoothstep;
    // How far it is drawn off along the barrel (1 = clear of the muzzle), where the hand is, and whether it is to be seen.
    let off = 0, reach = 0, away = 0, shown = quiet;
    if (k > 0 && quiet) {
      // Taking it off: the hand goes to it, unscrews it, takes it down out of view and comes back.
      reach = step(k, 0.03, 0.24) * (1 - step(k, 0.62, 0.76));
      off = step(k, 0.27, 0.62);
      away = step(k, 0.62, 0.76) * (1 - step(k, 0.82, 0.97));
      shown = k < 0.64;
    } else if (k > 0) {
      // Fitting it: the hand goes down for it, brings it to the muzzle, screws it on and comes back.
      away = step(k, 0.0, 0.13) * (1 - step(k, 0.17, 0.33));
      reach = step(k, 0.17, 0.33) * (1 - step(k, 0.76, 0.97));
      off = 1 - step(k, 0.35, 0.72);
      shown = k > 0.29;
    }
    const c = this.canAt;
    _swing.makeTranslation(c.x + off * this.canOut, c.y, c.z)
      .multiply(_turn.makeRotationX(off * Math.PI * 5))
      .multiply(_back.makeTranslation(-c.x, -c.y, -c.z));
    for (const { holder, on } of this.cans) {
      holder.visible = shown;
      holder.matrix.copy(on).multiply(_swing);
    }
    if (this.leftArm) {
      this.leftArm.position
        .addScaledVector(this.canShift, reach)
        .addScaledVector(this.canDraw, reach * off)
        .addScaledVector(this.canAway, away);
    }
  }
  /** A shot has left: with a gun in each hand, the next comes from the other. */
  fired(): void {
    if (this.muzzles) this.side ^= 1;
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
   * Stand `k` of the way through a reload (`empty`: begun with nothing in the gun). Sets how far
   * through each hand-worked part it is; returns how far through the pack's own bolt stroke
   * (0 while it is not in one).
   */
  poseReload(k: number, empty: boolean): number {
    this.reloadPump = this.reloadRack = this.reloadLoad = this.reloadBreech = 0;
    const step = THREE.MathUtils.smoothstep;
    switch (this.style) {
      case 'pump':
        // Fed shell by shell, then pumped once.
        this.pose('idle', 0);
        if (k < PUMP_LOADING) this.reloadLoad = Math.max(1e-4, k / PUMP_LOADING);
        else this.reloadPump = Math.min(1, Math.max(0, (k - PUMP_LOADING - 0.04) / 0.14));
        return 0;
      case 'break':
        // Both hands stay on the gun as it is broken open; the left then changes the shells.
        this.pose('idle', 0);
        this.swing(step(k, 0.1, 0.2) * (1 - step(k, 0.8, 0.87)));
        this.reloadBreech = k;
        return 0;
      case 'rifle':
        if (!this.handRack) { this.pose('reload', k); return 0; }
        // The pack's magazine change at about the speed it was drawn, then the left hand works the action.
        if (k < RIFLE_CLIP_ENDS) this.pose('reload', k / RIFLE_CLIP_ENDS);
        else this.pose('idle', 0);
        this.reloadRack = Math.min(1, Math.max(0, (k - RIFLE_RACK[0]) / (RIFLE_RACK[1] - RIFLE_RACK[0])));
        return 0;
      case 'bolt': {
        if (!this.rack) { this.pose('reload', k); return 0; }
        // The pack's own rifle: its magazine change, then its bolt stroke, each at the speed it was drawn.
        const a = this.seconds('reload'), b = this.seconds('bolt');
        const split = a / (a + b);
        if (k < split) { this.pose('reload', k / split); return 0; }
        const through = (k - split) / (1 - split);
        this.pose('bolt', through);
        return through;
      }
      default: {
        const clip = empty && this.has('reloadEmpty') ? 'reloadEmpty' : 'reload';
        if (this.style !== 'own' || !this.rack) { this.pose(clip, k); return 0; }
        // Its magazine change, then the pack's own working of the action, each at the speed it was drawn.
        const a = this.seconds(clip), b = this.seconds('bolt');
        const split = a / (a + b);
        if (k < split) { this.pose(clip, k / split); return 0; }
        const through = (k - split) / (1 - split);
        this.pose('bolt', through);
        return through;
      }
    }
  }
  /** The movement the gun is carried through while it is reloaded. */
  reloadMove(empty: boolean): Move {
    switch (this.style) {
      case 'pump': return PUMP_RELOAD;
      case 'break': return BREAK_RELOAD;
      case 'rifle': return this.rackPull > 0 ? RIFLE_RELOAD : RIFLE_RELOAD_TAP;
      case 'own': return this.heard.get(empty && this.has('reloadEmpty') ? 'reloadEmpty' : 'reload') ?? PISTOL_RELOAD;
      case 'bolt': return BOLT_RELOAD;
      default: return empty && this.has('reloadEmpty') ? PISTOL_RELOAD_EMPTY : PISTOL_RELOAD;
    }
  }
  /** The movement it is brought up with (null: the pack's own clip is used). */
  get drawMove(): Move | null {
    if (this.has('draw') && (this.style === 'own' || this.style === 'blade')) return null;
    return this.style === 'pistol' ? DRAW_PISTOL : this.style === 'bolt' ? DRAW_HEAVY : DRAW_RIFLE;
  }
  /** The movement it is looked over with (null: the pack's own clip is used). */
  get inspectMove(): Move | null {
    if ((this.style === 'bolt' || this.style === 'own') && this.has('inspect')) return null;
    if (this.muzzles) return INSPECT_PAIR;
    return this.style === 'blade' ? INSPECT_KNIFE : this.style === 'pistol' ? INSPECT_PISTOL : INSPECT_RIFLE;
  }
  /**
   * The left hand's part in a reload, and how far it has let go of the gun altogether (`off`).
   * Call after posing, and after `cycle`.
   */
  hands(off: number): void {
    const arm = this.leftArm;
    const step = THREE.MathUtils.smoothstep;
    if (this.round) this.round.visible = false;
    if (!arm) return;
    if (off > 0) arm.position.addScaledVector(this.awayShift, off);

    // ---- working the action ----
    const k = this.reloadRack;
    if (this.handRack && k > 0 && k < 1) {
      const drawn = this.rackPull > 0;
      // (a release that is only tapped: in quickly and straight off again)
      const at = drawn ? step(k, 0, 0.3) * (1 - step(k, 0.7, 1)) : step(k, 0.1, 0.46) * (1 - step(k, 0.54, 0.85));
      const pull = drawn ? step(k, 0.33, 0.5) * (1 - step(k, 0.565, 0.61)) : 0;
      arm.position.addScaledVector(this.rackShift, at).addScaledVector(this.rackDraw, at * pull);
      if (pull > 0) {
        _swing.makeTranslation(-this.rackPull * pull, 0, 0);
        for (const { holder, closed } of this.bolts) holder.matrix.copy(closed).multiply(_swing);
      }
    }

    // ---- feeding a tube magazine ----
    const u = this.reloadLoad;
    if (this.round && u > 0 && u < 1) {
      // Each shell: up from the pouch to the port, pushed home, and down for the next.
      const ph = (u * PUMP_SHELLS) % 1;
      const up = step(ph, 0.04, 0.44), push = step(ph, 0.5, 0.68), down = step(ph, 0.74, 1);
      const port = up * (1 - down);
      const busy = step(u, 0, 0.05) * (1 - step(u, 0.95, 1));
      arm.position
        .addScaledVector(this.loadShift, port * busy)
        .addScaledVector(this.fetchShift, (1 - port) * busy)
        .addScaledVector(this.pushShift, push * (1 - down) * busy);
      // (seen from the moment the hand has it at the port until it is home)
      this.round.visible = up > 0.8 && push < 0.97;
      this.round.position.set(this.loadAt.x + 0.045 * push, this.loadAt.y - 0.1 * (1 - up), this.loadAt.z);
    }

    // ---- at an open breech ----
    const b = this.reloadBreech;
    if (b > 0 && b < 1 && this.hinge) {
      // To the breech as it opens, a dip for the second shell, and back as it shuts.
      const at = step(b, 0.24, 0.36) * (1 - step(b, 0.66, 0.78));
      const dip = step(b, 0.44, 0.5) * (1 - step(b, 0.52, 0.58));
      arm.position.addScaledVector(this.breechShift, at * (1 - 0.5 * dip)).addScaledVector(this.awayShift, at * dip * 0.35);
    }
  }
}

/** A shotgun shell, lying along the barrel. */
const ROUND_GEO = new THREE.CylinderGeometry(0.0095, 0.0095, 0.058, 10).rotateZ(Math.PI / 2);
const ROUND_MAT = new THREE.MeshStandardMaterial({ color: 0x8a2a22, roughness: 0.55, metalness: 0.1 });

export interface ViewState {
  def: WeaponDef;
  team: number;
  /** Look delta this frame (radians) for sway. */
  lookDX: number;
  lookDY: number;
  speed: number;
  /** Velocity across the view (to the right) and along it (ahead), m/s. */
  strafe: number;
  ahead: number;
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
  /** A suppressor is on the muzzle, and how far through fitting it or taking it off (0 = neither). */
  quiet: boolean;
  fitT: number;
  grappling: boolean;
  mantling: boolean;
  /** A grenade in hand: where it is in a throw. */
  nade?: NadeViewState;
  /** The light where the player stands (directions in eye space: x right, y up, -z ahead). */
  light?: ViewLight;
}

export interface ViewLight {
  /** Towards the sun, and how much of it reaches the hands (0 in shadow .. 1). */
  sunDir: THREE.Vector3;
  sun: number;
  /** How open the sky is overhead (0 under a roof .. 1). */
  sky: number;
  /** The coloured light of nearby strips (linear, as baked) and where it mostly comes from. */
  spill: THREE.Color;
  spillDir: THREE.Vector3;
}

const SHELLS = 8;
/** Spent cases by kind of gun: width and length, metres. */
const CASES: Record<string, [number, number]> = {
  pistol: [0.0085, 0.017], smg: [0.0085, 0.017], rifle: [0.0092, 0.036], sniper: [0.012, 0.056], shotgun: [0.018, 0.056],
};
const FLASH_SECONDS = 0.045;
/**
 * How the gun is held while its suppressor is worked: turned across the body so it is seen side on,
 * the muzzle at the left hand. Moved right, up and back (metres); pitched up, turned left and canted (radians).
 */
const FIT_POSE: [number, number, number, number, number, number] = [0.36, -0.03, -0.14, 0.1, 1.0, 0.25];
/** The flash's light on the gun and hands at its brightest. */
const FLASH_LIGHT = 0.7;
/** How far a bolt or slide is thrown back by a shot (metres). */
const BOLT_TRAVEL = 0.04;
/** How long one stroke of a pump takes. */
const PUMP_SECONDS = 0.42;
/** A wrist moving faster than this (metres a second) is a cut in the animation, not a movement. */
const CUT_SPEED = 7;
/** How much of the spray's push the gun itself shows (the camera shows the rest: see VIEW_PUNCH in game.ts). */
const GUN_FOLLOWS = 0.4;
/** The moon on the hands when nothing shadows them. */
const SUN_ON_HANDS = 1.6;
/** Light-strip spill (as baked) to light on the hands, and the most it may be. */
const SPILL_GAIN = 6;
const SPILL_MAX = 1.4;
const _spill = new THREE.Color();

export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
  /** Carries the spring motion; the active rig hangs under it. */
  private holder = new THREE.Group();
  private rigs = new Map<string, Rig>();
  private nades = new Map<string, NadeRig>();
  private current: Rig | null = null;
  private currentId = '';
  private flash: THREE.Mesh;
  private flashKinds: THREE.MeshBasicMaterial[] = [];
  private flashLight: THREE.PointLight;
  private flashT = 0;
  private flashGain = 1;
  private shells: { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3; life: number }[] = [];
  private shellI = 0;
  private brass: THREE.MeshStandardMaterial;
  private hull: THREE.MeshStandardMaterial;

  private swayX = new Spring(140, 18);
  private swayY = new Spring(140, 18);
  // (stiff: each shot is its own jolt, over before the next, not a slow lean)
  private kickZ = new Spring(1400, 52);
  private kickPitch = new Spring(1200, 48);
  private kickRoll = new Spring(1000, 44);
  private landY = new Spring(120, 13);
  // (soft: the body's weight, felt as the gun leaning into a strafe and lagging a change of pace)
  private leanS = new Spring(55, 11);
  private surgeS = new Spring(45, 9);
  private bobPhase = 0;
  private bobAmt = 0;
  /** The part of the recoil the camera does not show, which the gun shows instead. */
  private clearing = 0;
  private fitShown = 0;
  /** Where the movement in progress (a reload, an inspection) carries the gun, eased. */
  private carry = [0, 0, 0, 0, 0, 0, 0];
  private carryTo = [0, 0, 0, 0, 0, 0, 0];
  private move: Move | null = null;
  private moveK = 0;
  private wasReloading = false;
  private workedK = 0;
  /** The reload in progress was begun with the gun empty. */
  private reloadEmpty = false;
  /** Called at each moment of a movement that is heard (a magazine seating, a bolt let go). */
  onFoley: ((sound: Foley, def: WeaponDef) => void) | null = null;
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
  private caseKind: WeaponDef['kind'] = 'rifle';
  private meleeT = -1;
  private meleeClip = 'cutA';
  private meleeI = 0;
  private inspectT = -1;

  /** Muzzle position in viewmodel-camera space (for tracers). */
  readonly muzzleWorld = new THREE.Vector3();
  /** What the guns' skins react to. */
  private live: SkinLive = { heat: { value: 0 }, ammo: { value: 1 } };

  /**
   * Lit by the place the player stands in, as the level is: sky light from above (less under a
   * roof), the moon from where it really is in the sky and only when it is not shadowed, and the
   * colour of the nearest light strips from their side. A soft key over the left shoulder and a
   * dim warm kick from the right keep the shapes readable in the darkest corner.
   */
  private hemi = new THREE.HemisphereLight(0xa9c1ee, 0x1c2028, 1.0);
  private key = new THREE.DirectionalLight(0xdbe7ff, 0.75);
  private kick = new THREE.DirectionalLight(0xffc9a0, 0.3);
  private sunLight = new THREE.DirectionalLight(0xcfe0ff, 0);
  private spillLight = new THREE.DirectionalLight(0xffffff, 0);
  /** The light as last eased towards: sun, sky, spill strength. */
  private lit = { sun: 0.6, sky: 0.6, spill: 0, ready: false };
  private spillCol = new THREE.Color();

  constructor() {
    this.key.position.set(-0.6, 1, 0.5);
    this.kick.position.set(1, 0.2, 0.4);
    this.sunLight.position.set(-0.4, 0.7, -0.5);
    this.spillLight.position.set(0.5, 0.5, -0.5);
    this.scene.add(this.hemi, this.key, this.kick, this.sunLight, this.spillLight);
    this.scene.add(this.holder);

    for (let i = 0; i < FLASH_KINDS; i++) {
      this.flashKinds.push(new THREE.MeshBasicMaterial({
        map: flashTexture(i + 11), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, toneMapped: false, side: THREE.DoubleSide,
      }));
    }
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), this.flashKinds[0]);
    this.flash.visible = false;
    this.flash.renderOrder = 10;
    this.scene.add(this.flash);
    // (linear falloff, and held out in front of the muzzle: right at it, an inverse-square light
    // burns white patches into whatever part of the gun is nearest)
    this.flashLight = new THREE.PointLight(0xffc070, 0, 2.5, 1);
    this.scene.add(this.flashLight);

    // Spent cases: the cylinder lies along z, the way a case leaves the port.
    const shellGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 10).rotateX(Math.PI / 2);
    this.brass = new THREE.MeshStandardMaterial({ color: 0x7d6a3c, roughness: 0.5, metalness: 0.55, envMapIntensity: 0.4 });
    this.hull = new THREE.MeshStandardMaterial({ color: 0x7a2620, roughness: 0.6, metalness: 0.1, envMapIntensity: 0.3 });
    for (let i = 0; i < SHELLS; i++) {
      const mesh = new THREE.Mesh(shellGeo, this.brass);
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
    r = new Rig(files, PACKS[look.pack]!, look, def.team, SKINS[def.id], this.live, def.suppressor);
    r.root.visible = false;
    this.holder.add(r.root);
    this.rigs.set(def.id, r);
    return r;
  }

  /** A grenade's hands, made once its files are in. */
  private nadeRig(def: WeaponDef, team: number): NadeRig | null {
    let n = this.nades.get(def.id);
    if (n) return n;
    const files = getWeapon(def.id);
    if (!files) {
      void loadWeapon(def.id);
      return null;
    }
    n = new NadeRig(def.id, files, (arms, nade, borrowed) => {
      const src = borrowed ?? arms[0]?.material as THREE.Material | undefined;
      if (src) {
        const finished = finishFor(src, team, arms);
        for (const m of arms) m.material = finished;
      }
      for (const m of nade) m.material = nadeMaterial(m.material as THREE.Material, def.id);
    });
    n.root.visible = false;
    this.holder.add(n.root);
    this.nades.set(def.id, n);
    return n;
  }

  onShot(def: WeaponDef, quiet = false): void {
    const k = def.kick;
    this.kickZ.kick(5.2 * k);
    this.kickPitch.kick(5.8 * k);
    this.kickRoll.kick((Math.random() - 0.5) * 11 * k);
    // (every round shoves the gun a little off its line, never the same way twice)
    this.swayX.kick((Math.random() - 0.5) * 0.24 * k);
    this.swayY.kick((Math.random() - 0.5) * 0.2 * k);
    const r = this.current;
    this.flashT = FLASH_SECONDS;
    this.flashGain = quiet ? 0.3 : 1;
    this.flash.material = this.flashKinds[(Math.random() * FLASH_KINDS) | 0]!;
    this.flash.rotation.z = Math.random() * Math.PI * 2;
    // (kept small: a flash that fills the view hides the target the next round is meant for)
    const s = (0.3 + Math.min(2.6, k) * 0.15 + Math.random() * 0.12) * (quiet ? 0.45 : 1);
    this.flash.scale.set(s, s, s);
    this.inspectT = -1;
    this.fireT = 0;
    this.shotT = 0;
    this.workedK = 0;
    r?.fired();
    // Each shot heats the gun; slow, heavy guns more per shot.
    this.live.heat.value = Math.min(1, this.live.heat.value + 0.07 + 0.12 * k);
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
    this.caseKind = def.kind;
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

  /** The action being worked after a shot: heard as it comes back (`open`) and as it goes home. */
  private worked(k: number, back: number, home: number, open: Foley, def: WeaponDef): void {
    if (k < this.workedK) this.workedK = 0;
    if (this.workedK < back && k >= back) this.onFoley?.(open, def);
    if (this.workedK < home && k >= home) this.onFoley?.('boltfwd', def);
    this.workedK = k;
  }

  private ejectShell(): void {
    const r = this.current;
    if (!r) return;
    const s = this.shells[this.shellI++ % SHELLS]!;
    const [wide, long] = CASES[this.caseKind] ?? CASES['rifle']!;
    s.mesh.material = this.caseKind === 'shotgun' ? this.hull : this.brass;
    s.mesh.scale.set(wide, wide, long);
    s.mesh.visible = true;
    s.life = 0.7;
    s.mesh.position.copy(r.port);
    this.holder.localToWorld(s.mesh.position);
    s.mesh.rotation.set((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, 0);
    // Out to the right, up a little and back, tumbling end over end.
    s.vel.set(2.3 + Math.random() * 0.9, 1.1 + Math.random() * 0.6, 0.3 + Math.random() * 0.5);
    s.spin.set(14 + Math.random() * 16, 6 + Math.random() * 10, (Math.random() - 0.5) * 8);
  }

  /** Light the hands by the place the player stands in, easing between places so a doorway does not pop. */
  private relight(dt: number, l: ViewLight | undefined): void {
    if (!l) return;
    const k = this.lit.ready ? 1 - Math.exp(-dt * 6) : 1;
    this.lit.ready = true;
    this.lit.sun += (l.sun - this.lit.sun) * k;
    this.lit.sky += (l.sky - this.lit.sky) * k;
    const top = Math.max(l.spill.r, l.spill.g, l.spill.b);
    const strength = Math.min(SPILL_MAX, (0.2126 * l.spill.r + 0.7152 * l.spill.g + 0.0722 * l.spill.b) * SPILL_GAIN);
    this.lit.spill += (strength - this.lit.spill) * k;
    if (top > 1e-4) this.spillCol.lerp(_spill.copy(l.spill).multiplyScalar(1 / top), k);
    this.hemi.intensity = 0.42 + 0.6 * this.lit.sky;
    // (what metal and paint reflect: a generic lit room, so kept low, and lower under a roof)
    this.scene.environmentIntensity = 0.26 + 0.16 * this.lit.sky;
    // (the directions turn with the view at once: they are fixed in the world, not eased)
    this.sunLight.position.copy(l.sunDir);
    this.sunLight.intensity = SUN_ON_HANDS * this.lit.sun;
    this.spillLight.position.copy(l.spillDir);
    this.spillLight.color.copy(this.spillCol);
    this.spillLight.intensity = this.lit.spill;
  }

  update(dt: number, st: ViewState): void {
    FINISH_TIME.value += dt;
    this.relight(dt, st.light);
    this.live.heat.value *= Math.exp(-dt * 1.9);
    this.live.ammo.value += (st.ammo - this.live.ammo.value) * Math.min(1, dt * 12);
    const dye = ARMS_TINT[st.team] ?? [0.86, 0.88, 0.92];
    ARMS_DYE.set(dye[0], dye[1], dye[2]);
    const nade = st.def.kind === 'grenade' ? this.nadeRig(st.def, st.team) : null;
    for (const [id, n] of this.nades) n.root.visible = n === nade && id === st.def.id && !st.scoped;
    const r = st.def.kind === 'grenade' ? null : this.rig(st.def);
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
    /** How far through working the action at the end of a reload (0 = not). */
    let racking = 0;
    /** The movement the gun is being carried through, and how far through it. */
    let move: Move | null = null, moveK = 0;
    /** How far through a stroke of the pump (0 = not). */
    let pumping = 0;
    /** How far through fitting or taking off the suppressor (0 = not). */
    const fitting = st.drawT > 0 ? 0 : st.fitT;
    if (r) {
      this.idleT += dt;
      const reloading = st.reloadT > 0;
      if (reloading && !this.wasReloading) this.reloadEmpty = st.ammo <= 0;
      this.wasReloading = reloading;
      if (reloading || st.drawT > 0 || fitting > 0) this.inspectT = -1;
      if (fitting > 0) this.fireT = this.meleeT = -1;
      if (st.drawT > 0) {
        const up = r.drawMove;
        if (up) { r.pose('idle', 0); move = up; moveK = 1 - st.drawT; }
        else r.pose('draw', 1 - st.drawT);
        this.fireT = this.meleeT = -1;
      } else if (reloading) {
        racking = r.poseReload(st.reloadT, this.reloadEmpty);
        pumping = r.reloadPump;
        move = r.reloadMove(this.reloadEmpty);
        moveK = st.reloadT;
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
          this.worked(through, 0.3, 0.68, 'boltback', st.def);
          if (this.caseIn && through > 0.42) { this.caseIn = false; this.ejectShell(); }
        } else if (this.pumpDur > 0 && this.fireT < this.fireDur + this.pumpDur) {
          r.pose('idle', 0);
          pumping = (this.fireT - this.fireDur) / this.pumpDur;
          this.worked(pumping, 0.18, 0.6, 'pump', st.def);
          if (this.caseIn && pumping > 0.36) { this.caseIn = false; this.ejectShell(); }
        } else this.fireT = -1;
      }
      if (st.drawT <= 0 && !reloading && this.meleeT < 0 && this.fireT < 0) {
        if (this.inspectT >= 0) {
          const look = r.inspectMove;
          // (a pack's own inspection at the pace it was drawn: squeezed, the hands stop looking like hands)
          this.inspectT += dt / (look?.seconds ?? r.seconds('inspect'));
          if (this.inspectT >= 1) this.inspectT = -1;
          else if (look) { r.pose('idle', 0); move = look; moveK = this.inspectT; }
          else r.pose('inspect', this.inspectT);
        }
        // The packs' own idle loops rock visibly; hold the rest pose and breathe procedurally.
        if (this.inspectT < 0) r.pose('idle', 0);
      }
    }

    // ---- the movement the gun is carried through, and what is heard and felt in it ----
    const begun = move !== this.move;
    if (begun || moveK < this.moveK) { this.move = move; this.moveK = 0; }
    if (move) {
      carryAt(move, moveK, this.carryTo);
      // (a movement that does not begin at rest, a draw, is begun where it begins)
      if (begun) for (let i = 0; i < 7; i++) this.carry[i] = this.carryTo[i]!;
      for (const [at, sound, jolt] of move.cues) {
        if (at <= this.moveK || at > moveK) continue;
        this.onFoley?.(sound, st.def);
        if (jolt > 0) { this.kickPitch.kick(jolt * 2.4); this.landY.kick(-jolt * 0.45); this.kickRoll.kick((Math.random() - 0.5) * jolt * 3); }
      }
      this.moveK = moveK;
    } else this.carryTo.fill(0);
    const ease = Math.min(1, dt * 24);
    for (let i = 0; i < 7; i++) this.carry[i]! += (this.carryTo[i]! - this.carry[i]!) * ease;
    const c = this.carry;
    // The gun is turned about the hand that holds it, not about the eye: the turn's own shift is taken out.
    _carried.set(0, 0, 0);
    if (r && (c[3] !== 0 || c[4] !== 0 || c[5] !== 0)) {
      _fq.setFromEuler(_turned.set(c[3]!, c[4]!, c[5]!, 'YXZ'));
      _carried.copy(r.pivot).sub(_v.copy(r.pivot).applyQuaternion(_fq));
    }

    r?.pump(pumping);
    r?.fit(fitting, st.quiet);
    r?.cycle(this.shotT >= 0 ? this.shotT / 0.085 : 0);
    r?.hands(c[6]!);
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
    // Sustained fire presses the gun back into the shoulder and down a little.
    const press = st.def.auto ? this.live.heat.value : 0;

    // Moving: the gun leans into a strafe and drifts against it, and sits back a little while
    // running forward; the springs overshoot, so starting and stopping are felt.
    const lean = this.leanS.step(THREE.MathUtils.clamp(st.strafe / Math.max(1, st.maxSpeed), -1, 1), dt);
    const surge = this.surgeS.step(THREE.MathUtils.clamp(st.ahead / Math.max(1, st.maxSpeed), -1, 1), dt);
    const breath = Math.sin(this.idleT * 1.5) * 0.0012 * (1 - this.bobAmt);
    // While the action is worked the hand comes back past the eye: ease the gun away and down
    // for that moment, so a glove does not fill the corner of the view.
    const clear = racking > 0 ? Math.sin(Math.PI * Math.min(1, racking * 1.15)) : 0;
    this.clearing += (clear - this.clearing) * Math.min(1, dt * 14);
    // The suppressor is worked with the gun drawn in and turned across the body, muzzle to the left hand.
    const across = fitting > 0 ? THREE.MathUtils.smoothstep(fitting, 0, 0.2) * (1 - THREE.MathUtils.smoothstep(fitting, 0.8, 1)) : 0;
    this.fitShown += (across - this.fitShown) * Math.min(1, dt * 16);
    const fs = this.fitShown;
    const twist = fitting > 0.3 && fitting < 0.7 ? Math.sin(fitting * 70) * 0.012 : 0;
    const h = this.holder;
    h.position.set(
      sx * 0.3 + bobX - lean * 0.007 + fs * FIT_POSE[0] + c[0]! + _carried.x,
      sy * 0.3 + bobY + breath + land * 0.35 - air - press * 0.004 - this.clearing * 0.05 + st.crouch * 0.006 - Math.abs(surge) * 0.003 + fs * FIT_POSE[1] + c[1]! + _carried.y,
      kz * 0.3 + press * 0.012 - this.clearing * 0.17 + surge * 0.009 + fs * FIT_POSE[2] + c[2]! + _carried.z,
    );
    h.rotation.set(
      kp * 0.22 + this.climb + sy * 0.8 + air * 2 - surge * 0.012 + fs * FIT_POSE[3] + c[3]!,
      sx * 1.0 + this.drift + bobX * 1.5 + lean * 0.01 + fs * FIT_POSE[4] + c[4]!,
      kr * 0.16 - sx * 1.2 + st.crouch * 0.04 - lean * 0.045 + fs * FIT_POSE[5] + twist + c[5]!,
      'YXZ',
    );

    // ---- muzzle flash ------------------------------------------------------------------
    h.updateMatrixWorld(true);
    r?.follow();
    if (nade && st.nade) nade.update(dt, st.nade);
    if (r) this.muzzleWorld.copy(r.muzzle);
    else this.muzzleWorld.set(0.1, -0.1, -0.6);
    h.localToWorld(this.muzzleWorld);
    if (this.flashT > 0) {
      this.flashT -= dt;
      const left = Math.max(0, this.flashT / FLASH_SECONDS);
      this.flash.visible = !st.scoped && !!r;
      this.flash.position.copy(this.muzzleWorld);
      this.flash.position.z -= 0.03;
      (this.flash.material as THREE.MeshBasicMaterial).opacity = this.flashGain * (0.35 + 0.65 * left);
      this.flashLight.position.set(this.muzzleWorld.x + 0.03, this.muzzleWorld.y + 0.06, this.muzzleWorld.z - 0.22);
      this.flashLight.intensity = FLASH_LIGHT * this.flashGain * left;
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
      s.mesh.rotation.y += s.spin.y * dt;
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
