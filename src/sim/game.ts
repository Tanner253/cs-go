// The authoritative simulation: fixed 64 Hz tick, driven only by per-player input commands.
// Nothing in here touches the DOM or the renderer, so the same class can run on a server.

import { Rng, forwardFromAngles, v3, type Vec3 } from './math';
import { World, newRayHit, newTrace } from './world';
import { buildMap, inZone, type MapDef } from './map';
import { Nav } from './nav';
import { DUCK_FULL, GRAVITY, JUMP_SPEED, TAG_HEAVY, TAG_LIGHT, endGrapple, eyeHeight, hullHeight, movePlayer } from './movement';
import {
  DEFAULT_PISTOL, GEAR, NADES, NADE_CARRY, NADE_INDEX, SUPPRESSED_RANGE, SUPPRESSED_RECOIL, SUPPRESSOR_TIME, WEAPONS, patternAt,
  type WeaponDef,
} from './weapons';
import {
  FIRE_FUSE, FIRE_GROW, FIRE_LIFE, FIRE_R, FUSE, NADE_LEAVE, PIN_TIME, SMOKE_LIFE, SMOKE_RH, THROW_TIME, flyNade, inSmoke, throwFrom,
} from './grenades';
import { Bot, assignRoles } from './bot';
import { DROP_R, MAX_DROPS, REACH, TOSS_SPEED, TOUCH_R, flyDrop, type Drop } from './drops';
import {
  ATK, BTN_ALT, BTN_DROP, BTN_FIRE, BTN_RELOAD, BTN_USE, DEF, HIT_NONE, HIT_PLAYER, HIT_WORLD, HULL_HALF, SLOT_LAST, SLOT_NADE, TICK,
  emptyCmd,
  type Charge, type Cmd, type Grenade, type Phase, type Player, type SimEvent, type Team, type WeaponState, type WinReason,
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
  /** Bullets passing through thin cover. Off: any wall stops any bullet. */
  wallbang: false,
  /** A match level at full time goes to overtime periods this many rounds long (0: it is drawn), each half begun with this much money. */
  overtimeRounds: 6,
  overtimeMoney: 10000,
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

/** Every way a round can end, in the order the round log numbers them. */
export const WIN_REASONS: WinReason[] = ['elimination', 'time', 'detonation', 'disarm'];

const BOT_NAMES = ['Vex', 'Ion', 'Nyx', 'Rook', 'Quill', 'Tarn', 'Juno', 'Kade', 'Lyra', 'Moss', 'Orin', 'Pax'];

const HEAD = 0, CHEST = 1, STOMACH = 2, LEGS = 3;

const ray = newRayHit();
const tr = newTrace();
const fwd = v3();
const punch = { pitch: 0, yaw: 0 };
/** How fast the aim comes back after a spray (per second, exponential): most of the way in a third of a second. */
const RECOIL_RETURN = 9;
const pHit = { t: 0, group: 0 };
/** How far a knife stab reaches from the eye (a slash reaches the knife's own range). */
const KNIFE_STAB_RANGE = 1.3;

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
  /** Grenades thrown this round that are still flying, lying, smoking or burning. */
  grenades: Grenade[] = [];
  private nadeId = 0;
  /** Thrown, but not yet out of the hand (server only): player id to the kind thrown. */
  private leaving = new Map<number, number>();
  /** Weapons lying on the floor (or falling to it) this round. */
  drops: Drop[] = [];
  private dropId = 0;
  /** When each player last slashed (server only): slashes in a row hit for less. */
  private slashAt = new Map<number, number>();
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
  /** Overtime period being played (0 = full time not yet reached). */
  overtime = 0;
  /** How each round went, in order: the winning side * 4 + the reason's index (see WIN_REASONS). */
  roundLog: number[] = [];
  /** This round (server only): damage each player has dealt each other (attacker * n + victim), kills, and who flashed whom until when. */
  private hurt = new Float32Array(0);
  private roundKills: number[] = [];
  private roundDamage: number[] = [];
  private flashedBy = new Map<number, { by: number; until: number }>();
  /** Who planted, and who disarmed, the charge this round. */
  private planter = -1;
  private disarmer = -1;
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
  /**
   * Set on a server: weapon spread is then seeded from this secret and the server tick, so a
   * client cannot choose (or predict) which way its bullets will stray.
   */
  spreadSecret = 0;
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
      kills: 0, deaths: 0, assists: 0, mvps: 0, points: 0, damage: 0, hasCharge: false,
      pos: v3(), prevPos: v3(), vel: v3(), yaw: 0, pitch: 0,
      onGround: true, ducked: false, crouchT: 0, prevCrouchT: 0, stepDist: 0, fallSpeed: 0, stamina: 0, tag: 1, duckSpeed: DUCK_FULL,
      wallJumps: 0, lastWallNx: 0, lastWallNz: 0,
      mantleT: -1, mantleFrom: v3(), mantleTo: v3(),
      grappleOn: false, grapplePoint: v3(), grappleTime: 0, grappleReadyAt: 0,
      weapons: [null, null, null, null], active: 1, lastActive: 2,
      nades: NADES.map(() => 0), nadeSel: 0, pinAt: -1, throwStr: 1, throwAt: -1, flashEnd: 0, flashLen: 0,
      drawTimer: 0, reloadTimer: 0, fitTimer: 0, nextFireAt: 0, lastShotAt: -99, recoilIdx: 0,
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
    return { def, mag: def.magSize, reserve: def.reserve, quiet: !!def.suppressor?.fitted };
  }

  private resetLoadout(p: Player): void {
    p.weapons = [null, this.makeWeapon(DEFAULT_PISTOL[p.team]), this.makeWeapon('edge'), null];
    p.nades.fill(0);
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
    this.grenades.length = 0;
    this.leaving.clear();
    this.drops.length = 0;
    const n = this.players.length;
    if (this.hurt.length !== n * n) this.hurt = new Float32Array(n * n);
    this.hurt.fill(0);
    this.roundKills = this.players.map(() => 0);
    this.roundDamage = this.players.map(() => 0);
    this.flashedBy.clear();
    this.planter = this.disarmer = -1;

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
      p.stamina = 0;
      p.tag = 1;
      p.duckSpeed = DUCK_FULL;
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
      p.fitTimer = 0;
      p.recoilIdx = 0;
      p.punchPitch = p.punchYaw = 0;
      p.fireSpread = 0;
      p.nextFireAt = 0;
      p.pinAt = -1;
      p.throwAt = -1;
      p.flashEnd = 0;
      if (p.active === 3) p.active = p.weapons[0] ? 0 : 1;
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

    // The round's most valuable player: whoever planted a charge that went off, or disarmed it;
    // otherwise the winner with the most kills this round (then the most damage).
    let mvp = -1;
    let mvpFor: 'kills' | 'plant' | 'disarm' | '' = '';
    if (reason === 'detonation' && this.planter >= 0) { mvp = this.planter; mvpFor = 'plant'; }
    else if (reason === 'disarm' && this.disarmer >= 0) { mvp = this.disarmer; mvpFor = 'disarm'; }
    else {
      let best = 0, bestDmg = 0;
      for (const p of this.players) {
        if (p.team !== winner) continue;
        const k = this.roundKills[p.id] ?? 0, d = this.roundDamage[p.id] ?? 0;
        if (k > best || (k === best && k > 0 && d > bestDmg)) { best = k; bestDmg = d; mvp = p.id; }
      }
      if (mvp >= 0) mvpFor = 'kills';
    }
    if (mvp >= 0) this.players[mvp]!.mvps++;
    this.roundLog.push(winner * 4 + WIN_REASONS.indexOf(reason));
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
    this.events.push({ type: 'roundEnd', winner, reason, mvp, mvpFor });
  }

  /** Score that wins the period being played: the match itself, or the overtime under way. */
  get winScore(): number {
    if (this.overtime === 0) return this.rules.roundsToWin;
    return this.rules.maxRounds / 2 + (this.overtime * this.rules.overtimeRounds) / 2 + 1;
  }

  /** The round on which the period being played ends. */
  get lastRound(): number {
    return this.rules.maxRounds + this.overtime * this.rules.overtimeRounds;
  }

  private afterRound(): void {
    const { maxRounds, overtimeRounds } = this.rules;
    const need = this.winScore;
    if (this.score[0] >= need || this.score[1] >= need || this.round >= this.lastRound) {
      if (this.score[0] === this.score[1] && overtimeRounds > 0) {
        // Level at full time (or at the end of an overtime): another overtime, on the same sides,
        // everyone starting it with the overtime money.
        this.overtime++;
        for (const p of this.players) { p.money = this.rules.overtimeMoney; p.alive = false; }
        this.lossStreak = [0, 0];
        this.events.push({ type: 'overtime', period: this.overtime });
        this.startRound(true);
        return;
      }
      this.phase = 'over';
      this.matchWinner = this.score[0] === this.score[1] ? -1 : this.score[0] > this.score[1] ? 0 : 1;
      this.events.push({ type: 'matchEnd', winner: this.matchWinner });
      return;
    }
    const half = this.overtime === 0 ? maxRounds / 2 : maxRounds + (this.overtime - 1) * overtimeRounds + overtimeRounds / 2;
    if (this.round === half) {
      // Half time: swap sides, reset the economy.
      for (const p of this.players) {
        p.team = (1 - p.team) as Team;
        p.money = this.overtime === 0 ? this.rules.startMoney : this.rules.overtimeMoney;
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
    if (def?.nade) {
      if (def.team !== -1 && def.team !== p.team) return false;
      const i = NADE_INDEX.get(def.id)!;
      const carried = p.nades.reduce((a, b) => a + b, 0);
      if (p.money < def.price || carried >= NADE_CARRY || p.nades[i]! >= def.nade.max) return false;
      p.money -= def.price;
      p.nades[i]!++;
      if (!p.weapons[3]) p.nadeSel = i;
      this.syncNade(p);
      return true;
    }
    if (def) {
      if (def.kind === 'knife' || (def.team !== -1 && def.team !== p.team)) return false;
      if (p.money < def.price || p.weapons[def.slot]?.def.id === def.id) return false;
      p.money -= def.price;
      // (the gun it replaces is let fall at the buyer's feet, as in Counter-Strike: a teammate may want it)
      const old = p.weapons[def.slot];
      if (old) this.spawnDrop(p, old, 'feet');
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

  /** Slot 3 shows the grenade picked out (or the next kind carried, once that one is gone). */
  private syncNade(p: Player): void {
    const n = NADES.length;
    let i = p.nadeSel;
    for (let k = 0; k < n && !(p.nades[i]! > 0); k++) i = (i + 1) % n;
    if (!(p.nades[i]! > 0)) {
      p.weapons[3] = null;
      return;
    }
    p.nadeSel = i;
    const w = p.weapons[3];
    if (w && w.def === NADES[i]) w.mag = p.nades[i]!;
    else p.weapons[3] = { def: NADES[i]!, mag: p.nades[i]!, reserve: 0, quiet: false };
  }

  /** Take out grenade kind `i` (if carried). */
  private pickNade(p: Player, i: number): void {
    if (!(p.nades[i]! > 0) || (p.active === 3 && p.nadeSel === i && p.throwAt < 0)) return;
    p.nadeSel = i;
    this.syncNade(p);
    if (p.active === 3) {
      // Changing kind with a grenade already out: put it away and bring the other up.
      p.pinAt = -1;
      p.throwAt = -1;
      p.drawTimer = NADES[i]!.drawTime;
      this.events.push({ type: 'draw', player: p.id, weapon: NADES[i]!.id });
    } else {
      this.switchTo(p, 3);
    }
  }

  /** @param again bring the slot's weapon up even if that slot is already in hand (a new gun put in it) */
  private switchTo(p: Player, slot: number, again = false): void {
    if (again && slot === p.active && p.weapons[slot]) {
      const last = p.lastActive;
      p.active = -1;
      this.switchTo(p, slot);
      p.lastActive = last;
      return;
    }
    if (slot === 3 && p.active === 3) {
      // The grenade key again: on to the next kind carried.
      for (let k = 1; k < NADES.length; k++) {
        const i = (p.nadeSel + k) % NADES.length;
        if (p.nades[i]! > 0) { this.pickNade(p, i); return; }
      }
      return;
    }
    if (slot === p.active || !p.weapons[slot]) return;
    p.lastActive = p.active;
    p.active = slot;
    const def = p.weapons[slot]!.def;
    p.drawTimer = def.drawTime;
    p.reloadTimer = 0;
    p.fitTimer = 0;
    p.scope = 0;
    p.rescope = 0;
    p.fireBuffer = 0;
    p.recoilIdx = 0;
    p.punchPitch = p.punchYaw = 0;
    p.fireSpread = 0;
    // A grenade with its pin out goes back on the belt, pin and all.
    p.pinAt = -1;
    p.throwAt = -1;
    this.events.push({ type: 'draw', player: p.id, weapon: def.id });
  }

  /** The gun to go back to once the last grenade of a kind has been thrown. */
  private afterNade(p: Player): number {
    if (p.lastActive !== 3 && p.weapons[p.lastActive]) return p.lastActive;
    return p.weapons[0] ? 0 : p.weapons[1] ? 1 : 2;
  }

  /** Current total inaccuracy (radians) — also drives the crosshair. */
  spreadOf(p: Player): number {
    const w = p.weapons[p.active];
    if (!w) return 0;
    const def = w.def;
    if (def.kind === 'knife' || def.kind === 'grenade') return 0;
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
    if (cmd.slot >= SLOT_NADE) this.pickNade(p, cmd.slot - SLOT_NADE);
    else if (cmd.slot >= 0 && cmd.slot <= 3) this.switchTo(p, cmd.slot);
    else if (cmd.slot === SLOT_LAST) this.switchTo(p, p.weapons[p.lastActive] ? p.lastActive : 2);

    const w = p.weapons[p.active];
    if (!w) {
      this.switchTo(p, this.afterNade(p));
      return;
    }
    const def = w.def;
    const pressed = cmd.buttons & ~p.prevButtons;

    // Recoil and spread recovery. While a spray is held the aim sits exactly where the pattern
    // put it; once the trigger is let go it comes straight back to where the player is
    // looking (it does not walk back along the pattern), and the place in the pattern is
    // forgotten a little more slowly.
    if (now - p.lastShotAt > 60 / def.rpm + 0.05) {
      if (p.recoilIdx > 0) p.recoilIdx = Math.max(0, p.recoilIdx - (2.5 + p.recoilIdx * 4.5) * TICK);
      const keep = Math.exp(-RECOIL_RETURN * TICK);
      p.punchPitch *= keep;
      p.punchYaw *= keep;
      if (Math.abs(p.punchPitch) < 2e-4 && Math.abs(p.punchYaw) < 2e-4) p.punchPitch = p.punchYaw = 0;
    }
    p.fireSpread *= Math.exp(-def.spreadDecay * TICK);

    if (p.drawTimer > 0) {
      p.drawTimer -= TICK;
      return;
    }
    if (def.kind === 'grenade') {
      this.updateNade(p, w, cmd, pressed, canAct);
      return;
    }
    if (p.reloadTimer > 0) {
      p.reloadTimer -= TICK;
      if (p.reloadTimer > 0) return;
      const need = Math.min(def.magSize - w.mag, w.reserve);
      w.mag += need;
      w.reserve -= need;
    }
    // Fitting or taking off the suppressor: the hands are busy until it is done.
    if (p.fitTimer > 0) {
      p.fitTimer -= TICK;
      if (p.fitTimer > 0) return;
      p.fitTimer = 0;
      w.quiet = !w.quiet;
    }
    if (!canAct) return;

    if (def.suppressor && pressed & BTN_ALT && now >= p.nextFireAt) {
      p.fitTimer = SUPPRESSOR_TIME;
      this.events.push({ type: 'fit', player: p.id, weapon: def.id, on: !w.quiet });
      return;
    }
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

    // The knife: a slash (fire), or a stab (alt), slower and heavier, that reaches less far.
    if (def.kind === 'knife') {
      const slash = (cmd.buttons & BTN_FIRE) !== 0, stab = (cmd.buttons & BTN_ALT) !== 0;
      if ((!slash && !stab) || now < p.nextFireAt) return;
      this.rewind(p, cmd.lag);
      this.knife(p, def, stab && !slash);
      this.restore(p, cmd.lag);
      return;
    }
    if (!def.auto && pressed & BTN_FIRE) p.fireBuffer = now + 0.12;
    const wantFire = def.auto ? cmd.buttons & BTN_FIRE : pressed & BTN_FIRE || now < p.fireBuffer;
    if (!wantFire || now < p.nextFireAt) return;
    p.fireBuffer = 0;
    if (w.mag <= 0) {
      if (pressed & BTN_FIRE) this.events.push({ type: 'dry', player: p.id });
      if (w.reserve > 0) this.startReload(p, w);
      else p.nextFireAt = now + 0.2;
    } else {
      this.rewind(p, cmd.lag);
      this.shoot(p, w, cmd.seq);
      this.restore(p, cmd.lag);
    }
  }

  // ---- grenades ----------------------------------------------------------------------

  /**
   * A grenade in hand. Pressing either button pulls the pin; letting go throws it, overarm
   * (fire), as an underarm lob (alt) or in between (both). Once a throw is asked for, it goes
   * as soon as the pin is out.
   */
  private updateNade(p: Player, w: WeaponState, cmd: Cmd, pressed: number, canAct: boolean): void {
    const now = this.time;
    if (p.throwAt >= 0) {
      this.launchNade(p);
      if (now < p.throwAt + THROW_TIME) return;
      p.throwAt = -1;
      const same = p.nades[p.nadeSel]! > 0;
      this.syncNade(p);
      if (same) {
        p.drawTimer = w.def.drawTime;
        this.events.push({ type: 'draw', player: p.id, weapon: w.def.id });
      } else {
        this.switchTo(p, this.afterNade(p));
      }
      return;
    }
    if (!canAct) return;
    const held = cmd.buttons & (BTN_FIRE | BTN_ALT);
    const strength = (b: number): number => ((b & BTN_FIRE) && (b & BTN_ALT) ? 0.5 : b & BTN_FIRE ? 1 : 0);
    if (p.pinAt < 0) {
      if (pressed & (BTN_FIRE | BTN_ALT)) {
        p.pinAt = now;
        p.throwStr = strength(held);
        this.events.push({ type: 'pin', player: p.id, weapon: w.def.id });
      }
      return;
    }
    if (held) {
      // Both buttons, once held together, stay a middle throw however they are let go.
      if (p.throwStr !== 0.5) p.throwStr = strength(held);
      return;
    }
    if (now < p.pinAt + PIN_TIME) return;
    this.throwNade(p, w);
  }

  private throwNade(p: Player, w: WeaponState): void {
    const i = NADE_INDEX.get(w.def.id)!;
    p.nades[i] = Math.max(0, p.nades[i]! - 1);
    w.mag = p.nades[i]!;
    p.pinAt = -1;
    p.throwAt = this.time;
    this.events.push({ type: 'throw', player: p.id, weapon: w.def.id, strength: p.throwStr });
    if (this.predicting) return;
    this.leaving.set(p.id, i);
  }

  /** The grenade leaves the hand NADE_LEAVE after the throw begins, as the arm comes over (and as the hand is drawn letting go). */
  private launchNade(p: Player): void {
    const i = this.leaving.get(p.id);
    if (i === undefined || this.time < p.throwAt + NADE_LEAVE) return;
    this.leaving.delete(p.id);
    const g = this.spawnNade(p, i);
    throwFrom(p, this.eyeY(p), p.throwStr, this.world, g.pos, g.vel);
  }

  private spawnNade(p: Player, kind: number): Grenade {
    const g: Grenade = {
      id: ++this.nadeId, kind, owner: p.id, team: p.team, pos: v3(), vel: v3(),
      born: this.time, state: 0, popAt: 0, endAt: 0,
    };
    this.grenades.push(g);
    return g;
  }

  // ---- weapons on the floor ----------------------------------------------------------

  /**
   * Put a weapon on the floor from a player: thrown out along the aim (G, or one swapped for
   * another), let fall from the hands (the dead), or set down at the feet (one replaced by buying).
   */
  private spawnDrop(p: Player, w: WeaponState, how: 'toss' | 'fall' | 'feet'): Drop {
    const rng = this.rng;
    const d: Drop = {
      id: ++this.dropId, weapon: w, pos: v3(), vel: v3(), yaw: p.yaw + Math.PI / 2 + (rng.next() - 0.5) * 0.8,
      spin: (rng.next() - 0.5) * 6, state: 0, owner: p.id, ownerUntil: this.time + 1,
    };
    if (how === 'toss') {
      // Out of the hands ahead of the chest, a little up from the aim; never through a wall in the face.
      forwardFromAngles(p.yaw, Math.max(-1, Math.min(0.9, p.pitch)) + 0.2, fwd);
      const sy = this.eyeY(p) - 0.3;
      this.world.traceHull(p.pos.x, sy, p.pos.z, p.pos.x + fwd.x * 0.6, sy + fwd.y * 0.6, p.pos.z + fwd.z * 0.6, DROP_R, 0.03, DROP_R, tr);
      const f = tr.startSolid ? 0 : Math.max(0, tr.fraction - 0.1);
      d.pos.x = p.pos.x + fwd.x * 0.6 * f; d.pos.y = sy + fwd.y * 0.6 * f; d.pos.z = p.pos.z + fwd.z * 0.6 * f;
      d.vel.x = fwd.x * TOSS_SPEED + p.vel.x; d.vel.y = fwd.y * TOSS_SPEED + p.vel.y * 0.5; d.vel.z = fwd.z * TOSS_SPEED + p.vel.z;
    } else {
      const a = rng.next() * Math.PI * 2, s = how === 'fall' ? 0.8 : 0.5;
      d.pos.x = p.pos.x; d.pos.y = p.pos.y + (how === 'fall' ? 1.1 : 0.6); d.pos.z = p.pos.z;
      d.vel.x = p.vel.x * 0.6 + Math.cos(a) * s; d.vel.y = how === 'fall' ? 1 : 0.5; d.vel.z = p.vel.z * 0.6 + Math.sin(a) * s;
    }
    this.drops.push(d);
    if (this.drops.length > MAX_DROPS) this.drops.shift();
    this.events.push({ type: 'drop', player: p.id, weapon: w.def.id });
    return d;
  }

  /** G: the weapon in hand goes to the floor (never the knife), and the next best comes up. */
  private dropHeld(p: Player): void {
    const slot = p.active, w = p.weapons[slot];
    if (!w || slot === 2 || this.predicting) return;
    if (slot === 3) {
      // One grenade of the kind in hand, with its pin in.
      const i = NADE_INDEX.get(w.def.id)!;
      if (p.pinAt >= 0 || p.throwAt >= 0 || !(p.nades[i]! > 0)) return;
      p.nades[i]!--;
      this.spawnDrop(p, { def: w.def, mag: 1, reserve: 0, quiet: false }, 'toss');
      this.syncNade(p);
      if (p.weapons[3]) this.switchTo(p, 3, true);
      else this.switchTo(p, this.afterNade(p));
      return;
    }
    p.weapons[slot] = null;
    this.spawnDrop(p, w, 'toss');
    this.switchTo(p, slot === 0 ? (p.weapons[1] ? 1 : 2) : p.weapons[0] ? 0 : 2);
    if (!p.weapons[p.lastActive]) p.lastActive = 2;
  }

  /** Close enough to walk over: under the body, not on a floor far above or below it. */
  private onDrop(p: Player, d: Drop): boolean {
    return Math.hypot(d.pos.x - p.pos.x, d.pos.z - p.pos.z) < TOUCH_R && d.pos.y > p.pos.y - 0.45 && d.pos.y < p.pos.y + 1.2;
  }

  /** Whether this weapon could be taken at all (a grenade needs room on the belt). */
  private hasRoom(p: Player, w: WeaponState): boolean {
    if (w.def.kind !== 'grenade') return true;
    const i = NADE_INDEX.get(w.def.id)!;
    return p.nades.reduce((a, b) => a + b, 0) < NADE_CARRY && p.nades[i]! < w.def.nade!.max;
  }

  /**
   * The weapon on the floor that E would take: the one nearest the crosshair within reach (and
   * in plain sight), or failing that one being stood on.
   */
  dropInReach(p: Player): Drop | null {
    if (!p.alive || this.drops.length === 0) return null;
    const ex = p.pos.x, ey = this.eyeY(p), ez = p.pos.z;
    forwardFromAngles(p.yaw, p.pitch, fwd);
    let best: Drop | null = null, bestScore = Infinity;
    for (const d of this.drops) {
      if (!this.hasRoom(p, d.weapon)) continue;
      const dx = d.pos.x - ex, dy = d.pos.y - ey, dz = d.pos.z - ez;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > REACH + 0.6) continue;
      const off = Math.acos(Math.max(-1, Math.min(1, (dx * fwd.x + dy * fwd.y + dz * fwd.z) / Math.max(dist, 1e-3))));
      // (a gun is a third of a metre long: the closer it is, the wider the angle it fills)
      const aimed = dist <= REACH && off < Math.atan2(0.3, dist) + 0.06
        && this.world.lineOfSight(ex, ey, ez, d.pos.x, d.pos.y + 0.05, d.pos.z);
      const score = aimed ? off : this.onDrop(p, d) ? 10 + dist : Infinity;
      if (score < bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  /**
   * Take a weapon off the floor. Walking over one (`swap` false) only fills an empty slot;
   * E (`swap` true) also trades the gun in that slot for it, which is thrown down in its place.
   */
  private takeDrop(p: Player, d: Drop, swap: boolean): boolean {
    const w = d.weapon, def = w.def;
    if (!this.hasRoom(p, w)) return false;
    if (def.kind === 'grenade') {
      const i = NADE_INDEX.get(def.id)!;
      p.nades[i]!++;
      if (!p.weapons[3]) p.nadeSel = i;
      this.syncNade(p);
    } else {
      const slot = def.slot;
      const old = p.weapons[slot];
      if (old && !swap) return false;
      this.drops.splice(this.drops.indexOf(d), 1);
      if (old) this.spawnDrop(p, old, 'toss');
      p.weapons[slot] = w;
      // Up into the hands if it was asked for, or is better than what they hold (and they are not mid-throw).
      const busy = p.active === 3 && (p.pinAt >= 0 || p.throwAt >= 0);
      if (swap || (!busy && slot < p.active)) this.switchTo(p, slot, true);
      this.events.push({ type: 'pickup', player: p.id, weapon: def.id });
      return true;
    }
    this.drops.splice(this.drops.indexOf(d), 1);
    this.events.push({ type: 'pickup', player: p.id, weapon: def.id });
    return true;
  }

  private updateDrops(): void {
    for (const d of this.drops) flyDrop(d, this.world, TICK, this.events);
    if (this.predicting) return;
    // Walking over one with that slot empty picks it up (its dropper only after a moment).
    for (let k = this.drops.length - 1; k >= 0; k--) {
      const d = this.drops[k]!;
      for (const p of this.players) {
        if (!p.alive || (p.id === d.owner && this.time < d.ownerUntil) || !this.onDrop(p, d)) continue;
        if (this.takeDrop(p, d, false)) break;
      }
    }
  }

  /** True if smoke hides b from a (enough of the line runs through one or more clouds). */
  smokeBlocks(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    let inside = 0;
    for (const g of this.grenades) {
      if (g.state !== 2 || NADES[g.kind]!.nade!.type !== 'smoke') continue;
      inside += inSmoke(g, this.time, ax, ay, az, bx, by, bz);
      if (inside > 1.1) return true;
    }
    return false;
  }

  /** A fire burning at this point (feet), if any: for bots to keep out of. */
  fireAt(x: number, y: number, z: number, margin = 0): Grenade | null {
    for (const g of this.grenades) {
      if (g.state !== 2 || NADES[g.kind]!.nade!.type !== 'fire') continue;
      const r = this.fireRadius(g) + margin;
      if (Math.hypot(x - g.pos.x, z - g.pos.z) < r && y > g.pos.y - 0.5 && y < g.pos.y + 1) return g;
    }
    return null;
  }

  /** Fire spreads out from where it lands over its first FIRE_GROW seconds. */
  fireRadius(g: Grenade): number {
    const age = this.time - g.popAt;
    return FIRE_R * Math.min(1, 0.35 + age / FIRE_GROW);
  }

  private updateGrenades(): void {
    const now = this.time;
    this.grenades = this.grenades.filter((g) => g.state !== 3);
    for (const g of this.grenades) {
      const def = NADES[g.kind]!;
      const type = def.nade!.type;
      const owner = this.players[g.owner] ?? null;
      const age = now - g.born;
      if (g.state < 2) {
        const floor = flyNade(g, this.world, this.players, now, TICK, this.events);
        if (type === 'he' || type === 'flash') {
          if (age >= FUSE) this.detonate(g, def, owner);
        } else if (type === 'smoke') {
          if ((g.state === 1 && age >= 0.5) || age >= 6) this.popSmoke(g);
        } else if (floor || age >= FIRE_FUSE) {
          this.ignite(g, age);
        }
      } else if (g.state === 2) {
        if (now >= g.endAt) g.state = 3;
        else if (type === 'fire' && this.tickCount % 16 === 0) this.burn(g, def, owner);
      }
    }
  }

  private popSmoke(g: Grenade): void {
    const now = this.time;
    g.state = 2;
    g.popAt = now;
    g.endAt = now + SMOKE_LIFE;
    g.vel.x = g.vel.y = g.vel.z = 0;
    this.events.push({ type: 'boom', id: g.id, kind: 'smoke', x: g.pos.x, y: g.pos.y, z: g.pos.z });
    // Smoke smothers any fire it covers.
    for (const f of this.grenades) {
      if (f.state !== 2 || NADES[f.kind]!.nade!.type !== 'fire') continue;
      if (Math.hypot(f.pos.x - g.pos.x, f.pos.z - g.pos.z) < SMOKE_RH + 1 && Math.abs(f.pos.y - g.pos.y) < 2.5) {
        f.state = 3;
        this.events.push({ type: 'boom', id: f.id, kind: 'out', x: f.pos.x, y: f.pos.y, z: f.pos.z });
      }
    }
  }

  private ignite(g: Grenade, age: number): void {
    const now = this.time;
    g.pos.y = this.floorBelow(g.pos.x, g.pos.y, g.pos.z);
    g.vel.x = g.vel.y = g.vel.z = 0;
    const smothered = this.grenades.some((s) => s.state === 2 && NADES[s.kind]!.nade!.type === 'smoke'
      && Math.hypot(s.pos.x - g.pos.x, s.pos.z - g.pos.z) < SMOKE_RH + 0.5 && Math.abs(s.pos.y - g.pos.y) < 2.5);
    // Burst in the air (thrown high, never finding a floor): nothing much comes down, as in Counter-Strike.
    const air = age >= FIRE_FUSE && g.state === 0;
    g.state = smothered || air ? 3 : 2;
    g.popAt = now;
    g.endAt = now + FIRE_LIFE;
    this.events.push({ type: 'boom', id: g.id, kind: g.state === 2 ? 'fire' : 'out', x: g.pos.x, y: g.pos.y, z: g.pos.z });
  }

  /** A quarter of the burn rate every quarter second to anyone standing in the flames. */
  private burn(g: Grenade, def: WeaponDef, owner: Player | null): void {
    if (this.predicting) return;
    const r = this.fireRadius(g);
    for (const v of this.players) {
      if (!v.alive || (v.team === g.team && v.id !== g.owner)) continue;
      if (Math.hypot(v.pos.x - g.pos.x, v.pos.z - g.pos.z) > r || v.pos.y < g.pos.y - 0.5 || v.pos.y > g.pos.y + 0.9) continue;
      this.damage(v, owner, def, def.damage / 4, CHEST, 0, v.pos.x, v.pos.y + 0.3, v.pos.z, false);
    }
  }

  private detonate(g: Grenade, def: WeaponDef, owner: Player | null): void {
    g.state = 3;
    const now = this.time;
    const gx = g.pos.x, gy = g.pos.y + 0.08, gz = g.pos.z;
    const type = def.nade!.type;
    this.events.push({ type: 'boom', id: g.id, kind: type === 'he' ? 'he' : 'flash', x: g.pos.x, y: g.pos.y, z: g.pos.z });
    if (this.predicting) return;
    const w = this.world;
    for (const v of this.players) {
      if (!v.alive) continue;
      if (type === 'he') {
        if (v.team === g.team && v.id !== g.owner) continue;
        const bx = v.pos.x, by = v.pos.y + 1.0, bz = v.pos.z;
        const d = Math.hypot(bx - gx, by - gy, bz - gz);
        if (d > 9) continue;
        if (!w.lineOfSight(gx, gy, gz, bx, by, bz) && !w.lineOfSight(gx, gy, gz, bx, v.pos.y + eyeHeight(v), bz)
          && !w.lineOfSight(gx, gy, gz, bx, v.pos.y + 0.3, bz)) continue;
        // Falls away fast: 98 at the centre, about 60 at 3 m, 25 at 5 m (before armour).
        const dmg = def.damage * Math.exp(-(d * d) / (2 * 3 * 3));
        if (dmg >= 1) this.damage(v, owner, def, dmg, CHEST, 0, bx, by, bz, false);
      } else {
        // Flashbang: blinds anyone who can see it, longest for those looking straight at it
        // and close by; even with it behind you, a short white-out.
        const ex = v.pos.x, ey = this.eyeY(v), ez = v.pos.z;
        const d = Math.hypot(gx - ex, gy - ey, gz - ez);
        if (d > 40 || !w.lineOfSight(gx, gy, gz, ex, ey, ez)) continue;
        if (this.smokeBlocks(gx, gy, gz, ex, ey, ez)) continue;
        forwardFromAngles(v.yaw, v.pitch, fwd);
        const dot = d > 0.01 ? ((gx - ex) * fwd.x + (gy - ey) * fwd.y + (gz - ez) * fwd.z) / d : 1;
        const facing = dot >= 0.5 ? 1 : dot <= -0.4 ? 0.22 : 0.22 + (0.78 * (dot + 0.4)) / 0.9;
        const near = d <= 7 ? 1 : Math.max(0, 1 - (d - 7) / 28);
        const seconds = 4.9 * facing * near;
        if (seconds < 0.3) continue;
        if (v.flashEnd - now < seconds) {
          v.flashEnd = now + seconds;
          v.flashLen = seconds;
        }
        this.events.push({ type: 'flashed', player: v.id, by: g.owner, seconds });
        if (owner && owner.team !== v.team) this.flashedBy.set(v.id, { by: owner.id, until: now + seconds });
      }
    }
  }

  /** Blind for this many more seconds (0 = can see). */
  blindFor(p: Player): number {
    return Math.max(0, p.flashEnd - this.time);
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

  /**
   * Where a player stood `ticks` ago (fractions are interpolated), as far back as lag
   * compensation remembers. Used by the server to judge what a shooter was looking at.
   */
  posAgo(id: number, ticks: number, out: { x: number; y: number; z: number; crouchT: number }): void {
    const h = this.history[id]!;
    const back = ticks < 0 ? 0 : ticks > HISTORY - 2 ? HISTORY - 2 : ticks;
    const whole = Math.floor(back), f = back - whole;
    const a = ((((this.tickCount - whole) % HISTORY) + HISTORY) % HISTORY) * 4;
    const b = ((((this.tickCount - whole - 1) % HISTORY) + HISTORY) % HISTORY) * 4;
    out.x = h[a]! + (h[b]! - h[a]!) * f;
    out.y = h[a + 1]! + (h[b + 1]! - h[a + 1]!) * f;
    out.z = h[a + 2]! + (h[b + 2]! - h[a + 2]!) * f;
    out.crouchT = h[a + 3]! + (h[b + 3]! - h[a + 3]!) * f;
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
    if (this.spreadSecret !== 0 && !this.predicting) {
      rng = this.shotRng;
      rng.reseed(Math.imul(this.tickCount, 2654435761) ^ Math.imul(p.id + 1, 40503) ^ this.spreadSecret);
    } else if (seq > 0) {
      // Client prediction: a stand-in seed, good enough for the tracer it draws.
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
    // A shotgun's pellets fill a cone that is always the same size and thickest in the middle;
    // moving, jumping and rapid fire throw the whole cone off the aim rather than opening it.
    const shot = def.pellets > 1;
    const cone = shot ? Math.min(spread, p.ducked ? def.spreadCrouch : def.spreadStand) : spread;
    let cx = 0, cy = 0;
    if (shot && spread > cone) {
      const a = rng.next() * Math.PI * 2, r = (spread - cone) * rng.next();
      cx = Math.cos(a) * r;
      cy = Math.sin(a) * r;
    }
    for (let i = 0; i < def.pellets; i++) {
      const a = rng.next() * Math.PI * 2;
      const r = cone * rng.next();
      const sx = cx + Math.cos(a) * r, sy = cy + Math.sin(a) * r;
      let dx = fwd.x + rx * sx + ux * sy;
      let dy = fwd.y + uy * sy;
      let dz = fwd.z + rz * sx + uz * sy;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
      dx *= inv; dy *= inv; dz *= inv;
      this.traceBullet(p, def, w.quiet ? SUPPRESSED_RANGE : 1, ox, oy, oz, dx, dy, dz, ends, kinds);
    }

    // The shot pushes the aim on by the pattern's next step from wherever it now is.
    patternAt(def, p.recoilIdx, punch);
    const fromPitch = punch.pitch, fromYaw = punch.yaw;
    p.recoilIdx += 1;
    patternAt(def, p.recoilIdx, punch);
    const steady = w.quiet ? SUPPRESSED_RECOIL : 1;
    p.punchPitch += (punch.pitch - fromPitch) * steady;
    p.punchYaw += (punch.yaw - fromYaw) * steady;
    p.fireSpread = Math.min(def.spreadPerShot * 8, p.fireSpread + def.spreadPerShot);
    p.lastShotAt = now;
    if (def.kind === 'sniper' && p.scope > 0) {
      p.rescope = w.mag > 0 ? p.scope : 0;
      p.scope = 0;
      this.events.push({ type: 'scope', player: p.id, level: 0 });
    }
    this.events.push(w.quiet
      ? { type: 'shot', player: p.id, weapon: def.id, ox, oy, oz, ends, hitKinds: kinds, quiet: true }
      : { type: 'shot', player: p.id, weapon: def.id, ox, oy, oz, ends, hitKinds: kinds });
  }

  /** @param carry what the round keeps of its damage with every 10 m, on top of the gun's own falloff */
  private traceBullet(
    p: Player, def: WeaponDef, carry: number,
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
        const far = carry === 1 ? 1 : Math.pow(carry, (travelled + vt) / 10);
        this.damage(victim, p, def, def.damage * factor * far, vgroup, travelled + vt, hx, hy, hz, wallbang);
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
      if (!this.rules.wallbang || def.penetration <= 0 || thickness > def.penetration) return;
      factor *= 0.8 - 0.45 * (thickness / def.penetration);
      travelled += exit + 0.01;
      sx += dx * (exit + 0.01); sy += dy * (exit + 0.01); sz += dz * (exit + 0.01);
      skip = wbox;
      wallbang = true;
    }
  }

  /**
   * A knife attack, as Counter-Strike's. A slash does 40, 25 for each slash that follows within
   * a second (90 from behind), every 0.4 s (0.5 s after a hit); a stab does 65 (180 from behind)
   * once a second and reaches less far. Armour takes its share of either. "From behind" is where
   * the attacker stands, not which way they face: within about 60 degrees of the victim's back.
   */
  private knife(p: Player, def: WeaponDef, heavy: boolean): void {
    const now = this.time;
    const ox = p.pos.x, oy = this.eyeY(p), oz = p.pos.z;
    forwardFromAngles(p.yaw, p.pitch, fwd);
    const range = heavy ? KNIFE_STAB_RANGE : def.range;
    this.world.raycast(ox, oy, oz, fwd.x, fwd.y, fwd.z, range, ray);
    let best: Player | null = null;
    let bt = Math.min(ray.dist, range);
    for (const v of this.players) {
      if (!v.alive || v.team === p.team) continue;
      // Generous: test a fat cylinder so melee does not need pixel aim.
      const t = rayCylinder(ox, oy, oz, fwd.x, fwd.y, fwd.z, v.pos.x, v.pos.z, v.pos.y, v.pos.y + 1.85, 0.5);
      if (t >= 0 && t < bt) { best = v; bt = t; }
    }
    const chained = !heavy && now - (this.slashAt.get(p.id) ?? -99) < 1;
    if (!heavy) this.slashAt.set(p.id, now);
    p.nextFireAt = now + (heavy ? 1 : best ? 0.5 : 0.4);
    this.events.push({ type: 'knife', player: p.id, hit: best !== null, heavy });
    if (!best) return;
    const dx = best.pos.x - p.pos.x, dz = best.pos.z - p.pos.z, d = Math.hypot(dx, dz) || 1;
    const back = (dx * -Math.sin(best.yaw) + dz * -Math.cos(best.yaw)) / d > 0.475;
    const dmg = heavy ? (back ? 180 : 65) : back ? 90 : chained ? 25 : 40;
    const hx = ox + fwd.x * bt, hy = oy + fwd.y * bt, hz = oz + fwd.z * bt;
    this.damage(best, p, def, dmg, CHEST, 0, hx, hy, hz, false);
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
    if (attacker && attacker.team !== v.team) {
      // (counted up to the health the hit took, as Counter-Strike's damage per round is)
      const took = Math.min(dealt, Math.max(0, v.hp));
      attacker.damage += took;
      this.roundDamage[attacker.id] = (this.roundDamage[attacker.id] ?? 0) + took;
      const n = this.players.length;
      if (this.hurt.length === n * n) this.hurt[attacker.id * n + v.id]! += took;
    }
    v.hp -= dealt;
    // "Tagging": getting hit slows you down, at once and for a second or so after; a heavy hit
    // more than a light one.
    if (attacker) {
      const tag = dealt >= 30 ? TAG_HEAVY : TAG_LIGHT;
      if (tag < v.tag) v.tag = tag;
      if (v.onGround) {
        v.vel.x *= tag;
        v.vel.z *= tag;
      }
    }
    this.events.push({ type: 'hit', victim: v.id, attacker: attacker ? attacker.id : -1, damage: dealt, head: group === HEAD, x, y, z });
    if (v.hp <= 0) this.kill(v, attacker, def, group === HEAD, wallbang);
  }

  private kill(v: Player, killer: Player | null, def: WeaponDef | null, head: boolean, wallbang: boolean): void {
    v.hp = 0;
    v.alive = false;
    v.deaths++;
    v.scope = 0;
    v.useTime = 0;
    v.flashEnd = 0;
    // The best gun falls from the hands (a pistol only when there is no main gun), and a grenade
    // that was in hand with its pin still in falls with it.
    if (!this.predicting) {
      const slot = v.weapons[0] ? 0 : 1;
      const best = v.weapons[slot];
      if (best) {
        this.spawnDrop(v, best, 'fall');
        v.weapons[slot] = null;
      }
      const held = v.weapons[3];
      if (v.active === 3 && held && v.pinAt < 0 && v.throwAt < 0) {
        const i = NADE_INDEX.get(held.def.id)!;
        if (v.nades[i]! > 0) {
          v.nades[i]!--;
          this.spawnDrop(v, { def: held.def, mag: 1, reserve: 0, quiet: false }, 'fall');
          this.syncNade(v);
        }
      }
      if (!v.weapons[v.active]) v.active = 2;
    }
    // Killed with the pin out: the grenade falls from the hand and goes off anyway.
    if (v.pinAt >= 0 && v.active === 3 && v.weapons[3] && !this.predicting) {
      const i = NADE_INDEX.get(v.weapons[3].def.id)!;
      v.nades[i] = Math.max(0, v.nades[i]! - 1);
      const g = this.spawnNade(v, i);
      g.pos.x = v.pos.x; g.pos.y = v.pos.y + 1.2; g.pos.z = v.pos.z;
      g.vel.x = v.vel.x * 0.5; g.vel.y = 1; g.vel.z = v.vel.z * 0.5;
    }
    // (or, killed in the middle of a throw, it falls from the hand)
    const leaving = this.leaving.get(v.id);
    if (leaving !== undefined && !this.predicting) {
      this.leaving.delete(v.id);
      const g = this.spawnNade(v, leaving);
      g.pos.x = v.pos.x; g.pos.y = v.pos.y + 1.2; g.pos.z = v.pos.z;
      g.vel.x = v.vel.x * 0.5; g.vel.y = 1; g.vel.z = v.vel.z * 0.5;
    }
    v.pinAt = -1;
    v.throwAt = -1;
    endGrapple(v, this.time, this.events);
    if (killer && killer !== v) {
      killer.kills++;
      if (def) this.addMoney(killer, def.killReward);
      if (killer.team !== v.team) {
        killer.points += 2;
        this.roundKills[killer.id] = (this.roundKills[killer.id] ?? 0) + 1;
      }
    }
    // Assists: the victim's other enemies who did it more than 40 damage this round, or had it
    // blinded by their flashbang when it died.
    const n = this.players.length;
    const flash = this.flashedBy.get(v.id);
    for (const a of this.players) {
      if (a === killer || a === v || a.team === v.team) continue;
      const hurt = this.hurt.length === n * n ? this.hurt[a.id * n + v.id]! : 0;
      if (hurt > 40 || (flash && flash.by === a.id && this.time < flash.until)) { a.assists++; a.points++; }
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
        this.planter = p.id;
        p.points += 2;
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
        this.disarmer = p.id;
        p.points += 2;
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
    this.updateGrenades();
    this.updateDrops();
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
    // A landing unsettles the aim for a moment, as in Counter-Strike: half the gun's in-air
    // inaccuracy after a full jump, bleeding off as fast as its spray does.
    if (land > 0) {
      const held = p.weapons[p.active];
      if (held) p.fireSpread += held.def.spreadAir * 0.5 * Math.min(1, land / JUMP_SPEED);
    }
    if (!this.predicting) {
      if (land > 14.7) {
        this.damage(p, null, null, (land - 14.7) * 9, LEGS, 0, p.pos.x, p.pos.y, p.pos.z, false);
        if (!p.alive) return;
      }
      // Kill plane, in case anything ever escapes the map.
      if (p.pos.y < -20) { this.kill(p, null, null, false, false); return; }
    }

    // Weapons on the floor: G throws down the one in hand, E takes the one looked at (unless E is
    // planting or disarming here). Both work in the freeze, to hand a teammate a gun.
    const pressed = cmd.buttons & ~p.prevButtons;
    if (!this.predicting && p.useTime <= 0) {
      if (pressed & BTN_DROP) this.dropHeld(p);
      if (pressed & BTN_USE && !this.canPlant(p) && !this.canDisarm(p)) {
        const d = this.dropInReach(p);
        if (d) this.takeDrop(p, d, true);
      }
    }
    this.updateUse(p, cmd);
    this.updateWeapon(p, cmd, !frozenPhase && p.useTime <= 0 && p.mantleT < 0);
    p.prevButtons = cmd.buttons;
  }

  /** Start a brand new match with the same players. */
  restart(): void {
    for (const p of this.players) {
      p.money = this.rules.startMoney;
      p.kills = p.deaths = p.assists = p.mvps = p.points = p.damage = 0;
      p.alive = false;
    }
    this.overtime = 0;
    this.roundLog = [];
    this.score = [0, 0];
    this.lossStreak = [0, 0];
    this.round = 0;
    this.matchWinner = -1;
    this.startRound(true);
  }
}

export { GRAVITY };
