import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/game';
import { BTN_FIRE, TICK, emptyCmd, type Cmd } from '../src/sim/types';
import { PROTOCOL, RULES_1V1, encodeHidden, takeSnapshot, type ServerMsg } from '../src/net/protocol';
import { canSee } from '../server/visibility';
import { Replica } from '../src/net/replica';

describe('lag compensation', () => {
  /** Shooter at mid, victim strafing across the lane 10 m away. */
  function setup() {
    const sim = new Sim({ teamSize: 1, bots: false, rules: { ...RULES_1V1, freezeTime: 0.02 } });
    const [shooter, victim] = [sim.players[0]!, sim.players[1]!];
    const cmds = [emptyCmd(), emptyCmd()];
    const step = (n = 1) => { for (let i = 0; i < n; i++) { sim.tick((p) => cmds[p.id]!); sim.events.length = 0; } };
    step(4);
    shooter.pos.x = 0; shooter.pos.z = 20; shooter.pos.y = 0.002;
    victim.pos.x = -3; victim.pos.z = 12; victim.pos.y = 0.002;
    shooter.money = 9000;
    sim.phase = 'freeze';
    sim.tryBuy(shooter, 'hammerhead');
    sim.phase = 'live';
    step(64); // draw the rifle
    // Victim runs east (+X) across the shooter's view.
    cmds[1]!.yaw = -Math.PI / 2;
    cmds[1]!.fwd = 1;
    step(40);
    return { sim, shooter, victim, cmds, step };
  }

  it('hits where the shooter saw the target, not where the target is now', () => {
    const lagTicks = 10; // ~156 ms
    for (const useLag of [true, false]) {
      const { sim, shooter, victim, cmds, step } = setup();
      // Aim at the chest position the victim had `lagTicks` ago.
      const history: number[] = [];
      for (let i = 0; i < lagTicks; i++) { history.push(victim.pos.x); step(1); }
      const oldX = history[0]!;
      expect(Math.abs(victim.pos.x - oldX)).toBeGreaterThan(0.6); // moved well clear of the old spot
      const dx = oldX - shooter.pos.x, dz = victim.pos.z - shooter.pos.z;
      cmds[0]!.yaw = Math.atan2(-dx, -dz);
      cmds[0]!.pitch = Math.atan2(1.3 - 1.63, Math.hypot(dx, dz));
      cmds[0]!.buttons = BTN_FIRE;
      cmds[0]!.seq = 1;
      // `lag` counts back from the tick being processed.
      cmds[0]!.lag = useLag ? lagTicks + 1 : 0;
      const hp = victim.hp;
      sim.tick((p) => cmds[p.id]!);
      expect(victim.hp < hp, useLag ? 'lag-compensated shot should hit' : 'uncompensated shot should miss').toBe(useLag);
      // The victim must be back at their real position afterwards.
      expect(Math.abs(victim.pos.x - oldX)).toBeGreaterThan(0.6);
    }
  });
});

