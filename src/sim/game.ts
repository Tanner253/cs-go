// The authoritative simulation: fixed 64 Hz tick, driven only by per-player input commands.
// Nothing in here touches the DOM or the renderer, so the same class can run on a server.

import { Rng, forwardFromAngles, v3, type Vec3 } from './math';
import { World, newRayHit, newTrace } from './world';
import { buildMap, inZone, type MapDef } from './map';
import { Nav } from './nav';
import { GRAVITY, endGrapple, eyeHeight, hullHeight, movePlayer } from './movement';
import { DEFAULT_PISTOL, GEAR, WEAPONS, patternAt, type WeaponDef } from './weapons';
import { Bot, assignRoles } from './bot';
import {
  ATK, BTN_ALT, BTN_FIRE, BTN_RELOAD, BTN_USE, DEF, HIT_NONE, HIT_PLAYER, HIT_WORLD, HULL_HALF, TICK,
  emptyCmd,
  type Charge, type Cmd, type Phase, type Player, type SimEvent, type Team, type WeaponState, type WinReason,
} from './types';

export const RULES = {
  freezeTime: 7,
  roundTime: 115,
  buyTime: 20,
  plantTime: 3.2,
  chargeTime: 40,
  disarmTime: 10,
  disarmTimeKit: 5,
  roundEndTime: 5,
  roundsToWin: 13,
  maxRounds: 24,
  startMoney: 800,
  maxMoney: 16000,
  blastRadius: 18,
  blastDamage: 500,
  /** Grapple hook, wall-jump and mantle. Off: the game plays as a classic ground shooter. */
  verticalKit: false,
};

export interface SimOptions {
  seed?: number;
  teamSize?: number;
  /** 0 (easy) .. 1 (hard). */
  botSkill?: number;
  /** Team for the human player, or null for an all-bot match. */
  humanTeam?: Team | null;
  humanName?: string;
  /** false = every player is human-controlled (online play). */
  bots?: boolean;
  /** Player names in id order (online play). */
  names?: string[];
  rules?: Partial<typeof RULES>;
}

/** Ticks of position history kept for lag compensation (1 second). */
const HISTORY = 64;

const BOT_NAMES = ['Vex', 'Ion', 'Nyx', 'Rook', 'Quill', 'Tarn', 'Juno', 'Kade', 'Lyra', 'Moss', 'Orin', 'Pax'];

const HEAD = 0, CHEST = 1, STOMACH = 2, LEGS = 3;

const ray = newRayHit();
const tr = newTrace();
const fwd = v3();
const punch = { pitch: 0, yaw: 0 };
const pHit = { t: 0, group: 0 };

/** Ray vs a vertical cylinder segment. Returns entry distance or -1. */
function rayCylinder(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  cx: number, cz: number, y0: number, y1: number, r: number,
): number {
  const px = ox - cx, pz = oz - cz;
  const a = dx * dx + dz * dz;
  let t0 = -Infinity, t1 = Infinity;
  if (a < 1e-9) {
    if (px * px + pz * pz > r * r) return -1;
  } else {
    const b = px * dx + pz * dz;
    const c = px * px + pz * pz - r * r;
    const disc = b * b - a * c;
    if (disc < 0) return -1;
    const s = Math.sqrt(disc);
    t0 = (-b - s) / a;
    t1 = (-b + s) / a;
  }
  if (dy > 1e-9 || dy < -1e-9) {
    let ta = (y0 - oy) / dy, tb = (y1 - oy) / dy;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  } else if (oy < y0 || oy > y1) {
    return -1;
  }
  if (t0 > t1 || t1 < 0) return -1;
  return t0 < 0 ? 0 : t0;
}

function raySphere(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number, r: number,
): number {
  const px = ox - cx, py = oy - cy, pz = oz - cz;
  const b = px * dx + py * dy + pz * dz;
  const c = px * px + py * py + pz * pz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  if (t < 0) return c < 0 ? 0 : -1;
  return t;
}

export class Sim {
  readonly map: MapDef;
  readonly world: World;
  readonly nav: Nav;
  readonly rules: typeof RULES;
  readonly rng: Rng;
  readonly players: Player[] = [];
  readonly bots = new Map<number, Bot>();
  readonly cmds: Cmd[] = [];
  readonly charge: Charge = { state: 'carried', carrier: -1, pos: v3(), timer: 0, site: -1 };
  /** Events produced since the consumer last cleared them. */
  events: SimEvent[] = [];

  time = 0;
  tickCount = 0;
  phase: Phase = 'freeze';
  /** Seconds left in the current phase. */
  phaseTime = 0;
  /** Seconds since the round went live. */
  liveTime = 0;
  round = 0;
  score: [number, number] = [0, 0];
  lossStreak: [number, number] = [0, 0];
  planted = false;
  lastWinner: Team = ATK;
  lastReason: WinReason = 'elimination';
  matchWinner: -1 | Team = -1;
  /** Shared bot knowledge: where each team last saw the enemy push. */
  intel: [{ site: number; time: number }, { site: number; time: number }] = [{ site: -1, time: -99 }, { site: -1, time: -99 }];
  botSkill: number;
  /** Id of the player this machine controls (-1 on a server or in an all-bot match). */
  localId = -1;
  /**
   * True while a client is predicting its own player: movement and weapon handling run,
   * but nothing authoritative (damage, purchases, objective completion) is applied.
   */
  predicting = false;
  private history: Float32Array[] = [];
  private shotRng = new Rng(1);
  private saved = new Float32Array(4 * 16);

