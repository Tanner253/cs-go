// Level renderer. Turns the collision boxes into clean, lit render geometry:
//
//  1. Surface extraction — every box face is clipped against every other box, so faces that
//     are hidden, shared between touching boxes, or duplicated by overlapping boxes are never
//     emitted. Nothing is coplanar with anything else, so nothing can z-fight.
//  2. Global lattice — surviving faces are split on one shared grid of coordinates, so
//     neighbouring faces always share vertices (no T-junction cracks).
//  3. Bake — ambient occlusion, sky visibility, key-light shadowing and coloured light spill
//     from the emissive strips are ray-traced once per vertex at load. The result looks
//     lightmapped and costs nothing per frame.
//
// Render-only dressing (pillars, light housings, masts, signage) never touches collision.

import * as THREE from 'three';
import { Mat, type MapDef } from '../sim/map';
import { LIGHTING, type Quality } from './gfx';

/** Site accent colours (A, B) — deliberately distinct from the team colours. */
export const SITE_COLORS: [number, number] = [0xb46bff, 0xc6f53a];
/** Team colours (attack, defence). */
export const TEAM_COLORS: [number, number] = [0xff7a2e, 0x35e0ff];
const NEUTRAL_GLOW = 0xffe2bd;
const BEACON_GLOW = 0xff3b30;

export const GLOW_COLORS: Record<number, number> = {
  [Mat.GlowA]: SITE_COLORS[0],
  [Mat.GlowB]: SITE_COLORS[1],
  [Mat.GlowNeutral]: NEUTRAL_GLOW,
};

const EPS = 1e-4;
type V3 = [number, number, number];

interface RBox {
  min: V3;
  max: V3;
  idx: number;
  mat: number;
  /** Emits faces (false for the invisible ceiling, which only hides things). */
  emit: boolean;
  /** Forced surface for dressing, else -1. */
  surf: number;
  /** Emissive colour, else -1. */
  glow: number;
  /** Emissive boxes normally only exist where they are mounted on a solid; `free` skips that. */
  free?: boolean;
}

const enum Surf { Floor, Wall, Block, Roof, Ceil, ContA, ContB, Deck, Trim, COUNT }

// ---------------------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------------------

type Ctx = CanvasRenderingContext2D;

function mk(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: true })!];
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Per-pixel grain. */
function grain(g: Ctx, w: number, h: number, amount: number, seed: number): void {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const r = lcg(seed);
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i]! + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1]! + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2]! + n));
  }
  g.putImageData(img, 0, 0);
}

/** Soft low-frequency blotches (tileable), composited with the given blend mode. */
function blotches(g: Ctx, w: number, h: number, cells: number, alpha: number, mode: GlobalCompositeOperation, seed: number): void {
  const [c, cg] = mk(cells, cells);
  const img = cg.createImageData(cells, cells);
  const r = lcg(seed);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = (r() * 255) | 0;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  cg.putImageData(img, 0, 0);
  g.save();
  g.globalAlpha = alpha;
  g.globalCompositeOperation = mode;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  // Draw 2x2 so the smoothing wraps and the result tiles.
  const pat = g.createPattern(c, 'repeat')!;
  pat.setTransform(new DOMMatrix().scale(w / cells, h / cells));
  g.fillStyle = pat;
  g.fillRect(0, 0, w, h);
  g.restore();
}

