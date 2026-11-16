// Client side of an online match (DOM-free, so it can be tested under Node).
// The local player is predicted every tick and re-simulated from each authoritative
// snapshot; the opponent is drawn slightly in the past, interpolated between snapshots.

import { Sim } from '../sim/game';
import { TICK, type Cmd, type Player, type SimEvent } from '../sim/types';
import { RULES_1V1, applySnapshot, isHidden, type ClientMsg, type Snapshot } from './protocol';

/** How far in the past remote players are drawn (seconds). */
export const INTERP_DELAY = 0.1;

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: number;
}

/** Events the client plays from its own prediction, so the server's copies are dropped. */
const PREDICTED = new Set<SimEvent['type']>([
  'shot', 'step', 'jump', 'land', 'walljump', 'mantle', 'grapple', 'grappleEnd', 'reload', 'dry', 'draw', 'scope', 'knife',
]);

export class Replica {
  readonly sim: Sim;
  readonly me: number;
  private pending: Cmd[] = [];
  private seq = 0;
  private samples: Sample[][] = [];
  private offset = NaN;
  /** Visual correction that decays to zero, hiding small prediction errors. */
  errX = 0;
  errY = 0;
  errZ = 0;
  snapshots = 0;
  lastSnapAt = 0;
  /** Per player id: the server is withholding this player's position (no line of sight). */
  readonly hidden: boolean[] = [];

  constructor(you: number, names: string[]) {
    this.me = you;
    this.sim = new Sim({ teamSize: 1, bots: false, names, rules: RULES_1V1 });
    this.sim.localId = you;
    this.sim.events.length = 0;
    for (let i = 0; i < this.sim.players.length; i++) this.samples.push([]);
  }

  get player(): Player {
    return this.sim.players[this.me]!;
  }

  /** Server time the opponent is currently being drawn at. */
  private viewTime(now: number): number {
    return Number.isNaN(this.offset) ? 0 : now + this.offset - INTERP_DELAY;
  }

  /**
   * Feed one tick of local input: predicts immediately and returns the message to send.
   * Predicted events are left in `sim.events` for the caller to present.
   */
  input(cmd: Cmd, now: number): ClientMsg {
    const sim = this.sim;
    cmd.seq = ++this.seq;
    cmd.lag = 0;
    const copy = { ...cmd };
    // Purchases are server-side only; do not replay them.
    copy.buy = '';
    this.pending.push(copy);
    if (this.pending.length > 128) this.pending.shift();
    sim.time += TICK;
    sim.predicting = true;
    sim.stepPlayer(this.player, copy);
    sim.predicting = false;
    return { t: 'c', q: cmd.seq, f: cmd.fwd, s: cmd.side, y: cmd.yaw, p: cmd.pitch, b: cmd.buttons, w: cmd.slot, u: cmd.buy, v: this.viewTime(now) };
  }

  /** Apply an authoritative snapshot. Returns the server events the client should present. */
  onSnapshot(s: Snapshot, now: number): SimEvent[] {
    const sim = this.sim;
    const me = this.player;
    const ox = me.pos.x, oy = me.pos.y, oz = me.pos.z;
    const hadEvents = sim.events.length;

    applySnapshot(sim, s);
    this.snapshots++;
    this.lastSnapAt = now;

    // Clock: track the server's timeline relative to ours.
    const off = s.t - now;
    this.offset = Number.isNaN(this.offset) || Math.abs(off - this.offset) > 0.5 ? off : this.offset + (off - this.offset) * 0.08;

    for (let i = 0; i < sim.players.length; i++) {
      if (i === this.me) continue;
      const p = sim.players[i]!;
      const buf = this.samples[i]!;
      const hid = isHidden(s.p[i]!);
      // Coming back into view must not be interpolated from where they were last seen.
      if (hid || this.hidden[i]) buf.length = 0;
      this.hidden[i] = hid;
      if (hid) continue;
      buf.push({ t: s.t, x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yaw, pitch: p.pitch, crouch: p.crouchT });
      if (buf.length > 40) buf.shift();
    }

    // Reconcile: rewind to the server's state and replay inputs it has not seen yet.
    const ack = s.a[this.me] ?? 0;
    let drop = 0;
    while (drop < this.pending.length && this.pending[drop]!.seq <= ack) drop++;
    if (drop > 0) this.pending.splice(0, drop);
    me.prevPos.x = me.pos.x; me.prevPos.y = me.pos.y; me.prevPos.z = me.pos.z;
    me.prevCrouchT = me.crouchT;
    sim.predicting = true;
    for (const c of this.pending) {
      sim.time += TICK;
      sim.stepPlayer(me, c);
    }
    sim.predicting = false;
    sim.events.length = hadEvents;

    const ex = ox - me.pos.x, ey = oy - me.pos.y, ez = oz - me.pos.z;
    const e2 = ex * ex + ey * ey + ez * ez;
    if (e2 > 4 || e2 < 1e-8) {
      // Teleport (respawn) or perfect agreement: no smoothing.
      if (e2 > 4) this.errX = this.errY = this.errZ = 0;
    } else {
      this.errX += ex; this.errY += ey; this.errZ += ez;
    }

    return s.e.filter((e) => !(PREDICTED.has(e.type) && (e as { player?: number }).player === this.me));
  }

  /** Per rendered frame: place remote players at their interpolated position. */
  frame(now: number, dt: number): void {
    const k = Math.exp(-dt * 14);
    this.errX *= k; this.errY *= k; this.errZ *= k;
    const t = this.viewTime(now);
    const sim = this.sim;
    for (let i = 0; i < sim.players.length; i++) {
      if (i === this.me) continue;
      const buf = this.samples[i]!;
      if (buf.length === 0) continue;
      const p = sim.players[i]!;
      let a = buf[0]!, b = buf[buf.length - 1]!;
      for (let j = buf.length - 1; j > 0; j--) {
        if (buf[j - 1]!.t <= t) { a = buf[j - 1]!; b = buf[j]!; break; }
      }
      let f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      // Allow a little extrapolation if snapshots are late; never rewind before the oldest.
      f = f < 0 ? 0 : f > 1.5 ? 1.5 : f;
      // A respawn or teleport must not be interpolated across.
      if (Math.abs(b.x - a.x) + Math.abs(b.z - a.z) > 6) f = f < 0.5 ? 0 : 1;
      p.pos.x = a.x + (b.x - a.x) * f;
      p.pos.y = a.y + (b.y - a.y) * f;
      p.pos.z = a.z + (b.z - a.z) * f;
      let dy = b.yaw - a.yaw;
      dy = ((dy + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      const g = f > 1 ? 1 : f;
      p.yaw = a.yaw + dy * g;
      p.pitch = a.pitch + (b.pitch - a.pitch) * g;
      p.crouchT = a.crouch + (b.crouch - a.crouch) * g;
      p.prevPos.x = p.pos.x; p.prevPos.y = p.pos.y; p.prevPos.z = p.pos.z;
      p.prevCrouchT = p.crouchT;
    }
  }
}