  constructor(opts: SimOptions = {}) {
    this.rules = { ...RULES, ...opts.rules };
    this.rng = new Rng(opts.seed ?? 1337);
    this.botSkill = opts.botSkill ?? 0.5;
    this.map = buildMap();
    this.world = new World(this.map.boxes);
    this.nav = new Nav(this.world, [...this.map.spawns[0], ...this.map.spawns[1]]);

    const size = opts.teamSize ?? 5;
    const humanTeam = opts.humanTeam === undefined ? ATK : opts.humanTeam;
    let nameI = 0;
    for (let team = 0 as Team; team <= 1; team = (team + 1) as Team) {
      for (let i = 0; i < size; i++) {
        const human = opts.bots === false || (humanTeam === team && i === 0);
        const id = this.players.length;
        const name = opts.names?.[id] ?? (human && opts.bots !== false ? opts.humanName ?? 'You' : BOT_NAMES[nameI++ % BOT_NAMES.length]!);
        const p = this.addPlayer(name, team, !human);
        if (human && opts.bots !== false) this.localId = p.id;
      }
    }
    this.startRound(true);
  }

  // ---- players -------------------------------------------------------------------

  private addPlayer(name: string, team: Team, isBot: boolean): Player {
    const p: Player = {
      id: this.players.length, name, team, isBot,
      alive: false, hp: 100, armor: 0, helmet: false, kit: false, money: this.rules.startMoney,
      kills: 0, deaths: 0, hasCharge: false,
      pos: v3(), prevPos: v3(), vel: v3(), yaw: 0, pitch: 0,
      onGround: true, ducked: false, crouchT: 0, prevCrouchT: 0, stepDist: 0, fallSpeed: 0,
      wallJumps: 0, lastWallNx: 0, lastWallNz: 0,
      mantleT: -1, mantleFrom: v3(), mantleTo: v3(),
      grappleOn: false, grapplePoint: v3(), grappleTime: 0, grappleReadyAt: 0,
      weapons: [null, null, null], active: 1, lastActive: 2,
      drawTimer: 0, reloadTimer: 0, nextFireAt: 0, lastShotAt: -99, recoilIdx: 0,
      punchPitch: 0, punchYaw: 0, fireSpread: 0, scope: 0, rescope: 0, fireBuffer: 0, useTime: 0, prevButtons: 0, spawnIndex: 0,
    };
    this.players.push(p);
    this.cmds.push(emptyCmd());
    this.history.push(new Float32Array(HISTORY * 4));
    if (isBot) this.bots.set(p.id, new Bot(p, this));
    return p;
  }

  /** The player controlled on this machine, if any. */
  get human(): Player | null {
    return this.localId >= 0 ? this.players[this.localId]! : null;
  }

  aliveCount(team: Team): number {
    let n = 0;
    for (const p of this.players) if (p.alive && p.team === team) n++;
    return n;
  }

  activeDef(p: Player): WeaponDef {
    return (p.weapons[p.active] ?? p.weapons[2]!).def;
  }

  moveSpeed(p: Player): number {
    const def = this.activeDef(p);
    if (def.kind === 'sniper' && p.scope > 0) return def.scopedSpeed!;
    return def.maxSpeed;
  }

  private makeWeapon(id: string): WeaponState {
    const def = WEAPONS[id]!;
    return { def, mag: def.magSize, reserve: def.reserve };
  }

  private resetLoadout(p: Player): void {
    p.weapons = [null, this.makeWeapon(DEFAULT_PISTOL[p.team]), this.makeWeapon('edge')];
    p.armor = 0;
    p.helmet = false;
    p.kit = false;
    p.active = 1;
    p.lastActive = 2;
  }

  // ---- round flow ------------------------------------------------------------------

