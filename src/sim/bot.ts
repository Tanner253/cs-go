// Bot brains. A bot only produces an input command, exactly like a human, so it obeys the
// same movement, recoil and accuracy rules as everyone else. Nothing here reads hidden
// state a player could not infer: enemies are known only by sight, by the noise they make
// (steps, shots, landings, planting/disarming, reloads) or by a teammate's callout.

import { angleDelta, clamp, lerp, v3, wrapAngle, yawTo, type Vec3 } from './math';
import { eyeHeight } from './movement';
import type { RouteDef } from './map';
import {
  ATK, BTN_ALT, BTN_CROUCH, BTN_FIRE, BTN_JUMP, BTN_RELOAD, BTN_USE, BTN_WALK, DEF, SLOT_NADE,
  type Cmd, type Player,
} from './types';
import type { Sim } from './game';
import { NADE_INDEX } from './weapons';
import { PIN_TIME } from './grenades';
import { worth } from './drops';
import { solveThrow, type ThrowPlan } from './bot-nades';

export type BotMode =
  | 'freeze' | 'wait' | 'move' | 'stage' | 'hold' | 'guard' | 'fight' | 'cover'
  | 'plant' | 'disarm' | 'save';

/** Last known information about one enemy, shared by the whole team ("callouts"). */
interface Sight {
  x: number;
  y: number;
  z: number;
  t: number;
  seen: boolean;
}

/** Team blackboard: what the team knows and what it has agreed to do this round. */
class Board {
  sight: (Sight | null)[] = [];
  /** heat[site][enemyId] = last time that enemy was noticed near the site. */
  heat: number[][] = [[], []];
  chargeSite = -1;
  chargeAt = -99;
  /** Attack: the site being hit. */
  site = 0;
  execute = false;
  executeAt = 0;
  /** Defence: the site the team has called. */
  called = -1;
  calledAt = -99;
  calledStrength = 0;
  contactAt = -99;
  retakeGo = false;
  /** Spots teammates have taken, so two bots never pick the same corner. */
  claims = new Map<number, Vec3>();
  eco = false;
  ecoRound = -1;
  /** Where the team has put grenades lately, so two bots never smoke the same spot. */
  nadeSpots: { x: number; z: number; t: number }[] = [];

  reset(): void {
    this.nadeSpots.length = 0;
    this.sight.length = 0;
    this.heat = [[], []];
    this.chargeSite = -1;
    this.chargeAt = -99;
    this.execute = false;
    this.called = -1;
    this.calledAt = -99;
    this.contactAt = -99;
    this.retakeGo = false;
    this.claims.clear();
  }
}

class Tactics {
  bots: Bot[] = [];
  boards: [Board, Board] = [new Board(), new Board()];
  /** The tick a bot last worked out a throw on (one a tick, so no tick runs long). */
  solveTick = -1;
  /** Densified walking line for each attack route (spawn -> waypoints -> site). */
  routeLines = new Map<string, Vec3[]>();
}

const tactics = new WeakMap<Sim, Tactics>();
function tac(sim: Sim): Tactics {
  let t = tactics.get(sim);
  if (!t) tactics.set(sim, (t = new Tactics()));
  return t;
}

/** Every live bot brain in a simulation (for tests and tooling). */
export function botsOf(sim: Sim): Bot[] {
  return tac(sim).bots.filter((b) => b.me.isBot);
}

const TAU = Math.PI * 2;
const FAN = 16;
const HEAD = 1.5;

function densify(points: Vec3[], step: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (i === 0) { out.push(p); continue; }
    const a = points[i - 1]!;
    const d = Math.hypot(p.x - a.x, p.z - a.z);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({ x: lerp(a.x, p.x, t), y: lerp(a.y, p.y, t), z: lerp(a.z, p.z, t) });
    }
  }
  return out;
}

function routeLine(sim: Sim, route: RouteDef): Vec3[] {
  const T = tac(sim);
  let line = T.routeLines.get(route.name);
  if (line) return line;
  const pts: Vec3[] = [sim.map.spawns[ATK][2]!];
  const stops = [...route.points, sim.map.sites[route.site]!.center];
  let from = pts[0]!;
  for (const s of stops) {
    const leg = sim.nav.findPath(from, s);
    if (leg) for (const p of leg) pts.push(p);
    else pts.push(s);
    from = s;
  }
  line = densify(pts, 1);
  T.routeLines.set(route.name, line);
  return line;
}

export class Bot {
  // ---- plan handed out by assignRoles (part of the public contract) ----
  /** Remaining high-level waypoints toward the objective. */
  route: Vec3[] = [];
  site = 0;
  holdPos: Vec3 | null = null;
  holdLook: Vec3 | null = null;
  /** Seconds after the round goes live before this bot starts moving. */
  startDelay = 0;

  // ---- introspection (tests, debugging) ----
  mode: BotMode = 'freeze';
  /** True while an enemy is in view. */
  visible = false;
  skill: number;
  /** Set to 0..1 to pin this bot's skill instead of using the match setting. */
  skillOverride = -1;

  // ---- navigation ----
  private path: Vec3[] = [];
  private pathI = 0;
  private goal: Vec3 | null = null;
  private lastRepath = -99;
  private stuckX = 0;
  private stuckZ = 0;
  private stuckCheckAt = 0;
  private stuckCount = 0;
  private hopAt = -99;
  private shoveDir = 0;
  private shoveUntil = 0;

  // ---- timers ----
  private nextSense: number;
  private nextDecide = 0;
  private nextLook = 0;

  // ---- perception ----
  private target = -1;
  private reactAt = 0;
  private lostAt = -99;
  private lastSeen = v3();
  private lastSeenAt = -99;
  private lastHp = 100;
  private hurtAt = -99;
  private killAt = -99;
  private eAir = new Uint8Array(16);
  private eFall = new Float32Array(16);
  private mateAlive = new Uint8Array(16);
  private tradeUntil = -99;

  // ---- aim ----
  private aimYaw = 0;
  private aimPitch = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private errYaw = 0;
  private errPitch = 0;
  private errUntil = 0;
  private acquiredAt = 0;
  private wantYaw = 0;
  private wantPitch = 0;
  private fan = new Float32Array(FAN);
  private fanAt = -99;
  private glanceYaw = 0;
  private glanceUntil = 0;
  private nextGlance = 0;
  private watch: Vec3[] = [];
  private watchI = 0;
  private watchUntil = 0;

  // ---- combat ----
  private bursting = false;
  private pauseUntil = 0;
  private fireHeld = false;
  /** The scope button was down last tick (it acts on the press, so it is let up between taps). */
  private altHeld = false;
  private nextClick = 0;
  private strafe = 1;
  private strafeUntil = 0;
  private crouchy = false;
  private coverSpot: Vec3 | null = null;
  private coverUntil = -99;
  private nerve = 0;

  // ---- plan state ----
  private stagePos: Vec3 | null = null;
  private spot: Vec3 | null = null;
  private spotKind = '';
  private ready = false;
  private wantsUse = false;
  /** A gun on the floor being gone for: which, since when, and ones given up on this round. */
  private lootId = -1;
  private lootSince = 0;
  private lootSkip = new Set<number>();
  private fakeUntil = -99;
  private nextFake = 0;
  private walk = false;
  private hurry = false;
  private isMid = false;
  private watchEntrance = 0;
  private rotateAt = -99;
  private bought = false;
  private buyAt = 0;
  /** A grenade being thrown: how, and when it was decided on. */
  private throwing: (ThrowPlan & { since: number }) | null = null;
  private nadeCheckAt = 0;
  /** After throwing a flashbang: looking away from it until this time. */
  private awayUntil = -99;
  private awayYaw = 0;

  constructor(readonly me: Player, private sim: Sim) {
    this.nextSense = (me.id % 6) / 64;
    this.skill = clamp(sim.botSkill + (sim.rng.next() - 0.5) * 0.2, 0, 1);
    tac(sim).bots.push(this);
  }

  private board(): Board {
    return tac(this.sim).boards[this.me.team];
  }

  /** Called at the start of every round. */
  reset(): void {
    const sim = this.sim, rng = sim.rng;
    this.path = [];
    this.pathI = 0;
    this.goal = null;
    this.target = -1;
    this.visible = false;
    this.lastSeenAt = -99;
    this.lostAt = -99;
    this.hurtAt = -99;
    this.killAt = -99;
    this.tradeUntil = -99;
    this.lastHp = 100;
    this.nextDecide = 0;
    this.nextLook = 0;
    this.bought = false;
    this.buyAt = sim.time + 0.3 + rng.next() * 1.6;
    this.throwing = null;
    this.nadeCheckAt = 0;
    this.aimYaw = this.lookYaw = this.me.yaw;
    this.aimPitch = this.lookPitch = 0;
    this.spot = null;
    this.spotKind = '';
    this.stagePos = null;
    this.ready = false;
    this.wantsUse = false;
    this.lootId = -1;
    this.lootSkip.clear();
    this.fakeUntil = -99;
    this.bursting = false;
    this.pauseUntil = 0;
    this.coverSpot = null;
    this.coverUntil = -99;
    this.stuckCheckAt = 0;
    this.stuckCount = 0;
    this.watch = [];
    this.isMid = false;
    this.rotateAt = -99;
    this.walk = false;
    this.hurry = false;
    this.mode = 'freeze';
    this.eAir.fill(0);
    for (const p of sim.players) this.mateAlive[p.id] = 1;
    this.skill = this.skillOverride >= 0 ? this.skillOverride : clamp(sim.botSkill + (rng.next() - 0.5) * 0.2, 0, 1);
    this.crouchy = rng.next() < 0.25 + this.skill * 0.35;
    // Personality for this round: how willing the bot is to push an uncertain fight.
    this.nerve = (rng.next() - 0.5) * 0.4;
  }

  // ======================================================================================
  // helpers
  // ======================================================================================

