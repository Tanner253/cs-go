import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/game';
import { ATK, BTN_ALT, BTN_CROUCH, BTN_FIRE, BTN_GRAPPLE, BTN_JUMP, DEF, TICK, emptyCmd, type Cmd, type Player, type SimEvent, type Team } from '../src/sim/types';
import { SUPPRESSED_RECOIL, SUPPRESSOR_TIME, WEAPONS, patternAt } from '../src/sim/weapons';
import { decodePlayer, encodePlayer } from '../src/net/protocol';

/** A sim with one human and no opposition interfering: freeze time skipped. */
function soloSim(vertical = false, team: Team = ATK): {
  sim: Sim; me: Player; step: (cmd: Partial<Cmd>, ticks?: number) => void; seen: SimEvent[];
} {
  const sim = new Sim({ teamSize: 1, humanTeam: team, rules: { freezeTime: 0.02, roundTime: 9999, verticalKit: vertical } });
  const me = sim.human!;
  const cmd = emptyCmd();
  /** Every event since the test last emptied it. */
  const seen: SimEvent[] = [];
  const step = (c: Partial<Cmd>, ticks = 1) => {
    for (let i = 0; i < ticks; i++) {
      Object.assign(cmd, emptyCmd(), { yaw: me.yaw, pitch: me.pitch }, c);
      sim.tick((p) => (p === me ? cmd : null));
      seen.push(...sim.events);
      sim.events.length = 0;
    }
  };
  // Park the lone enemy bot far away and make it harmless.
  const enemy = sim.players.find((p) => p.team !== team)!;
  enemy.pos.x = 0; enemy.pos.z = -33;
  sim.bots.clear();
  enemy.isBot = false;
  step({}, 4);
  return { sim, me, step, seen };
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

  it('a landing costs speed for a moment, and a jump straight after one is lower (stamina)', () => {
    const { me, step } = soloSim();
    me.pos.x = -17.5; me.pos.z = -14.5; me.pos.y = 0.002; // 30 m of open ground toward +X
    const yaw = -Math.PI / 2;
    step({ fwd: 1, yaw }, 50);
    step({ fwd: 1, yaw, buttons: BTN_JUMP });
    while (!me.onGround) step({ fwd: 1, yaw });
    let slowest = 99;
    for (let i = 0; i < 12; i++) { step({ fwd: 1, yaw }); slowest = Math.min(slowest, Math.hypot(me.vel.x, me.vel.z)); }
    expect(slowest).toBeLessThan(6.1 * 0.65);
    step({ fwd: 1, yaw }, 32);
    expect(Math.hypot(me.vel.x, me.vel.z)).toBeGreaterThan(5.9);
    expect(me.stamina).toBe(0);
    // Jumping again the moment the feet touch: lower.
    const y0 = me.pos.y;
    const apex = (): number => {
      step({ buttons: BTN_JUMP });
      let top = 0;
      for (let i = 0; i < 80 && !(me.onGround && i > 2); i++) { step({}); top = Math.max(top, me.pos.y - y0); }
      return top;
    };
    me.vel.x = me.vel.z = 0;
    step({}, 64);
    const first = apex();
    const second = apex();
    expect(first).toBeGreaterThan(1.35);
    expect(second).toBeLessThan(first * 0.8);
  });

  it('crouching in the air draws the legs up: a crouch-jump clears the crates a plain jump cannot', () => {
    const { me, step } = soloSim();
    const y0 = me.pos.y;
    const eye = (): number => me.pos.y + 1.63 - 0.46 * me.crouchT;
    let top = 0, lastEye = eye(), worstJerk = 0;
    step({ buttons: BTN_JUMP | BTN_CROUCH });
    for (let i = 0; i < 80; i++) {
      step({ buttons: BTN_CROUCH });
      top = Math.max(top, me.pos.y - y0);
      worstJerk = Math.max(worstJerk, Math.abs(eye() - lastEye));
      lastEye = eye();
    }
    expect(top).toBeGreaterThan(1.6); // 1.39 for a plain jump
    expect(worstJerk).toBeLessThan(0.13); // the eyes never jump
    expect(me.onGround).toBe(true);
    // A 1.4 m crate at x 16..18, z -12.2..-10.8, run at from the east, jumping 2.2 m out.
    const onto = (buttons: number): number => {
      me.pos.x = 24.4; me.pos.z = -11.5; me.pos.y = 0.002; me.vel.x = me.vel.z = 0; me.stamina = 0; me.ducked = false; me.crouchT = 0;
      const yaw = Math.PI / 2;
      while (me.pos.x > 18.4 + 2.2) step({ fwd: 1, yaw });
      step({ fwd: 1, yaw, buttons: BTN_JUMP | buttons });
      step({ fwd: 1, yaw, buttons }, 60);
      return me.pos.y;
    };
    expect(onto(0)).toBeLessThan(0.01);
    expect(onto(BTN_CROUCH)).toBeGreaterThan(1.39);
  });

  it('crouch-spamming slows each crouch down, and the speed grows back', () => {
    const { me, step } = soloSim();
    const ticksToCrouch = (): number => {
      let n = 0;
      while (me.crouchT < 1 && n < 200) { step({ buttons: BTN_CROUCH }); n++; }
      while (me.crouchT > 0) step({});
      return n;
    };
    const fresh = ticksToCrouch();
    ticksToCrouch(); ticksToCrouch();
    const spammed = ticksToCrouch();
    expect(fresh).toBeLessThanOrEqual(10);
    expect(spammed).toBeGreaterThan(fresh * 2);
    step({}, 64 * 3);
    expect(ticksToCrouch()).toBe(fresh);
  });

  it('being shot slows you, more for a heavy hit, and wears off', () => {
    const { sim, me, step } = soloSim();
    const enemy = sim.players.find((p) => p !== me)!;
    me.pos.x = -17.5; me.pos.z = -14.5; me.pos.y = 0.002;
    const yaw = -Math.PI / 2;
    step({ fwd: 1, yaw }, 40);
    (sim as unknown as { damage: (...a: unknown[]) => void }).damage(me, enemy, WEAPONS.longsight, 10, 2, 0, 0, 0, 0, false);
    expect(me.tag).toBeLessThan(0.66);
    step({ fwd: 1, yaw }, 20);
    expect(Math.hypot(me.vel.x, me.vel.z)).toBeLessThan(6.1 * 0.85);
    step({ fwd: 1, yaw }, 60);
    expect(me.tag).toBe(1);
    expect(Math.hypot(me.vel.x, me.vel.z)).toBeGreaterThan(5.9);
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

  it('has no vertical kit by default: no mantle, wall-jump or grapple', () => {
    const { me, step } = soloSim();
    // Hold jump into a 2.2 m container: must not climb it.
    me.pos.x = 20; me.pos.z = -13.2; me.pos.y = 0.002;
    step({ fwd: 1, yaw: 0 }, 40);
    step({ fwd: 1, yaw: 0, buttons: BTN_JUMP }, 50);
    step({ yaw: 0 }, 40);
    expect(me.pos.y).toBeLessThan(0.01);
    // Tap jump in the air against a wall: no second jump.
    me.pos.x = 4.55; me.pos.z = 2; me.pos.y = 0.002;
    const yaw = -Math.PI / 2;
    step({ fwd: 1, yaw }, 10);
    step({ fwd: 1, yaw, buttons: BTN_JUMP });
    step({ fwd: 1, yaw }, 18);
    step({ yaw, buttons: BTN_JUMP });
    expect(me.wallJumps).toBe(0);
    step({ yaw }, 80);
    // Grapple button does nothing.
    step({ yaw: 0, pitch: 0.5, buttons: BTN_GRAPPLE }, 5);
    expect(me.grappleOn).toBe(false);
  });

  it('vertical kit still works when the rule is switched on', () => {
    const { me, step } = soloSim(true);
    me.pos.x = 20; me.pos.z = -13.2; me.pos.y = 0.002;
    step({ fwd: 1, yaw: 0 }, 40);
    step({ fwd: 1, yaw: 0, buttons: BTN_JUMP }, 31);
    step({ yaw: 0 }, 20);
    expect(me.pos.y).toBeGreaterThan(2.15); // mantled onto the container
    me.pos.x = 0; me.pos.z = 14; me.pos.y = 0.002;
    const pitch = Math.atan2(3.0 - 1.63, 3);
    step({ yaw: 0, pitch, buttons: BTN_GRAPPLE }, 1);
    expect(me.grappleOn).toBe(true); // hooked the mid core
  });
});

describe('map', () => {
  it('has headroom for a jump everywhere: nothing overhead is within reach of a jumping player', () => {
    const { sim, me, step } = soloSim();
    // How high a standing jump takes the top of the head.
    me.pos.x = 0; me.pos.z = 30; me.pos.y = 0.002;
    step({}, 8);
    let top = 0;
    step({ buttons: BTN_JUMP });
    for (let i = 0; i < 80; i++) { step({}); top = Math.max(top, me.pos.y + 1.83); }
    expect(top).toBeGreaterThan(3.1);
    for (const b of sim.map.boxes) {
      if (b.noCollide || b.minY < 1) continue;
      expect(b.minY, `box under ${b.minY} m at ${b.minX},${b.minZ}`).toBeGreaterThan(top + 0.5);
    }
    // And under the lowest roof, a jump comes down without having touched it.
    me.pos.x = 11; me.pos.z = 8; me.pos.y = 0.002;
    step({}, 8);
    step({ buttons: BTN_JUMP });
    let peak = 0;
    for (let i = 0; i < 80; i++) { step({}); peak = Math.max(peak, me.pos.y); }
    expect(peak).toBeCloseTo(top - 1.83, 1);
  });

  it('neither spawn can see the other', () => {
    const sim = new Sim({ humanTeam: null });
    const [atk, def] = sim.map.spawns;
    for (const a of atk) {
      for (const d of def) {
        for (const ha of [1.63, 1.17]) {
          expect(sim.world.lineOfSight(a.x, a.y + ha, a.z, d.x, d.y + 1.63, d.z), `spawn ${a.x},${a.z} -> ${d.x},${d.z}`).toBe(false);
        }
      }
    }
  });

  it('has no overlapping or coplanar-touching solid boxes that would z-fight when drawn', () => {
    // Render-side culling handles shared faces; this guards the data against deep overlaps
    // between differently-sized boxes, which are almost always a level-design mistake.
    const sim = new Sim({ humanTeam: null });
    const boxes = sim.map.boxes.filter((b) => !b.noCollide && !b.hidden);
    const bad: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
        const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
        if (ox > 0.011 && oy > 0.011 && oz > 0.011) bad.push(`${i}:${j} overlap ${ox.toFixed(2)}x${oy.toFixed(2)}x${oz.toFixed(2)} at (${a.minX},${a.minY},${a.minZ}) / (${b.minX},${b.minY},${b.minZ})`);
      }
    }
    expect(bad, bad.join('\n')).toHaveLength(0);
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
    step({}, 96);
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

describe('snipers and shotguns', () => {
  /** A player of `team` with `id` bought, standing eight metres from an armoured enemy down a clear lane. */
  const facing = (team: Team, id: string) => {
    const t = soloSim(false, team);
    const { sim, me, step } = t;
    const enemy = sim.players.find((p) => p.team !== team)!;
    sim.phase = 'freeze';
    me.money = 16000;
    const bought = sim.tryBuy(me, id);
    sim.phase = 'live';
    me.pos.x = -26; me.pos.z = 24; me.pos.y = 0.002;
    enemy.pos.x = -26; enemy.pos.z = 16; enemy.pos.y = 0.002;
    enemy.armor = 100; enemy.helmet = true;
    step({ yaw: 0, pitch: 0 }, 80);
    return { ...t, enemy, bought };
  };

  it('each side has its own sniper, and either kills an armoured player with one shot to the chest', () => {
    expect(facing(ATK, 'longsight').bought).toBe(false);
    expect(facing(DEF, 'colossus').bought).toBe(false);
    for (const [team, id] of [[ATK, 'colossus'], [DEF, 'longsight']] as const) {
      const { me, step, enemy, bought } = facing(team, id);
      expect(bought, id).toBe(true);
      const chest = Math.atan2(1.3 - 1.63, 8);
      step({ yaw: 0, pitch: chest, buttons: BTN_ALT });
      step({ yaw: 0, pitch: chest }, 20);
      expect(me.scope, id).toBe(1);
      step({ yaw: 0, pitch: chest, buttons: BTN_FIRE });
      expect(enemy.alive, id).toBe(false);
    }
    // A leg is not a kill.
    const { step, enemy } = facing(ATK, 'colossus');
    const leg = Math.atan2(0.4 - 1.63, 8);
    step({ yaw: 0, pitch: leg, buttons: BTN_ALT });
    step({ yaw: 0, pitch: leg }, 20);
    step({ yaw: 0, pitch: leg, buttons: BTN_FIRE });
    expect(enemy.alive).toBe(true);
    expect(enemy.hp).toBeLessThan(40);
  });

  it('a shotgun throws every pellet into the same cone, thickest in the middle, standing or running', () => {
    const spreadOf = (running: boolean) => {
      const { sim, me, step, seen, bought } = facing(DEF, 'breaker');
      expect(bought).toBe(true);
      const cone = WEAPONS['breaker']!.spreadStand;
      let widest = 0, inner = 0, pellets = 0, offAim = 0;
      for (let shot = 0; shot < 12; shot++) {
        me.weapons[0]!.mag = 7;
        step({ yaw: 0, pitch: 0, fwd: running ? 1 : 0 }, 70);
        seen.length = 0;
        const from = { x: me.pos.x, y: me.pos.y + 1.63, z: me.pos.z };
        step({ yaw: 0, pitch: 0, fwd: running ? 1 : 0, buttons: BTN_FIRE });
        const e = seen.find((ev) => ev.type === 'shot');
        if (!e || e.type !== 'shot') throw new Error('no shot');
        const dirs: [number, number][] = [];
        for (let i = 0; i < e.hitKinds.length; i++) {
          const dx = e.ends[i * 6]! - from.x, dy = e.ends[i * 6 + 1]! - from.y, dz = e.ends[i * 6 + 2]! - from.z;
          dirs.push([Math.atan2(dx, -dz), Math.atan2(dy, Math.hypot(dx, dz))]);
        }
        expect(dirs.length).toBe(9);
        const cx = dirs.reduce((a, d) => a + d[0], 0) / 9, cy = dirs.reduce((a, d) => a + d[1], 0) / 9;
        offAim = Math.max(offAim, Math.hypot(cx, cy));
        for (const d of dirs) {
          const r = Math.hypot(d[0] - cx, d[1] - cy);
          widest = Math.max(widest, r);
          if (r < cone / 2) inner++;
          pellets++;
        }
        void sim;
      }
      return { widest, inner: inner / pellets, offAim, cone };
    };
    const still = spreadOf(false), run = spreadOf(true);
    // The cone is the same size either way (measured about each shot's own middle)...
    expect(still.widest).toBeLessThan(still.cone * 1.6);
    expect(run.widest).toBeLessThan(run.cone * 1.6);
    // ...with well over a quarter of the pellets in its inner half (an even scatter would put a quarter there)...
    expect(still.inner).toBeGreaterThan(0.38);
    // ...and it is the whole pattern that running throws off the aim.
    expect(run.offAim).toBeGreaterThan(still.offAim);
  });
});

describe('suppressors', () => {
  /** A defender holding `id`, drawn and ready, the enemy standing `far` metres in front. */
  const armed = (id: string, far = 8) => {
    const t = soloSim(false, DEF);
    const { sim, me, step } = t;
    const enemy = sim.players.find((p) => p.team === ATK)!;
    sim.phase = 'freeze';
    me.money = 16000;
    expect(sim.tryBuy(me, id)).toBe(true);
    sim.phase = 'live';
    // (down the long west lane: thirty metres of clear, level ground)
    me.pos.x = -26; me.pos.z = 24; me.pos.y = 0.002;
    enemy.pos.x = -26; enemy.pos.z = 24 - far; enemy.pos.y = 0.002;
    step({ yaw: 0, pitch: 0 }, 64);
    t.seen.length = 0;
    return { ...t, enemy, gun: me.weapons[0]! };
  };
  const fitTicks = Math.ceil(SUPPRESSOR_TIME / TICK) + 2;

  it('the Osprey comes with one on, the Lumen and Hornet without; other guns take none', () => {
    expect(armed('osprey').gun.quiet).toBe(true);
    expect(armed('lumen').gun.quiet).toBe(false);
    expect(armed('hornet').gun.quiet).toBe(false);
    const { me, step, seen } = armed('longsight');
    step({ buttons: BTN_ALT });
    step({}, fitTicks);
    expect(me.fitTimer).toBe(0);
    expect(me.weapons[0]!.quiet).toBe(false);
    expect(seen.some((e) => e.type === 'fit')).toBe(false);
  });

  it('alt-fire fits it, which takes time and both hands; again takes it off', () => {
    const { me, step, seen, gun } = armed('lumen');
    step({ buttons: BTN_ALT });
    expect(me.fitTimer).toBeGreaterThan(SUPPRESSOR_TIME - 2 * TICK);
    expect(seen.filter((e) => e.type === 'fit')).toEqual([{ type: 'fit', player: me.id, weapon: 'lumen', on: true }]);
    // Holding the button does not start it again, and the gun cannot be fired meanwhile.
    step({ buttons: BTN_ALT | BTN_FIRE }, 30);
    expect(gun.mag).toBe(30);
    expect(gun.quiet).toBe(false);
    step({}, fitTicks);
    expect(me.fitTimer).toBe(0);
    expect(gun.quiet).toBe(true);
    expect(seen.filter((e) => e.type === 'fit')).toHaveLength(1);
    step({ buttons: BTN_ALT });
    step({}, fitTicks);
    expect(gun.quiet).toBe(false);
  });

  it('putting the gun away part-way leaves it as it was', () => {
    const { me, step, gun } = armed('osprey');
    step({ buttons: BTN_ALT });
    step({}, 40);
    step({ slot: 1 });
    expect(me.fitTimer).toBe(0);
    step({}, fitTicks);
    step({ slot: 0 }, 1);
    step({}, 64);
    expect(gun.quiet).toBe(true);
  });

  it('fitted, the gun climbs less, is marked quiet, and loses a little more with distance', () => {
    const spray = (quiet: boolean, far: number) => {
      const t = armed('lumen', far);
      t.gun.quiet = quiet;
      // (aimed at the chest, so every round of a short burst lands)
      const pitch = Math.atan2(1.3 - 1.63, far);
      t.step({ yaw: 0, pitch, buttons: BTN_FIRE });
      const first = 100 - t.enemy.hp;
      t.enemy.hp = 100000;
      t.step({ yaw: 0, pitch, buttons: BTN_FIRE }, 40);
      const shots = t.seen.filter((e) => e.type === 'shot');
      return { first, climb: t.me.punchPitch, shots };
    };
    const loud = spray(false, 8), quiet = spray(true, 8);
    expect(loud.shots.length).toBeGreaterThan(4);
    expect(quiet.shots.length).toBe(loud.shots.length);
    expect(quiet.climb / loud.climb).toBeCloseTo(SUPPRESSED_RECOIL, 3);
    expect(loud.shots.every((e) => e.type === 'shot' && e.quiet === undefined)).toBe(true);
    expect(quiet.shots.every((e) => e.type === 'shot' && e.quiet === true)).toBe(true);
    // Up close the two hit alike; far off the suppressed round has lost more.
    expect(loud.first).toBeGreaterThan(20);
    expect(loud.first - quiet.first).toBeLessThanOrEqual(1);
    const farLoud = spray(false, 26), farQuiet = spray(true, 26);
    expect(farLoud.first).toBeGreaterThan(farQuiet.first);
    expect(farQuiet.first).toBeGreaterThan(farLoud.first * 0.9);
  });

  it('the Osprey with its suppressor on shoots as it always has', () => {
    const p = { pitch: 0, yaw: 0 };
    const DEG = Math.PI / 180;
    patternAt(WEAPONS['osprey']!, 8, p);
    expect((p.pitch * SUPPRESSED_RECOIL) / DEG).toBeCloseTo(4.6, 1);
    patternAt(WEAPONS['osprey']!, 13, p);
    expect(Math.abs((p.yaw * SUPPRESSED_RECOIL) / DEG - 1.3)).toBeLessThan(0.1);
    expect(Math.pow(WEAPONS['osprey']!.rangeMod * 0.985, 3)).toBeCloseTo(Math.pow(0.95, 3), 2);
  });

  it('is carried in what the server tells clients', () => {
    const { me, step, gun } = armed('lumen');
    step({ buttons: BTN_ALT });
    step({}, 10);
    const other = soloSim(false, DEF).me;
    decodePlayer(other, encodePlayer(me));
    expect(other.fitTimer).toBeCloseTo(me.fitTimer, 3);
    expect(other.weapons[0]!.quiet).toBe(false);
    gun.quiet = true;
    decodePlayer(other, encodePlayer(me));
    expect(other.weapons[0]!.quiet).toBe(true);
    expect(other.weapons[1]!.quiet).toBe(false);
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
