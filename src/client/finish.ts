// One look for every weapon and every pair of arms, and a painted skin for each gun.
//
// The models come from different authors: wood and bare steel on one, olive polymer on
// another, tan gloves here and black ones there. Rather than repaint each texture, the
// material is re-graded in the shader: the texture is desaturated (its wear, panel lines
// and markings survive as light and dark), brought to a common brightness measured from
// the texture itself, and tinted.
//
// A gun can also wear a skin (skins.ts): a two-colour pattern painted in the gun's own
// space, so it stays put across the separately moving slide, bolt and magazine, with
// light-emitting lines that pulse along the barrel, flare as the gun heats up from firing,
// and a magazine that lights up as a gauge of the rounds left in it.

import * as THREE from 'three';

export interface Finish {
  /** How much of the texture's own colour survives (0 = none). */
  sat: number;
  tint: [number, number, number];
  /** Average brightness to bring the texture to (linear, 0..1). */
  level: number;
  /** How much of the texture's light-to-dark range survives (1 = all, 0 = flat). */
  contrast: number;
  /** Edge-light colour and strength. */
  rim: number;
  rimStrength: number;
  metal: number;
  /** The roughness scale is kept between these (it multiplies the model's own roughness map). */
  roughMin: number;
  roughMax: number;
  env: number;
}

export type Pattern = 'hex' | 'digital' | 'tiger' | 'circuit' | 'carbon' | 'chevron';
const PATTERN_ID: Record<Pattern, number> = { hex: 1, digital: 2, tiger: 3, circuit: 4, carbon: 5, chevron: 6 };

/** A painted design for one gun. Colours are sRGB hex. */
export interface Skin {
  name: string;
  pattern: Pattern;
  /** Pattern cells per metre. */
  scale: number;
  /** The two paints of the pattern. */
  a: number;
  b: number;
  /** The slide or bolt. */
  accent: number;
  /** Light-emitting lines; `glow2` (optional) is what the colour runs to at the muzzle end. */
  glow: number;
  glow2?: number;
  glowStrength: number;
  metal?: number;
  rough?: number;
}

/** Which part of the gun a mesh is: it decides how the skin treats it. */
export type Role = 'body' | 'moving' | 'cell';

/** A skin as worn by one gun: the design plus that gun's own measurements and live state. */
export interface SkinWear {
  skin: Skin;
  role: Role;
  /** x of the breech end and of the muzzle, gun space (metres). */
  length: THREE.Vector2;
  /** y of the bottom and top of the magazine, gun space. */
  cell: THREE.Vector2;
  /** Live: heat from firing (0..1) and the fraction of the magazine left (0..1). */
  heat: { value: number };
  ammo: { value: number };
  /** The light the lines give off, if it can change while worn (in place of the skin's own). */
  glow?: THREE.Color;
}

/** Seconds, advanced once a frame by whoever draws: drives every skin's pulse. */
export const FINISH_TIME = { value: 0 };

const SHEEN = 0x9fc4ff;
/** Attackers carry warm, burnt graphite; defenders cold blue steel. Shared weapons sit between. */
const TEAM_TINT: [number, number, number][] = [[1.0, 0.93, 0.85], [0.82, 0.9, 1.0]];
const NEUTRAL_TINT: [number, number, number] = [0.91, 0.94, 1.0];

/**
 * The gun finish. (The edge light is kept faint: seen from behind, the whole top of a gun
 * is at a grazing angle, so a strong one floods it with colour.)
 */
export function gunFinish(team: number): Finish {
  return {
    sat: 0.14, tint: team === 0 || team === 1 ? TEAM_TINT[team]! : NEUTRAL_TINT, level: 0.06, contrast: 0.7,
    rim: SHEEN, rimStrength: 0.03,
    metal: 0.85, roughMin: 0.38, roughMax: 0.6, env: 1.4,
  };
}
/**
 * Sleeves and gloves, identical whichever weapon is held. (No contrast: the arm models'
 * own textures differ, so none of their light and dark is kept; the suit's weave is painted
 * on as a skin and the folds come from the models' relief.)
 */