  private distTo(p: Vec3): number {
    return Math.hypot(p.x - this.me.pos.x, p.z - this.me.pos.z);
  }

  private los(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    return this.sim.world.lineOfSight(ax, ay, az, bx, by, bz);
  }

  private eye(): number {
    return this.me.pos.y + eyeHeight(this.me);
  }

  private setGoal(g: Vec3 | null, force = false): void {
    if (!g) {
      this.goal = null;
      this.path = [];
      this.pathI = 0;
      return;
    }
    const now = this.sim.time;
    if (this.goal && !force) {
      const moved = Math.hypot(g.x - this.goal.x, g.z - this.goal.z);
      if (moved < 0.6) return;
      // A drifting goal (a moving enemy, a carried charge) must not trigger A* every decision.
      if (moved < 4 && now - this.lastRepath < 0.6 && this.pathI < this.path.length) return;
    }
    this.goal = { x: g.x, y: g.y, z: g.z };
    this.lastRepath = now;
    const p = this.sim.nav.findPath(this.me.pos, g);
    this.path = p ?? [];
    this.pathI = 0;
  }

  private arrived(p: Vec3 | null, r = 1.1): boolean {
    return !!p && this.distTo(p) < r && Math.abs(p.y - this.me.pos.y) < 1.4;
  }

  /** Horizontal clearance in 16 directions at eye height: "where is it open around me". */
  private updateFan(): void {
    const now = this.sim.time;
    if (now - this.fanAt < 0.22) return;
    this.fanAt = now;
    const me = this.me, w = this.sim.world, ey = this.eye();
    for (let i = 0; i < FAN; i++) {
      const a = (i / FAN) * TAU;
      this.fan[i] = this.clearance(a, ey, 26);
    }
    void me; void w;
  }

  private clearance(yaw: number, ey: number, max: number): number {
    const me = this.me;
    const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
    // Binary-free: one LOS probe per call would need a hit distance, so step it coarsely.
    let lo = 0;
    for (const d of [2.3, 4, 7, 12, 18, max]) {
      if (d > max) break;
      if (!this.los(me.pos.x, ey, me.pos.z, me.pos.x + dx * d, ey, me.pos.z + dz * d)) return lo;
      lo = d;
    }
    return lo;
  }

  /** The open direction closest to `yaw` (never a wall in the face). */
  private openYawNear(yaw: number, minOpen = 4): number {
    const ey = this.eye();
    if (this.clearance(yaw, ey, minOpen) >= minOpen) return yaw;
    this.updateFan();
    let best = -1, bestOff = Infinity;
    for (let pass = 0; pass < 2 && best < 0; pass++) {
      const need = pass === 0 ? minOpen : 2.3;
      for (let i = 0; i < FAN; i++) {
        if (this.fan[i]! < need) continue;
        const off = Math.abs(angleDelta(yaw, (i / FAN) * TAU));
        if (off < bestOff) { bestOff = off; best = i; }
      }
    }
    return best < 0 ? yaw : (best / FAN) * TAU;
  }

  private lookAtPoint(x: number, y: number, z: number): void {
    const me = this.me;
    const d = Math.hypot(x - me.pos.x, z - me.pos.z);
    if (d < 0.6) return;
    this.lookYaw = yawTo(me.pos.x, me.pos.z, x, z);
    this.lookPitch = clamp(Math.atan2(y - this.eye(), d), -1.2, 1.2);
  }

  private mates(): Bot[] {
    return tac(this.sim).bots.filter((b) => b !== this && b.me.isBot && b.me.alive && b.me.team === this.me.team);
  }

  private aliveEnemies(): number {
    return this.sim.aliveCount(this.me.team === ATK ? DEF : ATK);
  }

