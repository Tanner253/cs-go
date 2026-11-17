// Client application: owns the renderer and glues input -> sim -> presentation.
// The sim advances on a fixed 64 Hz clock; rendering interpolates between ticks.
// Offline the client runs the Sim itself; online it predicts through a Replica.

import * as THREE from 'three';
import { Sim } from '../sim/game';
import { lerp, yawTo } from '../sim/math';
import { ATK, DEF, HIT_PLAYER, HIT_WORLD, TICK, emptyCmd, type Player, type SimEvent, type Team } from '../sim/types';
import { SUPPRESSOR_TIME, WEAPONS } from '../sim/weapons';
import type { Replica } from '../net/replica';
import { buildWorld } from './world';
import { createGfx, setupEnvironment, type Gfx, type Quality } from './gfx';
import { Spring, Viewmodel } from './viewmodel';
import { setFinishRenderer } from './finish';
import { Thumbs } from './thumbs';
import { CharacterView } from './characters';
import { Effects } from './effects';
import { GameAudio } from './audio';
import { Input, isTouchDevice } from './input';
import { Hud } from './hud';
import { NetClient } from './net';
import { preloadAssets } from './assets';
import { Menu } from './menu';
import { ASPECTS, onSettings, settings } from './settings';

/** Fraction of weapon recoil shown as camera kick; the rest only moves the bullets. */
const VIEW_PUNCH = 0.6;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

type Mode = 'menu' | 'offline' | 'online';

export class GameApp {
  private canvas = $<HTMLCanvasElement>('game');
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(74, 1, 0.1, 900);
  private vm = new Viewmodel();
  private fx = new Effects();
  private audio = new GameAudio();
  private hud = new Hud();
  /** Icons of the guns for the armory, drawn one a frame once the models are in. */
  private thumbs!: Thumbs;
  private input: Input;
  private gfx: Gfx;
  private chars: CharacterView[] = [];
  private net = new NetClient();
  private menu: Menu;
  private replica: Replica | null = null;

  sim: Sim;
  private mode: Mode = 'menu';
  private paused = false;
  private ready = false;
  private acc = 0;
  private last = 0;
  private cmd = emptyCmd();
  private params = new URLSearchParams(location.search);
  private noLock = this.params.has('nolock');

  private punchP = 0;
  private punchY = 0;
  private fov = 74;
  private fovKick = 0;
  /** The jolt each of the player's own shots gives the view, on top of the spray's push (seen, not shot along). */
  private jolt = new Spring(1700, 46);
  private joltYaw = new Spring(1700, 50);
  private shake = 0;
  /**
   * Being hit knocks the view up and away from where the round came from, and it swings back:
   * a single jolt with a direction, not a rattle. (Seen only: the aim itself is not moved.)
   */
  private flinchP = new Spring(230, 19);
  private flinchY = new Spring(230, 19);
  private flinchR = new Spring(200, 16);
  /** When a passing round was last heard, so a burst is a few cracks and not thirty. */
  private crackAt = -9;
  private roll = 0;
  private landDip = 0;
  private landVel = 0;
  private eyeY = 0;
  private specYaw = 0;
  private specPitch = 0;
  private deathAt = -99;
  private beepAt = 0;
  private blink = 0;
  private fps = 60;
  private endTimer = 0;
  private tmp = new THREE.Vector3();
  private stageH = 1;
  private stageKey = '';

