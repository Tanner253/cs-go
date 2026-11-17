// Builds public/assets/audio from the raw CC0 sound packs in _reference/sounds-src
// (git-ignored; see CREDITS.md for where each pack is downloaded from).
//
//   node tools/build-sounds.mjs
//
// Gunshots are designed from The Free Firearm Sound Library (see "sound design" below);
// reload and handling sounds, footsteps and impacts are built from Kenney's impact pack.
// Kenney's Ogg files are decoded to WAV so every browser (Safari included) can play them.

import fs from 'node:fs';
import path from 'node:path';
import { OggVorbisDecoder } from '@wasm-audio-decoders/ogg-vorbis';

const SRC = '_reference/sounds-src';
const OUT = 'public/assets/audio';
fs.mkdirSync(OUT, { recursive: true });

// ---- WAV in / out ---------------------------------------------------------------------

function readWav(file) {
  const b = fs.readFileSync(file);
  let o = 12, fmt = null, data = null;
  while (o < b.length - 8) {
    const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      let tag = b.readUInt16LE(o + 8);
      if (tag === 0xfffe) tag = b.readUInt16LE(o + 8 + 24); // extensible: real format is in the sub-format GUID
      fmt = { tag, ch: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    } else if (id === 'data') {
      data = b.subarray(o + 8, Math.min(b.length, o + 8 + size));
      break;
    }
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`not a WAV file: ${file}`);
  const bytes = fmt.bits / 8, frames = Math.floor(data.length / (bytes * fmt.ch));
  const out = new Float32Array(frames); // mixed to mono
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const p = (i * fmt.ch + c) * bytes;
      if (fmt.tag === 3) s += bytes === 4 ? data.readFloatLE(p) : data.readDoubleLE(p);
      else if (bytes === 2) s += data.readInt16LE(p) / 32768;
      else if (bytes === 3) s += data.readIntLE(p, 3) / 8388608;
      else if (bytes === 4) s += data.readInt32LE(p) / 2147483648;
    }
    out[i] = s / fmt.ch;
  }
  return { rate: fmt.rate, x: out };
}

function writeWav(name, x, rate) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(path.join(OUT, `${name}.wav`), b);
}

// ---- processing ------------------------------------------------------------------------

/** Halve (or third, ...) the sample rate with a windowed-sinc low-pass first. */
function decimate(x, factor) {
  if (factor === 1) return x;
  const taps = 48 * factor + 1, mid = (taps - 1) / 2, fc = 0.45 / factor;
  const h = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    h[i] = sinc * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1)));
    sum += h[i];
  }
  const out = new Float32Array(Math.floor(x.length / factor));
  for (let i = 0; i < out.length; i++) {
    let acc = 0;
    const c = i * factor;
    for (let k = 0; k < taps; k++) {
      const j = c + k - mid;
      if (j >= 0 && j < x.length) acc += x[j] * h[k];
    }
    out[i] = acc / sum;
  }
  return out;
}

const peakOf = (x) => { let p = 0; for (const v of x) if (Math.abs(v) > p) p = Math.abs(v); return p; };
function normalise(x, db = -1) {
  const p = peakOf(x), g = p > 0 ? Math.pow(10, db / 20) / p : 1;
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}
function loud100(x, rate) {
  const w = Math.floor(rate * 0.1);
  let acc = 0, best = 0;
  for (let i = 0; i < x.length; i++) {
    acc += x[i] * x[i];
    if (i >= w) acc -= x[i - w] * x[i - w];
    if (acc > best) best = acc;
  }
  return 10 * Math.log10(best / Math.min(w, x.length) + 1e-12);
}

/** Start times (seconds) of each separate shot in a recording. */
function onsets(x, rate) {
  const block = Math.floor(rate * 0.002);
  const env = new Float32Array(Math.floor(x.length / block));
  for (let i = 0; i < env.length; i++) {
    let m = 0;
    for (let j = i * block; j < (i + 1) * block; j++) if (Math.abs(x[j]) > m) m = Math.abs(x[j]);
    env[i] = m;
  }
  const thr = peakOf(env) * 0.3;
  const out = [];
  let quiet = Infinity;
  for (let i = 0; i < env.length; i++) {
    if (env[i] > thr) {
      if (quiet * 0.002 >= 0.5) {
        // Walk back to where the transient really starts.
        let s = i;
        while (s > 0 && i - s < 10 && env[s - 1] > thr * 0.08) s--;
        out.push((s * block) / rate);
      }
      quiet = 0;
    } else if (env[i] < thr * 0.35) {
      quiet++;
    }
  }
  return out;
}