describe('server-side cheat resistance', () => {
  const duel = () => {
    const sim = new Sim({ teamSize: 1, bots: false, rules: { ...RULES_1V1, freezeTime: 0.02 } });
    const cmds = [emptyCmd(), emptyCmd()];
    const step = (n = 1) => { for (let i = 0; i < n; i++) { sim.tick((p) => cmds[p.id]!); sim.events.length = 0; } };
    step(4);
    return { sim, a: sim.players[0]!, b: sim.players[1]!, cmds, step };
  };

  it('withholds the position of an enemy with no line of sight, and sends it when there is one', () => {
    const { sim, a, b } = duel();
    // At their spawns the two cannot see each other.
    expect(canSee(sim, a, b)).toBe(false);
    const snap = takeSnapshot(sim, [0, 0], [], [false, true]);
    expect(snap.p[1]).toEqual(encodeHidden(b));
    expect(snap.p[1]!.length).toBe(4);
    expect(JSON.stringify(snap.p[1])).not.toContain(String(b.pos.z));
    // Face to face down a lane they can.
    a.pos.x = 24; a.pos.z = 20; b.pos.x = 24; b.pos.z = 4;
    expect(canSee(sim, a, b)).toBe(true);
    // About to round a corner: sight is granted a moment early, never late.
    a.pos.x = 3.6; a.pos.z = 10.9; b.pos.x = 12; b.pos.z = 8; // b inside the east connector, a just short of its mouth
    a.vel.x = a.vel.z = 0;
    expect(canSee(sim, a, b)).toBe(false);
    a.vel.z = -6; // running toward the opening
    expect(canSee(sim, a, b)).toBe(true);
  });

  it('walls stop bullets: no damage through cover', () => {
    const { sim, a, b, cmds, step } = duel();
    a.money = 9000;
    sim.phase = 'freeze';
    sim.tryBuy(a, 'hammerhead');
    sim.phase = 'live';
    // The 0.8 m shield wall at z 23.4..24.2 stands between them.
    a.pos.x = 0; a.pos.z = 27; a.pos.y = 0.002;
    b.pos.x = 0; b.pos.z = 21; b.pos.y = 0.002;
    step(64);
    cmds[0]!.yaw = 0; cmds[0]!.pitch = Math.atan2(1.3 - 1.63, 6);
    cmds[0]!.buttons = BTN_FIRE;
    step(40);
    expect(a.weapons[0]!.mag).toBeLessThan(30);
    expect(b.hp).toBe(100);
  });

  it('a server-side secret, not the client, decides bullet spread', () => {
    const run = (secret: number): number[] => {
      const { sim, a, cmds } = duel();
      sim.spreadSecret = secret;
      a.money = 9000;
      sim.phase = 'freeze';
      sim.tryBuy(a, 'hammerhead');
      sim.phase = 'live';
      a.pos.x = 24; a.pos.z = 20;
      for (let i = 0; i < 64; i++) { sim.tick((p) => cmds[p.id]!); sim.events.length = 0; }
      cmds[0]!.buttons = BTN_FIRE;
      cmds[0]!.seq = 777; // the same client sequence every time
      const ends: number[] = [];
      for (let i = 0; i < 30; i++) {
        sim.tick((p) => cmds[p.id]!);
        for (const e of sim.events) if (e.type === 'shot') ends.push(...e.ends.slice(0, 3));
        sim.events.length = 0;
      }
      return ends;
    };
    const one = run(1234567), two = run(7654321);
    expect(one.length).toBeGreaterThan(6);
    // Same inputs and client sequence, different secret: the bullets go elsewhere.
    expect(one).not.toEqual(two);
  });
});

