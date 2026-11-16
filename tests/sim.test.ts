import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/game';
import { ATK, BTN_FIRE, BTN_GRAPPLE, BTN_JUMP, DEF, TICK, emptyCmd, type Cmd, type Player } from '../src/sim/types';
import { WEAPONS, patternAt } from '../src/sim/weapons';

/** A sim with one human and no opposition interfering: freeze time skipped. */
function soloSim(): { sim: Sim; me: Player; step: (cmd: Partial<Cmd>, ticks?: number) => void } {
  const sim = new Sim({ teamSize: 1, humanTeam: ATK, rules: { freezeTime: 0.02, roundTime: 9999 } });
  const me = sim.human!;
  const cmd = emptyCmd();
  const step = (c: Partial<Cmd>, ticks = 1) => {
    for (let i = 0; i < ticks; i++) {
      Object.assign(cmd, emptyCmd(), { yaw: me.yaw, pitch: me.pitch }, c);
      sim.tick((p) => (p === me ? cmd : null));
      sim.events.length = 0;
    }
  };
  // Park the lone enemy bot far away and make it harmless.
  const enemy = sim.players.find((p) => p.team === DEF)!;
  enemy.pos.x = 0; enemy.pos.z = -33;
  sim.bots.clear();
  enemy.isBot = false;
  step({}, 4);
  return { sim, me, step };
}

describe('navigation', () => {
  const sim = new Sim({ humanTeam: null });
  it('floods the playable ground', () => {
    expect(sim.nav.nodeCount).toBeGreaterThan(4000);
  });
  it('connects both spawns to both sites and every hold position', () => {
    const atk = sim.map.spawns[0][0]!;
    const def = sim.map.spawns[1][0]!;
    for (const site of sim.map.sites) {
      expect(sim.nav.findPath(atk, site.center), `atk -> ${site.name}`).not.toBeNull();
      expect(sim.nav.findPath(def, site.center), `def -> ${site.name}`).not.toBeNull();
      for (const h of site.holds) {
        const path = sim.nav.findPath(def, h.pos);
        expect(path, `def -> hold ${site.name}`).not.toBeNull();
        const end = path![path!.length - 1]!;
        expect(Math.hypot(end.x - h.pos.x, end.z - h.pos.z)).toBeLessThan(1);
        expect(Math.abs(end.y - h.pos.y)).toBeLessThan(0.3);
      }
    }
    for (const r of sim.map.routes) {
      let from = atk;
      for (const p of r.points) {
        expect(sim.nav.findPath(from, p), `route ${r.name}`).not.toBeNull();
        from = p;
      }
    }
  });
});