export const ARMS_FINISH: Finish = {
  sat: 0, tint: [0.74, 0.8, 0.92], level: 0.018, contrast: 0, rim: SHEEN, rimStrength: 0.03, metal: 0, roughMin: 0.7, roughMax: 1, env: 0.5,
};
/** Bright worn steel for the blade. */
export const BLADE_FINISH: Finish = {
  sat: 0.1, tint: [0.9, 0.95, 1.0], level: 0.16, contrast: 0.8, rim: SHEEN, rimStrength: 0.05, metal: 0.55, roughMin: 0.3, roughMax: 0.5, env: 1.4,
};
/** Guns seen in other players' hands: the same graphite, no edge light. */
export const WORLD_GUN_FINISH: Finish = { ...gunFinish(-1), rimStrength: 0, level: 0.07 };

// ---- measuring a texture -----------------------------------------------------------------

const PROBE = 64;
const pixelCache = new Map<string, Float32Array | null>();

// The texture is read back through the GPU, sampled exactly as a mesh would sample it. (A
// 2D canvas cannot be used: several of these textures keep other data in their alpha
// channel, and a canvas throws away the colour of transparent pixels.)
let gl: THREE.WebGLRenderer | null = null;
let probe: { target: THREE.WebGLRenderTarget; scene: THREE.Scene; cam: THREE.Camera; mat: THREE.ShaderMaterial } | null = null;

/** Give the finish a renderer to measure textures with. Call once, before any model is finished. */
export function setFinishRenderer(renderer: THREE.WebGLRenderer): void {
  gl = renderer;
}

/** The texture's brightness (linear) on a small grid indexed [v][u], or null if it cannot be read. */
function luminanceGrid(tex: THREE.Texture): Float32Array | null {
  const hit = pixelCache.get(tex.uuid);
  if (hit !== undefined) return hit;
  let grid: Float32Array | null = null;
  if (gl) {
    try {
      if (!probe) {
        const mat = new THREE.ShaderMaterial({
          uniforms: { map: { value: null } },
          vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
          // Square-rooted so dark values keep their precision in eight bits.
          fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = vec4(sqrt(texture2D(map, vUv).rgb), 1.0); }',
          depthTest: false, depthWrite: false,
        });
        const scene = new THREE.Scene();
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
        quad.frustumCulled = false;
        scene.add(quad);
        probe = { target: new THREE.WebGLRenderTarget(PROBE, PROBE, { depthBuffer: false }), scene, cam: new THREE.Camera(), mat };
      }
      probe.mat.uniforms['map']!.value = tex;
      const before = gl.getRenderTarget();
      gl.setRenderTarget(probe.target);
      gl.render(probe.scene, probe.cam);
      const px = new Uint8Array(PROBE * PROBE * 4);
      gl.readRenderTargetPixels(probe.target, 0, 0, PROBE, PROBE, px);
      gl.setRenderTarget(before);
      probe.mat.uniforms['map']!.value = null;
      grid = new Float32Array(PROBE * PROBE);
      for (let i = 0, j = 0; i < px.length; i += 4, j++) {
        const r = (px[i]! / 255) ** 2, g = (px[i + 1]! / 255) ** 2, bl = (px[i + 2]! / 255) ** 2;
        grid[j] = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      }
    } catch {
      grid = null;
    }
  }
  pixelCache.set(tex.uuid, grid);
  return grid;
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

/**
 * The typical brightness of a texture where the given meshes actually use it, averaged as
 * the eye sees it (in square-root space). Most of an atlas is often empty or belongs to
 * other parts, so the whole image misleads.
 */
