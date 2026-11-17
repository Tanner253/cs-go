// Player movement: Quake/Source-lineage ground + air acceleration (counter-strafing,
// air-strafing and bunny hops fall out of the maths), plus the vertical kit:
// wall-jumps, ledge mantling and a grapple hook.

import { World, newTrace, newRayHit } from './world';
import { forwardFromAngles, lerp, type Vec3, v3 } from './math';
import {
  BTN_CROUCH, BTN_GRAPPLE, BTN_JUMP, BTN_WALK,
  EYE_CROUCH, EYE_STAND, HEIGHT_CROUCH, HEIGHT_STAND, HULL_HALF,
  type Cmd, type Player, type SimEvent,
} from './types';

export const GRAVITY = 20.32;
export const JUMP_SPEED = 7.67;
const ACCEL = 5.5;
const AIR_ACCEL = 12;
const AIR_CAP = 0.762;
const FRICTION = 5.2;
const STOP_SPEED = 2.03;
const STEP = 0.457;
const CROUCH_MULT = 0.34;
const WALK_MULT = 0.52;

// Counter-Strike's stamina (sv_stamina*): a jump costs 0.08 and a landing 0.05 per unit of
// vertical speed (inch/s), up to 80, bleeding off at 60 a second. While any is left, the
// player is slowed on the ground (by the fraction of 80 used, per 1/70 s) and jumps lower,
// which is what stops jump-spamming from being free and makes a landing cost a moment.
export const STAMINA_MAX = 80;
const STAMINA_JUMP = 0.08 / 0.0254;
const STAMINA_LAND = 0.05 / 0.0254;
const STAMINA_RECOVER = 60;

// Being shot ("tagging"): run speed is cut to this fraction, and grows back by TAG_RECOVER a second.
export const TAG_HEAVY = 0.5;
export const TAG_LIGHT = 0.65;
const TAG_RECOVER = 0.5;

// Crouch speed (crouchT per second). Every press of crouch spends DUCK_SPAM of it, growing
// back DUCK_REGROW a second, so the first crouch is quick and a spam of them slows to a crawl.
export const DUCK_FULL = 10;
const DUCK_RATE = 7;
const DUCK_SPAM = 3;
const DUCK_MIN = 1.5;
const DUCK_REGROW = 3;

/** Crouching in the air draws the feet up by half the difference and lowers the eyes by the other half. */
const AIR_TUCK = (HEIGHT_STAND - HEIGHT_CROUCH) / 2;

const WALLJUMP_UP = 7.0;
const WALLJUMP_PUSH = 5.4;
const MAX_WALLJUMPS = 2;
const MANTLE_MIN = 0.5;
const MANTLE_MAX = 1.95;
const MANTLE_TIME = 0.32;

export const GRAPPLE_RANGE = 26;
export const GRAPPLE_COOLDOWN = 7;
const GRAPPLE_SPEED = 15.5;
const GRAPPLE_MAX_TIME = 2.6;

const tr = newTrace();
const tr2 = newTrace();
const ray = newRayHit();
const tmp = v3();

export const eyeHeight = (p: Player): number => lerp(EYE_STAND, EYE_CROUCH, p.crouchT);
export const hullHeight = (p: Player): number => (p.ducked ? HEIGHT_CROUCH : HEIGHT_STAND);

/** Slide along surfaces for `dt`. Returns true if a wall (not floor/ceiling) blocked the move. */
function slide(p: Player, world: World, dt: number, hy: number): boolean {
  let t = dt;
  let blocked = false;
  const { pos, vel } = p;
  for (let i = 0; i < 4 && t > 1e-6; i++) {
    if (vel.x === 0 && vel.y === 0 && vel.z === 0) break;
    const cx = pos.x, cy = pos.y + hy, cz = pos.z;
    world.traceHull(cx, cy, cz, cx + vel.x * t, cy + vel.y * t, cz + vel.z * t, HULL_HALF, hy, HULL_HALF, tr);
    if (tr.startSolid) {
      // Wedged inside geometry (should be rare): lift until free.
      let freed = false;
      for (let k = 1; k <= 12; k++) {
        if (!world.hullBlocked(cx, cy + k * 0.05, cz, HULL_HALF, hy, HULL_HALF)) {
          pos.y += k * 0.05;
          freed = true;
          break;
        }
      }
      if (!freed) {
        vel.x = vel.y = vel.z = 0;
        return true;
      }
      continue;
    }
    const f = tr.fraction;
    pos.x += vel.x * t * f;
    pos.y += vel.y * t * f;
    pos.z += vel.z * t * f;
    if (!tr.hit) break;
    if (tr.ny < 0.7 && tr.ny > -0.7) blocked = true;
    // All surfaces are axis aligned, so clipping is zeroing one component.
    if (tr.nx !== 0 && vel.x * tr.nx < 0) vel.x = 0;
    if (tr.ny !== 0 && vel.y * tr.ny < 0) vel.y = 0;
    if (tr.nz !== 0 && vel.z * tr.nz < 0) vel.z = 0;
    t *= 1 - f;
  }
  return blocked;
}

