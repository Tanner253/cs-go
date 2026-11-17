// Game audio (WebAudio).
//
// Every sound is a named cue: one or more recordings (variations are picked at random).
// Each recording's loudness is measured when it is decoded and cues are played at a stated
// level, so a magazine click can never end up as loud as a gunshot. Cues are positioned
// with a pan + distance model and share one short, dark room reverb. Automatic fire chokes
// the tail of the previous shot so tails never pile up.
//
// The files in public/assets/audio are built by tools/build-sounds.mjs from CC0 packs
// (see CREDITS.md).

import type { WeaponKind } from '../sim/weapons';
import type { Foley } from './moves';

interface Listener {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface Cue {
  /** Recordings to choose from (file names without extension). */
  files: string[];
  /** Level the loudest 100 ms should be played at, dBFS, for a sound at the listener. */
  level: number;
  /** Playback speed (pitch) and its random spread. */
  rate?: number;
  jitter?: number;
  /** Distance (m) at which it has dropped to half. */
  ref?: number;
  /** Reverb send, 0..1. */
  wet?: number;
}

const numbered = (name: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${name}_${i + 1}`);
/** Recordings that ship as MP3 rather than WAV. */
const isMp3 = (file: string): boolean => /^(knife_|cloth_)/.test(file);

const SHOT = { ref: 20, wet: 0.18, jitter: 0.02 };
const QUIET = { ref: 8, wet: 0.1, jitter: 0.02 };
/** The sounds of handling a gun: close, dry, each a little different every time. */
const HANDLE = { ref: 2.5, wet: 0.04, jitter: 0.04 };

export const CUES: Record<string, Cue> = {
  // ---- gunshots: three designed takes per weapon (tools/build-sounds.mjs) ----
  'shot.kite': { files: numbered('shot_kite', 3), level: -17, ...SHOT },
  'shot.tern': { files: numbered('shot_tern', 3), level: -16.5, ...SHOT },
  'shot.maul': { files: numbered('shot_maul', 3), level: -14.5, ...SHOT, wet: 0.24 },
  'shot.stinger': { files: numbered('shot_stinger', 3), level: -17.5, ...SHOT },
  'shot.wasp': { files: numbered('shot_wasp', 3), level: -17, ...SHOT },
  'shot.hornet': { files: numbered('shot_hornet', 3), level: -17, ...SHOT },
  'shot.hammerhead': { files: numbered('shot_hammerhead', 3), level: -15, ...SHOT },
  'shot.mako': { files: numbered('shot_mako', 3), level: -15.5, ...SHOT },
  'shot.lumen': { files: numbered('shot_lumen', 3), level: -15.5, ...SHOT },
  'shot.osprey': { files: numbered('shot_osprey', 3), level: -15.5, ...SHOT },
  'shot.breaker': { files: numbered('shot_breaker', 3), level: -13.5, ...SHOT, wet: 0.24 },
  'shot.thresher': { files: numbered('shot_thresher', 3), level: -13, ...SHOT, wet: 0.26 },
  'shot.longsight': { files: numbered('shot_longsight', 3), level: -13, ...SHOT, wet: 0.3 },
  'shot.colossus': { files: numbered('shot_colossus', 3), level: -12.5, ...SHOT, wet: 0.32 },
  // ---- suppressed: it carries less than half as far ----
  'shot.osprey.quiet': { files: numbered('shot_osprey_q', 2), level: -20, ...QUIET },
  'shot.lumen.quiet': { files: numbered('shot_lumen_q', 2), level: -20, ...QUIET },
  'shot.hornet.quiet': { files: numbered('shot_hornet_q', 2), level: -20.5, ...QUIET },
  // ---- weapon handling: each moment of a reload is its own sound, played as the hands get there ----
  'fol.magout.pistol': { files: numbered('fol_magout_pistol', 2), level: -27, ...HANDLE },
  'fol.magin.pistol': { files: numbered('fol_magin_pistol', 2), level: -24.5, ...HANDLE },
  'fol.magout.rifle': { files: numbered('fol_magout_rifle', 2), level: -26, ...HANDLE },
  'fol.magin.rifle': { files: numbered('fol_magin_rifle', 2), level: -23.5, ...HANDLE },
  'fol.boltback': { files: numbered('fol_boltback', 2), level: -25, ...HANDLE },
  'fol.boltfwd': { files: numbered('fol_boltfwd', 2), level: -23, ...HANDLE },
  'fol.tap': { files: numbered('fol_tap', 2), level: -26, ...HANDLE },
  'fol.shell': { files: numbered('fol_shell', 2), level: -25, ...HANDLE },
  'fol.open': { files: numbered('fol_open', 2), level: -24.5, ...HANDLE },
  'fol.close': { files: numbered('fol_close', 2), level: -22.5, ...HANDLE },
  'fol.pump': { files: numbered('fol_pump', 2), level: -23.5, ...HANDLE },
  'fol.catch': { files: numbered('fol_catch', 2), level: -29, ...HANDLE },
  bolt: { files: numbered('click_plate', 2), level: -30, rate: 0.8, ref: 2, wet: 0.04, jitter: 0.04 },
  draw: { files: numbered('cloth', 2), level: -34, ref: 2, wet: 0.03, jitter: 0.06 },
  draw_metal: { files: numbered('click_metal', 3), level: -36, ref: 2, wet: 0.03, jitter: 0.08 },
  dry: { files: ['click_metal_1'], level: -32, rate: 1.6, ref: 2, wet: 0 },
  // ---- knife ----
  'knife.slash': { files: numbered('knife_slash', 3), level: -29, ref: 4, wet: 0.04, jitter: 0.05 },
  'knife.hit': { files: numbered('knife_flesh', 2), level: -24, ref: 4, wet: 0.05, jitter: 0.05 },
  'knife.draw': { files: ['knife_draw'], level: -32, ref: 2, wet: 0.03 },
  // ---- movement ----
  step: { files: numbered('step', 5), level: -28, ref: 8, wet: 0.08, jitter: 0.07 },
  land: { files: numbered('land', 3), level: -27, ref: 7, wet: 0.08, jitter: 0.05 },
  // ---- combat feedback ----
  impact: { files: numbered('impact', 5), level: -28, ref: 7, wet: 0.12, jitter: 0.12 },
  hit_body: { files: numbered('hit_body', 3), level: -29, rate: 1.25, ref: 1, wet: 0.02, jitter: 0.06 },
  hit_head: { files: numbered('hit_head', 2), level: -25, rate: 1.5, ref: 1, wet: 0.05 },
  hurt: { files: numbered('hurt', 2), level: -22, rate: 0.9, ref: 1, wet: 0.02, jitter: 0.05 },
  explosion: { files: numbered('explosion', 3), level: -11, rate: 0.8, ref: 40, wet: 0.45 },
  explosion_low: { files: ['explosion_low'], level: -10, ref: 40, wet: 0.3 },
  // ---- interface ----
  'ui.click': { files: ['ui_click_002'], level: -35, ref: 1, wet: 0 },
  'ui.tick': { files: ['ui_tick_001'], level: -36, ref: 1, wet: 0 },
  'ui.deny': { files: ['ui_error_004'], level: -32, ref: 1, wet: 0 },
  'ui.buy': { files: ['ui_confirmation_002'], level: -31, ref: 1, wet: 0 },
  'ui.plant': { files: ['ui_drop_002'], level: -29, ref: 1, wet: 0.1 },
  'ui.disarm': { files: ['ui_confirmation_001'], level: -29, ref: 1, wet: 0.1 },
  'ui.start': { files: ['ui_bong_001'], level: -31, ref: 1, wet: 0.1 },
  'ui.win': { files: ['ui_maximize_006'], level: -28, ref: 1, wet: 0.12 },
  'ui.lose': { files: ['ui_minimize_006'], level: -28, ref: 1, wet: 0.12 },
  'ui.scope': { files: ['ui_switch_002'], level: -36, ref: 1, wet: 0 },
};

interface Sample {
  buf: AudioBuffer;
  /** Loudest 100 ms, dBFS. */
  loud: number;
}

interface Voice {
  gain: GainNode;
  until: number;
}

function measure(buf: AudioBuffer): number {
  const x = buf.getChannelData(0);
  const w = Math.floor(buf.sampleRate * 0.1);
  let acc = 0, best = 0;
  for (let i = 0; i < x.length; i++) {
    acc += x[i]! * x[i]!;
    if (i >= w) acc -= x[i - w]! * x[i - w]!;
    if (acc > best) best = acc;
  }
  return 10 * Math.log10(best / Math.min(w, x.length) + 1e-12);
}

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private reverb!: ConvolverNode;
  private bank = new Map<string, Sample>();
  private loading = false;
  private listener: Listener = { x: 0, y: 0, z: 0, yaw: 0 };
  /** The last shot of each shooter, so the next one can choke its tail. */
  private lastShot = new Map<number, Voice>();
  volume = 0.7;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    // A limiter, not a compressor: it only acts on peaks, so sustained fire does not pump.
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -5;
    limit.knee.value = 4;
    limit.ratio.value = 16;
    limit.attack.value = 0.001;
    limit.release.value = 0.08;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume * 1.4;
    this.master.connect(limit).connect(ctx.destination);

    // A short, dark room: decaying noise that loses its highs as it dies away, different in
    // each ear. Bright white-noise tails are what make cheap reverbs hiss.
    const irLen = Math.floor(ctx.sampleRate * 1.1);
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const c = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < irLen; i++) {
        const t = i / irLen;
        lp += ((Math.random() * 2 - 1) - lp) * (0.5 - 0.42 * t);
        c[i] = lp * Math.pow(1 - t, 2.6) * (i < 400 ? i / 400 : 1);
      }
    }
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    this.reverb.connect(wet).connect(this.master);
    this.loadSamples();
  }

  private loadSamples(): void {
    if (this.loading || !this.ctx) return;
    this.loading = true;
    const ctx = this.ctx;
    const base = `${import.meta.env.BASE_URL}assets/audio/`;
    const names = new Set<string>();
    for (const cue of Object.values(CUES)) for (const f of cue.files) names.add(f);
    for (const name of names) {
      fetch(`${base}${name}.${isMp3(name) ? 'mp3' : 'wav'}`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((data) => ctx.decodeAudioData(data))
        .then((buf) => { this.bank.set(name, { buf, loud: measure(buf) }); })
        .catch(() => { /* that recording is skipped; its cue uses the others or stays silent */ });
    }
  }

  /** Number of recordings decoded so far (for diagnostics). */
  get samplesLoaded(): number {
    return this.bank.size;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.value = v * 1.4;
  }

  private crackBuf: AudioBuffer | null = null;

  setListener(x: number, y: number, z: number, yaw: number): void {
    this.listener.x = x; this.listener.y = y; this.listener.z = z; this.listener.yaw = yaw;
  }

  /** Output chain for a sound at a world position (or centred if `x` is null). */
  private out(x: number | null, y: number, z: number, refDist: number, wet: number): GainNode | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return null;
    let gain = 1, pan = 0, cutoff = 20000;
    if (x !== null) {
      const L = this.listener;
      const dx = x - L.x, dy = y - L.y, dz = z - L.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      gain = 1 / (1 + (dist / refDist) ** 1.5);
      if (gain < 0.01) return null;
      // Right vector of the listener is (cos yaw, 0, -sin yaw).
      const d2 = Math.hypot(dx, dz) || 1;
      pan = ((dx * Math.cos(L.yaw) - dz * Math.sin(L.yaw)) / d2) * Math.min(1, dist / 2) * 0.8;
      // Air soaks up highs with distance, gently.
      cutoff = 18000 / (1 + dist / 35);
    }
    const g = ctx.createGain();
    g.gain.value = gain;
    let head: AudioNode = g;
    if (cutoff < 15000) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.max(1400, cutoff);
      lp.Q.value = 0.5;
      g.connect(lp);
      head = lp;
    }
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    head.connect(p);
    p.connect(this.master);
    if (wet > 0) {
      const w = ctx.createGain();
      // Distant sounds are mostly room.
      w.gain.value = wet * (x === null ? 1 : 1 + (1 - gain) * 1.5);
      p.connect(w).connect(this.reverb);
    }
    return g;
  }

  /**
   * Play a cue. Returns the voice (for choking) or null if nothing sounded.
   * @param mul extra gain
   * @param delay seconds from now
   * @param fit play it over this many seconds (speed changed within reason)
   */
  private play(name: string, x: number | null, y = 0, z = 0, mul = 1, delay = 0, fit = 0): Voice | null {
    const cue = CUES[name];
    const ctx = this.ctx;
    if (!cue || !ctx) return null;
    const start = Math.floor(Math.random() * cue.files.length);
    let sample: Sample | undefined;
    for (let i = 0; i < cue.files.length && !sample; i++) sample = this.bank.get(cue.files[(start + i) % cue.files.length]!);
    if (!sample) return null;
    const out = this.out(x, y, z, cue.ref ?? 8, cue.wet ?? 0.1);
    if (!out) return null;
    const src = ctx.createBufferSource();
    src.buffer = sample.buf;
    let rate = (cue.rate ?? 1) * (1 + (Math.random() * 2 - 1) * (cue.jitter ?? 0));
    if (fit > 0) rate = Math.min(1.45, Math.max(0.7, sample.buf.duration / fit));
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = Math.pow(10, (cue.level - sample.loud) / 20) * mul;
    src.connect(g).connect(out);
    const at = ctx.currentTime + delay;
    src.start(at);
    return { gain: g, until: at + sample.buf.duration / rate };
  }

  // ---- game-facing API ------------------------------------------------------------------

  /**
   * A gunshot. `x` null = your own gun. `shooter` identifies who fired so rapid fire from
   * one gun chokes its previous tail instead of stacking twenty of them.
   */
  shot(kind: WeaponKind, x: number | null, y = 0, z = 0, id = '', shooter = -1, quiet = false): void {
    const ctx = this.ctx;
    if (!ctx || kind === 'knife') return;
    const prev = this.lastShot.get(shooter);
    if (prev && prev.until > ctx.currentTime) {
      prev.gain.gain.cancelScheduledValues(ctx.currentTime);
      prev.gain.gain.setTargetAtTime(0, ctx.currentTime + 0.04, 0.06);
    }
    const v = this.play(quiet && CUES[`shot.${id}.quiet`] ? `shot.${id}.quiet` : `shot.${id}`, x, y, z, x === null ? 1 : 1.15);
    if (v) this.lastShot.set(shooter, v);
  }

  /**
   * One moment of handling your own gun (a magazine seating, a bolt let go): played by the
   * viewmodel as the hands reach it, so the sound and the picture cannot drift apart.
   */
  foley(sound: Foley, kind: WeaponKind): void {
    if (sound === 'cloth') { this.play('draw', null, 0, 0, 0.8); return; }
    const small = kind === 'pistol' || kind === 'smg';
    const cue = sound === 'magout' || sound === 'magin' ? `fol.${sound}.${small ? 'pistol' : 'rifle'}` : `fol.${sound}`;
    // (a pistol's slide is a lighter thing than a rifle's bolt)
    this.play(cue, null, 0, 0, small && (sound === 'boltback' || sound === 'boltfwd') ? 0.8 : 1);
  }

  /** Someone else reloading nearby: the magazine out, and the new one in. */
  reloadHeard(x: number, y: number, z: number, kind: WeaponKind, duration: number): void {
    const small = kind === 'pistol' || kind === 'smg';
    if (kind === 'shotgun') {
      for (let i = 0; i < 3; i++) this.play('fol.shell', x, y, z, 1.6, duration * (0.15 + i * 0.2));
      return;
    }
    this.play(`fol.magout.${small ? 'pistol' : 'rifle'}`, x, y, z, 1.6, duration * 0.2);
    this.play(`fol.magin.${small ? 'pistol' : 'rifle'}`, x, y, z, 1.6, duration * 0.45);
  }

  step(x: number | null, y = 0, z = 0): void {
    this.play('step', x, y, z, x === null ? 0.7 : 1.3);
  }

  land(x: number | null, y: number, z: number, hard: number): void {
    this.play('land', x, y, z, 0.5 + hard * 0.7);
  }

  /** Jumping makes no sound of its own; the landing does. */
  jump(_x: number | null, _y = 0, _z = 0): void {}

  draw(id = ''): void {
    if (id === 'edge') {
      this.play('knife.draw', null);
      return;
    }
    this.play('draw', null);
    this.play('draw_metal', null, 0, 0, 1, 0.14);
  }

  /** Your own suppressor being screwed on or off: a few turns of metal on metal, then it seats (or comes free). */
  fit(on: boolean): void {
    for (const at of [0.5, 0.72, 0.94]) this.play('draw_metal', null, 0, 0, 0.8, at);
    this.play('bolt', null, 0, 0, 0.9, on ? 1.2 : 0.42);
    this.play('draw', null, 0, 0, 1, on ? 0.05 : 1.15);
  }

  dry(): void {
    this.play('dry', null);
  }

  knife(hit: boolean, x: number | null, y = 0, z = 0): void {
    this.play('knife.slash', x, y, z);
    if (hit) this.play('knife.hit', x, y, z, 1, 0.06);
  }

  /** Feedback when one of your bullets lands. */
  hit(head: boolean): void {
    this.play(head ? 'hit_head' : 'hit_body', null);
  }

  hurt(): void {
    this.play('hurt', null);
  }

  /**
   * A round going past the listener's head: the sharp crack of it, then a short hiss.
   * (Made here rather than recorded: a burst of noise, high-passed, gone in a twentieth of a second.)
   */
  crack(x: number, y: number, z: number, loud: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const out = this.out(x, y, z, 5, 0.06);
    if (!out) return;
    if (!this.crackBuf) {
      const n = Math.floor(ctx.sampleRate * 0.07);
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) {
        const t = i / ctx.sampleRate;
        // The crack (2 ms), and the hiss falling away behind it.
        d[i] = (Math.random() * 2 - 1) * (Math.exp(-t / 0.0022) + 0.22 * Math.exp(-t / 0.018));
      }
      this.crackBuf = buf;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.crackBuf;
    src.playbackRate.value = 0.9 + Math.random() * 0.25;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1700;
    const g = ctx.createGain();
    g.gain.value = 0.2 * loud;
    src.connect(hp).connect(g).connect(out);
    src.start();
  }

  /** A bullet striking the level near the listener. */
  impact(x: number, y: number, z: number): void {
    this.play('impact', x, y, z);
  }

  /** Kept for API compatibility; the game has no grapple. */
  grapple(_ok: boolean, _x: number | null, _y = 0, _z = 0): void {}
  whoosh(_x: number | null, _y = 0, _z = 0): void {}

  /** The planted charge's timer: a plain electronic blip. */
  beep(x: number, y: number, z: number, urgent: boolean): void {
    const o = this.out(x, y, z, 14, 0.15);
    const ctx = this.ctx;
    if (!o || !ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = urgent ? 2400 : 2000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.045, t + 0.004);
    g.gain.setValueAtTime(0.045, t + 0.055);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.075);
    osc.connect(g).connect(o);
    osc.start(t);
    osc.stop(t + 0.09);
  }

  explosion(x: number, y: number, z: number): void {
    this.play('explosion', x, y, z);
    this.play('explosion_low', x, y, z);
  }

  /** Interface and announcer cues. */
  ui(kind: 'click' | 'deny' | 'buy' | 'plant' | 'disarm' | 'win' | 'lose' | 'start' | 'tick' | 'scope'): void {
    this.play(`ui.${kind}`, null);
  }

  /** Audition a cue by name (Settings → sound test). */
  test(name: string): void {
    this.unlock();
    if (name === 'charge beep') this.beep(this.listener.x, this.listener.y, this.listener.z - 2, false);
    else this.play(name, null);
  }

  static cueNames(): string[] {
    return [...Object.keys(CUES), 'charge beep'];
  }
}