  private startRound(fresh: boolean): void {
    this.round++;
    this.phase = 'freeze';
    this.phaseTime = this.rules.freezeTime;
    this.liveTime = 0;
    this.planted = false;
    this.intel[0].site = this.intel[1].site = -1;

    const used: [number, number] = [0, 0];
    const offset = this.rng.int(7);
    for (const p of this.players) {
      if (fresh || !p.alive) this.resetLoadout(p);
      const spawns = this.map.spawns[p.team];
      const s = spawns[(offset + used[p.team]++) % spawns.length]!;
      p.alive = true;
      p.hp = 100;
      p.pos.x = s.x; p.pos.y = s.y + 0.002; p.pos.z = s.z;
      p.prevPos.x = s.x; p.prevPos.y = p.pos.y; p.prevPos.z = s.z;
      p.vel.x = p.vel.y = p.vel.z = 0;
      p.yaw = this.map.spawnYaw[p.team];
      p.pitch = 0;
      p.onGround = true;
      p.ducked = false;
      p.crouchT = p.prevCrouchT = 0;
      p.mantleT = -1;
      p.grappleOn = false;
      p.grappleReadyAt = 0;
      p.wallJumps = 0;
      p.hasCharge = false;
      p.useTime = 0;
      p.scope = 0;
      p.rescope = 0;
      p.fireBuffer = 0;
      p.reloadTimer = 0;
      p.recoilIdx = 0;
      p.punchPitch = p.punchYaw = 0;
      p.fireSpread = 0;
      p.nextFireAt = 0;
      p.prevButtons = 0;
      p.drawTimer = 0.3;
      if (!p.weapons[p.active]) p.active = p.weapons[0] ? 0 : 1;
      // Top up ammunition for carried weapons.
      for (const w of p.weapons) {
        if (w && w.def.magSize > 0) { w.mag = w.def.magSize; w.reserve = w.def.reserve; }
      }
    }

    const attackers = this.players.filter((p) => p.team === ATK);
    const carrier = this.rng.pick(attackers);
    carrier.hasCharge = true;
    this.charge.state = 'carried';
    this.charge.carrier = carrier.id;
    this.charge.site = -1;
    this.charge.timer = 0;

    assignRoles(this);
    this.events.push({ type: 'roundStart', round: this.round });
  }

  private addMoney(p: Player, amount: number): void {
    p.money = Math.min(this.rules.maxMoney, p.money + amount);
  }

  private endRound(winner: Team, reason: WinReason): void {
    if (this.phase === 'end' || this.phase === 'over') return;
    this.phase = 'end';
    this.phaseTime = this.rules.roundEndTime;
    this.lastWinner = winner;
    this.lastReason = reason;
    this.score[winner]++;
    const loser = (1 - winner) as Team;
    this.lossStreak[winner] = 0;
    this.lossStreak[loser] = Math.min(5, this.lossStreak[loser] + 1);

    const winBonus = reason === 'detonation' || reason === 'disarm' ? 3500 : 3250;
    const lossBonus = 900 + 500 * this.lossStreak[loser];
    for (const p of this.players) {
      if (p.team === winner) {
        this.addMoney(p, winBonus);
      } else {
        // Attackers who simply ran out the clock while alive get nothing.
        if (reason === 'time' && p.team === ATK && p.alive) continue;
        this.addMoney(p, lossBonus + (p.team === ATK && this.planted ? 800 : 0));
      }
    }
    this.events.push({ type: 'roundEnd', winner, reason });
  }

  private afterRound(): void {
    const { roundsToWin, maxRounds } = this.rules;
    if (this.score[0] >= roundsToWin || this.score[1] >= roundsToWin || this.round >= maxRounds) {
      this.phase = 'over';
      this.matchWinner = this.score[0] === this.score[1] ? -1 : this.score[0] > this.score[1] ? 0 : 1;
      this.events.push({ type: 'matchEnd', winner: this.matchWinner });
      return;
    }
    if (this.round === maxRounds / 2) {
      // Half time: swap sides, reset the economy.
      for (const p of this.players) {
        p.team = (1 - p.team) as Team;
        p.money = this.rules.startMoney;
        p.alive = false;
      }
      this.score = [this.score[1], this.score[0]];
      this.lossStreak = [0, 0];
      this.events.push({ type: 'halftime' });
      this.startRound(true);
      return;
    }
    this.startRound(false);
  }

  // ---- buying ----------------------------------------------------------------------

  canBuy(p: Player): boolean {
    if (!p.alive) return false;
    if (this.phase === 'freeze') return true;
    if (this.phase !== 'live' || this.liveTime > this.rules.buyTime) return false;
    return inZone(this.map.buyZones[p.team], p.pos.x, p.pos.z);
  }

  tryBuy(p: Player, item: string): boolean {
    if (!this.canBuy(p)) return false;
    const def = WEAPONS[item];
    if (def) {
      if (def.kind === 'knife' || (def.team !== -1 && def.team !== p.team)) return false;
      if (p.money < def.price || p.weapons[def.slot]?.def.id === def.id) return false;
      p.money -= def.price;
      p.weapons[def.slot] = this.makeWeapon(item);
      this.switchTo(p, def.slot);
      return true;
    }
    const gear = GEAR[item];
    if (!gear || (gear.team !== -1 && gear.team !== p.team)) return false;
    if (item === 'armor') {
      if (p.armor >= 100 || p.money < gear.price) return false;
      p.money -= gear.price;
      p.armor = 100;
      return true;
    }
    if (item === 'armorhelmet') {
      if (p.armor >= 100 && p.helmet) return false;
      const price = p.armor >= 100 ? 350 : gear.price;
      if (p.money < price) return false;
      p.money -= price;
      p.armor = 100;
      p.helmet = true;
      return true;
    }
    if (item === 'kit') {
      if (p.kit || p.money < gear.price) return false;
      p.money -= gear.price;
      p.kit = true;
      return true;
    }
    return false;
  }

  // ---- weapons ---------------------------------------------------------------------

