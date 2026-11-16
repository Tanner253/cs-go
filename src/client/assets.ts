// Weapon and character assets.
//
// A first-person weapon is an "arm pack" (arms + skeleton + one long animation) with a gun
// on it. Three packs carry their own gun; for the others, and for every alternative gun,
// a separate gun model is hung piece by piece on named joints of the pack's skeleton, so
// one set of authored animations serves several weapons. The packs and models come from
// the ZONA project's asset pipeline; see CREDITS.md for their authors.

import type * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

type V3 = [number, number, number];

export interface PackInfo {
  file: string;
  fps: number;
  /** movement -> [first frame, last frame] of the pack's single long animation */
  clips: Record<string, [number, number]>;
  /** pack space -> eye space (x right, y up, muzzle down -z, metres), column-major */
  view: number[];
  /** where the pack is held relative to the eye (eye space, metres) */
  hold: V3;
  /** pack space -> the space gun models are authored in (x along the barrel, y up), column-major */
  frame?: number[];
  /**
   * The pack's gun was drawn on the skeleton with the arms, so a joint's place is taken from
   * the file as loaded rather than from the first frame of animation.
   */
  skinned?: boolean;
  /** this pack's arms have no textures of their own: borrow them from another pack by the same maker */
  armsFrom?: string;
  /** meshes of the pack's own gun, hidden when another gun is mounted in its place */
  ownGun?: string[];
}

/** A separate gun model mounted on a pack's joints. */
export interface GunMount {
  file: string;
  /** gun piece -> joint it rides on; pieces not listed ride with `base` */
  ride: Record<string, string>;
  /** optional attachments stored in the file that are not fitted */
  hide?: string[];
  /** a second magazine shown in the hand during reloads: [joint it hangs on, joint it is placed by] */
  spare?: [string, string];
  /** fine placement in the gun's own space */
  nudge?: V3;
  /** drawn at this fraction of its own size (hands sized for another gun) */
  size?: number;
  /** seat it so the top of its magazine meets the top of this other gun's magazine */
  alignMagTo?: string;
}

const AK_JOINTS = { base: 'PBody_058', bolt: 'Rif_059', safety: 'Safety_061', trigger: 'Trigger_060', mag: 'Pmag_062' };
const SMG_JOINTS = { base: 'PBody_058', bolt: 'Rif_059', trigger: 'Trigger_060', mag: 'Pmag_061' };
const PISTOL_JOINTS = { base: 'base', slide: 'slide', mag: 'mag', hammer: 'hammer' };

export const PACKS: Record<string, PackInfo> = {
  ak: {
    file: 'ak_fp.glb', fps: 30,
    clips: { idle: [0, 59.45], draw: [61.45, 80.9], fire: [82.9, 92.35], reload: [94.35, 173.8], reloadEmpty: [175.8, 280.75], reloadAlt: [282.75, 367.2], walk: [369.2, 398.65], run: [400.65, 412.6] },
    view: [-0.3419853, 0, 0, 0, 0, 0.3419853, 0, 0, 0, 0, -0.3419853, 0, 0, 0, 0, 1],
    hold: [0.05, -0.17, -0.12],
    frame: [0.0083554, 0.0369341, -0.3398824, 0, 0, 0.3399839, 0.0369451, 0, 0.3418833, -0.0009026, 0.0083065, 0, -0.2204215, -0.0081636, -0.041764, 1],
    skinned: true,
  },
  smg: {
    file: 'smg_fp.glb', fps: 30,
    clips: { idle: [0, 49.45], draw: [51.45, 70.9], fire: [72.9, 82.35], reload: [84.35, 202.8], reloadEmpty: [204.8, 336.75], inspect: [338.75, 556.7], walk: [558.7, 580.65], run: [582.65, 597.1] },
    view: [-0.3443, 0, 0, 0, 0, 0.3443, 0, 0, 0, 0, -0.3443, 0, 0, 0, 0, 1],
    // (close in: further out, the left elbow hangs in the corner of the view)
    hold: [0.07, -0.215, -0.02],
    frame: [0.0052278, 0.0347936, -0.3424975, 0, 0, 0.342537, 0.0347977, 0, 0.3442603, -0.0005284, 0.005201, 0, -0.1702436, -0.0486295, -0.0435524, 1],
    skinned: true,
  },
  m9: {
    file: 'm9_fp.glb', fps: 30,
    clips: { fire: [0, 11], reload: [12, 82], fireLast: [83, 94], reloadEmpty: [95, 175], holster: [176, 187], draw: [187, 233], idle: [234, 264] },
    view: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1],
    hold: [0.1, -0.19, -0.09],
    frame: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, -0.1514388, -0.0360554, 0.0042332, 1],
    ownGun: ['base', 'stopper', 'mag', 'hammer', 'trigger', 'slide'],
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
    frame: [0, 0, -0.01, 0, 0, 0.01, 0, 0, 0.01, 0, 0, 0, -0.3425852, -0.0541586, -0.014514, 1],
    ownGun: ['base', 'scope', 'glass', 'boltrear', 'bolt', 'cheekrest', 'trigger', 'clip', 'bullet', 'silencer', 'mag'],
  },
};

