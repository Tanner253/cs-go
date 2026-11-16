// Server-side cheat detection.
//
// The server already decides everything that matters (movement, hits, money, bullet spread)
// and never tells a client where an enemy it cannot see is, so most cheats have nothing to
// work with. What is left is a client that *aims* or *times its input* by machine. Nothing in
// a browser can be trusted to police that, so it is judged here, from the only thing a client
// can send: its stream of commands.
//
// Every detector looks for something a hand on a mouse cannot do, and removes a player only
// when it has happened repeatedly:
//
//   snap       the aim arrives on a target at speed, stops dead exactly on its centre, and hits
//   flickback  the aim jumps onto a target for the one tick of the shot and back again
//   lock       the aim stays glued to the centre of a moving target through a change of direction
//   recoil     a spray's recoil is cancelled to the hundredth of a degree
//   spin       the view spins faster than a wrist can turn while still landing hits
//   timer      commands arrive faster than real time (a sped-up client)
//   protocol   messages no honest client produces

import type { Sim } from '../src/sim/game';
import { eyeHeight } from '../src/sim/movement';
import { EYE_CROUCH, EYE_STAND, HIT_PLAYER, TICK, TICK_RATE, type Cmd, type Player, type SimEvent } from '../src/sim/types';
import { WEAPONS } from '../src/sim/weapons';

const DEG = Math.PI / 180;

export type Kind = 'snap' | 'flickback' | 'lock' | 'recoil' | 'spin' | 'timer' | 'protocol';

/** Aim samples remembered (ticks). */
const RING = 32;
/**
 * How precisely on a target's centre the aim must be to count as a machine's: within 0.3
 * degrees, or within a quarter of the chest's half-width where the target is too far away for
 * that to mean anything (any shot that hits at 40 m is within 0.3 degrees). Aim errors are
 * measured in this unit.
 */
const CENTRE = 0.3 * DEG;
const PRECISE = 1;
const LOCKED = 0.5;
/**
 * The client drew its target at the moment it says it did, give or take this many ticks (its
 * interpolation between snapshots is not exactly ours). Kept small: along a crossing target's
 * path, every tick of slack forgives eight centimetres of error.
 */
const DELAY_SLACK = 0.5;
const DELAY_STEP = 0.125;

const wrap = (a: number): number => {
  a = (a + Math.PI) % (Math.PI * 2);
  return (a < 0 ? a + Math.PI * 2 : a) - Math.PI;
};

interface PendingShot { at: number }
interface Run { on: number; moving: number; turns: number; side: number; slow: number }

const past = { x: 0, y: 0, z: 0, crouchT: 0 };

export class Monitor {
  readonly strikes: Record<Kind, number> = { snap: 0, flickback: 0, lock: 0, recoil: 0, spin: 0, timer: 0, protocol: 0 };
  /** What was seen, newest last (for the server log). */
  readonly notes: string[] = [];

  // Aim, one sample per command the client really sent, in an unbroken run of sequence numbers.
  private yaws = new Float64Array(RING);
  private pitches = new Float64Array(RING);
  /** How far each sample's aim was from the centre of the nearest enemy in view (in units of CENTRE). */
  private errs = new Float32Array(RING).fill(Infinity);
  private n = 0;
  private chainFrom = 0;
  private lastSeq = -1;
  private pending: PendingShot[] = [];
  /** Hits that followed an abrupt arrival, and how many of those were dead centre. */
  private abruptHits = 0;
  private snaps = 0;

  private punchP = 0;
  private punchY = 0;
  private runs: Run[] = [];
  private lastHitTick = -9999;

  // The spray in progress: where the rounds were aimed, with and without the gun's recoil.
  private sprayGun = '';
  private sprayLast = -9999;
  private rawP: number[] = [];
  private effP: number[] = [];
  private effY: number[] = [];
  private spraysJudged = 0;

  private spun = new Uint8Array(64);
  private spunI = 0;
  private spunCount = 0;

  private cmdsInWindow = 0;
  private windowFrom = 0;