function cut(x, rate, start, len) {
  const a = Math.max(0, Math.floor((start - 0.003) * rate)), n = Math.min(x.length - a, Math.floor(len * rate));
  const y = x.slice(a, a + n);
  const fin = Math.floor(rate * 0.001), fout = Math.floor(n * 0.45);
  for (let i = 0; i < fin; i++) y[i] *= i / fin;
  for (let i = 0; i < fout; i++) y[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fout);
  return y;
}

// ---- sound design: the tools ----------------------------------------------------------
//
// A raw recording of a gunshot is a crack and very little else: measured, the shots in the
// library have almost nothing under 250 Hz and have fallen 20 dB within a fiftieth of a
// second. Played as they are they sound like cap guns. Each weapon's shot is therefore built
// here in layers: the recording's own crack and what body it has, a thump (a sine falling in
// pitch) for the weight of it, a bark (a band of noise) for the muzzle blast, the far
// microphone's take of the same gun for the echo of the range, a wash of noise dying away
// behind that, and the click of the action. The sum is driven into a soft clip, which is what
// gives a shot its density, and levelled.

const SR = 48000;
const lcg = (seed) => { let s = (seed * 2654435761) >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); };

function coef(type, f, q = 0.707, db = 0) {
  const A = Math.pow(10, db / 40), w = (2 * Math.PI * Math.min(f, SR * 0.45)) / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else { b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; } // peak
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function filt(x, type, f, q, db) {
  const [b0, b1, b2, a1, a2] = coef(type, f, q, db);
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
const noise = (n, rnd) => { const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = rnd() * 2 - 1; return y; };
/** Shape in place: up in `attack` seconds, away with time constant `tau`. */
function shape(x, attack, tau) {
  for (let i = 0; i < x.length; i++) { const t = i / SR; x[i] *= (1 - Math.exp(-t / attack)) * Math.exp(-t / tau); }
  return x;
}
/** A sine falling from f0 to f1 (the fall has time constant `drop`), dying away with `tau`. */
function thump(n, f0, f1, drop, tau) {
  const y = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (f1 + (f0 - f1) * Math.exp(-t / drop))) / SR;
    y[i] = Math.sin(ph) * Math.exp(-t / tau) * (1 - Math.exp(-t / 0.0008));
  }
  return y;
}
/** Soft clip in place (expects a peak near 1): quiet parts come up, peaks stay put. */
function drive(x, d) { const k = Math.tanh(d); for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * d) / k; return x; }
function mix(out, x, g, atSec = 0) {
  const at = Math.floor(atSec * SR);
  for (let i = 0; i < x.length && at + i < out.length; i++) out[at + i] += x[i] * g;
  return out;
}
/** Play `x` (recorded at `rate`) back at `speed`, resampled to SR. */
function repitch(x, speed, rate = SR) {
  const step = (speed * rate) / SR, n = Math.floor((x.length - 1) / step);
  const y = new Float32Array(Math.max(0, n));
  for (let i = 0; i < n; i++) { const p = i * step, j = Math.floor(p), f = p - j; y[i] = x[j] + (x[j + 1] - x[j]) * f; }
  return y;
}
function fadeOut(x, part = 0.3) {
  const n = Math.floor(x.length * part);
  for (let i = 0; i < n; i++) x[x.length - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
  return x;
}
/** A wash of noise that darkens as it dies away: the air after the shot. */
function wash(n, rnd, tau, from = 3600, to = 420) {
  const y = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, fc = to + (from - to) * Math.exp(-t / (tau * 0.7));
    lp += ((rnd() * 2 - 1) - lp) * (1 - Math.exp((-2 * Math.PI * fc) / SR));
    y[i] = lp * Math.exp(-t / tau) * (1 - Math.exp(-t / 0.015));
  }
  return y;
}
/** A click of metal on metal made of nothing but a ringing band of noise (for where no recording is layered). */
function clack(rnd, f = 3200, tau = 0.006) {
  return shape(filt(noise(Math.floor(SR * 0.05), rnd), 'bp', f, 3.5), 0.0003, tau);
}

// ---- gunshots: The Free Firearm Sound Library, designed -----------------------------------