function groundBelow(p: Player, world: World, hy: number, dist: number): boolean {
  const cy = p.pos.y + hy;
  world.traceHull(p.pos.x, cy, p.pos.z, p.pos.x, cy - dist, p.pos.z, HULL_HALF, hy, HULL_HALF, tr2);
  return tr2.hit && !tr2.startSolid && tr2.ny > 0.7;
}

function accelerate(p: Player, wx: number, wz: number, wishSpeed: number, accel: number, dt: number): void {
  const cur = p.vel.x * wx + p.vel.z * wz;
  const add = wishSpeed - cur;
  if (add <= 0) return;
  let a = accel * dt * wishSpeed;
  if (a > add) a = add;
  p.vel.x += wx * a;
  p.vel.z += wz * a;
}

/** Find a wall touching the hull. Walls are axis aligned, so four probes are exact. */
function findWall(p: Player, world: World, hy: number, out: { nx: number; nz: number }, wishX: number, wishZ: number): boolean {
  const cx = p.pos.x, cy = p.pos.y + hy, cz = p.pos.z;
  const reach = 0.3;
  let bestScore = -Infinity;
  let found = false;
  for (let i = 0; i < 4; i++) {
    const dx = i === 0 ? 1 : i === 1 ? -1 : 0;
    const dz = i === 2 ? 1 : i === 3 ? -1 : 0;
    world.traceHull(cx, cy, cz, cx + dx * reach, cy, cz + dz * reach, HULL_HALF, hy * 0.6, HULL_HALF, tr2);
    if (!tr2.hit || tr2.startSolid) continue;
    // Skip the wall we just jumped off so a single wall can't be climbed forever.
    if (p.wallJumps > 0 && -dx === p.lastWallNx && -dz === p.lastWallNz) continue;
    // Prefer the wall the player is moving or steering into.
    const score = (p.vel.x * dx + p.vel.z * dz) * 0.5 + (wishX * dx + wishZ * dz) * 4;
    if (score > bestScore) {
      bestScore = score;
      out.nx = -dx;
      out.nz = -dz;
      found = true;
    }
  }
  return found;
}

const wall = { nx: 0, nz: 0 };

function tryMantle(p: Player, world: World, hy: number, fx: number, fz: number): boolean {
  const cx = p.pos.x, cy = p.pos.y + hy, cz = p.pos.z;
  // Something solid directly ahead?
  world.traceHull(cx, cy, cz, cx + fx * 0.45, cy, cz + fz * 0.45, HULL_HALF, hy, HULL_HALF, tr2);
  if (!tr2.hit) return false;
  // Drop a hull from above onto whatever is ahead to find the ledge.
  const tx = cx + fx * 0.62, tz = cz + fz * 0.62;
  const topY = p.pos.y + MANTLE_MAX + hy;
  const lowY = p.pos.y + MANTLE_MIN + hy;
  world.traceHull(tx, topY, tz, tx, lowY, tz, HULL_HALF, hy, HULL_HALF, tr2);
  if (tr2.startSolid || !tr2.hit || tr2.ny < 0.7) return false;
  const ledgeFeet = topY + (lowY - topY) * tr2.fraction - hy;
  // Room to rise straight up to that height?
  world.traceHull(cx, cy, cz, cx, ledgeFeet + hy + 0.03, cz, HULL_HALF, hy, HULL_HALF, tr2);
  if (tr2.hit) return false;
  p.mantleT = 0;
  p.mantleFrom.x = p.pos.x; p.mantleFrom.y = p.pos.y; p.mantleFrom.z = p.pos.z;
  p.mantleTo.x = tx; p.mantleTo.y = ledgeFeet + 0.002; p.mantleTo.z = tz;
  p.vel.x = p.vel.y = p.vel.z = 0;
  return true;
}

export function endGrapple(p: Player, now: number, events: SimEvent[]): void {
  if (!p.grappleOn) return;
  p.grappleOn = false;
  p.grappleReadyAt = now + GRAPPLE_COOLDOWN;
  events.push({ type: 'grappleEnd', player: p.id });
}

