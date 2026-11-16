// First-person weapon rendering. Models are built from primitives and every motion is
// procedural: spring sway, movement bob, recoil, draw, reload, melee, landing dip.

import * as THREE from 'three';
import type { WeaponDef, WeaponKind } from '../sim/weapons';

/** Critically-damped-ish spring used for all viewmodel secondary motion. */
class Spring {
  x = 0;
  v = 0;
  constructor(private k: number, private c: number) {}
  step(target: number, dt: number): number {
    // Sub-step for stability at low frame rates.
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

interface GunModel {
  root: THREE.Group;
  mag: THREE.Object3D | null;
  slide: THREE.Object3D | null;
  muzzle: THREE.Vector3;
  leftHand: THREE.Object3D | null;
  /** Rest pose in camera space. */
  rest: THREE.Vector3;
}

const mats = {
  body: new THREE.MeshStandardMaterial({ color: 0x4a515c, roughness: 0.42, metalness: 0.75 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.55, metalness: 0.55 }),
  light: new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.35, metalness: 0.8 }),
  grip: new THREE.MeshStandardMaterial({ color: 0x3a3028, roughness: 0.9, metalness: 0.0 }),
  glowAtk: new THREE.MeshBasicMaterial({ color: 0xff7a2e, toneMapped: false }),
  glowDef: new THREE.MeshBasicMaterial({ color: 0x35e0ff, toneMapped: false }),
  sleeve: new THREE.MeshStandardMaterial({ color: 0x343a44, roughness: 0.85, metalness: 0.05 }),
  glove: new THREE.MeshStandardMaterial({ color: 0x6a707a, roughness: 0.7, metalness: 0.1 }),
  blade: new THREE.MeshStandardMaterial({ color: 0xd8e2ec, roughness: 0.2, metalness: 0.95 }),
};

const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);

function box(parent: THREE.Object3D, m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(boxGeo, m);
  mesh.scale.set(w, h, d);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}
