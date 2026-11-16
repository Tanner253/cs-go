// Grid navigation built automatically from the collision world.
// A flood fill from the spawn points probes every neighbouring cell with the real player
// hull, so the graph is exactly "where a player can walk". Paths are A* + string pulling.

import { World, newTrace } from './world';
import type { Rng, Vec3 } from './math';
import { HEIGHT_STAND, HULL_HALF } from './types';

const STEP_UP = 0.46;
const MAX_DROP = 1.05;
const HY = HEIGHT_STAND / 2;

export class Nav {
  readonly cell: number;
  readonly w: number;
  readonly h: number;
  readonly ox: number;
  readonly oz: number;
  /** Floor height per cell, NaN where not walkable. */
  readonly height: Float32Array;
  /** 1 where the cell touches something unwalkable (used to keep paths off walls). */
  readonly edge: Uint8Array;
  nodeCount = 0;

  private g: Float32Array;
  private came: Int32Array;
  private stamp: Uint32Array;
  private closed: Uint32Array;
  private gen = 0;
  private heap: number[] = [];
  private heapF: number[] = [];

  constructor(world: World, seeds: Vec3[], cell = 0.5) {
    this.cell = cell;
    this.ox = world.min.x;
    this.oz = world.min.z;
    this.w = Math.ceil((world.max.x - world.min.x) / cell);
    this.h = Math.ceil((world.max.z - world.min.z) / cell);
    const n = this.w * this.h;
    this.height = new Float32Array(n).fill(NaN);
    this.edge = new Uint8Array(n);
    this.g = new Float32Array(n);
    this.came = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.build(world, seeds);
  }

