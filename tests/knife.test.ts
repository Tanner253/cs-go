import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/game';
import { BTN_ALT, BTN_FIRE, emptyCmd, type Cmd, type SimEvent } from '../src/sim/types';
import { RULES_1V1 } from '../src/net/protocol';

/** Two players on the open mid lane, knife out, `gap` metres apart (the attacker facing the other). */
function duel(gap = 1.2) {
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
      // (held where they were put)
      me.pos.x = 0; me.pos.z = 20; foe.pos.x = 0; foe.pos.z = 20 - gap;
    }
  };
  run(4, () => { cmds[0].slot = 2; });
  run(40);
  return { sim, me, foe, cmds, run, events };
}

/** Press a button for one tick, then let it go (run it for two). */
const tap = (cmd: Cmd, bit: number) => (t: number): void => { cmd.buttons = t === 0 ? bit : 0; };

describe('the knife', () => {
  it('slashes for 40, then 25 for a slash that follows within a second', () => {
    const { foe, cmds, run, events } = duel();
    cmds[1].yaw = Math.PI; // (facing the attacker)
    run(2);
    run(2, tap(cmds[0], BTN_FIRE));
    expect(foe.hp).toBe(60);
    expect(events.some((e) => e.type === 'knife' && e.hit && !e.heavy)).toBe(true);
    run(40);
    run(2, tap(cmds[0], BTN_FIRE));
    expect(foe.hp).toBe(35);
    // (after a pause, the full 40 again)
    run(80);
    run(2, tap(cmds[0], BTN_FIRE));
    expect(foe.hp).toBe(0);
  });

  it('stabs for 65 to the front and 180 from behind, once a second', () => {
    const front = duel();
    front.cmds[1].yaw = Math.PI;
    front.run(2);
    front.run(2, tap(front.cmds[0], BTN_ALT));
    expect(front.foe.hp).toBe(35);
    expect(front.events.some((e) => e.type === 'knife' && e.heavy)).toBe(true);
    // (held: the next stab only comes a second later)
    front.cmds[0].buttons = BTN_ALT;
    front.run(60);
    expect(front.foe.hp).toBe(35);
    front.run(8);
    expect(front.foe.alive).toBe(false);

    const back = duel();
    back.cmds[1].yaw = 0; // (facing away: the attacker stands at its back)
    back.run(2);
    back.run(2, tap(back.cmds[0], BTN_ALT));
    expect(back.foe.alive).toBe(false);
  });

  it('a victim side-on is not stabbed in the back', () => {
    const { foe, cmds, run } = duel();
    cmds[1].yaw = -Math.PI / 2; // (the victim faces +x: the attacker, at its side, is not behind it)
    run(2);
    run(2, tap(cmds[0], BTN_ALT));
    expect(foe.hp).toBe(35);
  });

  it('a stab reaches less far than a slash', () => {
    const { foe, cmds, run } = duel(2.0);
    cmds[1].yaw = Math.PI;
    run(2);
    run(2, tap(cmds[0], BTN_ALT));
    expect(foe.hp).toBe(100);
    run(70);
    run(2, tap(cmds[0], BTN_FIRE));
    expect(foe.hp).toBe(60);
  });

  it('armour takes its share', () => {
    const { foe, cmds, run } = duel();
    foe.armor = 100;
    cmds[1].yaw = Math.PI;
    run(2);
    run(2, tap(cmds[0], BTN_ALT));
    expect(foe.hp).toBe(100 - 55);
  });
});
