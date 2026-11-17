// Explosions: an HE grenade, the charge going up.
//
// Made in layers, each on its own clock, as the explosions of the ZONA project are (the owner:
// "zona had way better effects for explosions"); the method and the pictures are the same, the
// code is this game's own:
//   the flash     – a glow and a star of rays, there at once and gone in a fourteenth of a second
//   the fireball  – photographs of fire, each swelling, rising, boiling and cooling: what is brightest
//                   in a picture burns longest and the rest of it goes to soot
//   the smoke     – puffs, dark at their hearts, lit from inside while the fire lasts, turning and thinning
//   the dust      – rolled out along the floor, and a ring of it laid flat with a thin quick ring ahead
//   sparks, a burst of embers, the floor left scorched, a light that flares and dies away
// Every card of every blast is one draw, sorted far to near, each laid on as a body that hides what is
// behind it with its own light added over; soft where it meets the floor; and kept on the blast's side
// of any wall near it, so a blast at a corner does not show through the wall.
//
// Pictures: the smoke, dust, sparks, rays and rings out of the Particle Pack by Kenney (CC0), as one
// sheet; the fire out of the flame pictures of "Campfire" by Zelad (CC BY 4.0). See CREDITS.md.

import * as THREE from 'three';
import type { World } from '../sim/world';
import { newRayHit } from '../sim/world';

export type BlastKind = 'grenade' | 'charge';
/** What a bullet struck, for what flies off it. */
export type Surface = 'stone' | 'metal' | 'wood';
const SURFACE_DUST: Record<Surface, number> = { stone: 0x8c8a86, metal: 0x4e5156, wood: 0x6e5c40 };

/** The fire stills on the flame sheet (pixels of a 1024 sheet: left, top, right, bottom). */
const STILLS: [number, number, number, number][] = [
  [784, 123, 1009, 321], // a ball of fire rolling up on its stalk: most of every fireball is this
  [787, 536, 1012, 800], // a round ball of it
  [137, 158, 540, 525], // a hot yellow heart
  [786, 330, 1010, 528], // a net of thin flame: what a ball leaves as it goes
  [550, 328, 775, 526], // red rags of flame: the same
];
/** The sheet's tiles, four by four. */
const T = { puffs: [0, 1, 2, 3, 4, 5], clods: [6, 7, 8], streak: 9, embers: 10, burn: 11, rays: 12, ring: 13, dot: 14, hoop: 15 };
type Rect = [number, number, number, number];
const tile = (i: number): Rect => [(i % 4) / 4, Math.floor(i / 4) / 4, ((i % 4) + 1) / 4, (Math.floor(i / 4) + 1) / 4];

/**
 * What each blast is. Lengths are metres, HALF the width of a card; times seconds.
 *   fire  – n balls, each from r[0] to r[1], living life[0..1]; thrown `out` and `rise` (m/s), lifted by `lift`
 *   smoke – n puffs, r, life, `out`, `up`, `lift`; how dark at first and how pale as they thin; `lit` by the fire, for `litFor`
 *   dust  – n puffs rolled out to `reach`; the ring of dust and the thin quick ring: [how far, how long]
 *   light – flares to `flash` and is gone in `fast`, while a dimmer `ball` lasts `ballFor`
 */
const KIND = {
  grenade: {
    flash: [1.4, 2.3],
    fire: { n: 11, r: [0.42, 1.7], life: [0.45, 0.75], out: 4.6, rise: 2.8, lift: 1, over: 0.08, heat: 1.6 },
    smoke: { n: 10, r: [0.5, 2.5], life: [3.0, 4.4], out: 3.0, up: [3.2, 6.8], lift: 0.8, dark: 0.13, pale: 0.24, lit: 0.28, litFor: 0.14, over: [0.03, 0.15] },
    dust: { n: 10, reach: 4.6, r: [0.45, 1.4], life: [1.5, 2.5] },
    ring: 4, shock: [4, 0.13],
    spray: 3, embers: 2, sparks: { n: 16, speed: [11, 26], life: [0.22, 0.6] },
    burn: 1.9,
    light: { flash: 120, fast: 0.2, ball: 32, ballFor: 0.55, reach: 22 },
    shake: 1,
  },
  charge: {
    flash: [3.4, 5.6],
    fire: { n: 22, r: [1.0, 4.2], life: [0.6, 1.0], out: 11, rise: 7, lift: 2.2, over: 0.14, heat: 1.7 },
    smoke: { n: 18, r: [1.2, 6.0], life: [4.0, 6.0], out: 7, up: [6, 12], lift: 1.8, dark: 0.1, pale: 0.2, lit: 0.34, litFor: 0.25, over: [0.03, 0.3] },
    dust: { n: 18, reach: 12, r: [1.0, 3.4], life: [2.0, 3.4] },
    ring: 11, shock: [12, 0.2],
    spray: 6, embers: 4, sparks: { n: 30, speed: [18, 40], life: [0.3, 0.9] },
    burn: 5,
    light: { flash: 420, fast: 0.3, ball: 120, ballFor: 1.0, reach: 60 },
    shake: 1,
  },
};