/**
 * Advance one player by one tick. Returns the landing speed if the player hit the
 * ground this tick (for fall damage), otherwise 0.
 */
export function movePlayer(
  p: Player, cmd: Cmd, world: World, dt: number, maxSpeed: number,
  frozen: boolean, now: number, events: SimEvent[], vertical = false,
): number {
  const buttons = frozen ? cmd.buttons & BTN_CROUCH : cmd.buttons;
  const pressed = buttons & ~p.prevButtons;
  const { pos, vel } = p;

  // ---- mantle in progress: scripted climb ------------------------------------
  if (p.mantleT >= 0) {
    p.mantleT += dt / MANTLE_TIME;
    const t = Math.min(1, p.mantleT);
    const up = Math.min(1, t / 0.7);
    const fw = t < 0.35 ? 0 : (t - 0.35) / 0.65;
    const eu = 1 - (1 - up) * (1 - up);
    pos.x = lerp(p.mantleFrom.x, p.mantleTo.x, fw * fw * (3 - 2 * fw));
    pos.z = lerp(p.mantleFrom.z, p.mantleTo.z, fw * fw * (3 - 2 * fw));
    pos.y = lerp(p.mantleFrom.y, p.mantleTo.y, eu);
    if (t >= 1) {
      p.mantleT = -1;
      p.onGround = true;
      p.wallJumps = 0;
      vel.x = -Math.sin(p.yaw) * 1.5;
      vel.z = -Math.cos(p.yaw) * 1.5;
      vel.y = 0;
    }
    return 0;
  }

  if (p.stamina > 0) p.stamina = Math.max(0, p.stamina - STAMINA_RECOVER * dt);
  if (p.tag < 1) p.tag = Math.min(1, p.tag + TAG_RECOVER * dt);
  const runSpeed = maxSpeed;
  maxSpeed *= p.tag;

  // ---- crouch ------------------------------------------------------------------
  // On the ground the head comes down. In the air the legs come up as much as the head comes
  // down (the crouch-jump), so the feet clear AIR_TUCK more; crouchT is moved by as much as
  // keeps the eyes where they were, and from there it settles as usual.
  const air = !p.onGround;
  if (p.duckSpeed < DUCK_FULL) p.duckSpeed = Math.min(DUCK_FULL, p.duckSpeed + DUCK_REGROW * dt);
  if (pressed & BTN_CROUCH) p.duckSpeed = Math.max(DUCK_MIN, p.duckSpeed - DUCK_SPAM);
  if (buttons & BTN_CROUCH) {
    if (!p.ducked && air) {
      pos.y += AIR_TUCK;
      p.crouchT = Math.min(1, p.crouchT + 0.5);
    }
    p.ducked = true;
  } else if (p.ducked) {
    const drop = AIR_TUCK * p.crouchT;
    if (air && drop > 0 && !world.hullBlocked(pos.x, pos.y - drop + HEIGHT_STAND / 2, pos.z, HULL_HALF, HEIGHT_STAND / 2, HULL_HALF)) {
      pos.y -= drop;
      p.crouchT *= 0.5;
      p.ducked = false;
    } else if (!world.hullBlocked(pos.x, pos.y + HEIGHT_STAND / 2, pos.z, HULL_HALF, HEIGHT_STAND / 2, HULL_HALF)) {
      p.ducked = false;
    }
  }
  const crouchTarget = p.ducked ? 1 : 0;
  const cstep = dt * Math.min(DUCK_RATE, p.duckSpeed);
  p.crouchT = p.crouchT < crouchTarget ? Math.min(crouchTarget, p.crouchT + cstep) : Math.max(crouchTarget, p.crouchT - cstep);

  const hy = hullHeight(p) / 2;
  const wasGround = p.onGround;
  p.onGround = vel.y <= 0.1 && !p.grappleOn && groundBelow(p, world, hy, 0.03);

  // ---- wish direction ----------------------------------------------------------
  const sy = Math.sin(p.yaw), cyaw = Math.cos(p.yaw);
  const fx = -sy, fz = -cyaw; // forward
  const rx = cyaw, rz = -sy; // right
  let wx = 0, wz = 0, wishLen = 0;
  if (!frozen) {
    wx = fx * cmd.fwd + rx * cmd.side;
    wz = fz * cmd.fwd + rz * cmd.side;
    wishLen = Math.hypot(wx, wz);
    if (wishLen > 1e-4) {
      wx /= wishLen;
      wz /= wishLen;
      if (wishLen > 1) wishLen = 1;
    } else {
      wishLen = 0;
    }
  }
  let wishSpeed = maxSpeed * wishLen;
  if (p.ducked) wishSpeed *= CROUCH_MULT;
  else if (buttons & BTN_WALK) wishSpeed *= WALK_MULT;

  // ---- grapple -------------------------------------------------------------------
  if (vertical && pressed & BTN_GRAPPLE && !p.grappleOn && now >= p.grappleReadyAt) {
    const ey = pos.y + eyeHeight(p);
    forwardFromAngles(p.yaw, p.pitch, tmp);
    const ok = world.raycast(pos.x, ey, pos.z, tmp.x, tmp.y, tmp.z, GRAPPLE_RANGE, ray) && ray.dist > 2;
    if (ok && !world.boxes[ray.box]!.hidden) {
      p.grappleOn = true;
      p.grappleTime = now;
      p.grapplePoint.x = pos.x + tmp.x * ray.dist;
      p.grapplePoint.y = ey + tmp.y * ray.dist;
      p.grapplePoint.z = pos.z + tmp.z * ray.dist;
      events.push({ type: 'grapple', player: p.id, x: p.grapplePoint.x, y: p.grapplePoint.y, z: p.grapplePoint.z, ok: true });
    } else {
      p.grappleReadyAt = now + 0.6;
      events.push({ type: 'grapple', player: p.id, x: pos.x + tmp.x * GRAPPLE_RANGE, y: ey + tmp.y * GRAPPLE_RANGE, z: pos.z + tmp.z * GRAPPLE_RANGE, ok: false });
    }
  }
  let jumped = false;
  if (p.grappleOn) {
    const gx = p.grapplePoint.x - pos.x;
    const gy = p.grapplePoint.y - (pos.y + hy);
    const gz = p.grapplePoint.z - pos.z;
    const d = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (!(buttons & BTN_GRAPPLE) || d < 1.5 || now - p.grappleTime > GRAPPLE_MAX_TIME) {
      endGrapple(p, now, events);
    } else {
      const k = Math.min(1, 7 * dt);
      vel.x += ((gx / d) * GRAPPLE_SPEED - vel.x) * k;
      vel.y += ((gy / d) * GRAPPLE_SPEED - vel.y) * k;
      vel.z += ((gz / d) * GRAPPLE_SPEED - vel.z) * k;
      // A little air control so the swing can be steered.
      accelerate(p, wx, wz, Math.min(wishSpeed, AIR_CAP * 3), AIR_ACCEL, dt);
      p.onGround = false;
    }
  }

  // ---- ground / air ----------------------------------------------------------------
  if (!p.grappleOn) {
    if (p.onGround) {
      p.wallJumps = 0;
      if (pressed & BTN_JUMP) {
        vel.y = JUMP_SPEED * (STAMINA_MAX - p.stamina) / STAMINA_MAX;
        p.stamina = Math.min(STAMINA_MAX, p.stamina + STAMINA_JUMP * vel.y);
        // A crouch still on its way down when the feet leave the ground is finished in the
        // air, as a crouch-jump (so jump and crouch pressed together reach the full height).
        if (p.ducked && p.crouchT < 0.999) p.ducked = false;
        p.onGround = false;
        jumped = true;
        events.push({ type: 'jump', player: p.id });
      } else {
        const speed = Math.hypot(vel.x, vel.z);
        if (speed > 0.001) {
          const control = speed < STOP_SPEED ? STOP_SPEED : speed;
          const ns = Math.max(0, speed - control * FRICTION * dt) / speed;
          vel.x *= ns;
          vel.z *= ns;
        } else {
          vel.x = vel.z = 0;
        }
        vel.y = 0;
        if (p.stamina > 0) {
          const keep = Math.pow((STAMINA_MAX - p.stamina) / STAMINA_MAX, dt * 70);
          vel.x *= keep;
          vel.z *= keep;
        }
      }
    }
    if (p.onGround) {
      accelerate(p, wx, wz, wishSpeed, ACCEL, dt);
    } else {
      // Mantle: hold jump and push into a ledge while airborne.
      if (vertical && !jumped && buttons & BTN_JUMP && cmd.fwd > 0.3 && vel.y > -11 && tryMantle(p, world, hy, fx, fz)) {
        events.push({ type: 'mantle', player: p.id });
        return 0;
      }
      // Wall-jump: tap jump while touching a wall in the air.
      if (vertical && !jumped && pressed & BTN_JUMP && p.wallJumps < MAX_WALLJUMPS && findWall(p, world, hy, wall, wx * wishLen, wz * wishLen)) {
        if (wall.nx !== 0) vel.x = wall.nx * WALLJUMP_PUSH;
        else vel.z = wall.nz * WALLJUMP_PUSH;
        vel.y = WALLJUMP_UP;
        p.wallJumps++;
        p.lastWallNx = wall.nx;
        p.lastWallNz = wall.nz;
        events.push({ type: 'walljump', player: p.id });
      }
      accelerate(p, wx, wz, Math.min(wishSpeed, AIR_CAP), AIR_ACCEL, dt);
      vel.y -= GRAVITY * dt;
    }
  }

  const preVelY = vel.y;

  // ---- move, with stair stepping ---------------------------------------------------
  if (p.onGround) {
    const sx0 = pos.x, sy0 = pos.y, sz0 = pos.z;
    const vx0 = vel.x, vz0 = vel.z;
    const blocked = slide(p, world, dt, hy);
    if (blocked) {
      const ax = pos.x, ay = pos.y, az = pos.z;
      const avx = vel.x, avz = vel.z;
      // Retry from a step up.
      pos.x = sx0; pos.y = sy0; pos.z = sz0;
      vel.x = vx0; vel.y = 0; vel.z = vz0;
      world.traceHull(pos.x, pos.y + hy, pos.z, pos.x, pos.y + hy + STEP, pos.z, HULL_HALF, hy, HULL_HALF, tr);
      const rise = STEP * tr.fraction;
      pos.y += rise;
      slide(p, world, dt, hy);
      world.traceHull(pos.x, pos.y + hy, pos.z, pos.x, pos.y + hy - rise - 0.02, pos.z, HULL_HALF, hy, HULL_HALF, tr);
      const landed = tr.hit && !tr.startSolid && tr.ny > 0.7;
      pos.y -= (rise + 0.02) * tr.fraction;
      const da = (ax - sx0) * (ax - sx0) + (az - sz0) * (az - sz0);
      const db = (pos.x - sx0) * (pos.x - sx0) + (pos.z - sz0) * (pos.z - sz0);
      if (!landed || db <= da + 1e-6) {
        pos.x = ax; pos.y = ay; pos.z = az;
        vel.x = avx; vel.z = avz;
      }
      vel.y = 0;
    }
    // Stay glued to stairs when walking down them.
    world.traceHull(pos.x, pos.y + hy, pos.z, pos.x, pos.y + hy - STEP, pos.z, HULL_HALF, hy, HULL_HALF, tr);
    if (tr.hit && !tr.startSolid && tr.ny > 0.7) pos.y -= STEP * tr.fraction;
  } else {
    slide(p, world, dt, hy);
  }

  if (p.grappleOn && !world.lineOfSight(pos.x, pos.y + hy, pos.z, p.grapplePoint.x - (p.grapplePoint.x - pos.x) * 0.02, p.grapplePoint.y - (p.grapplePoint.y - pos.y - hy) * 0.02, p.grapplePoint.z - (p.grapplePoint.z - pos.z) * 0.02)) {
    endGrapple(p, now, events);
  }

  // ---- landing ---------------------------------------------------------------------
  const nowGround = vel.y <= 0.1 && !p.grappleOn && groundBelow(p, world, hy, 0.03);
  let landSpeed = 0;
  if (!p.onGround && !jumped && nowGround) {
    landSpeed = Math.max(0, -preVelY);
    if (landSpeed > 3) events.push({ type: 'land', player: p.id, speed: landSpeed });
    p.wallJumps = 0;
    vel.y = 0;
  } else if (!wasGround && p.onGround && !jumped) {
    // Landed between ticks (ground detected at the start of this tick).
    landSpeed = p.fallSpeed;
    if (landSpeed > 3) events.push({ type: 'land', player: p.id, speed: landSpeed });
  }
  if (landSpeed > 0) p.stamina = Math.min(STAMINA_MAX, p.stamina + STAMINA_LAND * landSpeed);
  p.fallSpeed = nowGround ? 0 : Math.max(0, -vel.y);
  if (!jumped) p.onGround = nowGround;

  // ---- footsteps (silent when walking or crouched) ---------------------------------
  if (p.onGround) {
    const speed = Math.hypot(vel.x, vel.z);
    if (speed > runSpeed * 0.6) {
      p.stepDist += speed * dt;
      if (p.stepDist > 2.5) {
        p.stepDist = 0;
        events.push({ type: 'step', player: p.id, x: pos.x, y: pos.y, z: pos.z });
      }
    }
  }
  return landSpeed;
}
