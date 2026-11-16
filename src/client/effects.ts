// Pooled visual effects: tracers, impact sparks, blood, bullet holes, grapple ropes,
// the charge, and its detonation. Nothing here allocates per shot.

import * as THREE from 'three';

const MAX_TRACERS = 48;
const MAX_PARTICLES = 512;
const MAX_DECALS = 192;
const MAX_ROPES = 10;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _up = new THREE.Vector3(0, 1, 0);

export class Effects {
  readonly group = new THREE.Group();

  private tracers: { mesh: THREE.Mesh; life: number }[] = [];
  private tracerI = 0;

  private pPos = new Float32Array(MAX_PARTICLES * 3);
  private pCol = new Float32Array(MAX_PARTICLES * 3);
  private pVel = new Float32Array(MAX_PARTICLES * 3);
  private pLife = new Float32Array(MAX_PARTICLES);
  private pGrav = new Float32Array(MAX_PARTICLES);
  private pI = 0;
  private points: THREE.Points;

  private decals: THREE.InstancedMesh;
  private decalI = 0;

  private ropes: THREE.Mesh[] = [];
  private ropesUsed = 0;

  readonly charge = new THREE.Group();
  private chargeLight: THREE.Mesh;
  private blast: THREE.Mesh;
  private blastT = -1;

