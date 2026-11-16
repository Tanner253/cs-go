// Builds public/assets/audio from the raw CC0 sound packs in _reference/sounds-src
// (git-ignored; see CREDITS.md for where each pack is downloaded from).
//
//   node tools/build-sounds.mjs
//
// Gunshots are cut straight from The Free Firearm Sound Library: one clean shot per take,
// no layering or effects, only a fade-out, a resample to 48 kHz mono and peak normalising.
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

// ---- gunshots: The Free Firearm Sound Library -----------------------------------------

const LIB = path.join(SRC, 'firearm-library', 'Prepared SFX Library');
/** [output name, recording, takes wanted, seconds kept per shot] */
const GUNS = [
  ['shot_pistol9', 'Walther PPQ/X_31P.wav', 2, 1.0],
  ['shot_pistol45', '1911/A_42P.wav', 2, 1.1],
  ['shot_heavy', '1911/A_34P.wav', 3, 1.2],
  ['shot_smg_a', 'Carl Gustav M45/G_31P.wav', 3, 0.9],
  ['shot_smg_b', 'PPSh/P_30P.wav', 3, 0.9],
  ['shot_ak', 'AK-47/C_28P.wav', 3, 1.2],
  ['shot_ar', 'AR-15/D_32P.wav', 2, 1.2],
  ['shot_shotgun', 'Nova/O_21P.wav', 2, 1.5],
  ['shot_bolt', 'Tikka/W_24P.wav', 3, 1.7],
];
const manifest = {};
for (const [name, rel, takes, len] of GUNS) {
  const file = path.join(LIB, rel);
  if (!fs.existsSync(file)) { console.warn(`missing ${file}`); continue; }
  const { rate, x } = readWav(file);
  const starts = onsets(x, rate);
  const factor = rate % 48000 === 0 ? rate / 48000 : 1;
  const used = starts.slice(0, takes);
  used.forEach((s, i) => {
    const y = normalise(decimate(cut(x, rate, s, len), factor));
    const out = `${name}${i ? `_${i + 1}` : ''}`;
    writeWav(out, y, rate / factor);
    manifest[out] = +loud100(y, rate / factor).toFixed(1);
  });
  console.log(`${name.padEnd(14)} ${rel.padEnd(26)} ${rate} Hz, ${starts.length} shots found at ${starts.map((s) => s.toFixed(2)).join(', ')} -> kept ${used.length}`);
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
for (const [i, k] of seq(5).entries()) await ogg('kenney-impact', `footstep_concrete_${k}`, `step_${i + 1}`);
for (const [i, k] of seq(3).entries()) await ogg('kenney-impact', `impactSoft_heavy_${k}`, `land_${i + 1}`);
for (const [i, k] of seq(3).entries()) await ogg('kenney-impact', `impactPunch_medium_${k}`, `hit_body_${i + 1}`);
for (const [i, k] of seq(2).entries()) await ogg('kenney-impact', `impactPunch_heavy_${k}`, `hurt_${i + 1}`);
for (const [i, k] of seq(2).entries()) await ogg('kenney-impact', `impactPlate_medium_${k}`, `hit_head_${i + 1}`);
for (const [i, k] of seq(4).entries()) await ogg('kenney-impact', `impactGeneric_light_${k}`, `impact_${i + 1}`);
for (const [i, k] of seq(3).entries()) await ogg('kenney-impact', `impactMetal_light_${k}`, `click_metal_${i + 1}`);
for (const [i, k] of seq(2).entries()) await ogg('kenney-impact', `impactPlate_light_${k}`, `click_plate_${i + 1}`);
for (const f of ['click_002', 'confirmation_001', 'confirmation_002', 'error_004', 'switch_002', 'tick_001', 'bong_001', 'drop_002', 'maximize_006', 'minimize_006']) {
  await ogg('kenney-interface', f, `ui_${f}`);
}
for (const [i, k] of seq(3).entries()) await ogg('kenney-scifi', `explosionCrunch_${k}`, `explosion_${i + 1}`);
await ogg('kenney-scifi', 'lowFrequency_explosion_000', 'explosion_low');
decoder.free();

// ---- recordings used as they are (MP3) ----------------------------------------------------

const WS = '_reference/webstrafe/public/audio';
const copies = {
  'deagle_reload.mp3': 'reload_pistol.mp3', 'awp_reload.mp3': 'reload_rifle.mp3',
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
