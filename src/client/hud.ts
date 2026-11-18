// DOM heads-up display. Every setter is change-detected so the DOM is only touched
// when a value actually changes.

import type { Sim } from '../sim/game';
import { ATK, DEF, type Player } from '../sim/types';
import { GEAR, NADES, NADE_CARRY, NADE_INDEX, WEAPONS, WEAPON_LIST, type WeaponDef } from '../sim/weapons';
import { eyeHeight } from '../sim/movement';
import { onSettings } from './settings';
import { Radar } from './radar';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Cached text setter. */
function text(el: HTMLElement, cache: { v: string }, v: string): void {
  if (cache.v !== v) {
    cache.v = v;
    el.textContent = v;
  }
}
const c = (): { v: string } => ({ v: '\u0000' });

// ---- the armory -------------------------------------------------------------------------

interface BuyEntry {
  id: string;
  name: string;
  price: number;
  team: number;
  /** What kind of thing it is, in plain words (for guns: the real pattern it follows). */
  kind: string;
  blurb: string;
}

/** What each item is and what it is for. */
const ABOUT: Record<string, [kind: string, blurb: string]> = {
  kite: ['M9-pattern pistol', 'The attackers’ sidearm. A big magazine and a modest punch.'],
  tern: ['M1911-pattern pistol', 'The defenders’ sidearm. Hits harder, holds twelve.'],
  stinger: ['Škorpion machine pistol', 'The attackers’ automatic sidearm. Vicious up close, empty in two seconds.'],
  maul: ['Desert Eagle hand cannon', 'One to the head at any range. Seven rounds and a heavy kick.'],
  wasp: ['Compact submachine gun', 'Cheap and very fast. Made for running and spraying.'],
  vipers: ['Pair of MAC-10 machine pistols', 'The attackers’ pair: one in each hand, the fastest fire in the armory, fifty rounds. Close range only.'],
  wrens: ['Pair of compact submachine guns', 'The defenders’ pair: one in each hand, forty rounds, steadier than the Vipers.'],
  hornet: ['MP7 personal defence weapon', 'Tighter than the Wasp and better against armour. Right click fits its suppressor.'],
  breaker: ['M3-pattern pump shotgun', 'The defenders’ shotgun. Nine pellets a shell; owns corners and doorways. Right click fits its suppressor.'],
  thresher: ['Sawn-off double-barrel shotgun', 'The attackers’ shotgun. Two shells, each the hardest hit in the armory. Then you reload.'],
  mako: ['AKS-74U carbine', 'The budget rifle. Rifle damage for SMG money, with a wild climb.'],
  hammerhead: ['AK-74M-pattern assault rifle', 'The attackers’ rifle. Heavy hits, heavy recoil.'],
  osprey: ['9A-91 suppressed rifle', 'The budget rifle. Quiet, steady, twenty rounds. Right click takes its suppressor off.'],
  lumen: ['AR-15-pattern assault rifle', 'The defenders’ rifle. Fast, flat and accurate. Right click fits its suppressor.'],
  longsight: ['AWP-pattern bolt-action sniper rifle', 'The defenders’ sniper. One shot to the body or head kills. Slow to cycle, slow to carry.'],
  colossus: ['M82-pattern .50 rifle', 'The attackers’ sniper. One shot to the body or head kills, with no bolt to work: five rounds, a slow second shot, the heaviest gun there is.'],
  armor: ['Body armour', 'Soaks up most of the damage from shots to the body.'],
  armorhelmet: ['Body armour and helmet', 'Protects the head as well: fewer guns kill with a single headshot.'],
  kit: ['Disarm kit', 'Disarm the charge in 5 seconds instead of 10.'],
  frag: ['High-explosive grenade', 'Goes off 1.6 s after it leaves the hand. Up to 98 damage at the heart of it, a quarter of that five metres out; armour takes half. Left click throws, right click lobs, both for in between.'],
  flash: ['Flashbang', 'Blinds everyone who can see it go off: up to five seconds looking at it, about one with it behind you. Carry two.'],
  smoke: ['Smoke grenade', 'Lands, then puts up a cloud nobody can see through for eighteen seconds. Puts out fires.'],
  molotov: ['Molotov', 'The attackers’ fire bomb: bursts where it first lands and burns the floor there for seven seconds, 40 damage a second to anyone in it.'],
  incendiary: ['Incendiary grenade', 'The defenders’ fire grenade: bursts where it first lands and burns the floor there for seven seconds, 40 damage a second to anyone in it.'],
};