  private switchTo(p: Player, slot: number): void {
    if (slot === p.active || !p.weapons[slot]) return;
    p.lastActive = p.active;
    p.active = slot;
    const def = p.weapons[slot]!.def;
    p.drawTimer = def.drawTime;
    p.reloadTimer = 0;
    p.scope = 0;
    p.rescope = 0;
    p.fireBuffer = 0;
    p.recoilIdx = 0;
    p.fireSpread = 0;
    this.events.push({ type: 'draw', player: p.id, weapon: def.id });
  }

  /** Current total inaccuracy (radians) — also drives the crosshair. */
  spreadOf(p: Player): number {
    const w = p.weapons[p.active];
    if (!w) return 0;
    const def = w.def;
    if (def.kind === 'knife') return 0;
    let s = p.ducked ? def.spreadCrouch : def.spreadStand;
    if (def.kind === 'sniper' && p.scope === 0) s = def.spreadUnscoped!;
    s += p.fireSpread;
    if (!p.onGround) {
      s += def.spreadAir;
    } else {
      const speed = Math.hypot(p.vel.x, p.vel.z);
      // Below ~34% of run speed there is no penalty: that is what makes counter-strafing work.
      const f = (speed / def.maxSpeed - 0.34) / (0.95 - 0.34);
      if (f > 0) s += def.spreadMove * (f > 1 ? 1 : f);
    }
    return s;
  }

  private updateWeapon(p: Player, cmd: Cmd, canAct: boolean): void {
    const now = this.time;
    if (cmd.slot >= 0 && cmd.slot <= 2) this.switchTo(p, cmd.slot);
    else if (cmd.slot === 3) this.switchTo(p, p.weapons[p.lastActive] ? p.lastActive : 2);

    const w = p.weapons[p.active]!;
    const def = w.def;
    const pressed = cmd.buttons & ~p.prevButtons;

    // Recoil and spread recovery.
    if (now - p.lastShotAt > 60 / def.rpm + 0.07 && p.recoilIdx > 0) {
      p.recoilIdx = Math.max(0, p.recoilIdx - (3 + p.recoilIdx * 5) * TICK);
    }
    patternAt(def, p.recoilIdx, punch);
    p.punchPitch = punch.pitch;
    p.punchYaw = punch.yaw;
    p.fireSpread *= Math.exp(-def.spreadDecay * TICK);

    if (p.drawTimer > 0) {
      p.drawTimer -= TICK;
      return;
    }
    if (p.reloadTimer > 0) {
      p.reloadTimer -= TICK;
      if (p.reloadTimer > 0) return;
      const need = Math.min(def.magSize - w.mag, w.reserve);
      w.mag += need;
      w.reserve -= need;
    }
    if (!canAct) return;

    if (def.kind !== 'knife' && pressed & BTN_RELOAD && w.mag < def.magSize && w.reserve > 0) {
      this.startReload(p, w);
      return;
    }
    if (def.kind === 'sniper') {
      if (pressed & BTN_ALT) {
        p.scope = ((p.scope + 1) % 3) as 0 | 1 | 2;
        p.rescope = 0;
        this.events.push({ type: 'scope', player: p.id, level: p.scope });
      } else if (p.rescope > 0 && now >= p.nextFireAt - 0.2) {
        // Bolt cycled: back onto the scope at the zoom level used for the last shot.
        p.scope = p.rescope;
        p.rescope = 0;
        this.events.push({ type: 'scope', player: p.id, level: p.scope });
      }
    }

    if (!def.auto && pressed & BTN_FIRE) p.fireBuffer = now + 0.12;
    const wantFire = def.auto ? cmd.buttons & BTN_FIRE : pressed & BTN_FIRE || now < p.fireBuffer;
    if (!wantFire || now < p.nextFireAt) return;
    p.fireBuffer = 0;
    if (def.kind === 'knife') {
      this.rewind(p, cmd.lag);
      this.knife(p, def);
      this.restore(p, cmd.lag);
    } else if (w.mag <= 0) {
      if (pressed & BTN_FIRE) this.events.push({ type: 'dry', player: p.id });
      if (w.reserve > 0) this.startReload(p, w);
      else p.nextFireAt = now + 0.2;
    } else {
      this.rewind(p, cmd.lag);
      this.shoot(p, w, cmd.seq);
      this.restore(p, cmd.lag);
    }
  }

  // ---- lag compensation -------------------------------------------------------------
  // The shooter saw other players where they were a few ticks ago, so hits are tested
  // against those positions ("favour the shooter").

  private rewind(shooter: Player, lag: number): void {
    if (lag <= 0 || this.predicting) return;
    const back = Math.min(HISTORY - 1, lag);
    const slot = (((this.tickCount - back) % HISTORY) + HISTORY) % HISTORY;
    for (const v of this.players) {
      if (v === shooter || v.id >= 16) continue;
      const s = this.saved, h = this.history[v.id]!;
      s[v.id * 4] = v.pos.x; s[v.id * 4 + 1] = v.pos.y; s[v.id * 4 + 2] = v.pos.z; s[v.id * 4 + 3] = v.crouchT;
      v.pos.x = h[slot * 4]!; v.pos.y = h[slot * 4 + 1]!; v.pos.z = h[slot * 4 + 2]!; v.crouchT = h[slot * 4 + 3]!;
    }
  }