export interface WeaponLook {
  pack: keyof typeof PACKS;
  /** the gun mounted on the pack (omitted where the pack's own gun is the weapon) */
  mount?: GunMount;
  /** overrides the pack's hold position */
  hold?: V3;
  scale?: number;
  /** which model other players see this weapon as */
  world: string;
}

/** How each weapon id is drawn in first person. */
export const WEAPON_LOOK: Record<string, WeaponLook> = {
  edge: { pack: 'knife', world: 'knife' },
  // ---- attackers ----
  kite: { pack: 'm9', world: 'm9' },
  wasp: { pack: 'smg', world: 'smg', mount: { file: 'smg.glb', ride: SMG_JOINTS, spare: ['Pmag_2_062', 'Pmag_061'] } },
  hammerhead: { pack: 'ak', world: 'ak', mount: { file: 'ak.glb', ride: AK_JOINTS, spare: ['Pmag2_063', 'Pmag_062'] } },
  // ---- defenders ----
  // (every pistol is held in the pistol pack's two-handed grip, so the hands never change between sidearms)
  tern: { pack: 'm9', world: 'colt', mount: { file: 'colt_1911.glb', ride: PISTOL_JOINTS } },
  hornet: {
    pack: 'smg', world: 'mp7', hold: [0.08, -0.23, -0.05],
    // (its optic's lens is painted as a solid orange disc: left off, the iron sights stay;
    // the stock is left off too: extended, its rails run past the camera)
    mount: { file: 'mp7a1.glb', ride: SMG_JOINTS, hide: ['silencer', 'foregrip', 'sight', 'stock'], spare: ['Pmag_2_062', 'Pmag_061'] },
  },
  lumen: {
    pack: 'ak', world: 'ar15',
    mount: { file: 'ar15_lod1.glb', ride: { base: AK_JOINTS.base, mag: AK_JOINTS.mag }, hide: ['silencer', 'foregrip', 'light'], spare: ['Pmag2_063', 'Pmag_062'] },
  },
  // ---- both sides ----
  maul: { pack: 'm9', world: 'deagle', mount: { file: 'desert_eagle.glb', ride: PISTOL_JOINTS, size: 0.94 } },
  breaker: {
    pack: 'sniper', world: 'benelli', hold: [0.11, -0.2, -0.12],
    mount: { file: 'benelli_m3.glb', ride: { base: 'base' }, hide: ['silencer'], nudge: [0.08, -0.012, 0] },
  },
  longsight: { pack: 'sniper', world: 'sniper' },
};

// ---- loading ----------------------------------------------------------------------------

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const base = `${import.meta.env.BASE_URL}assets/weapons/`;
const files = new Map<string, GLTF | null>();
const pending = new Map<string, Promise<GLTF | null>>();

function loadFile(name: string): Promise<GLTF | null> {
  let p = pending.get(name);
  if (!p) {
    p = loader.loadAsync(base + name).then(
      (g) => { files.set(name, g); return g; },
      (err) => { console.warn(`weapon file "${name}" failed to load`, err); files.set(name, null); return null; },
    );
    pending.set(name, p);
  }
  return p;
}

export interface WeaponFiles {
  pack: GLTF;
  gun: GLTF | null;
  /** the gun whose magazine this one's is aligned to */
  magRef: GLTF | null;
  /** a pack whose arm textures are borrowed */
  arms: GLTF | null;
}

function filesFor(look: WeaponLook): string[] {
  const info = PACKS[look.pack]!;
  const out = [info.file];
  if (look.mount) out.push(look.mount.file);
  if (look.mount?.alignMagTo) out.push(look.mount.alignMagTo);
  if (info.armsFrom) out.push(PACKS[info.armsFrom]!.file);
  return out;
}

/** Everything a weapon needs, if it has all loaded; otherwise null. */
export function getWeapon(id: string): WeaponFiles | null {
  const look = WEAPON_LOOK[id];
  if (!look) return null;
  const info = PACKS[look.pack]!;
  const pack = files.get(info.file);
  if (!pack) return null;
  for (const f of filesFor(look)) if (!files.has(f)) return null;
  return {
    pack,
    gun: look.mount ? files.get(look.mount.file) ?? null : null,
    magRef: look.mount?.alignMagTo ? files.get(look.mount.alignMagTo) ?? null : null,
    arms: info.armsFrom ? files.get(PACKS[info.armsFrom]!.file) ?? null : null,
  };
}

export function loadWeapon(id: string): Promise<unknown> {
  const look = WEAPON_LOOK[id];
  return look ? Promise.all(filesFor(look).map(loadFile)) : Promise.resolve();
}