function heightToNormal(hc: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const w = hc.width, h = hc.height;
  const src = hc.getContext('2d')!.getImageData(0, 0, w, h).data;
  const [out, og] = mk(w, h);
  const img = og.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const yu = ((y - 1 + h) % h) * w, yd = ((y + 1) % h) * w, yy = y * w;
    for (let x = 0; x < w; x++) {
      const xl = (x - 1 + w) % w, xr = (x + 1) % w;
      const dx = (src[(yy + xr) * 4]! - src[(yy + xl) * 4]!) / 255;
      const dy = (src[(yd + x) * 4]! - src[(yu + x) * 4]!) / 255;
      // Canvas y runs down, texture v runs up.
      const nx = -dx * strength, ny = dy * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (yy + x) * 4;
      d[i] = (nx * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[i + 2] = (inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}

interface TexSet {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

function toSet(albedo: HTMLCanvasElement, height: HTMLCanvasElement, rough: HTMLCanvasElement, strength: number, aniso: number): TexSet {
  const wrap = (c: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = aniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { map: wrap(albedo, true), normalMap: wrap(heightToNormal(height, strength), false), roughnessMap: wrap(rough, false) };
}

/** Draw the same shapes into albedo / height / roughness with different greys. */
interface Layers {
  a: Ctx;
  h: Ctx;
  r: Ctx;
}
function rect3(L: Layers, x: number, y: number, w: number, hh: number, a: string | null, h: number | null, r: number | null): void {
  if (a) { L.a.fillStyle = a; L.a.fillRect(x, y, w, hh); }
  if (h !== null) { L.h.fillStyle = `rgb(${h},${h},${h})`; L.h.fillRect(x, y, w, hh); }
  if (r !== null) { L.r.fillStyle = `rgb(${r},${r},${r})`; L.r.fillRect(x, y, w, hh); }
}
function layers(w: number, h: number, base: string, height: number, rough: number): [Layers, HTMLCanvasElement, HTMLCanvasElement, HTMLCanvasElement] {
  const [ac, a] = mk(w, h), [hc, hg] = mk(w, h), [rc, r] = mk(w, h);
  a.fillStyle = base; a.fillRect(0, 0, w, h);
  hg.fillStyle = `rgb(${height},${height},${height})`; hg.fillRect(0, 0, w, h);
  r.fillStyle = `rgb(${rough},${rough},${rough})`; r.fillRect(0, 0, w, h);
  return [{ a, h: hg, r }, ac, hc, rc];
}

/** Wall trim sheet: 2.2 m wide, 5.5 m tall (the height of the buildings). Kick plate, panel courses, accent line, top band. */
function wallSheet(aniso: number): TexSet {
  const W = 512, H = 1280;
  const [L, ac, hc, rc] = layers(W, H, '#c4c8cc', 128, 150);
  const rnd = lcg(11);
  // Panel courses (five 1.1 m rows), staggered vertical seams.
  for (let row = 0; row < 5; row++) {
    const y = row * 256;
    for (let col = 0; col < 2; col++) {
      const x = col * 256 + (row % 2 ? 128 : 0);
      const tone = 190 + ((rnd() * 22) | 0);
      for (const ox of [x, x - W]) {
        rect3(L, ox + 3, y + 3, 250, 250, `rgb(${tone},${tone + 2},${tone + 5})`, 136, null);
        // Bevel highlight / lowlight.
        rect3(L, ox + 3, y + 3, 250, 2, 'rgba(255,255,255,0.35)', 150, null);
        rect3(L, ox + 3, y + 251, 250, 2, 'rgba(0,0,0,0.25)', 112, null);
        // Rivets at the corners.
        for (const [rx, ry] of [[14, 14], [236, 14], [14, 236], [236, 236]] as const) {
          L.h.fillStyle = 'rgb(205,205,205)'; L.h.beginPath(); L.h.arc(ox + rx, y + ry, 3.2, 0, 7); L.h.fill();
          L.a.fillStyle = 'rgba(60,66,74,0.7)'; L.a.beginPath(); L.a.arc(ox + rx, y + ry, 2.4, 0, 7); L.a.fill();
        }
      }
    }
    // Horizontal seam.
    rect3(L, 0, y, W, 3, '#5d636b', 70, 215);
  }
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 2; col++) {
      const x = (col * 256 + (row % 2 ? 128 : 0)) % W;
      rect3(L, x, row * 256, 3, 256, '#5d636b', 70, 215);
    }
  }
  // Accent line at ~1.15 m and a painted band under it.
  rect3(L, 0, H - 280, W, 7, '#3d444e', 120, 120);
  // Top band (0.2 m) with vent slots.
  rect3(L, 0, 0, W, 46, '#7b828b', 158, 120);
  rect3(L, 0, 46, W, 3, '#3e444c', 60, 220);
  for (let x = 20; x < W; x += 64) rect3(L, x, 14, 34, 6, '#2a2f36', 40, 230), rect3(L, x, 26, 34, 6, '#2a2f36', 40, 230);
  // Kick plate (0.24 m).
  rect3(L, 0, H - 56, W, 56, '#3b4149', 176, 95);
  rect3(L, 0, H - 59, W, 3, '#23272d', 60, 220);
  rect3(L, 0, H - 56, W, 2, 'rgba(255,255,255,0.22)', 190, null);
  // Grime: darker toward the floor, soft staining, grain.
  const grad = L.a.createLinearGradient(0, H - 420, 0, H);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(18,22,30,0.28)');
  L.a.fillStyle = grad; L.a.fillRect(0, H - 420, W, 420);
  blotches(L.a, W, H, 24, 0.22, 'multiply', 3);
  blotches(L.r, W, H, 20, 0.3, 'overlay', 5);
  grain(L.a, W, H, 9, 7);
  grain(L.h, W, H, 5, 8);
  return toSet(ac, hc, rc, 2.6, aniso);
}

/** Floor / roof slabs: 2 m tile. */
function slabSheet(aniso: number, slabs: number, base: string, seed: number): TexSet {
  const S = 512;
  const [L, ac, hc, rc] = layers(S, S, base, 128, 205);
  const rnd = lcg(seed);
  const cell = S / slabs;
  for (let i = 0; i < slabs; i++) {
    for (let j = 0; j < slabs; j++) {
      const t = (rnd() - 0.5) * 16;
      L.a.fillStyle = t > 0 ? `rgba(255,255,255,${t / 255})` : `rgba(0,0,0,${-t / 255})`;
      L.a.fillRect(i * cell, j * cell, cell, cell);
      // A smoother worn patch catches specular highlights.
      L.r.fillStyle = `rgba(110,110,110,${0.25 + rnd() * 0.3})`;
      L.r.beginPath(); L.r.ellipse(i * cell + rnd() * cell, j * cell + rnd() * cell, 40 + rnd() * 60, 24 + rnd() * 40, rnd() * 3, 0, 7); L.r.fill();
    }
  }
  for (let i = 0; i < slabs; i++) {
    rect3(L, i * cell, 0, 4, S, 'rgba(20,24,30,0.75)', 62, 235);
    rect3(L, 0, i * cell, S, 4, 'rgba(20,24,30,0.75)', 62, 235);
    rect3(L, i * cell + 4, 0, 2, S, 'rgba(255,255,255,0.12)', 140, null);
    rect3(L, 0, i * cell + 4, S, 2, 'rgba(255,255,255,0.12)', 140, null);
  }
  // Hairline cracks.
  L.a.strokeStyle = 'rgba(15,18,24,0.35)'; L.a.lineWidth = 1;
  L.h.strokeStyle = 'rgb(84,84,84)'; L.h.lineWidth = 1.5;
  for (let k = 0; k < 5; k++) {
    let x = rnd() * S, y = rnd() * S;
    L.a.beginPath(); L.h.beginPath(); L.a.moveTo(x, y); L.h.moveTo(x, y);
    for (let s = 0; s < 6; s++) { x += (rnd() - 0.5) * 60; y += (rnd() - 0.5) * 60; L.a.lineTo(x, y); L.h.lineTo(x, y); }
    L.a.stroke(); L.h.stroke();
  }
  blotches(L.a, S, S, 16, 0.3, 'multiply', seed + 1);
  blotches(L.a, S, S, 64, 0.16, 'overlay', seed + 2);
  blotches(L.r, S, S, 12, 0.3, 'overlay', seed + 3);
  grain(L.a, S, S, 14, seed + 4);
  grain(L.h, S, S, 12, seed + 5);
  return toSet(ac, hc, rc, 2.0, aniso);
}

/** Cargo container face: mapped 0..1 across each box face, so the frame hugs the edges. */
function containerSheet(aniso: number): TexSet {
  const S = 512;
  const [L, ac, hc, rc] = layers(S, S, '#b9bdbf', 120, 140);
  // Corrugation.
  for (let x = 0; x < S; x += 32) {
    const gh = L.h.createLinearGradient(x, 0, x + 32, 0);
    gh.addColorStop(0, 'rgb(96,96,96)'); gh.addColorStop(0.25, 'rgb(150,150,150)'); gh.addColorStop(0.75, 'rgb(150,150,150)'); gh.addColorStop(1, 'rgb(96,96,96)');
    L.h.fillStyle = gh; L.h.fillRect(x, 0, 32, S);
    const ga = L.a.createLinearGradient(x, 0, x + 32, 0);
    ga.addColorStop(0, 'rgba(0,0,0,0.22)'); ga.addColorStop(0.3, 'rgba(255,255,255,0.06)'); ga.addColorStop(0.7, 'rgba(255,255,255,0.06)'); ga.addColorStop(1, 'rgba(0,0,0,0.22)');
    L.a.fillStyle = ga; L.a.fillRect(x, 0, 32, S);
  }
  // Label plate.
  rect3(L, 150, 150, 212, 96, '#dfe2e4', 150, 110);
  L.a.fillStyle = '#2b3038';
  L.a.font = '900 54px "Segoe UI", system-ui, sans-serif';
  L.a.textAlign = 'center'; L.a.textBaseline = 'middle';
  L.a.fillText('NP-07', 256, 200);
  L.a.font = '700 20px "Segoe UI", system-ui, sans-serif';
  L.a.fillStyle = 'rgba(30,34,40,0.75)';
  L.a.fillText('RELAY CARGO  //  2200 KG', 256, 280);
  // Hazard chevrons along the bottom.
  for (let x = -40; x < S; x += 40) {
    L.a.fillStyle = 'rgba(30,32,36,0.55)';
    L.a.beginPath(); L.a.moveTo(x, S - 34); L.a.lineTo(x + 20, S - 34); L.a.lineTo(x + 40, S - 62); L.a.lineTo(x + 20, S - 62); L.a.fill();
  }
  // Frame and corner castings (raised).
  const F = 30;
  for (const [x, y, w, h] of [[0, 0, S, F], [0, S - F, S, F], [0, 0, F, S], [S - F, 0, F, S]] as const) rect3(L, x, y, w, h, '#8e9396', 196, 105);
  rect3(L, F, F, S - 2 * F, 3, 'rgba(0,0,0,0.4)', 70, 220);
  rect3(L, F, S - F - 3, S - 2 * F, 3, 'rgba(0,0,0,0.4)', 70, 220);
  rect3(L, F, F, 3, S - 2 * F, 'rgba(0,0,0,0.4)', 70, 220);
  rect3(L, S - F - 3, F, 3, S - 2 * F, 'rgba(0,0,0,0.4)', 70, 220);
  for (const [x, y] of [[0, 0], [S - 46, 0], [0, S - 46], [S - 46, S - 46]] as const) {
    rect3(L, x, y, 46, 46, '#6f7478', 226, 90);
    rect3(L, x + 15, y + 15, 16, 16, '#22262b', 60, 230);
  }
  blotches(L.a, S, S, 20, 0.26, 'multiply', 31);
  blotches(L.r, S, S, 16, 0.3, 'overlay', 32);
  // Scratches.
  const rnd = lcg(77);
  L.a.strokeStyle = 'rgba(255,255,255,0.18)'; L.r.strokeStyle = 'rgb(70,70,70)';
  for (let k = 0; k < 26; k++) {
    const x = rnd() * S, y = rnd() * S, a = rnd() * 6.28, l = 10 + rnd() * 40;
    for (const g of [L.a, L.r]) { g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke(); }
  }
  grain(L.a, S, S, 10, 33);
  return toSet(ac, hc, rc, 3.2, aniso);
}

/** Tread plate for decks, steps and catwalks: 2 m tile. */
function deckSheet(aniso: number): TexSet {
  const S = 512;
  const [L, ac, hc, rc] = layers(S, S, '#aeb4ba', 120, 120);
  // Raised lozenges, alternating direction.
  for (let y = 0; y < S; y += 16) {
    for (let x = 0; x < S; x += 16) {
      const flip = ((x + y) / 16) % 2 === 0;
      for (const [g, col] of [[L.h, 'rgb(186,186,186)'], [L.a, 'rgba(255,255,255,0.14)'], [L.r, 'rgb(84,84,84)']] as const) {
        g.save(); g.translate(x + 8, y + 8); g.rotate(flip ? 0.785 : -0.785);
        g.fillStyle = col; g.beginPath(); g.ellipse(0, 0, 5.5, 1.7, 0, 0, 7); g.fill(); g.restore();
      }
    }
  }
  // Plate seams every 1 m with bolts.
  for (let i = 0; i < 2; i++) {
    rect3(L, i * 256, 0, 4, S, '#3a4048', 56, 230);
    rect3(L, 0, i * 256, S, 4, '#3a4048', 56, 230);
  }
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (const [bx, by] of [[18, 18], [238, 18], [18, 238], [238, 238]] as const) {
    L.h.fillStyle = 'rgb(214,214,214)'; L.h.beginPath(); L.h.arc(i * 256 + bx, j * 256 + by, 5, 0, 7); L.h.fill();
    L.a.fillStyle = 'rgba(50,56,64,0.8)'; L.a.beginPath(); L.a.arc(i * 256 + bx, j * 256 + by, 4, 0, 7); L.a.fill();
  }
  blotches(L.a, S, S, 18, 0.3, 'multiply', 41);
  blotches(L.r, S, S, 14, 0.35, 'overlay', 42);
  grain(L.a, S, S, 10, 43);
  return toSet(ac, hc, rc, 2.4, aniso);
}

interface SurfStyle {
  tex: 'wall' | 'floor' | 'roof' | 'cont' | 'deck';
  tint: number;
  rough: number;
  metal: number;
  normal: number;
}
const STYLES: Record<number, SurfStyle> = {
  [Surf.Floor]: { tex: 'floor', tint: 0x8d97a8, rough: 1.0, metal: 0.0, normal: 0.9 },
  [Surf.Wall]: { tex: 'wall', tint: 0xdfe4ea, rough: 1.0, metal: 0.05, normal: 1.0 },
  [Surf.Block]: { tex: 'wall', tint: 0x8696b4, rough: 1.0, metal: 0.1, normal: 1.0 },
  [Surf.Roof]: { tex: 'roof', tint: 0x5c6779, rough: 1.0, metal: 0.05, normal: 1.0 },
  [Surf.Ceil]: { tex: 'roof', tint: 0x6f7b8f, rough: 1.0, metal: 0.05, normal: 0.8 },
  [Surf.ContA]: { tex: 'cont', tint: 0x8f9c4e, rough: 1.0, metal: 0.35, normal: 1.0 },
  [Surf.ContB]: { tex: 'cont', tint: 0x66758f, rough: 1.0, metal: 0.35, normal: 1.0 },
  [Surf.Deck]: { tex: 'deck', tint: 0x7c899c, rough: 1.0, metal: 0.55, normal: 1.0 },
  [Surf.Trim]: { tex: 'deck', tint: 0x3c4450, rough: 1.0, metal: 0.5, normal: 0.6 },
};

// ---------------------------------------------------------------------------------------
// Surface extraction
// ---------------------------------------------------------------------------------------

/** Remove rectangle `o` from every rectangle in `rects` (flat u0,v0,u1,v1 quadruples). */
function subtract(rects: number[], o0: number, o1: number, o2: number, o3: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < rects.length; i += 4) {
    const r0 = rects[i]!, r1 = rects[i + 1]!, r2 = rects[i + 2]!, r3 = rects[i + 3]!;
    if (o0 >= r2 - EPS || o2 <= r0 + EPS || o1 >= r3 - EPS || o3 <= r1 + EPS) {
      out.push(r0, r1, r2, r3);
      continue;
    }
    if (o0 > r0 + EPS) out.push(r0, r1, o0, r3);
    if (o2 < r2 - EPS) out.push(o2, r1, r2, r3);
    const m0 = Math.max(r0, o0), m2 = Math.min(r2, o2);
    if (o1 > r1 + EPS) out.push(m0, r1, m2, o1);
    if (o3 < r3 - EPS) out.push(m0, o3, m2, r3);
  }
  return out;
}

/**
 * The parts of face (axis a, direction s) of box A that are actually visible:
 * the face minus everything another box covers, minus coplanar duplicates.
 */
function faceRects(A: RBox, a: number, s: number, covers: RBox[], dedupe: boolean): number[] {
  const u = (a + 1) % 3, v = (a + 2) % 3;
  const c = s > 0 ? A.max[a]! : A.min[a]!;
  let rects = [A.min[u]!, A.min[v]!, A.max[u]!, A.max[v]!];
  for (const B of covers) {
    if (B === A) continue;
    // Is the space immediately outside this face inside B?
    let hides = s > 0 ? B.min[a]! < c + EPS && B.max[a]! > c + EPS : B.max[a]! > c - EPS && B.min[a]! < c - EPS;
    if (!hides && dedupe && B.emit && B.idx < A.idx) {
      // Same plane, same direction: the lower-numbered box owns the overlap.
      hides = Math.abs((s > 0 ? B.max[a]! : B.min[a]!) - c) < EPS;
    }
    if (!hides) continue;
    rects = subtract(rects, B.min[u]!, B.min[v]!, B.max[u]!, B.max[v]!);
    if (rects.length === 0) break;
  }
  return rects;
}

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  get count(): number {
    return this.pos.length / 3;
  }
}

type UvFn = (x: number, y: number, z: number, out: [number, number]) => void;

function emitGrid(b: Builder, a: number, s: number, c: number, us: number[], vs: number[], uvFn: UvFn): void {
  const u = (a + 1) % 3, v = (a + 2) % 3;
  const base = b.count;
  const p: V3 = [0, 0, 0];
  const uv: [number, number] = [0, 0];
  for (let j = 0; j < vs.length; j++) {
    for (let i = 0; i < us.length; i++) {
      p[a] = c; p[u] = us[i]!; p[v] = vs[j]!;
      b.pos.push(p[0], p[1], p[2]);
      b.nrm.push(a === 0 ? s : 0, a === 1 ? s : 0, a === 2 ? s : 0);
      uvFn(p[0], p[1], p[2], uv);
      b.uv.push(uv[0], uv[1]);
    }
  }
  const nu = us.length;
  for (let j = 0; j < vs.length - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const i0 = base + j * nu + i, i1 = i0 + 1, i2 = i0 + nu + 1, i3 = i0 + nu;
      if (s > 0) b.idx.push(i0, i1, i2, i0, i2, i3);
      else b.idx.push(i0, i2, i1, i0, i3, i2);
    }
  }
}

