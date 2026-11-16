// One look for every weapon and every pair of arms.
//
// The models come from different authors: wood and bare steel on one, olive polymer on
// another, tan gloves here and black ones there. Rather than repaint each texture, the
// material is re-graded in the shader: the texture is desaturated (its wear, panel lines
// and markings survive as light and dark), brought to a common brightness measured from
// the texture itself, tinted to one colour, and given a faint coloured edge light.

import * as THREE from 'three';

export interface Finish {
  /** How much of the texture's own colour survives (0 = none). */
  sat: number;
  tint: [number, number, number];
  /** Average brightness to bring the texture to (linear, 0..1). */
  level: number;
  /** Edge-light colour and strength. */
  rim: number;
  rimStrength: number;
  /** How much of the texture's light-to-dark range survives (1 = all, 0 = flat). */
  contrast: number;
  metal: number;
  /** The roughness scale is kept between these (it multiplies the model's own roughness map). */
  roughMin: number;
  roughMax: number;
  env: number;
}

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
/** Dark slate sleeves and gloves, identical whichever weapon is held. */
export const ARMS_FINISH: Finish = {
  sat: 0, tint: [0.74, 0.8, 0.92], level: 0.018, contrast: 0.42, rim: SHEEN, rimStrength: 0.03, metal: 0, roughMin: 0.7, roughMax: 1, env: 0.5,
};
/** Bright worn steel for the blade. */
export const BLADE_FINISH: Finish = {
  sat: 0.1, tint: [0.9, 0.95, 1.0], level: 0.16, contrast: 0.8, rim: SHEEN, rimStrength: 0.05, metal: 0.55, roughMin: 0.3, roughMax: 0.5, env: 1.4,
};
/** Guns seen in other players' hands: the same graphite, no edge light. */
export const WORLD_GUN_FINISH: Finish = { ...gunFinish(-1), rimStrength: 0, level: 0.07 };

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
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

/**
 * A copy of `src` wearing the finish.
 * @param meshes the meshes that will wear it, used to measure how bright their part of the texture is
 */
export function applyFinish(src: THREE.Material, f: Finish, meshes: readonly THREE.Mesh[] = []): THREE.Material {
  const m = src.clone() as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial) return m;
  // The brightness the surface has as authored: its colour, times its texture's typical value.
  const own = Math.max(0.004, 0.2126 * m.color.r + 0.7152 * m.color.g + 0.0722 * m.color.b);
  const base = Math.max(0.002, m.map ? usedLuminance(m.map, meshes) * own : own);
  m.metalness = Math.min(m.metalness, f.metal);
  m.roughness = Math.min(f.roughMax, Math.max(m.roughness, f.roughMin));
  m.envMapIntensity = f.env;
  if (m.emissiveMap) m.emissiveIntensity = 0.2;
  if (m.transparent) {
    m.depthWrite = true;
    m.alphaTest = Math.max(m.alphaTest, 0.02);
  }
  const rim = new THREE.Color(f.rim).multiplyScalar(f.rimStrength);
  const tint = new THREE.Vector3(f.tint[0], f.tint[1], f.tint[2]);
  m.onBeforeCompile = (shader) => {
    shader.uniforms['npSat'] = { value: f.sat };
    shader.uniforms['npTint'] = { value: tint };
    shader.uniforms['npRim'] = { value: rim };
    // x: the surface's own typical brightness, y: the brightness to bring it to, z: contrast kept
    shader.uniforms['npGrade'] = { value: new THREE.Vector3(base, f.level, f.contrast) };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float npSat;\nuniform vec3 npTint;\nuniform vec3 npRim;\nuniform vec3 npGrade;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         { float npL = max(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0005);
           // Re-centre on the common level and squeeze the range: wear and panel lines stay
           // as light and dark, but no texture ends up much brighter or darker than another.
           float npG = npGrade.y * min(pow(npL / npGrade.x, npGrade.z), 2.2);
           diffuseColor.rgb = mix(vec3(npL), diffuseColor.rgb, npSat) * (npG / npL) * npTint; }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         { float npF = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 4.0);
           totalEmissiveRadiance += npRim * npF; }`,
      );
  };
  m.customProgramCacheKey = () => 'np-finish';
  return m;
}
