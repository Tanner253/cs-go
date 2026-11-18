// NULLPOINT game server: five 1v1 arenas, each running the authoritative simulation.
// Plain Node + ws. Deployable to any host that keeps a process alive (see render.yaml).

import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Sim } from '../src/sim/game';
import { SLOT_NADE, TICK, emptyCmd, type Cmd, type SimEvent } from '../src/sim/types';
import { NADES } from '../src/sim/weapons';
import { GRACE, canSee } from './visibility';
import { Monitor, delayOf, type Kind } from './anticheat';
import {
  MAX_LOBBIES, PROTOCOL, RULES_1V1, SNAP_EVERY, cleanName, takeSnapshot, validItem,
  type ClientMsg, type LobbyInfo, type ServerMsg,
} from '../src/net/protocol';

const PORT = Number(process.env['PORT']) || 8787;
const MAX_CONNECTIONS = 64;
const COUNTDOWN = 3;
const REMATCH_DELAY = 12;
/** More messages per second than any honest client sends (64 inputs + pings + slack). */
const MAX_MSGS_PER_SEC = 240;
/** Interpolation delay the client draws opponents at, plus slack, in seconds. */
const LAG_SLACK = 0.1 + 0.06;
/**
 * Anti-cheat: `enforce` removes a player the detectors are sure of and keeps their address out
 * for a while, `log` only writes what it saw, `off` does neither.
 */
const ANTICHEAT = ((): 'enforce' | 'log' | 'off' => {
  const v = process.env['ANTICHEAT'];
  return v === 'log' || v === 'off' ? v : 'enforce';
})();
const BAN_MINUTES = Number(process.env['BAN_MINUTES']) || 15;
/** Connections one address may hold at once, and open per minute. */
const MAX_PER_ADDRESS = Number(process.env['MAX_PER_ADDRESS']) || 8;
const MAX_OPENS_PER_MINUTE = 40;
/** A connection that has not introduced itself by now is dropped. */
const HELLO_WITHIN_MS = 10000;
/** Close code for a connection the server will not have (the client does not retry). */
const REFUSED = 4001;
/** Allowed page origins (comma separated), or empty to accept any. */
const ALLOWED_ORIGINS = (process.env['ALLOWED_ORIGINS'] ?? '').split(',').map((o) => o.trim()).filter(Boolean);

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
  /** Round trip time measured by the server (seconds), and when the last probe went out. */
  rtt: number;
  pingAt: number;
  /** Flood control: messages seen in the current one-second window. */
  msgCount: number;
  msgWindow: number;
  /** Sim time at which this client last had sight of each other player. */
  sawAt: number[];
  /** Where it connected from (as far as the proxy in front of us says). */
  address: string;
  /** Watches this connection's input for what only a program does. */
  monitor: Monitor;
  /** Strikes already written to the log. */
  logged: number;
  /** Whether this tick's command was really sent for it, and how long ago the client was seeing its opponents (ticks). */
  fresh: boolean;
  delay: number;
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
/** Addresses removed for cheating -> when they may come back (ms). */
const banned = new Map<string, number>();
/** Recent connection times per address (ms), for the rate limit. */
const opens = new Map<string, number[]>();
const watch = { flagged: 0, removed: 0 };

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
  // Clients never learn this, so they cannot predict or pick their bullet spread.
  l.sim.spreadSecret = ((Math.random() * 2 ** 32) | 0) || 1;
  for (const c of l.clients) c.sawAt = [];
  l.events = [];
  l.acc = 0;
  l.restartAt = 0;
  for (const c of l.clients) send(c, { t: 'start', you: c.slot, names });
  console.log(`[${l.name}] match started: ${names.join(' vs ')}`);
  broadcastLobbies();
}