describe('online match (real server, two clients)', () => {
  // A fresh port per run, so a server left over from an interrupted run can never be mistaken for ours.
  const PORT = 20000 + Math.floor(Math.random() * 20000);
  let server: ChildProcess;

  beforeAll(async () => {
    execSync('npm run build:server', { stdio: 'ignore' });
    server = spawn(process.execPath, ['dist-server/index.cjs'], { env: { ...process.env, PORT: String(PORT), BAN_MINUTES: '0.0005' }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start')), 10000);
      server.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('listening')) { clearTimeout(t); resolve(); } });
    });
  }, 30000);

  afterAll(() => { server?.kill(); });

  it('reports health and lobby state over HTTP', async () => {
    expect(await (await fetch(`http://localhost:${PORT}/health`)).text()).toBe('ok');
    const info = (await (await fetch(`http://localhost:${PORT}/`)).json()) as { lobbies: unknown[] };
    expect(info.lobbies).toHaveLength(5);
  });

  it('starts a duel, predicts the local player accurately and shows the opponent moving', async () => {
    interface TestClient {
      ws: WebSocket; replica: Replica | null; cmd: Cmd; lobbies: number; corrections: number[]; left: string;
    }
    const now = () => performance.now() / 1000;
    const connect = (name: string): Promise<TestClient> => new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`);
      const c: TestClient = { ws, replica: null, cmd: emptyCmd(), lobbies: 0, corrections: [], left: '' };
      ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, name })); };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data as string) as ServerMsg;
        if (m.t === 'welcome') { ws.send(JSON.stringify({ t: 'join', id: 2 })); resolve(c); }
        else if (m.t === 'lobbies') c.lobbies++;
        else if (m.t === 'start') c.replica = new Replica(m.you, m.names);
        else if (m.t === 'left') c.left = m.reason;
        else if (m.t === 'snap' && c.replica) {
          const me = c.replica.player;
          const bx = me.pos.x, bz = me.pos.z;
          c.replica.onSnapshot(m.s, now());
          c.corrections.push(Math.hypot(me.pos.x - bx, me.pos.z - bz));
        }
      };
    });

    const a = await connect('Alpha');
    const b = await connect('Bravo');
    // Drive both clients at 64 Hz from a fixed-step accumulator, like the real client
    // (OS timers are too coarse to fire exactly every 15.6 ms).
    let acc = 0, last = now();
    const timer = setInterval(() => {
      const t = now();
      acc += Math.min(0.25, t - last);
      last = t;
      while (acc >= TICK) {
        acc -= TICK;
        for (const c of [a, b]) {
          if (!c.replica) continue;
          c.ws.send(JSON.stringify(c.replica.input(c.cmd, t)));
          c.replica.sim.events.length = 0;
          c.replica.frame(t, TICK);
        }
      }
    }, 2);
    const until = async (cond: () => boolean, ms: number, what: string) => {
      const t0 = Date.now();
      while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    try {
      await until(() => !!a.replica && !!b.replica, 8000, 'match start');
      expect(a.replica!.me).not.toBe(b.replica!.me);
      expect(a.replica!.sim.players.map((p) => p.name).sort()).toEqual(['Alpha', 'Bravo']);
      await until(() => a.replica!.sim.phase === 'live' && b.replica!.sim.phase === 'live', 12000, 'round to go live');

      // Both run forward for two seconds.
      const startA = { ...a.replica!.player.pos };
      const seenByB = { ...b.replica!.sim.players[a.replica!.me]!.pos };
      a.corrections.length = 0;
      for (const c of [a, b]) { c.cmd.yaw = c.replica!.player.yaw; c.cmd.fwd = 1; }
      await new Promise((r) => setTimeout(r, 2000));

      const movedA = Math.hypot(a.replica!.player.pos.x - startA.x, a.replica!.player.pos.z - startA.z);
      // (some spawns meet a wall after ~4.2 m, and a busy machine runs the test client slowly:
      // this only has to show that the player really ran)
      expect(movedA).toBeGreaterThan(2);
      // Anti-wallhack: the spawns have no line of sight, so B's client is never told where A
      // went. Its copy of A must still be at the last position it was allowed to know.
      const aOnB = b.replica!.sim.players[a.replica!.me]!.pos;
      expect(b.replica!.hidden[a.replica!.me]).toBe(true);
      expect(Math.hypot(aOnB.x - seenByB.x, aOnB.z - seenByB.z)).toBeLessThan(0.01);
      // Prediction should agree with the server almost exactly during steady movement.
      const worst = Math.max(...a.corrections);
      const mean = a.corrections.reduce((s, v) => s + v, 0) / a.corrections.length;
      console.log(`prediction corrections over ${a.corrections.length} snapshots: mean ${(mean * 1000).toFixed(2)} mm, worst ${(worst * 1000).toFixed(1)} mm`);
      expect(a.corrections.length).toBeGreaterThan(40);
      expect(mean).toBeLessThan(0.02);

      // Two honest clients have given the anti-cheat nothing to note.
      const watch = (await (await fetch(`http://localhost:${PORT}/`)).json()) as { anticheat: { flagged: number; removed: number } };
      expect(watch.anticheat).toMatchObject({ flagged: 0, removed: 0 });

      // Opponent leaving ends the match for the other player.
      b.ws.close();
      await until(() => a.left !== '', 3000, 'opponent-left notice');
    } finally {
      clearInterval(timer);
      a.ws.close();
      b.ws.close();
    }
  }, 40000);

  it('turns away an out-of-date page, and removes a client that sends what the game cannot', async () => {
    const open = (v: number) => new Promise<{ ws: WebSocket; msgs: ServerMsg[]; closed: Promise<number> }>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`);
      const msgs: ServerMsg[] = [];
      const closed = new Promise<number>((done) => { ws.onclose = (ev) => done(ev.code); });
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data as string) as ServerMsg;
        msgs.push(m);
        if (m.t === 'welcome') resolve({ ws, msgs, closed });
      };
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v, name: 'Probe' }));
    });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // An old build is told to refresh and is not let into an arena.
    const old = await open(PROTOCOL - 1);
    old.ws.send(JSON.stringify({ t: 'join', id: 4 }));
    await wait(300);
    expect(old.msgs.some((m) => m.t === 'error' && /refresh/.test(m.message))).toBe(true);
    expect(old.msgs.some((m) => m.t === 'joined')).toBe(false);
    old.ws.close();

    // Commands no client can produce: full speed in two directions at three times the limit, an
    // item that does not exist, a view angle past straight up.
    const bad = await open(PROTOCOL);
    for (let i = 0; i < 8; i++) bad.ws.send(JSON.stringify({ t: 'c', q: i + 1, f: 3, s: -3, y: 0, p: 9, b: 1, w: -1, u: 'godmode', v: 0 }));
    expect(await Promise.race([bad.closed, wait(3000).then(() => -1)])).toBe(4001);
    const info = (await (await fetch(`http://localhost:${PORT}/`)).json()) as { anticheat: { mode: string; removed: number } };
    expect(info.anticheat.mode).toBe('enforce');
    expect(info.anticheat.removed).toBe(1);
  }, 15000);
});
