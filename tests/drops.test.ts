import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/game';
import { BTN_DROP, BTN_USE, SLOT_CHARGE, emptyCmd, type Cmd, type SimEvent } from '../src/sim/types';
import { RULES_1V1, applySnapshot, takeSnapshot } from '../src/net/protocol';

/** Two players on the open mid lane, the round live and endless, one of them with a rifle. */
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
  sim.phase = 'freeze';
  sim.tryBuy(me, me.team === 0 ? 'hammerhead' : 'lumen');
  sim.phase = 'live';
  run(40); // (the rifle drawn)
  return { sim, me, foe, cmds, run, events };
}

/** Press a button for one tick, then let it go. */
const tap = (cmd: Cmd, bit: number) => (t: number): void => { cmd.buttons = t === 0 ? bit : 0; };

describe('weapons on the floor', () => {
  it('G throws the gun in hand ahead, where it lands, slides to a stop and lies', () => {
    const { sim, me, cmds, run, events } = lane();
    const rifle = me.weapons[0]!;
    rifle.mag = 7;
    cmds[0].yaw = 0; cmds[0].pitch = 0;
    run(1, tap(cmds[0], BTN_DROP));
    expect(me.weapons[0]).toBeNull();
    expect(me.active).toBe(1); // (the pistol comes up)
    expect(sim.drops).toHaveLength(1);
    expect(events.some((e) => e.type === 'drop' && e.player === me.id)).toBe(true);
    run(120);
    const d = sim.drops[0]!;
    expect(d.state).toBe(1);
    expect(d.weapon).toBe(rifle); // (its magazine and all)
    expect(d.weapon.mag).toBe(7);
    expect(d.pos.y).toBeLessThan(0.2);
    expect(20 - d.pos.z).toBeGreaterThan(1); // thrown forward (-z) ...
    expect(20 - d.pos.z).toBeLessThan(6); // ... not far
    expect(events.some((e) => e.type === 'clatter')).toBe(true);
  });

  it('the knife is never dropped', () => {
    const { sim, me, cmds, run } = lane();
    run(1, () => { cmds[0].slot = 2; });
    run(30);
    run(1, tap(cmds[0], BTN_DROP));
    expect(me.weapons[2]).not.toBeNull();
    expect(sim.drops).toHaveLength(0);
  });

  it('walking over one fills an empty slot; its dropper only after a moment', () => {
    const { sim, me, foe, cmds, run } = lane();
    cmds[0].yaw = 0;
    run(1, tap(cmds[0], BTN_DROP));
    run(90);
    const d = sim.drops[0]!;
    // The dropper standing on it at once does not take it back...
    me.pos.x = d.pos.x; me.pos.z = d.pos.z;
    const back = sim.drops[0]!;
    expect(back).toBe(d);
    // ...the enemy, with no main gun, walking over it, does.
    me.pos.x = 3; me.pos.z = 20;
    foe.pos.x = d.pos.x; foe.pos.z = d.pos.z;
    expect(foe.weapons[0]).toBeNull();
    run(2);
    expect(sim.drops).toHaveLength(0);
    expect(foe.weapons[0]?.def.slot).toBe(0);
    expect(foe.active).toBe(0); // (better than the pistol it held: taken up into the hands)
  });

  it('walking over one does not swap a gun already carried; E does, throwing down the old one', () => {
    const { sim, me, foe, cmds, run } = lane();
    sim.phase = 'freeze';
    sim.tryBuy(foe, foe.team === 0 ? 'hammerhead' : 'lumen');
    sim.phase = 'live';
    const theirs = foe.weapons[0]!;
    const mine = me.weapons[0]!;
    cmds[0].yaw = 0;
    run(1, tap(cmds[0], BTN_DROP));
    run(90);
    const d = sim.drops[0]!;
    foe.pos.x = d.pos.x; foe.pos.z = d.pos.z;
    run(10);
    expect(sim.drops).toHaveLength(1); // (its main slot is full)
    expect(foe.weapons[0]).toBe(theirs);
    // E while standing on it: the trade.
    run(1, tap(cmds[1], BTN_USE));
    expect(foe.weapons[0]).toBe(mine);
    expect(foe.active).toBe(0);
    expect(sim.drops).toHaveLength(1);
    expect(sim.drops[0]!.weapon).toBe(theirs);
  });

  it('E takes the one looked at, within reach and in sight', () => {
    const { sim, me, foe, cmds, run } = lane();
    cmds[0].yaw = 0;
    run(1, tap(cmds[0], BTN_DROP));
    run(90);
    const d = sim.drops[0]!;
    // The foe, two metres off, looking down at it.
    foe.pos.x = d.pos.x; foe.pos.z = d.pos.z - 1.3;
    const eye = 1.63;
    cmds[1].yaw = Math.PI; // (facing +z)
    cmds[1].pitch = -Math.atan2(eye - d.pos.y, 1.3);
    run(1);
    expect(sim.dropInReach(foe)).toBe(d);
    cmds[1].pitch = 0.6; // (looking up, away from it)
    run(1);
    expect(sim.dropInReach(foe)).toBeNull();
  });

  it('the dead let fall their best gun, which the next round clears away', () => {
    const { sim, me, foe, run } = lane();
    const rifle = me.weapons[0]!;
    (sim as unknown as { kill: (...a: unknown[]) => void }).kill(me, foe, null, false, false);
    expect(me.weapons[0]).toBeNull();
    expect(sim.drops).toHaveLength(1);
    expect(sim.drops[0]!.weapon).toBe(rifle);
    run(60);
    expect(sim.drops[0]!.state).toBe(1);
    // (the round ends with one side gone; the next starts with nothing on the floor)
    run(Math.ceil((RULES_1V1.roundEndTime + 0.5) * 64));
    expect(sim.round).toBe(2);
    expect(sim.drops).toHaveLength(0);
  });

  it('buying a gun for a full slot lets the old one fall at the feet', () => {
    const { sim, me } = lane();
    const rifle = me.weapons[0]!;
    sim.phase = 'freeze';
    expect(sim.tryBuy(me, me.team === 0 ? 'mako' : 'osprey')).toBe(true);
    expect(sim.drops).toHaveLength(1);
    expect(sim.drops[0]!.weapon).toBe(rifle);
    expect(Math.hypot(sim.drops[0]!.pos.x - me.pos.x, sim.drops[0]!.pos.z - me.pos.z)).toBeLessThan(0.5);
  });

  it('a grenade can be thrown down too, one at a time, and walked over by whoever has room', () => {
    const { sim, me, foe, cmds, run } = lane();
    sim.phase = 'freeze';
    sim.tryBuy(me, 'flash');
    sim.tryBuy(me, 'flash');
    sim.phase = 'live';
    run(1, () => { cmds[0].slot = 3; });
    run(40);
    cmds[0].yaw = 0;
    run(1, tap(cmds[0], BTN_DROP));
    expect(me.nades.reduce((a, b) => a + b, 0)).toBe(1);
    expect(me.active).toBe(3); // (the other flashbang comes up)
    run(90);
    const d = sim.drops[0]!;
    expect(d.weapon.def.id).toBe('flash');
    foe.pos.x = d.pos.x; foe.pos.z = d.pos.z;
    run(2);
    expect(sim.drops).toHaveLength(0);
    expect(foe.nades.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('bots go over and take a much better gun lying close by', () => {
    const sim = new Sim({ humanTeam: null, teamSize: 1, seed: 3, rules: { freezeTime: 0.5, roundTime: 9999 } });
    const bot = sim.players[0]!, foe = sim.players[1]!;
    while (sim.phase !== 'live') sim.tick();
    const fx = foe.pos.x, fz = foe.pos.z;
    const ex = bot.pos.y + 1.6;
    const dx = sim.world.lineOfSight(bot.pos.x, ex, bot.pos.z, bot.pos.x + 2.5, 0.3, bot.pos.z) ? 2.5 : -2.5;
    const rifle = { def: (sim as unknown as { makeWeapon: (id: string) => { def: unknown } }).makeWeapon('lumen').def, mag: 30, reserve: 90, quiet: false };
    sim.drops.push({
      id: 77, weapon: rifle as never, pos: { x: bot.pos.x + dx, y: bot.pos.y + 0.03, z: bot.pos.z }, vel: { x: 0, y: 0, z: 0 },
      yaw: 0, spin: 0, state: 1, owner: -1, ownerUntil: 0,
    });
    expect(bot.weapons[0]).toBeNull();
    for (let t = 0; t < 64 * 10 && !bot.weapons[0]; t++) {
      sim.tick();
      // (the enemy kept far off, out of the way)
      foe.pos.x = fx; foe.pos.z = fz;
    }
    expect(bot.weapons[0]?.def.id).toBe('lumen');
  });

  it('are sent to clients, where they keep their objects from snapshot to snapshot', () => {
    const { sim, cmds, run } = lane();
    cmds[0].yaw = 0;
    run(1, tap(cmds[0], BTN_DROP));
    run(5);
    const client = new Sim({ teamSize: 1, bots: false, rules: { ...RULES_1V1 } });
    applySnapshot(client, takeSnapshot(sim, [0, 0], []));
    expect(client.drops).toHaveLength(1);
    const first = client.drops[0]!;
    expect(first.weapon.def).toBe(sim.drops[0]!.weapon.def);
    expect(first.pos.z).toBeCloseTo(sim.drops[0]!.pos.z, 3);
    run(5);
    applySnapshot(client, takeSnapshot(sim, [0, 0], []));
    expect(client.drops[0]).toBe(first);
    expect(first.pos.z).toBeCloseTo(sim.drops[0]!.pos.z, 3);
  });
});

describe('the charge', () => {
  it('can be thrown down by its carrier for a teammate, who walks over it to take it', () => {
    const sim = new Sim({ teamSize: 2, bots: false, rules: { freezeTime: 0.02, roundTime: 9999 } });
    const carrier = sim.players.find((p) => p.hasCharge)!;
    const mate = sim.players.find((p) => p.team === carrier.team && p !== carrier)!;
    const cmds = sim.players.map(() => emptyCmd());
    const run = (n: number): void => { for (let i = 0; i < n; i++) { sim.tick((p) => cmds[p.id]!); for (const c of cmds) c.slot = -1; } };
    run(3);
    mate.pos.x = carrier.pos.x + 6; mate.pos.z = carrier.pos.z;
    cmds[carrier.id]!.yaw = carrier.yaw;
    cmds[carrier.id]!.slot = SLOT_CHARGE;
    run(1);
    expect(carrier.hasCharge).toBe(false);
    expect(sim.charge.state).toBe('dropped');
    // (not straight back into the hands it left)
    run(30);
    expect(sim.charge.state).toBe('dropped');
    mate.pos.x = sim.charge.pos.x; mate.pos.z = sim.charge.pos.z; mate.pos.y = sim.charge.pos.y;
    run(2);
    expect(mate.hasCharge).toBe(true);
  });
});