describe('movement', () => {
  it('reaches run speed, and stops quickly when keys are released (counter-strafe window)', () => {
    const { me, step } = soloSim();
    step({ fwd: 1 }, 64);
    const speed = Math.hypot(me.vel.x, me.vel.z);
    expect(speed).toBeGreaterThan(5.9);
    expect(speed).toBeLessThanOrEqual(6.11);
    // Counter-strafe: tapping the opposite key kills speed far faster than coasting.
    step({ fwd: -1 }, 7);
    expect(Math.hypot(me.vel.x, me.vel.z)).toBeLessThan(6.1 * 0.34);
    step({}, 24);
    expect(Math.hypot(me.vel.x, me.vel.z)).toBeLessThan(0.05);
  });

  it('jumps to roughly 1.45 m and lands again', () => {
    const { me, step } = soloSim();
    const y0 = me.pos.y;
    step({ buttons: BTN_JUMP });
    let apex = 0;
    for (let i = 0; i < 80; i++) {
      step({});
      apex = Math.max(apex, me.pos.y - y0);
    }
    expect(apex).toBeGreaterThan(1.35);
    expect(apex).toBeLessThan(1.55);
    expect(me.onGround).toBe(true);
    expect(Math.abs(me.pos.y - y0)).toBeLessThan(0.01);
  });

  it('never tunnels through walls at speed', () => {
    const { sim, me, step } = soloSim();
    me.vel.x = 60;
    step({ side: 1 }, 64);
    expect(me.pos.x).toBeLessThan(12);
    expect(sim.world.hullBlocked(me.pos.x, me.pos.y + 0.915, me.pos.z, 0.4, 0.915, 0.4)).toBe(false);
  });

  it('walks up steps onto the site deck', () => {
    const { me, step } = soloSim();
    me.pos.x = 22; me.pos.z = -20; me.pos.y = 0.002;
    me.yaw = -Math.PI / 2; // face +X
    step({ fwd: 1, yaw: me.yaw }, 90);
    expect(me.pos.y).toBeGreaterThan(0.75);
    expect(me.pos.x).toBeGreaterThan(25.5);
  });

  it('mantles onto a 2.2 m container when holding jump into it', () => {
    const { me, step } = soloSim();
    // Container at (20,-16), 2.4 m square, 2.2 m tall. Approach from the south.
    me.pos.x = 20; me.pos.z = -13.2; me.pos.y = 0.002;
    me.yaw = 0; // face -Z
    step({ fwd: 1, yaw: 0 }, 40); // walk up to it
    expect(me.pos.y).toBeLessThan(0.01);
    step({ fwd: 1, yaw: 0, buttons: BTN_JUMP });
    step({ fwd: 1, yaw: 0, buttons: BTN_JUMP }, 30);
    step({ yaw: 0 }, 20);
    expect(me.pos.y).toBeGreaterThan(2.15);
    expect(me.onGround).toBe(true);
  });

  it('wall-jumps off a wall for extra height', () => {
    const { me, step } = soloSim();
    // Stand against the west face of the east building (x = 5) in mid.
    me.pos.x = 4.55; me.pos.z = 2; me.pos.y = 0.402; // on the mid platform? no: x 4.55 is off it
    me.pos.y = 0.002;
    me.yaw = -Math.PI / 2; // face +X, into the wall
    step({ fwd: 1, yaw: me.yaw }, 10);
    const y0 = me.pos.y;
    step({ fwd: 1, yaw: me.yaw, buttons: BTN_JUMP });
    step({ fwd: 1, yaw: me.yaw }, 18);
    step({ fwd: 0, yaw: me.yaw, buttons: BTN_JUMP }); // tap again in the air
    expect(me.wallJumps).toBe(1);
    let apex = 0;
    for (let i = 0; i < 60; i++) {
      step({ yaw: me.yaw });
      apex = Math.max(apex, me.pos.y - y0);
    }
    expect(apex).toBeGreaterThan(2.2);
  });

  it('grapples up to a rooftop', () => {
    const { me, step } = soloSim();
    me.pos.x = 0; me.pos.z = 14; me.pos.y = 0.002;
    // Aim at the top of the mid pylon (0, 9, 10).
    const yaw = 0;
    const pitch = Math.atan2(8.5 - 1.63, 14 - 10.7);
    step({ yaw, pitch, buttons: BTN_GRAPPLE }, 1);
    expect(me.grappleOn).toBe(true);
    step({ yaw, pitch, buttons: BTN_GRAPPLE }, 50);
    expect(me.pos.y).toBeGreaterThan(4);
  });
});