  constructor() {
    const touch = isTouchDevice();
    document.body.classList.toggle('touch', touch);
    const quality: Quality = settings.quality === 'auto' ? (touch ? 'low' : 'high') : settings.quality;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    setFinishRenderer(this.renderer);
    setupEnvironment(this.scene, this.renderer, quality);
    this.gfx = createGfx(this.renderer, this.scene, this.camera, this.vm.scene, this.vm.camera, quality);
    this.scene.add(this.fx.group);
    this.camera.rotation.order = 'YXZ';

    this.input = new Input(this.canvas, $('touch'));
    this.input.onFirstGesture = () => this.audio.unlock();
    this.input.onToggleBuy = () => this.toggleBuy();
    this.input.onScoreboard = (show) => { if (this.mode !== 'menu') this.hud.setBoardOpen(show); };
    this.input.onInspect = () => { if (this.mode !== 'menu') this.vm.onInspect(); };
    this.vm.onFoley = (sound, def) => this.audio.foley(sound, def.kind);
    this.input.onEscape = () => {
      if (this.mode === 'menu') return;
      if (this.hud.buyOpen) this.toggleBuy();
      else this.setPaused(!this.paused);
    };
    this.input.onUnlock = () => {
      if (this.mode !== 'menu' && !this.hud.buyOpen && !this.noLock && !this.input.touch) this.setPaused(true);
    };
    this.input.onMenuKey = (d) => this.hud.buyDigit(d);
    this.hud.onBuy = (item) => this.input.queueBuy(item);
    this.thumbs = new Thumbs(this.renderer);
    this.hud.thumb = (id) => this.thumbs.get(id);
    this.canvas.addEventListener('click', () => {
      this.audio.unlock();
      if (this.mode !== 'menu' && !this.paused && !this.hud.buyOpen) {
        this.input.enterFullscreen();
        this.input.requestLock();
      }
    });
    // Ctrl+W and friends cannot be blocked outside fullscreen, but the browser will ask first.
    addEventListener('beforeunload', (e) => {
      if (this.mode !== 'menu') { e.preventDefault(); e.returnValue = ''; }
    });

    this.menu = new Menu(this.net, this.input.touch);
    this.menu.onPractice = (team, size, skill) => { this.input.enterFullscreen(); this.startOffline(team, size, skill); };
    this.menu.onClick = () => { this.audio.unlock(); this.audio.ui('click'); };
    this.menu.onResume = () => { this.input.enterFullscreen(); this.setPaused(false); this.input.requestLock(); };
    this.menu.onLeave = () => this.leave();
    this.menu.onSoundTest = (name) => this.audio.test(name);

    this.net.onStart = (r) => this.startOnline(r);
    this.net.onEvents = (ev) => { if (this.mode === 'online') this.handleEvents(ev); };
    this.net.onMatchEnd = (reason) => {
      if (this.mode !== 'online') return;
      this.toMenu();
      this.menu.notice(reason);
    };

    onSettings((s) => {
      this.audio.setVolume(s.volume);
      const q: Quality = s.quality === 'auto' ? (touch ? 'low' : 'high') : s.quality;
      if (this.gfx.quality !== q) this.gfx.setQuality(q);
      if (`${s.aspect}|${s.resolution}` !== this.stageKey) this.resize();
    });
    document.addEventListener('fullscreenchange', () => this.resize());
    addEventListener('resize', () => this.resize());
    this.resize();

    // A bot match runs behind the menu as a living backdrop.
    this.sim = new Sim({ humanTeam: null, botSkill: 0.5 });
    // Debug handle for the console and automated checks.
    (window as unknown as Record<string, unknown>)['__np'] = this;
    void this.boot();
  }

  // ---- setup ------------------------------------------------------------------------

  private async boot(): Promise<void> {
    const fill = $('boot-fill'), text = $('boot-text');
    let world = 0, assets = 0;
    const show = () => { fill.style.width = `${Math.round((world * 0.6 + assets * 0.4) * 100)}%`; };
    text.textContent = 'Building the arena';
    const [group] = await Promise.all([
      buildWorld(this.sim.map, this.renderer, this.gfx.quality, (f) => { world = f; show(); }),
      preloadAssets((f) => { assets = f; show(); }),
    ]);
    this.scene.add(group);
    this.renderer.shadowMap.needsUpdate = true;
    this.ensureChars(this.sim);
    this.ready = true;
    $('boot').classList.add('hidden');
    this.toMenu();
    requestAnimationFrame((t) => this.frame(t));
    if (this.params.has('spectate')) this.startOffline(null, 5, 0.6);
    const arena = Number(this.params.get('arena'));
    if (this.params.has('arena') && arena >= 1 && arena <= 5) this.menu.autoJoin(arena - 1);
  }

