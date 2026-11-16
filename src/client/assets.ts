// Loads the shipped first-person weapon packs (model + arms + animation in one GLB).
// The packs come from the ZONA project's asset pipeline; see CREDITS.md for their authors.

import type * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export interface PackInfo {
  file: string;
  fps: number;
  /** movement -> [first frame, last frame] of the pack's single long animation */
  clips: Record<string, [number, number]>;
  /** pack space -> eye space (x right, y up, muzzle down -z, metres), column-major */
  view: number[];
  /** where the pack is held relative to the eye (eye space, metres) */
  hold: [number, number, number];
  /** this pack's arms have no textures of their own: borrow them from another pack by the same maker */
  armsFrom?: string;
  /**
   * Packs whose file is only the arms: the gun is a separate model whose pieces are hung
   * on named joints of the arm skeleton so they move with the hands.
   */
  gun?: {
    file: string;
    /** pack space -> the gun file's space (x along the barrel, y up), column-major */
    frame: number[];
    /** gun piece (node name) -> joint it rides on */
    ride: Record<string, string>;
    /** a second magazine shown in the hand during reloads: [joint it hangs on, joint it is placed by] */
    spare?: [string, string];
  };
}

export const PACKS: Record<string, PackInfo> = {
  ak: {
    file: 'ak_fp.glb', fps: 30,
    clips: { idle: [0, 59.45], draw: [61.45, 80.9], fire: [82.9, 92.35], reload: [94.35, 173.8], reloadEmpty: [175.8, 280.75], reloadAlt: [282.75, 367.2], walk: [369.2, 398.65], run: [400.65, 412.6] },
    view: [-0.3419853, 0, 0, 0, 0, 0.3419853, 0, 0, 0, 0, -0.3419853, 0, 0, 0, 0, 1],
    hold: [0.05, -0.17, -0.12],
    gun: {
      file: 'ak.glb',
      frame: [0.0083554, 0.0369341, -0.3398824, 0, 0, 0.3399839, 0.0369451, 0, 0.3418833, -0.0009026, 0.0083065, 0, -0.2204215, -0.0081636, -0.041764, 1],
      ride: { base: 'PBody_058', bolt: 'Rif_059', safety: 'Safety_061', trigger: 'Trigger_060', mag: 'Pmag_062' },
      spare: ['Pmag2_063', 'Pmag_062'],
    },
  },
  smg: {
    file: 'smg_fp.glb', fps: 30,
    clips: { idle: [0, 49.45], draw: [51.45, 70.9], fire: [72.9, 82.35], reload: [84.35, 202.8], reloadEmpty: [204.8, 336.75], inspect: [338.75, 556.7], walk: [558.7, 580.65], run: [582.65, 597.1] },
    view: [-0.3443, 0, 0, 0, 0, 0.3443, 0, 0, 0, 0, -0.3443, 0, 0, 0, 0, 1],
    hold: [0.05, -0.17, -0.12],
    gun: {
      file: 'smg.glb',
      frame: [0.0052278, 0.0347936, -0.3424975, 0, 0, 0.342537, 0.0347977, 0, 0.3442603, -0.0005284, 0.005201, 0, -0.1702436, -0.0486295, -0.0435524, 1],
      ride: { base: 'PBody_058', base_2: 'PBody_058', bolt: 'Rif_059', trigger: 'Trigger_060', mag: 'Pmag_061' },
      spare: ['Pmag_2_062', 'Pmag_061'],
    },
  },
  m9: {
    file: 'm9_fp.glb', fps: 30,
    clips: { fire: [0, 11], reload: [12, 82], fireLast: [83, 94], reloadEmpty: [95, 175], holster: [176, 187], draw: [187, 233], idle: [234, 264] },
    view: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1],
    hold: [0.095, -0.135, -0.31],
  },
  knife: {
    file: 'knife_fp.glb', fps: 30,
    clips: { idle: [0, 40], cutA: [41, 60], cutB: [61, 80], stab: [81, 102], thrust: [103, 124], stow: [125, 135], draw: [135, 145] },
    view: [-0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, -0.01, 0, 0, 0, 0, 1],
    hold: [0, -0.16, -0.34],
    armsFrom: 'sniper',
  },
  sniper: {
    file: 'sniper_fp.glb', fps: 30,
    clips: { fire: [0, 10], bolt: [10, 48], reload: [49, 97], inspect: [98, 147], idle: [148, 180], melee: [180, 200] },
    view: [-0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, -0.01, 0, 0, 0, 0, 1],
    hold: [0.14, -0.22, -0.36],
  },
};

export interface WeaponLook {
  pack: keyof typeof PACKS;
  /** Colour multiplier for the gun's finish (arms are left alone where they have their own material). */
  tint?: [number, number, number];
  scale?: number;
}

/** Which pack each weapon id is drawn with. */
export const WEAPON_LOOK: Record<string, WeaponLook> = {
  edge: { pack: 'knife' },
  kite: { pack: 'm9' },
  tern: { pack: 'm9', tint: [0.72, 0.84, 1.0] },
  maul: { pack: 'm9', tint: [1.5, 1.38, 1.1], scale: 1.1 },
  wasp: { pack: 'smg' },
  breaker: { pack: 'smg', tint: [0.8, 0.8, 0.8] },
  hammerhead: { pack: 'ak' },
  lumen: { pack: 'ak', tint: [0.78, 0.95, 1.18] },
  longsight: { pack: 'sniper' },
};