  private restore(shooter: Player, lag: number): void {
    if (lag <= 0 || this.predicting) return;
    for (const v of this.players) {
      if (v === shooter || v.id >= 16) continue;
      const s = this.saved;
      v.pos.x = s[v.id * 4]!; v.pos.y = s[v.id * 4 + 1]!; v.pos.z = s[v.id * 4 + 2]!; v.crouchT = s[v.id * 4 + 3]!;
    }
  }

  private startReload(p: Player, w: WeaponState): void {
    p.reloadTimer = w.def.reloadTime;
    p.scope = 0;
    p.rescope = 0;
    this.events.push({ type: 'reload', player: p.id, weapon: w.def.id });
  }

  private eyeY(p: Player): number {
    return p.pos.y + eyeHeight(p);
  }

  /** Nearest hit-group intersection on a player, or false. */
  private rayPlayer(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, v: Player, maxT: number): boolean {
    // Quick reject against a bounding cylinder.
    const s = 1 - 0.25 * v.crouchT;
    const top = v.pos.y + 1.86 * s;
    if (rayCylinder(ox, oy, oz, dx, dy, dz, v.pos.x, v.pos.z, v.pos.y, top, 0.45) < 0) return false;
    let best = maxT, group = -1;
    let t = raySphere(ox, oy, oz, dx, dy, dz, v.pos.x, v.pos.y + eyeHeight(v) + 0.06, v.pos.z, 0.135);
    if (t >= 0 && t < best) { best = t; group = HEAD; }
    t = rayCylinder(ox, oy, oz, dx, dy, dz, v.pos.x, v.pos.z, v.pos.y + 1.08 * s, v.pos.y + 1.52 * s, 0.26);
    if (t >= 0 && t < best) { best = t; group = CHEST; }
    t = rayCylinder(ox, oy, oz, dx, dy, dz, v.pos.x, v.pos.z, v.pos.y + 0.82 * s, v.pos.y + 1.08 * s, 0.24);
    if (t >= 0 && t < best) { best = t; group = STOMACH; }
    t = rayCylinder(ox, oy, oz, dx, dy, dz, v.pos.x, v.pos.z, v.pos.y, v.pos.y + 0.82 * s, 0.2);
    if (t >= 0 && t < best) { best = t; group = LEGS; }
    if (group < 0) return false;
    pHit.t = best;
    pHit.group = group;
    return true;
  }

  private shoot(p: Player, w: WeaponState, seq: number): void {
    const def = w.def;
    // Online, spread is seeded from the command so the client's predicted tracer matches the server.
    let rng = this.rng;
    if (seq > 0) {
      rng = this.shotRng;
      rng.reseed(Math.imul(seq, 2654435761) ^ Math.imul(p.id + 1, 40503));
    }
    const now = this.time;
    const interval = 60 / def.rpm;
    if (p.nextFireAt < now - TICK) p.nextFireAt = now;
    p.nextFireAt += interval;
    w.mag--;

    const spread = this.spreadOf(p);
    const ox = p.pos.x, oy = this.eyeY(p), oz = p.pos.z;
    const yaw = p.yaw + p.punchYaw, pitch = p.pitch + p.punchPitch;
    forwardFromAngles(yaw, pitch, fwd);
    // Basis for the spread cone.
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const ux = fwd.y * rz, uy = fwd.z * rx - fwd.x * rz, uz = -fwd.y * rx;

    const ends: number[] = [];
    const kinds: number[] = [];
    for (let i = 0; i < def.pellets; i++) {
      const a = rng.next() * Math.PI * 2;
      const r = spread * (def.pellets > 1 ? Math.sqrt(rng.next()) : rng.next());
      const sx = Math.cos(a) * r, sy = Math.sin(a) * r;
      let dx = fwd.x + rx * sx + ux * sy;
      let dy = fwd.y + uy * sy;
      let dz = fwd.z + rz * sx + uz * sy;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
      dx *= inv; dy *= inv; dz *= inv;
      this.traceBullet(p, def, ox, oy, oz, dx, dy, dz, ends, kinds);
    }

    p.recoilIdx += 1;
    p.fireSpread = Math.min(def.spreadPerShot * 8, p.fireSpread + def.spreadPerShot);
    p.lastShotAt = now;
    patternAt(def, p.recoilIdx, punch);
    p.punchPitch = punch.pitch;
    p.punchYaw = punch.yaw;
    if (def.kind === 'sniper' && p.scope > 0) {
      p.rescope = w.mag > 0 ? p.scope : 0;
      p.scope = 0;
      this.events.push({ type: 'scope', player: p.id, level: 0 });
    }
    this.events.push({ type: 'shot', player: p.id, weapon: def.id, ox, oy, oz, ends, hitKinds: kinds });
  }