function between(sorted: number[], lo: number, hi: number): number[] {
  const out = [lo];
  // Binary search for the first value > lo.
  let l = 0, r = sorted.length;
  while (l < r) {
    const m = (l + r) >> 1;
    if (sorted[m]! <= lo + EPS) l = m + 1;
    else r = m;
  }
  for (let i = l; i < sorted.length && sorted[i]! < hi - EPS; i++) out.push(sorted[i]!);
  out.push(hi);
  return out;
}

function even(lo: number, hi: number, step: number): number[] {
  const n = Math.max(1, Math.round((hi - lo) / step));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(lo + ((hi - lo) * i) / n);
  return out;
}

// ---------------------------------------------------------------------------------------
// Bake
// ---------------------------------------------------------------------------------------

class Occluders {
  private b: Float32Array;
  private n: number;
  private cell = 3;
  private gw: number;
  private gh: number;
  private ox: number;
  private oz: number;
  private cells: Int32Array[];
  static readonly AO_DIST = 2.6;

  constructor(boxes: RBox[]) {
    this.n = boxes.length;
    this.b = new Float32Array(this.n * 6);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    boxes.forEach((bx, i) => {
      this.b.set([bx.min[0], bx.min[1], bx.min[2], bx.max[0], bx.max[1], bx.max[2]], i * 6);
      minX = Math.min(minX, bx.min[0]); minZ = Math.min(minZ, bx.min[2]);
      maxX = Math.max(maxX, bx.max[0]); maxZ = Math.max(maxZ, bx.max[2]);
    });
    this.ox = minX; this.oz = minZ;
    this.gw = Math.ceil((maxX - minX) / this.cell) + 1;
    this.gh = Math.ceil((maxZ - minZ) / this.cell) + 1;
    const lists: number[][] = Array.from({ length: this.gw * this.gh }, () => []);
    const R = Occluders.AO_DIST;
    boxes.forEach((bx, i) => {
      const x0 = Math.max(0, Math.floor((bx.min[0] - R - minX) / this.cell)), x1 = Math.min(this.gw - 1, Math.floor((bx.max[0] + R - minX) / this.cell));
      const z0 = Math.max(0, Math.floor((bx.min[2] - R - minZ) / this.cell)), z1 = Math.min(this.gh - 1, Math.floor((bx.max[2] + R - minZ) / this.cell));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) lists[z * this.gw + x]!.push(i);
    });
    this.cells = lists.map((l) => Int32Array.from(l));
  }

  /** Is the segment o -> t blocked by anything? */
  blocked(ox: number, oy: number, oz: number, tx: number, ty: number, tz: number): boolean {
    const b = this.b;
    const dx = tx - ox, dy = ty - oy, dz = tz - oz;
    const loX = ox < tx ? ox : tx, hiX = ox < tx ? tx : ox;
    const loY = oy < ty ? oy : ty, hiY = oy < ty ? ty : oy;
    const loZ = oz < tz ? oz : tz, hiZ = oz < tz ? tz : oz;
    for (let i = 0, k = 0; i < this.n; i++, k += 6) {
      const mnX = b[k]!, mnY = b[k + 1]!, mnZ = b[k + 2]!, mxX = b[k + 3]!, mxY = b[k + 4]!, mxZ = b[k + 5]!;
      if (hiX <= mnX || loX >= mxX || hiY <= mnY || loY >= mxY || hiZ <= mnZ || loZ >= mxZ) {
        // Touching counts only when moving into the box, which the slab test below handles;
        // a pure bounding reject is safe here because equality means no interior overlap,
        // except for a ray starting exactly on a face — handled by the caller's offset.
        if (!(oy === mxY && dy < 0 && ox > mnX && ox < mxX && oz > mnZ && oz < mxZ)) continue;
      }
      let t0 = 0, t1 = 1;
      if (dx > -1e-9 && dx < 1e-9) { if (ox <= mnX || ox >= mxX) continue; } else {
        const inv = 1 / dx; let a = (mnX - ox) * inv, c = (mxX - ox) * inv;
        if (a > c) { const t = a; a = c; c = t; }
        if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 >= t1) continue;
      }
      if (dy > -1e-9 && dy < 1e-9) { if (oy <= mnY || oy >= mxY) continue; } else {
        const inv = 1 / dy; let a = (mnY - oy) * inv, c = (mxY - oy) * inv;
        if (a > c) { const t = a; a = c; c = t; }
        if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 >= t1) continue;
      }
      if (dz > -1e-9 && dz < 1e-9) { if (oz <= mnZ || oz >= mxZ) continue; } else {
        const inv = 1 / dz; let a = (mnZ - oz) * inv, c = (mxZ - oz) * inv;
        if (a > c) { const t = a; a = c; c = t; }
        if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 >= t1) continue;
      }
      return true;
    }
    return false;
  }

  /** Nearest hit distance along a unit direction within AO range (or AO_DIST if clear). */
  near(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    const cx = Math.floor((ox - this.ox) / this.cell), cz = Math.floor((oz - this.oz) / this.cell);
    if (cx < 0 || cz < 0 || cx >= this.gw || cz >= this.gh) return Occluders.AO_DIST;
    const list = this.cells[cz * this.gw + cx]!;
    const b = this.b;
    let best = Occluders.AO_DIST;
    for (let q = 0; q < list.length; q++) {
      const k = list[q]! * 6;
      const mnX = b[k]!, mnY = b[k + 1]!, mnZ = b[k + 2]!, mxX = b[k + 3]!, mxY = b[k + 4]!, mxZ = b[k + 5]!;
      let t0 = 0, t1 = best;
      if (dx > -1e-9 && dx < 1e-9) { if (ox <= mnX || ox >= mxX) continue; } else {
        const inv = 1 / dx; let a = (mnX - ox) * inv, c = (mxX - ox) * inv;
        if (a > c) { const t = a; a = c; c = t; }
        if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 >= t1) continue;
      }
      if (dy > -1e-9 && dy < 1e-9) { if (oy <= mnY || oy >= mxY) continue; } else {
        const inv = 1 / dy; let a = (mnY - oy) * inv, c = (mxY - oy) * inv;
        if (a > c) { const t = a; a = c; c = t; }
        if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 >= t1) continue;
      }
      if (dz > -1e-9 && dz < 1e-9) { if (oz <= mnZ || oz >= mxZ) continue; } else {
        const inv = 1 / dz; let a = (mnZ - oz) * inv, c = (mxZ - oz) * inv;
        if (a > c) { const t = a; a = c; c = t; }
        if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 >= t1) continue;
      }
      best = t0;
    }
    return best;
  }

  inside(x: number, y: number, z: number): boolean {
    const b = this.b;
    for (let i = 0, k = 0; i < this.n; i++, k += 6) {
      if (x > b[k]! && x < b[k + 3]! && y > b[k + 1]! && y < b[k + 4]! && z > b[k + 2]! && z < b[k + 5]!) return true;
    }
    return false;
  }
}