  private sep(i: number, j: number): number {
    const a = i % RING, b = j % RING;
    return Math.hypot(wrap(this.yaws[a]! - this.yaws[b]!) * Math.cos(this.pitches[a]!), this.pitches[a]! - this.pitches[b]!);
  }
  private has(i: number): boolean {
    return i >= this.chainFrom && i > this.n - RING && i < this.n;
  }
  private strike(kind: Kind, note: string): void {
    this.strikes[kind]++;
    this.notes.push(`${kind}: ${note}`);
    if (this.notes.length > 24) this.notes.shift();
  }

  /** A command arrived (wall-clock seconds): more than real time's worth, sustained, is a sped-up client. */
  received(now: number): void {
    if (this.windowFrom === 0) this.windowFrom = now;
    this.cmdsInWindow++;
    const span = now - this.windowFrom;
    if (span < 10) return;
    const rate = this.cmdsInWindow / span / TICK_RATE;
    // (a burst after a network stall can fill one window; a clean one takes the strike back)
    if (rate > 1.3) this.strike('timer', `${(rate * 100).toFixed(0)}% of real time over ${span.toFixed(1)} s`);
    else if (rate < 1.05 && this.strikes.timer > 0) this.strikes.timer--;
    this.cmdsInWindow = 0;
    this.windowFrom = now;
  }

  /** A message no honest client sends. */
  violation(what: string): void {
    this.strike('protocol', what);
  }

  /**
   * How far the aim is from the centre of `victim` as the shooter saw it: the smallest angle
   * to head, chest or hips over the delays the client may have been drawing it at, in units
   * of CENTRE (1 = as far off as still counts as dead centre).
   */
  private aimError(sim: Sim, me: Player, victim: number, delay: number, yaw: number, pitch: number): number {
    const ex = me.pos.x, ey = me.pos.y + eyeHeight(me), ez = me.pos.z;
    let best = Infinity;
    for (let back = Math.max(0, delay - DELAY_SLACK); back <= delay + DELAY_SLACK; back += DELAY_STEP) {
      sim.posAgo(victim, back, past);
      const dx = past.x - ex, dz = past.z - ez;
      const flat = Math.hypot(dx, dz);
      const dyaw = wrap(Math.atan2(-dx, -dz) - yaw);
      const s = 1 - 0.25 * past.crouchT;
      const head = EYE_STAND + (EYE_CROUCH - EYE_STAND) * past.crouchT + 0.06;
      const unit = Math.min(CENTRE, 0.25 * Math.atan2(0.26, flat));
      for (let k = 0; k < 3; k++) {
        const h = k === 0 ? head : k === 1 ? 1.3 * s : 0.95 * s;
        const to = Math.atan2(past.y + h - ey, flat);
        const err = Math.hypot(dyaw * Math.cos(to), to - pitch) / unit;
        if (err < best) best = err;
      }
    }
    return best;
  }

