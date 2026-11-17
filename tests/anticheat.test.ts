import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/game';
import { BTN_FIRE, SLOTS, emptyCmd, type Player } from '../src/sim/types';
import { RULES_1V1, SLOT_FIELDS, encodePlayer, takeSnapshot } from '../src/net/protocol';
import { Monitor } from '../server/anticheat';

const DEG = Math.PI / 180;

/** Small deterministic noise source (the tests must not depend on Math.random). */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

interface Aim { yaw: number; pitch: number; fire: boolean }

/**
 * A duel on the mid lane: `me` stands still with a rifle, the opponent strafes across the lane
 * 8 m away, turning round every three quarters of a second, and cannot be killed. `me` is
 * driven by an aiming policy, exactly as a client would drive it (one command a tick, seeing
 * the opponent `DELAY` ticks late), and a Monitor watches.
 */
const DELAY = 6;
function bench(strafe = true) {
  const sim = new Sim({ teamSize: 1, bots: false, rules: { ...RULES_1V1, freezeTime: 0.02, roundTime: 9999 } });
  const me = sim.players[0]!, foe = sim.players[1]!;
  const cmds = [emptyCmd(), emptyCmd()];
  const quiet = (n: number): void => { for (let i = 0; i < n; i++) { sim.tick((p) => cmds[p.id]!); sim.events.length = 0; } };
  quiet(4);
  me.pos.x = 0; me.pos.z = 20; me.pos.y = 0.002;
  foe.pos.x = -2.4; foe.pos.z = 12; foe.pos.y = 0.002;
  me.money = 9000;
  sim.phase = 'freeze';
  sim.tryBuy(me, 'hammerhead');
  sim.phase = 'live';
  quiet(64);
  const mon = new Monitor();
  const past = { x: 0, y: 0, z: 0, crouchT: 0 };
  let seq = 0, n = 0, hits = 0;
  /** The angles from my eye to a point `height` up the opponent, where my screen shows them. */
  const sight = (height: number): { yaw: number; pitch: number } => {
    sim.posAgo(foe.id, DELAY - 1, past);
    const dx = past.x - me.pos.x, dz = past.z - me.pos.z;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(past.y + height - (me.pos.y + 1.63), Math.hypot(dx, dz)) };
  };
  const run = (ticks: number, aim: (t: number) => Aim, refill = true): void => {
    for (let t = 0; t < ticks; t++) {
      if (strafe) { cmds[1]!.yaw = -Math.PI / 2; cmds[1]!.fwd = Math.floor(n / 48) % 2 === 0 ? 1 : -1; }
      foe.hp = 1e6;
      const a = aim(t);
      if (refill && !a.fire) me.weapons[0]!.mag = 30;
      Object.assign(cmds[0]!, { yaw: a.yaw, pitch: a.pitch, buttons: a.fire ? BTN_FIRE : 0, seq: ++seq, lag: DELAY });
      sim.tick((p) => cmds[p.id]!);
      for (const e of sim.events) if (e.type === 'hit' && e.attacker === me.id) hits++;
      mon.observe(sim, me, cmds[0]!, true, DELAY, sim.events);
      sim.events.length = 0;
      n++;
    }
  };
  return { sim, me, foe, mon, sight, run, hits: () => hits };
}