describe('gunplay', () => {
  it('first shot is accurate when still, and wildly inaccurate while running or airborne', () => {
    const { sim, me } = soloSim();
    sim.phase = 'freeze';
    me.money = 16000;
    expect(sim.tryBuy(me, 'hammerhead')).toBe(true);
    me.vel.x = me.vel.z = 0;
    const still = sim.spreadOf(me);
    me.vel.x = 5.4;
    const running = sim.spreadOf(me);
    me.vel.x = 5.46 * 0.3;
    const counterStrafed = sim.spreadOf(me);
    me.onGround = false;
    const air = sim.spreadOf(me);
    expect(still).toBeLessThan(0.005);
    expect(counterStrafed).toBe(still);
    expect(running).toBeGreaterThan(still * 15);
    expect(air).toBeGreaterThan(running);
  });

  it('spray patterns climb, then recover after you stop firing', () => {
    const { sim, me, step } = soloSim();
    sim.phase = 'freeze';
    expect(sim.tryBuy(me, 'hammerhead')).toBe(false); // cannot afford it on $800
    me.money = 16000;
    expect(sim.tryBuy(me, 'hammerhead')).toBe(true);
    expect(sim.tryBuy(me, 'hammerhead')).toBe(false); // already owned
    expect(sim.tryBuy(me, 'lumen')).toBe(false); // defender-only rifle
    sim.phase = 'live';
    step({}, 64); // draw
    step({ buttons: BTN_FIRE }, 64);
    expect(me.weapons[0]!.mag).toBeLessThan(25);
    expect(me.punchPitch).toBeGreaterThan(0.08);
    step({}, 64);
    expect(me.punchPitch).toBe(0);
    const p = { pitch: 0, yaw: 0 };
    patternAt(WEAPONS['hammerhead']!, 0, p);
    expect(p.pitch).toBe(0);
  });

  it('a rifle headshot kills through a helmet; body shots take several', () => {
    const { sim, me, step } = soloSim();
    const enemy = sim.players.find((p) => p.team === DEF)!;
    sim.phase = 'freeze';
    me.money = 5000;
    sim.tryBuy(me, 'hammerhead');
    sim.phase = 'live';
    enemy.armor = 100; enemy.helmet = true;
    me.pos.x = 0; me.pos.z = 20; me.pos.y = 0.002;
    enemy.pos.x = 0; enemy.pos.z = 12; enemy.pos.y = 0.002;
    step({ yaw: 0, pitch: 0 }, 64);
    // Chest height shot.
    const chestPitch = Math.atan2(1.3 - 1.63, 8);
    step({ yaw: 0, pitch: chestPitch, buttons: BTN_FIRE });
    expect(enemy.hp).toBeLessThan(100);
    expect(enemy.hp).toBeGreaterThan(60);
    step({ yaw: 0, pitch: chestPitch }, 64);
    const headPitch = Math.atan2(1.69 - 1.63, 8);
    step({ yaw: 0, pitch: headPitch, buttons: BTN_FIRE });
    expect(enemy.alive).toBe(false);
    expect(me.kills).toBe(1);
    // rifle price, kill reward, then the round-win bonus for eliminating the other team
    expect(me.money).toBe(5000 - 2700 + 300 + 3250);
  });
});

describe('full bot match', () => {
  it('plays a complete match with plants, disarms and a winner', () => {
    const sim = new Sim({ humanTeam: null, seed: 7, rules: { freezeTime: 1, roundEndTime: 1 } });
    const reasons: Record<string, number> = {};
    let plants = 0, kills = 0, shots = 0, maxTickMs = 0;
    const t0 = performance.now();
    let ticks = 0;
    const limit = 64 * 60 * 60; // an hour of game time
    while (sim.phase !== 'over' && ticks < limit) {
      const a = performance.now();
      sim.tick();
      maxTickMs = Math.max(maxTickMs, performance.now() - a);
      ticks++;
      for (const e of sim.events) {
        if (e.type === 'roundEnd') reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
        else if (e.type === 'planted') plants++;
        else if (e.type === 'kill') kills++;
        else if (e.type === 'shot') shots++;
      }
      sim.events.length = 0;
      for (const p of sim.players) {
        if (!p.alive) continue;
        expect(Number.isFinite(p.pos.x + p.pos.y + p.pos.z)).toBe(true);
      }
    }
    const ms = performance.now() - t0;
    console.log(
      `match: ${sim.round} rounds, score ${sim.score.join('-')}, ${plants} plants, ${kills} kills, ${shots} shots,`,
      `reasons ${JSON.stringify(reasons)}, ${(ticks * TICK / 60).toFixed(1)} game-min in ${ms.toFixed(0)} ms`,
      `(${(ms / ticks * 1000).toFixed(1)} us/tick avg, ${maxTickMs.toFixed(2)} ms worst)`,
    );
    expect(sim.phase).toBe('over');
    expect(plants).toBeGreaterThan(2);
    expect(kills).toBeGreaterThan(40);
    expect(Object.keys(reasons).length).toBeGreaterThan(1);
    // 10 players must simulate far faster than real time (budget: 15.6 ms per tick).
    expect(ms / ticks).toBeLessThan(2);
  }, 120000);
});