export interface LoadedPack {
  pack: GLTF;
  gun: GLTF | null;
}

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const base = `${import.meta.env.BASE_URL}assets/weapons/`;
const loaded = new Map<string, LoadedPack | null>();
const pending = new Map<string, Promise<LoadedPack | null>>();

/** A loaded pack, or null if it is not available (yet). */
export function getPack(key: string): LoadedPack | null {
  return loaded.get(key) ?? null;
}

export function loadPack(key: string): Promise<LoadedPack | null> {
  let p = pending.get(key);
  if (!p) {
    const info = PACKS[key];
    p = info
      ? Promise.all([loader.loadAsync(base + info.file), info.gun ? loader.loadAsync(base + info.gun.file) : Promise.resolve(null)]).then(
          ([pack, gun]) => { const l = { pack, gun }; loaded.set(key, l); return l; },
          (err) => { console.warn(`weapon pack "${key}" failed to load`, err); loaded.set(key, null); return null; },
        )
      : Promise.resolve(null);
    pending.set(key, p);
  }
  return p;
}

// ---- third-person characters ---------------------------------------------------------

/** A weapon as other players see it: a low-poly model whose +x runs along the barrel. */
export interface WorldGun {
  scene: THREE.Object3D;
  /** where the right hand grips it, in the gun's own space */
  grip: [number, number, number];
  /** where the supporting (left) hand holds it, in the gun's own space */
  support: [number, number, number];
  /** muzzle tip in the gun's own space */
  muzzle: [number, number, number];
  /** a blade: its long axis is +y rather than +x */
  blade?: boolean;
}

export interface CharacterAssets {
  model: GLTF;
  clips: Map<string, THREE.AnimationClip>;
  guns: Map<string, WorldGun>;
}

const WORLD_GUNS: Record<string, { file: string; grip: [number, number, number]; support: [number, number, number]; muzzle: [number, number, number]; blade?: boolean }> = {
  ak: { file: 'ak_lod1.glb', grip: [-0.3, -0.02, 0.03], support: [0.0137, 0.029, -0.049], muzzle: [0.455, 0.03, 0.01] },
  smg: { file: 'smg_lod1.glb', grip: [-0.08, -0.02, 0.03], support: [0.105, 0.016, -0.08], muzzle: [0.25, 0.03, 0] },
  m9: { file: 'm9_lod1.glb', grip: [-0.072, -0.018, 0.032], support: [-0.069, -0.071, -0.035], muzzle: [0.218, 0.06, 0] },
  sniper: { file: 'sniper_lod1.glb', grip: [-0.425, 0, 0.034], support: [-0.041, -0.016, -0.064], muzzle: [0.726, 0.03, 0] },
  knife: { file: 'knife_lod1.glb', grip: [0.0146, -0.004, 0.076], support: [0, 0, 0], muzzle: [0, 0.24, 0], blade: true },
};

let characters: CharacterAssets | null = null;
let charactersPending: Promise<CharacterAssets | null> | null = null;

/** The soldier model, its animation clips and the world guns, once loaded. */
export function getCharacters(): CharacterAssets | null {
  return characters;
}

export function loadCharacters(): Promise<CharacterAssets | null> {
  if (!charactersPending) {
    const dir = `${import.meta.env.BASE_URL}assets/characters/`;
    const gunKeys = Object.keys(WORLD_GUNS);
    charactersPending = Promise.all([
      loader.loadAsync(`${dir}survivor.glb`),
      loader.loadAsync(`${dir}moves.glb`).catch(() => null),
      ...gunKeys.map((k) => loader.loadAsync(`${base}world/${WORLD_GUNS[k]!.file}`).catch(() => null)),
    ]).then(
      ([model, moves, ...gunFiles]) => {
        const clips = new Map<string, THREE.AnimationClip>();
        // The shared library first, so the model's own clips win where both have a name.
        for (const c of moves?.animations ?? []) clips.set(c.name, c);
        for (const c of model!.animations) clips.set(c.name, c);
        const guns = new Map<string, WorldGun>();
        gunKeys.forEach((k, i) => {
          const g = gunFiles[i];
          if (g) guns.set(k, { scene: g.scene, ...WORLD_GUNS[k]! });
        });
        characters = { model: model!, clips, guns };
        return characters;
      },
      (err) => { console.warn('character assets failed to load', err); return null; },
    );
  }
  return charactersPending;
}

/** Load everything the first match needs. Never rejects: a missing file only costs its model. */
export async function preloadAssets(onProgress?: (fraction: number) => void): Promise<void> {
  const keys = Object.keys(PACKS);
  let done = 0;
  const total = keys.length + 1;
  await Promise.all([
    ...keys.map((k) => loadPack(k).then(() => onProgress?.(++done / total))),
    loadCharacters().then(() => onProgress?.(++done / total)),
  ]);
}