describe('anti-cheat: what a program does', () => {
  it('the test range is sound: the opponent is in view and really strafes', () => {
    const { sim, me, foe, run, sight } = bench();
    let lo = Infinity, hi = -Infinity;
    run(200, () => {
      lo = Math.min(lo, foe.pos.x); hi = Math.max(hi, foe.pos.x);
      expect(sim.world.lineOfSight(me.pos.x, me.pos.y + 1.63, me.pos.z, foe.pos.x, foe.pos.y + 1.3, foe.pos.z)).toBe(true);
      return { ...sight(1.3), fire: false };
    });
    expect(hi - lo).toBeGreaterThan(2.5);
  });

  it('removes an aim-lock: glued to a strafing head through every change of direction', () => {
    const { me, mon, sight, run, hits } = bench();
    run(64 * 14, () => {
      const s = sight(1.69);
      return { yaw: s.yaw - me.punchYaw, pitch: s.pitch - me.punchPitch, fire: true };
    });
    expect(hits()).toBeGreaterThan(40);
    expect(mon.strikes.lock).toBeGreaterThanOrEqual(3);
    expect(mon.verdict()).toBe('lock');
  });

  it('removes a snap-bot: on to the chest in two ticks, dead stop, shot', () => {
    const { mon, sight, run, hits } = bench();
    let from = { yaw: 0, pitch: 0 }, to = { yaw: 0, pitch: 0 };
    run(64 * 10, (t) => {
      const k = t % 64;
      const s = sight(1.3);
      const away = { yaw: s.yaw + 28 * DEG, pitch: s.pitch + 4 * DEG };
      if (k < 30) return { ...away, fire: false };
      if (k === 30) { from = away; to = s; return { yaw: (from.yaw + to.yaw) / 2, pitch: (from.pitch + to.pitch) / 2, fire: false }; }
      if (k === 31) { to = s; return { ...to, fire: false }; }
      if (k <= 37) return { ...to, fire: k === 32 };
      // ...and drifts off again, smoothly.
      const u = Math.min(1, (k - 37) / 20), e = u * u * (3 - 2 * u);
      return { yaw: to.yaw + (away.yaw - to.yaw) * e, pitch: to.pitch + (away.pitch - to.pitch) * e, fire: false };
    });
    expect(hits()).toBeGreaterThanOrEqual(8);
    expect(mon.verdict()).toBe('snap');
  });

  it('removes silent aim: on the target for the tick of the shot only', () => {
    const { mon, sight, run, hits } = bench();
    run(64 * 4, (t) => {
      const s = sight(1.3);
      return t % 32 === 20 ? { ...s, fire: true } : { yaw: s.yaw + 30 * DEG, pitch: s.pitch, fire: false };
    });
    expect(hits()).toBeGreaterThanOrEqual(3);
    expect(mon.verdict()).toBe('flickback');
  });

  it('removes a spin-bot that still lands hits', () => {
    const { mon, sight, run, hits } = bench();
    run(64 * 6, (t) => {
      const s = sight(1.3);
      return t % 16 === 8 ? { ...s, fire: true } : { yaw: t * 40 * DEG, pitch: -1.2, fire: false };
    });
    expect(hits()).toBeGreaterThanOrEqual(3);
    expect(mon.strikes.spin).toBeGreaterThanOrEqual(3);
    expect(mon.verdict()).not.toBeNull();
  });

  it('removes a recoil script: every spray cancelled exactly', () => {
    const { me, mon, sight, run } = bench(false);
    const base = sight(1.3);
    for (let spray = 0; spray < 6; spray++) {
      run(100, () => ({ yaw: base.yaw - me.punchYaw, pitch: base.pitch - me.punchPitch, fire: true }), false);
      run(70, () => ({ ...base, fire: false }));
    }
    expect(mon.strikes.recoil).toBeGreaterThanOrEqual(4);
    expect(mon.verdict()).toBe('recoil');
  });

  it('removes a sped-up client, and forgives a burst after a network stall', () => {
    const fast = new Monitor();
    for (let t = 0, i = 0; t < 45; i++, t = i / 96) fast.received(100 + t);
    expect(fast.verdict()).toBe('timer');

    const stalled = new Monitor();
    let t = 100;
    for (let i = 0; i < 64 * 8; i++) stalled.received((t += 1 / 64));
    t += 3.5; // nothing gets through for three and a half seconds...
    for (let i = 0; i < 64 * 3.5; i++) stalled.received(t); // ...then all of it at once
    for (let i = 0; i < 64 * 40; i++) stalled.received((t += 1 / 64));
    expect(stalled.verdict()).toBeNull();
    expect(stalled.strikes.timer).toBe(0);
  });

  it('removes a client that keeps sending what the game cannot send', () => {
    const m = new Monitor();
    for (let i = 0; i < 7; i++) m.violation('a command outside what the game can send');
    expect(m.verdict()).toBeNull();
    m.violation('a command outside what the game can send');
    expect(m.verdict()).toBe('protocol');
  });
});