function usedLuminance(tex: THREE.Texture, meshes: readonly THREE.Mesh[]): number {
  const grid = luminanceGrid(tex);
  if (!grid) return 0.1;
  let sum = 0, weight = 0;
  const at = (u: number, v: number): number => {
    u -= Math.floor(u);
    v -= Math.floor(v);
    const x = Math.min(PROBE - 1, Math.floor(u * PROBE)), y = Math.min(PROBE - 1, Math.floor(v * PROBE));
    return grid[y * PROBE + x]!;
  };
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const uv = geo.getAttribute('uv'), pos = geo.getAttribute('position');
    if (!uv || !pos) continue;
    // One sample per triangle, weighted by its size on the model: a big flat panel counts
    // for more than a cluster of tiny screws.
    const index = geo.getIndex();
    const tris = Math.floor((index ? index.count : pos.count) / 3);
    const step = Math.max(1, Math.floor(tris / 3000));
    for (let t = 0; t < tris; t += step) {
      const a = index ? index.getX(t * 3) : t * 3, b = index ? index.getX(t * 3 + 1) : t * 3 + 1, c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      _a.fromBufferAttribute(pos, a);
      _b.fromBufferAttribute(pos, b).sub(_a);
      _c.fromBufferAttribute(pos, c).sub(_a);
      const area = _b.cross(_c).length();
      if (!(area > 0)) continue;
      const l = at((uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3, (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3);
      sum += Math.sqrt(l) * area;
      weight += area;
    }
  }
  if (weight === 0) {
    // No geometry to go by: the whole image, leaving out unused (black) atlas space.
    for (let i = 0; i < grid.length; i++) {
      if (grid[i]! < 0.0015) continue;
      sum += Math.sqrt(grid[i]!);
      weight++;
    }
  }
  return weight > 0 ? (sum / weight) ** 2 : 0.1;
}

// ---- gun space ---------------------------------------------------------------------------

/**
 * Record on a mesh where each of its vertices sits on the gun (gun space: x towards the
 * muzzle, y up, metres), which is what a skin's pattern is painted in. `box` grows to hold it.
 * `toGun` takes the mesh's own space to gun space.
 */
export function tagGunSpace(mesh: THREE.Mesh, toGun: THREE.Matrix4, box?: THREE.Box3): void {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  if (!pos) return;
  let tag = geo.getAttribute('npPos') as THREE.BufferAttribute | undefined;
  if (!tag) {
    // A mesh on a skeleton is measured as the skeleton currently poses it.
    const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh) : null;
    skinned?.skeleton.update();
    const out = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      if (skinned) skinned.getVertexPosition(i, _a);
      else _a.fromBufferAttribute(pos, i);
      _a.applyMatrix4(toGun);
      out[i * 3] = _a.x;
      out[i * 3 + 1] = _a.y;
      out[i * 3 + 2] = _a.z;
    }
    tag = new THREE.BufferAttribute(out, 3);
    geo.setAttribute('npPos', tag);
  }
  if (box) {
    for (let i = 0; i < tag.count; i++) box.expandByPoint(_a.fromBufferAttribute(tag, i));
  }
}

/** What part of a gun a piece is, from its name. */
export function roleOf(name: string): Role {
  if (/^(mag|clip|shells)/i.test(name)) return 'cell';
  if (/^(slide|bolt|hammer|forend)/i.test(name)) return 'moving';
  return 'body';
}

// ---- the shader --------------------------------------------------------------------------

const SKIN_GLSL = /* glsl */ `
uniform int npPattern;
uniform float npScale;
uniform vec3 npColA;
uniform vec3 npColB;
uniform vec3 npGlowA;
uniform vec3 npGlowB;
uniform vec4 npSpan;   // x: breech, y: muzzle, z: magazine bottom, w: magazine top
uniform vec3 npLive;   // x: time, y: heat, z: rounds left (0..1)
uniform float npRole;  // 0 body, 1 moving part, 2 magazine
varying vec3 vNpPos;
vec3 npEmit;

float npHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float npHexDist(vec2 p) { p = abs(p); return max(dot(p, vec2(0.5, 0.8660254)), p.x); }

// Returns x: how much of paint B (0..1), y: how strongly the spot emits light (0..1).
vec2 npPaint(vec2 q) {
  float m = 0.0, e = 0.0;
  if (npPattern == 1) {
    // Hexagon plating: scattered plates in the second paint, lit seams.
    const vec2 r = vec2(1.0, 1.7320508);
    vec2 h = r * 0.5;
    vec2 ga = mod(q, r) - h, gb = mod(q - h, r) - h;
    vec2 gv = dot(ga, ga) < dot(gb, gb) ? ga : gb;
    float id = npHash(floor((q - gv) * 2.0 + 0.5));
    float d = 0.5 - npHexDist(gv);
    m = step(0.62, id) * smoothstep(0.03, 0.07, d);
    e = (1.0 - smoothstep(0.012, 0.045, d)) * (0.35 + 0.65 * step(0.62, id));
  } else if (npPattern == 2) {
    // Digital camouflage in three tones, with a few lit pixels.
    float n = npHash(floor(q)) * 0.55 + npHash(floor(q * 2.0) + 17.0) * 0.45;
    m = n < 0.4 ? 0.0 : (n < 0.66 ? 0.5 : 1.0);
    float bit = npHash(floor(q * 2.0) + 5.0);
    e = step(0.955, bit) * (0.45 + 0.55 * sin(npLive.x * 3.0 + bit * 60.0));
  } else if (npPattern == 3) {
    // Tiger stripes with a hot rim.
    float w = q.x * 0.9 + q.y * 1.1 + sin(q.y * 2.1 + q.x * 0.6) * 0.7 + sin(q.x * 1.3) * 0.4;
    float s = sin(w * 2.6);
    m = smoothstep(0.18, 0.3, s);
    e = smoothstep(0.02, 0.16, s) * (1.0 - smoothstep(0.18, 0.3, s));
  } else if (npPattern == 4) {
    // Circuit traces: runs, risers and solder points.
    vec2 id = floor(q), f = fract(q);
    float h = npHash(id);
    float run = (1.0 - smoothstep(0.035, 0.075, abs(f.y - 0.5))) * step(h, 0.5);
    float rise = (1.0 - smoothstep(0.035, 0.075, abs(f.x - 0.5))) * step(0.72, h);
    float pad = (1.0 - smoothstep(0.11, 0.16, length(f - 0.5))) * step(0.4, h) * step(h, 0.62);
    e = max(max(run, rise), pad);
    m = step(0.86, npHash(floor(q / 3.0) + 3.0));
  } else if (npPattern == 5) {
    // Carbon weave, with a lit thread every few rows.
    vec2 id = floor(q), f = fract(q);
    float over = mod(id.x + id.y, 2.0);
    float t = over > 0.5 ? f.x : f.y;
    m = 0.25 + 0.75 * abs(t - 0.5) * 2.0;
    e = (1.0 - smoothstep(0.04, 0.1, abs(f.y - 0.5))) * step(mod(id.y, 7.0), 0.5);
  } else {
    // Hazard chevrons.
    float w = fract(q.x * 0.5 + abs(q.y) * 0.5);
    m = step(0.5, w);
    float edge = min(abs(w - 0.5), min(w, 1.0 - w));
    e = 1.0 - smoothstep(0.015, 0.05, edge);
  }
  return vec2(m, e);
}
`;

