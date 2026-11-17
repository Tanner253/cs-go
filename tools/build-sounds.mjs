// Builds public/assets/audio from the raw CC0 sound packs in _reference/sounds-src
// (git-ignored; see CREDITS.md for where each pack is downloaded from).
//
//   node tools/build-sounds.mjs
//
// Gunshots and gun handling are recordings of real guns (Snake's Authentic Gun Sounds),
// used as recorded; footsteps and impacts are built from Kenney's impact pack.
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

// ---- tools --------------------------------------------------------------------------------

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
/** A click of metal on metal made of nothing but a ringing band of noise (for where no recording is layered). */
function clack(rnd, f = 3200, tau = 0.006) {
  return shape(filt(noise(Math.floor(SR * 0.05), rnd), 'bp', f, 3.5), 0.0003, tau);
}

// ---- gunshots and gun handling: Snake's Authentic Gun Sounds, as recorded -------------------
//
// Every shot, reload, rack and bolt in the game is a recording of a real gun from the two
// "Snake's Authentic Gun Sounds" packs (f8studios.itch.io): nothing here is synthesised or
// layered. A recording is cut at the shot, played a little faster or slower where one calibre
// stands in for a neighbour, faded at its end and levelled; that is all.

const SNAKE1 = path.join(SRC, 'snake1', 'files', "Snake's Authentic Gun Sounds");
const SNAKE2 = path.join(SRC, 'snake2', 'files', "Snake's SECOND Authentic Gun Sounds");
/** Where each calibre's recordings are: [pack, folder, file prefix]. */
const CALIBRES = {
  '9mm': [2, '9mm', '9mm'],
  '308': [2, '.308 (7.62x51)', '308'],
  '20ga': [2, '20 Gauge', '20 Gauge'],
  '22': [1, '.22LR', '22LR'],
  '556': [1, '5.56', '556'],
  '762x39': [1, '7.62x39', '762x39'],
  '762x54': [1, '7.62x54R', '762x54r'],
};
/** @param dry the recording without the range's own echo; @param take 'Single' | 'Double Tap' | 'Burst' */
function calibreFile(cal, dry, take) {
  const [pack, folder, prefix] = CALIBRES[cal];
  return pack === 1
    ? path.join(SNAKE1, dry ? 'Isolated' : 'Full Sound', folder, 'WAV', `${prefix} ${take}${dry ? ' Isolated' : ''} WAV.wav`)
    : path.join(SNAKE2, dry ? 'Isolated' : 'Full Sounds', folder, 'WAV', `${prefix} ${take}${dry ? ' Isolated' : ''}.wav`);
}
const recordings = new Map();
/** A recording at SR, mono. */
function recording(file) {
  if (!recordings.has(file)) {
    if (!fs.existsSync(file)) { console.warn(`missing ${file}`); recordings.set(file, new Float32Array(SR)); }
    else { const { rate, x } = readWav(file); recordings.set(file, rate === SR ? x : repitch(x, 1, rate)); }
  }
  return recordings.get(file);
}
/** Where each shot in a recording begins (samples), shots as close together as a burst's. */
function shotStarts(x) {
  const block = Math.floor(SR * 0.002);
  const env = [];
  for (let i = 0; i + block <= x.length; i += block) { let m = 0; for (let j = i; j < i + block; j++) m = Math.max(m, Math.abs(x[j])); env.push(m); }
  const peak = Math.max(...env), thr = peak * 0.35;
  const out = [];
  let last = -1e9, dipped = true;
  for (let i = 0; i < env.length; i++) {
    if (env[i] < thr * 0.5) dipped = true;
    if (env[i] > thr && dipped && (i - last) * 0.002 > 0.06) {
      let s = i;
      while (s > 0 && i - s < 8 && env[s - 1] > thr * 0.1) s--;
      out.push(s * block);
      last = i;
      dipped = false;
    }
  }
  return out;
}
/** One shot out of a recording: from its start (the last shot in the file, so its tail is whole), `sec` long at most. */
function shotFrom(file, speed, sec, which = -1) {
  const x = recording(file);
  const starts = shotStarts(x);
  const at = Math.max(0, (starts.at(which) ?? 0) - Math.floor(SR * 0.003));
  let y = x.slice(at, Math.min(x.length, at + Math.floor(SR * sec * speed)));
  if (speed !== 1) y = repitch(y, speed);
  const fin = Math.floor(SR * 0.001);
  for (let i = 0; i < fin && i < y.length; i++) y[i] *= i / fin;
  return normalise(fadeOut(y, 0.25));
}

/**
 * Each weapon's shot: the calibre it is recorded from (the gun's own, or its nearest
 * neighbour in the packs), whether with the range's echo or without, the speed it is played
 * at, and how long it rings. Three takes each: the single shot, and the last of a double tap
 * and of a burst.
 */