// ---- third-person characters ---------------------------------------------------------

export type Carry = 'rifle' | 'smg' | 'pistol' | 'knife';

/** A weapon as other players see it: a low-poly model whose +x runs along the barrel. */
export interface WorldGun {
  scene: THREE.Object3D;
  carry: Carry;
  /** where the right hand grips it, in the gun's own space */
  grip: V3;
  /** where the supporting (left) hand holds it, in the gun's own space */
  support: V3;
  /** muzzle tip in the gun's own space */
  muzzle: V3;
  /** a blade: its long axis is +y rather than +x */
  blade?: boolean;
}

export interface CharacterAssets {
  model: GLTF;
  clips: Map<string, THREE.AnimationClip>;
  guns: Map<string, WorldGun>;
}

const RIFLE_GRIP: V3 = [-0.3, -0.02, 0.03];
const LONG_GRIP: V3 = [-0.425, 0, 0.034];
const PISTOL_GRIP: V3 = [-0.072, -0.018, 0.032];
const PISTOL_SUPPORT: V3 = [-0.069, -0.071, -0.035];
const WORLD_GUNS: Record<string, Omit<WorldGun, 'scene'> & { file: string }> = {
  ak: { file: 'world/ak_lod1.glb', carry: 'rifle', grip: RIFLE_GRIP, support: [0.0137, 0.029, -0.049], muzzle: [0.455, 0.03, 0.01] },
  ar15: { file: 'ar15_lod1.glb', carry: 'rifle', grip: RIFLE_GRIP, support: [0.0137, 0.029, -0.049], muzzle: [0.373, 0.03, 0.01] },
  smg: { file: 'world/smg_lod1.glb', carry: 'smg', grip: [-0.08, -0.02, 0.03], support: [0.105, 0.016, -0.08], muzzle: [0.25, 0.03, 0] },
  mp7: { file: 'world/mp7a1_lod1.glb', carry: 'smg', grip: [-0.08, -0.02, 0.03], support: [0.105, -0.027, -0.029], muzzle: [0.466, 0.03, 0] },
  m9: { file: 'world/m9_lod1.glb', carry: 'pistol', grip: PISTOL_GRIP, support: PISTOL_SUPPORT, muzzle: [0.218, 0.06, 0] },
  colt: { file: 'world/colt_1911_lod1.glb', carry: 'pistol', grip: PISTOL_GRIP, support: PISTOL_SUPPORT, muzzle: [0.181, 0.06, 0] },
  deagle: { file: 'world/desert_eagle_lod1.glb', carry: 'pistol', grip: PISTOL_GRIP, support: PISTOL_SUPPORT, muzzle: [0.263, 0.06, 0] },
  sniper: { file: 'world/sniper_lod1.glb', carry: 'rifle', grip: LONG_GRIP, support: [-0.041, -0.016, -0.064], muzzle: [0.726, 0.03, 0] },
  benelli: { file: 'world/benelli_m3_lod1.glb', carry: 'rifle', grip: LONG_GRIP, support: [-0.041, -0.016, -0.064], muzzle: [0.83, 0.03, 0] },
  knife: { file: 'world/knife_lod1.glb', carry: 'knife', grip: [0.0146, -0.004, 0.076], support: [0, 0, 0], muzzle: [0, 0.24, 0], blade: true },
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
      ...gunKeys.map((k) => loadFile(WORLD_GUNS[k]!.file)),
    ]).then(
      ([model, moves, ...gunFiles]) => {
        const clips = new Map<string, THREE.AnimationClip>();
        // The shared library first, so the model's own clips win where both have a name.
        for (const c of moves?.animations ?? []) clips.set(c.name, c);
        for (const c of model!.animations) clips.set(c.name, c);
        const guns = new Map<string, WorldGun>();
        gunKeys.forEach((k, i) => {
          const g = gunFiles[i];
          if (g) guns.set(k, { ...WORLD_GUNS[k]!, scene: g.scene });
        });
        characters = { model: model!, clips, guns };
        return characters;
      },
      (err) => { console.warn('character assets failed to load', err); return null; },
    );
  }
  return charactersPending;
}

/**
 * Load what the first round needs (starting pistols, knife, the soldier). Everything else
 * streams in afterwards in the background. Never rejects: a missing file only costs its model.
 */
export async function preloadAssets(onProgress?: (fraction: number) => void): Promise<void> {
  const first = ['kite', 'tern', 'edge'];
  let done = 0;
  const total = first.length + 1;
  await Promise.all([
    ...first.map((id) => loadWeapon(id).then(() => onProgress?.(++done / total))),
    loadCharacters().then(() => onProgress?.(++done / total)),
  ]);
  for (const id of Object.keys(WEAPON_LOOK)) void loadWeapon(id);
}