/** The colour of what a blast raises off this level's floors (concrete, steel): as light sent back. */
const DUST = 0x8c8a86, CLODS = 0x3c3b39;
const MOST = 480;
const BURN_LIFE = 22, BURN_FADE = 6;

const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
const pick = <X>(a: X[]): X => a[Math.floor(Math.random() * a.length)]!;
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Card {
  live: boolean;
  of: Blast | null;
  wait: number;
  age: number;
  life: number;
  p: THREE.Vector3;
  v: THREE.Vector3;
  drag: number;
  fall: number;
  r0: number;
  r1: number;
  swell: number;
  tall: number;
  turn: number;
  spin: number;
  /** 0 faces the eye; 1 a streak along its flight; 2 lies flat on the floor */
  lies: 0 | 1 | 2;
  long: number;
  rect: Rect;
  fire: boolean;
  c0: number[];
  c1: number[];
  a: number;
  in: number;
  out: number;
  glow: number;
  thick: number;
  heart: number;
  h0: number;
  h1: number;
  floor: number;
  soft: number;
  own: number;
  far: number;
}

interface Blast {
  kind: BlastKind;
  at: THREE.Vector3;
  foot: number;
  age: number;
  walls: { q: THREE.Vector3; n: THREE.Vector3 }[];
  roofed: boolean;
  top: number;
  room: number;
  over: number;
}

const VERT = /* glsl */ `
  attribute vec3 iMid;
  attribute vec4 iShape;
  attribute vec4 iAxis;
  attribute vec4 iRect;
  attribute vec4 iTint;
  attribute vec4 iKind;
  attribute vec4 iMore;
  varying vec2 vOn;
  varying vec4 vRect;
  varying vec4 vTint;
  varying vec4 vKind;
  varying vec4 vMore;
  varying vec2 vHalf;
  varying vec3 vAt;
  void main() {
    vec3 toEye = cameraPosition - iMid;
    float far = length( toEye );
    vec3 eye = toEye / max( far, 1e-4 );
    vec3 right, up;
    float near = 1.0, rolls = 0.0;
    if ( iAxis.w < 0.5 ) {
      vec3 ref = abs( eye.y ) > 0.98 ? vec3( 1.0, 0.0, 0.0 ) : vec3( 0.0, 1.0, 0.0 );
      vec3 r0 = normalize( cross( ref, eye ) ), u0 = cross( eye, r0 );
      float c = cos( iShape.z ), s = sin( iShape.z );
      right = ( r0 * c + u0 * s ) * iShape.x;
      up = ( u0 * c - r0 * s ) * iShape.y;
      // (let go as the eye comes into it: a card that fills the picture is a wall)
      float big = max( iShape.x, iShape.y );
      near = smoothstep( 0.3 * big, 0.3 * big + max( 0.7, 0.6 * big ), far );
      rolls = 1.0;
    } else if ( iAxis.w < 1.5 ) {
      up = iAxis.xyz;
      right = normalize( cross( up, eye ) + vec3( 1e-5, 0.0, 0.0 ) ) * iShape.x;
      near = smoothstep( 0.2, 0.9, far );
    } else {
      float c = cos( iShape.z ), s = sin( iShape.z );
      right = vec3( c, 0.0, s ) * iShape.x;
      up = vec3( -s, 0.0, c ) * iShape.y;
    }
    vec3 off = right * position.x + up * position.y;
    vec3 world = iMid + off;
    vec3 way = off / max( length( off ), 1e-4 );
    vOn = position.xy;
    vRect = iRect;
    vTint = vec4( iTint.rgb, iTint.a * near );
    vKind = iKind;
    vMore = iMore;
    vHalf = vec2( length( right ), length( up ) );
    // (lit from above: what makes a flat puff a round one)
    vAt = vec3( world.y - iShape.w, iAxis.w > 1.5 ? 1.0 : 0.8 + 0.25 * way.y, rolls );
    gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
  }`;

