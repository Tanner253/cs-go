// Rendering pipeline and environment.
//  - setupEnvironment: sky, megacity backdrop, fog, lights, reflection probe.
//  - createGfx: owns the frame draw — world pass, viewmodel pass on top (own depth range,
//    so it can never clip into walls), then bloom + grade on the higher tiers.
// Everything is procedural; nothing here allocates per frame.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export type Quality = 'high' | 'medium' | 'low';

/** Shared lighting constants: the world bake and the realtime lights must agree. */
export const LIGHTING = {
  /** Direction TO the key light (a low, cool "sky key" for blue hour). */
  sunDir: new THREE.Vector3(-0.46, 0.66, 0.6).normalize(),
  sunColor: new THREE.Color(0xcfe0ff),
  sunIntensity: 2.3,
  skyColor: new THREE.Color(0x7f9ee0),
  groundColor: new THREE.Color(0x3a3644),
  hemiIntensity: 1.55,
  fogColor: new THREE.Color(0x2b3d66),
  fogDensity: 0.0042,
};

/** Objects that care about the quality tier register `userData.onQuality`. */
function notifyQuality(scene: THREE.Scene, q: Quality): void {
  scene.traverse((o) => {
    const fn = o.userData['onQuality'] as ((q: Quality) => void) | undefined;
    if (fn) fn(q);
  });
}

// ---------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------

function buildSky(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      zenith: { value: new THREE.Color(0x070b1f) },
      mid: { value: new THREE.Color(0x1c3a7a) },
      horizon: { value: new THREE.Color(0xff9a6a) },
      haze: { value: new THREE.Color(0x4a5fa8) },
      moonDir: { value: LIGHTING.sunDir.clone() },
    },
    // w = 0 drops the camera translation, so the dome is always centred on the viewer.
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; vec4 mv = modelViewMatrix * vec4(position, 0.0); gl_Position = (projectionMatrix * vec4(mv.xyz, 1.0)).xyww; }',
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 zenith; uniform vec3 mid; uniform vec3 horizon; uniform vec3 haze; uniform vec3 moonDir;
      float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        // Blue hour: warm band hugging the horizon on one side, deep indigo overhead.
        float sunset = pow(max(0.0, 1.0 - abs(h) * 3.2), 3.0) * (0.55 + 0.45 * max(0.0, dot(normalize(d.xz), normalize(vec2(0.35, -1.0)))));
        vec3 c = mix(mid, zenith, smoothstep(0.0, 0.75, h));
        c = mix(c, haze, pow(1.0 - clamp(h, 0.0, 1.0), 5.0) * 0.8);
        c += horizon * sunset * 0.9;
        // Below the horizon: city glow fading into darkness.
        if (h < 0.0) c = mix(haze * 0.75 + horizon * 0.12, vec3(0.02, 0.03, 0.07), clamp(-h * 3.0, 0.0, 1.0));
        // Stars (stable: hashed on a quantised direction).
        vec3 q = floor(d * 190.0);
        float s = hash(q);
        float star = step(0.9975, s) * smoothstep(0.08, 0.5, h) * (0.6 + 0.4 * hash(q + 7.0));
        c += vec3(0.8, 0.9, 1.0) * star * 1.3;
        // A large pale moon as the key light source.
        float m = dot(d, normalize(moonDir));
        c += vec3(0.82, 0.9, 1.0) * (smoothstep(0.9988, 0.9992, m) * 2.4 + pow(max(m, 0.0), 90.0) * 0.22 + pow(max(m, 0.0), 8.0) * 0.05);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 14), mat);
  m.scale.setScalar(500);
  m.frustumCulled = false;
  m.renderOrder = -100;
  m.matrixAutoUpdate = false;
  m.updateMatrix();
  m.name = 'sky';
  return m;
}

