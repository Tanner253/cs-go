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
}

/**
 * Deterministic, learnable spray pattern: a hard vertical climb that flattens out,
 * then side-to-side sway. Shot 0 is always dead on.
 */
function makePattern(
  shots: number, climbDeg: number, climbShots: number,
  swayDeg: number, swayStart: number, swayPeriod: number, seed: number,
): Float32Array {
  const rng = new Rng(seed);
  const out = new Float32Array(shots * 2);
  let dir = rng.next() < 0.5 ? -1 : 1;
  for (let i = 1; i < shots; i++) {
    const climb = climbDeg * (1 - Math.exp(-i / climbShots));
    let sway = 0;
    if (i > swayStart) {
      const k = (i - swayStart) / swayPeriod;
      sway = Math.sin(k * Math.PI * 2) * swayDeg * Math.min(1, (i - swayStart) / 3) * dir;
    }
    out[i * 2] = (climb + rng.range(-0.08, 0.08)) * DEG;
    out[i * 2 + 1] = (sway + rng.range(-0.1, 0.1)) * DEG;
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
    damage: 28, armorPen: 0.47, rangeMod: 0.9, headMult: 4, rpm: 400, auto: false, pellets: 1,
    magSize: 20, reserve: 120, reloadTime: 2.2, drawTime: 0.45, maxSpeed: 6.1,
    spreadStand: 0.0055, spreadCrouch: 0.004, spreadMove: 0.03, spreadAir: 0.2, spreadPerShot: 0.012, spreadDecay: 6,
    pattern: makePattern(20, 2.2, 6, 0.5, 4, 7, 11), penetration: 0.25, kick: 0.7, range: 120,
  },
  {
    id: 'tern', name: 'Tern P7', kind: 'pistol', slot: 1, price: 200, killReward: 300, team: 1,
    damage: 34, armorPen: 0.5, rangeMod: 0.92, headMult: 4, rpm: 352, auto: false, pellets: 1,
    magSize: 12, reserve: 48, reloadTime: 2.2, drawTime: 0.45, maxSpeed: 6.1,
    spreadStand: 0.004, spreadCrouch: 0.003, spreadMove: 0.035, spreadAir: 0.2, spreadPerShot: 0.014, spreadDecay: 6,
    pattern: makePattern(12, 2.6, 5, 0.4, 4, 6, 12), penetration: 0.25, kick: 0.8, range: 120,
  },
  {
    id: 'maul', name: 'Maul .50', kind: 'pistol', slot: 1, price: 700, killReward: 300, team: -1,
    damage: 61, armorPen: 0.93, rangeMod: 0.88, headMult: 4, rpm: 267, auto: false, pellets: 1,
    magSize: 7, reserve: 35, reloadTime: 2.2, drawTime: 0.5, maxSpeed: 5.84,
    spreadStand: 0.004, spreadCrouch: 0.003, spreadMove: 0.07, spreadAir: 0.3, spreadPerShot: 0.05, spreadDecay: 3.2,
    pattern: makePattern(7, 5.5, 3, 0.8, 2, 5, 13), penetration: 0.6, kick: 1.6, range: 120,
  },
  {
    id: 'wasp', name: 'Wasp SMG', kind: 'smg', slot: 0, price: 1250, killReward: 600, team: -1,
    damage: 26, armorPen: 0.6, rangeMod: 0.82, headMult: 4, rpm: 800, auto: true, pellets: 1,
    magSize: 30, reserve: 120, reloadTime: 2.6, drawTime: 0.6, maxSpeed: 6.1,
    spreadStand: 0.009, spreadCrouch: 0.007, spreadMove: 0.028, spreadAir: 0.16, spreadPerShot: 0.0028, spreadDecay: 5,
    pattern: makePattern(30, 4.6, 7, 1.5, 6, 9, 21), penetration: 0.3, kick: 0.6, range: 120,
  },
  {
    id: 'breaker', name: 'Breaker', kind: 'shotgun', slot: 0, price: 1100, killReward: 900, team: -1,
    damage: 22, armorPen: 0.5, rangeMod: 0.6, headMult: 2, rpm: 68, auto: false, pellets: 9,
    magSize: 7, reserve: 28, reloadTime: 3.0, drawTime: 0.7, maxSpeed: 5.6,
    spreadStand: 0.045, spreadCrouch: 0.04, spreadMove: 0.02, spreadAir: 0.1, spreadPerShot: 0.01, spreadDecay: 4,
    pattern: makePattern(7, 6, 2, 1, 1, 4, 31), penetration: 0, kick: 2.2, range: 60,
  },
  {
    id: 'hammerhead', name: 'Hammerhead AR', kind: 'rifle', slot: 0, price: 2700, killReward: 300, team: 0,
    damage: 36, armorPen: 0.775, rangeMod: 0.96, headMult: 4, rpm: 600, auto: true, pellets: 1,
    magSize: 30, reserve: 90, reloadTime: 2.5, drawTime: 0.7, maxSpeed: 5.46,
    spreadStand: 0.004, spreadCrouch: 0.003, spreadMove: 0.11, spreadAir: 0.26, spreadPerShot: 0.0035, spreadDecay: 4.5,
    pattern: makePattern(30, 7.8, 5.5, 2.6, 7, 10, 41), penetration: 1.0, kick: 1.0, range: 200,
  },
  {
    id: 'lumen', name: 'Lumen AR', kind: 'rifle', slot: 0, price: 3000, killReward: 300, team: 1,
    damage: 33, armorPen: 0.7, rangeMod: 0.97, headMult: 4, rpm: 666, auto: true, pellets: 1,
    magSize: 30, reserve: 90, reloadTime: 3.0, drawTime: 0.7, maxSpeed: 5.72,
    spreadStand: 0.0033, spreadCrouch: 0.0025, spreadMove: 0.1, spreadAir: 0.26, spreadPerShot: 0.003, spreadDecay: 5,
    pattern: makePattern(30, 6.4, 6, 2.0, 8, 11, 42), penetration: 0.9, kick: 0.85, range: 200,
  },
  {
    id: 'longsight', name: 'Longsight', kind: 'sniper', slot: 0, price: 4750, killReward: 100, team: -1,
    damage: 115, armorPen: 0.975, rangeMod: 0.99, headMult: 4, rpm: 41, auto: false, pellets: 1,
    magSize: 5, reserve: 30, reloadTime: 3.6, drawTime: 1.0, maxSpeed: 5.08,
    spreadStand: 0.0008, spreadCrouch: 0.0005, spreadMove: 0.16, spreadAir: 0.4, spreadPerShot: 0.05, spreadDecay: 3,
    pattern: makePattern(5, 3, 2, 0, 9, 9, 51), penetration: 2.0, kick: 3.0, range: 300,
    spreadUnscoped: 0.055, scopedSpeed: 2.5, scopeFov: [40, 12],
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
