// Static collision world made of axis-aligned boxes ("brushes").
// Players are axis-aligned hulls, so every query is a slab test: cheap, exact and deterministic.

export interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  /** Material id, used by the renderer and for impact effects. */
  mat: number;
  /** Decorative boxes (light strips, floor markings) are rendered but never collide. */
  noCollide?: boolean;
  /** Collides but is never drawn (play-space ceiling). */
  hidden?: boolean;
}

export interface Trace {
  /** 0..1 portion of the move completed before hitting something. */
  fraction: number;
  nx: number;
  ny: number;
  nz: number;
  startSolid: boolean;
  hit: boolean;
}

export interface RayHit {
  dist: number;
  nx: number;
  ny: number;
  nz: number;
  box: number;
}

export const newTrace = (): Trace => ({ fraction: 1, nx: 0, ny: 0, nz: 0, startSolid: false, hit: false });
export const newRayHit = (): RayHit => ({ dist: Infinity, nx: 0, ny: 0, nz: 0, box: -1 });

/** Distance we stop short of a surface so hulls never rest exactly on a plane. */
const SKIN = 0.001;

export class World {
  readonly boxes: Box[];
  readonly min = { x: Infinity, y: Infinity, z: Infinity };
  readonly max = { x: -Infinity, y: -Infinity, z: -Infinity };

  constructor(all: Box[]) {
    this.boxes = all.filter((b) => !b.noCollide);
    for (const b of this.boxes) {
      this.min.x = Math.min(this.min.x, b.minX);
      this.min.y = Math.min(this.min.y, b.minY);
      this.min.z = Math.min(this.min.z, b.minZ);
      this.max.x = Math.max(this.max.x, b.maxX);
      this.max.y = Math.max(this.max.y, b.maxY);
      this.max.z = Math.max(this.max.z, b.maxZ);
    }
  }

  /**
   * Sweep an axis-aligned hull (given by its centre and half extents) from s to e.
   */
  traceHull(
    sx: number, sy: number, sz: number,
    ex: number, ey: number, ez: number,
    hx: number, hy: number, hz: number,
    out: Trace,
  ): Trace {
    const dx = ex - sx, dy = ey - sy, dz = ez - sz;
    let best = 1;
    let bnx = 0, bny = 0, bnz = 0;
    let hit = false;
    let startSolid = false;

    // Swept bounds for a quick reject.
    const loX = Math.min(sx, ex) - hx, hiX = Math.max(sx, ex) + hx;
    const loY = Math.min(sy, ey) - hy, hiY = Math.max(sy, ey) + hy;
    const loZ = Math.min(sz, ez) - hz, hiZ = Math.max(sz, ez) + hz;

    const boxes = this.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      if (b.minX >= hiX || b.maxX <= loX || b.minY >= hiY || b.maxY <= loY || b.minZ >= hiZ || b.maxZ <= loZ) continue;

      // Expand the box by the hull, then intersect a ray with it.
      const mnX = b.minX - hx, mxX = b.maxX + hx;
      const mnY = b.minY - hy, mxY = b.maxY + hy;
      const mnZ = b.minZ - hz, mxZ = b.maxZ + hz;

      let tEnter = -Infinity, tExit = Infinity;
      let axis = -1, sign = 0;

      // X
      if (dx > -1e-9 && dx < 1e-9) {
        if (sx <= mnX || sx >= mxX) continue;
      } else {
        const inv = 1 / dx;
        let t1 = (mnX - sx) * inv, t2 = (mxX - sx) * inv, sg = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
        if (t1 > tEnter) { tEnter = t1; axis = 0; sign = sg; }
        if (t2 < tExit) tExit = t2;
        if (tEnter >= tExit) continue;
      }
      // Y
      if (dy > -1e-9 && dy < 1e-9) {
        if (sy <= mnY || sy >= mxY) continue;
      } else {
        const inv = 1 / dy;
        let t1 = (mnY - sy) * inv, t2 = (mxY - sy) * inv, sg = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
        if (t1 > tEnter) { tEnter = t1; axis = 1; sign = sg; }
        if (t2 < tExit) tExit = t2;
        if (tEnter >= tExit) continue;
      }
      // Z
      if (dz > -1e-9 && dz < 1e-9) {
        if (sz <= mnZ || sz >= mxZ) continue;
      } else {
        const inv = 1 / dz;
        let t1 = (mnZ - sz) * inv, t2 = (mxZ - sz) * inv, sg = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
        if (t1 > tEnter) { tEnter = t1; axis = 2; sign = sg; }
        if (t2 < tExit) tExit = t2;
        if (tEnter >= tExit) continue;
      }

      if (tExit <= 0) continue;
      if (axis === -1 || tEnter < 0) {
        // The hull centre starts inside the expanded box.
        startSolid = true;
        best = 0;
        hit = true;
        bnx = 0; bny = 1; bnz = 0;
        continue;
      }
      if (tEnter < best) {
        best = tEnter;
        hit = true;
        bnx = axis === 0 ? sign : 0;
        bny = axis === 1 ? sign : 0;
        bnz = axis === 2 ? sign : 0;
      }
    }

