// Weapon catalogue. All tuning lives here as plain data.
// Angles are radians unless noted; distances are metres; times are seconds.

import { DEG, Rng } from './math';

export type WeaponSlot = 0 | 1 | 2; // primary, secondary, melee
export type WeaponKind = 'rifle' | 'smg' | 'pistol' | 'sniper' | 'shotgun' | 'knife';

export interface WeaponDef {
  id: string;
  name: string;
  kind: WeaponKind;
  slot: WeaponSlot;
  price: number;
  killReward: number;
  /** -1 = both teams, otherwise 0 (attack) or 1 (defence). */
  team: -1 | 0 | 1;
  damage: number;
  /** Fraction of damage that gets through armour (0..1). */
  armorPen: number;
  /** Damage multiplier per 10 m travelled. */
  rangeMod: number;
  headMult: number;
  rpm: number;
  auto: boolean;
  pellets: number;
  magSize: number;
  reserve: number;
  reloadTime: number;
  drawTime: number;
  /** Run speed with this weapon out (m/s). */
  maxSpeed: number;
  spreadStand: number;
  spreadCrouch: number;
  spreadMove: number;
  spreadAir: number;
  /** Inaccuracy added per shot, and how fast it bleeds off (per second, exponential). */
  spreadPerShot: number;
  spreadDecay: number;
  /** Spray pattern: cumulative view offset after n shots, in radians [pitchUp, yawLeft]. */
  pattern: Float32Array;
  /** Thickness of wall (m) this weapon can shoot through. */
  penetration: number;
  /** Sniper only: spread while not scoped, and scoped move speed. */
  spreadUnscoped?: number;
  scopedSpeed?: number;
  scopeFov?: [number, number];
  /** Viewmodel feel. */
  kick: number;
  range: number;
  /**
   * The gun takes a suppressor, fitted or taken off with alt-fire: `fitted` is how it comes
   * when bought. The numbers above are the gun's without one.
   */
  suppressor?: { fitted: boolean };
}

/** Seconds to fit or take off a suppressor. */
export const SUPPRESSOR_TIME = 1.7;
/** Fitted, it tames the recoil and costs the round a little of its energy with every 10 m. */
export const SUPPRESSED_RECOIL = 0.85;
export const SUPPRESSED_RANGE = 0.985;

/**
 * A deterministic, learnable spray pattern in the manner of Counter-Strike's.
 *
 * Up: the climb eases in, so the first couple of rounds land close together (taps and short
 * bursts stay accurate), is steepest a few rounds in, and has levelled off by round `riseBy`;
 * after that the muzzle only creeps up by `creep` more.
 * Sideways: once the climb is spent the spray walks from side to side through `turns`,
 * each [round, degrees left of the first shot], easing into and out of every turn.
 *
 * @param rise degrees the spray has climbed by round `riseBy`
 */
function spray(
  shots: number, rise: number, riseBy: number, creep: number,
  turns: [round: number, left: number][], seed: number,
): Float32Array {
  const rng = new Rng(seed);
  const out = new Float32Array(shots * 2);
  const ease = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
  for (let i = 1; i < shots; i++) {
    let up = rise * ease(i / riseBy);
    if (i > riseBy) up += (creep * (i - riseBy)) / Math.max(1, shots - 1 - riseBy);
    let left = 0, from = 0, was = 0;
    for (const [round, to] of turns) {
      left = was + (to - was) * ease((i - from) / Math.max(1, round - from));
      if (i <= round) break;
      from = round;
      was = to;
    }
    out[i * 2] = (up + rng.range(-0.05, 0.05)) * DEG;
    out[i * 2 + 1] = (left + rng.range(-0.07, 0.07)) * DEG;
  }
  return out;
}

const KNIFE_SPEED = 6.35;

