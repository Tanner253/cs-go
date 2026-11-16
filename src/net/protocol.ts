// Wire protocol shared by the game server and the browser client.
// Messages are JSON; player state is a flat number array to keep snapshots small.

import type { Sim } from '../sim/game';
import type { Charge, Phase, Player, SimEvent, Team, WinReason } from '../sim/types';
import { WEAPON_LIST } from '../sim/weapons';

export const PROTOCOL = 1;
export const MAX_LOBBIES = 5;
/** A snapshot is sent every this many ticks (64 Hz sim -> 32 Hz snapshots). */
export const SNAP_EVERY = 2;

/** Rule overrides for a duel: shorter rounds, first to 7, sides swap after 6. */
export const RULES_1V1 = {
  freezeTime: 6,
  roundTime: 100,
  roundEndTime: 4,
  roundsToWin: 7,
  maxRounds: 12,
};

export interface LobbyInfo {
  id: number;
  name: string;
  players: string[];
  state: 'open' | 'waiting' | 'starting' | 'live';
}

export type ClientMsg =
  | { t: 'hello'; v: number; name: string }
  | { t: 'join'; id: number }
  | { t: 'leave' }
  | { t: 'ping'; c: number }
  /** One input command: seq, fwd, side, yaw, pitch, buttons, slot, buy, view time. */
  | { t: 'c'; q: number; f: number; s: number; y: number; p: number; b: number; w: number; u: string; v: number };

export type ServerMsg =
  | { t: 'welcome'; v: number; lobbies: LobbyInfo[] }
  | { t: 'lobbies'; lobbies: LobbyInfo[] }
  | { t: 'joined'; id: number }
  | { t: 'left'; reason: string }
  | { t: 'countdown'; seconds: number }
  | { t: 'start'; you: number; names: string[] }
  | { t: 'snap'; s: Snapshot }
  | { t: 'pong'; c: number }
  | { t: 'error'; message: string };

export interface Snapshot {
  /** Server tick and sim time after that tick. */
  k: number;
  t: number;
  ph: number;
  pt: number;
  lt: number;
  r: number;
  sc: [number, number];
  ls: [number, number];
  pl: number;
  lw: number;
  lr: number;
  mw: number;
  /** Charge: state, carrier, x, y, z, timer, site. */
  c: number[];
  /** One encoded player per id. */
  p: number[][];
  /** Last input sequence the server has applied, per player id. */
  a: number[];
  e: SimEvent[];
}

const PHASES: Phase[] = ['freeze', 'live', 'planted', 'end', 'over'];
const CHARGE_STATES: Charge['state'][] = ['carried', 'dropped', 'planted', 'disarmed', 'detonated'];
const REASONS: WinReason[] = ['elimination', 'time', 'detonation', 'disarm'];

const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const WEAPON_INDEX = new Map(WEAPON_LIST.map((d, i) => [d.id, i]));

export function encodePlayer(p: Player): number[] {
  const out: number[] = [
    p.team, p.alive ? 1 : 0, p.hp, r4(p.armor), p.helmet ? 1 : 0, p.kit ? 1 : 0, p.money, p.kills, p.deaths, p.hasCharge ? 1 : 0,
    r4(p.pos.x), r4(p.pos.y), r4(p.pos.z), r4(p.vel.x), r4(p.vel.y), r4(p.vel.z), r4(p.yaw), r4(p.pitch),
    p.onGround ? 1 : 0, p.ducked ? 1 : 0, r4(p.crouchT), r4(p.stepDist), r4(p.fallSpeed),
    p.wallJumps, p.lastWallNx, p.lastWallNz,
    r4(p.mantleT), r4(p.mantleFrom.x), r4(p.mantleFrom.y), r4(p.mantleFrom.z), r4(p.mantleTo.x), r4(p.mantleTo.y), r4(p.mantleTo.z),
    p.grappleOn ? 1 : 0, r4(p.grapplePoint.x), r4(p.grapplePoint.y), r4(p.grapplePoint.z), r4(p.grappleTime), r4(p.grappleReadyAt),
    p.active, p.lastActive, r4(p.drawTimer), r4(p.reloadTimer), r4(p.nextFireAt), r4(p.lastShotAt),
    r4(p.recoilIdx), r4(p.fireSpread), p.scope, r4(p.useTime), p.prevButtons, p.rescope, r4(p.fireBuffer),
  ];
  for (let i = 0; i < 3; i++) {
    const w = p.weapons[i];
    if (w) out.push(WEAPON_INDEX.get(w.def.id)!, w.mag, w.reserve);
    else out.push(-1, 0, 0);
  }
  return out;
}

