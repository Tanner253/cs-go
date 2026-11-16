// Game audio (WebAudio). Weapons, handling and footsteps are recordings (see CREDITS.md),
// decoded after the first user gesture; anything without a recording, or not loaded yet,
// falls back to a synthesised recipe. Everything is positioned with a pan + distance model.

import type { WeaponKind } from '../sim/weapons';

interface Listener {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface ShotRecipe {
  dur: number;
  lp: number;
  thump: number;
  thumpGain: number;
  crack: number;
  gain: number;
  tail: number;
}

const SHOTS: Record<WeaponKind, ShotRecipe> = {
  rifle: { dur: 0.2, lp: 3600, thump: 130, thumpGain: 0.9, crack: 0.5, gain: 0.85, tail: 0.3 },
  smg: { dur: 0.12, lp: 5200, thump: 170, thumpGain: 0.5, crack: 0.45, gain: 0.6, tail: 0.18 },
  pistol: { dur: 0.14, lp: 4400, thump: 190, thumpGain: 0.6, crack: 0.55, gain: 0.65, tail: 0.2 },
  sniper: { dur: 0.42, lp: 2600, thump: 85, thumpGain: 1.3, crack: 0.7, gain: 1.0, tail: 0.6 },
  shotgun: { dur: 0.3, lp: 2400, thump: 100, thumpGain: 1.2, crack: 0.4, gain: 0.95, tail: 0.4 },
  knife: { dur: 0, lp: 0, thump: 0, thumpGain: 0, crack: 0, gain: 0, tail: 0 },
};

/** Recordings shipped in public/assets/sounds. */
const SAMPLES = [
  'shot_ak', 'shot_ar', 'shot_pistol', 'shot_pistol_2', 'shot_pistol_3', 'shot_deagle', 'shot_mp7', 'shot_rifle', 'shot_50', 'shot_shotgun',
  'bolt', 'pistol_mag_in', 'pistol_mag_out', 'rifle_mag_in', 'rifle_mag_out', 'ak_mag_in', 'ak_mag_out', 'ak_rack', 'rack',
  'uzi_mag_in', 'uzi_mag_out', 'uzi_rack', 'casing', 'step_concrete', 'step_concrete_2', 'step_concrete_3', 'step_concrete_4', 'step_concrete_5',
  'bullet_crack', 'bullet_crack_2', 'bullet_crack_3', 'hit_metal', 'hit_metal_2', 'hit_metal_3', 'c4_beep', 'punch', 'punch_2', 'thud', 'thud_2',
  'drop_gun', 'take_metal', 'cloth', 'cloth_2',
] as const;
type SampleName = (typeof SAMPLES)[number];

const SHOT_SAMPLE: Record<string, SampleName> = {
  hammerhead: 'shot_ak', lumen: 'shot_ar', wasp: 'shot_mp7', kite: 'shot_pistol', tern: 'shot_pistol_2', maul: 'shot_deagle',
  longsight: 'shot_50', breaker: 'shot_shotgun',
};

/** Handling sounds through a reload: [fraction of the reload, sample, gain]. */
const RELOAD_FOLEY: Record<WeaponKind, [number, SampleName, number][]> = {
  rifle: [[0.16, 'ak_mag_out', 0.9], [0.52, 'ak_mag_in', 1], [0.8, 'ak_rack', 1]],
  smg: [[0.14, 'uzi_mag_out', 0.9], [0.5, 'uzi_mag_in', 1], [0.8, 'uzi_rack', 1]],
  pistol: [[0.14, 'pistol_mag_out', 0.9], [0.55, 'pistol_mag_in', 1], [0.84, 'rack', 0.9]],
  sniper: [[0.1, 'bolt', 0.9], [0.5, 'rifle_mag_in', 1], [0.82, 'bolt', 1]],
  shotgun: [[0.2, 'rifle_mag_in', 0.9], [0.5, 'rifle_mag_in', 0.9], [0.84, 'rack', 1]],
  knife: [],
};

export class GameAudio {
  private bank = new Map<string, AudioBuffer>();
  private loading = false;

  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private reverb!: ConvolverNode;
  private reverbGain!: GainNode;
  private noise!: AudioBuffer;
  private listener: Listener = { x: 0, y: 0, z: 0, yaw: 0 };
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
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 5;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(comp).connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Small synthetic room so shots do not sound bone dry.
    const irLen = Math.floor(ctx.sampleRate * 0.9);
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const c = ir.getChannelData(ch);
      for (let i = 0; i < irLen; i++) c[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 3.2);
    }
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = ir;
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.35;
    this.reverb.connect(this.reverbGain).connect(this.master);
    this.loadSamples();
  }

  private loadSamples(): void {
    if (this.loading || !this.ctx) return;
    this.loading = true;
    const ctx = this.ctx;
    const base = `${import.meta.env.BASE_URL}assets/sounds/`;
    for (const name of SAMPLES) {
      fetch(`${base}${name}.wav`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((data) => ctx.decodeAudioData(data))
        .then((buf) => { this.bank.set(name, buf); })
        .catch(() => { /* synth fallback stays in use for this sound */ });
    }
  }

  /** Number of recordings decoded so far (for diagnostics). */
  get samplesLoaded(): number {
    return this.bank.size;
  }

  /** Play a recording if it is loaded. Returns false so callers can fall back to synthesis. */
  private sample(
    name: SampleName, x: number | null, y: number, z: number,
    gain = 1, refDist = 9, wet = 0.2, rate = 1, delay = 0,
  ): boolean {
    const buf = this.bank.get(name);
    if (!buf) return false;
    const o = this.out(x, y, z, refDist, wet);
    if (!o) return true;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(o.node);
    src.start(ctx.currentTime + delay);
    return true;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.value = v;
  }

  setListener(x: number, y: number, z: number, yaw: number): void {
    this.listener.x = x; this.listener.y = y; this.listener.z = z; this.listener.yaw = yaw;
  }

  /** Output chain for a sound at a world position (or centred if `pos` is null). */
  private out(x: number | null, y = 0, z = 0, refDist = 9, wet = 0.25): { node: AudioNode; gain: number } | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return null;
    let gain = 1, pan = 0, muffle = 20000;
    if (x !== null) {
      const L = this.listener;
      const dx = x - L.x, dy = y - L.y, dz = z - L.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      gain = 1 / (1 + (dist / refDist) ** 1.6);
      if (gain < 0.012) return null;
      // Right vector of the listener is (cos yaw, 0, -sin yaw).
      const d2 = Math.hypot(dx, dz) || 1;
      pan = ((dx * Math.cos(L.yaw) - dz * Math.sin(L.yaw)) / d2) * Math.min(1, dist / 2) * 0.85;
      muffle = 20000 / (1 + dist / 18);
    }
    const g = ctx.createGain();
    g.gain.value = gain;
    let head: AudioNode = g;
    if (muffle < 16000) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.max(700, muffle);
      g.connect(lp);
      head = lp;
    }
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    head.connect(p);
    p.connect(this.master);
    if (wet > 0) {
      const w = ctx.createGain();
      w.gain.value = wet;
      p.connect(w).connect(this.reverb);
    }
    return { node: g, gain };
  }

  private noiseBurst(dest: AudioNode, t: number, dur: number, type: BiquadFilterType, freq: number, q: number, gain: number, freqEnd = freq): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loopStart = 0;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd !== freq) f.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5, dur + 0.02);
  }

  private tone(dest: AudioNode, t: number, dur: number, type: OscillatorType, f0: number, f1: number, gain: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  shot(kind: WeaponKind, x: number | null, y = 0, z = 0, id = ''): void {
    const r = SHOTS[kind];
    if (r.dur === 0) return;
    const name = SHOT_SAMPLE[id];
    if (name && this.sample(name, x, y, z, 0.95, 18, 0.28 + r.tail * 0.4, 0.97 + Math.random() * 0.06)) {
      if (x === null) {
        // Your own gun: the spent case, and the bolt on a bolt-action.
        if (kind === 'sniper') this.sample('bolt', null, 0, 0, 0.8, 1, 0.1, 1, 0.42);
        else if (kind !== 'shotgun') this.sample('casing', null, 0, 0, 0.25, 1, 0.1, 0.9 + Math.random() * 0.3, 0.38);
      }
      return;
    }
    const o = this.out(x, y, z, 16, 0.3 + r.tail * 0.5);
    if (!o) return;
    const t = this.ctx!.currentTime;
    const v = 0.94 + Math.random() * 0.12;
    // Body: low-passed noise that closes down quickly.
    this.noiseBurst(o.node, t, r.dur, 'lowpass', r.lp * v, 0.7, r.gain, r.lp * 0.25);
    // Crack: a few milliseconds of bright noise.
    this.noiseBurst(o.node, t, 0.03, 'highpass', 2600, 0.5, r.crack);
    // Thump: pitch-dropping sine for chest weight.
    this.tone(o.node, t, r.dur * 0.8, 'sine', r.thump * 1.6 * v, r.thump * 0.45, r.thumpGain);
  }

  step(x: number | null, y = 0, z = 0): void {
    const n = 1 + Math.floor(Math.random() * 5);
    const name = (n === 1 ? 'step_concrete' : `step_concrete_${n}`) as SampleName;
    if (this.sample(name, x, y, z, x === null ? 0.45 : 0.9, 6, 0.1, 0.94 + Math.random() * 0.12)) return;
    const o = this.out(x, y, z, 5, 0.08);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(o.node, t, 0.07, 'bandpass', 380 + Math.random() * 180, 1.2, 0.5);
    this.tone(o.node, t, 0.06, 'sine', 110, 60, 0.35);
  }

  land(x: number | null, y: number, z: number, hard: number): void {
    if (this.sample(Math.random() < 0.5 ? 'thud' : 'thud_2', x, y, z, 0.35 + hard * 0.6, 6, 0.12)) return;
    const o = this.out(x, y, z, 6, 0.1);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(o.node, t, 0.12, 'lowpass', 700, 0.8, 0.5 + hard * 0.5);
    this.tone(o.node, t, 0.12, 'sine', 120, 45, 0.6 + hard * 0.4);
  }

  jump(x: number | null, y = 0, z = 0): void {
    const o = this.out(x, y, z, 4, 0.05);
    if (!o) return;
    this.noiseBurst(o.node, this.ctx!.currentTime, 0.08, 'bandpass', 600, 0.8, 0.25);
  }

  reload(kind: WeaponKind, duration: number): void {
    const foley = RELOAD_FOLEY[kind];
    if (foley.length > 0 && this.bank.has(foley[0]![1])) {
      for (const [at, name, gain] of foley) this.sample(name, null, 0, 0, gain, 1, 0.08, 1, at * duration);
      return;
    }
    const o = this.out(null, 0, 0, 1, 0.05);
    if (!o) return;
    const t = this.ctx!.currentTime;
    const click = (at: number, f: number, g: number) => {
      this.noiseBurst(o.node, t + at * duration, 0.035, 'bandpass', f, 3, g);
      this.tone(o.node, t + at * duration, 0.03, 'square', f * 0.5, f * 0.3, g * 0.15);
    };
    click(0.16, 1800, 0.5); // mag release
    click(0.3, 900, 0.35); // mag out
    click(0.64, 1400, 0.6); // mag seated
    click(0.78, 2400, 0.55); // charging handle back
    click(0.83, 2000, 0.6); // ...and forward
    void kind;
  }

  draw(): void {
    if (this.sample(Math.random() < 0.5 ? 'cloth' : 'cloth_2', null, 0, 0, 0.5, 1, 0.05)) {
      this.sample('take_metal', null, 0, 0, 0.35, 1, 0.05, 1, 0.12);
      return;
    }
    const o = this.out(null, 0, 0, 1, 0.03);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(o.node, t, 0.12, 'bandpass', 1500, 0.7, 0.18, 3200);
    this.noiseBurst(o.node, t + 0.14, 0.03, 'bandpass', 2400, 3, 0.3);
  }

  dry(): void {
    const o = this.out(null, 0, 0, 1, 0);
    if (!o) return;
    this.noiseBurst(o.node, this.ctx!.currentTime, 0.025, 'bandpass', 3000, 4, 0.5);
  }

  knife(hit: boolean, x: number | null, y = 0, z = 0): void {
    const o = this.out(x, y, z, 4, 0.05);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(o.node, t, 0.16, 'bandpass', 900, 1.2, 0.45, 4200);
    if (hit && this.sample(Math.random() < 0.5 ? 'punch' : 'punch_2', x, y, z, 0.9, 4, 0.08, 1, 0.05)) return;
    if (hit) {
      this.noiseBurst(o.node, t + 0.05, 0.1, 'lowpass', 900, 1, 0.8);
      this.tone(o.node, t + 0.05, 0.1, 'sine', 160, 70, 0.6);
    }
  }

  /** Feedback when one of your bullets lands. */
  hit(head: boolean): void {
    const o = this.out(null, 0, 0, 1, 0.05);
    if (!o) return;
    const t = this.ctx!.currentTime;
    if (head) {
      this.tone(o.node, t, 0.16, 'triangle', 2600, 2100, 0.4);
      this.tone(o.node, t, 0.1, 'sine', 3900, 3500, 0.2);
    } else {
      this.noiseBurst(o.node, t, 0.05, 'bandpass', 1300, 2, 0.35);
    }
  }

  hurt(): void {
    const o = this.out(null, 0, 0, 1, 0);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(o.node, t, 0.12, 'lowpass', 500, 1, 0.8);
    this.tone(o.node, t, 0.14, 'sine', 90, 50, 0.7);
  }

  grapple(ok: boolean, x: number | null, y = 0, z = 0): void {
    const o = this.out(x, y, z, 12, 0.15);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.tone(o.node, t, 0.18, 'sawtooth', 300, ok ? 1600 : 500, 0.18);
    this.noiseBurst(o.node, t, 0.2, 'bandpass', 2500, 2, 0.3, 6000);
    if (ok) this.noiseBurst(o.node, t + 0.16, 0.06, 'bandpass', 1100, 3, 0.6);
  }

  whoosh(x: number | null, y = 0, z = 0): void {
    const o = this.out(x, y, z, 6, 0.05);
    if (!o) return;
    this.noiseBurst(o.node, this.ctx!.currentTime, 0.2, 'bandpass', 500, 1, 0.3, 1800);
  }

  /** A bullet striking the level near the listener. */
  impact(x: number, y: number, z: number): void {
    const n = 1 + Math.floor(Math.random() * 3);
    this.sample((n === 1 ? 'hit_metal' : `hit_metal_${n}`) as SampleName, x, y, z, 0.35, 5, 0.15, 0.9 + Math.random() * 0.3);
  }

  beep(x: number, y: number, z: number, urgent: boolean): void {
    if (this.sample('c4_beep', x, y, z, 0.8, 14, 0.2, urgent ? 1.25 : 1)) return;
    const o = this.out(x, y, z, 14, 0.2);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.tone(o.node, t, 0.07, 'square', urgent ? 1900 : 1500, urgent ? 1900 : 1500, 0.16);
  }

  explosion(x: number, y: number, z: number): void {
    const o = this.out(x, y, z, 40, 0.6);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(o.node, t, 1.6, 'lowpass', 2400, 0.6, 1.6, 120);
    this.tone(o.node, t, 1.1, 'sine', 90, 28, 1.6);
    this.noiseBurst(o.node, t, 0.08, 'highpass', 1800, 0.5, 1.0);
  }

  /** Short UI / announcer cues. */
  ui(kind: 'click' | 'deny' | 'buy' | 'plant' | 'disarm' | 'win' | 'lose' | 'start' | 'tick'): void {
    const o = this.out(null, 0, 0, 1, kind === 'click' || kind === 'tick' ? 0 : 0.2);
    if (!o) return;
    const t = this.ctx!.currentTime;
    const n = (at: number, f: number, d = 0.12, g = 0.22, type: OscillatorType = 'triangle') => this.tone(o.node, t + at, d, type, f, f, g);
    switch (kind) {
      case 'click': n(0, 1200, 0.03, 0.12, 'square'); break;
      case 'tick': n(0, 900, 0.03, 0.1, 'square'); break;
      case 'deny': n(0, 220, 0.12, 0.2, 'square'); break;
      case 'buy': n(0, 880, 0.06); n(0.06, 1320, 0.1); break;
      case 'plant': n(0, 660, 0.1); n(0.12, 660, 0.1); n(0.24, 990, 0.25); break;
      case 'disarm': n(0, 990, 0.1); n(0.1, 1320, 0.1); n(0.2, 1760, 0.3); break;
      case 'start': n(0, 440, 0.1); n(0.12, 660, 0.2); break;
      case 'win': n(0, 523, 0.14); n(0.14, 659, 0.14); n(0.28, 784, 0.14); n(0.42, 1047, 0.4); break;
      case 'lose': n(0, 392, 0.2); n(0.2, 311, 0.2); n(0.4, 233, 0.5); break;
    }
  }
}