  constructor() {
    // ---- tracers: thin additive boxes stretched along the bullet path ----
    const tGeo = new THREE.BoxGeometry(1, 1, 1);
    const tMat = new THREE.MeshBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    for (let i = 0; i < MAX_TRACERS; i++) {
      const mesh = new THREE.Mesh(tGeo, tMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }

    // ---- particles ----
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.pPos.fill(-9999);
    this.points = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.07, vertexColors: true, sizeAttenuation: true, transparent: true, depthWrite: false, toneMapped: false }));
    this.points.frustumCulled = false;
    this.group.add(this.points);

    // ---- bullet holes ----
    const dc = document.createElement('canvas');
    dc.width = dc.height = 32;
    const g = dc.getContext('2d')!;
    const grad = g.createRadialGradient(16, 16, 1, 16, 16, 15);
    grad.addColorStop(0, 'rgba(10,10,12,0.95)');
    grad.addColorStop(0.45, 'rgba(25,25,28,0.7)');
    grad.addColorStop(1, 'rgba(40,40,40,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    const dMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(dc), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    this.decals = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.16, 0.16), dMat, MAX_DECALS);
    this.decals.count = 0;
    this.decals.frustumCulled = false;
    this.group.add(this.decals);

    // ---- grapple ropes ----
    const rMat = new THREE.MeshBasicMaterial({ color: 0x9ff3ff, toneMapped: false });
    for (let i = 0; i < MAX_ROPES; i++) {
      const mesh = new THREE.Mesh(tGeo, rMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.ropes.push(mesh);
    }

    // ---- the charge ----
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.2), new THREE.MeshStandardMaterial({ color: 0x22262d, roughness: 0.5, metalness: 0.6 }));
    body.position.y = 0.06;
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.16, 12), new THREE.MeshBasicMaterial({ color: 0xff3b2e, toneMapped: false }));
    core.position.y = 0.14;
    this.chargeLight = core;
    this.charge.add(body, core);
    this.charge.visible = false;
    this.group.add(this.charge);

    this.blast = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffc27a, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    this.blast.visible = false;
    this.group.add(this.blast);
  }

  tracer(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const t = this.tracers[this.tracerI++ % MAX_TRACERS]!;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1.5) return;
    // Draw only the leading part so it reads as a streak, not a laser.
    const seg = Math.min(len, 14);
    const start = Math.min(len - seg, 1.2);
    const m = t.mesh;
    m.position.set(ax + (dx / len) * (start + seg / 2), ay + (dy / len) * (start + seg / 2), az + (dz / len) * (start + seg / 2));
    _v.set(dx / len, dy / len, dz / len);
    m.quaternion.setFromUnitVectors(_z, _v);
    m.scale.set(0.012, 0.012, seg);
    m.visible = true;
    t.life = 0.05;
  }

  private emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, life: number, grav: number): void {
    const i = this.pI++ % MAX_PARTICLES;
    this.pPos[i * 3] = x; this.pPos[i * 3 + 1] = y; this.pPos[i * 3 + 2] = z;
    this.pVel[i * 3] = vx; this.pVel[i * 3 + 1] = vy; this.pVel[i * 3 + 2] = vz;
    this.pCol[i * 3] = r; this.pCol[i * 3 + 1] = g; this.pCol[i * 3 + 2] = b;
    this.pLife[i] = life;
    this.pGrav[i] = grav;
  }

  /** Sparks and dust where a bullet meets the world, plus a bullet hole. */
  impact(x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    for (let i = 0; i < 7; i++) {
      const sp = 1.5 + Math.random() * 3.5;
      this.emit(
        x, y, z,
        (nx + (Math.random() - 0.5) * 1.4) * sp, (ny + (Math.random() - 0.5) * 1.4) * sp + 0.8, (nz + (Math.random() - 0.5) * 1.4) * sp,
        1, 0.75 + Math.random() * 0.2, 0.35, 0.18 + Math.random() * 0.2, 12,
      );
    }
    for (let i = 0; i < 4; i++) {
      this.emit(x, y, z, nx * 0.8 + (Math.random() - 0.5), ny * 0.8 + Math.random() * 0.6, nz * 0.8 + (Math.random() - 0.5), 0.6, 0.62, 0.66, 0.45, 1.5);
    }
    // Decal.
    const i = this.decalI++ % MAX_DECALS;
    _v.set(nx, ny, nz);
    _q.setFromUnitVectors(_z, _v);
    const s = 0.7 + Math.random() * 0.6;
    _s.set(s, s, s);
    _v.set(x + nx * 0.004, y + ny * 0.004, z + nz * 0.004);
    _m.compose(_v, _q, _s);
    this.decals.setMatrixAt(i, _m);
    this.decals.count = Math.min(MAX_DECALS, this.decalI);
    this.decals.instanceMatrix.needsUpdate = true;
  }

  blood(x: number, y: number, z: number, dx: number, dy: number, dz: number, big: boolean): void {
    const n = big ? 14 : 8;
    for (let i = 0; i < n; i++) {
      const sp = 1 + Math.random() * 3;
      this.emit(x, y, z, (dx + (Math.random() - 0.5) * 1.2) * sp, (dy + (Math.random() - 0.3) * 1.2) * sp, (dz + (Math.random() - 0.5) * 1.2) * sp, 0.75, 0.05, 0.06, 0.3 + Math.random() * 0.25, 9);
    }
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
    m.scale.set(0.02, 0.02, len);
    m.visible = true;
  }
  endRopes(): void {
    for (let i = this.ropesUsed; i < MAX_ROPES; i++) this.ropes[i]!.visible = false;
  }

  detonate(x: number, y: number, z: number): void {
    this.blast.position.set(x, y + 0.5, z);
    this.blastT = 0;
    this.blast.visible = true;
    for (let i = 0; i < 120; i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI * 0.5;
      const sp = 6 + Math.random() * 16;
      this.emit(x, y + 0.3, z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp, Math.sin(a) * Math.cos(e) * sp, 1, 0.6 + Math.random() * 0.3, 0.2, 0.5 + Math.random() * 0.8, 10);
    }
  }

  clearRound(): void {
    this.decalI = 0;
    this.decals.count = 0;
    this.blast.visible = false;
    this.blastT = -1;
  }

  /** `chargeBlink` 0..1 brightness of the charge's light. */
  update(dt: number, chargeBlink: number): void {
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) t.mesh.visible = false;
    }
    const { pPos, pVel, pLife, pGrav } = this;
    let any = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (pLife[i]! <= 0) continue;
      any = true;
      pLife[i]! -= dt;
      if (pLife[i]! <= 0) {
        pPos[i * 3 + 1] = -9999;
        continue;
      }
      pVel[i * 3 + 1]! -= pGrav[i]! * dt;
      pPos[i * 3]! += pVel[i * 3]! * dt;
      pPos[i * 3 + 1]! += pVel[i * 3 + 1]! * dt;
      pPos[i * 3 + 2]! += pVel[i * 3 + 2]! * dt;
    }
    if (any) {
      this.points.geometry.attributes['position']!.needsUpdate = true;
      this.points.geometry.attributes['color']!.needsUpdate = true;
    }
    (this.chargeLight.material as THREE.MeshBasicMaterial).color.setRGB(0.25 + chargeBlink * 0.75, 0.06 + chargeBlink * 0.2, 0.05);
    if (this.blastT >= 0) {
      this.blastT += dt / 0.7;
      const t = this.blastT;
      if (t >= 1) {
        this.blast.visible = false;
        this.blastT = -1;
      } else {
        const r = 2 + t * 20;
        this.blast.scale.set(r, r, r);
        (this.blast.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - t) * (1 - t);
      }
    }
    void _up;
  }
}
