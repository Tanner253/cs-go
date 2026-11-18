// Weapons on the floor, as Counter-Strike's: thrown from the hands with G (or dropped by the
// dead, or by buying another gun for the same slot), they fall under full gravity, clatter and
// slide to a stop. Walking over one picks it up if that slot is empty; E, looking at one (or
// standing on it), swaps it for the gun in that slot. Whatever is on the floor is cleared when
// the next round starts.

import { World, newTrace } from './world';
import { GRAVITY } from './movement';
import type { WeaponState, SimEvent } from './types';

export interface Drop {
  id: number;
  /** The gun (or grenade) as it left the hands: its magazine, reserve and suppressor with it. */
  weapon: WeaponState;
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  /** Which way it lies (radians about the vertical) and how fast it turns while flying. */
  yaw: number;
  spin: number;
  /** 0 flying, 1 at rest. */
  state: 0 | 1;
  /** Who let go of it, and until when (sim time) they cannot take it straight back. */
  owner: number;
  ownerUntil: number;
}

/** Half size of the box a dropped gun is swept as (it lies flat: wide, thin). */
export const DROP_R = 0.06;
const DROP_H = 0.03;
/** Share of the speed into a surface kept through a bounce, and of the speed along it. */
const BOUNCE = 0.22;
const SLIDE = 0.55;
/** A thrown gun: speed out of the hand along the aim. */
export const TOSS_SPEED = 4.2;
/** Most guns on the floor at once (the oldest goes first). */
export const MAX_DROPS = 40;
/** How close to the feet one must be to walk over one, and to reach one with E. */
export const TOUCH_R = 0.75;
export const REACH = 2.4;

const tr = newTrace();

/** One tick of a gun falling, bouncing and sliding to rest. */
export function flyDrop(d: Drop, world: World, dt: number, events: SimEvent[]): void {
  const { pos, vel } = d;
  if (d.state === 1) {
    world.traceHull(pos.x, pos.y, pos.z, pos.x, pos.y - 0.02, pos.z, DROP_R, DROP_H, DROP_R, tr);
    if (tr.hit) return;
    d.state = 0;
  }
  vel.y -= GRAVITY * dt;
  d.yaw += d.spin * dt;
  let t = dt;
  for (let i = 0; i < 4 && t > 1e-6; i++) {
    world.traceHull(pos.x, pos.y, pos.z, pos.x + vel.x * t, pos.y + vel.y * t, pos.z + vel.z * t, DROP_R, DROP_H, DROP_R, tr);
    if (tr.startSolid) {
      pos.y += 0.02;
      continue;
    }
    pos.x += vel.x * t * tr.fraction;
    pos.y += vel.y * t * tr.fraction;
    pos.z += vel.z * t * tr.fraction;
    if (!tr.hit) break;
    t *= 1 - tr.fraction;
    const vn = vel.x * tr.nx + vel.y * tr.ny + vel.z * tr.nz;
    if (vn >= 0) continue;
    // Off the surface: a little of the speed into it comes back, most of the speed along it is kept.
    const tx = vel.x - vn * tr.nx, ty = vel.y - vn * tr.ny, tz = vel.z - vn * tr.nz;
    vel.x = tx * SLIDE - vn * tr.nx * BOUNCE;
    vel.y = ty * SLIDE - vn * tr.ny * BOUNCE;
    vel.z = tz * SLIDE - vn * tr.nz * BOUNCE;
    d.spin *= 0.5;
    if (-vn > 1.1) events.push({ type: 'clatter', id: d.id, x: pos.x, y: pos.y, z: pos.z, speed: -vn });
    if (tr.ny > 0.7 && Math.hypot(vel.x, vel.y, vel.z) < 0.9) {
      vel.x = vel.y = vel.z = 0;
      d.spin = 0;
      d.state = 1;
      break;
    }
  }
}

/** What a gun is worth to whoever might pick it up: its price, nothing once it is empty. */
export function worth(w: WeaponState | null | undefined): number {
  if (!w) return 0;
  if (w.def.magSize > 0 && w.mag + w.reserve <= 0) return 0;
  return w.def.price;
}