  private traceBullet(
    p: Player, def: WeaponDef,
    ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
    ends: number[], kinds: number[],
  ): void {
    let factor = 1;
    let travelled = 0;
    let sx = ox, sy = oy, sz = oz;
    let skip = -1;
    let wallbang = false;
    let recorded = false;

    for (let pass = 0; pass < 3; pass++) {
      const maxDist = def.range - travelled;
      if (maxDist <= 0) break;
      const worldHit = this.world.raycast(sx, sy, sz, dx, dy, dz, maxDist, ray, skip);
      const wdist = ray.dist;
      const wbox = ray.box, wnx = ray.nx, wny = ray.ny, wnz = ray.nz;

      let victim: Player | null = null;
      let vt = wdist, vgroup = 0;
      for (const v of this.players) {
        if (!v.alive || v.team === p.team) continue;
        if (this.rayPlayer(sx, sy, sz, dx, dy, dz, v, vt)) {
          victim = v;
          vt = pHit.t;
          vgroup = pHit.group;
        }
      }

      if (victim) {
        const hx = sx + dx * vt, hy = sy + dy * vt, hz = sz + dz * vt;
        if (!recorded) { ends.push(hx, hy, hz, -dx, -dy, -dz); kinds.push(HIT_PLAYER); recorded = true; }
        this.damage(victim, p, def, def.damage * factor, vgroup, travelled + vt, hx, hy, hz, wallbang);
        return;
      }
      if (!worldHit) {
        if (!recorded) { ends.push(sx + dx * maxDist, sy + dy * maxDist, sz + dz * maxDist, 0, 1, 0); kinds.push(HIT_NONE); }
        return;
      }
      if (!recorded) {
        ends.push(sx + dx * wdist, sy + dy * wdist, sz + dz * wdist, wnx, wny, wnz);
        kinds.push(HIT_WORLD);
        recorded = true;
      }
      // Wall penetration: thin cover does not stop a rifle round.
      const exit = this.world.exitDistance(wbox, sx, sy, sz, dx, dy, dz);
      const thickness = exit - wdist;
      if (def.penetration <= 0 || thickness > def.penetration) return;
      factor *= 0.8 - 0.45 * (thickness / def.penetration);
      travelled += exit + 0.01;
      sx += dx * (exit + 0.01); sy += dy * (exit + 0.01); sz += dz * (exit + 0.01);
      skip = wbox;
      wallbang = true;
    }
  }

  private knife(p: Player, def: WeaponDef): void {
    p.nextFireAt = this.time + 60 / def.rpm;
    const ox = p.pos.x, oy = this.eyeY(p), oz = p.pos.z;
    forwardFromAngles(p.yaw, p.pitch, fwd);
    this.world.raycast(ox, oy, oz, fwd.x, fwd.y, fwd.z, def.range, ray);
    let best: Player | null = null;
    let bt = ray.dist;
    for (const v of this.players) {
      if (!v.alive || v.team === p.team) continue;
      // Generous: test a fat cylinder so melee does not need pixel aim.
      const t = rayCylinder(ox, oy, oz, fwd.x, fwd.y, fwd.z, v.pos.x, v.pos.z, v.pos.y, v.pos.y + 1.85, 0.5);
      if (t >= 0 && t < bt) { best = v; bt = t; }
    }
    this.events.push({ type: 'knife', player: p.id, hit: best !== null });
    if (best) {
      // Backstab: victim is facing roughly the same way as the attacker.
      const back = Math.cos(best.yaw - p.yaw) > 0.5;
      const hx = ox + fwd.x * bt, hy = oy + fwd.y * bt, hz = oz + fwd.z * bt;
      this.damage(best, p, def, back ? 180 : def.damage, CHEST, 0, hx, hy, hz, false);
    }
  }

  private damage(
    v: Player, attacker: Player | null, def: WeaponDef | null, base: number, group: number,
    dist: number, x: number, y: number, z: number, wallbang: boolean,
  ): void {
    if (this.predicting) return;
    let dmg = base;
    let armorPen = 0.5;
    if (def) {
      dmg *= Math.pow(def.rangeMod, dist / 10);
      armorPen = def.armorPen;
      if (group === HEAD) dmg *= def.headMult;
      else if (group === STOMACH) dmg *= 1.25;
      else if (group === LEGS) dmg *= 0.75;
    }
    const armored = group === HEAD ? v.helmet : group !== LEGS && v.armor > 0;
    if (armored) {
      const through = dmg * armorPen;
      v.armor = Math.max(0, v.armor - (dmg - through) * 0.5);
      dmg = through;
    }
    const dealt = Math.max(1, Math.round(dmg));
    v.hp -= dealt;
    // "Tagging": getting hit slows you down.
    v.vel.x *= 0.6;
    v.vel.z *= 0.6;
    this.events.push({ type: 'hit', victim: v.id, attacker: attacker ? attacker.id : -1, damage: dealt, head: group === HEAD, x, y, z });
    if (v.hp <= 0) this.kill(v, attacker, def, group === HEAD, wallbang);
  }

  private kill(v: Player, killer: Player | null, def: WeaponDef | null, head: boolean, wallbang: boolean): void {
    v.hp = 0;
    v.alive = false;
    v.deaths++;
    v.scope = 0;
    v.useTime = 0;
    endGrapple(v, this.time, this.events);
    if (killer && killer !== v) {
      killer.kills++;
      if (def) this.addMoney(killer, def.killReward);
    }
    if (v.hasCharge) {
      v.hasCharge = false;
      this.charge.state = 'dropped';
      this.charge.carrier = -1;
      this.charge.pos.x = v.pos.x;
      this.charge.pos.z = v.pos.z;
      this.charge.pos.y = this.floorBelow(v.pos.x, v.pos.y, v.pos.z);
      this.events.push({ type: 'chargeDrop', x: this.charge.pos.x, y: this.charge.pos.y, z: this.charge.pos.z });
    }
    this.events.push({ type: 'kill', victim: v.id, killer: killer ? killer.id : -1, weapon: def ? def.id : 'world', head, wallbang });
  }