const LIB = path.join(SRC, 'firearm-library', 'Prepared SFX Library');
const takesCache = new Map();
/** Every separate shot in a recording, from its onset, at SR, each peaking at 1. */
function takesOf(rel, len) {
  const key = `${rel}|${len}`;
  if (takesCache.has(key)) return takesCache.get(key);
  const file = path.join(LIB, rel);
  if (!fs.existsSync(file)) { console.warn(`missing ${file}`); takesCache.set(key, []); return []; }
  const { rate, x } = readWav(file);
  const factor = rate % SR === 0 ? rate / SR : 1;
  const out = onsets(x, rate).map((s) => {
    const y = decimate(cut(x, rate, s, len), factor);
    return normalise(factor === 1 && rate !== SR ? repitch(y, 1, rate) : y, 0);
  });
  takesCache.set(key, out);
  return out;
}

/**
 * Each weapon's shot. `near`/`mid`: the close and far microphones' recordings of the gun it is
 * built on; `rate`: played faster or slower; `thump`: [from Hz, to Hz, seconds]; `bark`: [Hz,
 * seconds]; `air`: seconds the wash of noise lasts; `heavy`: decibels of weight added to the
 * thump and taken off the crack; `mech`: seconds after the shot the action is heard (omitted:
 * worked by hand later); `drive`: how hard the sum is pushed into the soft clip.
 */