  private ensureChars(sim: Sim): void {
    while (this.chars.length < sim.players.length) {
      const c = new CharacterView();
      this.chars.push(c);
      this.scene.add(c.group);
    }
    for (const c of this.chars) c.hideCorpse();
  }

  private enterMatch(sim: Sim, mode: Mode): void {
    clearTimeout(this.endTimer);
    this.sim = sim;
    this.mode = mode;
    this.paused = false;
    this.acc = 0;
    this.deathAt = -99;
    this.ensureChars(sim);
    this.fx.clearRound();
    this.menu.show(false);
    this.menu.showPause(false);
    $('touch').classList.add('live');
    this.hud.show(true);
    this.hud.setBuyOpen(false);
    this.hud.setBoardOpen(false);
    const me = sim.human;
    if (me) { this.input.yaw = sim.map.spawnYaw[me.team]; this.input.pitch = 0; }
    this.input.requestLock();
  }

  startOffline(team: Team | null, size: number, skill: number): void {
    this.replica = null;
    const sim = new Sim({ humanTeam: team, teamSize: size, botSkill: skill, humanName: settings.name || 'You', seed: (Math.random() * 1e9) | 0 });
    this.enterMatch(sim, 'offline');
    this.handleEvents(sim.events);
    sim.events.length = 0;
  }

  private startOnline(r: Replica): void {
    this.replica = r;
    this.enterMatch(r.sim, 'online');
  }

  /** Leave whatever match is running and go back to the menu. */
  private leave(): void {
    if (this.mode === 'online') this.net.leave();
    this.toMenu();
  }

  private toMenu(): void {
    clearTimeout(this.endTimer);
    // Swap the backdrop match back in.
    if (this.mode !== 'menu') this.sim = new Sim({ humanTeam: null, botSkill: 0.5 });
    this.mode = 'menu';
    this.replica = null;
    this.paused = false;
    this.input.releaseLock();
    this.hud.show(false);
    this.menu.showPause(false);
    this.menu.show(true);
    $('touch').classList.remove('live');
    this.ensureChars(this.sim);
    this.fx.clearRound();
  }

  private setPaused(p: boolean): void {
    if (this.mode === 'menu') return;
    this.paused = p;
    this.menu.showPause(p);
    if (p) this.input.releaseLock();
    else this.input.requestLock();
  }

  private toggleBuy(): void {
    const sim = this.sim, me = sim.human;
    if (this.mode === 'menu' || !me || this.paused) return;
    const open = !this.hud.buyOpen;
    if (open && !sim.canBuy(me)) {
      this.audio.ui('deny');
      this.hud.message('', me.alive ? 'The armory is closed' : '', 1.2);
      return;
    }
    this.hud.setBuyOpen(open);
    this.audio.ui('click');
    if (open) this.input.releaseLock();
    else this.input.requestLock();
  }

  private resize(): void {
    // The play area ("stage") is the largest box of the chosen shape that fits the window;
    // the rest is black bars. The canvas, HUD and touch controls all live inside it.
    const W = innerWidth, H = innerHeight;
    let w = W, h = H;
    const aspect = ASPECTS[settings.aspect] ?? 0;
    if (aspect > 0) {
      if (W / H > aspect) w = Math.round(H * aspect);
      else h = Math.round(W / aspect);
    }
    const st = document.documentElement.style;
    st.setProperty('--stage-x', `${(W - w) >> 1}px`);
    st.setProperty('--stage-y', `${(H - h) >> 1}px`);
    st.setProperty('--stage-w', `${w}px`);
    st.setProperty('--stage-h', `${h}px`);
    st.setProperty('--stage-min', `${Math.min(w, h)}px`);
    this.stageH = h;
    this.stageKey = `${settings.aspect}|${settings.resolution}`;
    this.gfx.resize(w, h, settings.resolution);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vm.resize(w / h);
  }

  // ---- events from the sim ------------------------------------------------------------

  private viewPlayer(): Player {
    const sim = this.sim;
    const me = sim.human;
    if (me && (me.alive || sim.time - this.deathAt < 1.6)) return me;
    let pick: Player | null = null;
    for (const p of sim.players) {
      if (!p.alive) continue;
      if (me && p.team === me.team) return p;
      if (!pick) pick = p;
    }
    return pick ?? me ?? sim.players[0]!;
  }