const entry = (id: string): BuyEntry => {
  const d = WEAPONS[id] ?? GEAR[id]!;
  const [kind, blurb] = ABOUT[id] ?? ['', ''];
  return { id, name: d.name, price: d.price, team: d.team, kind, blurb };
};

/** The armory's columns. Items for the other side are left out when it is drawn. */
const BUY_COLUMNS: { title: string; items: BuyEntry[] }[] = [
  { title: 'Pistols', items: ['kite', 'tern', 'stinger', 'maul'].map(entry) },
  { title: 'Close range', items: ['wasp', 'hornet', 'vipers', 'wrens', 'breaker', 'thresher'].map(entry) },
  { title: 'Rifles', items: ['mako', 'osprey', 'hammerhead', 'lumen'].map(entry) },
  { title: 'Snipers', items: ['longsight', 'colossus'].map(entry) },
  { title: 'Gear', items: ['armor', 'armorhelmet', 'kit'].map(entry) },
  { title: 'Grenades', items: ['frag', 'flash', 'smoke', 'molotov', 'incendiary'].map(entry) },
];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A gun's numbers as bars, each 0..1 against the best in the armory. */
function statBars(d: WeaponDef): [label: string, value: number][] {
  let climb = 0;
  for (let i = 0; i < d.pattern.length; i += 2) climb = Math.max(climb, d.pattern[i]!);
  return [
    ['Damage', clamp01((d.damage * d.pellets) / 120)],
    ['Fire rate', clamp01(d.rpm / 800)],
    ['Accuracy', clamp01(1 - Math.sqrt(d.spreadStand / 0.06))],
    ['Recoil control', clamp01(1 - (climb * 180) / Math.PI / 9)],
    ['Armour piercing', clamp01(d.armorPen)],
    ['Movement', clamp01((d.maxSpeed - 4.4) / (6.35 - 4.4))],
  ];
}

/** Simple line drawings for the gear, which has no model. */
const GEAR_ART: Record<string, string> = {
  armor: '<svg viewBox="0 0 96 48"><path d="M30 6h10l8 5 8-5h10l6 8-6 6v20H30V20l-6-6z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/><path d="M38 24h20M38 31h20" stroke="currentColor" stroke-width="2"/></svg>',
  armorhelmet: '<svg viewBox="0 0 96 48"><path d="M14 10h8l6 4 6-4h8l5 6-5 5v17H14V21l-5-5z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/><path d="M56 32c0-13 6-21 16-21s16 8 16 21h-9v-6H65v6z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>',
  kit: '<svg viewBox="0 0 96 48"><rect x="28" y="14" width="40" height="26" rx="3" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M40 14V9h16v5M48 21v12M42 27h12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
};

export class Hud {
  private root = $('hud');
  private el = {
    hp: $('hp'), armor: $('armor'), money: $('money'), mag: $('mag'), res: $('res'), wname: $('wname'),
    timer: $('timer'), round: $('round'), sAtk: $('score-atk'), sDef: $('score-def'),
    pAtk: $('pips-atk'), pDef: $('pips-def'), feed: $('killfeed'), msg: $('msg'), sub: $('sub'),
    hint: $('hint'), prog: $('progress'), progFill: $('progress-fill'), progLabel: $('progress-label'),
    spectate: $('spectate'), cross: $('crosshair'), scope: $('scope'), vig: $('vignette'), white: $('whiteout'),
    flashStill: $<HTMLCanvasElement>('flash-still'), flashWhite: $('flash-white'),
    carry: $('carry'), kit: $('kit'), slots: $('slots'), fps: $('fps'), hit: $('hitmarker'), dmg: $('dmgdir'),
    buy: $('buy'), buyGrid: $('buy-grid'), buyMoney: $('buy-money'), buyDetail: $('buy-detail'), buyHint: $('buy-hint'), board: $('scoreboard'),
  };
  private k = {
    hp: c(), armor: c(), money: c(), mag: c(), res: c(), wname: c(), timer: c(), round: c(), sAtk: c(), sDef: c(),
    pAtk: c(), pDef: c(), hint: c(), spectate: c(), slots: c(), fps: c(), progLabel: c(), buy: c(), buyDetail: c(), board: c(),
  };
  private gap = -1;
  private msgUntil = 0;
  private vig = 0;
  private white = 0;
  private hit = 0;
  private dmg = 0;
  private dmgYaw = 0;
  private radar = new Radar($<HTMLCanvasElement>('radar'));
  /** Extra text for the corner readout (ping etc.). */
  netText = '';
  private now = 0;
  buyOpen = false;
  boardOpen = false;
  onBuy: (item: string) => void = () => {};
  /** A picture of a weapon for the armory ('' until it is ready). */
  thumb: (id: string) => string = () => '';
  /** The armory's columns as drawn for the player's side. */
  private buyCols: { title: string; items: BuyEntry[] }[] = [];
  /** The column picked with a number key, waiting for the item's number (-1 = none). */
  private buyCol = -1;
  /** The item the detail pane shows. */
  private buyFocus = '';
  private thumbsSeen = 0;

