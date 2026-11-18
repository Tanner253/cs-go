import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/game';
import { ATK, DEF, type Player, type SimEvent } from '../src/sim/types';
import { WEAPONS } from '../src/sim/weapons';
import { applySnapshot, encodeHidden, decodePlayer, takeSnapshot } from '../src/net/protocol';

/** The sim's private round machinery, reached for the tests. */
interface Inner {
  afterRound(): void;
  endRound(winner: number, reason: string): void;
  damage(v: Player, a: Player | null, def: unknown, base: number, group: number, dist: number, x: number, y: number, z: number, wb: boolean): void;
  flashedBy: Map<number, { by: number; until: number }>;
  planter: number;
}
const inner = (sim: Sim): Inner => sim as unknown as Inner;
const rifle = WEAPONS['hammerhead']!;
const CHEST = 1;

function match(size = 2) {
  const sim = new Sim({ teamSize: size, bots: false, rules: { freezeTime: 0.02, roundTime: 9999 } });
  return { sim, atk: sim.players.filter((p) => p.team === ATK), def: sim.players.filter((p) => p.team === DEF) };
}

describe('the match', () => {
  it('level at full time goes to overtime: six rounds, first to 16, $10,000, sides kept, swapped at its half', () => {
    const { sim } = match();
    const first = sim.players[0]!;
    const side = first.team;
    sim.round = 24;
    sim.score = [12, 12];
    sim.events.length = 0;
    inner(sim).afterRound();
    expect(sim.phase).not.toBe('over');
    expect(sim.overtime).toBe(1);
    expect(sim.winScore).toBe(16);
    expect(sim.lastRound).toBe(30);
    expect(sim.round).toBe(25);
    expect(first.team).toBe(side);
    expect(sim.players.every((p) => p.money === 10000)).toBe(true);
    expect(sim.events.some((e: SimEvent) => e.type === 'overtime' && e.period === 1)).toBe(true);
    // (its half: after three rounds, the sides swap and the money is set again)
    sim.round = 27;
    sim.score = [14, 13];
    for (const p of sim.players) p.money = 1234;
    inner(sim).afterRound();
    expect(first.team).toBe(1 - side);
    expect(sim.score).toEqual([13, 14]);
    expect(first.money).toBe(10000);
    // Level again at its end: a second overtime, to 19.
    sim.round = 30;
    sim.score = [15, 15];
    inner(sim).afterRound();
    expect(sim.overtime).toBe(2);
    expect(sim.winScore).toBe(19);
    // Won in it.
    sim.round = 33;
    sim.score = [19, 14];
    inner(sim).afterRound();
    expect(sim.phase).toBe('over');
    expect(sim.matchWinner).toBe(0);
  });

  it('still ends a match won outright at full time, and can be drawn with overtime off', () => {
    const a = match().sim;
    a.round = 20; a.score = [13, 7];
    inner(a).afterRound();
    expect(a.phase).toBe('over');
    const b = new Sim({ teamSize: 1, bots: false, rules: { overtimeRounds: 0 } });
    b.round = 24; b.score = [12, 12];
    inner(b).afterRound();
    expect(b.phase).toBe('over');
    expect(b.matchWinner).toBe(-1);
  });

  it('credits an assist for more than 40 damage to someone a teammate kills, and points as Counter-Strike does', () => {
    const { sim, atk, def } = match();
    const [a, b] = atk as [Player, Player];
    const v = def[0]!;
    inner(sim).damage(v, a, rifle, 41, CHEST, 0, 0, 1, 0, false); // (no armour: 41)
    expect(a.damage).toBe(41);
    inner(sim).damage(v, b, rifle, 80, CHEST, 0, 0, 1, 0, false);
    expect(v.alive).toBe(false);
    expect(b.kills).toBe(1);
    expect(b.points).toBe(2);
    expect(b.damage).toBe(59); // (only the health that was left)
    expect(a.assists).toBe(1);
    expect(a.points).toBe(1);
    // 40 is not enough.
    const v2 = def[1]!;
    inner(sim).damage(v2, a, rifle, 40, CHEST, 0, 0, 1, 0, false);
    inner(sim).damage(v2, b, rifle, 80, CHEST, 0, 0, 1, 0, false);
    expect(a.assists).toBe(1);
  });

  it('credits a flash assist to whoever blinded the victim', () => {
    const { sim, atk, def } = match();
    const [a, b] = atk as [Player, Player];
    const v = def[0]!;
    inner(sim).flashedBy.set(v.id, { by: a.id, until: sim.time + 2 });
    inner(sim).damage(v, b, rifle, 120, CHEST, 0, 0, 1, 0, false);
    expect(a.assists).toBe(1);
  });

  it('names the round MVP: most kills on the winning side, or the planter of a charge that went off', () => {
    const { sim, atk, def } = match();
    const [a, b] = atk as [Player, Player];
    inner(sim).damage(def[0]!, b, rifle, 120, CHEST, 0, 0, 1, 0, false);
    inner(sim).damage(def[1]!, b, rifle, 120, CHEST, 0, 0, 1, 0, false);
    sim.events.length = 0;
    sim.phase = 'live';
    sim.tick();
    const end = sim.events.find((e) => e.type === 'roundEnd');
    expect(end && end.type === 'roundEnd' && end.mvp).toBe(b.id);
    expect(b.mvps).toBe(1);
    expect(a.mvps).toBe(0);
    expect(sim.roundLog).toEqual([ATK * 4 + 0]);

    const s2 = match().sim;
    const planter = s2.players.find((p) => p.team === ATK)!;
    inner(s2).planter = planter.id;
    inner(s2).endRound(ATK, 'detonation');
    expect(planter.mvps).toBe(1);
    expect(s2.roundLog).toEqual([ATK * 4 + 2]);
  });

  it('sends the scoreboard to clients, even about players they cannot see', () => {
    const { sim, atk, def } = match();
    const [a, b] = atk as [Player, Player];
    inner(sim).damage(def[0]!, a, rifle, 50, CHEST, 0, 0, 1, 0, false);
    inner(sim).damage(def[0]!, b, rifle, 80, CHEST, 0, 0, 1, 0, false);
    sim.roundLog.push(5);
    sim.overtime = 1;
    const client = new Sim({ teamSize: 2, bots: false });
    applySnapshot(client, takeSnapshot(sim, [0, 0, 0, 0], []));
    expect(client.players[a.id]!.assists).toBe(1);
    expect(client.players[b.id]!.points).toBe(2);
    expect(client.overtime).toBe(1);
    expect(client.roundLog).toEqual([5]);
    const blind = client.players[a.id]!;
    blind.assists = 0;
    decodePlayer(blind, encodeHidden(a));
    expect(blind.assists).toBe(1);
    expect(blind.damage).toBe(50);
  });
});
