// Main menu, lobby browser, settings and pause screen (plain DOM).

import type { Team } from '../sim/types';
import type { NetClient } from './net';
import { CREDITS } from './credits';
import { GameAudio } from './audio';
import { onSettings, setSetting, settings, type AspectSetting, type QualitySetting, type Settings } from './settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const CROSSHAIR_COLORS = ['#3dff8a', '#ffffff', '#35e0ff', '#ffe14a', '#ff5ad1', '#ff4a3d'];

export class Menu {
  onPractice: (team: Team, size: number, skill: number) => void = () => {};
  onClick: () => void = () => {};
  onResume: () => void = () => {};
  onLeave: () => void = () => {};
  onSoundTest: (name: string) => void = () => {};

  private root = $('menu');
  private pause = $('pause');
  private tab = 'online';
  private noticeText = '';
  private visible = false;
  private side = 0;
  private size = 5;
  private skill = 0.5;
  private lastArenas = '';

  constructor(private net: NetClient, touch: boolean) {
    // Tabs.
    document.querySelectorAll<HTMLButtonElement>('#nav button').forEach((b) => {
      b.addEventListener('click', () => { this.onClick(); this.openTab(b.dataset['tab']!); });
    });

    // Callsign.
    const name = $<HTMLInputElement>('opt-name');
    name.value = settings.name;
    name.addEventListener('change', () => setSetting('name', name.value.trim().slice(0, 14)));

    // Practice options.
    const seg = (id: string, set: (v: number) => void): void => {
      const el = $(id);
      el.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
        if (!b) return;
        this.onClick();
        el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        set(Number(b.dataset['v']));
      });
    };
    seg('opt-side', (v) => { this.side = v; });
    seg('opt-size', (v) => { this.size = v; });
    seg('opt-skill', (v) => { this.skill = v; });
    $('start-practice').addEventListener('click', () => { this.onClick(); this.onPractice(this.side as Team, this.size, this.skill); });

    // Settings appear both in the menu and on the pause screen.
    this.buildSettings($('settings-form'), true);
    this.buildSettings($('pause-settings'), false);

    const keys: [string, string][] = touch
      ? [['Left side', 'move'], ['Drag elsewhere', 'look'], ['FIRE', 'shoot (drag to aim)'], ['ZOOM', 'scope / suppressor'], ['RLD', 'reload'], ['USE', 'plant / disarm (hold)'], ['SWAP', 'next weapon'], ['BUY', 'armory'], ['II', 'pause']]
      : [
          ['W A S D', 'move'], ['Mouse', 'aim'], ['Left click', 'fire'], ['Right click', 'scope / suppressor'], ['Space', 'jump'],
          ['C / Ctrl', 'crouch'], ['Shift', 'walk (silent)'], ['R', 'reload'], ['E', 'plant / disarm (hold)'], ['F', 'inspect weapon'],
          ['B', 'armory'], ['1 2 3', 'primary / sidearm / knife'], ['Q', 'last weapon'], ['Wheel', 'cycle weapons'], ['Tab', 'scoreboard'], ['Esc', 'pause'],
        ];
    $('keys').innerHTML = keys.map(([k, v]) => `<div><b>${k}</b>${v}</div>`).join('');
    $('credits').innerHTML = CREDITS.map((c) =>
      `<div><b>${esc(c.title)}</b> by ${esc(c.author)} — <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.license)}</a>${c.note ? `<br>${esc(c.note)}` : ''}</div>`).join('');

    // Lobby browser.
    $('arenas').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!b) return;
      this.onClick();
      if (b.dataset['act'] === 'join') this.net.join(Number(b.dataset['id']));
      else if (b.dataset['act'] === 'leave') this.net.leave();
    });
    $('net-status').addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) { this.onClick(); this.net.connect(settings.name); }
    });
    this.net.onChange = () => {
      if (this.net.state === 'online' && this.net.message) this.noticeText = this.net.message;
      this.renderOnline();
    };

    $('resume').addEventListener('click', () => { this.onClick(); this.onResume(); });
    $('quit').addEventListener('click', () => { this.onClick(); this.onLeave(); });
    setInterval(() => { if (this.visible && this.tab === 'online') this.renderOnline(); }, 1000);
  }

  show(on: boolean): void {
    this.visible = on;
    this.root.classList.toggle('hidden', !on);
    if (on && this.tab === 'online') this.net.connect(settings.name);
    if (on) this.renderOnline();
  }

  showPause(on: boolean): void {
    this.pause.classList.toggle('hidden', !on);
  }

  /** Show a one-off message in the online tab (e.g. why a match ended). */
  notice(text: string): void {
    this.noticeText = text;
    this.openTab('online');
  }

  autoJoin(arena: number): void {
    this.openTab('online');
    this.net.connect(settings.name, arena);
  }

  private openTab(tab: string): void {
    this.tab = tab;
    document.querySelectorAll<HTMLElement>('#nav button').forEach((b) => b.classList.toggle('on', b.dataset['tab'] === tab));
    document.querySelectorAll<HTMLElement>('.tab').forEach((s) => s.classList.toggle('on', s.id === `tab-${tab}`));
    if (tab === 'online' && this.visible) this.net.connect(settings.name);
    this.renderOnline();
  }

  private renderOnline(): void {
    const net = this.net;
    const st = $('net-status');
    st.className = `net-status ${net.state}`;
    let text = '';
    if (net.state === 'online') text = `Connected · ${net.ping} ms`;
    else if (net.state === 'failed') text = `${esc(net.message)} <button class="btn alt">RETRY</button>`;
    else if (net.state === 'idle') text = 'Not connected';
    else text = esc(net.message);
    const status = `<span class="dot"></span><span>${text}</span>`;
    if (st.innerHTML !== status) st.innerHTML = status;

    let html = '';
    if (net.state === 'online') {
      for (const l of net.lobbies) {
        const mine = net.joined === l.id;
        const who = l.players.length ? l.players.map(esc).join(' <i>vs</i> ') : '<i>Empty</i>';
        const label = { open: 'OPEN', waiting: 'WAITING', starting: 'STARTING', live: 'LIVE' }[l.state];
        const btn = mine
          ? `<button class="btn alt" data-act="leave">LEAVE</button>`
          : `<button class="btn" data-act="join" data-id="${l.id}" ${l.players.length >= 2 ? 'disabled' : ''}>JOIN</button>`;
        html += `<div class="arena${mine ? ' mine' : ''}"><span class="name">${esc(l.name)}</span><span class="who"><span class="chip ${l.state}">${label}</span>${who}</span>${btn}</div>`;
      }
      if (net.joined >= 0) {
        const link = `${location.origin}${location.pathname}?arena=${net.joined + 1}`;
        html += net.countdown > 0
          ? `<div class="invite">Opponent found — match starting…</div>`
          : `<div class="invite">Waiting for an opponent. Send them this link: <code>${esc(link)}</code></div>`;
      } else if (this.noticeText && net.state === 'online') {
        html += `<div class="invite">${esc(this.noticeText)}</div>`;
      }
    }
    if (html !== this.lastArenas) {
      this.lastArenas = html;
      $('arenas').innerHTML = html;
    }
  }

  private buildSettings(root: HTMLElement, full: boolean): void {
    const range = (label: string, key: keyof Settings, min: number, max: number, step: number, digits: number): void => {
      const l = document.createElement('label');
      l.innerHTML = `<span>${label}</span><div class="row"><input type="range" min="${min}" max="${max}" step="${step}"><output></output></div>`;
      const input = l.querySelector('input')!, out = l.querySelector('output')!;
      input.addEventListener('input', () => setSetting(key, Number(input.value) as never));
      onSettings((s) => { input.value = String(s[key]); out.textContent = Number(s[key]).toFixed(digits); });
      root.appendChild(l);
    };
    const choice = <K extends keyof Settings>(label: string, key: K, options: [string, Settings[K]][]): void => {
      const l = document.createElement('label');
      l.innerHTML = `<span>${label}</span><div class="seg">${options.map(([n], i) => `<button data-i="${i}">${n}</button>`).join('')}</div>`;
      const buttons = [...l.querySelectorAll('button')];
      buttons.forEach((b, i) => b.addEventListener('click', (e) => { e.preventDefault(); this.onClick(); setSetting(key, options[i]![1]); }));
      onSettings((s) => buttons.forEach((b, i) => b.classList.toggle('on', s[key] === options[i]![1])));
      root.appendChild(l);
    };
    range('Sensitivity', 'sensitivity', 0.2, 8, 0.05, 2);
    range('Scoped sens.', 'zoomSensitivity', 0.3, 2, 0.05, 2);
    range('Field of view', 'fov', 60, 90, 1, 0);
    range('Volume', 'volume', 0, 1, 0.05, 2);
    choice<'quality'>('Graphics', 'quality', [['Auto', 'auto'], ['High', 'high'], ['Medium', 'medium'], ['Low', 'low']] as [string, QualitySetting][]);
    choice<'aspect'>('Aspect ratio', 'aspect', [['Fill', 'fill'], ['21:9', '21:9'], ['16:9', '16:9'], ['16:10', '16:10'], ['4:3', '4:3'], ['5:4', '5:4']] as [string, AspectSetting][]);
    choice<'resolution'>('Resolution', 'resolution', [['Native', 0], ['1440p', 1440], ['1080p', 1080], ['900p', 900], ['720p', 720]]);
    choice<'fullscreen'>('Fullscreen', 'fullscreen', [['On', true], ['Off', false]]);
    if (!full) return;
    const l = document.createElement('label');
    l.innerHTML = `<span>Crosshair</span><div class="swatches">${CROSSHAIR_COLORS.map((c) => `<button data-c="${c}" style="background:${c}"></button>`).join('')}</div>`;
    const sw = [...l.querySelectorAll<HTMLButtonElement>('button')];
    sw.forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); this.onClick(); setSetting('crosshairColor', b.dataset['c']!); }));
    onSettings((s) => sw.forEach((b) => b.classList.toggle('on', b.dataset['c'] === s.crosshairColor)));
    root.appendChild(l);
    range('Crosshair size', 'crosshairSize', 3, 16, 1, 0);
    choice<'crosshairDot'>('Centre dot', 'crosshairDot', [['On', true], ['Off', false]]);
    choice<'invertY'>('Invert Y', 'invertY', [['Off', false], ['On', true]]);
    choice<'showFps'>('FPS counter', 'showFps', [['On', true], ['Off', false]]);
    // Sound test: audition any cue, so a sound that is off can be named exactly.
    const st = document.createElement('label');
    st.innerHTML = `<span>Sound test</span><div class="row"><select>${GameAudio.cueNames().map((n) => `<option>${n}</option>`).join('')}</select><button class="btn alt">PLAY</button></div>`;
    const sel = st.querySelector('select')!;
    st.querySelector('button')!.addEventListener('click', (e) => { e.preventDefault(); this.onSoundTest(sel.value); });
    sel.addEventListener('change', () => this.onSoundTest(sel.value));
    root.appendChild(st);
  }
}
