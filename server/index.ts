// NULLPOINT game server: five 1v1 arenas, each running the authoritative simulation.
// Plain Node + ws. Deployable to any host that keeps a process alive (see render.yaml).

import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Sim } from '../src/sim/game';
import { TICK, emptyCmd, type Cmd, type SimEvent } from '../src/sim/types';
import {
  MAX_LOBBIES, PROTOCOL, RULES_1V1, SNAP_EVERY, cleanName, takeSnapshot, validItem,
  type ClientMsg, type LobbyInfo, type ServerMsg,
} from '../src/net/protocol';

const PORT = Number(process.env['PORT']) || 8787;
const MAX_CONNECTIONS = 64;
const COUNTDOWN = 3;
const REMATCH_DELAY = 12;

interface Client {
  ws: WebSocket;
  name: string;
  lobby: Lobby | null;
  /** Player id inside the match. */
  slot: number;
  queue: Cmd[];
  viewTimes: number[];
  cmd: Cmd;
  ack: number;
  alive: boolean;
  hello: boolean;
}

interface Lobby {
  id: number;
  name: string;
  clients: Client[];
  sim: Sim | null;
  events: SimEvent[];
  acc: number;
  /** Seconds until the match starts (>0 while counting down). */
  countdown: number;
  restartAt: number;
}

const lobbies: Lobby[] = [];
for (let i = 0; i < MAX_LOBBIES; i++) {
  lobbies.push({ id: i, name: `Arena ${i + 1}`, clients: [], sim: null, events: [], acc: 0, countdown: 0, restartAt: 0 });
}
const clients = new Set<Client>();

const send = (c: Client, msg: ServerMsg): void => {
  if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
};

function lobbyInfo(): LobbyInfo[] {
  return lobbies.map((l) => ({
    id: l.id,
    name: l.name,
    players: l.clients.map((c) => c.name),
    state: l.sim ? 'live' : l.countdown > 0 ? 'starting' : l.clients.length === 1 ? 'waiting' : 'open',
  }));
}

function broadcastLobbies(): void {
  const msg: ServerMsg = { t: 'lobbies', lobbies: lobbyInfo() };
  for (const c of clients) if (c.hello && !c.lobby?.sim) send(c, msg);
}

function startMatch(l: Lobby): void {
  // Random sides: slot 0 attacks first.
  if (Math.random() < 0.5) l.clients.reverse();
  l.clients.forEach((c, i) => {
    c.slot = i;
    c.queue.length = 0;
    c.viewTimes.length = 0;
    c.cmd = emptyCmd();
    c.ack = 0;
  });
  const names = l.clients.map((c) => c.name);
  l.sim = new Sim({ teamSize: 1, bots: false, names, rules: RULES_1V1, seed: (Math.random() * 2 ** 31) | 0 });
  l.events = [];
  l.acc = 0;
  l.restartAt = 0;
  for (const c of l.clients) send(c, { t: 'start', you: c.slot, names });
  console.log(`[${l.name}] match started: ${names.join(' vs ')}`);
  broadcastLobbies();
}

function leave(c: Client, reason: string): void {
  const l = c.lobby;
  if (!l) return;
  c.lobby = null;
  l.clients = l.clients.filter((x) => x !== c);
  if (l.sim) {
    console.log(`[${l.name}] match ended: ${reason}`);
    l.sim = null;
    // The remaining player goes back to waiting in the same arena.
    for (const other of l.clients) send(other, { t: 'left', reason: 'Your opponent left the match' });
  }
  l.countdown = 0;
  broadcastLobbies();
}

function join(c: Client, id: number): void {
  const l = lobbies[id];
  if (!l) return send(c, { t: 'error', message: 'No such arena' });
  if (c.lobby === l) return;
  if (l.clients.length >= 2) return send(c, { t: 'error', message: `${l.name} is full` });
  if (c.lobby) leave(c, 'switched arena');
  c.lobby = l;
  l.clients.push(c);
  send(c, { t: 'joined', id });
  if (l.clients.length === 2) {
    l.countdown = COUNTDOWN;
    for (const x of l.clients) send(x, { t: 'countdown', seconds: COUNTDOWN });
  }
  broadcastLobbies();
}

const num = (v: unknown, lo: number, hi: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return n < lo ? lo : n > hi ? hi : n;
};

