// "Relay" — an original three-lane, two-site blockout.
// Attackers spawn south (+Z), defenders north (-Z). Site A is north-east, Site B north-west.
// Units are metres, Y is up.

import type { Box } from './world';
import type { Vec3 } from './math';

export const enum Mat {
  Floor = 0,
  Wall = 1,
  Block = 2,
  Crate = 3,
  GlowA = 4,
  GlowB = 5,
  GlowNeutral = 6,
  Deck = 7,
  Roof = 8,
}

export interface Zone {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface SiteDef {
  name: 'A' | 'B';
  zone: Zone;
  center: Vec3;
  /** Where defending bots stand, and where they look. */
  holds: { pos: Vec3; look: Vec3 }[];
  /** Entrances attackers arrive from; post-plant bots watch these. */
  entrances: Vec3[];
}

export interface RouteDef {
  site: 0 | 1;
  name: string;
  points: Vec3[];
}

export interface MapDef {
  name: string;
  boxes: Box[];
  spawns: [Vec3[], Vec3[]];
  /** Facing yaw for each team's spawn. */
  spawnYaw: [number, number];
  buyZones: [Zone, Zone];
  sites: [SiteDef, SiteDef];
  routes: RouteDef[];
  midHolds: { pos: Vec3; look: Vec3 }[];
}

const P = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });

export function inZone(z: Zone, x: number, zz: number): boolean {
  return x >= z.minX && x <= z.maxX && zz >= z.minZ && zz <= z.maxZ;
}