  private handleEvents(events: SimEvent[]): void {
    const sim = this.sim;
    const me = sim.human;
    const view = this.viewPlayer();
    for (const e of events) {
      switch (e.type) {
        case 'shot': {
          const s = sim.players[e.player]!;
          const def = WEAPONS[e.weapon]!;
          const own = s === view;
          const quiet = e.quiet === true;
          let ox: number, oy: number, oz: number;
          if (own) {
            this.vm.onShot(def, quiet);
            this.jolt.kick(def.kick * (def.auto ? 0.5 : 0.75));
            this.joltYaw.kick((Math.random() - 0.5) * def.kick * 0.22);
            this.fovKick = Math.min(2.5, this.fovKick + def.kick * 0.55);
            this.audio.shot(def.kind, null, 0, 0, def.id, s.id, quiet);
            // Viewmodel muzzle -> world, compensating for the viewmodel's narrower FOV.
            const k = Math.tan((this.vm.camera.fov * Math.PI) / 360) / Math.tan((this.camera.fov * Math.PI) / 360);
            this.tmp.set(this.vm.muzzleWorld.x * k, this.vm.muzzleWorld.y * k, this.vm.muzzleWorld.z);
            this.camera.localToWorld(this.tmp);
            ox = this.tmp.x; oy = this.tmp.y; oz = this.tmp.z;
          } else {
            this.audio.shot(def.kind, e.ox, e.oy, e.oz, def.id, s.id, quiet);
            const m = this.chars[s.id]!.muzzle;
            this.chars[s.id]!.shot();
            ox = m.x; oy = m.y; oz = m.z;
            this.fx.muzzleFlash(ox, oy, oz, quiet ? 0.3 : 1);
          }
          // (a suppressed gun lights very little and shows no tracer)
          this.fx.flashLight(ox, oy, oz, quiet ? 6 : 34);
          let nearest = Infinity, nx = 0, ny = 0, nz = 0;
          for (let i = 0; i < e.hitKinds.length; i++) {
            const b = i * 6;
            const ex = e.ends[b]!, ey = e.ends[b + 1]!, ez = e.ends[b + 2]!;
            if (!quiet) this.fx.tracer(ox, oy, oz, ex, ey, ez);
            // Someone else's round going past the head (not into it).
            if (!own && view.alive && s.team !== view.team && e.hitKinds[i] !== HIT_PLAYER) {
              const cam = this.camera.position;
              const dx = ex - e.ox, dy = ey - e.oy, dz = ez - e.oz;
              const len2 = dx * dx + dy * dy + dz * dz;
              const u = len2 > 0 ? ((cam.x - e.ox) * dx + (cam.y - e.oy) * dy + (cam.z - e.oz) * dz) / len2 : 0;
              if (u > 0 && u < 1 && u * Math.sqrt(len2) > 4) {
                const px = e.ox + dx * u, py = e.oy + dy * u, pz = e.oz + dz * u;
                const d = Math.hypot(px - cam.x, py - cam.y, pz - cam.z);
                if (d < nearest) { nearest = d; nx = px; ny = py; nz = pz; }
              }
            }
            if (e.hitKinds[i] === HIT_WORLD) {
              this.fx.impact(ex, ey, ez, e.ends[b + 3]!, e.ends[b + 4]!, e.ends[b + 5]!);
              if (i === 0) this.audio.impact(ex, ey, ez);
            }
          }
          if (nearest < 1.8 && sim.time - this.crackAt > 0.07) {
            this.crackAt = sim.time;
            const close = 1 - nearest / 1.8;
            this.audio.crack(nx, ny, nz, 0.35 + 0.65 * close);
            // (close enough to make you duck)
            if (close > 0.55) this.flinchP.kick(-0.25 * close);
          }
          break;
        }
        case 'hit': {
          const v = sim.players[e.victim]!;
          const a = e.attacker >= 0 ? sim.players[e.attacker]! : null;
          const dx = a ? v.pos.x - a.pos.x : 0, dz = a ? v.pos.z - a.pos.z : 0;
          const d = Math.hypot(dx, dz) || 1;
          this.fx.blood(e.x, e.y, e.z, dx / d, 0.2, dz / d, e.head);
          if (v === view) {
            this.hud.damageFlash(e.damage);
            const hard = Math.min(1.5, e.damage / 30);
            let from = 0;
            if (a) {
              const bearing = yawTo(v.pos.x, v.pos.z, a.pos.x, a.pos.z);
              this.hud.damageFrom(bearing);
              // (+ = the attacker is to the left: the view is knocked to the right)
              from = Math.sin(bearing - this.camera.rotation.y);
            }
            this.flinchP.kick(1.05 * hard);
            this.flinchY.kick(-0.75 * hard * from);
            this.flinchR.kick(0.55 * hard * (from || (Math.random() < 0.5 ? -0.5 : 0.5)));
            this.shake = Math.min(1, this.shake + e.damage / 160);
            this.audio.hurt();
          } else {
            // Seen from outside: the body jerks away from the side it was hit on.
            const side = (e.x - v.pos.x) * Math.cos(v.yaw) - (e.z - v.pos.z) * Math.sin(v.yaw);
            this.chars[v.id]?.hurt(side >= 0 ? 1 : -1, e.damage / 50, e.head);
          }
          if (a && a === me) {
            this.audio.hit(e.head);
            this.hud.hitMarker(v.hp <= 0 || !v.alive, e.head);
          }
          break;
        }
        case 'kill': {
          const v = sim.players[e.victim]!;
          const killer = e.killer >= 0 ? sim.players[e.killer]! : null;
          this.hud.kill(killer, v, e.weapon, e.head, e.wallbang, me);
          if (killer === me && me) this.hud.hitMarker(true, e.head);
          if (v === me) {
            this.deathAt = sim.time;
            if (this.hud.buyOpen) { this.hud.setBuyOpen(false); this.input.requestLock(); }
          }
          break;
        }
        case 'step':
          this.audio.step(sim.players[e.player] === view ? null : e.x, e.y, e.z);
          break;
        case 'jump': {
          const p = sim.players[e.player]!;
          this.audio.jump(p === view ? null : p.pos.x, p.pos.y, p.pos.z);
          break;
        }
        case 'land': {
          const p = sim.players[e.player]!;
          this.audio.land(p === view ? null : p.pos.x, p.pos.y, p.pos.z, Math.min(1, e.speed / 14));
          if (p === view) this.landVel -= Math.min(2.2, e.speed * 0.16);
          break;
        }
        case 'reload': {
          // (your own reload is heard moment by moment, from the viewmodel: see `onFoley`)
          const p = sim.players[e.player]!;
          const w = WEAPONS[e.weapon]!;
          if (p !== view) this.audio.reloadHeard(p.pos.x, p.pos.y + 1.2, p.pos.z, w.kind, w.reloadTime);
          break;
        }
        case 'dry':
          if (sim.players[e.player] === view) this.audio.dry();
          break;
        case 'scope':
          if (sim.players[e.player] === view) this.audio.ui('scope');
          break;
        case 'fit':
          if (sim.players[e.player] === view) this.audio.fit(e.on);
          break;
        case 'draw':
          if (sim.players[e.player] === view) this.audio.draw(e.weapon);
          break;
        case 'buy':
          if (sim.players[e.player] === me) this.audio.ui(e.ok ? 'buy' : 'deny');
          break;
        case 'knife': {
          const p = sim.players[e.player]!;
          if (p === view) this.vm.onMelee();
          else this.chars[p.id]?.swing();
          this.audio.knife(e.hit, p === view ? null : p.pos.x, p.pos.y, p.pos.z);
          break;
        }
        case 'planted':
          this.hud.message('CHARGE PLANTED', `Site ${sim.map.sites[e.site]!.name} — ${sim.rules.chargeTime} seconds`, 3.5);
          this.audio.ui('plant');
          this.beepAt = 0;
          break;
        case 'disarmed':
          this.audio.ui('disarm');
          break;
        case 'detonated': {
          this.fx.detonate(e.x, e.y, e.z);
          this.audio.explosion(e.x, e.y, e.z);
          const d = Math.hypot(e.x - this.camera.position.x, e.z - this.camera.position.z);
          this.hud.whiteFlash(Math.max(0.15, 1 - d / 45));
          this.shake = 1;
          break;
        }
        case 'chargeDrop':
          if (!me || me.team === ATK) this.hud.message('', 'The charge has been dropped', 2.5);
          break;
        case 'chargePickup':
          if (sim.players[e.player] === me) this.hud.message('', 'You picked up the charge', 2.5);
          break;
        case 'roundStart':
          this.fx.clearRound();
          for (const c of this.chars) c.hideCorpse();
          if (me) { this.input.yaw = sim.map.spawnYaw[me.team]; this.input.pitch = 0; }
          this.deathAt = -99;
          this.hud.setBoardOpen(false);
          this.hud.message(`ROUND ${e.round}`, me ? (me.team === ATK ? 'ATTACK — plant the charge' : 'DEFEND — hold both sites') : '', 3);
          break;
        case 'roundLive':
          this.audio.ui('start');
          break;
        case 'roundEnd': {
          const reasons = { elimination: 'Enemy eliminated', time: 'Time ran out', detonation: 'The charge detonated', disarm: 'The charge was disarmed' };
          const won = me ? e.winner === me.team : null;
          this.hud.message(won === null ? (e.winner === ATK ? 'ATTACK WINS' : 'DEFENCE WINS') : won ? 'ROUND WON' : 'ROUND LOST', reasons[e.reason], 4);
          this.audio.ui(won === false ? 'lose' : 'win');
          break;
        }
        case 'halftime':
          this.hud.message('HALF TIME', 'Switching sides', 4);
          break;
        case 'matchEnd': {
          const won = me ? (e.winner === -1 ? null : e.winner === me.team) : null;
          const online = this.mode === 'online';
          this.hud.message(e.winner === -1 ? 'DRAW' : won === null ? 'MATCH OVER' : won ? 'VICTORY' : 'DEFEAT', `${sim.score[ATK]} — ${sim.score[DEF]}${online ? ' · rematch starting soon' : ''}`, 9);
          this.hud.setBoardOpen(true);
          if (!online) this.endTimer = window.setTimeout(() => this.toMenu(), 9000);
          break;
        }
        default:
          break;
      }
    }
  }