  private floorBelow(x: number, y: number, z: number): number {
    return this.world.raycast(x, y + 0.5, z, 0, -1, 0, 40, ray) ? y + 0.5 - ray.dist : y;
  }

  // ---- objective -------------------------------------------------------------------

  siteAt(x: number, z: number): number {
    if (inZone(this.map.sites[0].zone, x, z)) return 0;
    if (inZone(this.map.sites[1].zone, x, z)) return 1;
    return -1;
  }

  canPlant(p: Player): boolean {
    return this.phase === 'live' && p.alive && p.hasCharge && p.onGround && this.siteAt(p.pos.x, p.pos.z) >= 0;
  }

  canDisarm(p: Player): boolean {
    if (this.phase !== 'planted' || !p.alive || p.team !== DEF || this.charge.state !== 'planted') return false;
    const c = this.charge.pos;
    return Math.hypot(p.pos.x - c.x, p.pos.z - c.z) < 1.5 && Math.abs(p.pos.y - c.y) < 1.5;
  }

  disarmDuration(p: Player): number {
    return p.kit ? this.rules.disarmTimeKit : this.rules.disarmTime;
  }

  private updateUse(p: Player, cmd: Cmd): void {
    const holding = (cmd.buttons & BTN_USE) !== 0;
    if (this.predicting) {
      // Show progress immediately; the server decides when it completes.
      if (holding && this.canPlant(p)) p.useTime = Math.min(this.rules.plantTime, p.useTime + TICK);
      else if (holding && this.canDisarm(p)) p.useTime = Math.min(this.disarmDuration(p), p.useTime + TICK);
      else p.useTime = 0;
      return;
    }
    if (holding && this.canPlant(p)) {
      p.useTime += TICK;
      if (p.useTime >= this.rules.plantTime) {
        p.useTime = 0;
        p.hasCharge = false;
        const c = this.charge;
        c.state = 'planted';
        c.carrier = -1;
        c.pos.x = p.pos.x; c.pos.y = p.pos.y; c.pos.z = p.pos.z;
        c.timer = this.rules.chargeTime;
        c.site = this.siteAt(p.pos.x, p.pos.z);
        this.planted = true;
        this.phase = 'planted';
        this.phaseTime = this.rules.chargeTime;
        this.addMoney(p, 300);
        this.intel[DEF].site = c.site;
        this.intel[DEF].time = this.time;
        this.events.push({ type: 'planted', player: p.id, site: c.site, x: c.pos.x, y: c.pos.y, z: c.pos.z });
      }
    } else if (holding && this.canDisarm(p)) {
      p.useTime += TICK;
      if (p.useTime >= this.disarmDuration(p)) {
        p.useTime = 0;
        this.charge.state = 'disarmed';
        this.addMoney(p, 300);
        this.events.push({ type: 'disarmed', player: p.id });
        this.endRound(DEF, 'disarm');
      }
    } else {
      p.useTime = 0;
    }
  }

  private updateCharge(): void {
    const c = this.charge;
    if (c.state === 'carried') {
      const carrier = this.players[c.carrier];
      if (carrier) { c.pos.x = carrier.pos.x; c.pos.y = carrier.pos.y; c.pos.z = carrier.pos.z; }
    } else if (c.state === 'dropped') {
      for (const p of this.players) {
        if (!p.alive || p.team !== ATK) continue;
        if (Math.hypot(p.pos.x - c.pos.x, p.pos.z - c.pos.z) < 1.1 && Math.abs(p.pos.y - c.pos.y) < 1.6) {
          p.hasCharge = true;
          c.state = 'carried';
          c.carrier = p.id;
          this.events.push({ type: 'chargePickup', player: p.id });
          break;
        }
      }
    } else if (c.state === 'planted' && this.phase === 'planted') {
      c.timer -= TICK;
      if (c.timer <= 0) {
        c.state = 'detonated';
        this.events.push({ type: 'detonated', x: c.pos.x, y: c.pos.y, z: c.pos.z });
        for (const p of this.players) {
          if (!p.alive) continue;
          const d = Math.hypot(p.pos.x - c.pos.x, p.pos.y - c.pos.y, p.pos.z - c.pos.z);
          if (d < this.rules.blastRadius) {
            const dmg = this.rules.blastDamage * (1 - d / this.rules.blastRadius) ** 2;
            if (dmg >= 1) this.damage(p, null, null, dmg, CHEST, 0, p.pos.x, p.pos.y + 1, p.pos.z, false);
          }
        }
        this.endRound(ATK, 'detonation');
      }
    }
  }

