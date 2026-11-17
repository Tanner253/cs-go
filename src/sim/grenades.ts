// Grenades in flight and on the ground, measured against Counter-Strike's: thrown at up to
// 17 m/s (a third of that underarm) plus some of the thrower's own speed, under 0.4 g, losing
// over half their speed at every bounce. HE and flashbangs go off 1.6 s after leaving the hand,
// smokes once they have come to rest, fire on first touching the floor.

import { World, newTrace } from './world';
import { GRAVITY } from './movement';
import { HULL_HALF, type Grenade, type Player, type SimEvent } from './types';

export const NADE_GRAVITY = GRAVITY * 0.4;
/** Share of its speed a grenade keeps through a bounce. */
const ELASTIC = 0.45;
/** Half size of the box a grenade is swept as. */
const R = 0.05;
/** Full overarm throw speed (m/s). */
const THROW_SPEED = 17.15;

export const FUSE = 1.6;
/** Pulling the pin: a throw asked for sooner leaves the hand once it is out. */
export const PIN_TIME = 0.3;
/** From release until the hand is back and the next grenade or gun comes up. */
export const THROW_TIME = 0.45;

/** Smoke: grows for SMOKE_GROW, stands, and thins away over its last SMOKE_FADE seconds. */
export const SMOKE_LIFE = 18;
export const SMOKE_GROW = 1.3;
export const SMOKE_FADE = 3;
/** Smoke cloud: an ellipsoid this wide (radius) and tall (half height), its middle this high off the floor. */
export const SMOKE_RH = 3.3;
export const SMOKE_RV = 1.75;
export const SMOKE_LIFT = 1.45;

export const FIRE_LIFE = 7;
export const FIRE_GROW = 0.7;
export const FIRE_R = 2.3;
/** Fire that has flown this long without finding a floor goes off where it is. */
export const FIRE_FUSE = 2;

const tr = newTrace();

/** Where a throw starts and how fast it goes. `str` 1 overarm, 0.5 both buttons, 0 underarm. */
export function throwFrom(p: Player, eye: number, str: number, world: World, pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }): void {
  // Counter-Strike lifts every throw by 10 degrees, squeezing the rest of the pitch range in.
  const pitch = (10 * Math.PI) / 180 + p.pitch * (80 / 90);
  const cp = Math.cos(pitch);
  const fx = -Math.sin(p.yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(p.yaw) * cp;
  const speed = THROW_SPEED * (0.3 + 0.7 * str);
  vel.x = fx * speed + p.vel.x * 1.25;
  vel.y = fy * speed + p.vel.y * 1.25;
  vel.z = fz * speed + p.vel.z * 1.25;
  // Out of the hand a little ahead of the eye, never through a wall in the face.
  const sy = eye - 0.12 * (1 - str * 0.5);
  world.traceHull(p.pos.x, sy, p.pos.z, p.pos.x + fx * 0.5, sy + fy * 0.5, p.pos.z + fz * 0.5, R, R, R, tr);
  const f = Math.max(0, tr.fraction * 0.5 - 0.06) / 0.5;
  pos.x = p.pos.x + fx * 0.5 * f;
  pos.y = sy + fy * 0.5 * f;
  pos.z = p.pos.z + fz * 0.5 * f;
}

/**
 * One tick of flight. Returns true if the grenade struck a floor this tick (fire goes off on
 * that). Bounces off the level and off players' bodies.
 */
export function flyNade(g: Grenade, world: World, players: readonly Player[], now: number, dt: number, events: SimEvent[]): boolean {
  const { pos, vel } = g;
  let floor = false;
  if (g.state === 1) {
    // At rest: settle on whatever is below, and fall again if that goes away.
    world.traceHull(pos.x, pos.y, pos.z, pos.x, pos.y - 0.02, pos.z, R, R, R, tr);
    if (tr.hit) return false;
    g.state = 0;
  }
  vel.y -= NADE_GRAVITY * dt;
  let t = dt;
  for (let i = 0; i < 4 && t > 1e-6; i++) {
    world.traceHull(pos.x, pos.y, pos.z, pos.x + vel.x * t, pos.y + vel.y * t, pos.z + vel.z * t, R, R, R, tr);
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
    vel.x = (vel.x - 2 * vn * tr.nx) * ELASTIC;
    vel.y = (vel.y - 2 * vn * tr.ny) * ELASTIC;
    vel.z = (vel.z - 2 * vn * tr.nz) * ELASTIC;
    if (-vn > 1.2) events.push({ type: 'bounce', id: g.id, x: pos.x, y: pos.y, z: pos.z, speed: -vn });
    if (tr.ny > 0.7) {
      floor = true;
      // Rolling to a stop: a slow grenade on a floor stays put.
      if (Math.hypot(vel.x, vel.y, vel.z) < 0.6) {
        vel.x = vel.y = vel.z = 0;
        g.state = 1;
        break;
      }
    }
  }
  // Players' bodies: a grenade bounces off anyone it flies into (its thrower too, after a moment).
  for (const p of players) {
    if (!p.alive || (p.id === g.owner && now - g.born < 0.25)) continue;
    const dx = pos.x - p.pos.x, dz = pos.z - p.pos.z;
    if (Math.abs(dx) > HULL_HALF + R || Math.abs(dz) > HULL_HALF + R) continue;
    if (pos.y < p.pos.y || pos.y > p.pos.y + (p.ducked ? 1.37 : 1.83)) continue;
    if (dx * vel.x + dz * vel.z >= 0) continue;
    // Off the side it hit, losing most of its speed.
    if (Math.abs(dx) > Math.abs(dz)) vel.x = -vel.x * 0.3; else vel.z = -vel.z * 0.3;
    vel.y *= 0.5;
    events.push({ type: 'bounce', id: g.id, x: pos.x, y: pos.y, z: pos.z, speed: 2 });
    break;
  }
  return floor;
}

/** How much of the smoke is there at `now`: 0 before it goes off and after it is gone, 1 at full. */
export function smokeAmount(g: Grenade, now: number): number {
  if (g.state !== 2) return 0;
  const age = now - g.popAt, left = g.endAt - now;
  if (age < 0 || left <= 0) return 0;
  const grow = Math.min(1, age / SMOKE_GROW);
  return Math.min(1 - (1 - grow) * (1 - grow), left / SMOKE_FADE);
}

/** Length of the segment a..b that lies inside this smoke cloud (its size grown in). */
export function inSmoke(g: Grenade, now: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const k = smokeAmount(g, now);
  if (k <= 0) return 0;
  const age = now - g.popAt;
  const s = 0.35 + 0.65 * Math.min(1, age / SMOKE_GROW);
  const rh = SMOKE_RH * s, rv = SMOKE_RV * s;
  // Scale into a unit sphere.
  const ox = (ax - g.pos.x) / rh, oy = (ay - (g.pos.y + SMOKE_LIFT)) / rv, oz = (az - g.pos.z) / rh;
  const dx = (bx - ax) / rh, dy = (by - ay) / rv, dz = (bz - az) / rh;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-12) return 0;
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - 1;
  const disc = b * b - a * c;
  if (disc <= 0) return 0;
  const sq = Math.sqrt(disc);
  const t0 = Math.max(0, (-b - sq) / a), t1 = Math.min(1, (-b + sq) / a);
  if (t1 <= t0) return 0;
  return (t1 - t0) * Math.hypot(bx - ax, by - ay, bz - az) * k;
}