describe('anti-cheat: what a person does', () => {
  it('leaves a strong human player alone: tracking, flicks, bursts and pulled-down sprays', () => {
    const { me, mon, sight, run, hits } = bench();
    const rnd = noise(7);
    // A hand: sees the target late, leads it by its speed, wobbles, and overshoots a change of
    // direction until it has reacted to it.
    const REACT = 11;
    const seen: { yaw: number; pitch: number }[] = [];
    let yaw = 0, pitch = 0, tremY = 0, tremP = 0, started = false;
    let flick: { from: number; fromP: number; t: number } | null = null;
    run(64 * 90, (t) => {
      seen.push(sight(1.35));
      const old = seen[Math.max(0, seen.length - 1 - REACT)]!, older = seen[Math.max(0, seen.length - 2 - REACT)]!;
      // Where the hand expects the target to be by now.
      const want = { yaw: old.yaw + (old.yaw - older.yaw) * (REACT + 3), pitch: old.pitch };
      if (!started) { yaw = want.yaw; pitch = want.pitch; started = true; }
      tremY += (rnd() * 0.5 * DEG - tremY) * 0.25;
      tremP += (rnd() * 0.4 * DEG - tremP) * 0.25;
      const cycle = t % 256;
      if (cycle === 0) flick = null;
      let fire = false;
      if (cycle >= 150 && cycle < 200) {
        // Looks away to check a corner...
        yaw += (want.yaw + 32 * DEG - yaw) * 0.12;
        pitch += (want.pitch + 3 * DEG - pitch) * 0.12;
      } else if (cycle >= 200 && cycle < 211) {
        // ...and flicks back: fast in the middle, slowing into the target, and never quite on it.
        flick ??= { from: yaw, fromP: pitch, t: 0 };
        const u = ++flick.t / 11, e = u * u * u * (10 - 15 * u + 6 * u * u);
        const miss = 1 + rnd() * 0.12;
        yaw = flick.from + (want.yaw - flick.from) * e * miss;
        pitch = flick.fromP + (want.pitch - flick.fromP) * e;
        fire = cycle === 210;
      } else {
        yaw += (want.yaw - yaw) * 0.22;
        pitch += (want.pitch - pitch) * 0.22;
        // Bursts and the odd long spray, pulling down against most of the climb.
        fire = cycle < 150 ? cycle % 40 < (cycle < 80 ? 9 : 26) : cycle < 216;
      }
      const pull = 0.78 + rnd() * 0.1;
      return { yaw: yaw + tremY - me.punchYaw * pull, pitch: pitch + tremP - me.punchPitch * pull, fire };
    });
    // A player good enough to matter...
    expect(hits()).toBeGreaterThan(100);
    // ...and nothing held against them.
    expect(mon.notes).toEqual([]);
    expect(mon.total).toBe(0);
    expect(mon.verdict()).toBeNull();
  });

  it('does not mistake a low frame rate for a snap: the same aim sent for several ticks running', () => {
    const { mon, sight, run } = bench();
    let held = { yaw: 0, pitch: 0 };
    // 21 frames a second: three ticks to a frame, and a fast flick is only three frames long.
    run(64 * 60, (t) => {
      const cycle = t % 96;
      if (t % 3 === 0) {
        const s = sight(1.35);
        const u = cycle < 60 ? 0 : cycle < 69 ? (cycle - 60) / 9 : 1;
        const e = u * u * (3 - 2 * u);
        // (a flick this size ends a degree or so out, either way)
        held = { yaw: s.yaw + 30 * DEG * (1 - e) + 1.5 * DEG * Math.sin(t), pitch: s.pitch + 0.6 * DEG * Math.cos(t * 1.7) };
      }
      return { ...held, fire: cycle >= 69 && cycle < 75 };
    });
    expect(mon.verdict()).toBeNull();
    expect(mon.strikes.snap).toBe(0);
    expect(mon.strikes.flickback).toBe(0);
  });
});

describe('anti-cheat: what a client is told', () => {
  it('an enemy in view is sent without health, armour, money, ammunition or the rest of their kit', () => {
    const sim = new Sim({ teamSize: 1, bots: false, rules: { ...RULES_1V1, freezeTime: 0.02 } });
    const a = sim.players[0]!, b = sim.players[1]! as Player;
    b.hp = 37; b.armor = 61; b.helmet = true; b.money = 4321;
    b.weapons[b.active]!.mag = 3; b.weapons[b.active]!.reserve = 17;
    const full = encodePlayer(b);
    const told = takeSnapshot(sim, [0, 0], [], [false, false], a).p[1]!;
    expect(told.length).toBe(full.length);
    expect(told.slice(2, 7)).toEqual([100, 0, 0, 0, 0]);
    expect(JSON.stringify(told)).not.toContain('4321');
    const kit = told.slice(-SLOTS * SLOT_FIELDS);
    for (let s = 0; s < 3; s++) {
      expect(kit[s * SLOT_FIELDS], `slot ${s}`).toBe(s === b.active ? full[full.length - SLOTS * SLOT_FIELDS + s * SLOT_FIELDS] : -1);
      expect(kit[s * SLOT_FIELDS + 1]).toBe(0);
      expect(kit[s * SLOT_FIELDS + 2]).toBe(0);
    }
    // Where they are is still told: that much can be seen.
    expect(told.slice(10, 13)).toEqual(full.slice(10, 13));
    // The player's own state, and everything once they are dead and watching, is whole.
    expect(takeSnapshot(sim, [0, 0], [], [false, false], a).p[0]).toEqual(encodePlayer(a));
    a.alive = false;
    expect(takeSnapshot(sim, [0, 0], [], [false, false], a).p[1]).toEqual(full);
  });
});