interface PointLight {
  x: number; y: number; z: number;
  r: number; g: number; b: number;
}

const LIGHT_RANGE = 9;

/** The light reaching a point: sun (0..1 unshadowed), open sky above (0..1), and the coloured spill of the light strips with the way it mostly comes from. */
export interface LightSample {
  sun: number; sky: number;
  r: number; g: number; b: number;
  dx: number; dy: number; dz: number;
}
export type LightProbe = (x: number, y: number, z: number, out: LightSample) => LightSample;

/** Cosine-ish hemisphere sample set around +Z (weights sum to 1). */
const HEMI: number[] = (() => {
  const out: number[] = [];
  const push = (x: number, y: number, z: number, w: number) => { const l = Math.hypot(x, y, z); out.push(x / l, y / l, z / l, w); };
  push(0, 0, 1, 0.16);
  for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + 0.4; push(Math.cos(a) * 0.75, Math.sin(a) * 0.75, 0.66, 0.12); }
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; push(Math.cos(a) * 0.95, Math.sin(a) * 0.95, 0.3, 0.06); }
  return out;
})();

const yieldToBrowser = (() => {
  // MessageChannel is not throttled in background tabs (setTimeout is).
  const ch = new MessageChannel();
  let res: (() => void) | null = null;
  ch.port1.onmessage = () => { const r = res; res = null; r?.(); };
  return () => new Promise<void>((r) => { res = r; ch.port2.postMessage(0); });
})();

// ---------------------------------------------------------------------------------------
// Decals
// ---------------------------------------------------------------------------------------

function letterTexture(letter: string): THREE.CanvasTexture {
  const [c, g] = mk(256, 256);
  g.strokeStyle = '#fff'; g.lineWidth = 10;
  g.strokeRect(16, 16, 224, 224);
  g.lineWidth = 3; g.strokeRect(30, 30, 196, 196);
  g.fillStyle = '#fff';
  g.font = '900 176px "Segoe UI", system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(letter, 128, 138);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function quad(positions: number[], uvs: number[], indices: number[], cx: number, cy: number, cz: number, ux: V3, vx: V3, w: number, h: number, u0 = 0, v0 = 0, u1 = 1, v1 = 1): void {
  const base = positions.length / 3;
  const hw = w / 2, hh = h / 2;
  for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    positions.push(cx + ux[0] * su * hw + vx[0] * sv * hh, cy + ux[1] * su * hw + vx[1] * sv * hh, cz + ux[2] * su * hw + vx[2] * sv * hh);
  }
  uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function decalMesh(positions: number[], uvs: number[], indices: number[], mat: THREE.Material): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  const m = new THREE.Mesh(g, mat);
  m.matrixAutoUpdate = false;
  m.renderOrder = 2;
  return m;
}

/** Decals sit 1 cm proud of the surface and also use polygon offset, so they hold at any distance. */
function decalMaterial(params: THREE.MeshBasicMaterialParameters): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8, ...params });
}

// ---------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------

