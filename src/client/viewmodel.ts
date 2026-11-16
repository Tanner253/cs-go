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
class Spring {
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

  /**
   * @param team the side the weapon belongs to (-1 = both), which tints its bare finish
   * @param skin the paint the gun wears, if any
   */
  constructor(files: WeaponFiles, readonly info: PackInfo, look: WeaponLook, team: number, skin: Skin | undefined, live: SkinLive) {
    this.skip = new Set(look.skip ?? []);
    const scene = SkeletonUtils.clone(files.pack.scene);
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

    /** Where each gun mesh sits on the gun (its own geometry to gun space) and what part it is. */
    const onGun = new Map<THREE.Mesh, { toGun: THREE.Matrix4; role: Role }>();

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
      const seat = new THREE.Matrix4().compose(move, new THREE.Quaternion(), new THREE.Vector3(size, size, size));
      const gunSpace = new THREE.Matrix4().fromArray(info.frame).invert().multiply(seat);
      const hang = (piece: THREE.Object3D, on: string): void => {
        const j = joints.get(on);
        if (!j) return;
        const h = new THREE.Group();
        h.matrixAutoUpdate = false;
        h.matrix.copy(placeOf(j)).invert().multiply(gunSpace);
        h.add(piece);
        j.add(h);
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
    const t = (r[0] + (r[1] - r[0]) * (k < 0 ? 0 : k > 1 ? 1 : k)) / this.info.fps;
    this.mixer.setTime(Math.min(this.length - 1e-4, t));
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
  scoped: boolean;
  grappling: boolean;
  mantling: boolean;
}

const SHELLS = 8;

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
  private kickZ = new Spring(260, 22);
  private kickPitch = new Spring(210, 18);
  private kickRoll = new Spring(180, 16);
  private landY = new Spring(120, 13);
  private bobPhase = 0;
  private bobAmt = 0;
  private wasGround = true;
  private idleT = 0;

  /** Seconds since the current one-shot animation started (<0 = none). */
  private fireT = -1;
  private fireDur = 0.2;
  private boltDur = 0;
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
    this.kickZ.kick(1.5 * k);
    this.kickPitch.kick(3.4 * k);
    this.kickRoll.kick((Math.random() - 0.5) * 5 * k);
    this.swayX.kick((Math.random() - 0.5) * 0.2 * k);
    this.flashT = 0.045;
    this.flash.rotation.z = Math.random() * Math.PI * 2;
    const s = 0.7 + Math.random() * 0.5 + k * 0.25;
    this.flash.scale.set(s, s, s);
    this.inspectT = -1;
    this.fireT = 0;
    // Each shot heats the gun; slow, heavy guns more per shot.
    this.live.heat.value = Math.min(1, this.live.heat.value + 0.07 + 0.12 * k);
    const r = this.current;
    const interval = 60 / def.rpm;
    if (r) {
      // Automatic fire restarts the clip every shot; slow guns play it in full, then cycle the bolt.
      this.fireDur = Math.min(r.seconds('fire') || 0.2, def.auto ? Math.max(0.09, interval * 1.6) : Math.max(0.12, interval * 0.95));
      this.boltDur = r.has('bolt') ? Math.max(0.3, interval - this.fireDur - 0.05) : 0;
    }
    if (def.kind !== 'shotgun' && def.kind !== 'sniper') this.ejectShell();
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
    }
    if (r) r.root.visible = !st.scoped;

    // ---- authored animation: pick the movement and how far through it ----------
    let procDraw = 0;
    let procInspect = 0;
    if (r) {
      this.idleT += dt;
      const reloading = st.reloadT > 0;
      if (reloading || st.drawT > 0) this.inspectT = -1;
      if (st.drawT > 0) {
        if (r.has('draw')) r.pose('draw', 1 - st.drawT);
        else { r.pose('idle', 0); procDraw = st.drawT; }
        this.fireT = this.meleeT = -1;
      } else if (reloading) {
        r.pose('reload', st.reloadT);
        this.fireT = -1;
      } else if (this.meleeT >= 0) {
        this.meleeT += dt / 0.4;
        if (this.meleeT >= 1) this.meleeT = -1;
        else r.pose(r.has(this.meleeClip) ? this.meleeClip : 'melee', this.meleeT);
      } else if (this.fireT >= 0) {
        this.fireT += dt;
        if (this.fireT < this.fireDur) r.pose('fire', this.fireT / this.fireDur);
        else if (this.boltDur > 0 && this.fireT < this.fireDur + this.boltDur) r.pose('bolt', (this.fireT - this.fireDur) / this.boltDur);
        else this.fireT = -1;
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
    const drawE = procDraw * procDraw;

    const breath = Math.sin(this.idleT * 1.5) * 0.0012 * (1 - this.bobAmt);
    const h = this.holder;
    h.position.set(
      sx * 0.3 + bobX + procInspect * -0.05,
      sy * 0.3 + bobY + breath + land * 0.35 - air - drawE * 0.3 + st.crouch * 0.006 + procInspect * 0.03,
      kz * 0.3,
    );
    h.rotation.set(
      kp * 0.22 + sy * 0.8 - drawE * 1.1 + air * 2 + procInspect * 0.25,
      sx * 1.0 + bobX * 1.5 + procInspect * 0.9,
      kr * 0.16 - sx * 1.2 + st.crouch * 0.04 + procInspect * 0.6,
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