/** GLSL run right after the texture is read: grade it, then paint the skin over it. */
const GRADE_GLSL = /* glsl */ `
{ float npL = max(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0005);
  // Re-centre on the common level and squeeze the range: wear and panel lines stay
  // as light and dark, but no texture ends up much brighter or darker than another.
  float npRel = min(pow(npL / npGrade.x, npGrade.z), 2.2);
  #ifdef NP_SKIN
    float npAlong = clamp((vNpPos.x - npSpan.x) / max(npSpan.y - npSpan.x, 0.01), 0.0, 1.0);
    vec3 npGlow = mix(npGlowA, npGlowB, npAlong);
    // A bright band runs down the gun; firing heats every line and the muzzle end most.
    // (kept gentle: the lines are there to be read, not to light the room)
    float npBand = pow(0.5 + 0.5 * sin(vNpPos.x * 14.0 - npLive.x * 1.3), 4.0);
    float npPulse = 0.62 + 0.16 * npBand + npLive.y * 0.38;
    vec3 npCol;
    if (npRole > 1.5) {
      // The magazine is a cell: bars lit from the bottom up to the rounds left in it.
      float npH = clamp((vNpPos.y - npSpan.z) / max(npSpan.w - npSpan.z, 0.01), 0.0, 1.0);
      float npBar = step(0.3, fract(npH * 7.0));
      float npFull = step(npH, npLive.z * 0.86 + 0.02);
      npCol = npColA * 0.6;
      npEmit = npGlow * npBar * (npFull * (0.6 + 0.1 * npBand) + (1.0 - npFull) * 0.03);
    } else {
      // (the pattern is laid out on the gun's side; depth is folded in so tops are painted too)
      vec2 npPE = npPaint(vec2(vNpPos.x, vNpPos.y + vNpPos.z * 0.7) * npScale);
      npCol = npRole > 0.5 ? mix(npColB, npColA, npPE.x * 0.35) : mix(npColA, npColB, npPE.x);
      float npTip = smoothstep(npSpan.y - 0.09, npSpan.y, vNpPos.x) * npLive.y;
      npEmit = npGlow * (npPE.y * npPulse * (npRole > 0.5 ? 0.5 : 1.0) + npTip * 0.45);
    }
    // (the model's own wear and panel lines show through the paint as light and dark)
    diffuseColor.rgb = npCol * (0.5 + 0.5 * clamp(npRel, 0.3, 1.5));
  #else
    diffuseColor.rgb = mix(vec3(npL), diffuseColor.rgb, npSat) * (npGrade.y * npRel / npL) * npTint;
  #endif
}`;