  /**
   * Look at one tick of one player, after the simulation has run it.
   *
   * @param cmd the command the tick was run with
   * @param fresh whether the client really sent it for this tick (false = the last one, held)
   * @param delay how many ticks ago the client was seeing its opponents when it sent it
   * @param events what happened in the tick
   */
  observe(sim: Sim, me: Player, cmd: Cmd, fresh: boolean, delay: number, events: SimEvent[]): void {
    const live = me.alive && (sim.phase === 'live' || sim.phase === 'planted');
    let shotWith = '';
    let victim = -1;
    for (const e of events) {
      if (e.type === 'shot' && e.player === me.id) shotWith = e.weapon;
      else if (e.type === 'hit' && e.attacker === me.id) { victim = e.victim; this.lastHitTick = sim.tickCount; }
    }

    // The aim the bullets left along, with and without the recoil the gun had built up.
    const effYaw = cmd.yaw + this.punchY, effPitch = cmd.pitch + this.punchP;

    if (fresh && me.alive) {
      if (cmd.seq !== this.lastSeq + 1) {
        // Commands were lost or dropped: what happened between them is unknown.
        this.chainFrom = this.n;
        this.pending.length = 0;
      }
      this.lastSeq = cmd.seq;
      this.yaws[this.n % RING] = cmd.yaw;
      this.pitches[this.n % RING] = cmd.pitch;
      const i = this.n++;

      // ---- spin -------------------------------------------------------------------------
      const turned = live && this.has(i - 1) && Math.abs(wrap(this.yaws[i % RING]! - this.yaws[(i - 1) % RING]!)) > 25 * DEG ? 1 : 0;
      this.spunCount += turned - this.spun[this.spunI]!;
      this.spun[this.spunI] = turned;
      this.spunI = (this.spunI + 1) % this.spun.length;
      if (this.spunCount >= 40 && sim.tickCount - this.lastHitTick < 96) {
        this.strike('spin', `${this.spunCount} of 64 ticks turning faster than 1600 deg/s while landing hits`);
        this.spun.fill(0);
        this.spunCount = 0;
      }

      // ---- lock ---------------------------------------------------------------------------
      let err = Infinity;
      for (const v of sim.players) {
        if (v.team === me.team) continue;
        const run = (this.runs[v.id] ??= { on: 0, moving: 0, turns: 0, side: 0, slow: 0 });
        if (!live || !v.alive) { run.on = run.moving = run.turns = run.side = run.slow = 0; continue; }
        err = Math.min(err, this.track(sim, me, v, run, delay, cmd.yaw, cmd.pitch, effYaw, effPitch));
      }

      // ---- a shot that hit: remember it, to judge once what the aim did next is known ------
      if (shotWith && victim >= 0 && WEAPONS[shotWith]!.pellets === 1) {
        err = Math.min(err, this.aimError(sim, me, victim, delay, cmd.yaw, cmd.pitch), this.aimError(sim, me, victim, delay, effYaw, effPitch));
        this.pending.push({ at: i });
      }
      this.errs[i % RING] = err;
      while (this.pending.length > 0 && this.pending[0]!.at + 4 < this.n) this.judgeShot(this.pending.shift()!);
    }

    // ---- recoil ---------------------------------------------------------------------------
    if (shotWith) {
      const def = WEAPONS[shotWith]!;
      const gap = Math.round((TICK_RATE * 60) / def.rpm) + 3;
      if (shotWith !== this.sprayGun || sim.tickCount - this.sprayLast > gap) this.judgeSpray();
      this.sprayGun = shotWith;
      this.sprayLast = sim.tickCount;
      if (def.auto && def.kind !== 'knife') {
        this.rawP.push(cmd.pitch);
        this.effP.push(effPitch);
        this.effY.push(effYaw);
      }
    } else if (this.rawP.length > 0 && sim.tickCount - this.sprayLast > 12) this.judgeSpray();

    this.punchP = me.punchPitch;
    this.punchY = me.punchYaw;
  }

  private judgeShot(shot: PendingShot): void {
    const i = shot.at;
    if (!this.has(i - 1) || !this.has(i + 2)) return;
    // Onto the target for the tick of the shot and straight back: "silent" aim.
    const jump = this.sep(i, i - 1);
    if (jump >= 8 * DEG && this.sep(i + 1, i - 1) <= 0.25 * jump) {
      this.strike('flickback', `${(jump / DEG).toFixed(1)} deg onto the target for one tick and back`);
      return;
    }
    // The last tick in which the aim moved, up to 6 ticks before the shot.
    let arrive = -1;
    for (let k = i; k > i - 6 && this.has(k - 1); k--) {
      if (this.sep(k, k - 1) >= 1 * DEG) { arrive = k; break; }
    }
    if (arrive < 0) return;
    const speed = this.sep(arrive, arrive - 1);
    if (speed < 6 * DEG) return;
    // ... and then nothing: no slowing down into the target, no settling afterwards.
    let after = 0;
    for (let k = arrive + 1; k <= arrive + 3 && this.has(k); k++) after += this.sep(k, k - 1);
    if (after > 1 * DEG) return;
    this.abruptHits++;
    // (where the aim stopped, not where the target had got to by the time the round left)
    const precise = this.errs[arrive % RING]! <= PRECISE;
    if (precise) this.snaps++;
    // A fast hand at a low frame rate arrives abruptly too, and now and then dead centre by
    // luck: it only counts once it is what usually happens.
    const counted = this.snaps >= 3 && this.snaps >= 0.4 * this.abruptHits ? this.snaps : 0;
    if (precise && counted > 0) {
      this.notes.push(`snap: arrived at ${((speed / DEG) * TICK_RATE).toFixed(0)} deg/s, stopped dead on centre and hit (${this.snaps} of ${this.abruptHits})`);
      if (this.notes.length > 24) this.notes.shift();
    }
    this.strikes.snap = counted;
  }