  // ---- frame ------------------------------------------------------------------------

  private frame(t: number): void {
    requestAnimationFrame((n) => this.frame(n));
    const dt = Math.min(0.1, (t - this.last) / 1000 || 0.016);
    this.last = t;
    this.fps += (1 / Math.max(dt, 1e-4) - this.fps) * 0.05;
    if (!this.ready) return;
    const now = t / 1000;

    if (this.mode === 'menu') {
      this.menuFrame(now, dt);
      return;
    }
    const sim = this.sim;
    const me = sim.human;
    const active = !this.paused && !this.hud.buyOpen && !!me && me.alive && (this.input.locked || this.input.touch || this.noLock);

    if (this.mode === 'offline') {
      if (!this.paused) {
        this.acc += dt;
        let n = 0;
        while (this.acc >= TICK && n++ < 8) {
          this.acc -= TICK;
          this.buildCmd(me, active);
          const cmd = this.cmd;
          sim.tick((p) => (p === me ? cmd : null));
        }
        if (this.acc > TICK * 4) this.acc = 0;
      }
    } else if (this.replica) {
      // Online never pauses: the menu only stops your own input.
      this.acc += dt;
      let n = 0;
      while (this.acc >= TICK && n++ < 8) {
        this.acc -= TICK;
        this.buildCmd(me, active);
        this.net.send(this.replica.input(this.cmd, performance.now() / 1000));
      }
      if (this.acc > TICK * 4) this.acc = 0;
      this.replica.frame(performance.now() / 1000, dt);
      this.hud.netText = `${this.net.ping} ms`;
    }
    if (sim.events.length > 0) {
      this.handleEvents(sim.events);
      sim.events.length = 0;
    }
    this.render(sim, dt, this.acc / TICK);
  }