const SHOTS = {
  kite: ['9mm', false, 1, 1.3],
  tern: ['9mm', false, 0.88, 1.4],
  maul: ['308', true, 1.12, 1.2],
  stinger: ['9mm', true, 1.14, 0.9],
  wasp: ['9mm', false, 1.05, 1.1],
  hornet: ['556', true, 1.12, 0.9],
  hammerhead: ['762x39', false, 1, 1.6],
  mako: ['762x39', true, 1.07, 1.0],
  lumen: ['556', false, 1, 1.6],
  osprey: ['762x39', false, 0.9, 1.6],
  breaker: ['20ga', false, 0.92, 1.8],
  thresher: ['20ga', false, 0.82, 2.0],
  longsight: ['308', false, 0.92, 2.2],
  colossus: ['762x54', false, 0.8, 2.4],
};
const manifest = {};
const report = (name, y) => { manifest[name] = +loud100(y, SR).toFixed(1); };
for (const [id, [cal, dry, speed, sec]] of Object.entries(SHOTS)) {
  ['Single', 'Double Tap', 'Burst'].forEach((take, k) => {
    const y = shotFrom(calibreFile(cal, dry, take), speed, sec);
    writeWav(`shot_${id}_${k + 1}`, y, SR);
    report(`shot_${id}_${k + 1}`, y);
  });
}
// With a suppressor: the same gun's dry recording with the muzzle blast taken off the top (what
// a suppressor does), since neither pack has a suppressed gun. The one thing here that is not
// simply a recording.
const QUIET = { osprey: ['762x39', 0.9], lumen: ['556', 1], hornet: ['556', 1.12], breaker: ['20ga', 0.92] };
for (const [id, [cal, speed]] of Object.entries(QUIET)) {
  ['Single', 'Double Tap'].forEach((take, k) => {
    let y = shotFrom(calibreFile(cal, true, take), speed, 0.7);
    y = filt(filt(filt(y, 'lp', 2400), 'lp', 2400), 'hp', 160);
    normalise(fadeOut(y, 0.3));
    writeWav(`shot_${id}_q_${k + 1}`, y, SR);
    report(`shot_${id}_q_${k + 1}`, y);
  });
}

// Handling: the packs' own recordings of each movement.
const MECH1 = path.join(SNAKE1, 'Reloads, Cycling & More', 'WAV');
const MECH2 = path.join(SNAKE2, '& More');
/** A handling sound: its silence trimmed off the front, levelled. */
function handling(name, file, peakDb = -3) {
  const x = recording(file);
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  let a = 0;
  while (a < x.length && Math.abs(x[a]) < peak * 0.02) a++;
  const y = x.slice(Math.max(0, a - Math.floor(SR * 0.004)));
  normalise(fadeOut(y, 0.2), peakDb);
  writeWav(name, y, SR);
  report(name, y);
}
for (const [name, file] of [
  ['fol_ak_magout', path.join(MECH1, 'AK Reload Part 1 WAV.wav')],
  ['fol_ak_magin', path.join(MECH1, 'AK Reload Part 2 WAV.wav')],
  ['fol_ak_rack', path.join(MECH1, 'AK Rack WAV.wav')],
  ['fol_ar_magout', path.join(MECH1, 'AR Reload Part 1 WAV.wav')],
  ['fol_ar_magin', path.join(MECH1, 'AR Reload Part 2 WAV.wav')],
  ['fol_ar_release', path.join(MECH1, 'AR Bolt Release WAV.wav')],
  ['fol_ar_charge', path.join(MECH1, 'AR Charging Handle WAV.wav')],
  ['fol_bolt_magout', path.join(MECH1, '308 Magazine Part 1 WAV.wav')],
  ['fol_bolt_magin', path.join(MECH1, '308 Magazine Part 2 WAV.wav')],
  ['fol_bolt_cycle_1', path.join(MECH1, '308 Bolt Cycle WAV.wav')],
  ['fol_bolt_cycle_2', path.join(MECH1, 'Mosin Bolt Cycle WAV.wav')],
  ['fol_pump_back', path.join(MECH1, 'Pump Reload Part 1 WAV.wav')],
  ['fol_pump_fwd', path.join(MECH1, 'Pump Reload Part 2 WAV.wav')],
  ['fol_pump_shell', path.join(MECH1, 'Pump Shell Load WAV.wav')],
  ['fol_break_open', path.join(MECH1, 'Single Shot Reload Part 1 WAV.wav')],
  ['fol_break_close', path.join(MECH1, 'Single Shot Reload Part 2 WAV.wav')],
  ['fol_break_shell', path.join(MECH2, 'Mag Pack', 'WAV', 'Single Shotgun Load.wav')],
  ['fol_pistol_magout', path.join(MECH2, 'Pistol', 'WAV', '9mm Pistol Reload 1.wav')],
  ['fol_pistol_magin', path.join(MECH2, 'Pistol', 'WAV', '9mm Pistol Reload 2.wav')],
  ['fol_pistol_rack', path.join(MECH2, 'Pistol', 'WAV', '9mm Pistol Rack Full.wav')],
  ['fol_pistol_release', path.join(MECH2, 'Pistol', 'WAV', '9mm Pistol Slide Release.wav')],
  ['fol_pistol_dry', path.join(MECH2, 'Pistol', 'WAV', '9mm Pistol Dry Fire.wav')],
]) handling(name, file);

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
// ---- from Kenney's impact recordings: footsteps, impacts, a hand catching a gun ---------------

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
/** [recording or made sound, speed, level, at seconds] laid over one another. */
function foley(name, sec, layers, peakDb = -3) {
  const out = new Float32Array(Math.floor(SR * sec));
  for (const [x, speed, level, at] of layers) mix(out, speed === 1 ? x : repitch(x, speed), level, at);
  const y = normalise(fadeOut(filt(out, 'hp', 90), 0.25), peakDb);
  writeWav(name, y, SR);
  report(name, y);
}
for (let v = 0; v < 2; v++) {
  foley(`fol_catch_${v + 1}`, 0.2, [[K.impactSoft_medium[v + 2], 1.25, 0.6, 0], [K.impactGeneric_light[v + 2], 1.1, 0.25, 0.004]]);
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