function onMessage(c: Client, raw: string): void {
  let m: ClientMsg;
  try {
    m = JSON.parse(raw) as ClientMsg;
  } catch {
    return;
  }
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'hello':
      c.name = cleanName(m.name);
      c.hello = true;
      send(c, { t: 'welcome', v: PROTOCOL, lobbies: lobbyInfo() });
      if (m.v !== PROTOCOL) send(c, { t: 'error', message: 'Game version mismatch — refresh the page' });
      break;
    case 'join':
      if (c.hello) join(c, num(m.id, 0, MAX_LOBBIES - 1) | 0);
      break;
    case 'leave':
      leave(c, `${c.name} left`);
      break;
    case 'ping':
      send(c, { t: 'pong', c: num(m.c, 0, 1e15) });
      break;
    case 'c': {
      if (!c.lobby?.sim || c.queue.length > 32) return;
      const seq = num(m.q, 0, 2 ** 31) | 0;
      const last = c.queue.length > 0 ? c.queue[c.queue.length - 1]!.seq : c.ack;
      if (seq <= last) return;
      c.queue.push({
        fwd: num(m.f, -1, 1), side: num(m.s, -1, 1),
        yaw: num(m.y, -1e6, 1e6), pitch: num(m.p, -1.56, 1.56),
        buttons: num(m.b, 0, 255) | 0, slot: num(m.w, -1, 3) | 0,
        buy: validItem(m.u), seq, lag: 0,
      });
      c.viewTimes.push(num(m.v, 0, 1e9));
      break;
    }
    default:
      break;
  }
}

function stepLobby(l: Lobby): void {
  const sim = l.sim!;
  for (const c of l.clients) {
    // Bound the input backlog: a burst after a stall must not turn into a speed-up.
    if (c.queue.length > 10) {
      const drop = c.queue.length - 3;
      c.queue.splice(0, drop);
      c.viewTimes.splice(0, drop);
    }
    const next = c.queue.shift();
    if (next) {
      const view = c.viewTimes.shift() ?? 0;
      // Rewind targets to where this client was seeing them (capped at 400 ms).
      next.lag = view > 0 ? Math.max(0, Math.min(26, Math.round((sim.time + TICK - view) / TICK))) : 0;
      c.cmd = next;
      c.ack = next.seq;
    } else {
      // Starved: hold the last movement/aim, but do not repeat one-shot actions.
      c.cmd.slot = -1;
      c.cmd.buy = '';
      c.cmd.seq = 0;
    }
  }
  sim.tick((p) => l.clients[p.id]?.cmd ?? null);
  if (sim.events.length > 0) {
    for (const e of sim.events) l.events.push(e);
    sim.events.length = 0;
  }
  if (sim.tickCount % SNAP_EVERY === 0) {
    const acks = l.clients.map((c) => c.ack);
    const msg = JSON.stringify({ t: 'snap', s: takeSnapshot(sim, acks, l.events) } satisfies ServerMsg);
    for (const c of l.clients) if (c.ws.readyState === 1) c.ws.send(msg);
    l.events = [];
  }
  if (sim.phase === 'over') {
    if (l.restartAt === 0) l.restartAt = Date.now() + REMATCH_DELAY * 1000;
    else if (Date.now() >= l.restartAt) {
      l.restartAt = 0;
      sim.restart();
      // `tick` is a no-op while the match is over, so push the fresh round out now.
      const acks = l.clients.map((c) => c.ack);
      l.events.push(...sim.events);
      sim.events.length = 0;
      const msg = JSON.stringify({ t: 'snap', s: takeSnapshot(sim, acks, l.events) } satisfies ServerMsg);
      for (const c of l.clients) if (c.ws.readyState === 1) c.ws.send(msg);
      l.events = [];
    }
  }
}

// ---- main loop -------------------------------------------------------------------------
let lastLoop = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.25, (now - lastLoop) / 1000);
  lastLoop = now;
  for (const l of lobbies) {
    if (l.countdown > 0) {
      l.countdown -= dt;
      if (l.countdown <= 0) {
        l.countdown = 0;
        if (l.clients.length === 2) startMatch(l);
      }
    }
    if (!l.sim) continue;
    l.acc += dt;
    let n = 0;
    while (l.acc >= TICK && n++ < 8) {
      l.acc -= TICK;
      stepLobby(l);
    }
    if (l.acc > TICK * 8) l.acc = 0;
  }
}, 4);

// ---- http + websocket ------------------------------------------------------------------
const http = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ name: 'nullpoint-server', protocol: PROTOCOL, connections: clients.size, lobbies: lobbyInfo() }));
});

const wss = new WebSocketServer({ server: http, maxPayload: 4096 });
wss.on('connection', (ws) => {
  if (clients.size >= MAX_CONNECTIONS) {
    ws.close(1013, 'Server full');
    return;
  }
  const c: Client = { ws, name: 'Operator', lobby: null, slot: 0, queue: [], viewTimes: [], cmd: emptyCmd(), ack: 0, alive: true, hello: false };
  clients.add(c);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) onMessage(c, data.toString());
  });
  ws.on('pong', () => { c.alive = true; });
  ws.on('close', () => {
    leave(c, `${c.name} disconnected`);
    clients.delete(c);
  });
  ws.on('error', () => ws.terminate());
});

// Drop dead connections.
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) {
      c.ws.terminate();
      continue;
    }
    c.alive = false;
    c.ws.ping();
  }
}, 15000);

http.listen(PORT, () => console.log(`nullpoint-server listening on :${PORT} (${MAX_LOBBIES} arenas)`));

export { http, wss };
