// Turns the box map into a handful of merged meshes (one draw call per material),
// with procedural panel textures and baked vertex shading. No asset downloads.

import * as THREE from 'three';
import { Mat, type MapDef } from '../sim/map';

interface Palette {
  base: string;
  line: string;
  accent: string;
  rough: number;
  metal: number;
  /** Panels per texture tile. */
  grid: number;
  ribs?: boolean;
}

const PALETTES: Record<number, Palette> = {
  [Mat.Floor]: { base: '#5d6570', line: '#474e58', accent: '#6b7480', rough: 0.92, metal: 0.0, grid: 2 },
  [Mat.Wall]: { base: '#c9d1da', line: '#9aa5b2', accent: '#dfe5ec', rough: 0.7, metal: 0.05, grid: 1 },
  [Mat.Block]: { base: '#8b98a8', line: '#6d7a8a', accent: '#9ba8b8', rough: 0.75, metal: 0.1, grid: 1 },
  [Mat.Crate]: { base: '#d98a2b', line: '#9c5f17', accent: '#f0a544', rough: 0.6, metal: 0.25, grid: 2, ribs: true },
  [Mat.Deck]: { base: '#3f6f78', line: '#2b4d54', accent: '#4f8791', rough: 0.55, metal: 0.4, grid: 2, ribs: true },
  [Mat.Roof]: { base: '#3a414c', line: '#2a3039', accent: '#454d59', rough: 0.85, metal: 0.1, grid: 1 },
};

export const GLOW_COLORS: Record<number, number> = {
  [Mat.GlowA]: 0x35e0ff,
  [Mat.GlowB]: 0xffb02e,
  [Mat.GlowNeutral]: 0xf2f6ff,
};

function panelTexture(p: Palette, maxAniso: number): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = p.base;
  g.fillRect(0, 0, S, S);
  // Fine grain so large flat surfaces do not look like plastic.
  const img = g.getImageData(0, 0, S, S);
  let seed = 12345;
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const n = ((seed >>> 24) / 255 - 0.5) * 14;
    img.data[i] = Math.max(0, Math.min(255, img.data[i]! + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1]! + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2]! + n));
  }
  g.putImageData(img, 0, 0);
  const cell = S / p.grid;
  if (p.ribs) {
    g.fillStyle = p.line;
    g.globalAlpha = 0.35;
    for (let x = 0; x < S; x += 16) g.fillRect(x, 0, 5, S);
    g.globalAlpha = 1;
  }
  for (let i = 0; i < p.grid; i++) {
    for (let j = 0; j < p.grid; j++) {
      const x = i * cell, y = j * cell;
      // Panel bevel: light top/left edge, dark seam.
      g.strokeStyle = p.line;
      g.lineWidth = 3;
      g.strokeRect(x + 1.5, y + 1.5, cell - 3, cell - 3);
      g.strokeStyle = p.accent;
      g.lineWidth = 1;
      g.strokeRect(x + 4.5, y + 4.5, cell - 9, cell - 9);
      g.fillStyle = p.line;
      for (const [bx, by] of [[10, 10], [cell - 12, 10], [10, cell - 12], [cell - 12, cell - 12]] as const) {
        g.fillRect(x + bx, y + by, 2, 2);
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  return t;
}

class MeshBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  quad(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number, shade: [number, number, number, number],
  ): void {
    const base = this.pos.length / 3;
    const pts = [ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz];
    for (let i = 0; i < 4; i++) {
      const x = pts[i * 3]!, y = pts[i * 3 + 1]!, z = pts[i * 3 + 2]!;
      this.pos.push(x, y, z);
      this.nrm.push(nx, ny, nz);
      // World-space UVs: every surface tiles on the same 2 m grid.
      if (nx !== 0) this.uv.push(z * 0.5, y * 0.5);
      else if (ny !== 0) this.uv.push(x * 0.5, z * 0.5);
      else this.uv.push(x * 0.5, y * 0.5);
      const s = shade[i]!;
      this.col.push(s, s, s);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  box(b: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }, glow: boolean): void {
    const { minX: x0, minY: y0, minZ: z0, maxX: x1, maxY: y1, maxZ: z1 } = b;
    // Fake ambient occlusion: walls darken toward the floor they stand on.
    const lo = glow ? 1 : y0 <= 0.01 && y1 > 0.5 ? 0.62 : 0.85;
    const hi = 1;
    const side: [number, number, number, number] = [lo, lo, hi, hi];
    const flat: [number, number, number, number] = [1, 1, 1, 1];
    this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, side);
    this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, side);
    this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, side);
    this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, side);
    this.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0, flat);
    if (y0 > 0.05) this.quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0, [0.6, 0.6, 0.6, 0.6]);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

function letterTexture(letter: string, color: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 256, 256);
  g.strokeStyle = color;
  g.lineWidth = 8;
  g.strokeRect(14, 14, 228, 228);
  g.fillStyle = color;
  g.font = '900 190px system-ui, "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(letter, 128, 140);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildWorld(map: MapDef, maxAniso: number, shadows: boolean): THREE.Group {
  const group = new THREE.Group();
  const builders = new Map<number, MeshBuilder>();
  for (const b of map.boxes) {
    if (b.hidden) continue;
    let mb = builders.get(b.mat);
    if (!mb) builders.set(b.mat, (mb = new MeshBuilder()));
    mb.box(b, b.mat in GLOW_COLORS);
  }
  for (const [mat, mb] of builders) {
    let material: THREE.Material;
    if (mat in GLOW_COLORS) {
      material = new THREE.MeshBasicMaterial({ color: GLOW_COLORS[mat], toneMapped: false });
    } else {
      const p = PALETTES[mat] ?? PALETTES[Mat.Wall]!;
      material = new THREE.MeshStandardMaterial({
        map: panelTexture(p, maxAniso), roughness: p.rough, metalness: p.metal, vertexColors: true,
      });
    }
    const mesh = new THREE.Mesh(mb.build(), material);
    mesh.matrixAutoUpdate = false;
    if (!(mat in GLOW_COLORS)) {
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
    }
    group.add(mesh);
  }

  // Site markings: a big letter on the floor and a sign on the back wall.
  const signs: [string, number, number, number][] = [
    ['A', GLOW_COLORS[Mat.GlowA]!, 19.75, -16.5],
    ['B', GLOW_COLORS[Mat.GlowB]!, -19.75, -16.5],
  ];
  for (const [letter, color, x, z] of signs) {
    const tex = letterTexture(letter, '#ffffff');
    const m = new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), m);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(x, 0.03, z);
    group.add(floor);
    const wallM = m.clone();
    wallM.opacity = 0.9;
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), wallM);
    wall.position.set(x > 0 ? 24.5 : -24.5, 2.6, -23.97);
    group.add(wall);
  }
  return group;
}

/** Gradient sky dome with a soft sun glow. */
export function buildSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(400, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x2f6fd0) },
      horizon: { value: new THREE.Color(0xcfe4f7) },
      sunDir: { value: new THREE.Vector3(-0.42, 0.72, 0.35).normalize() },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `
      varying vec3 vDir; uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir;
      void main(){
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 c = mix(horizon, top, pow(h, 0.55));
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        c += vec3(1.0, 0.92, 0.75) * (pow(s, 220.0) * 2.0 + pow(s, 12.0) * 0.25);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = -10;
  return m;
}