function injectBake(m: THREE.MeshStandardMaterial): void {
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 bake;\nvarying vec4 vBake;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBake = bake;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vBake;')
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
         // Baked ambient occlusion on everything indirect, plus baked light spill.
         reflectedLight.indirectDiffuse *= vBake.a;
         reflectedLight.indirectSpecular *= vBake.a;
         reflectedLight.indirectDiffuse += vBake.rgb * diffuseColor.rgb;`,
      );
  };
  m.customProgramCacheKey = () => 'np-bake';
}

export async function buildWorld(
  map: MapDef, renderer: THREE.WebGLRenderer, quality: Quality, onProgress?: (fraction: number) => void,
): Promise<THREE.Group> {
  const group = new THREE.Group();
  group.name = 'world';
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  onProgress?.(0);

  // ---- classify boxes ----------------------------------------------------------------
  const covers: RBox[] = [];
  const solids: RBox[] = [];
  const glows: RBox[] = [];
  map.boxes.forEach((b, i) => {
    const rb: RBox = { min: [b.minX, b.minY, b.minZ], max: [b.maxX, b.maxY, b.maxZ], idx: i, mat: b.mat, emit: !b.hidden, surf: -1, glow: -1 };
    if (b.noCollide) {
      rb.glow = GLOW_COLORS[b.mat] ?? NEUTRAL_GLOW;
      glows.push(rb);
    } else {
      covers.push(rb);
      if (!b.hidden) solids.push(rb);
    }
  });
  const wmin: V3 = [Infinity, Infinity, Infinity], wmax: V3 = [-Infinity, -Infinity, -Infinity];
  for (const c of covers) for (let k = 0; k < 3; k++) { wmin[k] = Math.min(wmin[k]!, c.min[k]!); wmax[k] = Math.max(wmax[k]!, c.max[k]!); }
  const occ = new Occluders(covers);

  // ---- render-only dressing ------------------------------------------------------------
  let nextIdx = 100000;
  const decor: RBox[] = [];
  const addDecor = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, surf: number): void => {
    decor.push({ min: [x0, y0, z0], max: [x1, y1, z1], idx: nextIdx++, mat: -1, emit: true, surf, glow: -1 });
  };
  const addGlow = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number, free = false): void => {
    glows.push({ min: [x0, y0, z0], max: [x1, y1, z1], idx: nextIdx++, mat: -1, emit: true, surf: -1, glow: color, free });
  };
  const intersectsAny = (list: RBox[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, skip: RBox | null): boolean => {
    for (const o of list) {
      if (o === skip) continue;
      if (x1 > o.min[0] + EPS && x0 < o.max[0] - EPS && y1 > o.min[1] + EPS && y0 < o.max[1] - EPS && z1 > o.min[2] + EPS && z0 < o.max[2] - EPS) return true;
    }
    return false;
  };
  // Buttresses break up long, tall walls. Placed wherever a full-height column is clear.
  for (const w of solids) {
    if (w.mat !== Mat.Wall || w.min[1] > 0.01 || w.max[1] - w.min[1] < 8) continue;
    for (const a of [0, 2]) {
      const len = a === 0 ? 2 : 0; // the wall runs along the other horizontal axis
      const length = w.max[len]! - w.min[len]!;
      if (length < 16) continue;
      for (const s of [1, -1]) {
        const c = s > 0 ? w.max[a]! : w.min[a]!;
        if (s > 0 ? c >= wmax[a]! - EPS : c <= wmin[a]! + EPS) continue;
        const n = Math.floor(length / 9);
        const PW = 0.6, PD = 0.3, top = Math.min(w.max[1], wmax[1] - 1) - 0.1;
        for (let i = 0; i < n; i++) {
          const t = w.min[len]! + (length * (i + 0.5)) / n;
          const lo: V3 = [0, 0, 0], hi: V3 = [0, top, 0];
          lo[a] = s > 0 ? c : c - PD; hi[a] = s > 0 ? c + PD : c;
          lo[len] = t - PW / 2; hi[len] = t + PW / 2;
          if (intersectsAny(covers, lo[0], lo[1], lo[2], hi[0], hi[1], hi[2], w)) continue;
          addDecor(lo[0], lo[1], lo[2], hi[0], hi[1], hi[2], Surf.Block);
        }
      }
    }
  }
  // Rooftops are out of play: give the big ones vent units and a relay mast with a beacon.
  for (const r of solids) {
    const top = r.max[1];
    const sx = r.max[0] - r.min[0], sz = r.max[2] - r.min[2];
    if (r.mat === Mat.Floor || r.mat === Mat.Wall || top < 4 || top > wmax[1] - 3 || sx < 6 || sz < 6) continue;
    const rnd = lcg(r.idx * 7919 + 13);
    const placed: RBox[] = [];
    const tryPlace = (w: number, h: number, d: number, surf: number): RBox | null => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const x = r.min[0] + 1.2 + rnd() * (sx - 2.4 - w), z = r.min[2] + 1.2 + rnd() * (sz - 2.4 - d);
        if (intersectsAny(covers, x, top + 0.01, z, x + w, top + h, z + d, null)) continue;
        if (intersectsAny(placed, x - 0.3, top, z - 0.3, x + w + 0.3, top + h, z + d + 0.3, null)) continue;
        // The roof under the unit must really be there (not cut away by another box).
        if (!occ.inside(x + w / 2, top - 0.05, z + d / 2)) continue;
        const before = decor.length;
        addDecor(x, top, z, x + w, top + h, z + d, surf);
        placed.push(decor[before]!);
        return decor[before]!;
      }
      return null;
    };
    const units = Math.min(3, Math.floor((sx * sz) / 70) + 1);
    for (let i = 0; i < units; i++) tryPlace(1.4 + rnd() * 0.8, 0.7 + rnd() * 0.5, 0.9 + rnd() * 0.5, Surf.Deck);
    if (sx * sz >= 90) {
      const mastH = Math.min(3.4, wmax[1] - 1.6 - top);
      const m = mastH > 1.5 ? tryPlace(0.28, mastH, 0.28, Surf.Trim) : null;
      if (m) addGlow(m.min[0] + 0.04, m.max[1], m.min[2] + 0.04, m.max[0] - 0.04, m.max[1] + 0.2, m.max[2] - 0.04, BEACON_GLOW, true);
    }
  }

  // ---- emissive strips: keep only the parts mounted on a solid, add housings -----------
  const glowBoxes: RBox[] = [];
  for (const gb of glows) {
    if (gb.max[1] < 0.06) continue; // floor markings are drawn as decals instead
    if (gb.free) { glowBoxes.push(gb); continue; }
    const size: V3 = [gb.max[0] - gb.min[0], gb.max[1] - gb.min[1], gb.max[2] - gb.min[2]];
    const a = size[0] <= size[1] && size[0] <= size[2] ? 0 : size[1] <= size[2] ? 1 : 2;
    const u = (a + 1) % 3, v = (a + 2) % 3;
    for (const s of [1, -1]) {
      // Covered part of the back face = full face minus its uncovered part.
      const open = faceRects(gb, a, s, covers, false);
      let mounted = [gb.min[u], gb.min[v], gb.max[u], gb.max[v]];
      for (let i = 0; i < open.length; i += 4) mounted = subtract(mounted, open[i]!, open[i + 1]!, open[i + 2]!, open[i + 3]!);
      for (let i = 0; i < mounted.length; i += 4) {
        if (mounted[i + 2]! - mounted[i]! < 0.15 && mounted[i + 3]! - mounted[i + 1]! < 0.15) continue;
        const part: RBox = { min: [0, 0, 0], max: [0, 0, 0], idx: nextIdx++, mat: -1, emit: true, surf: -1, glow: gb.glow };
        part.min[a] = gb.min[a]!; part.max[a] = gb.max[a]!;
        part.min[u] = mounted[i]!; part.min[v] = mounted[i + 1]!; part.max[u] = mounted[i + 2]!; part.max[v] = mounted[i + 3]!;
        glowBoxes.push(part);
        // Housing: a dark frame behind the strip, 55% as deep, 5 cm bigger all round.
        const depth = size[a]! * 0.55, pad = 0.05;
        const h: RBox = { min: [0, 0, 0], max: [0, 0, 0], idx: nextIdx++, mat: -1, emit: true, surf: Surf.Trim, glow: -1 };
        if (s > 0) { h.max[a] = gb.max[a]!; h.min[a] = gb.max[a]! - depth; } else { h.min[a] = gb.min[a]!; h.max[a] = gb.min[a]! + depth; }
        // Pad across the strip only: neighbouring parts of one strip must not overlap.
        const across = part.max[u]! - part.min[u]! < part.max[v]! - part.min[v]! ? u : v;
        h.min[u] = part.min[u]!; h.max[u] = part.max[u]!;
        h.min[v] = part.min[v]!; h.max[v] = part.max[v]!;
        h.min[across] = part.min[across]! - pad; h.max[across] = part.max[across]! + pad;
        decor.push(h);
      }
      if (mounted.length > 0) break;
    }
  }

  // ---- lattice -------------------------------------------------------------------------
  const lattice: number[][] = [[], [], []];
  for (let k = 0; k < 3; k++) {
    const vals: number[] = [];
    for (const s of solids) vals.push(s.min[k]!, s.max[k]!);
    const step = k === 1 ? 1.1 : 2.0;
    for (let t = Math.ceil(wmin[k]! / step) * step; t < wmax[k]!; t += step) vals.push(t);
    vals.sort((p, q) => p - q);
    const uniq = lattice[k]!;
    for (const val of vals) if (uniq.length === 0 || val - uniq[uniq.length - 1]! > 1e-3) uniq.push(val);
  }

  // ---- surface classification + UVs ----------------------------------------------------
  const builders: Builder[] = [];
  for (let i = 0; i < Surf.COUNT; i++) builders.push(new Builder());
  const tile: UvFn = (x, y, z, o) => { o[0] = x * 0.5; o[1] = z * 0.5; };
  const sheetX: UvFn = (_x, y, z, o) => { o[0] = z / 2.2; o[1] = y / 5.5; };
  const sheetZ: UvFn = (x, y, _z, o) => { o[0] = x / 2.2; o[1] = y / 5.5; };
  const tileX: UvFn = (_x, y, z, o) => { o[0] = z * 0.5; o[1] = y * 0.5; };
  const tileZ: UvFn = (x, y, _z, o) => { o[0] = x * 0.5; o[1] = y * 0.5; };

  const surfaceOf = (b: RBox, a: number, s: number): [number, UvFn] => {
    if (b.surf === Surf.Block) return [Surf.Block, a === 0 ? sheetX : a === 2 ? sheetZ : tile];
    if (b.surf >= 0) return [b.surf, a === 0 ? tileX : a === 2 ? tileZ : tile];
    const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
    const containerLike = Math.max(sx, sz) <= 3 && sy >= 0.9;
    if (b.mat === Mat.Crate || (b.mat === Mat.Deck && containerLike)) {
      const fit: UvFn = a === 0
        ? (_x, y, z, o) => { o[0] = (z - b.min[2]) / sz; o[1] = (y - b.min[1]) / sy; }
        : a === 2
          ? (x, y, _z, o) => { o[0] = (x - b.min[0]) / sx; o[1] = (y - b.min[1]) / sy; }
          : (x, _y, z, o) => { o[0] = (x - b.min[0]) / sx; o[1] = (z - b.min[2]) / sz; };
      return [b.mat === Mat.Crate ? Surf.ContA : Surf.ContB, fit];
    }
    if (b.mat === Mat.Deck) return [Surf.Deck, a === 0 ? tileX : a === 2 ? tileZ : tile];
    if (a === 1) return [b.mat === Mat.Floor ? Surf.Floor : s > 0 ? Surf.Roof : Surf.Ceil, tile];
    if (b.mat === Mat.Wall) return [Surf.Wall, a === 0 ? sheetX : sheetZ];
    return [Surf.Block, a === 0 ? sheetX : sheetZ];
  };

  for (const b of solids) {
    for (let a = 0; a < 3; a++) {
      for (const s of [1, -1]) {
        const c = s > 0 ? b.max[a]! : b.min[a]!;
        // Never visible: the outer skin of the map and anything facing down at ground level.
        if (s > 0 ? c >= wmax[a]! - EPS : c <= wmin[a]! + EPS) continue;
        if (a === 1 && s < 0 && c <= 0.01) continue;
        const rects = faceRects(b, a, s, covers, true);
        if (rects.length === 0) continue;
        const [surf, uvFn] = surfaceOf(b, a, s);
        const u = (a + 1) % 3, v = (a + 2) % 3;
        for (let i = 0; i < rects.length; i += 4) {
          emitGrid(builders[surf]!, a, s, c, between(lattice[u]!, rects[i]!, rects[i + 2]!), between(lattice[v]!, rects[i + 1]!, rects[i + 3]!), uvFn);
        }
      }
    }
  }
  for (const b of decor) {
    for (let a = 0; a < 3; a++) {
      for (const s of [1, -1]) {
        const c = s > 0 ? b.max[a]! : b.min[a]!;
        const rects = faceRects(b, a, s, covers, false);
        if (rects.length === 0) continue;
        const [surf, uvFn] = surfaceOf(b, a, s);
        for (let i = 0; i < rects.length; i += 4) {
          emitGrid(builders[surf]!, a, s, c, even(rects[i]!, rects[i + 2]!, 1.2), even(rects[i + 1]!, rects[i + 3]!, 1.2), uvFn);
        }
      }
    }
  }

  // ---- light sources for the bake ------------------------------------------------------
  const lights: PointLight[] = [];
  const col = new THREE.Color();
  const addStripLights = (b: RBox, gain: number): void => {
    const size: V3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    const long = size[0] >= size[1] && size[0] >= size[2] ? 0 : size[1] >= size[2] ? 1 : 2;
    const thin = size[0] <= size[1] && size[0] <= size[2] ? 0 : size[1] <= size[2] ? 1 : 2;
    const mid = 3 - long - thin;
    const n = Math.max(1, Math.round(size[long]! / 2.5));
    col.setHex(b.glow);
    const power = gain * (size[long]! / n) * Math.min(1.5, Math.max(0.5, size[mid]! / 0.2));
    for (let i = 0; i < n; i++) {
      const p: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      p[long] = b.min[long]! + ((i + 0.5) / n) * size[long]!;
      // Step off whichever side is open air.
      const off = size[thin]! / 2 + 0.08;
      p[thin] = p[thin]! + off;
      if (occ.inside(p[0], p[1], p[2])) p[thin] = p[thin]! - 2 * off;
      lights.push({ x: p[0], y: p[1], z: p[2], r: col.r * power, g: col.g * power, b: col.b * power });
    }
  };
  for (const gb of glowBoxes) addStripLights(gb, gb.free ? 0.2 : 0.62);
  for (const gb of glows) if (gb.max[1] < 0.06) addStripLights(gb, 0.3);
  // Spatial hash for the lights.
  const LC = LIGHT_RANGE;
  const lgw = Math.ceil((wmax[0] - wmin[0]) / LC) + 1, lgh = Math.ceil((wmax[2] - wmin[2]) / LC) + 1;
  const lightCells: number[][] = Array.from({ length: lgw * lgh }, () => []);
  lights.forEach((l, i) => lightCells[Math.floor((l.z - wmin[2]) / LC) * lgw + Math.floor((l.x - wmin[0]) / LC)]!.push(i));

  // ---- bake ------------------------------------------------------------------------------
  const sun = LIGHTING.sunDir;
  const total = builders.reduce((n, b) => n + b.count, 0);
  const cache = new Map<number, number>();
  const results: number[] = []; // ao, sun, r, g, b per unique sample
  const bakeIdx: Int32Array[] = builders.map((b) => new Int32Array(b.count));
  let done = 0;
  let sliceStart = performance.now();
  for (let bi = 0; bi < builders.length; bi++) {
    const b = builders[bi]!;
    const idxOut = bakeIdx[bi]!;
    for (let vi = 0; vi < b.count; vi++) {
      const px = b.pos[vi * 3]!, py = b.pos[vi * 3 + 1]!, pz = b.pos[vi * 3 + 2]!;
      const nx = b.nrm[vi * 3]!, ny = b.nrm[vi * 3 + 1]!, nz = b.nrm[vi * 3 + 2]!;
      const face = nx > 0 ? 0 : nx < 0 ? 1 : ny > 0 ? 2 : ny < 0 ? 3 : nz > 0 ? 4 : 5;
      const key = ((Math.round(px * 500) + 20000) * 40001 + (Math.round(pz * 500) + 20000)) * 60006 + Math.round(py * 500 + 1000) * 6 + face;
      let slot = cache.get(key);
      if (slot === undefined) {
        slot = results.length / 5;
        cache.set(key, slot);
        const ox = px + nx * 0.03, oy = py + ny * 0.03, oz = pz + nz * 0.03;
        const a = nx !== 0 ? 0 : ny !== 0 ? 1 : 2;
        const sgn = nx + ny + nz;
        // Local ambient occlusion.
        let occl = 0;
        const d: V3 = [0, 0, 0];
        for (let h = 0; h < HEMI.length; h += 4) {
          d[a] = HEMI[h + 2]! * sgn; d[(a + 1) % 3] = HEMI[h]!; d[(a + 2) % 3] = HEMI[h + 1]!;
          const t = occ.near(ox, oy, oz, d[0], d[1], d[2]);
          const f = 1 - t / Occluders.AO_DIST;
          occl += HEMI[h + 3]! * f * f;
        }
        // Sky visibility: is this spot under open sky or under a roof?
        let sky = 0;
        if (ny >= 0) {
          for (let k = 0; k < 4; k++) {
            const jx = (k & 1 ? 0.38 : -0.38), jz = (k & 2 ? 0.38 : -0.38);
            const dx = jx + nx * 0.55, dz = jz + nz * 0.55, dy = 1;
            const inv = 45 / Math.hypot(dx, dy, dz);
            if (!occ.blocked(ox, oy, oz, ox + dx * inv, oy + dy * inv, oz + dz * inv)) sky += 0.25;
          }
        }
        const ao = Math.max(0.12, (1 - occl * 1.15)) * (0.36 + 0.64 * sky);
        // Key light.
        const ndl = nx * sun.x + ny * sun.y + nz * sun.z;
        const lit = ndl > 0 && !occ.blocked(ox, oy, oz, ox + sun.x * 140, oy + sun.y * 140, oz + sun.z * 140) ? ndl : 0;
        // Coloured spill from emissive strips.
        let lr = 0, lg = 0, lb = 0;
        const cx = Math.floor((px - wmin[0]) / LC), cz = Math.floor((pz - wmin[2]) / LC);
        for (let gz = cz - 1; gz <= cz + 1; gz++) {
          if (gz < 0 || gz >= lgh) continue;
          for (let gx = cx - 1; gx <= cx + 1; gx++) {
            if (gx < 0 || gx >= lgw) continue;
            const cell = lightCells[gz * lgw + gx]!;
            for (let q = 0; q < cell.length; q++) {
              const L = lights[cell[q]!]!;
              const dx = L.x - ox, dy = L.y - oy, dz = L.z - oz;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 > LIGHT_RANGE * LIGHT_RANGE) continue;
              const dist = Math.sqrt(d2);
              const nl = (nx * dx + ny * dy + nz * dz) / (dist + 1e-6);
              if (nl < -0.2) continue;
              const win = 1 - d2 / (LIGHT_RANGE * LIGHT_RANGE);
              const e = ((nl > 0 ? nl : 0) * 0.85 + 0.15) * win * win / (d2 + 0.7);
              if (e < 0.002) continue;
              if (occ.blocked(ox, oy, oz, L.x, L.y, L.z)) continue;
              lr += L.r * e; lg += L.g * e; lb += L.b * e;
            }
          }
        }
        results.push(ao, lit, lr, lg, lb);
      }
      idxOut[vi] = slot;
      done++;
      if ((done & 255) === 0 && performance.now() - sliceStart > 14) {
        onProgress?.(0.05 + 0.9 * (done / total));
        await yieldToBrowser();
        sliceStart = performance.now();
      }
    }
  }

  // ---- meshes ---------------------------------------------------------------------------
  const tex: Record<SurfStyle['tex'], TexSet> = {
    wall: wallSheet(aniso),
    floor: slabSheet(aniso, 2, '#9a9fa6', 21),
    roof: slabSheet(aniso, 1, '#8b9097', 51),
    cont: containerSheet(aniso),
    deck: deckSheet(aniso),
  };
  const hemiSky = LIGHTING.skyColor, hemiGround = LIGHTING.groundColor, sunC = LIGHTING.sunColor;
  const surfMeshes: { mesh: THREE.Mesh; std: THREE.MeshStandardMaterial; basic: THREE.MeshBasicMaterial }[] = [];
  for (let si = 0; si < builders.length; si++) {
    const b = builders[si]!;
    if (b.count === 0) continue;
    const style = STYLES[si]!;
    const bake = new Float32Array(b.count * 4);
    const color = new Float32Array(b.count * 3);
    const idxs = bakeIdx[si]!;
    for (let vi = 0; vi < b.count; vi++) {
      const r = idxs[vi]! * 5;
      const ao = results[r]!, lit = results[r + 1]!, lr = results[r + 2]!, lg = results[r + 3]!, lb = results[r + 4]!;
      bake[vi * 4] = lr; bake[vi * 4 + 1] = lg; bake[vi * 4 + 2] = lb; bake[vi * 4 + 3] = ao;
      // Fully baked lighting for the low tier (unlit material x this colour).
      const k = b.nrm[vi * 3 + 1]! * 0.5 + 0.5;
      const amb = (LIGHTING.hemiIntensity * ao) / Math.PI, key = (LIGHTING.sunIntensity * lit) / Math.PI;
      color[vi * 3] = (hemiGround.r + (hemiSky.r - hemiGround.r) * k) * amb + sunC.r * key + lr + 0.03;
      color[vi * 3 + 1] = (hemiGround.g + (hemiSky.g - hemiGround.g) * k) * amb + sunC.g * key + lg + 0.03;
      color[vi * 3 + 2] = (hemiGround.b + (hemiSky.b - hemiGround.b) * k) * amb + sunC.b * key + lb + 0.035;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setAttribute('bake', new THREE.BufferAttribute(bake, 4));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    g.setIndex(b.count > 65535 ? new THREE.Uint32BufferAttribute(b.idx, 1) : new THREE.Uint16BufferAttribute(b.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    const t = tex[style.tex];
    const std = new THREE.MeshStandardMaterial({
      map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap, color: style.tint,
      roughness: style.rough, metalness: style.metal, normalScale: new THREE.Vector2(style.normal, style.normal),
    });
    injectBake(std);
    const basic = new THREE.MeshBasicMaterial({ map: t.map, color: style.tint, vertexColors: true });
    const mesh = new THREE.Mesh(g, quality === 'low' ? basic : std);
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    surfMeshes.push({ mesh, std, basic });
  }

  // ---- emissive strips --------------------------------------------------------------------
  {
    const gb = new Builder();
    const cols: number[] = [];
    const none: UvFn = (_x, _y, _z, o) => { o[0] = 0; o[1] = 0; };
    for (const b of glowBoxes) {
      col.setHex(b.glow);
      for (let a = 0; a < 3; a++) {
        for (const s of [1, -1]) {
          const rects = faceRects(b, a, s, covers, false);
          const c = s > 0 ? b.max[a]! : b.min[a]!;
          for (let i = 0; i < rects.length; i += 4) {
            const before = gb.count;
            emitGrid(gb, a, s, c, [rects[i]!, rects[i + 2]!], [rects[i + 1]!, rects[i + 3]!], none);
            for (let k = before; k < gb.count; k++) cols.push(col.r, col.g, col.b);
          }
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(gb.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    g.setIndex(gb.idx);
    // HDR-bright so the bloom pass picks them up; they also read fine without bloom.
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    m.color.setScalar(2.6);
    const mesh = new THREE.Mesh(g, m);
    mesh.matrixAutoUpdate = false;
    mesh.name = 'glow';
    group.add(mesh);
  }

  // ---- decals: site markings and signage ----------------------------------------------------
  {
    const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0], Zn: V3 = [0, 0, -1];
    // Site outlines: four non-overlapping bars per site.
    const p: number[] = [], uv: number[] = [], ix: number[] = [], cols: number[] = [];
    map.sites.forEach((site, si) => {
      const z = site.zone, t = 0.14, y = 0.012;
      col.setHex(SITE_COLORS[si]!);
      const bar = (cx: number, cz: number, w: number, d: number): void => {
        quad(p, uv, ix, cx, y, cz, X, Zn, w, d);
        for (let k = 0; k < 4; k++) cols.push(col.r, col.g, col.b);
      };
      const w = z.maxX - z.minX, d = z.maxZ - z.minZ;
      bar((z.minX + z.maxX) / 2, z.minZ + t / 2, w, t);
      bar((z.minX + z.maxX) / 2, z.maxZ - t / 2, w, t);
      bar(z.minX + t / 2, (z.minZ + z.maxZ) / 2, t, d - 2 * t);
      bar(z.maxX - t / 2, (z.minZ + z.maxZ) / 2, t, d - 2 * t);
    });
    const om = decalMaterial({ vertexColors: true, transparent: false, fog: false });
    om.color.setScalar(2.2);
    const outlines = decalMesh(p, uv, ix, om);
    outlines.geometry.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    group.add(outlines);

    // Site letters: one on open floor inside the zone, one on a wall that faces the site.
    const dressing = [...decor, ...glowBoxes];
    map.sites.forEach((site, si) => {
      const z = site.zone;
      const lp: number[] = [], luv: number[] = [], lix: number[] = [];
      // Floor: the clear square nearest the site centre.
      for (let L = Math.min(3.2, z.maxX - z.minX - 1, z.maxZ - z.minZ - 1); L >= 1.4 && lp.length === 0; L -= 0.6) {
        let best = Infinity, bx = 0, bz = 0;
        for (let x = z.minX + L / 2 + 0.3; x <= z.maxX - L / 2 - 0.3; x += 0.4) {
          for (let zz = z.minZ + L / 2 + 0.3; zz <= z.maxZ - L / 2 - 0.3; zz += 0.4) {
            const d = Math.hypot(x - site.center.x, zz - site.center.z);
            if (d >= best) continue;
            if (intersectsAny(covers, x - L / 2 - 0.15, 0.02, zz - L / 2 - 0.15, x + L / 2 + 0.15, 0.3, zz + L / 2 + 0.15, null)) continue;
            best = d; bx = x; bz = zz;
          }
        }
        if (best < Infinity) quad(lp, luv, lix, bx, 0.012, bz, X, Zn, L, L);
      }
      // Wall: nearest clear patch of wall looking at the site.
      const SW = 2.2, y0 = 1.5, y1 = 3.7;
      let best = Infinity;
      let bestQuad: (() => void) | null = null;
      const zc: V3 = [site.center.x, 0, site.center.z];
      for (const w of solids) {
        for (const a of [0, 2]) {
          const hAxis = a === 0 ? 2 : 0;
          for (const s of [1, -1]) {
            const c = s > 0 ? w.max[a]! : w.min[a]!;
            const facing = (zc[a]! - c) * s;
            if (facing < 0.5 || facing > 16) continue;
            const rects = faceRects(w, a, s, covers, true);
            for (let i = 0; i < rects.length; i += 4) {
              // a = 0: (u, v) = (Y, Z);  a = 2: (u, v) = (X, Y).
              const ylo = a === 0 ? rects[i]! : rects[i + 1]!, yhi = a === 0 ? rects[i + 2]! : rects[i + 3]!;
              const hlo = a === 0 ? rects[i + 1]! : rects[i]!, hhi = a === 0 ? rects[i + 3]! : rects[i + 2]!;
              if (ylo > y0 - 0.15 || yhi < y1 + 0.15 || hhi - hlo < SW + 0.4) continue;
              for (let h = hlo + SW / 2 + 0.2; h <= hhi - SW / 2 - 0.2; h += 0.5) {
                const score = Math.abs(h - zc[hAxis]!) + facing * 0.6;
                if (score >= best) continue;
                const lo: V3 = [0, y0, 0], hi: V3 = [0, y1, 0];
                lo[a] = s > 0 ? c + 0.005 : c - 0.7; hi[a] = s > 0 ? c + 0.7 : c - 0.005;
                lo[hAxis] = h - SW / 2; hi[hAxis] = h + SW / 2;
                if (intersectsAny(covers, lo[0], lo[1], lo[2], hi[0], hi[1], hi[2], w)) continue;
                if (intersectsAny(dressing, lo[0], lo[1] - 0.1, lo[2], hi[0], hi[1] + 0.1, hi[2], null)) continue;
                best = score;
                bestQuad = (): void => {
                  const p3: V3 = [0, (y0 + y1) / 2, 0];
                  p3[a] = c + s * 0.012; p3[hAxis] = h;
                  // Horizontal axis of the quad chosen so the letter is not mirrored.
                  const ux: V3 = a === 0 ? [0, 0, -s] : [s, 0, 0];
                  quad(lp, luv, lix, p3[0], p3[1], p3[2], ux, Y, SW, SW);
                };
              }
            }
          }
        }
      }
      (bestQuad as (() => void) | null)?.();
      if (lp.length === 0) return;
      const lm = decalMaterial({ map: letterTexture(site.name), color: SITE_COLORS[si], opacity: 0.9, fog: false });
      lm.color.multiplyScalar(1.5);
      group.add(decalMesh(lp, luv, lix, lm));
    });
  }

  // ---- the light at a point ----------------------------------------------------------------------
  // What the bake knows, asked of a point in the air: used to light what is not baked, the
  // weapon in the player's hands, by the place they stand in.
  // (rays stop just under the unseen lid over the whole arena, which only keeps players in)
  let lid = Infinity;
  for (const b of map.boxes) if (b.hidden && b.maxX - b.minX > 30 && b.maxZ - b.minZ > 30) lid = Math.min(lid, b.minY);
  const lightAt: LightProbe = (px, py, pz, out) => {
    const up = Math.max(0.5, Math.min(140, lid - 0.05 - py));
    let open = 0;
    const ts = up / sun.y;
    for (let k = 0; k < 3; k++) {
      const o = (k - 1) * 0.18;
      if (!occ.blocked(px + o, py, pz - o, px + o + sun.x * ts, py + sun.y * ts, pz - o + sun.z * ts)) open += 1 / 3;
    }
    let sky = 0;
    for (let k = 0; k < 4; k++) {
      const jx = k & 1 ? 0.38 : -0.38, jz = k & 2 ? 0.38 : -0.38;
      if (!occ.blocked(px, py, pz, px + jx * up, py + up, pz + jz * up)) sky += 0.25;
    }
    let lr = 0, lg = 0, lb = 0, dx = 0, dy = 0, dz = 0;
    const cx = Math.floor((px - wmin[0]) / LC), cz = Math.floor((pz - wmin[2]) / LC);
    for (let gz = cz - 1; gz <= cz + 1; gz++) {
      if (gz < 0 || gz >= lgh) continue;
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        if (gx < 0 || gx >= lgw) continue;
        for (const li of lightCells[gz * lgw + gx]!) {
          const L = lights[li]!;
          const ex = L.x - px, ey = L.y - py, ez = L.z - pz;
          const d2 = ex * ex + ey * ey + ez * ez;
          if (d2 > LIGHT_RANGE * LIGHT_RANGE) continue;
          const win = 1 - d2 / (LIGHT_RANGE * LIGHT_RANGE);
          const e = (win * win) / (d2 + 0.7);
          if (e < 0.002 || occ.blocked(px, py, pz, L.x, L.y, L.z)) continue;
          lr += L.r * e; lg += L.g * e; lb += L.b * e;
          const w = (L.r + L.g + L.b) * e / Math.sqrt(d2 + 1e-6);
          dx += ex * w; dy += ey * w; dz += ez * w;
        }
      }
    }
    const dl = Math.hypot(dx, dy, dz) || 1;
    out.sun = open; out.sky = sky; out.r = lr; out.g = lg; out.b = lb;
    out.dx = dx / dl; out.dy = dy / dl; out.dz = dz / dl;
    return out;
  };
  group.userData['lightAt'] = lightAt;

  // ---- quality switching -----------------------------------------------------------------------
  group.userData['onQuality'] = (q: Quality): void => {
    for (const s of surfMeshes) s.mesh.material = q === 'low' ? s.basic : s.std;
  };
  group.userData['stats'] = { vertices: total, samples: results.length / 5, lights: lights.length };
  group.updateMatrixWorld(true);
  onProgress?.(1);
  return group;
}