    if (hit && !startSolid) {
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      best = len > 0 ? Math.max(0, best - SKIN / len) : 0;
    }
    out.fraction = best;
    out.nx = bnx; out.ny = bny; out.nz = bnz;
    out.hit = hit;
    out.startSolid = startSolid;
    return out;
  }

  /** True if a hull at this centre overlaps any solid. */
  hullBlocked(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): boolean {
    const boxes = this.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      if (
        cx + hx > b.minX && cx - hx < b.maxX &&
        cy + hy > b.minY && cy - hy < b.maxY &&
        cz + hz > b.minZ && cz - hz < b.maxZ
      ) return true;
    }
    return false;
  }

  /**
   * Nearest ray hit. `d` must be normalised. Boxes the ray starts inside are skipped
   * (use `skipBox` to continue a penetrating bullet out the far side).
   */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number, out: RayHit, skipBox = -1,
  ): boolean {
    let best = maxDist;
    let found = false;
    const boxes = this.boxes;
    for (let i = 0; i < boxes.length; i++) {
      if (i === skipBox) continue;
      const b = boxes[i]!;
      let tEnter = -Infinity, tExit = Infinity;
      let axis = -1, sign = 0;

      if (dx > -1e-9 && dx < 1e-9) {
        if (ox <= b.minX || ox >= b.maxX) continue;
      } else {
        const inv = 1 / dx;
        let t1 = (b.minX - ox) * inv, t2 = (b.maxX - ox) * inv, sg = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
        if (t1 > tEnter) { tEnter = t1; axis = 0; sign = sg; }
        if (t2 < tExit) tExit = t2;
        if (tEnter >= tExit) continue;
      }
      if (dy > -1e-9 && dy < 1e-9) {
        if (oy <= b.minY || oy >= b.maxY) continue;
      } else {
        const inv = 1 / dy;
        let t1 = (b.minY - oy) * inv, t2 = (b.maxY - oy) * inv, sg = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
        if (t1 > tEnter) { tEnter = t1; axis = 1; sign = sg; }
        if (t2 < tExit) tExit = t2;
        if (tEnter >= tExit) continue;
      }
      if (dz > -1e-9 && dz < 1e-9) {
        if (oz <= b.minZ || oz >= b.maxZ) continue;
      } else {
        const inv = 1 / dz;
        let t1 = (b.minZ - oz) * inv, t2 = (b.maxZ - oz) * inv, sg = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
        if (t1 > tEnter) { tEnter = t1; axis = 2; sign = sg; }
        if (t2 < tExit) tExit = t2;
        if (tEnter >= tExit) continue;
      }

      if (tEnter < 0 || tEnter >= best) continue;
      best = tEnter;
      found = true;
      out.box = i;
      out.nx = axis === 0 ? sign : 0;
      out.ny = axis === 1 ? sign : 0;
      out.nz = axis === 2 ? sign : 0;
    }
    out.dist = found ? best : maxDist;
    if (!found) out.box = -1;
    return found;
  }

  /** Distance along the ray at which it leaves the given box (for wall penetration). */
  exitDistance(box: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    const b = this.boxes[box]!;
    let tExit = Infinity;
    if (dx > 1e-9 || dx < -1e-9) tExit = Math.min(tExit, Math.max((b.minX - ox) / dx, (b.maxX - ox) / dx));
    if (dy > 1e-9 || dy < -1e-9) tExit = Math.min(tExit, Math.max((b.minY - oy) / dy, (b.maxY - oy) / dy));
    if (dz > 1e-9 || dz < -1e-9) tExit = Math.min(tExit, Math.max((b.minZ - oz) / dz, (b.maxZ - oz) / dz));
    return tExit;
  }

  /** Line of sight between two points (true = clear). */
  private losHit = newRayHit();
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) return true;
    const inv = 1 / len;
    return !this.raycast(ax, ay, az, dx * inv, dy * inv, dz * inv, len, this.losHit);
  }
}
