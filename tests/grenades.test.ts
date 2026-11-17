import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/game';
import { BTN_ALT, BTN_FIRE, SLOT_NADE, TICK, emptyCmd, type Cmd, type Grenade, type SimEvent } from '../src/sim/types';
import { NADE_INDEX } from '../src/sim/weapons';
import { FUSE, PIN_TIME, SMOKE_GROW, SMOKE_LIFE, THROW_TIME } from '../src/sim/grenades';
import { RULES_1V1 } from '../src/net/protocol';

/** Two players on the open mid lane, the round live and endless. */
function lane() {
  const sim = new Sim({ teamSize: 1, bots: false, rules: { ...RULES_1V1, freezeTime: 0.02, roundTime: 9999 } });
  const me = sim.players[0]!, foe = sim.players[1]!;
  const cmds: [Cmd, Cmd] = [emptyCmd(), emptyCmd()];
  const events: SimEvent[] = [];
  const run = (ticks: number, each?: (t: number) => void): void => {
    for (let t = 0; t < ticks; t++) {
      each?.(t);
      sim.tick((p) => cmds[p.id]!);
      events.push(...sim.events);
      sim.events.length = 0;
      cmds[0].slot = cmds[1].slot = -1;
    }
  };
  run(4);
  me.pos.x = 0; me.pos.z = 20; me.pos.y = 0.002;
  foe.pos.x = 0; foe.pos.z = 12; foe.pos.y = 0.002;
  me.money = foe.money = 16000;
  run(2);
  return { sim, me, foe, cmds, run, events };
}

/** A grenade of `id` set down at a point, about to go off (or, for smoke and fire, lying there). */
function place(sim: Sim, id: string, owner: number, x: number, y: number, z: number): Grenade {
  const g: Grenade = {
    id: 900 + sim.grenades.length, kind: NADE_INDEX.get(id)!, owner, team: sim.players[owner]!.team,
    pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, born: sim.time - FUSE + 2 * TICK, state: 1, popAt: 0, endAt: 0,
  };
  sim.grenades.push(g);
  return g;
}

