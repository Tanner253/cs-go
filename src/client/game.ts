// Client application: owns the renderer and glues input -> sim -> presentation.
// The sim advances on a fixed 64 Hz clock; rendering interpolates between ticks.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Sim } from '../sim/game';
import { eyeHeight } from '../sim/movement';
import { lerp } from '../sim/math';
import { ATK, DEF, HIT_WORLD, TICK, emptyCmd, type Player, type SimEvent, type Team } from '../sim/types';
import { WEAPONS } from '../sim/weapons';
import { buildSky, buildWorld } from './world';
import { Viewmodel } from './viewmodel';
import { CharacterView } from './characters';
import { Effects } from './effects';
import { GameAudio } from './audio';
import { Input, isTouchDevice } from './input';
import { Hud } from './hud';

const BASE_FOV = 74;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export class GameApp {
  private canvas = $<HTMLCanvasElement>('game');
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.05, 600);
  private vm = new Viewmodel();
  private fx = new Effects();
  private audio = new GameAudio();
  private hud = new Hud();
  private input: Input;
  private chars: CharacterView[] = [];
  private worldGroup: THREE.Group | null = null;
  private sun: THREE.DirectionalLight;

  sim: Sim | null = null;
  private playing = false;
  private paused = false;
  private acc = 0;
  private last = 0;
  private cmd = emptyCmd();
  private params = new URLSearchParams(location.search);
  private noLock = this.params.has('nolock');

  private punchP = 0;
  private punchY = 0;
  private fov = BASE_FOV;
  private fovKick = 0;
  private shake = 0;
  private roll = 0;
  private landDip = 0;
  private landVel = 0;
  private specYaw = 0;
  private specPitch = 0;
  private deathAt = -99;
  private beepAt = 0;
  private blink = 0;
  private fps = 60;
  private endTimer: number | null = null;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  constructor() {
    const touch = isTouchDevice();
    document.body.classList.toggle('touch', touch);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: !touch, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, touch ? 1.5 : 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.autoClear = false;
    this.renderer.shadowMap.enabled = !touch;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;

    // One small prefiltered environment gives every metal surface something to reflect.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.45;
    this.vm.scene.environment = env;
    this.vm.scene.environmentIntensity = 0.9;

    this.scene.fog = new THREE.Fog(0xc4d9ee, 70, 260);
    this.scene.add(buildSky());
    this.scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x5b5f6a, 1.25));
    this.sun = new THREE.DirectionalLight(0xfff0da, 2.6);
    this.sun.position.set(-42, 72, 35);
    this.sun.castShadow = !touch;
    const sc = this.sun.shadow.camera;
    sc.left = -52; sc.right = 52; sc.top = 52; sc.bottom = -52; sc.near = 10; sc.far = 190;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.fx.group);
    this.camera.rotation.order = 'YXZ';

    this.input = new Input(this.canvas, $('touch'));
    this.input.onFirstGesture = () => this.audio.unlock();
    this.input.onToggleBuy = () => this.toggleBuy();
    this.input.onScoreboard = (show) => this.playing && this.hud.setBoardOpen(show);
    this.input.onPause = () => {
      if (this.playing && !this.hud.buyOpen && !this.noLock && !this.input.touch) this.setPaused(true);
    };
    this.input.onMenuKey = (d) => this.hud.buyDigit(d);
    this.hud.onBuy = (item) => this.input.queueBuy(item);
    this.canvas.addEventListener('click', () => {
      this.audio.unlock();
      if (this.playing && !this.paused && !this.hud.buyOpen) this.input.requestLock();
    });

    // Debug handle for the console and automated checks.
    (window as unknown as Record<string, unknown>)['__np'] = this;
    this.bindMenu();
    addEventListener('resize', () => this.resize());
    this.resize();

    // A slow orbit behind the menu.
    this.loadWorld(new Sim({ humanTeam: null, botSkill: 0.5 }), false);
    requestAnimationFrame((t) => this.frame(t));
    if (this.params.has('spectate')) this.start(null, 0.6);
  }

  // ---- setup ----------------------------------------------------------------------

  private bindMenu(): void {
    const sens = $<HTMLInputElement>('opt-sens'), sensV = $('opt-sens-v');
    sens.value = String(this.input.sensitivity);
    sensV.textContent = this.input.sensitivity.toFixed(2);
    sens.addEventListener('input', () => {
      this.input.setSensitivity(Number(sens.value));
      sensV.textContent = Number(sens.value).toFixed(2);
    });
    const vol = $<HTMLInputElement>('opt-vol');
    vol.addEventListener('input', () => this.audio.setVolume(Number(vol.value)));
    document.querySelectorAll<HTMLButtonElement>('#menu .big').forEach((b) => {
      b.addEventListener('click', () => {
        this.audio.unlock();
        this.audio.ui('click');
        this.start(Number(b.dataset['team']) as Team, Number($<HTMLSelectElement>('opt-skill').value));
      });
    });
    $('resume').addEventListener('click', () => { this.setPaused(false); this.input.requestLock(); });
    $('quit').addEventListener('click', () => this.quit());
    const keys: [string, string][] = this.input.touch
      ? [['Left side', 'move'], ['Right side', 'look'], ['HOOK', 'grapple (hold)'], ['JUMP', 'tap in air at a wall to wall-jump']]
      : [
          ['WASD', 'move'], ['Mouse', 'aim / fire'], ['Space', 'jump · wall-jump'], ['Hold Space', 'mantle ledges'],
          ['F / Mouse3', 'grapple (hold)'], ['C / Ctrl', 'crouch'], ['Shift', 'walk (silent)'], ['R', 'reload'],
          ['E', 'plant / disarm'], ['B', 'armory'], ['1 2 3 · Q', 'weapons'], ['Right click', 'scope'], ['Tab', 'scoreboard'],
        ];
    $('keys').innerHTML = keys.map(([k, v]) => `<div><b>${k}</b>${v}</div>`).join('');
  }

  private loadWorld(sim: Sim, playing: boolean): void {
    this.sim = sim;
    if (!this.worldGroup) {
      // The map is the same every match, so its meshes are built once.
      this.worldGroup = buildWorld(sim.map, this.renderer.capabilities.getMaxAnisotropy() > 4 ? 4 : 1, this.renderer.shadowMap.enabled);
      this.scene.add(this.worldGroup);
      this.renderer.shadowMap.needsUpdate = true;
    }
    while (this.chars.length < sim.players.length) {
      const c = new CharacterView();
      this.chars.push(c);
      this.scene.add(c.group);
    }
    for (const c of this.chars) c.hideCorpse();
    this.fx.clearRound();
    this.playing = playing;
    this.acc = 0;
  }

  start(team: Team | null, skill: number): void {
    if (this.endTimer !== null) { clearTimeout(this.endTimer); this.endTimer = null; }
    const sim = new Sim({ humanTeam: team, botSkill: skill, seed: (Math.random() * 1e9) | 0 });
    this.loadWorld(sim, true);
    this.paused = false;
    $('menu').classList.add('hidden');
    $('pause').classList.add('hidden');
    $('touch').classList.add('live');
    this.hud.show(true);
    this.hud.setBuyOpen(false);
    const me = sim.human;
    if (me) { this.input.yaw = me.yaw; this.input.pitch = 0; }
    this.input.requestLock();
    this.handleEvents(sim.events);
    sim.events.length = 0;
  }

  private quit(): void {
    this.playing = false;
    this.paused = false;
    this.input.releaseLock();
    this.hud.show(false);
    $('pause').classList.add('hidden');
    $('menu').classList.remove('hidden');
    $('touch').classList.remove('live');
  }

  private setPaused(p: boolean): void {
    if (!this.playing) return;
    this.paused = p;
    $('pause').classList.toggle('hidden', !p);
  }

  private toggleBuy(): void {
    const sim = this.sim, me = sim?.human;
    if (!this.playing || !sim || !me || this.paused) return;
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
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vm.resize(w / h);
  }

  // ---- events from the sim ------------------------------------------------------------

  private viewPlayer(): Player {
    const sim = this.sim!;
    const me = sim.human;
    if (me && (me.alive || sim.time - this.deathAt < 1.6)) return me;
    // Spectate: a living teammate if possible.
    let pick: Player | null = null;
    for (const p of sim.players) {
      if (!p.alive) continue;
      if (me && p.team === me.team) return p;
      if (!pick) pick = p;
    }
    return pick ?? me ?? sim.players[0]!;
  }

  private handleEvents(events: SimEvent[]): void {
    const sim = this.sim!;
    const me = sim.human;
    const view = this.viewPlayer();
    for (const e of events) {
      switch (e.type) {
        case 'shot': {
          const s = sim.players[e.player]!;
          const def = WEAPONS[e.weapon]!;
          const own = s === view;
          let ox = e.ox, oy = e.oy, oz = e.oz;
          if (own) {
            this.vm.onShot(def);
            this.fovKick = Math.min(2.5, this.fovKick + def.kick * 0.55);
            this.audio.shot(def.kind, null);
            // Viewmodel muzzle -> world, compensating for the viewmodel's narrower FOV.
            const k = Math.tan((this.vm.camera.fov * Math.PI) / 360) / Math.tan((this.camera.fov * Math.PI) / 360);
            this.tmp.set(this.vm.muzzleWorld.x * k, this.vm.muzzleWorld.y * k, this.vm.muzzleWorld.z);
            this.camera.localToWorld(this.tmp);
            ox = this.tmp.x; oy = this.tmp.y; oz = this.tmp.z;
          } else {
            this.audio.shot(def.kind, e.ox, e.oy, e.oz);
            const m = this.chars[s.id]!.muzzle;
            ox = m.x; oy = m.y; oz = m.z;
          }
          for (let i = 0; i < e.hitKinds.length; i++) {
            const b = i * 6;
            const ex = e.ends[b]!, ey = e.ends[b + 1]!, ez = e.ends[b + 2]!;
            this.fx.tracer(ox, oy, oz, ex, ey, ez);
            if (e.hitKinds[i] === HIT_WORLD) this.fx.impact(ex, ey, ez, e.ends[b + 3]!, e.ends[b + 4]!, e.ends[b + 5]!);
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
            this.shake = Math.min(1, this.shake + e.damage / 60);
            this.audio.hurt();
          }
          if (a && a === me) this.audio.hit(e.head);
          break;
        }
        case 'kill': {
          const v = sim.players[e.victim]!;
          const killer = e.killer >= 0 ? sim.players[e.killer]! : null;
          this.hud.kill(killer, v, e.weapon, e.head, e.wallbang, me);
          if (v === me) {
            this.deathAt = sim.time;
            this.hud.setBuyOpen(false);
            if (!this.input.touch && !this.noLock) this.input.requestLock();
          }
          break;
        }
        case 'step': {
          const own = sim.players[e.player] === view;
          this.audio.step(own ? null : e.x, e.y, e.z);
          break;
        }
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
        case 'walljump':
        case 'mantle': {
          const p = sim.players[e.player]!;
          this.audio.whoosh(p === view ? null : p.pos.x, p.pos.y, p.pos.z);
          if (p === view && e.type === 'walljump') this.fovKick = Math.min(3, this.fovKick + 1.5);
          break;
        }
        case 'grapple': {
          const p = sim.players[e.player]!;
          this.audio.grapple(e.ok, p === view ? null : p.pos.x, p.pos.y, p.pos.z);
          if (e.ok) this.fx.impact(e.x, e.y, e.z, 0, 1, 0);
          break;
        }
        case 'reload':
          if (sim.players[e.player] === view) this.audio.reload(WEAPONS[e.weapon]!.kind, WEAPONS[e.weapon]!.reloadTime);
          break;
        case 'dry':
          if (sim.players[e.player] === view) this.audio.dry();
          break;
        case 'draw':
          if (sim.players[e.player] === view) this.audio.draw();
          break;
        case 'buy':
          if (sim.players[e.player] === me) this.audio.ui(e.ok ? 'buy' : 'deny');
          break;
        case 'knife': {
          const p = sim.players[e.player]!;
          if (p === view) this.vm.onMelee();
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
          if (me) { this.input.yaw = me.yaw; this.input.pitch = 0; }
          this.deathAt = -99;
          this.hud.message(`ROUND ${e.round}`, me ? (me.team === ATK ? 'ATTACK — plant the charge' : 'DEFEND — hold both sites') : '', 3);
          break;
        case 'roundLive':
          this.audio.ui('start');
          break;
        case 'roundEnd': {
          const reasons = { elimination: 'Enemy team eliminated', time: 'Time ran out', detonation: 'The charge detonated', disarm: 'The charge was disarmed' };
          const won = me ? e.winner === me.team : null;
          this.hud.message(won === null ? (e.winner === ATK ? 'ATTACK WINS' : 'DEFENCE WINS') : won ? 'ROUND WON' : 'ROUND LOST', reasons[e.reason], 4.5);
          this.audio.ui(won === false ? 'lose' : 'win');
          break;
        }
        case 'halftime':
          this.hud.message('HALF TIME', 'Switching sides', 4);
          break;
        case 'matchEnd': {
          const won = me ? (e.winner === -1 ? null : e.winner === me.team) : null;
          this.hud.message(e.winner === -1 ? 'DRAW' : won === null ? 'MATCH OVER' : won ? 'VICTORY' : 'DEFEAT', `${sim.score[ATK]} — ${sim.score[DEF]}`, 8);
          this.hud.setBoardOpen(true);
          this.endTimer = window.setTimeout(() => { this.hud.setBoardOpen(false); this.quit(); }, 8000);
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
    const sim = this.sim;
    if (!sim) return;

    if (!this.playing) {
      this.menuCamera(t / 1000, dt, sim);
      return;
    }

    const me = sim.human;
    const active = !this.paused && !this.hud.buyOpen && !!me && me.alive && (this.input.locked || this.input.touch || this.noLock);
    if (!this.paused) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= TICK && n++ < 8) {
        this.acc -= TICK;
        this.input.build(this.cmd, active);
        if (me && this.cmd.slot >= 4) this.cmd.slot = this.cycleSlot(me, this.cmd.slot === 4 ? 1 : -1);
        const cmd = this.cmd;
        sim.tick((p) => (p === me ? cmd : null));
      }
      if (this.acc > TICK * 4) this.acc = 0;
      if (sim.events.length > 0) {
        this.handleEvents(sim.events);
        sim.events.length = 0;
      }
    }
    this.render(sim, dt, this.acc / TICK);
  }

  private cycleSlot(p: Player, dir: number): number {
    for (let i = 1; i <= 3; i++) {
      const s = (p.active + dir * i + 6) % 3;
      if (p.weapons[s]) return s;
    }
    return -1;
  }

  private menuCamera(time: number, dt: number, sim: Sim): void {
    // Keep the background match running so the menu backdrop is alive.
    this.acc += dt;
    let n = 0;
    while (this.acc >= TICK && n++ < 4) { this.acc -= TICK; sim.tick(); }
    sim.events.length = 0;
    if (sim.phase === 'over') sim.restart();
    const a = time * 0.06;
    this.camera.position.set(Math.sin(a) * 46, 26, Math.cos(a) * 52);
    this.camera.lookAt(0, 0, -4);
    this.camera.fov = 55;
    this.camera.updateProjectionMatrix();
    for (const p of sim.players) this.chars[p.id]!.update(p, this.acc / TICK, dt, false, false);
    this.fx.beginRopes();
    this.fx.endRopes();
    this.fx.charge.visible = false;
    this.fx.update(dt, 0);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
  }

  private render(sim: Sim, dt: number, alpha: number): void {
    const me = sim.human;
    const view = this.viewPlayer();
    const isMe = view === me;
    const def = sim.activeDef(view);

    // ---- camera ----
    const x = lerp(view.prevPos.x, view.pos.x, alpha);
    const y = lerp(view.prevPos.y, view.pos.y, alpha);
    const z = lerp(view.prevPos.z, view.pos.z, alpha);
    const crouch = lerp(view.prevCrouchT, view.crouchT, alpha);
    const eye = lerp(1.63, 1.17, crouch);
    let yaw: number, pitch: number;
    if (isMe) {
      yaw = this.input.yaw;
      pitch = this.input.pitch;
      this.specYaw = yaw;
      this.specPitch = pitch;
    } else {
      // Smooth a spectated player's 64 Hz aim.
      let d = view.yaw - this.specYaw;
      d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      const k = Math.min(1, dt * 20);
      this.specYaw += d * k;
      this.specPitch += (view.pitch - this.specPitch) * k;
      yaw = this.specYaw;
      pitch = this.specPitch;
    }
    const pk = Math.min(1, dt * 32);
    this.punchP += (view.punchPitch - this.punchP) * pk;
    this.punchY += (view.punchYaw - this.punchY) * pk;

    // Landing dip (spring), strafe roll, damage shake.
    this.landVel += (-140 * this.landDip - 16 * this.landVel) * dt;
    this.landDip += this.landVel * dt;
    const side = view.vel.x * Math.cos(yaw) - view.vel.z * Math.sin(yaw);
    this.roll += (-side * 0.0035 - this.roll) * Math.min(1, dt * 8);
    this.shake = Math.max(0, this.shake - dt * 3);
    const sh = this.shake * this.shake * 0.02;

    const dead = !view.alive;
    this.camera.position.set(x, y + (dead ? 0.45 : eye) + this.landDip * 0.06, z);
    this.camera.rotation.set(
      pitch + this.punchP + (Math.random() - 0.5) * sh,
      yaw + this.punchY + (Math.random() - 0.5) * sh,
      this.roll + (dead ? 0.5 : 0),
    );

    // FOV: scope zoom, shot kick, grapple rush.
    let targetFov = BASE_FOV;
    if (view.scope > 0 && def.scopeFov) targetFov = def.scopeFov[view.scope - 1]!;
    else if (view.grappleOn) targetFov = BASE_FOV + 7;
    this.fov += (targetFov - this.fov) * Math.min(1, dt * (view.scope > 0 ? 22 : 10));
    this.fovKick = Math.max(0, this.fovKick - dt * 14);
    const fov = this.fov + this.fovKick * 0.5;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.input.zoomScale = this.fov / BASE_FOV;
    this.camera.updateMatrixWorld();
    this.audio.setListener(x, y + eye, z, yaw);

    // ---- characters ----
    for (const p of sim.players) {
      this.chars[p.id]!.update(p, alpha, dt, !!me && p.team === me.team && p !== me, p === view && view.alive);
    }

    // ---- grapple ropes ----
    this.fx.beginRopes();
    for (const p of sim.players) {
      if (!p.alive || !p.grappleOn) continue;
      if (p === view) {
        this.tmp.set(0.22, -0.2, -0.5);
        this.camera.localToWorld(this.tmp);
        this.fx.rope(this.tmp.x, this.tmp.y, this.tmp.z, p.grapplePoint.x, p.grapplePoint.y, p.grapplePoint.z);
      } else {
        const m = this.chars[p.id]!.muzzle;
        this.fx.rope(m.x, m.y, m.z, p.grapplePoint.x, p.grapplePoint.y, p.grapplePoint.z);
      }
    }
    this.fx.endRopes();

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
        scoped: view.scope > 0,
        grappling: view.grappleOn,
        mantling: view.mantleT >= 0,
      });
    }
    this.input.lookDX = 0;
    this.input.lookDY = 0;

    // ---- draw ----
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    if (showVm) {
      this.renderer.clearDepth();
      this.renderer.render(this.vm.scene, this.vm.camera);
    }

    // ---- HUD ----
    const spread = sim.spreadOf(view);
    const gapPx = (Math.tan(spread) / Math.tan((this.camera.fov * Math.PI) / 360)) * (innerHeight / 2);
    this.hud.update(sim, view, me, gapPx, dt, this.fps, this.input.touch);
    void this.tmp2;
    void eyeHeight;
  }
}