function windowTexture(): THREE.CanvasTexture {
  const W = 128, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0a1024';
  g.fillRect(0, 0, W, H);
  let seed = 9;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let y = 4; y < H - 4; y += 8) {
    const rowLit = rnd();
    for (let x = 4; x < W - 4; x += 8) {
      const r = rnd();
      if (r > 0.42 + rowLit * 0.3) continue;
      const warm = rnd() < 0.7;
      const a = 0.25 + rnd() * 0.75;
      g.fillStyle = warm ? `rgba(255,${190 + ((rnd() * 40) | 0)},120,${a})` : `rgba(140,200,255,${a})`;
      g.fillRect(x, y, 5, 4);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** A ring of megastructures far outside the arena: one instanced draw call. */
function buildSkyline(): THREE.Object3D {
  const group = new THREE.Group();
  group.name = 'skyline';
  const N = 150;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  // Tile windows by world size so every tower has the same window scale.
  const uv = geo.attributes['uv'] as THREE.BufferAttribute;
  const nrm = geo.attributes['normal'] as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) if (Math.abs(nrm.getY(i)) > 0.5) uv.setXY(i, 0, 0);
  const mat = new THREE.MeshBasicMaterial({ map: windowTexture(), fog: true });
  mat.color.setScalar(1.6);
  mat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
       #ifdef USE_INSTANCING
         vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
         vMapUv = uv * vec2(max(sc.x, sc.z) / 26.0, sc.y / 104.0);
       #endif`,
    );
  };
  const inst = new THREE.InstancedMesh(geo, mat, N);
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < N; i++) {
    const ring = i % 3;
    const a = (i / N) * Math.PI * 2 + rnd() * 0.12;
    const r = 150 + ring * 75 + rnd() * 50;
    const h = 150 + rnd() * 190 + ring * 60;
    const w = 20 + rnd() * 34, d = 20 + rnd() * 34;
    const top = 35 + rnd() * 150 + ring * 30;
    p.set(Math.cos(a) * r, top - h / 2, Math.sin(a) * r);
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * Math.PI);
    s.set(w, h, d);
    m.compose(p, q, s);
    inst.setMatrixAt(i, m);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.frustumCulled = false;
  inst.matrixAutoUpdate = false;
  group.add(inst);

  // Relay beams: a few thin light shafts rising from distant towers.
  const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  const beamMat = new THREE.MeshBasicMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
  const beams = new THREE.InstancedMesh(beamGeo, beamMat, 5);
  for (let i = 0; i < 5; i++) {
    const a = 0.7 + i * 1.31;
    p.set(Math.cos(a) * (230 + i * 22), 170, Math.sin(a) * (230 + i * 22));
    q.identity();
    s.set(1.6, 440, 1.6);
    m.compose(p, q, s);
    beams.setMatrixAt(i, m);
  }
  beams.frustumCulled = false;
  beams.matrixAutoUpdate = false;
  group.add(beams);
  return group;
}

export function setupEnvironment(scene: THREE.Scene, renderer: THREE.WebGLRenderer, quality: Quality): void {
  // Small prefiltered probe so metals have something to reflect.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.32;
  scene.background = null;
  scene.fog = new THREE.FogExp2(LIGHTING.fogColor.getHex(), LIGHTING.fogDensity);

  scene.add(buildSky());
  scene.add(buildSkyline());

  const hemi = new THREE.HemisphereLight(LIGHTING.skyColor, LIGHTING.groundColor, LIGHTING.hemiIntensity);
  hemi.name = 'hemi';
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(LIGHTING.sunColor, LIGHTING.sunIntensity);
  sun.name = 'sun';
  sun.position.copy(LIGHTING.sunDir).multiplyScalar(110);
  const sc = sun.shadow.camera;
  sc.left = -58; sc.right = 58; sc.top = 58; sc.bottom = -58; sc.near = 20; sc.far = 220;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.035;
  scene.add(sun, sun.target);

  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const apply = (q: Quality): void => {
    const shadows = q !== 'low';
    renderer.shadowMap.enabled = shadows;
    sun.castShadow = shadows;
    const size = q === 'high' ? 4096 : 2048;
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    renderer.shadowMap.needsUpdate = true;
  };
  sun.userData['onQuality'] = apply;
  apply(quality);
}

// ---------------------------------------------------------------------------------------
// Frame pipeline
// ---------------------------------------------------------------------------------------

const FS_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

function fsMaterial(frag: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
}

export interface Gfx {
  render(dt: number, drawViewmodel: boolean): void;
  resize(w: number, h: number): void;
  setQuality(q: Quality): void;
  /** Current tier. */
  readonly quality: Quality;
  /** Draw calls and triangles of the last frame (all passes). */
  readonly stats: { calls: number; triangles: number };
}

const BLOOM_LEVELS = 5;