const FRAG = /* glsl */ `
  uniform sampler2D tSheet;
  uniform sampler2D tFire;
  uniform sampler2D tRipple;
  uniform float uTime;
  uniform float uSky;
  varying vec2 vOn;
  varying vec4 vRect;
  varying vec4 vTint;
  varying vec4 vKind;
  varying vec4 vMore;
  varying vec2 vHalf;
  varying vec3 vAt;
  void main() {
    float fade = vTint.a;
    if ( vMore.w > 0.0 ) fade *= smoothstep( 0.0, vMore.w, vAt.x );
    if ( fade < 0.003 ) discard;
    vec2 on = vOn * 0.5 + 0.5;
    float fire = step( 0.5, vKind.x ), own = vKind.w;
    // A picture is a still; what moves in it is where each point reads it from, pushed about by a
    // pattern fixed in metres (fast through fire, which boils; slowly through smoke, which rolls).
    vec2 at = vOn * vHalf;
    float runs = uTime * mix( 0.42, 2.3, fire );
    vec2 a = texture2D( tRipple, at * 0.5 + vec2( own * 3.7, own * 5.3 - runs * 0.5 ) ).rg - 0.5;
    vec2 b = texture2D( tRipple, at * 1.5 + vec2( own * 9.1 + runs * 0.3, own * 2.9 - runs * 0.9 ) ).gr - 0.5;
    vec2 push = ( a * 0.2 + b * 0.08 ) * min( 0.5 + 0.35 * max( vHalf.x, vHalf.y ), 1.3 ) * vAt.z * mix( 0.8, 1.0, fire );
    vec2 from = on + push / ( 2.0 * max( vHalf, vec2( 0.01 ) ) );
    float edge = smoothstep( 0.0, 0.08, from.x ) * smoothstep( 0.0, 0.08, 1.0 - from.x ) * smoothstep( 0.0, 0.08, from.y ) * smoothstep( 0.0, 0.08, 1.0 - from.y );
    edge = mix( 1.0, edge, vAt.z );
    vec2 q = clamp( from, 0.0, 1.0 );
    vec3 body, light = vec3( 0.0 );
    float alpha, covers;
    if ( fire > 0.5 ) {
      vec4 t = texture2D( tFire, vec2( mix( vRect.x, vRect.z, q.x ), mix( vRect.w, vRect.y, q.y ) ) );
      // how HOT each point of the photograph is and how yellow; the colour is made from those, and as the
      // ball cools (vKind.z falling from over 1) only the brightest of it burns and the rest is soot
      float hot = max( t.r, max( t.g, t.b ) );
      float thin = smoothstep( 0.02, 0.5, hot );
      float heat = smoothstep( 0.03, 0.75, dot( t.rgb, vec3( 0.3, 0.6, 0.1 ) ) );
      float grain = texture2D( tRipple, at * 2.9 + vec2( own * 4.1 + runs * 0.2, own * 7.7 - runs * 1.2 ) ).r;
      heat = clamp( heat * ( 0.66 + 0.68 * grain ), 0.0, 1.0 );
      float warm = min( vKind.z, 1.0 );
      float cold = ( 1.0 - warm ) * 1.3;
      float burns = smoothstep( cold - 0.25, cold + 0.05, heat );
      float red = mix( 0.42, 1.55, heat ) * max( vKind.z, 1.0 ) * mix( 0.5, 1.0, warm );
      vec3 flame = vec3( red, red * min( t.g / max( t.r, 0.001 ), 0.62 ) * 0.82 * mix( 0.5, 1.0, warm ), red * 0.03 );
      vec3 soot = vec3( 0.045, 0.038, 0.034 ) * uSky + vec3( 0.25, 0.04, 0.0 ) * heat * warm;
      body = mix( soot, flame, burns );
      alpha = t.a * edge * fade * mix( 0.3, 1.0, thin ) * smoothstep( 0.02, 0.24, t.a ) * mix( 0.6, 1.0, max( warm, 1.0 - burns ) );
      light = body * 0.08 * burns;
      covers = alpha;
    } else {
      float d = texture2D( tSheet, vec2( mix( vRect.x, vRect.z, q.x ), mix( vRect.w, vRect.y, q.y ) ) ).r;
      alpha = clamp( d * vMore.y, 0.0, 1.0 ) * edge * fade;
      float dense = smoothstep( 0.15, 0.85, d );
      // smoke and dust: as bright as the level's light, lit from above, dark at the heart; and lit from
      // inside while there is fire in it
      body = vTint.rgb * mix( 1.0, vMore.z, dense ) * uSky * vAt.y + vec3( 1.0, 0.36, 0.0 ) * vKind.z * ( 0.12 + 0.88 * dense * dense );
      // (what is all light, a spark or the flash, is its own colour and hides nothing)
      body = mix( body, vTint.rgb, vKind.y );
      covers = alpha * ( 1.0 - vKind.y );
    }
    if ( alpha < 0.003 ) discard;
    gl_FragColor = vec4( body * alpha + light * alpha, covers );
  }`;