const defs: WeaponDef[] = [
  {
    id: 'edge', name: 'Edge', kind: 'knife', slot: 2, price: 0, killReward: 1500, team: -1,
    damage: 45, armorPen: 0.85, rangeMod: 1, headMult: 1, rpm: 130, auto: true, pellets: 1,
    magSize: -1, reserve: 0, reloadTime: 0, drawTime: 0.35, maxSpeed: KNIFE_SPEED,
    spreadStand: 0, spreadCrouch: 0, spreadMove: 0, spreadAir: 0, spreadPerShot: 0, spreadDecay: 10,
    pattern: new Float32Array(2), penetration: 0, kick: 0, range: 1.75,
  },
  {
    id: 'kite', name: 'Kite-9', kind: 'pistol', slot: 1, price: 200, killReward: 300, team: 0,
    damage: 28, armorPen: 0.47, rangeMod: 0.9, headMult: 4, rpm: 340, auto: false, pellets: 1,
    magSize: 20, reserve: 120, reloadTime: 2.2, drawTime: 0.45, maxSpeed: 6.1,
    spreadStand: 0.0055, spreadCrouch: 0.004, spreadMove: 0.03, spreadAir: 0.2, spreadPerShot: 0.012, spreadDecay: 6,
    pattern: spray(20, 2.4, 9, 0.4, [[6, -0.25], [13, 0.35], [19, -0.2]], 11), penetration: 0.25, kick: 0.7, range: 120,
  },
  {
    id: 'tern', name: 'Tern P7', kind: 'pistol', slot: 1, price: 200, killReward: 300, team: 1,
    damage: 34, armorPen: 0.5, rangeMod: 0.92, headMult: 4, rpm: 310, auto: false, pellets: 1,
    magSize: 12, reserve: 48, reloadTime: 2.2, drawTime: 0.45, maxSpeed: 6.1,
    spreadStand: 0.004, spreadCrouch: 0.003, spreadMove: 0.035, spreadAir: 0.2, spreadPerShot: 0.014, spreadDecay: 6,
    pattern: spray(12, 2.8, 7, 0.4, [[5, 0.3], [11, -0.3]], 12), penetration: 0.25, kick: 0.8, range: 120,
  },
  {
    id: 'maul', name: 'Maul .50', kind: 'pistol', slot: 1, price: 700, killReward: 300, team: -1,
    damage: 61, armorPen: 0.93, rangeMod: 0.88, headMult: 4, rpm: 230, auto: false, pellets: 1,
    magSize: 7, reserve: 35, reloadTime: 2.2, drawTime: 0.5, maxSpeed: 5.84,
    spreadStand: 0.004, spreadCrouch: 0.003, spreadMove: 0.07, spreadAir: 0.3, spreadPerShot: 0.05, spreadDecay: 3.2,
    pattern: spray(7, 6.0, 4, 0.6, [[3, -0.6], [6, 0.5]], 13), penetration: 0.6, kick: 1.6, range: 120,
  },
  {
    // A machine pistol for the sidearm slot: sprays, runs dry fast, weak past a few metres.
    id: 'stinger', name: 'Stinger MP', kind: 'pistol', slot: 1, price: 500, killReward: 300, team: 0,
    damage: 24, armorPen: 0.6, rangeMod: 0.82, headMult: 4, rpm: 600, auto: true, pellets: 1,
    magSize: 20, reserve: 60, reloadTime: 2.9, drawTime: 0.5, maxSpeed: 6.0,
    spreadStand: 0.009, spreadCrouch: 0.007, spreadMove: 0.03, spreadAir: 0.2, spreadPerShot: 0.006, spreadDecay: 5,
    pattern: spray(20, 5.0, 7, 0.6, [[6, -0.5], [12, 1.3], [19, -1.1]], 14), penetration: 0.25, kick: 0.6, range: 120,
  },
  {
    // Attackers' SMG: cheap, fast-firing and loose.
    id: 'wasp', name: 'Wasp SMG', kind: 'smg', slot: 0, price: 1050, killReward: 600, team: 0,
    damage: 29, armorPen: 0.575, rangeMod: 0.8, headMult: 4, rpm: 690, auto: true, pellets: 1,
    magSize: 30, reserve: 100, reloadTime: 2.6, drawTime: 0.6, maxSpeed: 6.1,
    spreadStand: 0.0105, spreadCrouch: 0.008, spreadMove: 0.026, spreadAir: 0.16, spreadPerShot: 0.003, spreadDecay: 5,
    pattern: spray(30, 4.8, 10, 0.5, [[8, -0.5], [14, 1.3], [22, -1.5], [29, 0.8]], 21), penetration: 0.3, kick: 0.65, range: 120,
  },
  {
    // Defenders' SMG: dearer, tighter, better against armour.
    id: 'hornet', name: 'Hornet PDW', kind: 'smg', slot: 0, price: 1500, killReward: 600, team: 1,
    damage: 27, armorPen: 0.65, rangeMod: 0.86, headMult: 4, rpm: 650, auto: true, pellets: 1,
    magSize: 30, reserve: 120, reloadTime: 3.0, drawTime: 0.7, maxSpeed: 5.6,
    spreadStand: 0.0075, spreadCrouch: 0.006, spreadMove: 0.03, spreadAir: 0.16, spreadPerShot: 0.0026, spreadDecay: 5.5,
    pattern: spray(30, 3.7, 10, 0.4, [[9, 0.35], [16, -0.9], [24, 0.8], [29, 0.2]], 22), penetration: 0.35, kick: 0.55, range: 120,
    suppressor: { fitted: false },
  },
  {
    id: 'breaker', name: 'Breaker', kind: 'shotgun', slot: 0, price: 1100, killReward: 900, team: 1,
    damage: 22, armorPen: 0.5, rangeMod: 0.6, headMult: 2, rpm: 68, auto: false, pellets: 9,
    magSize: 7, reserve: 28, reloadTime: 3.0, drawTime: 0.7, maxSpeed: 5.6,
    spreadStand: 0.045, spreadCrouch: 0.04, spreadMove: 0.02, spreadAir: 0.1, spreadPerShot: 0.004, spreadDecay: 4,
    pattern: spray(7, 6.0, 3, 0.5, [[3, 0.5], [6, -0.6]], 31), penetration: 0, kick: 2.2, range: 60,
    suppressor: { fitted: false },
  },
  {
    // Two barrels, two shells: the hardest single hit in the game, then a reload.
    id: 'thresher', name: 'Thresher DB', kind: 'shotgun', slot: 0, price: 1300, killReward: 900, team: 0,
    damage: 26, armorPen: 0.45, rangeMod: 0.5, headMult: 2, rpm: 200, auto: false, pellets: 10,
    magSize: 2, reserve: 24, reloadTime: 2.8, drawTime: 0.8, maxSpeed: 5.9,
    spreadStand: 0.06, spreadCrouch: 0.055, spreadMove: 0.02, spreadAir: 0.1, spreadPerShot: 0.004, spreadDecay: 4,
    pattern: spray(2, 4.5, 1, 0, [[1, 0.4]], 32), penetration: 0, kick: 2.6, range: 45,
  },
  {
    // Attackers' budget rifle: a short carbine, wilder than the full rifle.
    id: 'mako', name: 'Mako Carbine', kind: 'rifle', slot: 0, price: 1800, killReward: 300, team: 0,
    damage: 31, armorPen: 0.72, rangeMod: 0.93, headMult: 4, rpm: 600, auto: true, pellets: 1,
    magSize: 30, reserve: 90, reloadTime: 3.0, drawTime: 0.8, maxSpeed: 5.7,
    spreadStand: 0.0055, spreadCrouch: 0.0042, spreadMove: 0.1, spreadAir: 0.26, spreadPerShot: 0.0038, spreadDecay: 4.5,
    pattern: spray(30, 6.8, 8, 0.5, [[6, -0.7], [12, 2.2], [20, -2.4], [29, 1.6]], 43), penetration: 0.8, kick: 0.9, range: 200,
  },
  {
    // Defenders' budget rifle: comes suppressed, steady, a small magazine.
    // (its numbers are the bare gun's, set so that with the suppressor on it shoots as it always has)
    id: 'osprey', name: 'Osprey SD', kind: 'rifle', slot: 0, price: 2050, killReward: 300, team: 1,
    damage: 30, armorPen: 0.7, rangeMod: 0.9645, headMult: 4, rpm: 600, auto: true, pellets: 1,
    magSize: 20, reserve: 80, reloadTime: 2.9, drawTime: 0.7, maxSpeed: 5.8,
    spreadStand: 0.0036, spreadCrouch: 0.0028, spreadMove: 0.1, spreadAir: 0.26, spreadPerShot: 0.003, spreadDecay: 5.2,
    pattern: spray(20, 5.41, 8, 0.47, [[8, 0.35], [13, 1.53], [19, -0.94]], 44), penetration: 0.8, kick: 0.7, range: 200,
    suppressor: { fitted: true },
  },
  {
    id: 'hammerhead', name: 'Hammerhead AR', kind: 'rifle', slot: 0, price: 2700, killReward: 300, team: 0,
    damage: 36, armorPen: 0.775, rangeMod: 0.96, headMult: 4, rpm: 600, auto: true, pellets: 1,
    magSize: 30, reserve: 90, reloadTime: 2.5, drawTime: 0.7, maxSpeed: 5.46,
    spreadStand: 0.004, spreadCrouch: 0.003, spreadMove: 0.11, spreadAir: 0.26, spreadPerShot: 0.0035, spreadDecay: 4.5,
    pattern: spray(30, 7.4, 9, 0.5, [[7, -1.0], [10, 1.7], [14, 2.8], [19, -1.75], [25, -1.6], [29, 2.3]], 41), penetration: 1.0, kick: 1.0, range: 200,
  },
  {
    id: 'lumen', name: 'Lumen AR', kind: 'rifle', slot: 0, price: 3000, killReward: 300, team: 1,
    damage: 33, armorPen: 0.7, rangeMod: 0.97, headMult: 4, rpm: 630, auto: true, pellets: 1,
    magSize: 30, reserve: 90, reloadTime: 3.0, drawTime: 0.7, maxSpeed: 5.72,
    spreadStand: 0.0033, spreadCrouch: 0.0025, spreadMove: 0.1, spreadAir: 0.26, spreadPerShot: 0.003, spreadDecay: 5,
    pattern: spray(30, 5.8, 9, 0.4, [[6, 0.35], [9, -1.25], [14, 2.1], [19, 2.5], [24, -0.45], [29, -0.6]], 42), penetration: 0.9, kick: 0.85, range: 200,
    suppressor: { fitted: false },
  },
  {
    // The defenders' sniper: a bolt-action in the AWP's class. One shot to the body or head kills.
    id: 'longsight', name: 'Longsight AWP', kind: 'sniper', slot: 0, price: 4750, killReward: 100, team: 1,
    damage: 115, armorPen: 0.975, rangeMod: 0.99, headMult: 4, rpm: 41, auto: false, pellets: 1,
    magSize: 5, reserve: 30, reloadTime: 3.6, drawTime: 1.0, maxSpeed: 5.08,
    spreadStand: 0.0008, spreadCrouch: 0.0005, spreadMove: 0.16, spreadAir: 0.4, spreadPerShot: 0.05, spreadDecay: 3,
    pattern: spray(5, 3.2, 2, 0.3, [[4, 0.2]], 51), penetration: 2.0, kick: 3.0, range: 300,
    spreadUnscoped: 0.055, scopedSpeed: 2.5, scopeFov: [40, 12],
  },
  {
    // The attackers' sniper: a .50 self-loader. One shot to the body or head kills, as the AWP's
    // does; it needs no bolt worked between shots, and pays for that in weight, kick and a slow second shot.
    id: 'colossus', name: 'Colossus .50', kind: 'sniper', slot: 0, price: 5200, killReward: 100, team: 0,
    damage: 120, armorPen: 0.98, rangeMod: 0.99, headMult: 4, rpm: 56, auto: false, pellets: 1,
    magSize: 5, reserve: 20, reloadTime: 3.9, drawTime: 1.1, maxSpeed: 4.7,
    spreadStand: 0.001, spreadCrouch: 0.0006, spreadMove: 0.18, spreadAir: 0.4, spreadPerShot: 0.06, spreadDecay: 2.4,
    pattern: spray(10, 5.0, 3, 0.6, [[3, 0.4], [6, -0.5], [9, 0.3]], 52), penetration: 2.5, kick: 3.4, range: 300,
    spreadUnscoped: 0.06, scopedSpeed: 2.2, scopeFov: [40, 12],
  },
  {
    // A machine pistol in each hand: the fastest fire in the game, fifty rounds between them,
    // and little idea where they are going past a few metres.
    id: 'vipers', name: 'Viper Twins', kind: 'smg', slot: 0, price: 1400, killReward: 600, team: 0,
    damage: 23, armorPen: 0.5, rangeMod: 0.78, headMult: 4, rpm: 900, auto: true, pellets: 1,
    magSize: 50, reserve: 100, reloadTime: 2.2, drawTime: 0.6, maxSpeed: 5.9,
    spreadStand: 0.016, spreadCrouch: 0.013, spreadMove: 0.02, spreadAir: 0.12, spreadPerShot: 0.0022, spreadDecay: 5,
    pattern: spray(50, 5.6, 14, 0.7, [[10, -0.9], [20, 1.5], [32, -1.7], [44, 1.1], [49, -0.4]], 61), penetration: 0.2, kick: 0.5, range: 100,
  },
  {
    // The defenders' pair: slower, steadier, forty rounds.
    id: 'wrens', name: 'Wren Twins', kind: 'smg', slot: 0, price: 1500, killReward: 600, team: 1,
    damage: 25, armorPen: 0.55, rangeMod: 0.8, headMult: 4, rpm: 780, auto: true, pellets: 1,
    magSize: 40, reserve: 80, reloadTime: 2.2, drawTime: 0.6, maxSpeed: 5.9,
    spreadStand: 0.013, spreadCrouch: 0.0105, spreadMove: 0.02, spreadAir: 0.12, spreadPerShot: 0.002, spreadDecay: 5.2,
    pattern: spray(40, 4.6, 13, 0.5, [[9, 0.7], [18, -1.2], [28, 1.3], [39, -0.6]], 62), penetration: 0.25, kick: 0.5, range: 100,
  },
];

