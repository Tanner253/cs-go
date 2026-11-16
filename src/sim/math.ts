// Shared math helpers. Everything under src/sim is engine-agnostic (no DOM, no three.js)
// so the same code can run on an authoritative server.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const copy3 = (out: Vec3, a: Vec3): Vec3 => {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
};

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Signed shortest difference `to - from`. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

export function dist2D(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

/**
 * Angle convention (matches a three.js camera with rotation order YXZ):
 * yaw 0 looks down -Z, positive yaw turns left; positive pitch looks up.
 */
export function forwardFromAngles(yaw: number, pitch: number, out: Vec3): Vec3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

export function yawTo(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return Math.atan2(-(toX - fromX), -(toZ - fromZ));
}

/** Small, fast, deterministic PRNG (mulberry32). */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  reseed(seed: number): void {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)]!;
  }
}