  /** Follow how closely the aim keeps to one enemy. Returns how far off its centre the aim is now. */
  private track(sim: Sim, me: Player, v: Player, run: Run, delay: number, yaw: number, pitch: number, effYaw: number, effPitch: number): number {
    const reset = (far = Infinity): number => { run.on = run.moving = run.turns = run.side = run.slow = 0; return far; };
    const dx = v.pos.x - me.pos.x, dz = v.pos.z - me.pos.z;
    const d = Math.hypot(dx, dz);
    const ey = me.pos.y + eyeHeight(me);
    if (d < 5 || d > 70 || !sim.world.lineOfSight(me.pos.x, ey, me.pos.z, v.pos.x, v.pos.y + 1.3, v.pos.z)) return reset();
    const err = Math.min(this.aimError(sim, me, v.id, delay, yaw, pitch), this.aimError(sim, me, v.id, delay, effYaw, effPitch));
    if (err > LOCKED) return reset(err);
    run.on++;
    // How fast the target is crossing the view, and which way.
    const across = (dx * v.vel.z - dz * v.vel.x) / d;
    if (Math.abs(across) >= 2 && Math.abs(across) / d >= 0.112) {
      const side = across > 0 ? 1 : -1;
      if (run.side !== 0 && side !== run.side) run.turns++;
      run.side = side;
      run.moving++;
      run.slow = 0;
    } else if (++run.slow > 32) return reset(err);
    if ((run.moving >= 40 && run.turns >= 1) || run.moving >= 128) {
      this.strike('lock', `within ${((LOCKED * CENTRE) / DEG).toFixed(2)} deg of a moving target's centre for ${run.on} ticks, ${run.turns} change(s) of direction`);
      reset();
    }
    return err;
  }

  private judgeSpray(): void {
    const n = this.rawP.length;
    if (n >= 10) {
      let lo = Infinity, hi = -Infinity;
      for (const p of this.rawP) { if (p < lo) lo = p; if (p > hi) hi = p; }
      // Only sprays whose recoil was being pulled against say anything.
      if (hi - lo >= 2 * DEG) {
        this.spraysJudged++;
        const spread = (a: number[]): number => {
          let m = 0;
          for (let i = 1; i < n; i++) m += a[i]!;
          m /= n - 1;
          let s = 0;
          for (let i = 1; i < n; i++) s += (a[i]! - m) ** 2;
          return s / (n - 1);
        };
        const level = Math.cos((lo + hi) / 2);
        const left = Math.sqrt(spread(this.effP) + spread(this.effY) * level * level);
        if (left <= 0.06 * DEG) this.strike('recoil', `${n} rounds, recoil of ${((hi - lo) / DEG).toFixed(1)} deg cancelled to ${(left / DEG).toFixed(3)} deg`);
      }
    }
    this.rawP.length = this.effP.length = this.effY.length = 0;
    this.sprayGun = '';
  }

  /** The kind of cheating this player is to be removed for, if any. */
  verdict(): Kind | null {
    const s = this.strikes;
    if (s.flickback >= 3) return 'flickback';
    if (s.snap >= 6) return 'snap';
    if (s.lock >= 3) return 'lock';
    if (s.recoil >= 4 && s.recoil >= 0.5 * this.spraysJudged) return 'recoil';
    if (s.spin >= 3) return 'spin';
    if (s.timer >= 3) return 'timer';
    if (s.protocol >= 8) return 'protocol';
    return null;
  }

  /** Total strikes, of any kind (a rise is worth a line in the log). */
  get total(): number {
    const s = this.strikes;
    return s.snap + s.flickback + s.lock + s.recoil + s.spin + s.timer + s.protocol;
  }
}

/** Is this tick within the delay a client may claim? (kept beside the detectors so the two agree) */
export const delayOf = (simTime: number, view: number): number => {
  if (!(view > 0)) return 0;
  const d = (simTime + TICK - view) / TICK;
  return d < 0 ? 0 : d > 40 ? 40 : d;
};