/** A tiling pattern of soft bumps, two channels, for pushing pictures about (made, not loaded). */
function ripple(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  let seed = 11;
  const r = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const grid = (n: number): number[] => Array.from({ length: n * n }, r);
  const layers = [[4, grid(4)], [8, grid(8)], [16, grid(16)]] as [number, number[]][];
  const other = [[4, grid(4)], [8, grid(8)], [16, grid(16)]] as [number, number[]][];
  const at = (n: number, g: number[], u: number, v: number): number => {
    const x = u * n, y = v * n, i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const val = (a: number, b: number): number => g[((b % n) + n) % n * n + ((a % n) + n) % n]!;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (val(i, j) * (1 - sx) + val(i + 1, j) * sx) * (1 - sy) + (val(i, j + 1) * (1 - sx) + val(i + 1, j + 1) * sx) * sy;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const k = (y * size + x) * 4;
      let a = 0, b = 0;
      [0.55, 0.3, 0.15].forEach((w, l) => { a += at(layers[l]![0], layers[l]![1], u, v) * w; b += at(other[l]![0], other[l]![1], u, v) * w; });
      data[k] = a * 255; data[k + 1] = b * 255; data[k + 2] = 128; data[k + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const ray = newRayHit();

export class Blasts {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private cards: Card[] = [];
  private blasts: Blast[] = [];
  private order: Card[] = [];
  private attrs: THREE.InstancedBufferAttribute[] = [];
  private mid = new Float32Array(MOST * 3);
  private shape = new Float32Array(MOST * 4);
  private axis = new Float32Array(MOST * 4);
  private rect = new Float32Array(MOST * 4);
  private tint = new Float32Array(MOST * 4);
  private kindA = new Float32Array(MOST * 4);
  private more = new Float32Array(MOST * 4);
  private time = { value: 0 };
  private light = new THREE.PointLight(0xffae6a, 0, 22, 2);
  /** The floor left scorched: cards that lie flat and last, apart from the rest. */
  private burns: Card[] = [];

  constructor(private world: World) {
    const base = `${import.meta.env.BASE_URL}assets/fx/`;
    const loader = new THREE.TextureLoader();
    const sheet = loader.load(`${base}blast.webp`);
    const fire = loader.load(`${base}flames.webp`);
    fire.colorSpace = THREE.SRGBColorSpace;
    // (rows read from the top, as the sheets are laid out)
    for (const t of [sheet, fire]) { t.flipY = false; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const add = (name: string, arr: Float32Array, size: number): void => {
      const a = new THREE.InstancedBufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      this.attrs.push(a);
    };
    add('iMid', this.mid, 3);
    add('iShape', this.shape, 4);
    add('iAxis', this.axis, 4);
    add('iRect', this.rect, 4);
    add('iTint', this.tint, 4);
    add('iKind', this.kindA, 4);
    add('iMore', this.more, 4);
    geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: { tSheet: { value: sheet }, tFire: { value: fire }, tRipple: { value: ripple() }, uTime: this.time, uSky: { value: 1.1 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
    this.group.add(this.mesh, this.light);
    for (let i = 0; i < MOST; i++) this.cards.push(this.blank());
  }

  private blank(): Card {
    return {
      live: false, of: null, wait: 0, age: 0, life: 1, p: new THREE.Vector3(), v: new THREE.Vector3(), drag: 0, fall: 0,
      r0: 1, r1: 1, swell: 1, tall: 1, turn: 0, spin: 0, lies: 0, long: 0, rect: tile(0), fire: false,
      c0: [1, 1, 1], c1: [1, 1, 1], a: 1, in: 0, out: 0.5, glow: 0, thick: 1, heart: 1, h0: 0, h1: 0, floor: -1e5, soft: 0, own: 0, far: 0,
    };
  }

  clear(): void {
    for (const c of this.cards) c.live = false;
    this.burns.length = 0;
    this.blasts.length = 0;
    this.light.intensity = 0;
  }

  /** A blast at `at` (the grenade's place; the floor under it is found). */
  go(at: { x: number; y: number; z: number }, kind: BlastKind): void {
    const K = KIND[kind];
    const w = this.world;
    const foot = w.raycast(at.x, at.y + 0.3, at.z, 0, -1, 0, 3, ray) ? at.y + 0.3 - ray.dist : at.y - 1;
    const b: Blast = { kind, at: new THREE.Vector3(at.x, Math.max(at.y, foot + 0.05), at.z), foot, age: 0, walls: [], roofed: false, top: Infinity, room: Infinity, over: 0 };
    this.roomOf(b);
    this.blasts.push(b);
    const room = Math.max(0.6, b.room);
    const fit = (r: number): number => Math.min(r, room);
    const low = b.roofed ? Math.min(1, (b.top - b.at.y) / 4.5) : 1;
    const floor = foot;
    const col = (hex: number, k = 1): number[] => { const c = new THREE.Color(hex); return [c.r * k, c.g * k, c.b * k]; };
    const grey = (k: number): number[] => [k, k * 0.98, k * 0.95];
    const heart = new THREE.Vector3(b.at.x, b.at.y + 0.25, b.at.z);
    const any = (): THREE.Vector3 => new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();

    // ---- the flash: there at once, and gone
    this.card(b, { p: heart, r0: K.flash[0], r1: fit(K.flash[1]), life: 0.075, tile: T.dot, c0: [3.2, 2.3, 1.2], c1: [2, 1, 0.3], a: 1, in: 0, out: 0.15, glow: 1, thick: 1.3, floor, soft: 0.3 });
    this.card(b, { p: heart, r0: K.flash[0] * 0.9, r1: fit(K.flash[1] * 1.25), life: 0.06, tile: T.rays, turn: rnd(0, 6.3), c0: [3.6, 2.5, 1.2], c1: [2, 1, 0.3], a: 0.85, in: 0, out: 0.1, glow: 1, thick: 1.6, floor, soft: 0.3 });

    // ---- the fireball
    const F = K.fire;
    for (let i = 0; i < F.n; i++) {
      const way = any();
      way.y = Math.abs(way.y) * 0.8 + 0.15;
      const late = i < 2 ? 0 : rnd(0, F.over), last = i / F.n > 0.72;
      const still = last ? pick([3, 4]) : pick([0, 0, 0, 1, 1, 2]);
      this.card(b, {
        p: heart.clone().addScaledVector(way, rnd(0.05, 0.45) * F.r[0]! * 2),
        v: way.clone().multiplyScalar(rnd(0.45, 1) * F.out * low * (last ? 0.5 : 1)).setY(way.y * F.out * 0.4 + rnd(0.5, 1) * F.rise * low),
        wait: late, life: rnd(F.life[0]!, F.life[1]!), drag: 2.6, fall: -F.lift * low,
        r0: F.r[0]! * rnd(0.8, 1.2), r1: fit(F.r[1]! * rnd(0.75, 1.15) * (last ? 0.8 : 1)), swell: 2.4, tall: still === 0 ? 0.9 : 1,
        turn: still === 0 ? rnd(-0.5, 0.5) : rnd(0, 6.3), spin: rnd(-0.5, 0.5),
        still, fire: true, a: 1, in: 0.03, out: 0.45, h0: F.heat * rnd(0.9, 1.1), h1: 0, floor, soft: 0.25,
      });
    }

    // ---- the smoke the fire turns into
    const S = K.smoke;
    for (let i = 0; i < S.n; i++) {
      const way = any();
      way.y = Math.abs(way.y);
      this.card(b, {
        p: heart.clone().addScaledVector(way, rnd(0.1, 0.5)),
        v: new THREE.Vector3(way.x * S.out * rnd(0.4, 1), rnd(S.up[0]!, S.up[1]!) * (0.35 + 0.65 * way.y) * low, way.z * S.out * rnd(0.4, 1)),
        wait: rnd(S.over[0]!, S.over[1]!), life: rnd(S.life[0]!, S.life[1]!), drag: 2.2, fall: -S.lift * low,
        r0: S.r[0]! * rnd(0.8, 1.2), r1: fit(S.r[1]! * rnd(0.8, 1.2)), swell: 2.6, turn: rnd(0, 6.3), spin: rnd(-0.45, 0.45),
        tile: pick(T.puffs), c0: grey(S.dark * rnd(0.8, 1.3)), c1: grey(S.pale), a: 0.9, in: 0.1, out: 0.3, thick: 1.7, heart: 0.45,
        h0: S.lit * rnd(0.7, 1.1), h1: S.litFor, floor, soft: 0.5,
      });
    }

    // ---- what the floor gives: dust rolled out, a ring of it, a thin quick ring ahead of it, clods
    if (b.at.y - foot < 1.5) {
      const D = K.dust, lift = new THREE.Vector3(b.at.x, foot + 0.1, b.at.z);
      const reach = Math.min(D.reach, room * 1.6);
      for (let i = 0; i < D.n; i++) {
        const a = ((i + Math.random()) / D.n) * Math.PI * 2, out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
        this.card(b, {
          p: lift.clone().addScaledVector(out, 0.35).setY(foot + 0.35), v: out.multiplyScalar(reach * 2.6 * rnd(0.7, 1.05)).setY(rnd(0.3, 1.1)),
          wait: rnd(0, 0.04), life: rnd(D.life[0]!, D.life[1]!), drag: 2.8, fall: -0.15,
          r0: D.r[0]!, r1: fit(D.r[1]! * rnd(0.8, 1.25)), swell: 2, turn: rnd(0, 6.3), spin: rnd(-0.5, 0.5),
          tile: pick(T.puffs), c0: col(DUST, rnd(0.6, 0.8)), c1: col(DUST, 0.95), a: 0.5, in: 0.05, out: 0.25, thick: 1.5, heart: 0.8, floor: foot - 0.3, soft: 0.45,
        });
      }
      this.card(b, { p: lift, lies: 2, r0: 0.5, r1: Math.min(K.ring, room * 1.5), swell: 2.2, life: 0.9, turn: rnd(0, 6.3), spin: 0.25, tile: T.ring, c0: col(DUST, 0.8), c1: col(DUST, 0.95), a: 0.55, in: 0.03, out: 0.2, thick: 1.6, heart: 0.85 });
      this.card(b, { p: lift, lies: 2, r0: 0.4, r1: Math.min(K.shock[0]!, room * 1.5), swell: 1.2, life: K.shock[1]! * 1.35, tile: T.hoop, c0: [0.8, 0.79, 0.75], c1: [0.8, 0.79, 0.75], a: 0.15, in: 0.015, out: 0.35, thick: 1.4 });
      for (let i = 0; i < K.spray; i++) {
        const way = any();
        this.card(b, {
          p: new THREE.Vector3(b.at.x, foot + 0.4, b.at.z), v: new THREE.Vector3(way.x * 3.5, rnd(5, 8.5) * low, way.z * 3.5), life: rnd(0.9, 1.3), drag: 0.9, fall: 9.8,
          r0: 0.3, r1: fit(rnd(1.2, 1.8) * (kind === 'grenade' ? 1 : 1.6)), swell: 1.5, turn: rnd(0, 6.3), spin: rnd(-1.2, 1.2),
          tile: pick(T.clods), c0: col(CLODS, 1.4), c1: col(CLODS, 1.4), a: 0.8, in: 0.04, out: 0.55, thick: 3.5, floor: foot - 0.2, soft: 0.3,
        });
      }
      // The floor left scorched: a patch under it and smaller ones round about.
      for (let i = 0; i < 5; i++) {
        const a = (i / 4) * Math.PI * 2 + rnd(0, 0.6), r = i ? K.burn * rnd(0.22, 0.36) : 0;
        const c = this.blank();
        c.live = true;
        c.p.set(b.at.x + Math.cos(a) * r, foot + 0.012 + i * 0.002, b.at.z + Math.sin(a) * r);
        c.lies = 2;
        c.r0 = c.r1 = K.burn * (i ? rnd(0.4, 0.55) : 0.72) * 0.5;
        c.turn = rnd(0, 6.3);
        c.rect = tile(i % 3 === 1 ? T.rays : T.burn);
        c.c0 = c.c1 = [0.02, 0.018, 0.016];
        c.a = i ? rnd(0.55, 0.85) : 0.95;
        c.thick = 1.4;
        c.heart = 1;
        c.life = BURN_LIFE;
        c.out = 1 - BURN_FADE / BURN_LIFE;
        this.burns.push(c);
        if (this.burns.length > 40) this.burns.shift();
      }
    }

    // ---- sparks, and a burst of embers
    const P = K.sparks;
    for (let i = 0; i < P.n; i++) {
      const way = any();
      way.y = Math.abs(way.y) * 0.9 + 0.05;
      this.card(b, {
        p: heart.clone(), v: way.multiplyScalar(rnd(P.speed[0]!, P.speed[1]!) * (b.roofed ? 0.6 : 1)), life: rnd(P.life[0]!, P.life[1]!), drag: 1.5, fall: 9.8,
        lies: 1, long: 0.022, r0: rnd(0.02, 0.035), r1: 0.012, tile: T.streak, c0: [4, 2.4, 0.8], c1: [2, 0.7, 0.1], a: 1, in: 0, out: 0.5, glow: 1, thick: 2.5,
      });
    }
    for (let i = 0; i < K.embers; i++) {
      this.card(b, {
        p: heart.clone().add(any().multiplyScalar(0.3)), v: any().multiplyScalar(2).setY(rnd(1, 3)), life: rnd(0.25, 0.38), drag: 2,
        r0: 0.4, r1: fit(rnd(0.9, 1.3) * F.r[1]!), swell: 2, turn: rnd(0, 6.3), tile: T.embers, c0: [2.2, 1.1, 0.28], c1: [1.4, 0.45, 0.05], a: 0.55, in: 0.015, out: 0.3, glow: 1, thick: 2.2,
      });
    }
    b.over = Math.max(1, ...this.cards.filter((c) => c.live && c.of === b).map((c) => c.wait + c.life));
  }

  /**
   * One tongue of a fire on the floor (a molotov's, an incendiary's): one of the fire photographs,
   * rising, swelling a little and burning down to nothing, seen from any side.
   */
  flame(x: number, y: number, z: number, size = 1): void {
    const b = this.ground;
    b.foot = y;
    this.card(b, {
      p: new THREE.Vector3(x, y + 0.2 * size, z), v: new THREE.Vector3(rnd(-0.15, 0.15), rnd(0.9, 1.6) * size, rnd(-0.15, 0.15)),
      life: rnd(0.45, 0.8), drag: 1.2, fall: -0.6,
      r0: 0.25 * size, r1: rnd(0.48, 0.78) * size, swell: 1.6, tall: rnd(1.25, 1.7), turn: rnd(-0.3, 0.3), spin: rnd(-0.4, 0.4),
      still: pick([0, 0, 1, 3, 4]), fire: true, a: 1, in: 0.08, out: 0.45, h0: rnd(0.95, 1.2), h1: 0.15, floor: y - 0.05, soft: 0.12,
    });
  }
  /**
   * A bullet striking the level: a flick of light, sparks thrown off it as streaks (a shower off
   * steel, a few off stone, hardly any off wood), a small puff of the stuff it is made of rolling
   * out from the face, and a chip or two falling.
   */
  hit(x: number, y: number, z: number, nx: number, ny: number, nz: number, surface: Surface): void {
    const b = this.ground;
    const n = new THREE.Vector3(nx, ny, nz);
    const at = new THREE.Vector3(x, y, z).addScaledVector(n, 0.02);
    const any = (): THREE.Vector3 => new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    const metal = surface === 'metal', wood = surface === 'wood';
    if (!wood) {
      this.card(b, { p: at.clone(), r0: 0.035, r1: 0.07, life: 0.04, tile: T.dot, c0: [3.2, 2.5, 1.5], c1: [2, 1, 0.3], a: 1, in: 0, out: 0.3, glow: 1, thick: 1.2 });
    }
    const sparks = metal ? 4 + Math.floor(Math.random() * 3) : wood ? (Math.random() < 0.3 ? 1 : 0) : 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < sparks; i++) {
      const way = n.clone().addScaledVector(any(), 0.95).normalize();
      this.card(b, {
        p: at.clone(), v: way.multiplyScalar(rnd(3.5, metal ? 10 : 7)), life: rnd(0.06, metal ? 0.2 : 0.13), drag: 1.4, fall: 9.8,
        lies: 1, long: 0.014, r0: rnd(0.012, 0.02), r1: 0.006, tile: T.streak, c0: [4, 2.6, 1], c1: [2, 0.8, 0.15], a: 1, in: 0, out: 0.5, glow: 1, thick: 2,
      });
    }
    const dust = new THREE.Color(SURFACE_DUST[surface]);
    const puffs = metal ? 1 : 2;
    for (let i = 0; i < puffs; i++) {
      this.card(b, {
        p: at.clone(), v: n.clone().multiplyScalar(rnd(0.5, 1.4)).add(any().multiplyScalar(0.3)).setY(n.y * 1.2 + rnd(0.1, 0.4)),
        life: rnd(0.45, 0.85), drag: 3, fall: -0.2, r0: 0.03, r1: rnd(0.18, metal ? 0.24 : 0.36), swell: 2.2, turn: rnd(0, 6.3), spin: rnd(-0.6, 0.6),
        tile: pick(T.puffs), c0: [dust.r * 0.75, dust.g * 0.75, dust.b * 0.75], c1: [dust.r, dust.g, dust.b], a: metal ? 0.35 : 0.55, in: 0.02, out: 0.45, thick: 1.5, heart: 0.8, soft: 0.2,
      });
    }
    if (!metal) {
      for (let i = 0; i < 2; i++) {
        this.card(b, {
          p: at.clone(), v: n.clone().multiplyScalar(rnd(1.5, 3)).add(any().multiplyScalar(1.2)).setY(rnd(0.8, 2.2)), life: rnd(0.3, 0.5), drag: 0.6, fall: 9.8,
          r0: rnd(0.018, 0.03), turn: rnd(0, 6.3), spin: rnd(-6, 6), tile: pick(T.clods), c0: [dust.r * 0.6, dust.g * 0.6, dust.b * 0.6], a: 0.9, in: 0, out: 0.4, thick: 3,
        });
      }
    }
  }

  /** (what a fire's flames belong to: no walls, never over) */
  private ground: Blast = { kind: 'grenade', at: new THREE.Vector3(), foot: 0, age: 0, walls: [], roofed: false, top: Infinity, room: Infinity, over: Infinity };

  /** What stands round a blast: the walls near it eight ways round and a roof over it; cards are kept on its side of them. */
  private roomOf(b: Blast): void {
    const w = this.world, f = b.at;
    const fy = f.y + 0.3;
    if (w.raycast(f.x, fy, f.z, 0, 1, 0, 9, ray) && ray.dist > 0.05) {
      b.roofed = true;
      b.top = fy + ray.dist;
      b.walls.push({ q: new THREE.Vector3(f.x, b.top, f.z), n: new THREE.Vector3(0, -1, 0) });
    }
    const open: number[] = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2, x = Math.cos(a), z = Math.sin(a);
      open.push(Infinity);
      if (!w.raycast(f.x, fy, f.z, x, 0, z, 8, ray) || ray.dist < 0.05 || ray.ny > 0.5) continue;
      open[k] = ray.dist;
      const n = new THREE.Vector3(ray.nx, 0, ray.nz).normalize();
      const q = new THREE.Vector3(f.x + x * ray.dist, fy, f.z + z * ray.dist);
      if (!b.walls.some((m) => m.n.dot(n) > 0.97 && Math.abs(m.n.dot(q) - m.n.dot(m.q)) < 0.3)) b.walls.push({ q, n });
    }
    let gap = Infinity;
    for (let k = 0; k < 4; k++) gap = Math.min(gap, open[k]! + open[k + 4]!);
    b.room = Math.min(gap, b.roofed ? b.top - b.foot : Infinity) / 2;
  }

  private card(b: Blast, o: Partial<Omit<Card, 'p' | 'v' | 'rect'>> & { p: THREE.Vector3; v?: THREE.Vector3; tile?: number; still?: number }): void {
    let c = this.cards.find((x) => !x.live);
    if (!c) {
      let least = Infinity;
      for (const x of this.cards) {
        const left = x.wait + x.life - x.age;
        if (left < least) { least = left; c = x; }
      }
    }
    if (!c) return;
    Object.assign(c, this.blank(), o, { p: c.p.copy(o.p), v: o.v ? c.v.copy(o.v) : c.v.set(0, 0, 0) });
    c.live = true;
    c.of = b;
    c.age = 0;
    c.r1 = o.r1 ?? c.r0;
    c.c1 = o.c1 ?? c.c0;
    if (c.fire) {
      const s = STILLS[o.still ?? 0]!;
      c.rect = [s[0] / 1024, s[1] / 1024, s[2] / 1024, s[3] / 1024];
    } else c.rect = tile(o.tile ?? T.dot);
    c.own = Math.random();
  }

  private size(c: Card): number {
    const u = Math.min(1, c.age / c.life);
    return c.r0 + (c.r1 - c.r0) * (1 - (1 - u) ** c.swell);
  }

  /** @returns how hard the view should shake now (0..1), from the blasts near `eye` */
  update(dt: number, eye: THREE.Vector3): number {
    this.time.value = (this.time.value + dt) % 4096;
    let lit = 0, shake = 0;
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i]!, L = KIND[b.kind].light;
      b.age += dt;
      const s = L.flash * Math.max(0, 1 - b.age / L.fast) ** 2 + L.ball * smooth(0, 0.1, b.age) * (1 - smooth(L.ballFor * 0.35, L.ballFor, b.age));
      if (s > lit) {
        lit = s;
        this.light.distance = L.reach;
        this.light.position.set(b.at.x, Math.min(b.at.y + 0.6 + Math.min(b.age, 1.2) * 2.2, b.top - 0.3), b.at.z);
      }
      const far = b.at.distanceTo(eye);
      if (b.age < 0.4) shake = Math.max(shake, KIND[b.kind].shake * (1 - b.age / 0.4) / (1 + (far / (b.kind === 'charge' ? 30 : 10)) ** 2));
      if (b.age > b.over) this.blasts.splice(i, 1);
    }
    this.light.intensity = lit;

    const order = this.order;
    order.length = 0;
    for (const c of this.cards) {
      if (!c.live) continue;
      if (c.wait > 0) { c.wait -= dt; continue; }
      c.age += dt;
      if (c.age >= c.life) { c.live = false; continue; }
      c.v.y -= c.fall * dt;
      const slow = Math.exp(-c.drag * dt);
      c.v.multiplyScalar(slow);
      c.p.addScaledVector(c.v, dt);
      c.turn += c.spin * dt;
      const walls = c.of?.walls;
      if (walls?.length && c.lies !== 2) {
        const r = c.lies === 1 ? 0.05 : Math.min(this.size(c), c.of!.room) * 0.8;
        for (const w of walls) {
          const d = (c.p.x - w.q.x) * w.n.x + (c.p.y - w.q.y) * w.n.y + (c.p.z - w.q.z) * w.n.z;
          if (d >= r) continue;
          c.p.addScaledVector(w.n, r - d);
          const into = c.v.dot(w.n);
          if (into < 0) c.v.addScaledVector(w.n, -into * 1.15);
        }
      }
      if (c.lies === 1 && c.of && c.p.y < c.of.foot - 0.1 && c.v.y < 0) { c.live = false; continue; }
      c.far = c.p.distanceToSquared(eye);
      order.push(c);
    }
    for (let i = this.burns.length - 1; i >= 0; i--) {
      const c = this.burns[i]!;
      c.age += dt;
      if (c.age >= c.life) { this.burns.splice(i, 1); continue; }
      c.far = c.p.distanceToSquared(eye) + 1e6; // (under everything else)
      order.push(c);
    }
    order.sort((a, b) => b.far - a.far);
    let n = 0;
    for (const c of order) {
      if (n >= MOST) break;
      const u = c.age / c.life, a3 = n * 3, a4 = n * 4;
      const r = this.size(c);
      const shows = c.a * (c.in > 0 ? smooth(0, c.in, c.age) : 1) * (1 - smooth(c.out, 1, u));
      if (shows <= 0.003) continue;
      this.mid[a3] = c.p.x; this.mid[a3 + 1] = c.p.y; this.mid[a3 + 2] = c.p.z;
      this.shape[a4] = r; this.shape[a4 + 1] = r * c.tall; this.shape[a4 + 2] = c.turn; this.shape[a4 + 3] = c.floor;
      if (c.lies === 1) {
        const long = Math.max(c.long, (r * 2) / Math.max(c.v.length(), 0.01)) * 0.5;
        this.axis[a4] = c.v.x * long; this.axis[a4 + 1] = c.v.y * long; this.axis[a4 + 2] = c.v.z * long;
      } else {
        this.axis[a4] = 0; this.axis[a4 + 1] = 1; this.axis[a4 + 2] = 0;
      }
      this.axis[a4 + 3] = c.lies;
      this.rect.set(c.rect, a4);
      this.tint[a4] = c.c0[0]! + (c.c1[0]! - c.c0[0]!) * u;
      this.tint[a4 + 1] = c.c0[1]! + (c.c1[1]! - c.c0[1]!) * u;
      this.tint[a4 + 2] = c.c0[2]! + (c.c1[2]! - c.c0[2]!) * u;
      this.tint[a4 + 3] = shows;
      this.kindA[a4] = c.fire ? 1 : 0;
      this.kindA[a4 + 1] = c.glow;
      this.kindA[a4 + 2] = c.fire ? c.h1 + (c.h0 - c.h1) * (1 - u) ** 1.6 : c.h1 > 0 ? c.h0 * Math.exp(-c.age / c.h1) : 0;
      this.kindA[a4 + 3] = c.own;
      this.more[a4] = 0; this.more[a4 + 1] = c.thick; this.more[a4 + 2] = c.heart; this.more[a4 + 3] = c.soft;
      n++;
    }
    const geo = this.mesh.geometry;
    geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) for (const a of this.attrs) a.needsUpdate = true;
    return shake;
  }
}