describe('grenades', () => {
  it('can be bought within the carrying limits', () => {
    const { sim, me } = lane();
    sim.phase = 'freeze';
    expect(sim.tryBuy(me, 'flash')).toBe(true);
    expect(sim.tryBuy(me, 'flash')).toBe(true);
    expect(sim.tryBuy(me, 'flash')).toBe(false); // two at most
    expect(sim.tryBuy(me, 'frag')).toBe(true);
    expect(sim.tryBuy(me, me.team === 0 ? 'incendiary' : 'molotov')).toBe(false); // the other side's
    expect(sim.tryBuy(me, me.team === 0 ? 'molotov' : 'incendiary')).toBe(true);
    expect(sim.tryBuy(me, 'smoke')).toBe(false); // four in all
    expect(me.nades.reduce((a, b) => a + b, 0)).toBe(4);
    expect(me.weapons[3]?.def.kind).toBe('grenade');
  });

  it('is thrown on letting go, as hard as the buttons say, and goes off 1.6 s later', () => {
    const { sim, me, cmds, run, events } = lane();
    sim.phase = 'freeze';
    sim.tryBuy(me, 'frag');
    sim.phase = 'live';
    cmds[0].yaw = 0; cmds[0].pitch = 0;
    cmds[0].slot = 3;
    run(1);
    expect(me.active).toBe(3);
    run(Math.ceil(0.6 / TICK));
    cmds[0].buttons = BTN_FIRE;
    run(4);
    expect(me.pinAt).toBeGreaterThan(0);
    expect(sim.grenades.length).toBe(0);
    cmds[0].buttons = 0;
    run(Math.ceil(PIN_TIME / TICK));
    expect(sim.grenades.length).toBe(1);
    const g = sim.grenades[0]!;
    const speed = Math.hypot(g.vel.x, g.vel.y, g.vel.z);
    expect(speed).toBeGreaterThan(15);
    expect(speed).toBeLessThan(18);
    expect(g.vel.z).toBeLessThan(-14); // straight down the lane
    // The hand comes back with the gun it had before (there are no grenades left).
    run(Math.ceil((THROW_TIME + 0.05) / TICK));
    expect(me.active).not.toBe(3);
    run(Math.ceil(FUSE / TICK));
    expect(events.some((e) => e.type === 'boom' && e.kind === 'he')).toBe(true);
    expect(sim.grenades.length).toBe(0);
  });

  it('lobs underarm with alt-fire', () => {
    const { sim, me, cmds, run } = lane();
    sim.phase = 'freeze';
    sim.tryBuy(me, 'smoke');
    sim.phase = 'live';
    cmds[0].slot = SLOT_NADE + NADE_INDEX.get('smoke')!;
    run(Math.ceil(0.7 / TICK));
    cmds[0].buttons = BTN_ALT;
    run(Math.ceil(PIN_TIME / TICK) + 2);
    cmds[0].buttons = 0;
    run(1);
    const g = sim.grenades[0]!;
    expect(Math.hypot(g.vel.x, g.vel.y, g.vel.z)).toBeLessThan(6.5);
    // It comes to rest and the smoke goes up where it lies.
    run(Math.ceil(4 / TICK));
    expect(g.state).toBe(2);
    expect(Math.hypot(g.pos.x - me.pos.x, g.pos.z - me.pos.z)).toBeLessThan(6);
  });

  it('HE hurts hard up close and little a few metres off', () => {
    const { sim, me, foe, run } = lane();
    place(sim, 'frag', me.id, foe.pos.x, 0.05, foe.pos.z - 1);
    run(3);
    const close = 100 - foe.hp;
    expect(close).toBeGreaterThan(80);
    foe.hp = 100;
    place(sim, 'frag', me.id, foe.pos.x, 0.05, foe.pos.z + 6);
    run(3);
    const far = 100 - foe.hp;
    expect(far).toBeGreaterThan(3);
    expect(far).toBeLessThan(25);
  });

  it('a flashbang blinds longest those looking at it', () => {
    const { sim, me, foe, cmds, run } = lane();
    cmds[1].yaw = 0; // foe looks down the lane, away from me (towards -z)
    run(1);
    place(sim, 'flash', me.id, foe.pos.x, 1.4, foe.pos.z - 3);
    run(3);
    const facing = sim.blindFor(foe);
    expect(facing).toBeGreaterThan(4);
    // I am 8 m behind it and looking at it too.
    cmds[0].yaw = 0;
    expect(sim.blindFor(me)).toBeGreaterThan(2);
    foe.flashEnd = 0;
    cmds[1].yaw = Math.PI; // now facing away
    run(1);
    place(sim, 'flash', me.id, foe.pos.x, 1.4, foe.pos.z - 3);
    run(3);
    const away = sim.blindFor(foe);
    expect(away).toBeGreaterThan(0.5);
    expect(away).toBeLessThan(1.5);
  });

  it('smoke hides what is behind it while it lasts, and only then', () => {
    const { sim, me, foe, run } = lane();
    const g = place(sim, 'smoke', me.id, 0, 0.05, 16);
    const across = (): boolean => sim.smokeBlocks(me.pos.x, 1.63, me.pos.z, foe.pos.x, 1.63, foe.pos.z);
    expect(across()).toBe(false);
    run(Math.ceil((0.6 + SMOKE_GROW) / TICK));
    expect(g.state).toBe(2);
    expect(across()).toBe(true);
    run(Math.ceil(SMOKE_LIFE / TICK));
    expect(across()).toBe(false);
  });

  it('fire burns those standing in it, and smoke puts it out', () => {
    const { sim, me, foe, run, events } = lane();
    const f = place(sim, foe.team === 0 ? 'incendiary' : 'molotov', me.id, foe.pos.x, 0.3, foe.pos.z);
    f.state = 0;
    run(Math.ceil(1.0 / TICK), () => { foe.hp = Math.max(foe.hp, 1); });
    expect(f.state).toBe(2);
    const before = foe.hp;
    run(64);
    expect(before - foe.hp).toBeGreaterThan(30);
    expect(before - foe.hp).toBeLessThan(50);
    place(sim, 'smoke', me.id, foe.pos.x + 1, 0.05, foe.pos.z);
    run(Math.ceil(0.7 / TICK));
    expect(events.some((e) => e.type === 'boom' && e.kind === 'out')).toBe(true);
    expect(sim.grenades.includes(f)).toBe(false);
  });
});