export function buildMap(): MapDef {
  const boxes: Box[] = [];
  const box = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, mat: Mat, noCollide = false) => {
    boxes.push({
      minX: Math.min(x1, x2), minY: Math.min(y1, y2), minZ: Math.min(z1, z2),
      maxX: Math.max(x1, x2), maxY: Math.max(y1, y2), maxZ: Math.max(z1, z2),
      mat, noCollide: noCollide || undefined,
    });
  };
  /** Solid from the floor up. */
  const solid = (x1: number, z1: number, x2: number, z2: number, h: number, mat: Mat = Mat.Wall) => box(x1, 0, z1, x2, h, z2, mat);
  const crate = (cx: number, cz: number, sx: number, sz: number, h: number, mat: Mat = Mat.Crate) =>
    box(cx - sx / 2, 0, cz - sz / 2, cx + sx / 2, h, cz + sz / 2, mat);
  /** Non-colliding emissive strip. */
  const glow = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, mat: Mat) => box(x1, y1, z1, x2, y2, z2, mat, true);

  // A standing player is 1.83 m tall and jumps 1.45 m: nothing overhead is lower than CLEAR, so
  // a jump never ends against a ceiling, and no wall that is meant to block a view can be
  // seen over from the top of one (the eye reaches 3.1 m).
  // (Wall heights are whole courses of the 1.1 m wall panels.)
  const WALL_H = 11;
  const BLOCK_H = 5.5;
  const TALL_H = 7.7;
  const CLEAR = 4.0;
  /** Free-standing walls with a way through them. */
  const DOOR_H = 5.0;

  // ---- ground and perimeter -------------------------------------------------
  box(-33, -1, -37, 33, 0, 37, Mat.Floor);
  solid(-30, -37, 30, -36, WALL_H);
  solid(-30, 36, 30, 37, WALL_H);
  solid(-33, -37, -30, 37, WALL_H);
  solid(30, -37, 33, 37, WALL_H);

  // ---- spawn pockets --------------------------------------------------------
  // Attacker spawn is x[-12,12] z[26,36]; everything beside it is solid.
  solid(-30, 26, -12, 36, TALL_H, Mat.Block);
  solid(12, 26, 30, 36, TALL_H, Mat.Block);
  // Defender spawn is x[-10,10] z[-36,-28].
  solid(-30, -36, -10, -28, TALL_H, Mat.Block);
  solid(10, -36, 30, -28, TALL_H, Mat.Block);
  // Close the dead-end ends of the defender corridor.
  solid(19, -28, 30, -24, BLOCK_H, Mat.Block);
  solid(-30, -28, -19, -24, BLOCK_H, Mat.Block);

  // ---- east building (between mid and A-long), with a covered connector -----
  solid(5, -8, 18, 6, BLOCK_H, Mat.Block);
  solid(5, 10, 18, 22, BLOCK_H, Mat.Block);
  box(5, CLEAR, 6, 18, BLOCK_H, 10, Mat.Roof); // connector roof

  // ---- west building (between mid and B tunnels), connector further south ---
  solid(-18, -8, -5, 10, BLOCK_H, Mat.Block);
  solid(-18, 14, -5, 22, BLOCK_H, Mat.Block);
  box(-18, CLEAR, 10, -5, BLOCK_H, 14, Mat.Roof);

  // ---- walls between mid and the sites, with one opening each ("short") -----
  solid(5, -24, 14, -18, BLOCK_H, Mat.Block);
  solid(5, -14, 14, -8, BLOCK_H, Mat.Block);
  box(5, CLEAR, -18, 14, BLOCK_H, -14, Mat.Roof);
  solid(-14, -24, -5, -15, BLOCK_H, Mat.Block);
  solid(-14, -11, -5, -8, BLOCK_H, Mat.Block);
  box(-14, CLEAR, -15, -5, BLOCK_H, -11, Mat.Roof);

  // ---- mid doors (north end of mid) -----------------------------------------
  solid(-5, -25, -1.6, -24, DOOR_H);
  solid(1.6, -25, 5, -24, DOOR_H);
  box(-1.6, CLEAR, -25, 1.6, DOOR_H, -24, Mat.Wall);

  // ---- A long doors: the lane narrows to one doorway half way down -----------
  solid(18, 13, 22.8, 14, DOOR_H);
  solid(25.6, 13, 30, 14, DOOR_H);
  box(22.8, CLEAR, 13, 25.6, DOOR_H, 14, Mat.Wall);

  // ---- B tunnels bend: two baffles turn the tunnel into an S, no straight line through it --
  solid(-30, 6, -24.5, 7.2, CLEAR + 0.2, Mat.Block);
  solid(-22, 1.5, -18, 2.7, CLEAR + 0.2, Mat.Block);

  // ---- site entry walls ------------------------------------------------------
  // A-long opens on the east side of the lane; B tunnels open on the inner side.
  solid(18, -9, 25, -8, DOOR_H);
  solid(-30, -9, -23, -8, DOOR_H);

  // ---- B tunnels roof (a darker, enclosed stretch of the west lane) ---------
  box(-30, CLEAR + 0.2, 0, -18, CLEAR + 0.7, 14, Mat.Roof);

  // ---- raised decks with steps (exercise step-up; give sites some height) ---
  // Site A platform: the defenders' high ground over the site, up three steps.
  box(25, 0, -24, 30, 1.2, -17, Mat.Deck);
  box(24.2, 0, -24, 25, 0.8, -17, Mat.Deck);
  box(23.4, 0, -24, 24.2, 0.4, -17, Mat.Deck);
  // Site B back deck.
  box(-30, 0, -24, -25, 0.8, -18, Mat.Deck);
  box(-25, 0, -24, -24.2, 0.4, -18, Mat.Deck);
  // Low mid platform that splits the mid lane.
  box(-2, 0, 0, 2, 0.4, 5, Mat.Deck);

  // ---- mid: break the long sightlines ------------------------------------------
  // A solid core splits mid into two lanes; a baffle in front of the doors and a
  // shield wall at the attackers' end mean neither spawn can see the other.
  solid(-2.2, 7, 2.2, 11, 4.4, Mat.Block);
  solid(-2.4, -21, 2.4, -20.2, 3.6);
  solid(-3, 23.4, 3, 24.2, 3.4);
  // Head-height cover on the open lanes.
  crate(27.2, 8.4, 2.4, 2.0, 2.2, Mat.Deck);
  crate(-21, 20, 2.4, 2.0, 2.2, Mat.Deck);
  // Invisible ceiling keeps everyone inside the play space.
  boxes.push({ minX: -33, minY: WALL_H, minZ: -37, maxX: 33, maxY: WALL_H + 1, maxZ: 37, mat: Mat.Roof, hidden: true });

  // ---- cover -----------------------------------------------------------------
  // Site A
  crate(20, -16, 2.4, 2.4, 2.2);
  crate(22.6, -16.4, 1.4, 1.4, 1.1);
  crate(17, -11.5, 2, 1.4, 1.4);
  box(16.4, 1.4, -12, 17.6, 2.5, -11, Mat.Crate); // stacked
  crate(27, -12, 1.6, 1.6, 1.2);
  crate(15.5, -21.5, 1.6, 1.6, 1.4);
  // Site B
  // (B's middle is a pillar, floor to roof height: a site fought round, not over)
  solid(-21.8, -16.8, -20.2, -15.2, BLOCK_H, Mat.Block);
  crate(-18.6, -14, 1.4, 1.4, 1.1);
  crate(-27, -12.5, 1.6, 2, 1.4);
  crate(-16.5, -21, 1.6, 1.6, 1.3);
  crate(-22, -22, 2.2, 1.2, 1.0);
  box(-22.6, 1.0, -22.5, -21.4, 2.1, -21.5, Mat.Crate); // stacked: a crouch-jump up from the box below
  // A-long
  crate(28.4, 16, 1.8, 2.6, 2.2);
  crate(19.4, 4, 1.6, 1.6, 1.3);
  crate(27.5, -2, 2, 1.6, 1.1);
  crate(20, 19.5, 2.2, 1.4, 1.2);
  // B tunnels
  crate(-28.4, 18, 1.8, 2.4, 2.2);
  crate(-19.4, 4, 1.4, 2.2, 1.2);
  crate(-27.6, -3, 1.8, 1.8, 1.4);
  // Mid
  crate(3.6, 16, 1.6, 2.4, 2.2);
  crate(-3.6, -4, 1.6, 2.4, 1.3);
  crate(3.8, -11, 1.4, 1.4, 1.1);
  crate(-3.7, -16.6, 1.8, 1.4, 1.4);
  // Defender corridor
  crate(12, -27, 1.6, 1.2, 1.2);
  crate(-12.5, -25.2, 1.6, 1.2, 1.2);
  // Attacker forecourt
  crate(-15, 24.6, 2.4, 1.4, 1.3);
  crate(15, 23.4, 2.4, 1.4, 1.3);
  // Connectors
  crate(12, 9.2, 1.6, 1.0, 1.0);
  crate(-11, 10.8, 1.6, 1.0, 1.0);

  // ---- emissive dressing (no collision) -------------------------------------
  // Site outlines on the floor.
  const outline = (z: Zone, mat: Mat) => {
    const t = 0.12, y1 = 0.005, y2 = 0.02;
    glow(z.minX, y1, z.minZ, z.maxX, y2, z.minZ + t, mat);
    glow(z.minX, y1, z.maxZ - t, z.maxX, y2, z.maxZ, mat);
    glow(z.minX, y1, z.minZ, z.minX + t, y2, z.maxZ, mat);
    glow(z.maxX - t, y1, z.minZ, z.maxX, y2, z.maxZ, mat);
  };
  const zoneA: Zone = { minX: 15.5, maxX: 24, minZ: -22.5, maxZ: -10.5 };
  const zoneB: Zone = { minX: -24, maxX: -15.5, minZ: -22.5, maxZ: -10.5 };
  outline(zoneA, Mat.GlowA);
  outline(zoneB, Mat.GlowB);
  // Wall light bands that colour-code each half of the map.
  glow(29.9, 2.6, -24, 30, 2.8, -8, Mat.GlowA);
  glow(29.9, 2.6, -8, 30, 2.8, 26, Mat.GlowA);
  glow(14, 2.6, -24.02, 19, 2.8, -23.9, Mat.GlowA);
  glow(-30, 2.6, -24, -29.9, 2.8, -8, Mat.GlowB);
  glow(-30, 2.6, -8, -29.9, 2.8, 26, Mat.GlowB);
  glow(4.9, 2.6, -8, 5, 2.8, 22, Mat.GlowNeutral);
  glow(-5, 2.6, -8, -4.9, 2.8, 22, Mat.GlowNeutral);
  glow(-12, 2.6, 35.9, 12, 2.8, 36, Mat.GlowNeutral);
  glow(-10, 2.6, -36, 10, 2.8, -35.9, Mat.GlowNeutral);
  // Ceiling strips inside the roofed sections.
  glow(8, CLEAR - 0.05, 7.9, 15, CLEAR, 8.1, Mat.GlowNeutral);
  glow(-15, CLEAR - 0.05, 11.9, -8, CLEAR, 12.1, Mat.GlowNeutral);
  glow(-24.1, CLEAR + 0.15, 1, -23.9, CLEAR + 0.2, 13, Mat.GlowB);
  glow(8, CLEAR - 0.05, -16.1, 12, CLEAR, -15.9, Mat.GlowA);
  glow(-12, CLEAR - 0.05, -13.1, -8, CLEAR, -12.9, Mat.GlowB);

  const siteA: SiteDef = {
    name: 'A',
    zone: zoneA,
    center: P(19.5, -16.5),
    holds: [
      { pos: P(27.5, -20.5, 1.2), look: P(27.5, -8) },
      { pos: P(16.2, -19.6), look: P(12, -16) },
      { pos: P(21.6, -18.2), look: P(27, -8) },
    ],
    entrances: [P(27.5, -6), P(12, -16), P(16.5, -26)],
  };
  const siteB: SiteDef = {
    name: 'B',
    zone: zoneB,
    center: P(-19.5, -16.5),
    holds: [
      { pos: P(-27.5, -21, 0.8), look: P(-20.5, -8) },
      { pos: P(-16.2, -19.2), look: P(-12, -13) },
      { pos: P(-22.8, -18.4), look: P(-20.5, -8) },
    ],
    entrances: [P(-20.5, -6), P(-12, -13), P(-16.5, -26)],
  };

  return {
    name: 'Relay',
    boxes,
    spawns: [
      [P(-6, 32), P(-3, 33), P(0, 32), P(3, 33), P(6, 32), P(-4.5, 29.5), P(4.5, 29.5)],
      [P(-6, -33), P(-3, -32), P(0, -33), P(3, -32), P(6, -33), P(-4.5, -30), P(4.5, -30)],
    ],
    spawnYaw: [0, Math.PI],
    buyZones: [
      { minX: -12, maxX: 12, minZ: 24, maxZ: 36 },
      { minX: -10, maxX: 10, minZ: -36, maxZ: -26 },
    ],
    sites: [siteA, siteB],
    routes: [
      { site: 0, name: 'A long', points: [P(24, 24), P(25, 8), P(27.5, -6)] },
      { site: 0, name: 'A short', points: [P(3.9, 20), P(3.6, 9), P(1.5, -12), P(11, -16)] },
      { site: 0, name: 'A connector', points: [P(3.9, 20), P(3.6, 8), P(16, 8), P(26, 0), P(27.5, -6)] },
      { site: 1, name: 'B tunnels', points: [P(-24, 24), P(-24, 8), P(-20.5, -6)] },
      { site: 1, name: 'B short', points: [P(-3.9, 20), P(-3.6, 9), P(-1.5, -10), P(-11, -13)] },
      { site: 1, name: 'B connector', points: [P(-3.9, 20), P(-3.6, 12), P(-16, 12), P(-25.5, 3.5), P(-20.5, -6)] },
    ],
    midHolds: [
      { pos: P(3.5, -19.4), look: P(3.6, 4) },
      { pos: P(-3.5, -22.4), look: P(-3.6, 4) },
    ],
  };
}