function leave(c: Client, reason: string, toOthers = 'Your opponent left the match'): void {
  const l = c.lobby;
  if (!l) return;
  c.lobby = null;
  l.clients = l.clients.filter((x) => x !== c);
  if (l.sim) {
    console.log(`[${l.name}] match ended: ${reason}`);
    l.sim = null;
    // The remaining player goes back to waiting in the same arena.
    for (const other of l.clients) send(other, { t: 'left', reason: toOthers });
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
/** A finite number within [lo, hi]: what an honest client always sends for this field. */
const within = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const whole = (v: unknown, lo: number, hi: number): boolean => within(v, lo, hi) && Number.isInteger(v);

/** Take a player the detectors are sure of out of the match, and keep their address out for a while. */
function remove(c: Client, kind: Kind): void {
  watch.removed++;
  console.log(`[anticheat] removed "${c.name}" (${c.address}) for ${kind}: ${c.monitor.notes.slice(-4).join(' | ')}`);
  send(c, { t: 'left', reason: 'You were removed from the match by anti-cheat' });
  leave(c, `${c.name} removed by anti-cheat (${kind})`, 'Your opponent was removed by anti-cheat');
  banned.set(c.address, Date.now() + BAN_MINUTES * 60000);
  setTimeout(() => c.ws.close(REFUSED, 'Removed by anti-cheat'), 250);
}

/** Write new strikes to the log, and act on a verdict. Returns true if the player was removed. */
function police(c: Client): boolean {
  if (ANTICHEAT === 'off') return false;
  const m = c.monitor;
  if (m.total > c.logged) {
    if (c.logged === 0) watch.flagged++;
    c.logged = m.total;
    console.log(`[anticheat] "${c.name}" (${c.address}): ${m.notes[m.notes.length - 1] ?? ''}`);
  }
  const kind = m.verdict();
  if (!kind || ANTICHEAT !== 'enforce') return false;
  remove(c, kind);
  return true;
}

function onMessage(c: Client, raw: string): void {
  // Flood control: far more traffic than a real client produces gets the connection dropped.
  const sec = Math.floor(Date.now() / 1000);
  if (sec !== c.msgWindow) { c.msgWindow = sec; c.msgCount = 0; }
  if (++c.msgCount > MAX_MSGS_PER_SEC) {
    c.ws.close(1008, 'Too many messages');
    return;
  }
  let m: ClientMsg;
  try {
    m = JSON.parse(raw) as ClientMsg;
  } catch {
    c.monitor.violation('not JSON');
    police(c);
    return;
  }
  if (!m || typeof m !== 'object') {
    c.monitor.violation('not a message');
    police(c);
    return;
  }
  switch (m.t) {
    case 'hello':
      c.name = cleanName(m.name);
      // An out-of-date page is told to refresh, and cannot join: its simulation may not match ours.
      c.hello = m.v === PROTOCOL;
      send(c, { t: 'welcome', v: PROTOCOL, lobbies: lobbyInfo() });
      if (!c.hello) send(c, { t: 'error', message: 'Game version mismatch — refresh the page' });
      break;
    case 'join':
      if (c.hello) join(c, num(m.id, 0, MAX_LOBBIES - 1) | 0);
      else send(c, { t: 'error', message: 'Game version mismatch — refresh the page' });
      break;
    case 'leave':
      leave(c, `${c.name} left`);
      break;
    case 'ping':
      send(c, { t: 'pong', c: num(m.c, 0, 1e15) });
      break;
    case 'c': {
      // An honest client only ever sends these within their ranges: anything else was made by hand.
      if (
        !whole(m.q, 0, 2 ** 31) || !within(m.f, -1, 1) || !within(m.s, -1, 1) || !within(m.y, -1e6, 1e6) || !within(m.p, -1.56, 1.56) ||
        !whole(m.b, 0, 511) || !whole(m.w, -1, SLOT_NADE + NADES.length - 1) || !within(m.v, -60, 1e9) || typeof m.u !== 'string' || (m.u !== '' && validItem(m.u) === '')
      ) {
        c.monitor.violation('a command outside what the game can send');
        police(c);
        return;
      }
      if (!c.lobby?.sim) return;
      c.monitor.received(performance.now() / 1000);
      if (c.queue.length > 32) return;
      const seq = num(m.q, 0, 2 ** 31) | 0;
      const last = c.queue.length > 0 ? c.queue[c.queue.length - 1]!.seq : c.ack;
      if (seq <= last) return;
      c.queue.push({
        fwd: num(m.f, -1, 1), side: num(m.s, -1, 1),
        yaw: num(m.y, -1e6, 1e6), pitch: num(m.p, -1.56, 1.56),
        buttons: num(m.b, 0, 511) | 0, slot: num(m.w, -1, SLOT_NADE + NADES.length - 1) | 0,
        buy: validItem(m.u), seq, lag: 0,
      });
      c.viewTimes.push(num(m.v, 0, 1e9));
      break;
    }
    default:
      c.monitor.violation('an unknown message');
      police(c);
      break;
  }
}

/** Quiet movement sounds from someone the recipient cannot see and is too far away to hear. */
const HEARING = 28;

/** Each client gets its own snapshot: enemies it has no sight of are sent without a position. */
function sendSnapshots(l: Lobby): void {
  const sim = l.sim!;
  const acks = l.clients.map((c) => c.ack);
  for (const c of l.clients) {
    if (c.ws.readyState !== 1) continue;
    const me = sim.players[c.slot]!;
    const hidden: boolean[] = [];
    for (const p of sim.players) {
      if (p === me || !p.alive || !me.alive || p.team === me.team) { hidden[p.id] = false; continue; }
      if (canSee(sim, me, p)) c.sawAt[p.id] = sim.time;
      hidden[p.id] = sim.time - (c.sawAt[p.id] ?? -99) > GRACE;
    }
    const events = l.events.filter((e) => {
      // What someone bought, drew, reloaded or scoped is theirs to know (and a spectator's).
      if (e.type === 'buy' || e.type === 'draw' || e.type === 'reload' || e.type === 'dry' || e.type === 'scope' || e.type === 'fit') {
        return e.player === me.id || !me.alive || sim.players[e.player]!.team === me.team;
      }
      if (e.type !== 'step' && e.type !== 'jump' && e.type !== 'land') return true;
      const p = sim.players[e.player]!;
      return !hidden[p.id] || Math.hypot(p.pos.x - me.pos.x, p.pos.z - me.pos.z) < HEARING;
    });
    c.ws.send(JSON.stringify({ t: 'snap', s: takeSnapshot(sim, acks, events, hidden, me) } satisfies ServerMsg));
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
      // Rewind targets to where this client was seeing them. The claim is capped by the
      // latency the server itself has measured, so nobody can ask to shoot further into the past.
      const maxLag = Math.min(26, Math.ceil((c.rtt * 0.5 + LAG_SLACK) / TICK));
      next.lag = view > 0 ? Math.max(0, Math.min(maxLag, Math.round((sim.time + TICK - view) / TICK))) : 0;
      c.cmd = next;
      c.ack = next.seq;
      c.fresh = true;
      c.delay = delayOf(sim.time, view);
    } else {
      c.fresh = false;
      // Starved: hold the last movement/aim, but do not repeat one-shot actions.
      c.cmd.slot = -1;
      c.cmd.buy = '';
      c.cmd.seq = 0;
    }
  }
  sim.tick((p) => l.clients[p.id]?.cmd ?? null);
  if (ANTICHEAT !== 'off') {
    for (const c of l.clients) c.monitor.observe(sim, sim.players[c.slot]!, c.cmd, c.fresh, c.delay, sim.events);
    // (removing a player ends the match: nothing more to step)
    for (const c of l.clients) if (police(c)) return;
  }
  if (sim.events.length > 0) {
    for (const e of sim.events) l.events.push(e);
    sim.events.length = 0;
  }
  if (sim.tickCount % SNAP_EVERY === 0) {
    sendSnapshots(l);
    l.events = [];
  }
  if (sim.phase === 'over') {
    if (l.restartAt === 0) l.restartAt = Date.now() + REMATCH_DELAY * 1000;
    else if (Date.now() >= l.restartAt) {
      l.restartAt = 0;
      sim.restart();
      // `tick` is a no-op while the match is over, so push the fresh round out now.
      l.events.push(...sim.events);
      sim.events.length = 0;
      sendSnapshots(l);
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
    while (l.sim && l.acc >= TICK && n++ < 8) {
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
  res.end(JSON.stringify({
    name: 'nullpoint-server', protocol: PROTOCOL, connections: clients.size, lobbies: lobbyInfo(),
    anticheat: { mode: ANTICHEAT, flagged: watch.flagged, removed: watch.removed },
  }));
});

const wss = new WebSocketServer({ server: http, maxPayload: 4096 });
wss.on('connection', (ws, req) => {
  if (clients.size >= MAX_CONNECTIONS) {
    ws.close(1013, 'Server full');
    return;
  }
  if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(req.headers.origin ?? '')) {
    ws.close(1008, 'Origin not allowed');
    return;
  }
  // Behind the host's proxy the socket's own address is the proxy's: the last hop it reports is the client.
  const forwarded = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  const address = hops[hops.length - 1] ?? req.socket.remoteAddress ?? 'unknown';
  const refuse = (message: string): void => {
    ws.send(JSON.stringify({ t: 'error', message } satisfies ServerMsg));
    ws.close(REFUSED, message);
  };
  const until = banned.get(address) ?? 0;
  if (until > Date.now()) {
    refuse(`Removed by anti-cheat: you can play again in ${Math.ceil((until - Date.now()) / 60000)} min`);
    return;
  }
  const recent = (opens.get(address) ?? []).filter((t) => t > Date.now() - 60000);
  recent.push(Date.now());
  opens.set(address, recent);
  let held = 0;
  for (const other of clients) if (other.address === address) held++;
  if (held >= MAX_PER_ADDRESS || recent.length > MAX_OPENS_PER_MINUTE) {
    refuse('Too many connections from your network');
    return;
  }
  const c: Client = {
    ws, name: 'Operator', lobby: null, slot: 0, queue: [], viewTimes: [], cmd: emptyCmd(), ack: 0, alive: true, hello: false,
    rtt: 0.15, pingAt: 0, msgCount: 0, msgWindow: 0, sawAt: [],
    address, monitor: new Monitor(), logged: 0, fresh: false, delay: 0,
  };
  clients.add(c);
  setTimeout(() => { if (!c.hello && ws.readyState === 1) ws.close(1008, 'No hello'); }, HELLO_WITHIN_MS);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) onMessage(c, data.toString());
    else { c.monitor.violation('a binary message'); police(c); }
  });
  ws.on('pong', () => {
    c.alive = true;
    if (c.pingAt > 0) {
      const sample = (performance.now() - c.pingAt) / 1000;
      // Track the low end: latency spikes should not widen what a client may claim.
      c.rtt = sample < c.rtt ? sample : c.rtt + (sample - c.rtt) * 0.1;
      c.pingAt = 0;
    }
  });
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
  }
}, 15000);

// Forget bans and connection counts that have run out.
setInterval(() => {
  const now = Date.now();
  for (const [a, until] of banned) if (until <= now) banned.delete(a);
  for (const [a, times] of opens) if (times.every((t) => t <= now - 60000)) opens.delete(a);
}, 60000);

// Measure each client's latency ourselves (never trust the client's own figure).
setInterval(() => {
  for (const c of clients) {
    if (c.ws.readyState !== 1) continue;
    c.pingAt = performance.now();
    c.ws.ping();
  }
}, 2000);

http.listen(PORT, () => console.log(`nullpoint-server listening on :${PORT} (${MAX_LOBBIES} arenas)`));

export { http, wss };