  private build(world: World, seeds: Vec3[]): void {
    const tr = newTrace();
    const queue: number[] = [];
    const { w, h, cell, height } = this;

    for (const s of seeds) {
      const i = this.index(s.x, s.z);
      if (i < 0 || !Number.isNaN(height[i]!)) continue;
      const cx = this.cx(i), cz = this.cz(i);
      world.traceHull(cx, s.y + STEP_UP + HY, cz, cx, s.y - 1 + HY, cz, HULL_HALF, HY, HULL_HALF, tr);
      if (tr.startSolid || !tr.hit) continue;
      height[i] = s.y + STEP_UP - (STEP_UP + 1) * tr.fraction;
      queue.push(i);
    }

    const dirs = [1, -1, w, -w];
    for (let q = 0; q < queue.length; q++) {
      const a = queue[q]!;
      const ax = a % w, az = (a / w) | 0;
      const ha = height[a]!;
      for (let d = 0; d < 4; d++) {
        if ((d === 0 && ax === w - 1) || (d === 1 && ax === 0) || (d === 2 && az === h - 1) || (d === 3 && az === 0)) continue;
        const b = a + dirs[d]!;
        if (!Number.isNaN(height[b]!)) continue;
        const bx = this.cx(b), bz = this.cz(b);
        const top = ha + STEP_UP + HY;
        const bottom = ha - MAX_DROP + HY;
        world.traceHull(bx, top, bz, bx, bottom, bz, HULL_HALF, HY, HULL_HALF, tr);
        if (tr.startSolid || !tr.hit || tr.ny < 0.7) continue;
        height[b] = top + (bottom - top) * tr.fraction - HY;
        queue.push(b);
      }
    }
    this.nodeCount = queue.length;

    for (let i = 0; i < w * h; i++) {
      const hi = height[i]!;
      if (Number.isNaN(hi)) continue;
      const x = i % w, z = (i / w) | 0;
      let e = 0;
      for (let dz = -1; dz <= 1 && !e; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= w || nz >= h) { e = 1; break; }
          const hn = height[nz * w + nx]!;
          if (Number.isNaN(hn) || Math.abs(hn - hi) > STEP_UP) { e = 1; break; }
        }
      }
      this.edge[i] = e;
    }
    void cell;
  }

  index(x: number, z: number): number {
    const ix = Math.floor((x - this.ox) / this.cell);
    const iz = Math.floor((z - this.oz) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.h) return -1;
    return iz * this.w + ix;
  }
  cx(i: number): number {
    return this.ox + ((i % this.w) + 0.5) * this.cell;
  }
  cz(i: number): number {
    return this.oz + (((i / this.w) | 0) + 0.5) * this.cell;
  }
  walkable(i: number): boolean {
    return i >= 0 && !Number.isNaN(this.height[i]!);
  }

  /** Nearest walkable cell to a point (searches outward a few metres). */
  nearest(x: number, z: number, y = NaN): number {
    const i0 = this.index(x, z);
    if (this.walkable(i0) && (Number.isNaN(y) || Math.abs(this.height[i0]! - y) < 1.2)) return i0;
    const ix = Math.floor((x - this.ox) / this.cell);
    const iz = Math.floor((z - this.oz) / this.cell);
    let best = -1, bestD = Infinity;
    const R = 8;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const nx = ix + dx, nz = iz + dz;
        if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.h) continue;
        const i = nz * this.w + nx;
        const hi = this.height[i]!;
        if (Number.isNaN(hi)) continue;
        let d = dx * dx + dz * dz;
        if (!Number.isNaN(y)) d += (hi - y) * (hi - y) * 4;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    return best;
  }

  private canStep(a: number, b: number): boolean {
    const hb = this.height[b]!;
    if (Number.isNaN(hb)) return false;
    const d = hb - this.height[a]!;
    return d <= STEP_UP && d >= -MAX_DROP;
  }

  // ---- binary heap keyed by f ---------------------------------------------------
  private push(i: number, f: number): void {
    const heap = this.heap, hf = this.heapF;
    let k = heap.length;
    heap.push(i);
    hf.push(f);
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (hf[p]! <= f) break;
      heap[k] = heap[p]!; hf[k] = hf[p]!;
      k = p;
    }
    heap[k] = i; hf[k] = f;
  }
  private pop(): number {
    const heap = this.heap, hf = this.heapF;
    const top = heap[0]!;
    const li = heap.pop()!, lf = hf.pop()!;
    const n = heap.length;
    if (n > 0) {
      let k = 0;
      for (;;) {
        let c = k * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && hf[c + 1]! < hf[c]!) c++;
        if (hf[c]! >= lf) break;
        heap[k] = heap[c]!; hf[k] = hf[c]!;
        k = c;
      }
      heap[k] = li; hf[k] = lf;
    }
    return top;
  }

  /** A* path between two world positions. Returns waypoints (excluding the start) or null. */
  findPath(from: Vec3, to: Vec3): Vec3[] | null {
    const start = this.nearest(from.x, from.z, from.y);
    const goal = this.nearest(to.x, to.z, to.y);
    if (start < 0 || goal < 0) return null;
    const { w, g, came, stamp, closed, height, edge, cell } = this;
    const gen = ++this.gen;
    this.heap.length = 0;
    this.heapF.length = 0;
    const gx = goal % w, gz = (goal / w) | 0;
    const hcost = (i: number): number => {
      const dx = Math.abs((i % w) - gx), dz = Math.abs(((i / w) | 0) - gz);
      return (Math.max(dx, dz) + 0.4142 * Math.min(dx, dz)) * cell;
    };
    g[start] = 0;
    came[start] = -1;
    stamp[start] = gen;
    this.push(start, hcost(start));
    let found = false;
    while (this.heap.length > 0) {
      const a = this.pop();
      if (closed[a] === gen) continue;
      closed[a] = gen;
      if (a === goal) { found = true; break; }
      const ax = a % w, az = (a / w) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = ax + dx, nz = az + dz;
          if (nx < 0 || nz < 0 || nx >= w || nz >= this.h) continue;
          const b = nz * w + nx;
          if (closed[b] === gen || !this.canStep(a, b)) continue;
          if (dx !== 0 && dz !== 0) {
            // No cutting corners.
            if (!this.canStep(a, az * w + nx) || !this.canStep(a, nz * w + ax)) continue;
          }
          const step = (dx !== 0 && dz !== 0 ? 1.4142 : 1) * cell * (edge[b] ? 2.2 : 1);
          const ng = g[a]! + step;
          if (stamp[b] !== gen || ng < g[b]!) {
            g[b] = ng;
            came[b] = a;
            stamp[b] = gen;
            this.push(b, ng + hcost(b));
          }
        }
      }
    }
    if (!found) return null;

    const cells: number[] = [];
    for (let c = goal; c !== -1; c = came[c]!) cells.push(c);
    cells.reverse();

    // String pulling: skip ahead while a straight, flat, wall-clear line exists.
    const out: Vec3[] = [];
    let anchor = 0;
    while (anchor < cells.length - 1) {
      let next = anchor + 1;
      for (let j = Math.min(cells.length - 1, anchor + 40); j > anchor + 1; j--) {
        if (this.clearLine(cells[anchor]!, cells[j]!)) { next = j; break; }
      }
      const c = cells[next]!;
      out.push({ x: this.cx(c), y: height[c]!, z: this.cz(c) });
      anchor = next;
    }
    if (out.length > 0 && this.index(to.x, to.z) === goal) {
      const last = out[out.length - 1]!;
      last.x = to.x;
      last.z = to.z;
    }
    return out;
  }

  private clearLine(a: number, b: number): boolean {
    const ax = this.cx(a), az = this.cz(a), bx = this.cx(b), bz = this.cz(b);
    const ha = this.height[a]!;
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.ceil(len / (this.cell * 0.5));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const i = this.index(ax + (bx - ax) * t, az + (bz - az) * t);
      if (i < 0) return false;
      const hi = this.height[i]!;
      if (Number.isNaN(hi) || this.edge[i] || Math.abs(hi - ha) > 0.05) return false;
    }
    return Math.abs(this.height[b]! - ha) <= 0.05;
  }

  /** Random walkable point within `radius` of a position (or null). */
  randomNear(x: number, z: number, radius: number, rng: Rng, y = NaN): Vec3 | null {
    for (let tries = 0; tries < 16; tries++) {
      const a = rng.next() * Math.PI * 2;
      const r = Math.sqrt(rng.next()) * radius;
      const i = this.index(x + Math.cos(a) * r, z + Math.sin(a) * r);
      if (!this.walkable(i) || this.edge[i]) continue;
      if (!Number.isNaN(y) && Math.abs(this.height[i]! - y) > 1.2) continue;
      return { x: this.cx(i), y: this.height[i]!, z: this.cz(i) };
    }
    return null;
  }
}