  constructor() {
    onSettings((st) => {
      const root = document.documentElement.style;
      root.setProperty('--cross', st.crosshairColor);
      root.setProperty('--cross-size', `${st.crosshairSize}px`);
      this.el.cross.classList.toggle('nodot', !st.crosshairDot);
      this.el.fps.style.display = st.showFps ? '' : 'none';
    });
    this.el.buyGrid.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.buy-item');
      if (!b) return;
      this.focusBuy(b.dataset['id']!);
      if (!b.classList.contains('off')) this.onBuy(b.dataset['id']!);
    });
    this.el.buyGrid.addEventListener('pointerover', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.buy-item');
      if (b) this.focusBuy(b.dataset['id']!);
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
  hitMarker(kill: boolean, head = false): void {
    this.hit = kill ? 1.6 : 1;
    this.el.hit.classList.toggle('kill', kill);
    this.el.hit.classList.toggle('head', head);
  }

  /** Show which way damage came from. `worldYaw` is the direction from the player to the attacker. */
  damageFrom(worldYaw: number): void {
    this.dmg = 1;
    this.dmgYaw = worldYaw;
  }

  // ---- the damage report: what passed between the player and each enemy this round ----
  private dmgLog = new Map<number, { given: number; hitsGiven: number; taken: number; hitsTaken: number }>();
  private deathCard = $('deathcard');

  /** A round starts: the report is cleared and put away. */
  roundReset(): void {
    this.dmgLog.clear();
    this.deathCard.classList.remove('on');
  }

  /** Note a hit that the local player gave or took. */
  logHit(attacker: Player | null, victim: Player, damage: number, me: Player | null): void {
    if (!me || !attacker || attacker.team === victim.team) return;
    const other = attacker === me ? victim : victim === me ? attacker : null;
    if (!other) return;
    let r = this.dmgLog.get(other.id);
    if (!r) this.dmgLog.set(other.id, (r = { given: 0, hitsGiven: 0, taken: 0, hitsTaken: 0 }));
    if (attacker === me) { r.given += damage; r.hitsGiven++; } else { r.taken += damage; r.hitsTaken++; }
  }

  /** The local player died: who did it, with what, and what passed between them and each enemy. */
  died(sim: Sim, killer: Player | null, weapon: string, head: boolean): void {
    const w = WEAPONS[weapon]?.name ?? (weapon === 'world' ? 'a fall' : weapon);
    const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
    const rows = [...this.dmgLog.entries()]
      .sort((a, b) => (b[1].given + b[1].taken) - (a[1].given + a[1].taken))
      .map(([id, r]) => {
        const p = sim.players[id];
        if (!p) return '';
        const hits = (n: number): string => (n === 1 ? '1 hit' : `${n} hits`);
        return `<tr${p === killer ? ' class="killer"' : ''}><td class="t${p.team}">${esc(p.name)}</td>` +
          `<td>${r.given ? `<b>${r.given}</b> in ${hits(r.hitsGiven)}` : '<i>—</i>'}</td>` +
          `<td>${r.taken ? `<b>${r.taken}</b> in ${hits(r.hitsTaken)}` : '<i>—</i>'}</td></tr>`;
      }).join('');
    this.deathCard.innerHTML =
      `<div class="dc-head">${killer ? `KILLED BY <b class="t${killer.team}">${esc(killer.name)}</b>` : 'YOU DIED'}` +
      `<span>${esc(w)}${head ? ' · headshot' : ''}</span></div>` +
      (rows ? `<table><tr><th></th><th>DEALT</th><th>TAKEN</th></tr>${rows}</table>` : '');
    this.deathCard.classList.add('on');
  }

  damageFlash(amount: number): void {
    this.vig = Math.min(1, this.vig + 0.25 + amount / 80);
  }
  whiteFlash(amount: number): void {
    this.white = Math.max(this.white, amount);
  }

  /** The player we look through was flashed: keep the next frame drawn as the after-image. */
  wantStill = false;
  flashed(): void {
    this.wantStill = true;
  }
  /** Keep this frame (the game's canvas, just drawn) as the after-image. */
  takeStill(canvas: HTMLCanvasElement): void {
    this.wantStill = false;
    const c = this.el.flashStill;
    if (c.width !== Math.round(canvas.width / 3)) { c.width = Math.round(canvas.width / 3); c.height = Math.round(canvas.height / 3); }
    c.getContext('2d')?.drawImage(canvas, 0, 0, c.width, c.height);
  }
  private flashK = '';

  setBuyOpen(open: boolean): void {
    this.buyOpen = open;
    this.buyCol = -1;
    this.el.buy.classList.toggle('hidden', !open);
    this.k.buy.v = '\u0000';
  }
  /** Tell the armory that another weapon picture is ready. */
  thumbsChanged(): void {
    this.thumbsSeen++;
  }
  setBoardOpen(open: boolean): void {
    this.boardOpen = open;
    this.el.board.classList.toggle('hidden', !open);
  }

  /**
   * A number key in the armory: the first picks a column, the second buys from it.
   * Returns true if the armory consumed the key.
   */
  buyDigit(d: number): boolean {
    if (!this.buyOpen) return false;
    if (this.buyCol < 0) {
      const col = this.buyCols[d - 1];
      if (col) {
        this.buyCol = d - 1;
        if (col.items[0]) this.buyFocus = col.items[0].id;
      }
    } else {
      const item = this.buyCols[this.buyCol]?.items[d - 1];
      if (item) {
        this.buyFocus = item.id;
        this.onBuy(item.id);
      }
      this.buyCol = -1;
    }
    this.k.buy.v = '\u0000';
    return true;
  }

  private focusBuy(id: string): void {
    if (this.buyFocus === id) return;
    this.buyFocus = id;
    for (const b of this.el.buyGrid.querySelectorAll<HTMLElement>('.buy-item')) b.classList.toggle('focus', b.dataset['id'] === id);
    this.k.buyDetail.v = '\u0000';
  }

  /** What an item costs this player now, and whether they already have it. */
  private buyState(p: Player, e: BuyEntry): { price: number; owned: boolean } {
    const nade = WEAPONS[e.id]?.nade;
    if (nade) {
      // (full: as many of this kind as can be carried, or four grenades in all)
      const i = NADE_INDEX.get(e.id)!;
      return { owned: p.nades[i]! >= nade.max || p.nades.reduce((a, b) => a + b, 0) >= NADE_CARRY, price: e.price };
    }
    const owned = p.weapons[0]?.def.id === e.id || p.weapons[1]?.def.id === e.id ||
      (e.id === 'armor' && p.armor >= 100) || (e.id === 'armorhelmet' && p.armor >= 100 && p.helmet) || (e.id === 'kit' && p.kit);
    return { owned, price: e.id === 'armorhelmet' && p.armor >= 100 && !p.helmet ? 350 : e.price };
  }

  private renderBuy(sim: Sim, p: Player): void {
    const can = sim.canBuy(p);
    const key = `${p.money}|${p.team}|${p.armor}|${p.helmet}|${p.kit}|${p.weapons[0]?.def.id}|${p.weapons[1]?.def.id}|${p.nades.join('')}|${can}|${this.buyCol}|${this.thumbsSeen}`;
    if (this.k.buy.v !== key) {
      this.k.buy.v = key;
      this.k.buyDetail.v = '\u0000';
      const cols = BUY_COLUMNS.map((c) => ({ title: c.title, items: c.items.filter((e) => e.team === -1 || e.team === p.team) }));
      this.buyCols = cols;
      if (!cols.some((c) => c.items.some((e) => e.id === this.buyFocus))) {
        this.buyFocus = p.weapons[0]?.def.id ?? cols[2]?.items.at(-1)?.id ?? '';
      }
      this.el.buyMoney.textContent = `$${p.money}`;
      this.el.buyHint.textContent = this.buyCol < 0 ? `1–${cols.length} pick a column · B closes` : `1–${cols[this.buyCol]!.items.length} buy · B closes`;
      this.el.buyGrid.innerHTML = cols.map((col, ci) => {
        const picked = ci === this.buyCol;
        return `<div class="buy-col${picked ? ' picked' : ''}${this.buyCol >= 0 && !picked ? ' dim' : ''}">` +
          `<div class="buy-cat"><span class="k">${ci + 1}</span>${col.title}</div>` +
          col.items.map((e, i) => {
            const { owned, price } = this.buyState(p, e);
            const off = !can || owned || p.money < price;
            const src = this.thumb(e.id);
            const art = GEAR_ART[e.id] ?? (src ? `<img src="${src}" alt="" draggable="false">` : '');
            return `<button class="buy-item${owned ? ' owned' : ''}${off ? ' off' : ''}${!owned && p.money < price ? ' poor' : ''}${e.id === this.buyFocus ? ' focus' : ''}" data-id="${e.id}">` +
              `<span class="k">${picked ? i + 1 : ''}</span><span class="art">${art}</span>` +
              `<span class="n">${e.name}</span><span class="p">${owned ? (WEAPONS[e.id]?.nade ? 'Full' : 'Owned') : '$' + price}</span></button>`;
          }).join('') + '</div>';
      }).join('');
    }
    this.renderBuyDetail(p, can);
  }

  private renderBuyDetail(p: Player, can: boolean): void {
    const e = this.buyCols.flatMap((c) => c.items).find((x) => x.id === this.buyFocus);
    const key = `${this.buyFocus}|${p.money}|${can}|${this.thumbsSeen}|${e ? this.buyState(p, e).owned : ''}`;
    if (this.k.buyDetail.v === key) return;
    this.k.buyDetail.v = key;
    if (!e) {
      this.el.buyDetail.innerHTML = '';
      return;
    }
    const d = WEAPONS[e.id];
    const { owned, price } = this.buyState(p, e);
    const src = this.thumb(e.id);
    const art = GEAR_ART[e.id] ?? (src ? `<img src="${src}" alt="" draggable="false">` : '');
    const status = owned ? `<span class="st">${d?.nade ? 'Carrying all you can' : 'Owned'}</span>`
      : !can ? '<span class="st">Armory closed</span>'
        : p.money < price ? `<span class="st poor">$${price} · $${price - p.money} short</span>`
          : `<span class="st ok">$${price}</span>`;
    const bars = d && !d.nade ? statBars(d).map(([label, v]) =>
      `<div class="bar"><span>${label}</span><i><b style="width:${Math.round(v * 100)}%"></b></i></div>`).join('') : '';
    const facts = d?.nade ? `<div class="facts">Carry <b>${d.nade.max}</b> · Kill award <b>$${d.killReward}</b></div>`
      : d ? `<div class="facts">Magazine <b>${d.magSize} / ${d.reserve}</b> · Kill award <b>$${d.killReward}</b></div>` : '';
    this.el.buyDetail.innerHTML =
      `<div class="art">${art}</div>` +
      `<div class="title">${e.name}</div><div class="kind">${e.kind}</div>` +
      `<p>${e.blurb}</p>${bars}${facts}${status}`;
  }

  private renderBoard(sim: Sim, me: Player | null): void {
    // As Counter-Strike's: each side by points, with kills, assists, deaths, round MVPs, damage
    // per round and points; and under it how every round so far was won.
    const played = Math.max(1, sim.roundLog.length);
    const rows = (team: number): string => {
      const ps = sim.players.filter((p) => p.team === team).sort((a, b) => b.points - a.points || b.kills - a.kills);
      return `<tr class="th-team"><td class="t${team}" colspan="2">${team === ATK ? 'ATTACK' : 'DEFENCE'} — ${sim.score[team]}</td><td colspan="6"></td></tr>` +
        ps.map((p) => `<tr class="${p.alive ? '' : 'dead'}${p === me ? ' me' : ''}"><td>${p.name}${p.hasCharge && me?.team === ATK ? ' ◆' : ''}</td>` +
          `<td>${me && p.team === me.team ? `$${p.money}` : ''}</td><td>${p.kills}</td><td>${p.assists}</td><td>${p.deaths}</td>` +
          `<td class="mvp">${p.mvps > 0 ? `★${p.mvps > 1 ? p.mvps : ''}` : ''}</td><td>${Math.round(p.damage / played)}</td><td>${p.points}</td></tr>`).join('');
    };
    // (the round strip: each round a mark in the winner's colour, saying how it was won; a gap at half time)
    const marks = ['✕', '◷', '✹', '✓'];
    const half = sim.rules.maxRounds / 2;
    let strip = '';
    sim.roundLog.forEach((r, i) => {
      const gap = i === half || (i > sim.rules.maxRounds && (i - sim.rules.maxRounds) % (sim.rules.overtimeRounds / 2) === 0) ? ' gap' : '';
      const winner = r >> 2, how = r & 3;
      strip += `<span class="rd t${winner}${gap}" title="Round ${i + 1}">${marks[how]}</span>`;
    });
    const ot = sim.overtime > 0 ? `<div class="ot">OVERTIME ${sim.overtime} · first to ${sim.winScore}</div>` : '';
    const html = `<table><tr><th>PLAYER</th><th>MONEY</th><th>K</th><th>A</th><th>D</th><th>MVP</th><th>ADR</th><th>SCORE</th></tr>${rows(ATK)}${rows(DEF)}</table>` +
      `<div class="rounds">${strip}</div>${ot}`;
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
      text(e.mag, k.mag, w.def.nade ? String(w.mag) : w.def.magSize < 0 ? '—' : String(w.mag));
      text(e.res, k.res, w.def.magSize < 0 ? '' : String(w.reserve));
      e.mag.classList.toggle('low', w.def.magSize > 0 && w.mag <= w.def.magSize * 0.25);
    }
    const slotKey = view.weapons.map((s, i) => `${s ? s.def.name : ''}${i === view.active ? '*' : ''}`).join('|') + view.nades.join('');
    if (k.slots.v !== slotKey) {
      k.slots.v = slotKey;
      // (the grenade slot lists every kind carried)
      const nades = NADES.map((d, i) => (view.nades[i]! > 0 ? `${d.name}${view.nades[i]! > 1 ? ` ×${view.nades[i]}` : ''}` : '')).filter(Boolean).join(' · ');
      e.slots.innerHTML = view.weapons.map((s, i) => (s ? `<span class="${i === view.active ? 'on' : ''}">${i + 1} ${i === 3 ? nades : s.def.name}</span>` : '')).join('');
    }

    // Round clock and score.
    let t = Math.max(0, sim.phaseTime);
    if (sim.phase === 'end' || sim.phase === 'over') t = 0;
    const secs = Math.ceil(t);
    text(e.timer, k.timer, sim.phase === 'planted' ? `◆ ${secs}` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
    e.timer.classList.toggle('danger', sim.phase === 'planted' || (sim.phase === 'live' && secs <= 10));
    text(e.round, k.round, sim.phase === 'freeze' ? 'BUY PHASE' : sim.overtime > 0 ? `OVERTIME · ROUND ${sim.round}` : `ROUND ${sim.round}`);
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
      const loose = this.buyOpen || me.useTime > 0 || sim.canPlant(me) || sim.canDisarm(me) ? null : sim.dropInReach(me);
      if (this.buyOpen) hint = '';
      else if (loose) {
        // A weapon on the floor in reach: what E would do with it.
        const def = loose.weapon.def;
        const held = def.kind === 'grenade' ? null : me.weapons[def.slot];
        const empty = def.magSize > 0 && loose.weapon.mag + loose.weapon.reserve <= 0 ? ' <span class="dim">(empty)</span>' : '';
        hint = held ? `<b>${useKey}</b> Swap your ${held.def.name} for the ${def.name}${empty}` : `<b>${useKey}</b> Pick up the ${def.name}${empty}`;
      } else if (sim.phase === 'freeze') hint = touch ? 'Tap <b>BUY</b> to open the armory' : 'Press <b>B</b> to open the armory';
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
    // Flashed: white while it lasts, then the white thins first and the frozen picture after it.
    const blind = view.alive ? Math.max(0, view.flashEnd - sim.time) : 0;
    const fade = Math.min(2.6, Math.max(0.7, view.flashLen * 0.55));
    const fk = `${Math.min(1, (blind / fade) ** 1.3).toFixed(3)}|${Math.min(0.85, blind / (fade * 1.25)).toFixed(3)}`;
    if (fk !== this.flashK) {
      this.flashK = fk;
      const [w, s] = fk.split('|');
      e.flashWhite.style.opacity = w!;
      e.flashStill.style.opacity = s!;
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
    this.radar.draw(sim, view, me, this.now);
    text(e.fps, k.fps, (fps > 0 ? `${fps.toFixed(0)} fps` : '') + (this.netText ? ` · ${this.netText}` : ''));

    if (this.buyOpen && me) this.renderBuy(sim, me);
    if (this.boardOpen) this.renderBoard(sim, me);
  }
}

export { WEAPON_LIST };
