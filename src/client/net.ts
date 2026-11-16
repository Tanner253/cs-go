// Browser connection to the game server: lobby browsing and match transport.

import { PROTOCOL, type ClientMsg, type LobbyInfo, type ServerMsg } from '../net/protocol';
import { Replica } from '../net/replica';
import type { SimEvent } from '../sim/types';

export type NetState = 'idle' | 'connecting' | 'waking' | 'online' | 'failed';

/** Where the game server lives. Overridable for testing with ?server=wss://host. */
export function serverUrl(): string {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  const env = import.meta.env['VITE_SERVER_URL'] as string | undefined;
  if (env) return env;
  const h = location.hostname;
  const local = h === 'localhost' || h === '127.0.0.1' || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(h);
  return local ? `ws://${h}:8787` : 'wss://nullpoint-duel-server.onrender.com';
}

export class NetClient {
  state: NetState = 'idle';
  lobbies: LobbyInfo[] = [];
  /** Arena we are sitting in, or -1. */
  joined = -1;
  countdown = 0;
  ping = 0;
  message = '';
  replica: Replica | null = null;

  onChange: () => void = () => {};
  onStart: (r: Replica) => void = () => {};
  onEvents: (events: SimEvent[]) => void = () => {};
  /** The match ended (opponent left or connection dropped). */
  onMatchEnd: (reason: string) => void = () => {};

  private ws: WebSocket | null = null;
  private name = 'Operator';
  private attempts = 0;
  private retry = 0;
  private pinger = 0;
  private wantArena = -1;
  private closed = true;

  connect(name: string, autoJoin = -1): void {
    this.name = name || 'Operator';
    this.wantArena = autoJoin;
    if (this.ws && (this.state === 'online' || this.state === 'connecting' || this.state === 'waking')) return;
    this.closed = false;
    this.attempts = 0;
    this.open();
  }

  private open(): void {
    clearTimeout(this.retry);
    this.state = this.attempts === 0 ? 'connecting' : 'waking';
    this.message = this.attempts === 0 ? 'Connecting…' : 'Waking the server — free hosting sleeps when idle, this can take up to a minute…';
    this.onChange();
    let ws: WebSocket;
    try {
      ws = new WebSocket(serverUrl());
    } catch {
      this.fail('Invalid server address');
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.send({ t: 'hello', v: PROTOCOL, name: this.name });
      this.pinger = window.setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
    };
    ws.onmessage = (ev) => this.handle(JSON.parse(ev.data as string) as ServerMsg);
    ws.onclose = () => {
      clearInterval(this.pinger);
      if (this.ws !== ws) return;
      this.ws = null;
      const wasOnline = this.state === 'online';
      const inMatch = this.replica !== null;
      this.replica = null;
      this.joined = -1;
      this.countdown = 0;
      if (inMatch) this.onMatchEnd('Connection to the server was lost');
      if (this.closed) {
        this.state = 'idle';
        this.onChange();
        return;
      }
      // Cold starts on free hosting refuse connections for a while: keep trying.
      if (!wasOnline && this.attempts < 30) {
        this.attempts++;
        this.state = 'waking';
        this.message = 'Waking the server — free hosting sleeps when idle, this can take up to a minute…';
        this.onChange();
        this.retry = window.setTimeout(() => this.open(), 3000);
      } else {
        this.fail(wasOnline ? 'Disconnected from the server' : 'Could not reach the game server');
      }
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private fail(message: string): void {
    this.state = 'failed';
    this.message = message;
    this.onChange();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    this.ws?.close();
  }

  send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  join(id: number): void {
    this.send({ t: 'join', id });
  }

  leave(): void {
    this.send({ t: 'leave' });
    this.joined = -1;
    this.countdown = 0;
    this.replica = null;
    this.onChange();
  }

  private handle(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome':
        this.state = 'online';
        this.message = '';
        this.lobbies = m.lobbies;
        if (this.wantArena >= 0) {
          this.join(this.wantArena);
          this.wantArena = -1;
        }
        this.onChange();
        break;
      case 'lobbies':
        this.lobbies = m.lobbies;
        this.onChange();
        break;
      case 'joined':
        this.joined = m.id;
        this.message = '';
        this.onChange();
        break;
      case 'countdown':
        this.countdown = m.seconds;
        this.onChange();
        break;
      case 'start':
        this.countdown = 0;
        this.replica = new Replica(m.you, m.names);
        this.onStart(this.replica);
        this.onChange();
        break;
      case 'snap':
        if (this.replica) {
          const events = this.replica.onSnapshot(m.s, performance.now() / 1000);
          if (events.length > 0) this.onEvents(events);
        }
        break;
      case 'left':
        this.replica = null;
        this.countdown = 0;
        this.message = m.reason;
        this.onMatchEnd(m.reason);
        this.onChange();
        break;
      case 'pong':
        this.ping = Math.round(performance.now() - m.c);
        break;
      case 'error':
        this.message = m.message;
        this.onChange();
        break;
    }
  }
}