  private buildCmd(me: Player | null, active: boolean): void {
    this.input.build(this.cmd, active);
    if (me && this.cmd.slot >= 4) {
      const dir = this.cmd.slot === 4 ? 1 : -1;
      this.cmd.slot = -1;
      for (let i = 1; i <= 3; i++) {
        const s = (me.active + dir * i + 6) % 3;
        if (me.weapons[s]) { this.cmd.slot = s; break; }
      }
    }
  }

  private menuFrame(time: number, dt: number): void {
    const sim = this.sim;
    this.acc += dt;
    let n = 0;
    while (this.acc >= TICK && n++ < 4) { this.acc -= TICK; sim.tick(); }
    for (const e of sim.events) {
      if (e.type === 'roundStart') { this.fx.clearRound(); for (const c of this.chars) c.hideCorpse(); }
    }
    sim.events.length = 0;
    if (sim.phase === 'over') sim.restart();
    const a = time * 0.05;
    this.camera.position.set(Math.sin(a) * 40, 24, Math.cos(a) * 46);
    this.camera.lookAt(0, 0, -4);
    if (this.camera.fov !== 50) { this.camera.fov = 50; this.camera.updateProjectionMatrix(); }
    for (const p of sim.players) this.chars[p.id]!.update(p, this.acc / TICK, dt, false, false);
    for (let i = sim.players.length; i < this.chars.length; i++) this.chars[i]!.hideCorpse();
    this.fx.charge.visible = false;
    this.fx.update(dt, 0);
    if (this.thumbs.step()) this.hud.thumbsChanged();
    this.gfx.render(dt, false);
  }