/** Cylinder lying along Z. */
function barrel(parent: THREE.Object3D, m: THREE.Material, r: number, len: number, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(cylGeo, m);
  mesh.scale.set(r * 2, len, r * 2);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

function arm(parent: THREE.Object3D, fromX: number, fromY: number, fromZ: number, toX: number, toY: number, toZ: number): THREE.Group {
  const g = new THREE.Group();
  const from = new THREE.Vector3(fromX, fromY, fromZ), to = new THREE.Vector3(toX, toY, toZ);
  const len = from.distanceTo(to);
  const sleeve = new THREE.Mesh(boxGeo, mats.sleeve);
  sleeve.scale.set(0.062, 0.062, len * 0.78);
  sleeve.position.z = len * 0.39;
  const glove = new THREE.Mesh(boxGeo, mats.glove);
  glove.scale.set(0.056, 0.066, len * 0.26);
  glove.position.z = -len * 0.1;
  g.add(sleeve, glove);
  g.position.copy(to);
  g.lookAt(from); // +Z of the group points back toward the shoulder
  parent.add(g);
  return g;
}

function buildGun(kind: WeaponKind, id: string, team: number): GunModel {
  const root = new THREE.Group();
  const glow = team === 0 ? mats.glowAtk : mats.glowDef;
  let mag: THREE.Object3D | null = null;
  let slide: THREE.Object3D | null = null;
  let leftHand: THREE.Object3D | null = null;
  const muzzle = new THREE.Vector3(0, 0.03, -0.6);
  const rest = new THREE.Vector3(0.19, -0.19, -0.52);

  if (kind === 'knife') {
    box(root, mats.grip, 0.03, 0.035, 0.12, 0, 0, 0.02);
    box(root, mats.dark, 0.05, 0.05, 0.015, 0, 0, -0.045);
    const blade = box(root, mats.blade, 0.008, 0.045, 0.2, 0, 0.004, -0.15);
    blade.rotation.x = 0.04;
    box(root, glow, 0.01, 0.006, 0.19, 0, -0.02, -0.15);
    arm(root, 0.1, -0.16, 0.42, 0.0, -0.03, 0.03);
    rest.set(0.22, -0.2, -0.5);
    return { root, mag, slide, muzzle, leftHand, rest };
  }

  if (kind === 'pistol') {
    const big = id === 'maul';
    const len = big ? 0.24 : 0.2;
    box(root, mats.grip, 0.034, 0.11, 0.05, 0, -0.065, 0.03).rotation.x = -0.18;
    box(root, mats.body, 0.036, 0.03, len, 0, -0.005, -len / 2 + 0.06);
    slide = new THREE.Group();
    box(slide, big ? mats.light : mats.dark, 0.04, 0.036, len + 0.01, 0, 0.028, -len / 2 + 0.06);
    box(slide, mats.dark, 0.012, 0.012, 0.012, 0, 0.052, 0.045);
    box(slide, mats.dark, 0.006, 0.012, 0.008, 0, 0.052, -len + 0.07);
    root.add(slide);
    box(root, glow, 0.038, 0.006, len * 0.5, 0, 0.008, -len / 2 + 0.03);
    mag = box(root, mats.dark, 0.028, 0.1, 0.04, 0, -0.07, 0.032);
    (mag as THREE.Mesh).rotation.x = -0.18;
    muzzle.set(0, 0.028, -len + 0.05);
    arm(root, 0.12, -0.2, 0.45, 0.0, -0.07, 0.04);
    leftHand = arm(root, -0.3, -0.22, 0.4, -0.012, -0.085, 0.03);
    rest.set(0.17, -0.17, -0.58);
    return { root, mag, slide, muzzle, leftHand, rest };
  }

  // Long guns.
  const long = kind === 'sniper' ? 1.0 : kind === 'shotgun' ? 0.78 : kind === 'smg' ? 0.5 : 0.72;
  const front = -long + 0.22;
  // Receiver, stock, grip.
  box(root, mats.body, 0.05, 0.075, 0.3, 0, 0.0, -0.05);
  box(root, mats.dark, 0.042, 0.06, kind === 'smg' ? 0.14 : 0.24, 0, -0.005, 0.2);
  box(root, mats.dark, 0.046, 0.09, 0.03, 0, -0.01, kind === 'smg' ? 0.28 : 0.33);
  box(root, mats.grip, 0.036, 0.1, 0.045, 0, -0.08, 0.06).rotation.x = -0.25;
  // Handguard and barrel.
  const hgLen = kind === 'smg' ? 0.16 : 0.26;
  box(root, mats.light, 0.046, 0.058, hgLen, 0, 0.003, -0.2 - hgLen / 2);
  barrel(root, mats.dark, kind === 'shotgun' ? 0.017 : 0.011, -front - 0.2, 0, 0.012, (front - 0.2) / 2);
  if (kind !== 'shotgun') box(root, mats.dark, 0.03, 0.03, 0.05, 0, 0.012, front + 0.02);
  // Accent strip.
  box(root, glow, 0.052, 0.008, 0.26, 0, -0.022, -0.06);
  box(root, glow, 0.012, 0.005, hgLen * 0.6, 0, 0.034, -0.2 - hgLen / 2);
  // Sights.
  if (kind === 'sniper') {
    barrel(root, mats.dark, 0.03, 0.3, 0, 0.085, -0.07);
    barrel(root, mats.light, 0.036, 0.04, 0, 0.085, -0.23);
    barrel(root, mats.light, 0.034, 0.04, 0, 0.085, 0.09);
    box(root, mats.dark, 0.02, 0.03, 0.03, 0, 0.055, -0.14);
    box(root, mats.dark, 0.02, 0.03, 0.03, 0, 0.055, 0.02);
  } else {
    box(root, mats.dark, 0.012, 0.03, 0.02, 0, 0.05, 0.06);
    box(root, mats.dark, 0.008, 0.03, 0.012, 0, 0.05, -0.2 - hgLen + 0.02);
    box(root, mats.dark, 0.03, 0.012, 0.16, 0, 0.042, -0.05);
  }
  // Magazine / pump.
  if (kind === 'shotgun') {
    mag = box(root, mats.grip, 0.056, 0.05, 0.16, 0, -0.035, -0.36);
    slide = mag;
  } else {
    const mh = kind === 'smg' ? 0.16 : kind === 'sniper' ? 0.07 : 0.15;
    mag = box(root, mats.dark, 0.032, mh, 0.06, 0, -0.04 - mh / 2, -0.09);
    (mag as THREE.Mesh).rotation.x = kind === 'rifle' ? 0.22 : 0.05;
  }
  muzzle.set(0, 0.012, front - 0.01);
  arm(root, 0.11, -0.22, 0.5, 0.0, -0.085, 0.065);
  leftHand = arm(root, -0.32, -0.2, 0.32, -0.006, -0.04, -0.2 - hgLen / 2);
  if (kind === 'sniper') rest.set(0.18, -0.19, -0.46);
  if (kind === 'smg') rest.set(0.18, -0.185, -0.56);
  return { root, mag, slide, muzzle, leftHand, rest };
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
  // Star spikes.
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
  scoped: boolean;
  grappling: boolean;
  mantling: boolean;
}

const SHELLS = 8;

export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);
  private holder = new THREE.Group();
  private models = new Map<string, GunModel>();
  private current: GunModel | null = null;
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
  private meleeT = -1;
  private meleeSide = 1;
  private wasGround = true;
  private time = 0;
  private magRest = new THREE.Vector3();
  private slideRest = 0;
  /** World-space muzzle position of the last frame (for tracers). */
  readonly muzzleWorld = new THREE.Vector3();
  private tmp = new THREE.Vector3();

  constructor() {
    this.scene.add(new THREE.HemisphereLight(0xdfeaff, 0x3a3f4a, 1.5));
    const d = new THREE.DirectionalLight(0xfff2dd, 2.0);
    d.position.set(-0.5, 1, 0.6);
    this.scene.add(d);
    this.scene.add(this.holder);

    const fm = new THREE.MeshBasicMaterial({
      map: flashTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, toneMapped: false, side: THREE.DoubleSide,
    });
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), fm);
    this.flash.visible = false;
    this.flash.renderOrder = 10;
    this.scene.add(this.flash);
    this.flashLight = new THREE.PointLight(0xffc070, 0, 3);
    this.scene.add(this.flashLight);

    const shellMat = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.3, metalness: 0.9 });
    for (let i = 0; i < SHELLS; i++) {
      const mesh = new THREE.Mesh(cylGeo, shellMat);
      mesh.scale.set(0.012, 0.03, 0.012);
      mesh.visible = false;
      this.scene.add(mesh);
      this.shells.push({ mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0 });
    }
  }

  private model(def: WeaponDef, team: number): GunModel {
    const key = def.id + team;
    let m = this.models.get(key);
    if (!m) {
      m = buildGun(def.kind, def.id, team);
      m.root.visible = false;
      this.holder.add(m.root);
      this.models.set(key, m);
    }
    return m;
  }

  onShot(def: WeaponDef): void {
    const k = def.kick;
    this.kickZ.kick(2.2 * k);
    this.kickPitch.kick(5.5 * k);
    this.kickRoll.kick((Math.random() - 0.5) * 6 * k);
    this.swayX.kick((Math.random() - 0.5) * 0.25 * k);
    this.flashT = 0.045;
    this.flash.rotation.z = Math.random() * Math.PI * 2;
    const s = 0.7 + Math.random() * 0.5 + k * 0.25;
    this.flash.scale.set(s, s, s);
    if (def.kind !== 'shotgun' && def.kind !== 'sniper') this.ejectShell();
  }

  onMelee(): void {
    this.meleeT = 0;
    this.meleeSide = -this.meleeSide;
  }

  private ejectShell(): void {
    if (!this.current) return;
    const s = this.shells[this.shellI++ % SHELLS]!;
    s.mesh.visible = true;
    s.life = 0.6;
    this.current.root.localToWorld(s.mesh.position.set(0.03, 0.04, -0.02));
    s.vel.set(1.1 + Math.random() * 0.5, 1.2 + Math.random() * 0.5, 0.2 + Math.random() * 0.3);
    s.spin.set(Math.random() * 20, Math.random() * 20, Math.random() * 20);
  }

  update(dt: number, st: ViewState): void {
    this.time += dt;
    const m = this.model(st.def, st.team);
    const key = st.def.id + st.team;
    if (this.currentId !== key) {
      if (this.current) this.current.root.visible = false;
      this.current = m;
      this.currentId = key;
      if (m.mag) this.magRest.copy(m.mag.position);
      if (m.slide) this.slideRest = m.slide.position.z;
      this.meleeT = -1;
    }
    m.root.visible = !st.scoped;

    // ---- sway from mouse look --------------------------------------------------
    const sx = this.swayX.step(THREE.MathUtils.clamp(-st.lookDX * 1.6, -0.06, 0.06), dt);
    const sy = this.swayY.step(THREE.MathUtils.clamp(st.lookDY * 1.6, -0.05, 0.05), dt);

    // ---- movement bob ---------------------------------------------------------
    const moveF = st.onGround ? Math.min(1, st.speed / Math.max(1, st.maxSpeed)) : 0;
    this.bobAmt += (moveF - this.bobAmt) * Math.min(1, dt * 9);
    this.bobPhase += dt * (5.5 + st.speed * 1.35) * (moveF > 0.05 ? 1 : 0);
    const bobX = Math.sin(this.bobPhase) * 0.006 * this.bobAmt;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * 0.007 * this.bobAmt + 0.0035 * this.bobAmt;

    // ---- air / landing --------------------------------------------------------
    if (st.onGround && !this.wasGround) this.landY.kick(-Math.min(1.4, 0.25 + Math.abs(st.velY) * 0.08));
    this.wasGround = st.onGround;
    const air = st.onGround ? 0 : THREE.MathUtils.clamp(st.velY * 0.0035, -0.03, 0.03);
    const land = this.landY.step(0, dt);

    // ---- recoil ---------------------------------------------------------------
    const kz = this.kickZ.step(0, dt);
    const kp = this.kickPitch.step(0, dt);
    const kr = this.kickRoll.step(0, dt);

    // ---- draw -----------------------------------------------------------------
    const d = st.drawT;
    const drawE = d * d;

    // ---- reload ---------------------------------------------------------------
    let relTilt = 0, relDrop = 0, magOut = 0, rack = 0;
    const r = st.reloadT;
    if (r > 0) {
      const tiltIn = THREE.MathUtils.smoothstep(r, 0.0, 0.14);
      const tiltOut = 1 - THREE.MathUtils.smoothstep(r, 0.84, 1.0);
      relTilt = Math.min(tiltIn, tiltOut);
      relDrop = relTilt * 0.035;
      // Magazine leaves, a fresh one comes back, then a firm slap.
      const out = THREE.MathUtils.smoothstep(r, 0.14, 0.3);
      const back = THREE.MathUtils.smoothstep(r, 0.48, 0.66);
      magOut = out - back;
      rack = Math.max(0, 1 - Math.abs(r - 0.78) / 0.06);
      if (r > 0.655 && r < 0.68) this.kickPitch.kick(-0.6);
    }
    if (m.mag && st.def.kind !== 'shotgun') {
      m.mag.position.set(this.magRest.x - magOut * 0.03, this.magRest.y - magOut * 0.26, this.magRest.z + magOut * 0.04);
      m.mag.visible = magOut < 0.97;
      if (m.leftHand && r > 0) m.leftHand.position.y += 0; // hand stays; mag motion sells the action
    }
    if (m.slide) {
      const isPump = st.def.kind === 'shotgun';
      const back = isPump ? Math.max(rack, Math.min(1, Math.max(0, kz * 6))) * 0.07 : Math.max(rack * 0.04, Math.min(0.04, Math.max(0, kz) * 1.4));
      m.slide.position.z = this.slideRest + back;
    }

    // ---- melee swing ------------------------------------------------------------
    let swing = 0, stab = 0;
    if (this.meleeT >= 0) {
      this.meleeT += dt / 0.32;
      if (this.meleeT >= 1) this.meleeT = -1;
      else {
        const t = this.meleeT;
        swing = Math.sin(t * Math.PI) * this.meleeSide;
        stab = Math.sin(Math.min(1, t * 1.6) * Math.PI);
      }
    }

    // ---- compose ----------------------------------------------------------------
    const rest = m.rest;
    const tuck = st.mantling ? 1 : st.grappling ? 0.35 : 0;
    const root = m.root;
    root.position.set(
      rest.x + sx * 0.35 + bobX - swing * 0.16 - relTilt * 0.03,
      rest.y + sy * 0.35 + bobY + land * 0.4 - air - drawE * 0.26 - relDrop - tuck * 0.2 + st.crouch * 0.008,
      rest.z + kz * 0.35 - stab * 0.12 + tuck * 0.05,
    );
    root.rotation.set(
      kp * 0.28 + sy * 0.9 - drawE * 1.1 + relTilt * 0.34 - tuck * 0.9 + air * 2,
      sx * 1.1 + swing * 0.9 + relTilt * 0.22 + bobX * 1.5,
      kr * 0.2 - sx * 1.4 - relTilt * 0.5 + swing * 0.5 + st.crouch * 0.05,
      'YXZ',
    );

    // ---- muzzle flash -----------------------------------------------------------
    root.updateMatrixWorld(true);
    this.tmp.copy(m.muzzle);
    root.localToWorld(this.tmp);
    this.muzzleWorld.copy(this.tmp);
    if (this.flashT > 0) {
      this.flashT -= dt;
      this.flash.visible = !st.scoped;
      this.flash.position.copy(this.tmp);
      this.flash.position.z -= 0.03;
      this.flashLight.position.copy(this.tmp);
      this.flashLight.intensity = 2.5;
    } else {
      this.flash.visible = false;
      this.flashLight.intensity = 0;
    }

    // ---- shells -----------------------------------------------------------------
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
    this.camera.fov = aspect < 1 ? 75 : 58;
    this.camera.updateProjectionMatrix();
  }
}
