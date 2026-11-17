// How a bot aims a grenade: by throwing it in its head first. The real throw (grenades.ts) is
// run against the real level from where the bot stands, over a spread of aims and the three
// strengths, and the aim whose grenade ends up nearest the spot wanted is kept. So a bot banks
// a grenade off a wall or lobs it over cover only where that actually works, and never throws
// one into the wall in front of it.

import { FIRE_FUSE, FUSE, flyNade, throwFrom } from './grenades';
import { eyeHeight } from './movement';
import { yawTo, v3 } from './math';
import { NADES } from './weapons';
import { TICK, type Grenade, type Player, type SimEvent } from './types';
import type { World } from './world';

export interface ThrowPlan {
  kind: number;
  yaw: number;
  pitch: number;
  /** 1 overarm, 0.5 both buttons, 0 underarm */
  str: number;
  /** How far from the spot wanted it ends up (m). */
  miss: number;
}

const scratch: SimEvent[] = [];
const ghost: Grenade = { id: -1, kind: 0, owner: -1, team: 0, pos: v3(), vel: v3(), born: 0, state: 0, popAt: 0, endAt: 0 };
const none: Player[] = [];

/** Where a grenade thrown this way goes off (or, a smoke, comes to rest). */
function landing(world: World, me: Player, kind: number, yaw: number, pitch: number, str: number): Grenade {
  const type = NADES[kind]!.nade!.type;
  const p = { ...me, yaw, pitch, vel: v3() } as Player;
  throwFrom(p, me.pos.y + eyeHeight(me), str, world, ghost.pos, ghost.vel);
  ghost.state = 0;
  ghost.born = 0;
  const end = type === 'he' || type === 'flash' ? FUSE : type === 'fire' ? FIRE_FUSE : 5;
  for (let t = 0; t < end; t += TICK) {
    const floor = flyNade(ghost, world, none, t, TICK, scratch);
    scratch.length = 0;
    if (type === 'fire' && floor) break;
    if (type === 'smoke' && (ghost.state as number) === 1 && t > 0.5) break;
  }
  return ghost;
}

/**
 * The best throw of grenade `kind` at the point (tx, ty, tz), or null if none comes within
 * `within` metres of it.
 */
export function solveThrow(world: World, me: Player, kind: number, tx: number, ty: number, tz: number, within: number): ThrowPlan | null {
  const yaw = yawTo(me.pos.x, me.pos.z, tx, tz);
  let best: ThrowPlan | null = null;
  const miss = (g: Grenade): number => Math.hypot(g.pos.x - tx, (g.pos.y - ty) * 0.5, g.pos.z - tz);
  // (coarse first, overarm and underarm; stopped as soon as one is close enough)
  for (const str of [1, 0]) {
    for (let pitch = -0.45; pitch <= 1.21; pitch += 0.15) {
      const m = miss(landing(world, me, kind, yaw, pitch, str));
      if (!best || m < best.miss) best = { kind, yaw, pitch, str, miss: m };
    }
    if (best && best.miss < within * 0.5) break;
  }
  if (!best) return null;
  // (and a finer look either side of the best)
  const around = best.pitch;
  for (let pitch = around - 0.075; pitch <= around + 0.076; pitch += 0.025) {
    const m = miss(landing(world, me, kind, yaw, pitch, best.str));
    if (m < best.miss) { best.pitch = pitch; best.miss = m; }
  }
  return best.miss <= within ? best : null;
}