  private render(sim: Sim, dt: number, alpha: number): void {
    const me = sim.human;
    const view = this.viewPlayer();
    const isMe = view === me;
    const def = sim.activeDef(view);
    const predicted = isMe && this.replica !== null;

    // ---- camera ----
    let x = lerp(view.prevPos.x, view.pos.x, alpha);
    let y = lerp(view.prevPos.y, view.pos.y, alpha);
    let z = lerp(view.prevPos.z, view.pos.z, alpha);
    if (predicted) { x += this.replica!.errX; y += this.replica!.errY; z += this.replica!.errZ; }
    // Stairs: the body steps instantly, the eye glides.
    if (view.onGround && Math.abs(y - this.eyeY) < 0.7) this.eyeY += (y - this.eyeY) * Math.min(1, dt * 16);
    else this.eyeY = y;
    const crouch = lerp(view.prevCrouchT, view.crouchT, alpha);
    const eye = lerp(1.63, 1.17, crouch);
    let yaw: number, pitch: number;
    if (isMe) {
      yaw = this.input.yaw;
      pitch = this.input.pitch;
      this.specYaw = yaw;
      this.specPitch = pitch;
    } else {
      let d = view.yaw - this.specYaw;
      d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      const k = Math.min(1, dt * 20);
      this.specYaw += d * k;
      this.specPitch += (view.pitch - this.specPitch) * k;
      yaw = this.specYaw;
      pitch = this.specPitch;
    }
    // The view follows the spray closely, and every shot jolts it.
    const pk = Math.min(1, dt * 55);
    this.punchP += (view.punchPitch * VIEW_PUNCH - this.punchP) * pk;
    this.punchY += (view.punchYaw * VIEW_PUNCH - this.punchY) * pk;
    const jolt = this.jolt.step(0, dt), joltYaw = this.joltYaw.step(0, dt);

    this.landVel += (-140 * this.landDip - 16 * this.landVel) * dt;
    this.landDip += this.landVel * dt;
    const side = view.vel.x * Math.cos(yaw) - view.vel.z * Math.sin(yaw);
    this.roll += (-side * 0.003 - this.roll) * Math.min(1, dt * 8);
    this.shake = Math.max(0, this.shake - dt * 3);
    const sh = this.shake * this.shake * 0.018;
    const flinchP = this.flinchP.step(0, dt), flinchY = this.flinchY.step(0, dt), flinchR = this.flinchR.step(0, dt);

    const dead = !view.alive;
    this.camera.position.set(x, this.eyeY + (dead ? 0.45 : eye) + this.landDip * 0.06, z);
    this.camera.rotation.set(
      pitch + this.punchP + jolt + flinchP + (Math.random() - 0.5) * sh,
      yaw + this.punchY + joltYaw + flinchY + (Math.random() - 0.5) * sh,
      this.roll + flinchR + (dead ? 0.5 : 0),
    );

    // FOV: scope zoom and a touch of shot kick.
    const base = settings.fov;
    let targetFov = base;
    if (view.scope > 0 && def.scopeFov) targetFov = def.scopeFov[view.scope - 1]!;
    this.fov += (targetFov - this.fov) * Math.min(1, dt * (view.scope > 0 ? 22 : 12));
    this.fovKick = Math.max(0, this.fovKick - dt * 14);
    const fov = this.fov + this.fovKick * 0.5;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.input.zoomScale = (this.fov / base) * (view.scope > 0 ? settings.zoomSensitivity : 1);
    this.camera.updateMatrixWorld();
    this.audio.setListener(x, y + eye, z, yaw);

    // ---- characters ----
    for (const p of sim.players) {
      this.chars[p.id]!.update(p, alpha, dt, !!me && p.team === me.team && p !== me, (p === view && view.alive) || (this.replica?.hidden[p.id] === true && p.alive));
    }
    for (let i = sim.players.length; i < this.chars.length; i++) this.chars[i]!.hideCorpse();

    // ---- the charge ----
    const c = sim.charge;
    const showCharge = c.state === 'dropped' || c.state === 'planted';
    this.fx.charge.visible = showCharge;
    if (showCharge) {
      this.fx.charge.position.set(c.pos.x, c.pos.y, c.pos.z);
      if (c.state === 'planted' && sim.phase === 'planted') {
        this.beepAt -= dt;
        if (this.beepAt <= 0 && !this.paused) {
          this.beepAt = 0.13 + 0.9 * Math.max(0, c.timer / sim.rules.chargeTime);
          this.blink = 1;
          this.audio.beep(c.pos.x, c.pos.y, c.pos.z, c.timer < 10);
        }
      } else if (c.state === 'dropped') {
        this.blink = 0.5 + 0.5 * Math.sin(sim.time * 5);
      }
    }
    this.blink = Math.max(0, this.blink - dt * 5);
    this.fx.update(dt, this.blink);

    // ---- viewmodel ----
    const showVm = view.alive;
    if (showVm) {
      this.vm.update(dt, {
        def,
        team: view.team,
        lookDX: isMe ? this.input.lookDX : 0,
        lookDY: isMe ? this.input.lookDY : 0,
        speed: Math.hypot(view.vel.x, view.vel.z),
        maxSpeed: def.maxSpeed,
        onGround: view.onGround,
        velY: view.vel.y,
        crouch,
        drawT: Math.max(0, Math.min(1, view.drawTimer / def.drawTime)),
        reloadT: view.reloadTimer > 0 ? 1 - view.reloadTimer / def.reloadTime : 0,
        ammo: def.magSize > 0 ? (view.weapons[view.active]?.mag ?? def.magSize) / def.magSize : 1,
        recoilPitch: view.punchPitch,
        recoilYaw: view.punchYaw,
        scoped: view.scope > 0,
        quiet: view.weapons[view.active]?.quiet === true,
        fitT: view.fitTimer > 0 ? Math.max(0.001, 1 - view.fitTimer / SUPPRESSOR_TIME) : 0,
        grappling: false,
        mantling: false,
      });
    }
    this.input.lookDX = 0;
    this.input.lookDY = 0;

    if (this.thumbs.step()) this.hud.thumbsChanged();
    this.gfx.render(dt, showVm && view.scope === 0);

    // ---- HUD ----
    const spread = sim.spreadOf(view);
    const gapPx = (Math.tan(spread) / Math.tan((this.camera.fov * Math.PI) / 360)) * (this.stageH / 2);
    this.hud.update(sim, view, me, gapPx, dt, this.fps, this.input.touch);
  }
}