  /** Freshest useful piece of enemy information, or null. */
  private threat(maxAge: number, maxDist: number): Sight | null {
    const B = this.board(), now = this.sim.time, me = this.me;
    let best: Sight | null = null, bestScore = Infinity;
    for (const s of B.sight) {
      if (!s || now - s.t > maxAge) continue;
      const d = Math.hypot(s.x - me.pos.x, s.z - me.pos.z);
      if (d > maxDist) continue;
      const score = d + (now - s.t) * 6;
      if (score < bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  // ======================================================================================
  // perception
  // ======================================================================================

  private canSee(e: Player, d: number): boolean {
    const me = this.me, sim = this.sim;
    if (d > 85) return false;
    // (flashed: nothing, until the white has thinned)
    if (sim.blindFor(me) > 0.7) return false;
    if (d > 2.5) {
      const off = Math.abs(angleDelta(this.aimYaw, yawTo(me.pos.x, me.pos.z, e.pos.x, e.pos.z)));
      if (off > 1.08) return false; // ~125 degree field of view
    }
    const oy = this.eye();
    const s = 1 - 0.25 * e.crouchT;
    // (a sight line counts if no wall stands in it and no smoke hides the far end of it)
    const ey = e.pos.y + eyeHeight(e) + 0.05, cy = e.pos.y + 1.05 * s;
    return (
      (this.los(me.pos.x, oy, me.pos.z, e.pos.x, ey, e.pos.z) && !sim.smokeBlocks(me.pos.x, oy, me.pos.z, e.pos.x, ey, e.pos.z)) ||
      (this.los(me.pos.x, oy, me.pos.z, e.pos.x, cy, e.pos.z) && !sim.smokeBlocks(me.pos.x, oy, me.pos.z, e.pos.x, cy, e.pos.z))
    );
  }

  /** How far away this enemy can be heard right now (0 = silent). */
  private noise(e: Player): number {
    const sim = this.sim, now = sim.time;
    const def = sim.activeDef(e);
    if (now - e.lastShotAt < 0.35) return def.kind === 'knife' ? 5 : e.weapons[e.active]?.quiet ? 20 : 50;
    if (this.eAir[e.id] && e.onGround && this.eFall[e.id]! > 6) return 15;
    if (e.useTime > 0) return 11;
    if (e.reloadTimer > 0) return 9;
    if (e.onGround && !e.ducked && Math.hypot(e.vel.x, e.vel.z) > def.maxSpeed * 0.6) return 15;
    return 0;
  }

  private note(e: Player, seen: boolean, x: number, y: number, z: number): void {
    const B = this.board(), now = this.sim.time;
    const prev = B.sight[e.id];
    if (!seen && prev && prev.seen && now - prev.t < 0.5) return;
    if (prev) { prev.x = x; prev.y = y; prev.z = z; prev.t = now; prev.seen = seen; }
    else B.sight[e.id] = { x, y, z, t: now, seen };
    const sites = this.sim.map.sites;
    const d0 = Math.hypot(x - sites[0].center.x, z - sites[0].center.z);
    const d1 = Math.hypot(x - sites[1].center.x, z - sites[1].center.z);
    const s = d0 < d1 ? 0 : 1;
    if (Math.min(d0, d1) < 21) {
      B.heat[s]![e.id] = now;
      if (seen && e.hasCharge) { B.chargeSite = s; B.chargeAt = now; }
    }
  }

  private sense(): void {
    const sim = this.sim, me = this.me, now = sim.time, rng = sim.rng, B = this.board();
    let best: Player | null = null, bestScore = Infinity, bestD = 0;
    const cur = this.target >= 0 ? sim.players[this.target]! : null;
    const hearing = lerp(0.65, 1.1, this.skill);
    for (const e of sim.players) {
      if (e.team === me.team) {
        // A teammate going down nearby is a call to trade the kill.
        if (e !== me && this.mateAlive[e.id] && !e.alive) {
          const d = Math.hypot(e.pos.x - me.pos.x, e.pos.z - me.pos.z);
          if (d < 24) {
            let killer: Sight | null = null, kd = 30;
            for (const s of B.sight) {
              if (!s || now - s.t > 3) continue;
              const sd = Math.hypot(s.x - e.pos.x, s.z - e.pos.z);
              if (sd < kd) { kd = sd; killer = s; }
            }
            this.tradeUntil = now + 4;
            if (killer && !this.visible) {
              this.lastSeen.x = killer.x; this.lastSeen.y = killer.y; this.lastSeen.z = killer.z;
              this.lastSeenAt = now;
            }
          }
        }
        this.mateAlive[e.id] = e.alive ? 1 : 0;
        continue;
      }
      if (!e.alive) {
        B.sight[e.id] = null; // the kill feed tells everyone
        continue;
      }
      const d = Math.hypot(e.pos.x - me.pos.x, e.pos.y - me.pos.y, e.pos.z - me.pos.z);
      if (this.canSee(e, d)) {
        this.note(e, true, e.pos.x, e.pos.y, e.pos.z);
        const score = d * (e === cur ? 0.6 : 1);
        if (score < bestScore) { bestScore = score; best = e; bestD = d; }
      } else {
        const r = this.noise(e) * hearing;
        if (d < r) {
          // Sound gives a direction and a rough distance, not a position.
          const err = d * 0.1 * (1.5 - this.skill);
          this.note(e, false, e.pos.x + (rng.next() - 0.5) * err, e.pos.y, e.pos.z + (rng.next() - 0.5) * err);
        }
      }
      this.eAir[e.id] = e.onGround ? 0 : 1;
      this.eFall[e.id] = e.onGround ? 0 : Math.max(0, -e.vel.y);
    }

    if (best) {
      if (best.id !== this.target || !this.visible) {
        const off = Math.abs(angleDelta(this.aimYaw, yawTo(me.pos.x, me.pos.z, best.pos.x, best.pos.z)));
        let base = lerp(0.6, 0.15, this.skill);
        if (off < 0.3 && now - this.lastSeenAt < 4) base *= 0.6; // already holding that angle
        if (now - this.killAt < 0.7) base *= 0.6; // spray transfer
        const far = bestD > 35 ? (bestD - 35) * 0.012 : 0;
        this.reactAt = now + base + rng.next() * 0.1 + off * lerp(0.22, 0.08, this.skill) + far;
        this.acquiredAt = now;
        this.bursting = false;
        this.pauseUntil = 0;
        this.errUntil = 0;
      }
      this.target = best.id;
      this.visible = true;
      this.lastSeen.x = best.pos.x; this.lastSeen.y = best.pos.y; this.lastSeen.z = best.pos.z;
      this.lastSeenAt = now;
      if (B.contactAt < 0) B.contactAt = now;
    } else {
      if (this.visible) {
        this.lostAt = now;
        if (cur && !cur.alive) this.killAt = now;
      }
      this.visible = false;
      if (this.target >= 0 && (!sim.players[this.target]!.alive || now - this.lostAt > 5)) this.target = -1;
    }
  }

  /** Being shot tells you roughly where from, like a damage indicator. */
  private feelDamage(): void {
    const me = this.me, sim = this.sim, now = sim.time;
    if (me.hp < this.lastHp) {
      this.hurtAt = now;
      if (!this.visible) {
        let shooter: Player | null = null, sd = Infinity;
        for (const e of sim.players) {
          if (!e.alive || e.team === me.team || now - e.lastShotAt > 0.3) continue;
          const d = Math.hypot(e.pos.x - me.pos.x, e.pos.z - me.pos.z);
          if (d < sd && this.los(me.pos.x, this.eye(), me.pos.z, e.pos.x, e.pos.y + 1.4, e.pos.z)) { sd = d; shooter = e; }
        }
        if (shooter) {
          this.note(shooter, false, shooter.pos.x, shooter.pos.y, shooter.pos.z);
          this.lastSeen.x = shooter.pos.x; this.lastSeen.y = shooter.pos.y; this.lastSeen.z = shooter.pos.z;
          this.lastSeenAt = now;
          this.target = shooter.id;
          this.lostAt = now;
          this.nextLook = 0;
          this.nextDecide = Math.min(this.nextDecide, now + 0.05);
        }
      }
    }
    this.lastHp = me.hp;
  }

  // ======================================================================================
  // where to stand
  // ======================================================================================

  /**
   * Pick a standing spot: sees `watch[0]`, hidden from as many `threats` as possible,
   * tucked against cover, not on top of a teammate.
   */
  private pickSpot(
    center: Vec3, rMin: number, rMax: number, watch: Vec3[], threats: Vec3[],
    authored: Vec3[], needLos: Vec3 | null, zone: { minX: number; maxX: number; minZ: number; maxZ: number } | null,
  ): Vec3 {
    const sim = this.sim, nav = sim.nav, rng = sim.rng, B = this.board();
    let best: Vec3 = center, bestScore = -Infinity;
    const n = 18 + authored.length;
    for (let i = 0; i < n; i++) {
      const isAuthored = i < authored.length;
      const c = isAuthored ? authored[i]! : nav.sampleRing(center.x, center.z, rMin, rMax, rng, center.y);
      if (!c) continue;
      if (zone && !(c.x > zone.minX + 0.7 && c.x < zone.maxX - 0.7 && c.z > zone.minZ + 0.7 && c.z < zone.maxZ - 0.7)) continue;
      const cy = Number.isNaN(nav.floorAt(c.x, c.z)) ? c.y : nav.floorAt(c.x, c.z);
      let s = rng.next() * 0.8 + (isAuthored ? 1.5 : 0);
      const w0 = watch[0];
      if (w0) {
        const d = Math.hypot(c.x - w0.x, c.z - w0.z);
        if (this.los(c.x, cy + 1.6, c.z, w0.x, w0.y + HEAD, w0.z)) {
          s += 5;
          // Head-glitch spots: can see standing, hidden when crouched.
          if (!this.los(c.x, cy + 1.0, c.z, w0.x, w0.y + 1.0, w0.z)) s += 1;
        } else s -= 3;
        if (d < 6) s -= 3;
        else if (d < 9) s -= 1;
      }
      for (const t of threats) {
        if (this.los(t.x, t.y + HEAD, t.z, c.x, cy + 1.2, c.z)) s -= 2;
      }
      if (nav.nearCover(c.x, c.z)) s += 1.5;
      if (needLos) s += this.los(c.x, cy + 1.6, c.z, needLos.x, needLos.y + 0.4, needLos.z) ? 4 : -2;
      for (const [id, q] of B.claims) {
        if (id !== this.me.id && Math.hypot(q.x - c.x, q.z - c.z) < 2.6) s -= 8;
      }
      if (s > bestScore) { bestScore = s; best = { x: c.x, y: cy, z: c.z }; }
    }
    B.claims.set(this.me.id, best);
    return best;
  }

  /** Defensive hold at a site, watching one of its entrances. */
  pickHold(site: number, entrance: number): void {
    const def = this.sim.map.sites[site]!;
    const watch = [def.entrances[entrance % def.entrances.length]!];
    const threats: Vec3[] = [];
    def.entrances.forEach((e, i) => {
      if (i !== entrance % def.entrances.length) threats.push(e);
    });
    this.site = site;
    this.watchEntrance = entrance;
    this.holdPos = this.pickSpot(def.center, 1.5, 10.5, watch, threats, def.holds.map((h) => h.pos), null, null);
    this.holdLook = watch[0]!;
    this.setWatch(this.holdPos, [watch[0]!, ...threats]);
  }

  /** Keep only watch points that can actually be seen from where the bot will stand. */
  private setWatch(from: Vec3, points: Vec3[]): void {
    this.watch = points.filter((p) => this.los(from.x, from.y + 1.6, from.z, p.x, p.y + HEAD, p.z));
    if (this.watch.length === 0 && points.length > 0) this.watch = [points[0]!];
    this.watchI = 0;
    this.watchUntil = 0;
  }

  private pickGuard(around: Vec3, needLos: Vec3 | null, rMin: number, rMax: number): Vec3 {
    const site = this.sim.map.sites[this.site]!;
    // Attackers expect the retake from the defender side first.
    const order = this.me.team === ATK ? [2, 1, 0] : [0, 1, 2];
    const k = order[this.me.id % order.length]!;
    const watch = [site.entrances[k]!];
    const threats = site.entrances.filter((_, i) => i !== k);
    const spot = this.pickSpot(around, rMin, rMax, watch, threats, [], needLos, null);
    this.setWatch(spot, needLos ? [watch[0]!, ...threats, needLos] : [watch[0]!, ...threats]);
    return spot;
  }

  private pickPlantSpot(): Vec3 {
    const site = this.sim.map.sites[this.site]!;
    return this.pickSpot(site.center, 0, 7, [], site.entrances, [], null, site.zone);
  }

  /** A spot the enemy at `from` cannot see, as close as possible. */
  private findCover(from: Vec3): Vec3 | null {
    const sim = this.sim, me = this.me, nav = sim.nav;
    let best: Vec3 | null = null, bestD = Infinity;
    for (let i = 0; i < 14; i++) {
      const c = nav.sampleRing(me.pos.x, me.pos.z, 1.2, 8, sim.rng, me.pos.y);
      if (!c) continue;
      if (this.los(from.x, from.y + 1.6, from.z, c.x, c.y + 1.5, c.z)) continue;
      if (this.los(from.x, from.y + 1.6, from.z, c.x, c.y + 0.7, c.z)) continue;
      const d = this.distTo(c);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  private fleePoint(from: Vec3): Vec3 {
    const sim = this.sim, me = this.me;
    const opts = [sim.map.spawns[me.team][0]!, sim.map.sites[0].center, sim.map.sites[1].center, { x: 0, y: 0, z: 12 }, sim.map.spawns[1 - me.team as 0 | 1][0]!];
    let best = opts[0]!, bestD = Infinity;
    for (const o of opts) {
      if (Math.hypot(o.x - from.x, o.z - from.z) < 24) continue;
      const d = this.distTo(o);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  // ======================================================================================
  // decisions (5 Hz)
  // ======================================================================================

  /** Willingness to go looking for a fight, from numbers, health, role and temperament. */
  private aggression(): number {
    const me = this.me, sim = this.sim;
    const mine = sim.aliveCount(me.team), theirs = this.aliveEnemies();
    let a = 0.45 + 0.12 * (mine - theirs) + (me.hp - 60) / 220 + this.nerve;
    if (sim.time < this.tradeUntil) a += 0.35;
    if (me.team === ATK) a += sim.phase === 'planted' ? -0.35 : 0.1;
    else a += sim.phase === 'planted' ? 0.3 : -0.2;
    if (mine === 1 && theirs >= 2) a -= 0.3; // clutch: play for picks and time
    return a;
  }

  private decide(): void {
    const sim = this.sim, me = this.me, now = sim.time;
    this.wantsUse = false;
    this.walk = false;
    this.hurry = false;

    if (sim.phase === 'freeze') {
      this.mode = 'freeze';
      this.setGoal(null);
      return;
    }
    if (sim.phase === 'end' || sim.phase === 'over') {
      // Round decided: stop objectives, keep defending yourself.
      this.mode = this.visible ? 'fight' : 'hold';
      this.setGoal(null);
      return;
    }
    if (sim.phase === 'live' && sim.liveTime < this.startDelay) {
      this.mode = 'wait';
      return;
    }
    // Break line of sight to reload or when badly hurt in a duel.
    const w = me.weapons[me.active]!;
    const pressured = this.visible || now - this.lastSeenAt < 1.2;
    const dry = w.def.magSize > 0 && (me.reloadTimer > 0 || w.mag === 0);
    if (pressured && (dry || (me.hp < 30 && now - this.hurtAt < 1.5 && this.skill > 0.35)) && this.distTo(this.lastSeen) > 4) {
      if (!this.coverSpot || now > this.coverUntil) {
        this.coverSpot = this.findCover(this.lastSeen);
        this.coverUntil = now + 2.5;
      }
      if (this.coverSpot) {
        this.mode = 'cover';
        this.hurry = true;
        this.setGoal(this.coverSpot);
        return;
      }
    } else if (!pressured) {
      this.coverSpot = null;
    }

    if (me.team === ATK) this.decideAttack();
    else this.decideDefend();
    this.loot();

    // Move quietly when an unseen enemy is close and there is no clock pressure.
    if (!this.hurry && this.skill > 0.3 && (this.mode === 'move' || this.mode === 'fight')) {
      const t = this.threat(5, 17);
      if (t && !this.visible) this.walk = true;
    }
  }

  /**
   * A much better gun on the floor close by and nothing pressing (no enemy in sight or heard of
   * lately, nothing to plant or disarm): go over and take it, as players pick up the rifle of
   * someone just killed.
   */
  private loot(): void {
    const sim = this.sim, me = this.me, now = sim.time;
    if (this.visible || now - this.lastSeenAt < 2.5 || this.wantsUse || this.mode === 'cover' || this.mode === 'save'
      || this.mode === 'plant' || this.mode === 'disarm' || sim.drops.length === 0
      || (me.hasCharge && sim.siteAt(me.pos.x, me.pos.z) >= 0)) { this.lootId = -1; return; }
    let best = null as (typeof sim.drops)[number] | null, bestScore = 0;
    for (const d of sim.drops) {
      const w = d.weapon;
      if (w.def.kind === 'grenade' || this.lootSkip.has(d.id)) continue;
      const gain = worth(w) - worth(me.weapons[w.def.slot]);
      const dist = Math.hypot(d.pos.x - me.pos.x, d.pos.z - me.pos.z);
      if (gain < 600 || dist > 10 || Math.abs(d.pos.y - me.pos.y) > 1.3) continue;
      const score = gain - dist * 110;
      if (score > bestScore && this.los(me.pos.x, this.eye(), me.pos.z, d.pos.x, d.pos.y + 0.1, d.pos.z)) { best = d; bestScore = score; }
    }
    if (!best) { this.lootId = -1; return; }
    if (best.id !== this.lootId) { this.lootId = best.id; this.lootSince = now; }
    else if (now - this.lootSince > 5) { this.lootSkip.add(best.id); this.lootId = -1; return; } // (cannot get to it)
    this.mode = 'move';
    this.walk = false;
    this.setGoal({ x: best.pos.x, y: best.pos.y, z: best.pos.z });
    if (Math.hypot(best.pos.x - me.pos.x, best.pos.z - me.pos.z) < 0.6) this.wantsUse = true;
  }

  /** Should the bot go to where it last saw / heard its target? */
  private wantsHunt(leashFrom: Vec3 | null, leash: number): boolean {
    const now = this.sim.time;
    if (this.visible || this.target < 0) return false;
    const since = now - this.lostAt;
    const holdAngle = lerp(2.2, 1.1, clamp(this.aggression(), 0, 1));
    if (since < holdAngle || since > 7) return false;
    if (this.aggression() < 0.5) return false;
    if (leashFrom && Math.hypot(this.lastSeen.x - leashFrom.x, this.lastSeen.z - leashFrom.z) > leash) return false;
    return this.distTo(this.lastSeen) > 1.5;
  }

  private decideAttack(): void {
    const sim = this.sim, me = this.me, now = sim.time, c = sim.charge, B = this.board();
    const site = sim.map.sites[this.site]!;

    if (c.state === 'planted') {
      this.site = c.site;
      // The fuse is about to finish: get out of the blast.
      const d = Math.hypot(me.pos.x - c.pos.x, me.pos.z - c.pos.z);
      const disarming = this.enemyDisarming();
      if (c.timer < 6.5 && d < 16 && !disarming) {
        this.mode = 'save';
        this.hurry = true;
        this.setGoal(this.fleePoint(c.pos));
        return;
      }
      if (disarming) {
        // Someone is on the charge: get eyes on it now.
        this.hurry = true;
        this.lastSeen.x = c.pos.x; this.lastSeen.y = c.pos.y; this.lastSeen.z = c.pos.z;
        this.lastSeenAt = now;
        if (!this.los(me.pos.x, this.eye(), me.pos.z, c.pos.x, c.pos.y + 0.9, c.pos.z)) {
          this.mode = 'move';
          this.setGoal(c.pos);
        } else {
          this.mode = 'fight';
          this.setGoal(null);
        }
        return;
      }
      if (this.spotKind !== 'post' || !this.spot) {
        this.spot = this.pickGuard(c.pos, c.pos, 4, 13);
        this.spotKind = 'post';
      }
      if (this.wantsHunt(c.pos, 14)) { this.mode = 'move'; this.setGoal(this.lastSeen); return; }
      this.mode = this.arrived(this.spot) ? 'guard' : 'move';
      this.setGoal(this.spot);
      return;
    }

    if (c.state === 'dropped') {
      let closest: Player = me, cd = this.distTo(c.pos);
      for (const b of this.mates()) {
        const d = Math.hypot(b.me.pos.x - c.pos.x, b.me.pos.z - c.pos.z);
        if (d < cd) { cd = d; closest = b.me; }
      }
      if (closest === me) {
        this.mode = 'move';
        this.hurry = true;
        this.setGoal(c.pos);
        return;
      }
    }

    // Follow a human carrier's lead: if they commit to the other site, go with them.
    const carrier = c.state === 'carried' ? sim.players[c.carrier] : null;
    if (carrier && !carrier.isBot) {
      for (let s = 0; s < 2; s++) {
        const sc = sim.map.sites[s]!.center;
        if (s !== B.site && Math.hypot(carrier.pos.x - sc.x, carrier.pos.z - sc.z) < 15) {
          B.site = s;
          B.execute = true;
          B.executeAt = now;
        }
      }
    }
    if (this.site !== B.site) {
      this.site = B.site;
      this.spot = null;
      this.stagePos = null;
      this.route = [];
    }

    // Clock management: with time running out there is no more waiting.
    if (sim.phaseTime < 42 && !B.execute) { B.execute = true; B.executeAt = now; }

    if (!B.execute) {
      // Walk the route, then gather just short of the site.
      if (this.route.length > 0) {
        const wp = this.route[0]!;
        if (this.distTo(wp) < 2.5 || (this.stagePos && this.distTo(this.stagePos) < 6)) this.route.shift();
        else if (!this.stagePos || this.distTo(wp) < this.distTo(this.stagePos) + 12) {
          this.mode = 'move';
          this.setGoal(wp);
          this.checkExecute();
          return;
        } else this.route.shift();
      }
      const stage = this.stagePos ?? site.center;
      this.ready = this.arrived(stage, 2.2);
      this.mode = this.ready ? 'stage' : 'move';
      if (!this.ready && this.distTo(stage) < 14 && this.skill > 0.3) this.walk = true;
      this.setGoal(stage);
      this.checkExecute();
      return;
    }

    // ---- executing ----
    this.hurry = now - B.executeAt < 6 || sim.phaseTime < 30;
    if (me.hasCharge) {
      // The carrier lets the entry players go first.
      const mates = this.mates().length;
      if (mates > 0 && now - B.executeAt < 1.2 && this.stagePos && !this.visible) {
        this.mode = 'stage';
        this.setGoal(this.stagePos);
        return;
      }
      if (this.spotKind !== 'plant' || !this.spot) {
        this.spot = this.pickPlantSpot();
        this.spotKind = 'plant';
      }
      this.setGoal(this.spot);
      this.mode = 'move';
      if (sim.canPlant(me) && (this.arrived(this.spot, 1.2) || this.pathI >= this.path.length)) {
        const t = this.threat(2.5, 10);
        const pressure = sim.phaseTime < sim.rules.plantTime + 6;
        const committed = me.useTime > sim.rules.plantTime * 0.7;
        const safe = (!this.visible && (!t || !t.seen || mates > 0)) || pressure || committed;
        if (safe && now - this.hurtAt > 0.8 || pressure || committed) {
          this.wantsUse = true;
          this.mode = 'plant';
        } else {
          this.mode = 'fight';
        }
      }
      return;
    }
    if (this.wantsHunt(site.center, 16)) { this.mode = 'move'; this.setGoal(this.lastSeen); return; }
    if (this.spotKind !== 'site' || !this.spot) {
      this.spot = this.pickGuard(site.center, site.center, 2, 9);
      this.spotKind = 'site';
    }
    this.mode = this.arrived(this.spot) ? 'guard' : 'move';
    this.setGoal(this.spot);
  }

  /** Attackers go in together: most of the squad in position, or contact, or the clock. */
  private checkExecute(): void {
    const sim = this.sim, B = this.board(), now = sim.time;
    if (B.execute) return;
    let alive = 0, ready = 0;
    for (const b of tac(sim).bots) {
      if (!b.me.isBot || !b.me.alive || b.me.team !== ATK) continue;
      alive++;
      if (b.ready) ready++;
    }
    // Getting into a fight right at the staging area means the element of surprise is gone.
    const contact = this.ready && (this.visible || now - this.hurtAt < 1) && sim.liveTime > 6;
    if ((alive > 0 && ready >= Math.ceil(alive * 0.6) && sim.liveTime > 4) || contact || sim.liveTime > 34) {
      B.execute = true;
      B.executeAt = now;
    }
  }

  private enemyDisarming(): boolean {
    const sim = this.sim, c = sim.charge, me = this.me;
    for (const e of sim.players) {
      if (!e.alive || e.team === me.team || e.useTime <= 0) continue;
      // Disarming is audible near the charge.
      if (Math.hypot(me.pos.x - c.pos.x, me.pos.z - c.pos.z) < 22) return true;
    }
    return false;
  }

  private updateCall(): void {
    const sim = this.sim, B = this.board(), now = sim.time;
    const enemies = this.aliveEnemies();
    let bestSite = -1, bestN = 0;
    for (let s = 0; s < 2; s++) {
      let n = 0;
      const h = B.heat[s]!;
      for (let id = 0; id < h.length; id++) {
        if (h[id] !== undefined && now - h[id]! < 6 && sim.players[id]!.alive) n++;
      }
      if (B.chargeSite === s && now - B.chargeAt < 8) n += 3;
      if (n > bestN) { bestN = n; bestSite = s; }
    }
    if (bestSite >= 0 && (bestN >= Math.min(2, enemies) || bestN >= 3)) {
      if (B.called !== bestSite || bestN > B.calledStrength || now - B.calledAt > 4) {
        B.called = bestSite;
        B.calledStrength = bestN >= enemies ? 9 : bestN;
      }
      B.calledAt = now;
    }
  }

  private decideDefend(): void {
    const sim = this.sim, me = this.me, now = sim.time, c = sim.charge, B = this.board();

    if (c.state === 'planted') {
      this.site = c.site;
      const d = Math.hypot(me.pos.x - c.pos.x, me.pos.z - c.pos.z);
      const need = sim.disarmDuration(me) - me.useTime;
      const eta = Math.max(0, d - 1.2) / 5.2;
      // Not enough fuse left to get there and finish: live to keep the rifle.
      if (c.timer < need + eta + 0.15 && me.useTime <= 0) {
        this.mode = 'save';
        this.hurry = true;
        this.setGoal(d < 22 ? this.fleePoint(c.pos) : null);
        return;
      }
      // Who disarms: whoever can finish soonest (a kit is worth five seconds).
      let disarmer: Player = me, bestT = eta + sim.disarmDuration(me);
      const mates = this.mates();
      for (const b of mates) {
        const bd = Math.hypot(b.me.pos.x - c.pos.x, b.me.pos.z - c.pos.z);
        const t = Math.max(0, bd - 1.2) / 5.2 + sim.disarmDuration(b.me) + (b.me.id < me.id ? -0.01 : 0.01);
        if (t < bestT) { bestT = t; disarmer = b.me; }
      }
      const urgent = c.timer < need + eta + 2.2;
      // Retake together unless the clock forbids waiting.
      if (!B.retakeGo) {
        let near = 0;
        for (const b of mates) if (Math.hypot(b.me.pos.x - me.pos.x, b.me.pos.z - me.pos.z) < 10) near++;
        if (mates.length === 0 || near >= Math.ceil(mates.length * 0.5) || c.timer < sim.disarmDuration(me) + 14 || d < 9) B.retakeGo = true;
      }
      this.hurry = urgent || c.timer < 20;
      if (disarmer === me) {
        const far = d > 15;
        if (!B.retakeGo && far) {
          // Wait for the others at the edge of the site.
          const e = sim.map.sites[c.site]!.entrances[2]!;
          this.mode = this.arrived(e, 3) ? 'stage' : 'move';
          this.setGoal(e);
          return;
        }
        this.setGoal(c.pos);
        this.mode = 'move';
        if (sim.canDisarm(me)) {
          const hurt = now - this.hurtAt < 1.0;
          const t = this.threat(1.5, 14);
          if (urgent) {
            this.wantsUse = true; // stick it
          } else if (this.visible || hurt) {
            this.wantsUse = false; // fight first
          } else if (now < this.fakeUntil) {
            this.wantsUse = false; // faked: now watch for the peek
          } else {
            this.wantsUse = true;
            // Tap the charge, let go, and catch whoever swings on the sound.
            if (me.useTime > 0.35 && me.useTime < 0.6 && now > this.nextFake && this.skill > 0.45 && this.aliveEnemies() > 0 && (t || sim.rng.next() < 0.5)) {
              this.fakeUntil = now + 1.3 + sim.rng.next() * 0.6;
              this.nextFake = now + 6;
              this.wantsUse = false;
            }
          }
          this.mode = this.wantsUse ? 'disarm' : 'fight';
        }
        return;
      }
      // Cover the disarmer.
      if (this.spotKind !== 'retake' || !this.spot) {
        this.spot = this.pickGuard(c.pos, c.pos, 3, 9);
        this.spotKind = 'retake';
      }
      if (this.wantsHunt(c.pos, 15)) { this.mode = 'move'; this.setGoal(this.lastSeen); return; }
      this.mode = this.arrived(this.spot) ? 'guard' : 'move';
      this.setGoal(this.spot);
      return;
    }

    // ---- no plant yet: hold, and rotate on information ----
    this.updateCall();
    if (B.called >= 0 && B.called !== this.site && now - B.calledAt < 9) {
      // How many leave: everyone if the whole enemy team is confirmed there, otherwise keep an anchor.
      let rank = 0, siteMates = 0;
      for (const b of this.mates()) {
        if (b.site === this.site && !b.isMid) {
          siteMates++;
          if (b.me.id < me.id) rank++;
        }
      }
      const all = B.calledStrength >= 9 || B.calledStrength >= 3;
      const go = this.isMid || all || rank < siteMates; // lowest ids rotate first, the last one anchors
      if (go) {
        if (this.rotateAt < 0) this.rotateAt = now + lerp(1.6, 0.5, this.skill) + sim.rng.next() * 0.6;
        if (now >= this.rotateAt) {
          this.isMid = false;
          this.rotateAt = -99;
          this.pickHold(B.called, (me.id + 1) % 3);
          this.hurry = true;
        }
      }
    } else {
      this.rotateAt = -99;
    }

    const hold = this.holdPos;
    if (hold && this.wantsHunt(hold, 13) && sim.phaseTime > 20) {
      this.mode = 'move';
      this.setGoal(this.lastSeen);
      return;
    }
    this.mode = this.arrived(hold) ? 'hold' : 'move';
    this.setGoal(hold);
  }

  /** Attack plan: walk a route, then gather short of the site until the squad goes in. */
  planRoute(route: RouteDef, order: number): void {
    const sim = this.sim;
    this.site = route.site;
    this.route = route.points.slice(0, -1);
    // Leave spawn spaced out rather than as a conga line.
    this.startDelay = order * 0.45 + sim.rng.next() * 0.3;
    // Gather a dozen metres short of the entrance, tucked out of sight of the site.
    const line = routeLine(sim, route);
    const entrance = route.points[route.points.length - 1]!;
    let ei = line.length - 1, ed = Infinity;
    for (let i = 0; i < line.length; i++) {
      const d = Math.hypot(line[i]!.x - entrance.x, line[i]!.z - entrance.z);
      if (d < ed) { ed = d; ei = i; }
    }
    const stage = line[Math.max(0, ei - 12)]!;
    const site = sim.map.sites[route.site]!;
    this.stagePos = this.pickSpot(stage, 0, 3.2, [], [site.center, ...site.holds.map((h) => h.pos)], [], null, null);
  }

  /** Defence plan: watch the middle of the map and be first to rotate. */
  planMid(index: number): void {
    const sim = this.sim;
    const h = sim.map.midHolds[index % sim.map.midHolds.length]!;
    this.isMid = true;
    this.site = sim.rng.int(2);
    this.holdPos = h.pos;
    this.holdLook = h.look;
    this.board().claims.set(this.me.id, h.pos);
    this.setWatch(h.pos, [h.look]);
  }

  // ======================================================================================
  // buying
  // ======================================================================================

  private buy(): void {
    const sim = this.sim, me = this.me, B = this.board(), rng = sim.rng;
    this.bought = true;
    const rifle = me.team === ATK ? 'hammerhead' : 'lumen';
    const riflePrice = me.team === ATK ? 2700 : 3000;
    const carbine = me.team === ATK ? 'mako' : 'osprey';
    const carbinePrice = me.team === ATK ? 1800 : 2050;
    const full = riflePrice + 1000;

    // The team saves or buys together.
    if (B.ecoRound !== sim.round) {
      B.ecoRound = sim.round;
      let sum = 0, n = 0, canFull = 0;
      for (const p of sim.players) {
        if (p.team !== me.team) continue;
        sum += p.money; n++;
        if (p.money >= full || p.weapons[0]) canFull++;
      }
      const half = sim.rules.maxRounds / 2;
      const lastOfHalf = sim.round === half || sim.round === sim.rules.maxRounds;
      const matchPoint = sim.score[1 - me.team as 0 | 1] >= sim.rules.roundsToWin - 1;
      const pistolRound = sim.round === 1 || sim.round === half + 1;
      B.eco = !pistolRound && !lastOfHalf && !matchPoint && canFull < Math.ceil(n * 0.6) && sum / n < full * 0.8;
    }

    // One on each side carries the sniper, when the team is buying and this one can afford it
    // with armour besides (as in CS, the AWP is a team's choice, not everyone's).
    const sniper = me.team === ATK ? 'colossus' : 'longsight';
    const sniperPrice = me.team === ATK ? 5200 : 4750;
    const teamHasSniper = sim.players.some((p) => p !== me && p.team === me.team && p.alive && p.weapons[0]?.def.kind === 'sniper');
    const wantsSniper = !B.eco && !teamHasSniper && me.money >= sniperPrice + 1000 && rng.next() < 0.45;
    if (!me.weapons[0] && wantsSniper) {
      sim.tryBuy(me, sniper);
      sim.tryBuy(me, 'armorhelmet');
    } else if (!me.weapons[0]) {
      if (me.money >= full) { sim.tryBuy(me, rifle); sim.tryBuy(me, 'armorhelmet'); }
      else if (!B.eco) {
        if (me.money >= riflePrice + 650) { sim.tryBuy(me, rifle); sim.tryBuy(me, 'armor'); }
        else if (me.money >= carbinePrice + 650) { sim.tryBuy(me, carbine); sim.tryBuy(me, 'armor'); }
        else if (me.money >= 1900) { sim.tryBuy(me, rng.next() < 0.8 ? (me.team === ATK ? 'wasp' : 'hornet') : me.team === ATK ? 'thresher' : 'breaker'); sim.tryBuy(me, 'armor'); }
        else if (me.money >= 1350) { sim.tryBuy(me, 'maul'); sim.tryBuy(me, 'armor'); }
        else if (me.money >= 650) sim.tryBuy(me, 'armor');
      }
    } else {
      if (!sim.tryBuy(me, 'armorhelmet')) sim.tryBuy(me, 'armor');
    }
    if (me.team === DEF && !B.eco && me.money >= 400 && (me.weapons[0] || me.money >= 900)) sim.tryBuy(me, 'kit');
    // Grenades with what is left: each side's habits, in a different order each round; never on a save.
    if (!B.eco && me.weapons[0]) {
      const fire = me.team === ATK ? 'molotov' : 'incendiary';
      const wants = me.team === ATK ? ['smoke', 'flash', fire, 'frag', 'flash'] : ['frag', 'flash', fire, 'smoke'];
      const start = rng.int(wants.length);
      for (let k = 0; k < wants.length; k++) {
        const id = wants[(start + k) % wants.length]!;
        if (me.money >= 900 || (me.money >= 300 && rng.next() < 0.5)) sim.tryBuy(me, id);
      }
    }
  }

  /**
   * Decide on a grenade, if there is one worth throwing from here: fire or an HE grenade at an
   * enemy known to be behind cover close by; going onto a site, smoke on the defenders' spots and a
   * flash over it; with the charge down and defenders closing on it, fire on the charge.
   */
  private planNade(): void {
    const sim = this.sim, me = this.me, now = sim.time, rng = sim.rng, B = this.board();
    if ((sim.phase !== 'live' && sim.phase !== 'planted') || me.reloadTimer > 0 || !me.nades.some((n) => n > 0)) return;
    if (rng.next() > 0.3 + this.skill * 0.55) return;
    const has = (id: string): number => { const i = NADE_INDEX.get(id)!; return me.nades[i]! > 0 ? i : -1; };
    const fire = has(me.team === ATK ? 'molotov' : 'incendiary'), he = has('frag'), smoke = has('smoke'), flash = has('flash');
    const tries: [kind: number, x: number, y: number, z: number, within: number][] = [];
    const s = this.threat(4, 26);
    if (s && !this.visible) {
      const d = Math.hypot(s.x - me.pos.x, s.z - me.pos.z);
      if (d > 6) {
        if (he >= 0) tries.push([he, s.x, s.y, s.z, 2.5]);
        if (fire >= 0 && d < 22) tries.push([fire, s.x, s.y, s.z, 2]);
        if (flash >= 0 && d < 16) tries.push([flash, s.x, s.y + 1.6, s.z, 4]);
      }
    }
    if (me.team === ATK && B.execute && now - B.executeAt < 10) {
      const site = sim.map.sites[B.site]!;
      const d = Math.hypot(site.center.x - me.pos.x, site.center.z - me.pos.z);
      if (d > 8 && d < 32) {
        if (smoke >= 0) for (const h of site.holds) tries.push([smoke, h.pos.x, h.pos.y, h.pos.z, 2.5]);
        if (flash >= 0) tries.push([flash, site.center.x, site.center.y + 1.8, site.center.z, 5]);
      }
    }
    const c = sim.charge;
    if (me.team === ATK && sim.phase === 'planted' && c.state === 'planted' && fire >= 0) {
      const d = Math.hypot(c.pos.x - me.pos.x, c.pos.z - me.pos.z);
      const closing = B.sight.some((t) => !!t && now - t.t < 3 && Math.hypot(t.x - c.pos.x, t.z - c.pos.z) < 9);
      if (closing && d > 7 && d < 24) tries.push([fire, c.pos.x, c.pos.y, c.pos.z, 1.5]);
    }
    const T = tac(sim);
    let solved = 0;
    for (const [kind, x, y, z, within] of tries) {
      if (B.nadeSpots.some((p) => now - p.t < 8 && Math.hypot(p.x - x, p.z - z) < 3.5)) continue;
      // (a flashbang is not thrown where a teammate would be looking at it)
      if (kind === flash && sim.players.some((m) => m !== me && m.alive && m.team === me.team && Math.hypot(m.pos.x - x, m.pos.z - z) < 12)) continue;
      // One throw worked out a tick between all the bots, and two at most for this one now.
      if (T.solveTick === sim.tickCount || solved >= 2) { this.nadeCheckAt = now + 0.1; return; }
      T.solveTick = sim.tickCount;
      solved++;
      const plan = solveThrow(sim.world, me, kind, x, y, z, within);
      if (!plan) continue;
      this.throwing = { ...plan, since: now };
      B.nadeSpots.push({ x, z, t: now });
      return;
    }
  }

  /** One tick of a throw: the grenade out, the aim on, the pin pulled, let go. */
  private throwStep(cmd: Cmd): void {
    const me = this.me, now = this.sim.time, T = this.throwing!;
    if (me.active !== 3 || me.nadeSel !== T.kind) {
      if (me.throwAt < 0) cmd.slot = SLOT_NADE + T.kind;
      return;
    }
    if (me.throwAt >= 0) {
      // Gone: back to the gun (and a flashbang is not watched going off).
      if (me.weapons[3]?.def.nade?.type === 'flash' || T.kind === NADE_INDEX.get('flash')) { this.awayUntil = now + 1.9; this.awayYaw = T.yaw + Math.PI; }
      this.throwing = null;
      this.nadeCheckAt = now + 2.5;
      return;
    }
    if (me.drawTimer > 0) return;
    const aimed = Math.abs(angleDelta(this.aimYaw, T.yaw)) < 0.025 && Math.abs(this.aimPitch - T.pitch) < 0.025;
    const btn = T.str >= 0.75 ? BTN_FIRE : T.str <= 0.25 ? BTN_ALT : BTN_FIRE | BTN_ALT;
    if (me.pinAt < 0) { if (aimed) cmd.buttons |= btn; }
    else if (now - me.pinAt < PIN_TIME + 0.05 || !aimed) cmd.buttons |= btn;
  }

  // ======================================================================================
  // looking (8 Hz when no enemy is in view)
  // ======================================================================================

  private updateLook(): void {
    const sim = this.sim, me = this.me, now = sim.time, rng = sim.rng;
    const ey = this.eye();

    // 1. Just lost sight of someone, or just got shot: keep the crosshair where they were.
    if (now - this.lastSeenAt < 2.2 && this.distTo(this.lastSeen) > 1.2) {
      const ls = this.lastSeen;
      if (this.los(me.pos.x, ey, me.pos.z, ls.x, ls.y + 1.4, ls.z)) {
        this.lookAtPoint(ls.x, ls.y + 1.4, ls.z);
      } else {
        this.lookYaw = this.openYawNear(yawTo(me.pos.x, me.pos.z, ls.x, ls.z));
        this.lookPitch = clamp(Math.atan2(ls.y + 1.4 - ey, this.distTo(ls)), -0.9, 0.9) * 0.6;
      }
      return;
    }

    const settled = this.mode === 'hold' || this.mode === 'guard' || this.mode === 'stage';
    const t = this.threat(5, 45);

    // 2. A noise or a callout: face the opening it will come through.
    if (t) {
      let done = false;
      if (settled && this.watch.length > 0) {
        const bearing = yawTo(me.pos.x, me.pos.z, t.x, t.z);
        let bi = -1, bo = 0.9;
        for (let i = 0; i < this.watch.length; i++) {
          const wp = this.watch[i]!;
          const off = Math.abs(angleDelta(bearing, yawTo(me.pos.x, me.pos.z, wp.x, wp.z)));
          if (off < bo) { bo = off; bi = i; }
        }
        if (bi >= 0) {
          const wp = this.watch[bi]!;
          this.lookAtPoint(wp.x, wp.y + HEAD, wp.z);
          done = true;
        }
      }
      if (!done) {
        if (this.los(me.pos.x, ey, me.pos.z, t.x, t.y + 1.4, t.z)) this.lookAtPoint(t.x, t.y + 1.4, t.z);
        else {
          this.lookYaw = this.openYawNear(yawTo(me.pos.x, me.pos.z, t.x, t.z));
          // Enemies are not always at eye level (decks, steps).
          this.lookPitch = clamp(Math.atan2(t.y + 1.4 - ey, Math.hypot(t.x - me.pos.x, t.z - me.pos.z)), -0.8, 0.9) * 0.7;
        }
      }
      return;
    }

    // 3. Holding a position: watch the angles it covers, mostly the main one.
    if (settled && this.watch.length > 0) {
      if (now >= this.watchUntil) {
        if (this.watch.length === 1 || rng.next() < 0.62) {
          this.watchI = 0;
          this.watchUntil = now + 2.5 + rng.next() * 3;
        } else {
          this.watchI = 1 + rng.int(this.watch.length - 1);
          this.watchUntil = now + 0.9 + rng.next() * 0.9;
        }
      }
      const wp = this.watch[this.watchI]!;
      if (this.los(me.pos.x, ey, me.pos.z, wp.x, wp.y + HEAD, wp.z)) this.lookAtPoint(wp.x, wp.y + HEAD, wp.z);
      else {
        this.lookYaw = this.openYawNear(yawTo(me.pos.x, me.pos.z, wp.x, wp.z));
        this.lookPitch = 0;
      }
      return;
    }

    // 4. Quick glance at another open angle while travelling.
    if (now < this.glanceUntil) {
      this.lookYaw = this.glanceYaw;
      this.lookPitch = 0;
      return;
    }

    // 5. Travelling: aim at head height where the path next comes into view (the corner).
    if (this.pathI < this.path.length) {
      let px = me.pos.x, py = me.pos.y, pz = me.pos.z;
      let lx = 0, ly = 0, lz = 0, found = false, acc = 0;
      let hx = 0, hz = 0, hidden = false;
      outer: for (let i = this.pathI; i < this.path.length && acc < 30; i++) {
        const wp = this.path[i]!;
        const seg = Math.hypot(wp.x - px, wp.z - pz);
        const n = Math.max(1, Math.ceil(seg / 1.5));
        for (let k = 1; k <= n; k++) {
          const f = k / n;
          const sx = lerp(px, wp.x, f), sy = lerp(py, wp.y, f), sz = lerp(pz, wp.z, f);
          if (this.los(me.pos.x, ey, me.pos.z, sx, sy + 1.45, sz)) {
            lx = sx; ly = sy; lz = sz; found = true;
          } else {
            hx = sx; hz = sz; hidden = true;
            break outer;
          }
        }
        acc += seg;
        px = wp.x; py = wp.y; pz = wp.z;
      }
      if (found && Math.hypot(lx - me.pos.x, lz - me.pos.z) >= 3.5) {
        this.lookAtPoint(lx, ly + 1.45, lz);
      } else {
        const yaw = hidden ? yawTo(me.pos.x, me.pos.z, hx, hz) : found ? yawTo(me.pos.x, me.pos.z, lx, lz) : this.aimYaw;
        this.lookYaw = this.openYawNear(yaw);
        this.lookPitch = 0;
      }
      // Check a side angle now and then, like a player clearing a room.
      if (now >= this.nextGlance && this.mode === 'move') {
        this.nextGlance = now + lerp(5, 2.2, this.skill) + rng.next() * 2;
        this.updateFan();
        let pick = -1, n = 0;
        for (let i = 0; i < FAN; i++) {
          if (this.fan[i]! < 9) continue;
          const off = Math.abs(angleDelta(this.lookYaw, (i / FAN) * TAU));
          if (off < 0.8 || off > 2.3) continue;
          if (rng.next() < 1 / ++n) pick = i;
        }
        if (pick >= 0) {
          this.glanceYaw = (pick / FAN) * TAU;
          this.glanceUntil = now + 0.3 + rng.next() * 0.2;
        }
      }
      return;
    }

    // 6. Nothing to do: never stare at a wall.
    this.lookYaw = this.openYawNear(this.lookYaw, 6);
    this.lookPitch = 0;
  }

  // ======================================================================================
  // movement primitives
  // ======================================================================================

  /** Convert a world-space move direction into forward/side input relative to the aim. */
  private steer(cmd: Cmd, mx: number, mz: number): void {
    const s = Math.sin(this.aimYaw), c = Math.cos(this.aimYaw);
    cmd.fwd = clamp(mx * -s + mz * -c, -1, 1);
    cmd.side = clamp(mx * c + mz * -s, -1, 1);
  }

  /** Counter-strafe: push against current velocity until nearly stopped. */
  private brake(cmd: Cmd): void {
    const me = this.me;
    const sp = Math.hypot(me.vel.x, me.vel.z);
    if (sp > 1.2) this.steer(cmd, -me.vel.x / sp, -me.vel.z / sp);
    else { cmd.fwd = 0; cmd.side = 0; }
  }

  private followPath(cmd: Cmd): boolean {
    const me = this.me, now = this.sim.time;
    while (this.pathI < this.path.length && this.distTo(this.path[this.pathI]!) < 0.5) this.pathI++;
    // Shoved past a waypoint: do not walk back for it.
    if (this.pathI + 1 < this.path.length) {
      const a = this.path[this.pathI]!, b = this.path[this.pathI + 1]!;
      if (this.distTo(b) < Math.hypot(a.x - b.x, a.z - b.z) && Math.abs(b.y - me.pos.y) < 0.6 && this.distTo(a) < 1.5) this.pathI++;
    }
    if (this.pathI >= this.path.length) {
      if (this.goal && this.distTo(this.goal) > 1.4 && now - this.lastRepath > 0.5) this.setGoal(this.goal, true);
      return this.pathI < this.path.length;
    }
    const wp = this.path[this.pathI]!;
    let mx = wp.x - me.pos.x, mz = wp.z - me.pos.z;
    const d = Math.hypot(mx, mz) || 1;
    mx /= d; mz /= d;
    // Keep off teammates' heels.
    for (const p of this.sim.players) {
      if (p === me || !p.alive || p.team !== me.team) continue;
      const ox = me.pos.x - p.pos.x, oz = me.pos.z - p.pos.z;
      const od = Math.hypot(ox, oz);
      if (od < 1.25 && od > 0.01 && Math.abs(p.pos.y - me.pos.y) < 1.5) {
        const push = (1.25 - od) * 1.6;
        mx += (ox / od) * push;
        mz += (oz / od) * push;
      }
    }
    if (now < this.shoveUntil) {
      mx += -mz * this.shoveDir * 0.9;
      mz += mx * this.shoveDir * 0.9;
    }
    this.steer(cmd, mx, mz);

    // Stuck: hop, sidestep, replan, and finally give the spot up.
    if (now >= this.stuckCheckAt) {
      const moved = Math.hypot(me.pos.x - this.stuckX, me.pos.z - this.stuckZ);
      if (this.stuckCheckAt > 0 && moved < 0.22) {
        this.stuckCount++;
        this.hopAt = now;
        this.shoveDir = this.sim.rng.next() < 0.5 ? -1 : 1;
        this.shoveUntil = now + 0.4;
        if (this.stuckCount >= 2 && this.goal) this.setGoal(this.goal, true);
        if (this.stuckCount >= 5) {
          this.spot = null;
          this.coverSpot = null;
          this.board().claims.delete(me.id);
          this.setGoal(null);
          this.stuckCount = 0;
          this.nextDecide = 0;
        }
      } else if (moved > 1) this.stuckCount = 0;
      this.stuckX = me.pos.x;
      this.stuckZ = me.pos.z;
      this.stuckCheckAt = now + 0.6;
    }
    if (now - this.hopAt < 0.05) cmd.buttons |= BTN_JUMP;
    return true;
  }

  // ======================================================================================
  // shooting
  // ======================================================================================

  private combat(cmd: Cmd, tgt: Player, moveLocked: boolean): void {
    const sim = this.sim, me = this.me, now = sim.time, rng = sim.rng;
    const w = me.weapons[me.active]!;
    const def = w.def;
    const dist = Math.hypot(tgt.pos.x - me.pos.x, tgt.pos.z - me.pos.z);
    const skill = this.skill;

    const idealYaw = yawTo(me.pos.x, me.pos.z, tgt.pos.x, tgt.pos.z);
    // "On target" means the crosshair has settled where the bot is trying to put it. The bot
    // cannot see its own aiming error, so misses at range happen exactly as they do for people.
    const tol = clamp(0.2 / Math.max(1, dist), 0.006, 0.2);
    const aligned =
      Math.abs(angleDelta(this.aimYaw, this.wantYaw)) < tol && Math.abs(this.aimPitch - this.wantPitch) < tol * 1.5;

    if (def.kind === 'knife') {
      if (dist < 1.8 && aligned) {
        // A stab when it will kill or comes from behind and is in reach; a slash otherwise.
        const behind = ((tgt.pos.x - me.pos.x) * -Math.sin(tgt.yaw) + (tgt.pos.z - me.pos.z) * -Math.cos(tgt.yaw)) / Math.max(dist, 0.1) > 0.475;
        cmd.buttons |= dist < 1.15 && (behind || tgt.hp <= 55) ? BTN_ALT : BTN_FIRE;
      }
      if (!moveLocked) this.steer(cmd, -Math.sin(idealYaw), -Math.cos(idealYaw));
      return;
    }

    const close = dist < (def.kind === 'shotgun' ? 10 : 6.5);
    if (def.kind === 'sniper') this.scopeTo(cmd, dist > 4.5 && me.reloadTimer <= 0 && me.drawTimer <= 0 ? 1 : 0);
    // Fire only when the gun is accurate enough to hit at this range (worse players spray anyway).
    const need = Math.max(def.spreadStand * 2.5, 0.42 / Math.max(1, dist)) * lerp(3.2, 1, skill);
    const okSpread = close || sim.spreadOf(me) <= need;
    const ready = w.mag > 0 && me.reloadTimer <= 0 && me.drawTimer <= 0 && now >= this.reactAt;
    let firing = false;

    if (def.auto) {
      const discipline = lerp(2.4, 1, skill);
      const maxBurst = close ? 99 : Math.round((dist < 12 ? 9 : dist < 22 ? 5 : 2.5) * discipline);
      if (this.bursting) {
        if (me.recoilIdx >= maxBurst) {
          this.bursting = false;
          this.pauseUntil = now + 0.12 + rng.next() * 0.12;
          this.strafe = rng.next() < 0.5 ? -1 : 1;
        }
      } else if (now >= this.pauseUntil && me.recoilIdx < 0.8) {
        this.bursting = true; // recoil has reset: next burst
      }
      firing = this.bursting;
      if (firing && ready && aligned && okSpread) cmd.buttons |= BTN_FIRE;
    } else {
      firing = true;
      if (ready && aligned && okSpread && !this.fireHeld && now >= this.nextClick) {
        cmd.buttons |= BTN_FIRE;
        this.fireHeld = true;
        this.nextClick = now + 60 / def.rpm + lerp(0.17, 0.03, skill) + rng.next() * 0.07;
      } else {
        this.fireHeld = false;
      }
    }

    if (moveLocked) return;
    if (close) {
      // Close quarters: never stand still. Strafe, and give ground if they are on top of us.
      if (now >= this.strafeUntil) {
        this.strafe = -this.strafe;
        this.strafeUntil = now + 0.3 + rng.next() * 0.45;
      }
      const c = Math.cos(this.aimYaw), s = Math.sin(this.aimYaw);
      let mx = c * this.strafe, mz = -s * this.strafe;
      if (dist < 2.6) { mx += s * 0.8; mz += c * 0.8; }
      this.steer(cmd, mx, mz);
      return;
    }
    if (firing || skill < 0.35 || now < this.reactAt) {
      // Stop dead to shoot.
      this.brake(cmd);
      if (def.auto && this.crouchy && this.bursting && me.recoilIdx > 2.5 && dist < 24) cmd.buttons |= BTN_CROUCH;
    } else {
      // Recoil is resetting: sidestep so the return fire misses.
      const c = Math.cos(this.aimYaw), s = Math.sin(this.aimYaw);
      this.steer(cmd, c * this.strafe, -s * this.strafe);
    }
  }

  /** Tap the scope button until the scope is at `level` (it steps 0, 1, 2, 0 on each press). */
  private scopeTo(cmd: Cmd, level: 0 | 1): void {
    const me = this.me;
    if (me.scope === level || me.rescope > 0) { this.altHeld = false; return; }
    if (this.altHeld) { this.altHeld = false; return; }
    cmd.buttons |= BTN_ALT;
    this.altHeld = true;
  }

  // ======================================================================================
  // per tick
  // ======================================================================================

  think(cmd: Cmd): void {
    const sim = this.sim, me = this.me, now = sim.time, rng = sim.rng;
    cmd.fwd = 0; cmd.side = 0; cmd.buttons = 0; cmd.slot = -1; cmd.buy = '';
    cmd.yaw = this.aimYaw; cmd.pitch = this.aimPitch;
    if (!me.alive) {
      this.visible = false;
      return;
    }

    if (!this.bought && sim.phase === 'freeze' && now >= this.buyAt) this.buy();
    this.feelDamage();
    if (now >= this.nextSense) { this.nextSense = now + 0.085; this.sense(); }
    if (now >= this.nextDecide) { this.nextDecide = now + 0.2; this.decide(); }

    let tgt = this.visible && this.target >= 0 ? sim.players[this.target]! : null;
    if (tgt && !tgt.alive) {
      tgt = null;
      this.visible = false;
      this.killAt = now;
      this.lostAt = now;
      this.nextSense = now; // look for the next one immediately
    }
    const w = me.weapons[me.active]!;
    const def = w.def;
    const dist = tgt ? Math.hypot(tgt.pos.x - me.pos.x, tgt.pos.z - me.pos.z) : 0;

    // ---- grenades: a fight (or a throw that will not come right) beats a throw ----
    if (this.throwing && (tgt || now - this.throwing.since > 4)) this.throwing = null;
    if (!this.throwing && !tgt && now >= this.nadeCheckAt) {
      this.nadeCheckAt = now + 0.7;
      this.planNade();
    }
    const throwing = this.throwing;

    // ---- weapon handling ----
    const prim = me.weapons[0], sec = me.weapons[1];
    const primAmmo = !!prim && (prim.mag > 0 || prim.reserve > 0);
    const secAmmo = !!sec && (sec.mag > 0 || sec.reserve > 0);
    if (throwing) { /* (the grenade's own slot: see throwStep) */ }
    else if (me.active === 0 && prim && prim.mag === 0 && tgt && dist < 16 && sec && sec.mag > 0) cmd.slot = 1; // faster than reloading
    else if (me.active !== 0 && prim && (prim.mag > 0 || (!tgt && primAmmo))) { if (!tgt || me.active === 2 || !sec || sec.mag === 0) cmd.slot = 0; }
    else if (me.active === 2 && secAmmo) cmd.slot = 1;
    else if (me.active !== 2 && !primAmmo && !secAmmo) cmd.slot = 2;
    const calm = !tgt && now - this.lastSeenAt > 2.5 && !this.threat(2.5, 12);
    if (def.kind === 'sniper' && !tgt && now - this.lastSeenAt > 1.2) this.scopeTo(cmd, 0);
    if (!throwing && def.magSize > 0 && me.reloadTimer <= 0 && w.reserve > 0 && (w.mag === 0 || (calm && w.mag < def.magSize * 0.55))) {
      cmd.buttons |= BTN_RELOAD;
    }

    // ---- aim ----
    if (!tgt && now >= this.nextLook) {
      this.nextLook = now + 0.12;
      this.updateLook();
    }
    let wantYaw = this.lookYaw, wantPitch = this.lookPitch;
    if (throwing) { wantYaw = throwing.yaw; wantPitch = throwing.pitch; }
    else if (!tgt && now < this.awayUntil) { wantYaw = this.awayYaw; wantPitch = 0; }
    if (tgt) {
      if (now > this.errUntil) {
        // Human aim wobbles; fresh acquisitions and strafing targets are harder.
        const lateral = Math.abs(tgt.vel.x * Math.cos(this.aimYaw) - tgt.vel.z * Math.sin(this.aimYaw));
        let mag = lerp(0.06, 0.007, this.skill) * (1 + lateral * 0.12);
        // The first moments on a new target are the least precise; aim tightens as it settles.
        mag *= 1 + 1.3 * Math.exp(-(now - this.acquiredAt) / 0.45);
        this.errYaw = (rng.next() - 0.5) * 2 * mag;
        this.errPitch = (rng.next() - 0.5) * 2 * mag * 0.7;
        this.errUntil = now + 0.22 + rng.next() * 0.25;
      }
      // Aim between chest and head; better bots favour the head.
      const s = 1 - 0.25 * tgt.crouchT;
      const aimH = lerp(1.2 * s, eyeHeight(tgt) + 0.03, 0.25 + this.skill * 0.6);
      const comp = lerp(0.3, 0.92, this.skill);
      wantYaw = yawTo(me.pos.x, me.pos.z, tgt.pos.x, tgt.pos.z) + this.errYaw - me.punchYaw * comp;
      wantPitch = Math.atan2(tgt.pos.y + aimH - this.eye(), Math.max(0.5, dist)) + this.errPitch - me.punchPitch * comp;
    }
    this.wantYaw = wantYaw;
    this.wantPitch = wantPitch;
    const turn = lerp(4.5, 13, this.skill) * (tgt ? 1 : 0.6) * (1 / 64);
    const gain = tgt ? 0.24 : 0.13;
    this.aimYaw = wrapAngle(this.aimYaw + clamp(angleDelta(this.aimYaw, wantYaw) * gain, -turn, turn));
    this.aimPitch = clamp(this.aimPitch + clamp((wantPitch - this.aimPitch) * gain, -turn, turn), -1.4, 1.4);
    cmd.yaw = this.aimYaw;
    cmd.pitch = this.aimPitch;

    // ---- act ----
    if (this.wantsUse) {
      cmd.buttons |= BTN_USE;
      return;
    }
    if (sim.phase === 'freeze' || this.mode === 'wait') return;

    // Standing in fire: out of it, whatever else is going on.
    const burning = sim.fireAt(me.pos.x, me.pos.y, me.pos.z, 0.5);
    if (burning) {
      if (tgt) this.combat(cmd, tgt, true);
      const dx = me.pos.x - burning.pos.x, dz = me.pos.z - burning.pos.z, d = Math.hypot(dx, dz) || 1;
      this.steer(cmd, dx / d, dz / d);
      return;
    }
    if (throwing && !tgt) {
      // (stood still to throw: the aim was worked out from here, standing)
      this.throwStep(cmd);
      this.brake(cmd);
      return;
    }

    const engaged = !!tgt;
    const running = this.mode === 'cover' || this.mode === 'save' || (this.mode === 'move' && this.hurry && me.hasCharge && !!tgt && dist > 25);
    if (engaged && !running) {
      this.combat(cmd, tgt!, false);
      return;
    }
    if (engaged) this.combat(cmd, tgt!, true);

    // Hold the angle for a moment after losing sight instead of running into it.
    if (!engaged && this.target >= 0 && now - this.lostAt < 0.9 && this.mode !== 'cover' && this.mode !== 'save' && !this.hurry) {
      this.brake(cmd);
      return;
    }
    if (this.mode === 'fight') {
      this.brake(cmd);
      return;
    }

    const moving = this.followPath(cmd);
    if (moving) {
      if (this.walk && !this.hurry) cmd.buttons |= BTN_WALK;
    } else {
      this.stuckCheckAt = 0;
      this.brake(cmd);
      // Settled in a hold: some players like to crouch behind cover.
      if ((this.mode === 'hold' || this.mode === 'guard') && this.crouchy && this.threat(4, 25)) cmd.buttons |= BTN_CROUCH;
    }
  }
}

/** Hand out a plan to every bot at the start of a round. */
export function assignRoles(sim: Sim): void {
  const rng = sim.rng;
  const map = sim.map;
  const T = tac(sim);
  T.boards[0].reset();
  T.boards[1].reset();
  const bots = T.bots.filter((b) => b.me.isBot);
  const attackers: Bot[] = [];
  const defenders: Bot[] = [];
  for (const bot of bots) {
    bot.reset();
    bot.holdPos = null;
    bot.holdLook = null;
    bot.route = [];
    bot.startDelay = 0;
    (bot.me.team === ATK ? attackers : defenders).push(bot);
  }
  const shuffle = <X>(a: X[]): void => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = a[i]!; a[i] = a[j]!; a[j] = t;
    }
  };

  // ---- attack: one site, a main route and (with enough players) a second prong ----
  const attackSite = rng.int(2);
  T.boards[ATK].site = attackSite;
  const siteRoutes = map.routes.filter((r) => r.site === attackSite);
  shuffle(siteRoutes);
  const main = siteRoutes[0]!;
  const alt = siteRoutes[1] ?? main;
  shuffle(attackers);
  attackers.forEach((bot, i) => {
    const split = attackers.length >= 3 && i === attackers.length - 1 && rng.next() < 0.6;
    bot.planRoute(split ? alt : main, i);
  });

  // ---- defence: cover both sites, spare player watches mid ----
  shuffle(defenders);
  const n = defenders.length;
  const lone = rng.int(3); // a lone defender gambles on a site or sits in the middle
  const slots = n === 1 ? [lone] : n === 2 ? [0, 1] : n === 3 ? [0, 1, 2] : n === 4 ? [0, 1, rng.int(2), 2] : [0, 1, 0, 1, 2];
  const used = [0, 0, 0];
  defenders.forEach((bot, i) => {
    const slot = slots[i % slots.length]!;
    if (slot === 2) bot.planMid(used[2]!++);
    else bot.pickHold(slot, used[slot]!++); // each site-mate watches a different entrance: a crossfire
  });

}