export function decodePlayer(p: Player, a: number[]): void {
  let i = 0;
  const n = (): number => a[i++]!;
  p.team = n() as Team; p.alive = n() === 1; p.hp = n(); p.armor = n(); p.helmet = n() === 1; p.kit = n() === 1;
  p.money = n(); p.kills = n(); p.deaths = n(); p.hasCharge = n() === 1;
  p.pos.x = n(); p.pos.y = n(); p.pos.z = n(); p.vel.x = n(); p.vel.y = n(); p.vel.z = n(); p.yaw = n(); p.pitch = n();
  p.onGround = n() === 1; p.ducked = n() === 1; p.crouchT = n(); p.stepDist = n(); p.fallSpeed = n();
  p.wallJumps = n(); p.lastWallNx = n(); p.lastWallNz = n();
  p.mantleT = n(); p.mantleFrom.x = n(); p.mantleFrom.y = n(); p.mantleFrom.z = n(); p.mantleTo.x = n(); p.mantleTo.y = n(); p.mantleTo.z = n();
  p.grappleOn = n() === 1; p.grapplePoint.x = n(); p.grapplePoint.y = n(); p.grapplePoint.z = n(); p.grappleTime = n(); p.grappleReadyAt = n();
  p.active = n(); p.lastActive = n(); p.drawTimer = n(); p.reloadTimer = n(); p.nextFireAt = n(); p.lastShotAt = n();
  p.recoilIdx = n(); p.fireSpread = n(); p.scope = n() as 0 | 1 | 2; p.useTime = n(); p.prevButtons = n(); p.rescope = n() as 0 | 1 | 2; p.fireBuffer = n();
  for (let s = 0; s < 3; s++) {
    const wi = n(), mag = n(), reserve = n();
    if (wi < 0) {
      p.weapons[s] = null;
      continue;
    }
    const def = WEAPON_LIST[wi]!;
    let w = p.weapons[s];
    if (!w || w.def !== def) p.weapons[s] = w = { def, mag, reserve };
    w.mag = mag;
    w.reserve = reserve;
  }
}

export function takeSnapshot(sim: Sim, acks: number[], events: SimEvent[]): Snapshot {
  const c = sim.charge;
  return {
    k: sim.tickCount,
    t: r4(sim.time),
    ph: PHASES.indexOf(sim.phase),
    pt: r4(sim.phaseTime),
    lt: r4(sim.liveTime),
    r: sim.round,
    sc: [sim.score[0], sim.score[1]],
    ls: [sim.lossStreak[0], sim.lossStreak[1]],
    pl: sim.planted ? 1 : 0,
    lw: sim.lastWinner,
    lr: REASONS.indexOf(sim.lastReason),
    mw: sim.matchWinner,
    c: [CHARGE_STATES.indexOf(c.state), c.carrier, r4(c.pos.x), r4(c.pos.y), r4(c.pos.z), r4(c.timer), c.site],
    p: sim.players.map(encodePlayer),
    a: acks,
    e: events,
  };
}

/** Overwrite a client-side replica with authoritative state. */
export function applySnapshot(sim: Sim, s: Snapshot): void {
  sim.tickCount = s.k;
  sim.time = s.t;
  sim.phase = PHASES[s.ph]!;
  sim.phaseTime = s.pt;
  sim.liveTime = s.lt;
  sim.round = s.r;
  sim.score[0] = s.sc[0]; sim.score[1] = s.sc[1];
  sim.lossStreak[0] = s.ls[0]; sim.lossStreak[1] = s.ls[1];
  sim.planted = s.pl === 1;
  sim.lastWinner = s.lw as Team;
  sim.lastReason = REASONS[s.lr]!;
  sim.matchWinner = s.mw as -1 | Team;
  const c = sim.charge;
  c.state = CHARGE_STATES[s.c[0]!]!;
  c.carrier = s.c[1]!;
  c.pos.x = s.c[2]!; c.pos.y = s.c[3]!; c.pos.z = s.c[4]!;
  c.timer = s.c[5]!;
  c.site = s.c[6]!;
  for (let i = 0; i < s.p.length && i < sim.players.length; i++) decodePlayer(sim.players[i]!, s.p[i]!);
}

const ITEMS = new Set<string>([...WEAPON_LIST.map((d) => d.id), 'armor', 'armorhelmet', 'kit']);
/** Sanitise an untrusted purchase id. */
export const validItem = (id: unknown): string => (typeof id === 'string' && ITEMS.has(id) ? id : '');

/** Sanitise an untrusted display name. */
export function cleanName(name: unknown): string {
  const s = typeof name === 'string' ? name.replace(/[^\w \-.]/g, '').trim().slice(0, 14) : '';
  return s || 'Operator';
}