const RIM_GLSL = /* glsl */ `
{ float npF = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 4.0);
  totalEmissiveRadiance += npRim * npF;
  #ifdef NP_SKIN
    totalEmissiveRadiance += npEmit;
  #endif
}`;

const ROLE_ID: Record<Role, number> = { body: 0, moving: 1, cell: 2 };
/**
 * How bright a skin's lines are overall. Set so they stay under the level at which the
 * picture starts to bloom: crisp lines rather than a haze, except briefly when the gun is hot.
 */
const GLOW = 0.34;

/**
 * A copy of `src` wearing the finish, and the skin if one is given.
 * @param meshes the meshes that will wear it, used to measure how bright their part of the texture is
 * @param wear a skin to paint over the finish; the meshes must have been through `tagGunSpace`
 */
export function applyFinish(src: THREE.Material, f: Finish, meshes: readonly THREE.Mesh[] = [], wear?: SkinWear): THREE.Material {
  const m = src.clone() as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial) return m;
  // The brightness the surface has as authored: its colour, times its texture's typical value.
  const own = Math.max(0.004, 0.2126 * m.color.r + 0.7152 * m.color.g + 0.0722 * m.color.b);
  const base = Math.max(0.002, m.map ? usedLuminance(m.map, meshes) * own : own);
  const skin = wear?.skin;
  m.metalness = Math.min(m.metalness, skin?.metal ?? f.metal);
  m.roughness = skin?.rough ?? Math.min(f.roughMax, Math.max(m.roughness, f.roughMin));
  m.envMapIntensity = f.env;
  if (m.emissiveMap) m.emissiveIntensity = 0.2;
  if (m.transparent) {
    m.depthWrite = true;
    m.alphaTest = Math.max(m.alphaTest, 0.02);
  }
  const rim = new THREE.Color(f.rim).multiplyScalar(f.rimStrength);
  const tint = new THREE.Vector3(f.tint[0], f.tint[1], f.tint[2]);
  // (kept by reference: the live values are refreshed just before each draw)
  const live = new THREE.Vector3();
  if (wear) {
    m.onBeforeRender = () => { live.set(FINISH_TIME.value, wear.heat.value, wear.ammo.value); };
  }
  m.onBeforeCompile = (shader) => {
    shader.uniforms['npSat'] = { value: f.sat };
    shader.uniforms['npTint'] = { value: tint };
    shader.uniforms['npRim'] = { value: rim };
    // x: the surface's own typical brightness, y: the brightness to bring it to, z: contrast kept
    shader.uniforms['npGrade'] = { value: new THREE.Vector3(base, f.level, f.contrast) };
    let head = 'uniform float npSat;\nuniform vec3 npTint;\nuniform vec3 npRim;\nuniform vec3 npGrade;\n';
    if (wear && skin) {
      const glowA = wear.glow ?? new THREE.Color(skin.glow).multiplyScalar(skin.glowStrength * GLOW);
      const glowB = wear.glow ?? new THREE.Color(skin.glow2 ?? skin.glow).multiplyScalar(skin.glowStrength * GLOW);
      shader.uniforms['npPattern'] = { value: PATTERN_ID[skin.pattern] };
      shader.uniforms['npScale'] = { value: skin.scale };
      shader.uniforms['npColA'] = { value: new THREE.Color(skin.a) };
      shader.uniforms['npColB'] = { value: new THREE.Color(wear.role === 'moving' ? skin.accent : skin.b) };
      shader.uniforms['npGlowA'] = { value: glowA };
      shader.uniforms['npGlowB'] = { value: glowB };
      shader.uniforms['npSpan'] = { value: new THREE.Vector4(wear.length.x, wear.length.y, wear.cell.x, wear.cell.y) };
      shader.uniforms['npLive'] = { value: live };
      shader.uniforms['npRole'] = { value: ROLE_ID[wear.role] };
      head = '#define NP_SKIN\n' + head + SKIN_GLSL;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 npPos;\nvarying vec3 vNpPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNpPos = npPos;');
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + head)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + GRADE_GLSL)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + RIM_GLSL);
  };
  m.customProgramCacheKey = () => (wear ? 'np-skin' : 'np-finish');
  return m;
}