const SHOTS = {
  kite: { near: 'Walther PPQ/X_39P.wav', mid: 'Walther PPQ/X_31P.wav', len: 0.7, thump: [210, 95, 0.028], bark: [950, 0.026], air: 0.13, heavy: -1, mech: 0.045, drive: 2.1 },
  tern: { near: '1911/A_42P.wav', mid: '1911/A_34P.wav', len: 0.8, thump: [175, 78, 0.036], bark: [760, 0.034], air: 0.16, heavy: 0.5, mech: 0.05, drive: 2.1 },
  maul: { near: '1911/A_42P.wav', mid: '1911/A_34P.wav', rate: 0.8, len: 1.1, thump: [140, 55, 0.06], bark: [540, 0.055], air: 0.3, heavy: 2.5, mech: 0.07, drive: 1.9 },
  stinger: { near: 'Bersa/F_47P.wav', mid: 'Bersa/F_41P.wav', rate: 1.06, len: 0.6, thump: [235, 110, 0.022], bark: [1100, 0.02], air: 0.1, heavy: -1.5, mech: 0.035, drive: 2.0 },
  wasp: { near: 'Carl Gustav M45/G_31P.wav', mid: 'Carl Gustav M45/G_20P.wav', len: 0.65, thump: [200, 92, 0.028], bark: [900, 0.026], air: 0.12, heavy: -1, mech: 0.04, drive: 2.1 },
  hornet: { near: 'PPSh/P_30P.wav', mid: 'PPSh/P_16P.wav', rate: 1.08, len: 0.65, thump: [225, 105, 0.024], bark: [1200, 0.022], air: 0.11, heavy: -1.5, mech: 0.036, drive: 2.0 },
  hammerhead: { near: 'AK-47/C_28P.wav', mid: 'AK-47/C_31P.wav', len: 1.0, thump: [155, 62, 0.05], bark: [620, 0.046], air: 0.26, heavy: 1.5, mech: 0.055, drive: 1.8 },
  mako: { near: 'SKS/U_14P.wav', mid: 'SKS/U_19P.wav', rate: 1.05, len: 0.9, thump: [170, 72, 0.042], bark: [780, 0.042], air: 0.22, heavy: 0.5, mech: 0.05, drive: 1.9 },
  lumen: { near: 'AR-15/D_32P.wav', mid: 'AR-15/D_24P.wav', len: 0.9, thump: [180, 78, 0.038], bark: [920, 0.036], air: 0.22, heavy: -0.5, mech: 0.045, drive: 2.0 },
  osprey: { near: 'Marlin 336/I_22P.wav', mid: 'Marlin 336/I_17P.wav', rate: 0.96, len: 0.9, thump: [160, 66, 0.046], bark: [660, 0.042], air: 0.23, heavy: 1, mech: 0.055, drive: 2.0 },
  breaker: { near: 'Nova/O_21P.wav', mid: 'Nova/O_17P.wav', len: 1.3, thump: [130, 52, 0.07], bark: [500, 0.07], air: 0.36, heavy: 3, drive: 2.0 },
  thresher: { near: 'Model 12/K_22P.wav', mid: 'Model 12/K_17P.wav', rate: 0.92, len: 1.4, thump: [120, 46, 0.08], bark: [450, 0.08], air: 0.42, heavy: 3.5, drive: 2.1 },
  longsight: { near: 'Tikka/W_29P.wav', mid: 'Tikka/W_24P.wav', rate: 0.9, len: 1.7, thump: [125, 44, 0.09], bark: [540, 0.066], air: 0.55, heavy: 3, drive: 2.0 },
  colossus: { near: 'Mosin Nagant/M_21P.wav', mid: 'Mosin Nagant/M_26P.wav', rate: 0.8, len: 1.9, thump: [110, 38, 0.11], bark: [440, 0.09], air: 0.68, heavy: 4, mech: 0.09, drive: 2.2 },
};
const SHOT_TAKES = 3;
const energy = (x) => { let e = 0; for (let i = 0; i < x.length; i++) e += x[i] * x[i]; return e; };
/** Scale in place so the layer carries `share` of the shot's energy (decibels below the whole). */
function share(x, db) {
  const e = energy(x);
  const g = e > 0 ? Math.sqrt(Math.pow(10, db / 10) / e) : 0;
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

function designShot(id, p, k) {
  const rnd = lcg(id.length * 97 + id.charCodeAt(0) * 13 + k * 7919 + 5);
  const n = Math.floor(SR * p.len);
  const out = new Float32Array(n);
  const near = takesOf(p.near, 0.7), mid = takesOf(p.mid, p.len + 0.3);
  if (near.length === 0) return null;
  const rate = (p.rate ?? 1) * (1 + (rnd() - 0.5) * 0.03);
  const a = repitch(near[k % near.length], rate);
  const heavy = p.heavy ?? 0;
  // The layers are balanced by the energy each carries, so every gun has the same build
  // (crack, body, weight) in its own proportions, however its recording happened to be made.
  // The recording: its crack kept whole, and its low half as it is.
  mix(out, share(shape(filt(a, 'hp', 1200), 0.0002, 0.1), -6.5 - heavy * 0.4), 1);
  mix(out, share(filt(filt(a, 'lp', 1200), 'hp', 130), -8.5), 1);
  // The muzzle blast.
  const [bf, bs] = p.bark;
  mix(out, share(shape(filt(filt(noise(Math.floor(SR * Math.min(p.len, bs * 9)), rnd), 'bp', bf, 0.75), 'lp', bf * 3.2), 0.001, bs), -6.5), 1, 0.0015);
  // The weight of the shot, a little dirtied so it is heard on small speakers too.
  const [f0, f1, sec] = p.thump;
  mix(out, share(filt(drive(thump(Math.floor(SR * Math.min(p.len, sec * 8)), f0 * (1 + (rnd() - 0.5) * 0.05), f1, 0.02, sec), 1.6), 'lp', 1100), -4.5 + heavy), 1, 0.0015);
  // The range answering: the far microphone, darkened, and the air dying away behind it.
  if (mid.length > 0) mix(out, share(filt(filt(repitch(mid[k % mid.length], rate), 'lp', 3600), 'hp', 160), -15), 1, 0.014);
  mix(out, share(wash(n, rnd, p.air), -17), 1);
  // The action.
  if (p.mech) mix(out, share(clack(rnd, 2800 + rnd() * 900), -24), 1, p.mech);
  let y = filt(out, 'hp', 40);
  y = filt(y, 'peak', 3200, 0.9, 2);
  normalise(y, 0);
  drive(y, p.drive);
  y = filt(y, 'hp', 32);
  return normalise(fadeOut(y, 0.3));
}

/** A suppressed shot: no blast, a hiss and a cough, and the action heard over both. */
const QUIET = {
  osprey: { near: 'Savage 10 .300 Blackout/T_27P.wav', hiss: 1900, pop: [150, 70, 0.04], rate: 0.95 },
  lumen: { near: 'Savage 10 .300 Blackout/T_27P.wav', hiss: 2400, pop: [175, 82, 0.034], rate: 1.05 },
  hornet: { near: 'Savage 10 .300 Blackout/T_27P.wav', hiss: 2900, pop: [200, 95, 0.028], rate: 1.18 },
};
function designQuiet(id, p, k) {
  const rnd = lcg(id.length * 71 + k * 5113 + 9);
  const n = Math.floor(SR * 0.55);
  const out = new Float32Array(n);
  const near = takesOf(p.near, 0.5);
  if (near.length > 0) mix(out, filt(filt(repitch(near[k % near.length], p.rate), 'lp', 2600), 'hp', 200), 0.4);
  mix(out, shape(filt(noise(Math.floor(SR * 0.3), rnd), 'bp', p.hiss, 0.7), 0.0012, 0.03), 2.0, 0.001);
  const [f0, f1, sec] = p.pop;
  mix(out, drive(thump(Math.floor(SR * 0.3), f0, f1, 0.02, sec), 1.5), 0.55, 0.001);
  mix(out, clack(rnd, 2600 + rnd() * 600, 0.008), 1.6, 0.034);
  mix(out, clack(rnd, 3600 + rnd() * 600, 0.005), 0.9, 0.062);
  mix(out, wash(n, rnd, 0.11, 2400, 500), 0.25);
  let y = filt(out, 'hp', 60);
  normalise(y, 0);
  drive(y, 1.8);
  return normalise(fadeOut(y, 0.35));
}

const manifest = {};
const report = (name, y) => { manifest[name] = +loud100(y, SR).toFixed(1); };
for (const [id, p] of Object.entries(SHOTS)) {
  for (let k = 0; k < SHOT_TAKES; k++) {
    const y = designShot(id, p, k);
    if (!y) continue;
    writeWav(`shot_${id}_${k + 1}`, y, SR);
    report(`shot_${id}_${k + 1}`, y);
  }
}
for (const [id, p] of Object.entries(QUIET)) {
  for (let k = 0; k < 2; k++) {
    const y = designQuiet(id, p, k);
    writeWav(`shot_${id}_q_${k + 1}`, y, SR);
    report(`shot_${id}_q_${k + 1}`, y);
  }
}

// ---- Kenney packs (Ogg -> WAV) -----------------------------------------------------------

const decoder = new OggVorbisDecoder();
await decoder.ready;
async function ogg(pack, file, out, peakDb = -1) {
  const p = path.join(SRC, pack, 'Audio', `${file}.ogg`);
  if (!fs.existsSync(p)) { console.warn(`missing ${p}`); return; }
  const { channelData, sampleRate } = await decoder.decodeFile(new Uint8Array(fs.readFileSync(p)));
  await decoder.reset();
  const n = channelData[0].length, x = new Float32Array(n);
  for (const c of channelData) for (let i = 0; i < n; i++) x[i] += c[i] / channelData.length;
  normalise(x, peakDb);
  writeWav(out, x, sampleRate);
  manifest[out] = +loud100(x, sampleRate).toFixed(1);
}
const seq = (n) => Array.from({ length: n }, (_, i) => String(i).padStart(3, '0'));
for (const [i, k] of seq(3).entries()) await ogg('kenney-impact', `impactSoft_heavy_${k}`, `land_${i + 1}`);
for (const [i, k] of seq(3).entries()) await ogg('kenney-impact', `impactPunch_medium_${k}`, `hit_body_${i + 1}`);
for (const [i, k] of seq(2).entries()) await ogg('kenney-impact', `impactPunch_heavy_${k}`, `hurt_${i + 1}`);
for (const [i, k] of seq(2).entries()) await ogg('kenney-impact', `impactPlate_medium_${k}`, `hit_head_${i + 1}`);
for (const [i, k] of seq(3).entries()) await ogg('kenney-impact', `impactMetal_light_${k}`, `click_metal_${i + 1}`);
for (const [i, k] of seq(2).entries()) await ogg('kenney-impact', `impactPlate_light_${k}`, `click_plate_${i + 1}`);
for (const f of ['click_002', 'confirmation_001', 'confirmation_002', 'error_004', 'switch_002', 'tick_001', 'bong_001', 'drop_002', 'maximize_006', 'minimize_006']) {
  await ogg('kenney-interface', f, `ui_${f}`);
}
for (const [i, k] of seq(3).entries()) await ogg('kenney-scifi', `explosionCrunch_${k}`, `explosion_${i + 1}`);
await ogg('kenney-scifi', 'lowFrequency_explosion_000', 'explosion_low');
// ---- handling sounds: built from Kenney's impact recordings ----------------------------------
//
// Each moment of a reload (a magazine leaving, one seating, a bolt drawn and let go, a shell
// pushed home) is its own short sound, played when the animation reaches it, instead of one
// recording of somebody else's reload stretched to fit. Each is a few real impacts of metal,
// pitched and laid over one another, with a scrape of noise where metal slides on metal.

/** One of Kenney's recordings, at SR, peaking at 1. */
async function kenney(pack, file) {
  const p = path.join(SRC, pack, 'Audio', `${file}.ogg`);
  if (!fs.existsSync(p)) { console.warn(`missing ${p}`); return new Float32Array(1); }
  const { channelData, sampleRate } = await decoder.decodeFile(new Uint8Array(fs.readFileSync(p)));
  await decoder.reset();
  const n = channelData[0].length, x = new Float32Array(n);
  for (const c of channelData) for (let i = 0; i < n; i++) x[i] += c[i] / channelData.length;
  return normalise(repitch(x, 1, sampleRate), 0);
}
const K = {};
for (const name of ['impactMetal_light', 'impactMetal_medium', 'impactMetal_heavy', 'impactPlate_light', 'impactPlate_medium', 'impactPlate_heavy', 'impactTin_medium', 'impactGeneric_light', 'impactSoft_medium', 'footstep_concrete']) {
  K[name] = [];
  for (const k of seq(5)) K[name].push(await kenney('kenney-impact', `${name}_${k}`));
}
/** Metal sliding on metal: a band of noise swelling and dying over `sec`. */
function scrape(rnd, sec, f) {
  const y = filt(filt(noise(Math.floor(SR * sec), rnd), 'bp', f, 1.1), 'hp', 500);
  for (let i = 0; i < y.length; i++) y[i] *= Math.sin((Math.PI * i) / y.length) ** 1.5;
  return y;
}
/** [recording or made sound, speed, level, at seconds] laid over one another. */
function foley(name, sec, layers, peakDb = -3) {
  const out = new Float32Array(Math.floor(SR * sec));
  for (const [x, speed, level, at] of layers) mix(out, speed === 1 ? x : repitch(x, speed), level, at);
  const y = normalise(fadeOut(filt(out, 'hp', 90), 0.25), peakDb);
  writeWav(name, y, SR);
  report(name, y);
}
for (let v = 0; v < 2; v++) {
  const rnd = lcg(4000 + v * 31);
  const j = () => 1 + (rnd() - 0.5) * 0.08; // a little off pitch each time
  const n = `_${v + 1}`;
  foley(`fol_magout_pistol${n}`, 0.22, [[K.impactMetal_light[v], 1.3 * j(), 0.7, 0], [scrape(rnd, 0.05, 3000), 1, 0.25, 0.008]]);
  foley(`fol_magin_pistol${n}`, 0.26, [[scrape(rnd, 0.045, 2600), 1, 0.22, 0], [K.impactPlate_light[v + 1], 1.2 * j(), 0.8, 0.045], [K.impactMetal_light[v + 2], 0.9 * j(), 0.5, 0.05]]);
  foley(`fol_magout_rifle${n}`, 0.3, [[K.impactMetal_medium[v], 1.05 * j(), 0.7, 0], [scrape(rnd, 0.075, 2200), 1, 0.28, 0.012], [K.impactPlate_light[v], 0.8 * j(), 0.3, 0.065]]);
  foley(`fol_magin_rifle${n}`, 0.34, [[scrape(rnd, 0.06, 2000), 1, 0.24, 0], [K.impactPlate_medium[v + 1], 1.0 * j(), 0.9, 0.06], [K.impactMetal_medium[v + 2], 0.8 * j(), 0.6, 0.066], [K.impactGeneric_light[v], 0.9, 0.4, 0.06]]);
  foley(`fol_boltback${n}`, 0.3, [[K.impactMetal_light[v + 3], 0.9 * j(), 0.6, 0], [scrape(rnd, 0.09, 1800), 1, 0.32, 0.006], [K.impactMetal_medium[v + 3], 0.85 * j(), 0.7, 0.092]]);
  foley(`fol_boltfwd${n}`, 0.28, [[scrape(rnd, 0.03, 2400), 1, 0.2, 0], [K.impactMetal_heavy[v], 1.15 * j(), 0.9, 0.03], [K.impactPlate_light[v + 2], 1.0 * j(), 0.4, 0.033]]);
  foley(`fol_tap${n}`, 0.2, [[K.impactSoft_medium[v], 1.1, 0.55, 0], [K.impactMetal_light[v + 1], 1.1 * j(), 0.5, 0.006]]);
  foley(`fol_shell${n}`, 0.3, [[K.impactTin_medium[v], 1.3 * j(), 0.32, 0], [scrape(rnd, 0.065, 1500), 1, 0.3, 0.012], [K.impactMetal_light[v + 2], 0.8 * j(), 0.6, 0.075]]);
  foley(`fol_open${n}`, 0.3, [[K.impactMetal_medium[v + 1], 0.9 * j(), 0.8, 0], [K.impactPlate_medium[v], 0.8 * j(), 0.5, 0.02]]);
  foley(`fol_close${n}`, 0.32, [[K.impactMetal_heavy[v + 2], 1.0 * j(), 1, 0], [K.impactPlate_heavy[v], 1.1 * j(), 0.5, 0.005], [K.impactGeneric_light[v + 1], 0.8, 0.5, 0]]);
  foley(`fol_pump${n}`, 0.3, [[scrape(rnd, 0.085, 1200), 1, 0.42, 0], [K.impactMetal_medium[v + 2], 0.8 * j(), 0.8, 0.082], [K.impactPlate_light[v + 3], 0.9, 0.3, 0.086]]);
  foley(`fol_catch${n}`, 0.2, [[K.impactSoft_medium[v + 2], 1.25, 0.6, 0], [K.impactGeneric_light[v + 2], 1.1, 0.25, 0.004]]);
}

// Footsteps: the recording is a soft thud with nothing above 800 Hz, which is lost under
// gunfire and cannot be placed by ear. A heel click and a little grit give it an edge.
for (let i = 0; i < 5; i++) {
  const rnd = lcg(7000 + i * 17);
  const out = new Float32Array(Math.floor(SR * 0.2));
  mix(out, K.footstep_concrete[i], 1);
  mix(out, filt(K.impactGeneric_light[i], 'hp', 700), 0.32, 0.002);
  mix(out, shape(filt(filt(noise(Math.floor(SR * 0.12), rnd), 'hp', 1800), 'lp', 7000), 0.002, 0.028), 0.2, 0.004);
  const y = normalise(fadeOut(out, 0.3));
  writeWav(`step_${i + 1}`, y, SR);
  report(`step_${i + 1}`, y);
}
// A round striking the level: the thud of it, the crack of the surface, and bits falling.
for (let i = 0; i < 5; i++) {
  const rnd = lcg(9000 + i * 29);
  const out = new Float32Array(Math.floor(SR * 0.32));
  mix(out, K.impactGeneric_light[i], 0.75);
  mix(out, shape(filt(noise(Math.floor(SR * 0.1), rnd), 'hp', 2400), 0.0004, 0.016), 0.6);
  for (let d = 0; d < 7; d++) mix(out, clack(rnd, 2500 + rnd() * 4000, 0.002 + rnd() * 0.003), 0.06 + rnd() * 0.16, 0.03 + rnd() * 0.2);
  const y = normalise(fadeOut(out, 0.3));
  writeWav(`impact_${i + 1}`, y, SR);
  report(`impact_${i + 1}`, y);
}

decoder.free();

// ---- recordings used as they are (MP3) ----------------------------------------------------

const WS = '_reference/webstrafe/public/audio';
const copies = {
  'knife/slash-1.mp3': 'knife_slash_1.mp3', 'knife/slash-2.mp3': 'knife_slash_2.mp3', 'knife/slash-3.mp3': 'knife_slash_3.mp3',
  'knife/stab-1.mp3': 'knife_stab_1.mp3', 'knife/flesh-1.mp3': 'knife_flesh_1.mp3', 'knife/flesh-2.mp3': 'knife_flesh_2.mp3',
  'knife/draw-fixed-1.mp3': 'knife_draw.mp3', 'knife/cloth-1.mp3': 'cloth_1.mp3', 'knife/cloth-2.mp3': 'cloth_2.mp3',
};
for (const [from, to] of Object.entries(copies)) {
  const p = path.join(WS, from);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(OUT, to));
  else console.warn(`missing ${p}`);
}

console.log('\nloudest 100 ms (dBFS):');
for (const [k, v] of Object.entries(manifest)) console.log(`  ${k.padEnd(24)} ${v}`);
const files = fs.readdirSync(OUT);
console.log(`\n${files.length} files, ${(files.reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0) / 1048576).toFixed(1)} MB in ${OUT}`);