export const WEAPONS: Record<string, WeaponDef> = Object.fromEntries(defs.map((d) => [d.id, d]));
export const WEAPON_LIST: readonly WeaponDef[] = defs;

export const DEFAULT_PISTOL = ['kite', 'tern'] as const;

export interface GearDef {
  id: string;
  name: string;
  price: number;
  team: -1 | 0 | 1;
}
export const GEAR: Record<string, GearDef> = {
  armor: { id: 'armor', name: 'Plating', price: 650, team: -1 },
  armorhelmet: { id: 'armorhelmet', name: 'Plating + Helm', price: 1000, team: -1 },
  kit: { id: 'kit', name: 'Disarm Kit', price: 400, team: 1 },
};

/** Sample the spray pattern at a fractional shot index. */
export function patternAt(def: WeaponDef, idx: number, out: { pitch: number; yaw: number }): void {
  const n = def.pattern.length / 2;
  if (idx <= 0) {
    out.pitch = 0;
    out.yaw = 0;
    return;
  }
  const c = Math.min(idx, n - 1);
  const i0 = Math.floor(c);
  const i1 = Math.min(i0 + 1, n - 1);
  const t = c - i0;
  out.pitch = def.pattern[i0 * 2]! * (1 - t) + def.pattern[i1 * 2]! * t;
  out.yaw = def.pattern[i0 * 2 + 1]! * (1 - t) + def.pattern[i1 * 2 + 1]! * t;
}
