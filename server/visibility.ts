// Server-side visibility: decides whether one player's client may be told where another
// player is. A client that never receives an enemy's position cannot draw them through walls.
//
// The test is deliberately generous (several sight lines, both players' positions run a
// little into the future, a grace period after losing sight) so that an honest client never
// sees an enemy pop into existence late when peeking a corner.

import type { Sim } from '../src/sim/game';
import { eyeHeight } from '../src/sim/movement';
import type { Player } from '../src/sim/types';

/** How far ahead (seconds) positions are projected: covers latency and interpolation delay. */
const LEAD = 0.3;
/** Within this distance an enemy is always sent: footsteps and gunfire give them away anyway. */
const ALWAYS = 5;
/** Keep sending for this long after sight is lost, so brief occlusions never flicker. */
export const GRACE = 0.6;

const OFFSETS: [number, number][] = [[0, 0], [0.42, 0], [-0.42, 0], [0, 0.42], [0, -0.42]];

export function canSee(sim: Sim, viewer: Player, target: Player): boolean {
  const w = sim.world;
  const dx = target.pos.x - viewer.pos.x, dz = target.pos.z - viewer.pos.z;
  if (dx * dx + dz * dz < ALWAYS * ALWAYS) return true;
  const ey = viewer.pos.y + eyeHeight(viewer);
  const th = eyeHeight(target);
  // Viewer now and a moment ahead; target now and a moment ahead.
  for (let vi = 0; vi < 2; vi++) {
    const vx = viewer.pos.x + viewer.vel.x * LEAD * vi, vz = viewer.pos.z + viewer.vel.z * LEAD * vi;
    for (let ti = 0; ti < 2; ti++) {
      const tx = target.pos.x + target.vel.x * LEAD * ti, tz = target.pos.z + target.vel.z * LEAD * ti;
      for (const [ox, oz] of OFFSETS) {
        // Head, chest and shin of the target's hull, at its centre and edges.
        if (w.lineOfSight(vx, ey, vz, tx + ox, target.pos.y + th, tz + oz)) return true;
        if (w.lineOfSight(vx, ey, vz, tx + ox, target.pos.y + 1.0, tz + oz)) return true;
        if (w.lineOfSight(vx, ey, vz, tx + ox, target.pos.y + 0.25, tz + oz)) return true;
      }
    }
  }
  return false;
}
