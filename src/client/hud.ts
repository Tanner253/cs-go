// DOM heads-up display. Every setter is change-detected so the DOM is only touched
// when a value actually changes.

import type { Sim } from '../sim/game';
import { ATK, DEF, type Player } from '../sim/types';
import { GEAR, WEAPONS, WEAPON_LIST } from '../sim/weapons';
import { eyeHeight } from '../sim/movement';
import { onSettings } from './settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Cached text setter. */
function text(el: HTMLElement, cache: { v: string }, v: string): void {
  if (cache.v !== v) {
    cache.v = v;
    el.textContent = v;
  }
}
const c = (): { v: string } => ({ v: '\u0000' });

interface BuyEntry {
  id: string;
  name: string;
  desc: string;
  price: number;
  team: number;
}

const BUY_ORDER: BuyEntry[] = [
  ...['maul', 'wasp', 'hornet', 'breaker', 'hammerhead', 'lumen', 'longsight'].map((id) => {
    const d = WEAPONS[id]!;
    const kind = { rifle: 'Assault rifle', smg: 'SMG', pistol: 'Heavy pistol', sniper: 'Bolt-action sniper', shotgun: 'Shotgun', knife: '' }[d.kind];
    return { id, name: d.name, desc: `${kind} · ${d.damage}${d.pellets > 1 ? `×${d.pellets}` : ''} dmg · ${d.rpm} rpm`, price: d.price, team: d.team };
  }),
  { id: 'armor', name: GEAR['armor']!.name, desc: 'Body armour (100)', price: 650, team: -1 },
  { id: 'armorhelmet', name: GEAR['armorhelmet']!.name, desc: 'Armour + head protection', price: 1000, team: -1 },
  { id: 'kit', name: GEAR['kit']!.name, desc: 'Disarm in 5s instead of 10s', price: 400, team: 1 },
];

export class Hud {
  private root = $('hud');
  private el = {
    hp: $('hp'), armor: $('armor'), money: $('money'), mag: $('mag'), res: $('res'), wname: $('wname'),
    timer: $('timer'), round: $('round'), sAtk: $('score-atk'), sDef: $('score-def'),
    pAtk: $('pips-atk'), pDef: $('pips-def'), feed: $('killfeed'), msg: $('msg'), sub: $('sub'),
    hint: $('hint'), prog: $('progress'), progFill: $('progress-fill'), progLabel: $('progress-label'),
    spectate: $('spectate'), cross: $('crosshair'), scope: $('scope'), vig: $('vignette'), white: $('whiteout'),
    carry: $('carry'), kit: $('kit'), slots: $('slots'), fps: $('fps'), hit: $('hitmarker'), dmg: $('dmgdir'),
    buy: $('buy'), buyGrid: $('buy-grid'), buyMoney: $('buy-money'), board: $('scoreboard'),
  };
  private k = {
    hp: c(), armor: c(), money: c(), mag: c(), res: c(), wname: c(), timer: c(), round: c(), sAtk: c(), sDef: c(),
    pAtk: c(), pDef: c(), hint: c(), spectate: c(), slots: c(), fps: c(), progLabel: c(), buy: c(), board: c(),
  };
  private gap = -1;
  private msgUntil = 0;
  private vig = 0;
  private white = 0;
  private hit = 0;
  private dmg = 0;
  private dmgYaw = 0;
  private radar = $<HTMLCanvasElement>('radar');
  private radarCtx = this.radar.getContext('2d')!;
  private radarBg: HTMLCanvasElement | null = null;
  private radarTick = 0;
  private seen: boolean[] = [];
  /** Extra text for the corner readout (ping etc.). */
  netText = '';
  private now = 0;
  buyOpen = false;
  boardOpen = false;
  onBuy: (item: string) => void = () => {};
  /** Items currently listed in the buy menu, in hotkey order. */
  private buyList: BuyEntry[] = [];

