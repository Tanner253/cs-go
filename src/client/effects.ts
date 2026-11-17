// Pooled visual effects: tracers, muzzle flashes with real light on the level, impact sparks
// and dust, blood, bullet holes, the charge, and its detonation. Fixed pools; nothing here
// allocates after construction, and every effect type is a single draw call.

import * as THREE from 'three';

const MAX_TRACERS = 48;
const MAX_PARTICLES = 768;
const MAX_DECALS = 256;
const MAX_ROPES = 10;
const MAX_FLASHES = 8;
const FLASH_LIGHTS = 2;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _size = new THREE.Vector2();

/**
 * A muzzle flash seen end-on: a hot core with a few uneven tongues of burning gas, soft at the
 * edges. Each `seed` is a different burst, so repeated shots do not look stamped.
 */
export function flashTexture(seed = 1): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  g.globalCompositeOperation = 'lighter';
  let grad = g.createRadialGradient(64, 64, 0, 64, 64, 60);
  grad.addColorStop(0, 'rgba(255,186,104,0.42)');
  grad.addColorStop(0.5, 'rgba(255,128,48,0.13)');
  grad.addColorStop(1, 'rgba(255,90,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  g.filter = 'blur(1.6px)';
  const n = 4 + Math.floor(rnd() * 3);
  const a0 = rnd() * 6.283;
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * 6.283 + (rnd() - 0.5) * 0.7;
    const len = 26 + rnd() * 32, wid = 6 + rnd() * 8;
    g.save();
    g.translate(64, 64);
    g.rotate(a);
    const tongue = g.createLinearGradient(0, 0, len, 0);
    tongue.addColorStop(0, 'rgba(255,240,205,0.9)');
    tongue.addColorStop(0.45, 'rgba(255,188,98,0.55)');
    tongue.addColorStop(1, 'rgba(255,110,30,0)');
    g.fillStyle = tongue;
    g.beginPath();
    g.moveTo(0, -wid * 0.5);
    g.quadraticCurveTo(len * 0.45, -wid, len, 0);
    g.quadraticCurveTo(len * 0.45, wid, 0, wid * 0.5);
    g.closePath();
    g.fill();
    g.restore();
  }
  g.filter = 'none';
  grad = g.createRadialGradient(64, 64, 0, 64, 64, 19);
  grad.addColorStop(0, 'rgba(255,255,246,1)');
  grad.addColorStop(0.5, 'rgba(255,226,160,0.65)');
  grad.addColorStop(1, 'rgba(255,170,80,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(64, 64, 19, 0, 7);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** How many different bursts are drawn. */
export const FLASH_KINDS = 4;

function holeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  // Scorch halo, chipped rim, dark core.
  let grad = g.createRadialGradient(32, 32, 4, 32, 32, 31);
  grad.addColorStop(0, 'rgba(12,12,14,0.85)');
  grad.addColorStop(0.5, 'rgba(22,22,26,0.4)');
  grad.addColorStop(1, 'rgba(30,30,34,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  let seed = 3;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  g.strokeStyle = 'rgba(10,10,12,0.7)';
  g.lineWidth = 1.2;
  for (let i = 0; i < 7; i++) {
    const a = rnd() * 6.283, l = 9 + rnd() * 14;
    g.beginPath();
    g.moveTo(32 + Math.cos(a) * 5, 32 + Math.sin(a) * 5);
    g.lineTo(32 + Math.cos(a + (rnd() - 0.5) * 0.5) * l, 32 + Math.sin(a + (rnd() - 0.5) * 0.5) * l);
    g.stroke();
  }
  grad = g.createRadialGradient(32, 32, 0, 32, 32, 8);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.7, 'rgba(5,5,6,0.95)');
  grad.addColorStop(1, 'rgba(60,60,64,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(32, 32, 9, 0, 7);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Effects {
  readonly group = new THREE.Group();

  private tracers: { mesh: THREE.Mesh; life: number }[] = [];
  private tracerI = 0;

  // Particles: one draw call, premultiplied blending so sparks (additive) and dust (alpha) mix.
  private pPos = new Float32Array(MAX_PARTICLES * 3);
  private pCol = new Float32Array(MAX_PARTICLES * 3);
  private pMisc = new Float32Array(MAX_PARTICLES * 3); // size, alpha, additive
  private pVel = new Float32Array(MAX_PARTICLES * 3);
  private pLife = new Float32Array(MAX_PARTICLES);
  private pMax = new Float32Array(MAX_PARTICLES);
  private pGrav = new Float32Array(MAX_PARTICLES);
  private pSize0 = new Float32Array(MAX_PARTICLES);
  private pGrow = new Float32Array(MAX_PARTICLES);
  private pAlpha0 = new Float32Array(MAX_PARTICLES);
  private pDrag = new Float32Array(MAX_PARTICLES);
  private pI = 0;
  private points: THREE.Points;

  private decals: THREE.InstancedMesh;
  private decalI = 0;

  private flashes: { mesh: THREE.Mesh; life: number }[] = [];
  private flashI = 0;
  private lights: { light: THREE.PointLight; life: number; peak: number; dur: number }[] = [];
  private lightI = 0;

  private ropes: THREE.Mesh[] = [];
  private ropesUsed = 0;

  readonly charge = new THREE.Group();
  private chargeCore: THREE.MeshBasicMaterial;

  constructor() {
    const unit = new THREE.BoxGeometry(1, 1, 1);

    // ---- tracers: thin HDR streaks along the bullet path ----
    const tMat = new THREE.MeshBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    tMat.color.multiplyScalar(2.4);
    for (let i = 0; i < MAX_TRACERS; i++) {
      const mesh = new THREE.Mesh(unit, tMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }

    // ---- particles ----
    const pg = new THREE.BufferGeometry();
    this.pPos.fill(-9999);
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('misc', new THREE.BufferAttribute(this.pMisc, 3).setUsage(THREE.DynamicDrawUsage));
    const pm = new THREE.ShaderMaterial({
      uniforms: { scale: { value: 500 } },
      vertexShader: `
        attribute vec3 color; attribute vec3 misc; uniform float scale;
        varying vec3 vCol; varying vec2 vMisc;
        void main(){
          vCol = color; vMisc = misc.yz;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(misc.x * scale / max(0.05, -mv.z), 0.0, 220.0);
        }`,
      fragmentShader: `
        varying vec3 vCol; varying vec2 vMisc;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.12, d) * vMisc.x;
          if (a < 0.004) discard;
          // Premultiplied: additive particles write no alpha, so they add; others blend.
          gl_FragColor = vec4(vCol * a, a * (1.0 - vMisc.y));
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      toneMapped: false,
    });
    this.points = new THREE.Points(pg, pm);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.onBeforeRender = (renderer, _scene, camera) => {
      const rt = renderer.getRenderTarget();
      const h = rt ? rt.height : renderer.getDrawingBufferSize(_size).y;
      pm.uniforms['scale']!.value = h * 0.5 * (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5]!;
    };
    this.group.add(this.points);

    // ---- bullet holes: 6 mm proud of the surface plus polygon offset, never z-fight ----
    const dMat = new THREE.MeshBasicMaterial({ map: holeTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
    this.decals = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.2, 0.2), dMat, MAX_DECALS);
    this.decals.count = 0;
    this.decals.frustumCulled = false;
    this.decals.renderOrder = 3;
    this.group.add(this.decals);

    // ---- muzzle flashes (third person) and their light on the level ----
    const fMats: THREE.MeshBasicMaterial[] = [];
    for (let i = 0; i < FLASH_KINDS; i++) {
      const fMat = new THREE.MeshBasicMaterial({ map: flashTexture(i + 1), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
      fMat.color.multiplyScalar(2.2);
      fMats.push(fMat);
    }
    const fGeo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < MAX_FLASHES; i++) {
      const mesh = new THREE.Mesh(fGeo, fMats[i % FLASH_KINDS]!);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 6;
      mesh.onBeforeRender = (_r, _s2, camera) => {
        // Billboard, keeping the random roll stored in userData.
        mesh.quaternion.copy(camera.quaternion);
        mesh.rotateZ(mesh.userData['roll'] as number);
        mesh.updateMatrixWorld();
      };
      this.group.add(mesh);
      this.flashes.push({ mesh, life: 0 });
    }
    // A fixed number of lights keeps shader programs stable; idle ones sit at zero intensity.
    for (let i = 0; i < FLASH_LIGHTS; i++) {
      const light = new THREE.PointLight(0xffc27a, 0, 13, 2);
      this.group.add(light);
      this.lights.push({ light, life: 0, peak: 0, dur: 0.06 });
    }

    // ---- ropes (kept for API compatibility) ----
    const rMat = new THREE.MeshBasicMaterial({ color: 0x9ff3ff, fog: false });
    for (let i = 0; i < MAX_ROPES; i++) {
      const mesh = new THREE.Mesh(unit, rMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.ropes.push(mesh);
    }

    // ---- the charge ----
    const shell = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.45, metalness: 0.7 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.22), shell);
    body.position.y = 0.05;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.07, 12), shell);
    cap.position.y = 0.135;
    this.chargeCore = new THREE.MeshBasicMaterial({ color: 0xff3b2e, fog: false });
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.05, 12), this.chargeCore);
    core.position.y = 0.19;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.012, 0.03), this.chargeCore);
    strip.position.set(0, 0.106, 0.08);
    this.charge.add(body, cap, core, strip);
    this.charge.visible = false;
    this.group.add(this.charge);

  }

  /** Light the level for a moment (muzzle flash, explosion). */
  flashLight(x: number, y: number, z: number, intensity = 34, duration = 0.06, color = 0xffc27a): void {
    // Reuse a light that is already flashing at this spot (shotgun pellets, rapid fire).
    let slot = this.lights[0]!;
    let found = false;
    for (const l of this.lights) {
      if (l.life > 0 && l.light.position.distanceToSquared(_v.set(x, y, z)) < 0.6) { slot = l; found = true; break; }
    }
    if (!found) slot = this.lights[this.lightI++ % FLASH_LIGHTS]!;
    slot.light.position.set(x, y, z);
    slot.light.color.setHex(color);
    slot.peak = intensity;
    slot.dur = duration;
    slot.life = duration;
    slot.light.intensity = intensity;
  }

  /** A third-person muzzle flash sprite plus its light. (First person uses the viewmodel's own.) */
  muzzleFlash(x: number, y: number, z: number, scale = 1): void {
    const f = this.flashes[this.flashI++ % MAX_FLASHES]!;
    f.mesh.position.set(x, y, z);
    const s = (0.32 + Math.random() * 0.16) * scale;
    f.mesh.scale.set(s, s, s);
    f.mesh.userData['roll'] = Math.random() * Math.PI * 2;
    f.mesh.visible = true;
    f.life = 0.045;
    this.flashLight(x, y, z, 30 * scale);
  }

  tracer(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 2.5) return;
    const t = this.tracers[this.tracerI++ % MAX_TRACERS]!;
    // Only the leading part is drawn so it reads as a streak, not a laser.
    const seg = Math.min(len - 1.2, 16);
    const start = 1.2 + Math.random() * Math.min(4, len - 1.2 - seg + 0.001);
    const m = t.mesh;
    const k = (start + seg / 2) / len;
    m.position.set(ax + dx * k, ay + dy * k, az + dz * k);
    _v.set(dx / len, dy / len, dz / len);
    m.quaternion.setFromUnitVectors(_z, _v);
    m.scale.set(0.014, 0.014, seg);
    m.visible = true;
    t.life = 0.055;
  }

  private emit(
    x: number, y: number, z: number, vx: number, vy: number, vz: number,
    r: number, g: number, b: number, life: number, grav: number,
    size: number, grow: number, alpha: number, additive: number, drag: number,
  ): void {
    const i = this.pI++ % MAX_PARTICLES;
    const i3 = i * 3;
    this.pPos[i3] = x; this.pPos[i3 + 1] = y; this.pPos[i3 + 2] = z;
    this.pVel[i3] = vx; this.pVel[i3 + 1] = vy; this.pVel[i3 + 2] = vz;
    this.pCol[i3] = r; this.pCol[i3 + 1] = g; this.pCol[i3 + 2] = b;
    this.pMisc[i3] = size; this.pMisc[i3 + 1] = alpha; this.pMisc[i3 + 2] = additive;
    this.pLife[i] = life; this.pMax[i] = life;
    this.pGrav[i] = grav; this.pSize0[i] = size; this.pGrow[i] = grow; this.pAlpha0[i] = alpha; this.pDrag[i] = drag;
  }

  /**
   * A bullet hole where a round meets the world; with `particles`, round sparks and dust too (the
   * game draws those with the blast cards, `Blasts.hit`, once they are loaded).
   */
  impact(x: number, y: number, z: number, nx: number, ny: number, nz: number, particles = true): void {
    for (let i = 0; particles && i < 6; i++) {
      const sp = 2 + Math.random() * 5;
      this.emit(
        x, y, z,
        (nx + (Math.random() - 0.5) * 1.5) * sp, (ny + (Math.random() - 0.5) * 1.5) * sp + 1, (nz + (Math.random() - 0.5) * 1.5) * sp,
        3.2, 2.2 + Math.random(), 0.9, 0.14 + Math.random() * 0.2, 14, 0.035, -0.03, 1, 1, 1.5,
      );
    }
    for (let i = 0; particles && i < 3; i++) {
      const sp = 1 + Math.random() * 2.5;
      this.emit(
        x, y, z, (nx + (Math.random() - 0.5)) * sp, (ny + (Math.random() - 0.5)) * sp + 1.2, (nz + (Math.random() - 0.5)) * sp,
        0.2, 0.21, 0.24, 0.35 + Math.random() * 0.3, 12, 0.03, 0, 0.9, 0, 0.5,
      );
    }
    for (let i = 0; particles && i < 3; i++) {
      const sp = 0.5 + Math.random() * 0.9;
      this.emit(
        x + nx * 0.05, y + ny * 0.05, z + nz * 0.05,
        (nx * 1.2 + (Math.random() - 0.5) * 0.8) * sp, (ny * 1.2 + (Math.random() - 0.5) * 0.8) * sp + 0.25, (nz * 1.2 + (Math.random() - 0.5) * 0.8) * sp,
        0.62, 0.66, 0.74, 0.5 + Math.random() * 0.35, -0.3, 0.16, 0.7, 0.3, 0, 2.5,
      );
    }
    // Decal, with a random roll so repeated hits do not look stamped.
    const i = this.decalI++ % MAX_DECALS;
    _v.set(nx, ny, nz);
    _q.setFromUnitVectors(_z, _v);
    _q2.setFromAxisAngle(_z, Math.random() * Math.PI * 2);
    _q.multiply(_q2);
    const s = 0.65 + Math.random() * 0.55;
    _s.set(s, s, s);
    _v.set(x + nx * 0.006, y + ny * 0.006, z + nz * 0.006);
    _m.compose(_v, _q, _s);
    this.decals.setMatrixAt(i, _m);
    this.decals.count = Math.min(MAX_DECALS, this.decalI);
    this.decals.instanceMatrix.needsUpdate = true;
  }

  blood(x: number, y: number, z: number, dx: number, dy: number, dz: number, big: boolean): void {
    const n = big ? 12 : 7;
    for (let i = 0; i < n; i++) {
      const sp = 1 + Math.random() * 3.2;
      this.emit(
        x, y, z, (dx + (Math.random() - 0.5) * 1.2) * sp, (dy + (Math.random() - 0.3) * 1.2) * sp, (dz + (Math.random() - 0.5) * 1.2) * sp,
        0.5, 0.02, 0.03, 0.3 + Math.random() * 0.25, 10, 0.05 + Math.random() * 0.04, 0, 0.95, 0, 0.8,
      );
    }
    // A quick mist so hits read at range.
    this.emit(x, y, z, dx * 0.6, 0.3, dz * 0.6, 0.55, 0.04, 0.05, 0.22, 0, big ? 0.3 : 0.2, 0.9, 0.5, 0, 2);
  }

  beginRopes(): void {
    this.ropesUsed = 0;
  }
  rope(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    if (this.ropesUsed >= MAX_ROPES) return;
    const m = this.ropes[this.ropesUsed++]!;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    _v.set(dx / len, dy / len, dz / len);
    m.quaternion.setFromUnitVectors(_z, _v);
    m.scale.set(0.012, 0.012, len);
    m.visible = true;
  }
  endRopes(): void {
    for (let i = this.ropesUsed; i < MAX_ROPES; i++) this.ropes[i]!.visible = false;
  }

  /** A flashbang: one white pop, too short to look at, and a wisp of smoke. */
  flashPop(x: number, y: number, z: number): void {
    this.flashLight(x, y + 0.2, z, 300, 0.12, 0xe9f1ff);
    const R = Math.random;
    this.emit(x, y + 0.1, z, 0, 0, 0, 2.6, 2.6, 2.8, 0.07, 0, 0.9, 0.8, 1, 1, 0);
    for (let i = 0; i < 26; i++) {
      const a = R() * Math.PI * 2, e = (R() - 0.3) * Math.PI, sp = 5 + R() * 9;
      this.emit(x, y + 0.1, z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp, Math.sin(a) * Math.cos(e) * sp,
        3.5, 3.5, 3.8, 0.08 + R() * 0.12, 4, 0.025, -0.02, 1, 1, 2);
    }
    for (let i = 0; i < 6; i++) {
      this.emit(x, y + 0.15, z, (R() - 0.5) * 0.8, 0.3 + R() * 0.5, (R() - 0.5) * 0.8, 0.55, 0.57, 0.6, 1.2 + R(), -0.2, 0.35, 1.2, 0.35, 0, 1.5);
    }
  }

  /** One tongue of flame (fire on the ground, a molotov's rag in flight). */
  flame(x: number, y: number, z: number, size = 1): void {
    const R = Math.random;
    const hot = R();
    // (big soft tongues, overlapping, that shrink and redden as they rise)
    this.emit(x, y + 0.1, z, (R() - 0.5) * 0.35, 1.2 + R() * 1.4, (R() - 0.5) * 0.35,
      1.5 + hot * 0.6, 0.42 + hot * 0.5, 0.08 + hot * 0.1, 0.35 + R() * 0.35, -1.0, (0.55 + R() * 0.4) * size, -0.5 * size, 0.5, 1, 1.5);
  }

  /** Smoke off a fire. */
  fireSmoke(x: number, y: number, z: number): void {
    const R = Math.random;
    this.emit(x, y, z, (R() - 0.5) * 0.5, 0.8 + R() * 0.8, (R() - 0.5) * 0.5, 0.1, 0.1, 0.11, 1.8 + R() * 1.2, -0.15, 0.4, 1.8, 0.38, 0, 0.8);
  }

  /** A fire put out: steam and smoke. */
  fireOut(x: number, y: number, z: number): void {
    const R = Math.random;
    for (let i = 0; i < 16; i++) {
      const a = R() * Math.PI * 2, sp = 0.5 + R() * 1.5;
      this.emit(x + Math.cos(a) * R() * 1.2, y + 0.1, z + Math.sin(a) * R() * 1.2, Math.cos(a) * sp, 0.6 + R() * 1.2, Math.sin(a) * sp,
        0.5, 0.52, 0.55, 1.2 + R() * 0.8, -0.2, 0.5, 1.6, 0.45, 0, 1.2);
    }
  }

  clearRound(): void {
    this.decalI = 0;
    this.decals.count = 0;
  }

  /** `chargeBlink` 0..1 brightness of the charge's light. */
  update(dt: number, chargeBlink: number): void {
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) f.mesh.visible = false;
    }
    for (const l of this.lights) {
      if (l.life <= 0) continue;
      l.life -= dt;
      const k = l.life > 0 ? l.life / l.dur : 0;
      l.light.intensity = l.peak * k * k;
    }

    const { pPos, pVel, pLife, pMax, pGrav, pMisc, pSize0, pGrow, pAlpha0, pDrag } = this;
    let any = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (pLife[i]! <= 0) continue;
      any = true;
      const i3 = i * 3;
      pLife[i]! -= dt;
      if (pLife[i]! <= 0) {
        pPos[i3 + 1] = -9999;
        pMisc[i3 + 1] = 0;
        continue;
      }
      const drag = Math.max(0, 1 - pDrag[i]! * dt);
      pVel[i3]! *= drag; pVel[i3 + 2]! *= drag;
      pVel[i3 + 1] = pVel[i3 + 1]! * drag - pGrav[i]! * dt;
      pPos[i3]! += pVel[i3]! * dt;
      pPos[i3 + 1]! += pVel[i3 + 1]! * dt;
      pPos[i3 + 2]! += pVel[i3 + 2]! * dt;
      const age = 1 - pLife[i]! / pMax[i]!;
      pMisc[i3] = Math.max(0.005, pSize0[i]! + pGrow[i]! * age);
      pMisc[i3 + 1] = pAlpha0[i]! * (1 - age * age);
    }
    if (any) {
      const a = this.points.geometry.attributes;
      a['position']!.needsUpdate = true;
      a['color']!.needsUpdate = true;
      a['misc']!.needsUpdate = true;
    }

    this.chargeCore.color.setRGB(0.3 + chargeBlink * 2.6, 0.06 + chargeBlink * 0.5, 0.05 + chargeBlink * 0.2);
  }
}