  private checkWin(): void {
    const atk = this.aliveCount(ATK), def = this.aliveCount(DEF);
    if (this.phase === 'live') {
      if (atk === 0) this.endRound(DEF, 'elimination');
      else if (def === 0) this.endRound(ATK, 'elimination');
      else if (this.phaseTime <= 0) this.endRound(DEF, 'time');
    } else if (this.phase === 'planted') {
      if (def === 0) this.endRound(ATK, 'elimination');
    }
  }

  // ---- tick ------------------------------------------------------------------------

  /** Keep players from standing inside each other. */
  private separate(): void {
    const ps = this.players;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i]!;
      if (!a.alive) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j]!;
        if (!b.alive) continue;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        const min = HULL_HALF * 2;
        if (d2 >= min * min || Math.abs(a.pos.y - b.pos.y) > 1.7) continue;
        const d = Math.sqrt(d2);
        const push = (min - d) * 0.25;
        const nx = d > 1e-4 ? dx / d : 1, nz = d > 1e-4 ? dz / d : 0;
        this.nudge(a, -nx * push, -nz * push);
        this.nudge(b, nx * push, nz * push);
      }
    }
  }

  private nudge(p: Player, dx: number, dz: number): void {
    const hy = hullHeight(p) / 2;
    const cy = p.pos.y + hy;
    this.world.traceHull(p.pos.x, cy, p.pos.z, p.pos.x + dx, cy, p.pos.z + dz, HULL_HALF, hy, HULL_HALF, tr);
    if (tr.startSolid) return;
    p.pos.x += dx * tr.fraction;
    p.pos.z += dz * tr.fraction;
  }

  /**
   * Advance the simulation one tick. `humanCmd` supplies the command for a human player;
   * bots generate their own.
   */
  tick(humanCmd?: (p: Player) => Cmd | null): void {
    if (this.phase === 'over') return;
    this.time += TICK;
    this.tickCount++;

    // Phase timers.
    this.phaseTime -= TICK;
    if (this.phase === 'freeze' && this.phaseTime <= 0) {
      this.phase = 'live';
      this.phaseTime = this.rules.roundTime;
      this.liveTime = 0;
      this.events.push({ type: 'roundLive' });
    } else if (this.phase === 'end' && this.phaseTime <= 0) {
      this.afterRound();
      if ((this.phase as Phase) === 'over') return;
    }
    if (this.phase === 'live' || this.phase === 'planted') this.liveTime += TICK;
    for (const p of this.players) {
      const cmd = this.cmds[p.id]!;
      if (p.isBot) {
        this.bots.get(p.id)!.think(cmd);
      } else {
        const c = humanCmd ? humanCmd(p) : null;
        if (c) Object.assign(cmd, c);
        else { cmd.fwd = cmd.side = 0; cmd.buttons = 0; cmd.slot = -1; cmd.buy = ''; cmd.seq = 0; cmd.lag = 0; }
      }
      this.stepPlayer(p, cmd);
    }

    this.separate();
    this.updateCharge();
    this.checkWin();

    // Record where everyone ended the tick, for lag compensation.
    const slot = this.tickCount % HISTORY;
    for (const p of this.players) {
      const h = this.history[p.id]!;
      h[slot * 4] = p.pos.x; h[slot * 4 + 1] = p.pos.y; h[slot * 4 + 2] = p.pos.z; h[slot * 4 + 3] = p.crouchT;
    }
  }

  /**
   * Apply one input command to one player. The server calls this from `tick`; a client
   * calls it directly (with `predicting` set) to predict its own player ahead of the server.
   */
  stepPlayer(p: Player, cmd: Cmd): void {
    p.prevPos.x = p.pos.x; p.prevPos.y = p.pos.y; p.prevPos.z = p.pos.z;
    p.prevCrouchT = p.crouchT;
    if (!p.alive) return;
    const frozenPhase = this.phase === 'freeze';

    p.yaw = cmd.yaw;
    p.pitch = cmd.pitch;
    if (cmd.buy && !this.predicting) {
      const ok = this.tryBuy(p, cmd.buy);
      this.events.push({ type: 'buy', player: p.id, item: cmd.buy, ok });
    }

    const busy = p.useTime > 0;
    const land = movePlayer(p, cmd, this.world, TICK, this.moveSpeed(p), frozenPhase || busy, this.time, this.events, this.rules.verticalKit);
    if (!this.predicting) {
      if (land > 14.7) {
        this.damage(p, null, null, (land - 14.7) * 9, LEGS, 0, p.pos.x, p.pos.y, p.pos.z, false);
        if (!p.alive) return;
      }
      // Kill plane, in case anything ever escapes the map.
      if (p.pos.y < -20) { this.kill(p, null, null, false, false); return; }
    }

    this.updateUse(p, cmd);
    this.updateWeapon(p, cmd, !frozenPhase && p.useTime <= 0 && p.mantleT < 0);
    p.prevButtons = cmd.buttons;
  }

  /** Start a brand new match with the same players. */
  restart(): void {
    for (const p of this.players) {
      p.money = this.rules.startMoney;
      p.kills = p.deaths = 0;
      p.alive = false;
    }
    this.score = [0, 0];
    this.lossStreak = [0, 0];
    this.round = 0;
    this.matchWinner = -1;
    this.startRound(true);
  }
}

export { GRAVITY };