export function createGfx(
  renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera,
  vmScene: THREE.Scene, vmCamera: THREE.PerspectiveCamera, quality: Quality,
): Gfx {
  renderer.autoClear = false;
  renderer.info.autoReset = false;
  // 0.1 m is safe (the player hull keeps the eye 0.4 m from any wall) and doubles depth precision.
  camera.near = 0.1;
  camera.far = 900;
  camera.updateProjectionMatrix();
  vmScene.environment = scene.environment;
  vmScene.environmentIntensity = 0.75;

  const tri = new THREE.Mesh(new THREE.BufferGeometry(), undefined);
  tri.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  tri.geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  tri.frustumCulled = false;
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fsScene = new THREE.Scene();
  fsScene.add(tri);

  let q = quality;
  let width = 1, height = 1;
  let sceneRT: THREE.WebGLRenderTarget | null = null;
  const mips: THREE.WebGLRenderTarget[] = [];
  const stats = { calls: 0, triangles: 0 };
  let time = 0;

  const prefilter = fsMaterial(
    `varying vec2 vUv; uniform sampler2D tex; uniform vec2 texel;
     void main(){
       // 4-tap box downsample + soft-knee threshold: only genuinely bright pixels bloom.
       vec3 c = texture2D(tex, vUv + texel * vec2(-1.0, -1.0)).rgb + texture2D(tex, vUv + texel * vec2(1.0, -1.0)).rgb
              + texture2D(tex, vUv + texel * vec2(-1.0, 1.0)).rgb + texture2D(tex, vUv + texel * vec2(1.0, 1.0)).rgb;
       c *= 0.25;
       float br = max(c.r, max(c.g, c.b));
       float knee = clamp((br - 0.85) / 0.9, 0.0, 1.0);
       gl_FragColor = vec4(min(c, vec3(12.0)) * knee * knee, 1.0);
     }`,
    { tex: { value: null }, texel: { value: new THREE.Vector2() } },
  );
  const down = fsMaterial(
    `varying vec2 vUv; uniform sampler2D tex; uniform vec2 texel;
     void main(){
       vec3 c = texture2D(tex, vUv).rgb * 4.0;
       c += texture2D(tex, vUv + texel * vec2(-1.0, -1.0)).rgb + texture2D(tex, vUv + texel * vec2(1.0, -1.0)).rgb;
       c += texture2D(tex, vUv + texel * vec2(-1.0, 1.0)).rgb + texture2D(tex, vUv + texel * vec2(1.0, 1.0)).rgb;
       gl_FragColor = vec4(c / 8.0, 1.0);
     }`,
    { tex: { value: null }, texel: { value: new THREE.Vector2() } },
  );
  const up = fsMaterial(
    `varying vec2 vUv; uniform sampler2D tex; uniform vec2 texel;
     void main(){
       vec3 c = texture2D(tex, vUv + texel * vec2(-1.0, 0.0)).rgb + texture2D(tex, vUv + texel * vec2(1.0, 0.0)).rgb
              + texture2D(tex, vUv + texel * vec2(0.0, -1.0)).rgb + texture2D(tex, vUv + texel * vec2(0.0, 1.0)).rgb;
       c += (texture2D(tex, vUv + texel * vec2(-0.7, -0.7)).rgb + texture2D(tex, vUv + texel * vec2(0.7, -0.7)).rgb
           + texture2D(tex, vUv + texel * vec2(-0.7, 0.7)).rgb + texture2D(tex, vUv + texel * vec2(0.7, 0.7)).rgb);
       gl_FragColor = vec4(c / 8.0, 1.0);
     }`,
    { tex: { value: null }, texel: { value: new THREE.Vector2() } },
  );
  up.blending = THREE.AdditiveBlending;
  up.transparent = true;

  const final = fsMaterial(
    `varying vec2 vUv; uniform sampler2D tex; uniform sampler2D bloom; uniform float bloomStrength; uniform float time; uniform float exposure;
     float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
     vec3 aces(vec3 x){
       // Narkowicz fit: cheap and close to the reference curve.
       return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
     }
     void main(){
       vec3 c = texture2D(tex, vUv).rgb;
       c += texture2D(bloom, vUv).rgb * bloomStrength;
       c *= exposure;
       c = aces(c);
       // Grade: cool shadows, warm highlights, a touch more saturation and contrast.
       float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
       c = mix(vec3(l), c, 1.1);
       c = mix(c * vec3(0.94, 0.98, 1.08), c * vec3(1.05, 1.0, 0.95), smoothstep(0.15, 0.85, l));
       c = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
       // Vignette.
       vec2 v = vUv - 0.5;
       c *= 1.0 - dot(v, v) * 0.42;
       c = pow(c, vec3(1.0 / 2.2));
       // Dither away banding in the sky gradient.
       c += (hash(vUv * vec2(1920.0, 1080.0) + time) - 0.5) / 255.0;
       gl_FragColor = vec4(c, 1.0);
     }`,
    { tex: { value: null }, bloom: { value: null }, bloomStrength: { value: 0.55 }, time: { value: 0 }, exposure: { value: 1.0 } },
  );

  const disposeTargets = (): void => {
    sceneRT?.dispose();
    sceneRT = null;
    for (const m of mips) m.dispose();
    mips.length = 0;
  };

  const rebuild = (): void => {
    disposeTargets();
    // Resolution cap per tier keeps frame cost bounded on 4K / high-DPR displays.
    const maxPixels = q === 'high' ? 3.8e6 : q === 'medium' ? 2.2e6 : 1.25e6;
    const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(maxPixels / Math.max(1, width * height)));
    renderer.setPixelRatio(Math.max(0.5, dpr));
    renderer.setSize(width, height, false);
    if (q === 'low') return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    sceneRT = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.LinearSRGBColorSpace,
      samples: q === 'high' ? 4 : 2, depthBuffer: true, stencilBuffer: false,
    });
    let w = size.x >> 1, h = size.y >> 1;
    const levels = q === 'high' ? BLOOM_LEVELS : 4;
    for (let i = 0; i < levels && w >= 4 && h >= 4; i++) {
      mips.push(new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.LinearSRGBColorSpace, depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }));
      w >>= 1; h >>= 1;
    }
  };

  const blit = (mat: THREE.ShaderMaterial, src: THREE.Texture, dst: THREE.WebGLRenderTarget | null, texW: number, texH: number): void => {
    tri.material = mat;
    mat.uniforms['tex']!.value = src;
    const tx = mat.uniforms['texel'];
    if (tx) (tx.value as THREE.Vector2).set(1 / texW, 1 / texH);
    renderer.setRenderTarget(dst);
    renderer.render(fsScene, fsCam);
  };

  const gfx: Gfx = {
    get quality() { return q; },
    stats,
    resize(w: number, h: number): void {
      width = Math.max(1, w | 0);
      height = Math.max(1, h | 0);
      rebuild();
    },
    setQuality(next: Quality): void {
      if (next === q) return;
      q = next;
      notifyQuality(scene, q);
      notifyQuality(vmScene, q);
      rebuild();
    },
    render(dt: number, drawViewmodel: boolean): void {
      time += dt;
      renderer.info.reset();
      if (q === 'low' || !sceneRT) {
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.render(scene, camera);
        if (drawViewmodel) {
          renderer.clearDepth();
          renderer.render(vmScene, vmCamera);
        }
      } else {
        // HDR scene; tone mapping happens once in the final pass.
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.setRenderTarget(sceneRT);
        renderer.clear();
        renderer.render(scene, camera);
        if (drawViewmodel) {
          renderer.clearDepth();
          renderer.render(vmScene, vmCamera);
        }
        // Bloom pyramid.
        const m0 = mips[0]!;
        blit(prefilter, sceneRT.texture, m0, sceneRT.width, sceneRT.height);
        for (let i = 1; i < mips.length; i++) blit(down, mips[i - 1]!.texture, mips[i]!, mips[i - 1]!.width, mips[i - 1]!.height);
        for (let i = mips.length - 1; i > 0; i--) blit(up, mips[i]!.texture, mips[i - 1]!, mips[i]!.width, mips[i]!.height);
        final.uniforms['bloom']!.value = m0.texture;
        final.uniforms['time']!.value = time % 64;
        blit(final, sceneRT.texture, null, 1, 1);
      }
      stats.calls = renderer.info.render.calls;
      stats.triangles = renderer.info.render.triangles;
    },
  };

  notifyQuality(scene, q);
  notifyQuality(vmScene, q);
  width = renderer.domElement.clientWidth || window.innerWidth;
  height = renderer.domElement.clientHeight || window.innerHeight;
  rebuild();
  return gfx;
}