  constructor() {
    onSettings((st) => {
      const root = document.documentElement.style;
      root.setProperty('--cross', st.crosshairColor);
      root.setProperty('--cross-size', `${st.crosshairSize}px`);
      this.el.cross.classList.toggle('nodot', !st.crosshairDot);
      this.el.fps.style.display = st.showFps ? '' : 'none';
    });
    this.el.buyGrid.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.buy-item');
      if (b && !b.disabled) this.onBuy(b.dataset['id']!);
    });
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
  }

  message(msg: string, sub = '', seconds = 3): void {
    this.el.msg.textContent = msg;
    this.el.sub.textContent = sub;
    this.el.msg.style.opacity = this.el.sub.style.opacity = '1';
    this.msgUntil = this.now + seconds;
  }

  kill(killer: Player | null, victim: Player, weapon: string, head: boolean, wallbang: boolean, me: Player | null): void {
    const d = document.createElement('div');
    d.className = 'kf' + (me && (killer === me || victim === me) ? ' me' : '');
    const w = WEAPONS[weapon]?.name ?? (weapon === 'world' ? 'gravity' : weapon);
    d.innerHTML =
      (killer ? `<span class="t${killer.team}">${killer.name}</span>` : '') +
      `<span class="w">${w}${wallbang ? ' ▣' : ''}</span>${head ? '<span class="hs">◎</span>' : ''}` +
      `<span class="t${victim.team}">${victim.name}</span>`;
    this.el.feed.appendChild(d);
    while (this.el.feed.childElementCount > 5) this.el.feed.firstElementChild!.remove();
    setTimeout(() => d.remove(), 6000);
  }

  /** Confirm one of the local player's bullets landed. */
  hitMarker(kill: boolean): void {
    this.hit = kill ? 1.6 : 1;
    this.el.hit.classList.toggle('kill', kill);
  }

  /** Show which way damage came from. `worldYaw` is the direction from the player to the attacker. */
  damageFrom(worldYaw: number): void {
    this.dmg = 1;
    this.dmgYaw = worldYaw;
  }

  private drawRadar(sim: Sim, view: Player, me: Player | null): void {
    const S = this.radar.width;
    const k = S / 74;
    const X = (x: number): number => (x + 33) * (S / 66);
    const Z = (z: number): number => (z + 37) * k;
    if (!this.radarBg) {
      const bg = document.createElement('canvas');
      bg.width = bg.height = S;
      const g = bg.getContext('2d')!;
      g.fillStyle = 'rgba(70,82,98,0.55)';
      g.fillRect(X(-30), Z(-36), X(30) - X(-30), Z(36) - Z(-36));
      g.fillStyle = 'rgba(8,11,16,0.95)';
      for (const b of sim.map.boxes) {
        if (b.noCollide || b.hidden || b.maxY < 2.4 || b.minY > 0.5) continue;
        g.fillRect(X(b.minX), Z(b.minZ), X(b.maxX) - X(b.minX), Z(b.maxZ) - Z(b.minZ));
      }
      g.fillStyle = 'rgba(8,11,16,0.55)';
      for (const b of sim.map.boxes) {
        if (b.noCollide || b.hidden || b.maxY >= 2.4 || b.maxY < 0.9 || b.minY > 0.5) continue;
        g.fillRect(X(b.minX), Z(b.minZ), X(b.maxX) - X(b.minX), Z(b.maxZ) - Z(b.minZ));
      }
      g.font = '700 18px Rajdhani, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      sim.map.sites.forEach((site) => {
        const z = site.zone;
        g.strokeStyle = g.fillStyle = 'rgba(255,255,255,0.75)';
        g.lineWidth = 1;
        g.strokeRect(X(z.minX), Z(z.minZ), X(z.maxX) - X(z.minX), Z(z.maxZ) - Z(z.minZ));
        g.fillText(site.name, X(site.center.x), Z(site.center.z));
      });
      this.radarBg = bg;
    }
    const g = this.radarCtx;
    g.clearRect(0, 0, S, S);
    g.drawImage(this.radarBg, 0, 0);
    const pov = me ?? view;
    const ey = view.pos.y + eyeHeight(view);
    for (const p of sim.players) {
      if (!p.alive) continue;
      const friendly = p.team === pov.team;
      if (!friendly) {
        // Enemies only appear while the player being watched can actually see them.
        const vis = view.alive && sim.world.lineOfSight(view.pos.x, ey, view.pos.z, p.pos.x, p.pos.y + 1.2, p.pos.z);
        this.seen[p.id] = vis;
        if (!vis) continue;
      }
      const x = X(p.pos.x), z = Z(p.pos.z);
      if (p === view) {
        g.save();
        g.translate(x, z);
        g.rotate(-p.yaw);
        g.fillStyle = '#fff';
        g.beginPath();
        g.moveTo(0, -6); g.lineTo(4.5, 5); g.lineTo(0, 2.5); g.lineTo(-4.5, 5);
        g.closePath();
        g.fill();
        g.restore();
      } else {
        g.fillStyle = friendly ? (p.team === ATK ? '#ff7a2e' : '#35e0ff') : '#ff3b2e';
        g.beginPath();
        g.arc(x, z, friendly ? 3.2 : 3.8, 0, Math.PI * 2);
        g.fill();
      }
    }
    const c = sim.charge;
    if (c.state === 'planted' || (c.state === 'dropped' && pov.team === ATK)) {
      g.fillStyle = Math.floor(sim.time * 3) % 2 ? '#ff3b2e' : '#fff';
      const x = X(c.pos.x), z = Z(c.pos.z);
      g.beginPath();
      g.moveTo(x, z - 5); g.lineTo(x + 5, z); g.lineTo(x, z + 5); g.lineTo(x - 5, z);
      g.closePath();
      g.fill();
    }
  }

  damageFlash(amount: number): void {
    this.vig = Math.min(1, this.vig + 0.25 + amount / 80);
  }
  whiteFlash(amount: number): void {
    this.white = Math.max(this.white, amount);
  }

  setBuyOpen(open: boolean): void {
    this.buyOpen = open;
    this.el.buy.classList.toggle('hidden', !open);
    this.k.buy.v = '\u0000';
  }
  setBoardOpen(open: boolean): void {
    this.boardOpen = open;
    this.el.board.classList.toggle('hidden', !open);
  }

  /** Buy by hotkey digit (1-based). Returns true if the menu consumed the key. */
  buyDigit(d: number): boolean {
    if (!this.buyOpen) return false;
    const item = this.buyList[d - 1];
    if (item) this.onBuy(item.id);
    return true;
  }

  private renderBuy(sim: Sim, p: Player): void {
    const list = BUY_ORDER.filter((e) => e.team === -1 || e.team === p.team);
    this.buyList = list;
    const key = `${p.money}|${p.team}|${p.armor}|${p.helmet}|${p.kit}|${p.weapons[0]?.def.id}|${p.weapons[1]?.def.id}|${sim.canBuy(p)}`;
    if (this.k.buy.v === key) return;
    this.k.buy.v = key;
    this.el.buyMoney.textContent = `$${p.money}`;
    const can = sim.canBuy(p);
    this.el.buyGrid.innerHTML = list.map((e, i) => {
      const owned = p.weapons[0]?.def.id === e.id || p.weapons[1]?.def.id === e.id ||
        (e.id === 'armor' && p.armor >= 100) || (e.id === 'armorhelmet' && p.armor >= 100 && p.helmet) || (e.id === 'kit' && p.kit);
      const price = e.id === 'armorhelmet' && p.armor >= 100 && !p.helmet ? 350 : e.price;
      const dis = !can || owned || p.money < price;
      return `<button class="buy-item${owned ? ' owned' : ''}" data-id="${e.id}" ${dis ? 'disabled' : ''}>` +
        `<span class="k">${i + 1}</span><span class="n">${e.name}</span><span class="p">${owned ? 'OWNED' : '$' + price}</span>` +
        `<span class="d">${e.desc}</span></button>`;
    }).join('');
  }

  private renderBoard(sim: Sim, me: Player | null): void {
    const rows = (team: number): string => {
      const ps = sim.players.filter((p) => p.team === team).sort((a, b) => b.kills - a.kills);
      return `<tr class="th-team"><td class="t${team}" colspan="2">${team === ATK ? 'ATTACK' : 'DEFENCE'} — ${sim.score[team]}</td><td></td><td></td></tr>` +
        ps.map((p) => `<tr class="${p.alive ? '' : 'dead'}${p === me ? ' me' : ''}"><td>${p.name}${p.hasCharge && me?.team === ATK ? ' ◆' : ''}</td><td>$${me && p.team === me.team ? p.money : '—'}</td><td>${p.kills}</td><td>${p.deaths}</td></tr>`).join('');
    };
    const html = `<table><tr><th>PLAYER</th><th>MONEY</th><th>K</th><th>D</th></tr>${rows(ATK)}${rows(DEF)}</table>`;
    if (this.k.board.v !== html) {
      this.k.board.v = html;
      this.el.board.innerHTML = html;
    }
  }

  private pips(el: HTMLElement, cache: { v: string }, alive: number, total: number): void {
    const key = `${alive}/${total}`;
    if (cache.v === key) return;
    cache.v = key;
    let s = '';
    for (let i = 0; i < total; i++) s += `<i class="${i < alive ? '' : 'dead'}"></i>`;
    el.innerHTML = s;
  }

  /**
   * @param view the player whose eyes we are looking through
   * @param me the local human (null when everyone is a bot)
   * @param gapPx crosshair gap in CSS pixels
   */
  update(sim: Sim, view: Player, me: Player | null, gapPx: number, dt: number, fps: number, touch: boolean): void {
    this.now += dt;
    const e = this.el, k = this.k;

    // Crosshair.
    const scoped = view.scope > 0;
    const def = view.weapons[view.active]?.def;
    const showCross = view.alive && !scoped && def?.kind !== 'sniper';
    const g = Math.round(Math.min(60, 3 + gapPx));
    if (g !== this.gap) {
      this.gap = g;
      e.cross.style.setProperty('--gap', `${g}px`);
    }
    e.cross.style.display = showCross ? '' : 'none';
    e.scope.classList.toggle('on', scoped && view.alive);

    // Vitals.
    text(e.hp, k.hp, String(Math.max(0, Math.ceil(view.hp))));
    e.hp.classList.toggle('low', view.hp <= 30);
    text(e.armor, k.armor, String(Math.ceil(view.armor)) + (view.helmet ? '+' : ''));
    text(e.money, k.money, `$${(me ?? view).money}`);
    const w = view.weapons[view.active];
    if (w) {
      text(e.wname, k.wname, w.def.name);
      text(e.mag, k.mag, w.def.magSize < 0 ? '—' : String(w.mag));
      text(e.res, k.res, w.def.magSize < 0 ? '' : String(w.reserve));
      e.mag.classList.toggle('low', w.def.magSize > 0 && w.mag <= w.def.magSize * 0.25);
    }
    const slotKey = view.weapons.map((s, i) => `${s ? s.def.name : ''}${i === view.active ? '*' : ''}`).join('|');
    if (k.slots.v !== slotKey) {
      k.slots.v = slotKey;
      e.slots.innerHTML = view.weapons.map((s, i) => (s ? `<span class="${i === view.active ? 'on' : ''}">${i + 1} ${s.def.name}</span>` : '')).join('');
    }

    // Round clock and score.
    let t = Math.max(0, sim.phaseTime);
    if (sim.phase === 'end' || sim.phase === 'over') t = 0;
    const secs = Math.ceil(t);
    text(e.timer, k.timer, sim.phase === 'planted' ? `◆ ${secs}` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
    e.timer.classList.toggle('danger', sim.phase === 'planted' || (sim.phase === 'live' && secs <= 10));
    text(e.round, k.round, sim.phase === 'freeze' ? 'BUY PHASE' : `ROUND ${sim.round}`);
    text(e.sAtk, k.sAtk, String(sim.score[ATK]));
    text(e.sDef, k.sDef, String(sim.score[DEF]));
    const size = sim.players.length / 2;
    this.pips(e.pAtk, k.pAtk, sim.aliveCount(ATK), size);
    this.pips(e.pDef, k.pDef, sim.aliveCount(DEF), size);

    e.carry.classList.toggle('on', view.hasCharge);
    e.kit.classList.toggle('on', view.kit);

    // Contextual hint + progress bar.
    let hint = '';
    const useKey = touch ? 'USE' : 'E';
    if (me && me.alive) {
      if (this.buyOpen) hint = '';
      else if (sim.phase === 'freeze') hint = touch ? 'Tap <b>BUY</b> to open the armory' : 'Press <b>B</b> to open the armory';
      else if (me.useTime > 0) hint = '';
      else if (sim.canPlant(me)) hint = `Hold <b>${useKey}</b> to plant the charge`;
      else if (sim.canDisarm(me)) hint = `Hold <b>${useKey}</b> to disarm`;
      else if (me.hasCharge && sim.phase === 'live' && sim.liveTime < 6) hint = 'You carry the charge — take it to site A or B';
    }
    if (k.hint.v !== hint) {
      k.hint.v = hint;
      e.hint.innerHTML = hint;
    }
    const using = view.useTime > 0;
    e.prog.classList.toggle('on', using);
    if (using) {
      const total = view.team === ATK ? sim.rules.plantTime : sim.disarmDuration(view);
      e.progFill.style.width = `${Math.min(100, (view.useTime / total) * 100).toFixed(1)}%`;
      text(e.progLabel, k.progLabel, view.team === ATK ? 'PLANTING' : 'DISARMING');
    }

    text(e.spectate, k.spectate, me && !me.alive && view !== me ? `SPECTATING ${view.name.toUpperCase()}` : !me ? `WATCHING ${view.name.toUpperCase()}` : '');

    // Fading overlays.
    if (this.msgUntil > 0 && this.now > this.msgUntil) {
      this.msgUntil = 0;
      e.msg.style.opacity = e.sub.style.opacity = '0';
    }
    if (this.vig > 0.001) {
      this.vig = Math.max(0, this.vig - dt * 1.6);
      e.vig.style.opacity = this.vig.toFixed(3);
    }
    if (this.white > 0.001) {
      this.white = Math.max(0, this.white - dt * 0.9);
      e.white.style.opacity = this.white.toFixed(3);
    }
    if (this.hit > 0.001) {
      this.hit = Math.max(0, this.hit - dt * 5);
      e.hit.style.opacity = Math.min(1, this.hit).toFixed(2);
    }
    if (this.dmg > 0.001) {
      this.dmg = Math.max(0, this.dmg - dt * 0.9);
      e.dmg.style.opacity = this.dmg.toFixed(2);
      // Screen-relative: 0 = in front, positive = to the right.
      const rel = view.yaw - this.dmgYaw;
      e.dmg.style.transform = `rotate(${(rel * 180 / Math.PI).toFixed(1)}deg)`;
    }
    if (++this.radarTick % 4 === 0) this.drawRadar(sim, view, me);
    text(e.fps, k.fps, (fps > 0 ? `${fps.toFixed(0)} fps` : '') + (this.netText ? ` · ${this.netText}` : ''));

    if (this.buyOpen && me) this.renderBuy(sim, me);
    if (this.boardOpen) this.renderBoard(sim, me);
  }
}

export { WEAPON_LIST };
