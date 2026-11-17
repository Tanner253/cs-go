// Weapon and character assets.
//
// A first-person weapon is an "arm pack" (arms + skeleton + one long animation) with a gun
// on it. There are three packs, all by one artist and all with the same arms: one holds a
// pistol, one a long gun, one a knife. Each carries its own gun; every other gun is a
// separate model hung piece by piece on named joints of a pack's skeleton, so one set of
// authored animations serves several weapons and the player's arms never change: sidearms
// and submachine guns (magazine in the grip) go in the pistol pack, rifles and the shotgun
// in the long-gun pack. The packs and models come from the ZONA project's asset pipeline;
// see CREDITS.md for their authors.

import * as THREE from 'three';
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
  /**
   * This pack is a skeleton and its animation only: the arms of this other pack, by the same
   * maker and on the same rig, are put onto its joints.
   */
  armsOf?: string;
  /** meshes of the pack's own gun, hidden when another gun is mounted in its place */
  ownGun?: string[];
  /** how much of the firing movement's travel is shown (it is drawn for a heavier kick than this game's) */
  fireTravel?: number;
  /** how much of the firing movement's turn is shown (its muzzle flip is a magnum's) */
  fireTurn?: number;
  /**
   * where this pack's left wrist sits against the middle of a suppressor the hand is holding
   * (the gun's own space: along the barrel, up, to the right; metres)
   */
  canGrip?: V3;
  /** the same against the handle of an action it is working, and against a loading port it is feeding */
  rackGrip?: V3;
  loadGrip?: V3;
}

/** A separate gun model mounted on a pack's joints. */
export interface GunMount {
  file: string;
  /** gun piece -> joint it rides on; pieces not listed ride with `base` */
  ride: Record<string, string>;
  /**
   * optional attachments stored in the file that are not fitted
   * (a `silencer` is left to the weapon: fitted and taken off in play where it takes one, see `suppressor` in weapons.ts)
   */
  hide?: string[];
  /** a second magazine shown in the hand during reloads: [joint it hangs on, joint it is placed by] */
  spare?: [string, string];
  /** a pair of guns, one in each hand: the joints the second one's pieces ride on */
  twin?: Record<string, string>;
  /** fine placement in the gun's own space */
  nudge?: V3;
  /** drawn at this fraction of its own size (hands sized for another gun) */
  size?: number;
  /**
   * a break-action: these pieces swing down about a hinge while the gun is reloaded
   * (`at` is the hinge in the gun's own space, `angle` how far they drop, radians)
   */
  hinge?: { pieces: string[]; at: V3; angle: number };
  /** a pump-action: this piece is drawn back `travel` metres and returned, by the left hand, after every shot */
  pump?: { piece: string; travel: number };
}

/** Which joint of the rifle pack and of the submachine-gun pack each piece of a gun rides on. */
const AK_JOINTS = { base: 'PBody_058', bolt: 'Rif_059', safety: 'Safety_061', trigger: 'Trigger_060', mag: 'Pmag_062' };
const SMG_JOINTS = { base: 'PBody_058', bolt: 'Rif_059', trigger: 'Trigger_060', mag: 'Pmag_061' };
/** The joints of the two-gun pack: the right hand's gun, and the left's. */
const TWIN_RIGHT = { base: 'base', bolt: 'bolt', trigger: 'trigger', mag: 'mag' };
const TWIN_LEFT = { base: 'base_2', bolt: 'bolt_2', trigger: 'trigger_2', mag: 'mag_2' };
/** Which joint of the pistol pack each piece of a mounted gun rides on. */
const PISTOL_JOINTS = { base: 'base', slide: 'slide', bolt: 'slide', mag: 'mag', hammer: 'hammer' };
/** The same for the long-gun pack (its magazine joint is called "clip"). */
const LONG_JOINTS = { base: 'base', mag: 'clip' };
// Every mounted gun is seated (`nudge`) so that its trigger is where the pack's own gun has
// its trigger: that is where the animation's trigger finger is, and the grip follows from it.
// (Measured from the models: the long-gun pack's trigger is at [-0.261, -0.009, -0.015] in gun
// space, the pistol pack's at [0.077, 0.031, 0.004].)

export const PACKS: Record<string, PackInfo> = {
  // The automatic weapons are held in the two packs that were animated for one: each has its
  // own draw, firing movement, reload, reload from empty and (the submachine gun) inspection.
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
  // The .50 rifle's own pack and the pack for a gun in each hand: skeletons and animation only,
  // by the maker of the pistol, sniper and knife packs, so the sniper pack's arms go on them.
  sniper50: {
    file: 'sniper50_fp.glb', fps: 30,
    clips: { fire: [0, 14], bolt: [16, 50], reload: [62, 118], inspect: [120, 164] },
    view: [-0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, -0.01, 0, 0, 0, 0, 1],
    hold: [0.14, -0.22, -0.36],
    frame: [0, 0, -0.01, 0, 0, 0.01, 0, 0, 0.01, 0, 0, 0, 0.1433733, -0.0110513, 0.0008269, 1],
    armsOf: 'sniper',
  },
  dual: {
    file: 'dualsmg_fp.glb', fps: 30,
    // (as the movement itself reads, joint by joint: both guns fire, are thrown up to drop their
    // magazines and taken down out of sight for new ones, are put away and brought out again, and
    // stand still; its last second is a blow with the right-hand gun, which is not used)
    clips: { fire: [0, 10], reload: [12, 54], draw: [64, 76], idle: [76, 102] },
    view: [-0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, -0.01, 0, 0, 0, 0, 1],
    hold: [0.0, -0.13, -0.4],
    frame: [0, 0, -0.01, 0, 0, 0.01, 0, 0, 0.01, 0, 0, 0, 0.0168823, -0.0022367, -0.1298198, 1],
    armsOf: 'sniper',
  },
  m9: {
    file: 'm9_fp.glb', fps: 30,
    // (its draw, frames 187-233, racks the slide on the way up: too much to fit in a half-second
    // draw, so pistols are raised by the spring layer instead)
    clips: { fire: [0, 11], reload: [12, 82], fireLast: [83, 94], reloadEmpty: [95, 175], holster: [176, 187], idle: [234, 264] },
    view: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1],
    hold: [0.1, -0.19, -0.09],
    // (as drawn, each shot brings the hand 10 cm back towards the eye)
    fireTravel: 0.65,
    fireTurn: 0.55,
    canGrip: [-0.06, -0.03, -0.01],
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
    canGrip: [-0.07, -0.045, -0.02],
    rackGrip: [-0.05, -0.07, 0],
    loadGrip: [-0.05, -0.07, 0],
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
  /** movements of the pack this weapon does not use */
  skip?: string[];
  /**
   * the reload ends by working the action: on the pack's own rifle with the pack's bolt movement,
   * on a mounted one by the left hand (see `rack` in viewmodel.ts)
   */
  rack?: boolean;
  /**
   * where the left hand works the action (the gun's own space), if not at the gun's own bolt,
   * and how far it draws it back (metres; 0 = a release that is only tapped)
   */
  rackAt?: V3;
  rackPull?: number;
  /** where shells are pushed into a tube magazine (the gun's own space) */
  loadAt?: V3;
  /** the pack's own movements are played as they were drawn (no carrying of the gun by moves.ts, no hand-worked action) */
  authored?: boolean;
  /**
   * where the left hand holds this gun, relative to where it holds the pack's own
   * (the gun's own space: x towards the muzzle, y up, z to the right; metres)
   */
  support?: V3;
  scale?: number;
  /** which model other players see this weapon as */
  world: string;
}

/** Submachine guns are held a little further out than a pistol, so they do not fill the view when raised to reload. */
const SMG_HOLD: V3 = [0.105, -0.195, -0.16];
/** Where a mounted long gun is held (closer in than the pack's own scoped rifle). */
const LONG_HOLD: V3 = [0.125, -0.195, -0.25];

/** How each weapon id is drawn in first person. */
export const WEAPON_LOOK: Record<string, WeaponLook> = {
  edge: { pack: 'knife', world: 'knife' },
  // ---- attackers ----
  kite: { pack: 'm9', world: 'm9' },
  // (automatic guns in the pistol pack leave out its firing movement: a pistol's muzzle flip, repeated
  // thirteen times a second, throws the gun about; the spring layer carries their recoil instead)
  wasp: { pack: 'smg', world: 'smg', mount: { file: 'smg.glb', ride: SMG_JOINTS, spare: ['Pmag_2_062', 'Pmag_061'] } },
  // (the long-gun pack's bolt-action cycle is not for a self-loading rifle, and its firing movement is a
  // single heavy shot's: repeated ten times a second it threw the rifle 5 cm a round. The spring layer
  // carries an automatic's recoil.)
  hammerhead: { pack: 'ak', world: 'ak', mount: { file: 'ak.glb', ride: AK_JOINTS, spare: ['Pmag2_063', 'Pmag_062'] } },
  // (seated so the top of its magazine is where the pack's own rifle has its magazine: the hands change it there)
  mako: { pack: 'ak', world: 'aks74u', mount: { file: 'aks74u.glb', ride: AK_JOINTS, nudge: [-0.21, -0.014, -0.002], spare: ['Pmag2_063', 'Pmag_062'] } },
  // ---- defenders ----
  tern: { pack: 'm9', world: 'colt', mount: { file: 'colt_1911.glb', ride: PISTOL_JOINTS, nudge: [0.01, 0, 0] } },
  hornet: {
    pack: 'smg', world: 'mp7', hold: [0.08, -0.23, -0.05],
    // (its optic's lens is painted as a solid orange disc: left off, the iron sights stay;
    // the stock is left off too: extended, its rails run past the camera)
    mount: { file: 'mp7a1.glb', ride: SMG_JOINTS, hide: ['foregrip', 'sight', 'stock'], spare: ['Pmag_2_062', 'Pmag_061'] },
  },
  lumen: {
    pack: 'ak', world: 'ar15',
    mount: { file: 'ar15_lod1.glb', ride: { base: AK_JOINTS.base, mag: AK_JOINTS.mag }, hide: ['foregrip', 'light', 'sight'], spare: ['Pmag2_063', 'Pmag_062'] },
  },
  osprey: { pack: 'ak', world: 'a91', mount: { file: 'a91.glb', ride: { base: AK_JOINTS.base, mag: AK_JOINTS.mag, trigger: AK_JOINTS.trigger }, hide: ['bullet'], spare: ['Pmag2_063', 'Pmag_062'] } },
  // ---- both sides ----
  // (the model is larger than life: drawn at seven tenths, here and in other players' hands)
  stinger: { pack: 'm9', world: 'scorpion', skip: ['fire'], mount: { file: 'scorpion.glb', ride: PISTOL_JOINTS, size: 0.7, nudge: [0.022, 0.022, 0.01] } },
  thresher: {
    // (no magazine to change: the pack's reload is left out and the gun is simply broken open)
    pack: 'sniper', world: 'db12', hold: LONG_HOLD, skip: ['bolt', 'reload'],
    mount: { file: 'db12.glb', ride: { base: 'base' }, nudge: [-0.33, 0.011, -0.01], hinge: { pieces: ['barrels', 'shells'], at: [0.2, -0.012, 0], angle: 0.55 } },
  },
  // (in the .50 rifle's own pack: its firing movement, reload, the working of its action and its inspection)
  colossus: {
    pack: 'sniper50', world: 'barrett', skip: ['bolt'], rack: true, authored: true,
    // (seated so its bolt handle and trigger are where the pack's own rifle has them)
    mount: { file: 'barrett.glb', ride: { base: 'base', mag: 'mag', bolt: 'bolt' }, nudge: [0.05, 0.01, 0.005] },
  },
  // A machine pistol in each hand.
  vipers: {
    pack: 'dual', world: 'dualmac', authored: true,
    mount: { file: 'dualmac.glb', ride: TWIN_RIGHT, twin: TWIN_LEFT, hide: ['silencer'], nudge: [-0.007, 0.011, 0] },
  },
  wrens: {
    pack: 'dual', world: 'dualsmg', authored: true,
    mount: { file: 'dualsmg.glb', ride: TWIN_RIGHT, twin: TWIN_LEFT },
  },
  maul: { pack: 'm9', world: 'deagle', mount: { file: 'desert_eagle.glb', ride: PISTOL_JOINTS, size: 0.94, nudge: [-0.012, 0.008, 0] } },
  breaker: {
    // (pumped by the left hand: the pack's bolt movement, a right hand leaving the grip for a bolt handle, is not a shotgun's)
    pack: 'sniper', world: 'benelli', hold: LONG_HOLD, skip: ['bolt'],
    // (its ghost-ring sight on a rail is left off; its suppressor is fitted in play)
    mount: { file: 'benelli_m3.glb', ride: { base: 'base' }, hide: ['sight'], nudge: [0.08, -0.012, 0], pump: { piece: 'forend', travel: 0.075 } },
    loadAt: [-0.27, 0.0, 0],
  },
  longsight: { pack: 'sniper', world: 'sniper', rack: true },
};

// ---- loading ----------------------------------------------------------------------------

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const base = `${import.meta.env.BASE_URL}assets/weapons/`;
const files = new Map<string, GLTF | null>();
const pending = new Map<string, Promise<GLTF | null>>();

/**
 * Changes made to a model as it loads: [piece, scale along the barrel, about this point on it].
 * (The double-barrel comes with long fowling barrels; they are cut down to a sawn-off.)
 */
const RESHAPE: Record<string, [piece: string, scale: number, about: number][]> = {
  'db12.glb': [['barrels', 0.46, 0.22]],
  'world/db12_lod1.glb': [['barrels', 0.46, 0.22]],
};

/** Models drawn at other than the size they came. */
const RESIZE: Record<string, number> = { 'world/scorpion_lod1.glb': 0.7 };

function reshape(name: string, g: GLTF): void {
  const size = RESIZE[name];
  if (size) g.scene.scale.multiplyScalar(size);
  for (const [piece, scale, about] of RESHAPE[name] ?? []) {
    g.scene.traverse((o) => {
      if (o.name.replace(/_\d+$/, '') !== piece) return;
      // (pieces sit directly in the gun's own space: x runs along the barrel)
      o.position.x = about + (o.position.x - about) * scale;
      o.scale.x *= scale;
      o.updateMatrix();
    });
  }
}

function loadFile(name: string): Promise<GLTF | null> {
  let p = pending.get(name);
  if (!p) {
    p = loader.loadAsync(base + name).then(
      (g) => { reshape(name, g); files.set(name, g); return g; },
      (err) => { console.warn(`weapon file "${name}" failed to load`, err); files.set(name, null); return null; },
    );
    pending.set(name, p);
  }
  return p;
}

export interface WeaponFiles {
  pack: GLTF;
  gun: GLTF | null;
  /** a pack whose arm textures are borrowed */
  arms: GLTF | null;
}

function filesFor(look: WeaponLook): string[] {
  const info = PACKS[look.pack]!;
  const out = [info.file];
  if (look.mount) out.push(look.mount.file);
  if (info.armsFrom) out.push(PACKS[info.armsFrom]!.file);
  if (info.armsOf) out.push(PACKS[info.armsOf]!.file);
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
    arms: files.get(PACKS[info.armsFrom ?? info.armsOf ?? '']?.file ?? '') ?? null,
  };
}

export function loadWeapon(id: string): Promise<unknown> {
  const look = WEAPON_LOOK[id];
  return look ? Promise.all(filesFor(look).map(loadFile)) : Promise.resolve();
}

// ---- third-person characters ---------------------------------------------------------

export type Carry = 'rifle' | 'smg' | 'pistol' | 'knife' | 'dual';

/** A weapon as other players see it: a low-poly model whose +x runs along the barrel. */
export interface WorldGun {
  scene: THREE.Object3D;
  carry: Carry;
  /**
   * where its trigger is (x along the barrel, y up, in the gun's own space): the hands are
   * placed from it and from the model's own shape
   */
  trigger: [number, number];
  /** held by the wrist of a stock rather than by a pistol grip */
  wrist?: boolean;
  /** how far ahead of the trigger the supporting hand holds it (default: by kind) */
  fore?: number;
  /** muzzle tip in the gun's own space */
  muzzle: V3;
  /** optics stored in the file that are not fitted (the guns are shot over their own sights) */
  hide?: string[];
  /** a blade: its long axis is +y rather than +x, and it is held at `grip` in one hand */
  blade?: boolean;
  grip?: V3;
}

export interface CharacterAssets {
  model: GLTF;
  clips: Map<string, THREE.AnimationClip>;
  guns: Map<string, WorldGun>;
}

// (Triggers measured from the models; where a model has no separate trigger piece, taken from
// where the gun was seated in the first-person hands.)
const WORLD_GUNS: Record<string, Omit<WorldGun, 'scene'> & { file: string }> = {
  ak: { file: 'world/ak_lod1.glb', carry: 'rifle', trigger: [-0.145, 0.024], muzzle: [0.455, 0.03, 0.01] },
  ar15: { file: 'ar15_lod1.glb', carry: 'rifle', trigger: [-0.127, 0.02], muzzle: [0.373, 0.03, 0.01], hide: ['sight'] },
  smg: { file: 'world/smg_lod1.glb', carry: 'smg', trigger: [0.059, 0.018], fore: 0.12, muzzle: [0.25, 0.03, 0] },
  // (one of the pair: the other hand's is a copy of it)
  dualmac: { file: 'world/dualmac_lod1.glb', carry: 'dual', trigger: [0.071, 0.011], muzzle: [0.21, 0.058, 0], hide: ['silencer'] },
  dualsmg: { file: 'world/dualsmg_lod1.glb', carry: 'dual', trigger: [0.064, 0.022], muzzle: [0.273, 0.07, 0] },
  mp7: { file: 'world/mp7a1_lod1.glb', carry: 'smg', trigger: [0.026, 0.046], fore: 0.2, muzzle: [0.466, 0.03, 0], hide: ['sight'] },
  m9: { file: 'world/m9_lod1.glb', carry: 'pistol', trigger: [0.077, 0.031], muzzle: [0.218, 0.06, 0] },
  colt: { file: 'world/colt_1911_lod1.glb', carry: 'pistol', trigger: [0.067, 0.031], muzzle: [0.181, 0.06, 0] },
  deagle: { file: 'world/desert_eagle_lod1.glb', carry: 'pistol', trigger: [0.095, 0.024], muzzle: [0.263, 0.06, 0] },
  sniper: { file: 'world/sniper_lod1.glb', carry: 'rifle', trigger: [-0.261, -0.009], wrist: true, muzzle: [0.726, 0.03, 0] },
  benelli: { file: 'world/benelli_m3_lod1.glb', carry: 'rifle', trigger: [-0.31, -0.005], fore: 0.34, muzzle: [0.83, 0.03, 0], hide: ['sight'] },
  // (drawn at seven tenths: these are the model's own figures, before that)
  scorpion: { file: 'world/scorpion_lod1.glb', carry: 'smg', trigger: [0.079, 0.013], fore: 0.14, muzzle: [0.396, 0.03, 0] },
  aks74u: { file: 'world/aks74u_lod1.glb', carry: 'rifle', trigger: [0.056, 0.029], muzzle: [0.473, 0.03, 0.01] },
  a91: { file: 'world/a91_lod1.glb', carry: 'rifle', trigger: [-0.099, 0.009], muzzle: [0.485, 0.03, 0.01] },
  barrett: { file: 'world/barrett_lod1.glb', carry: 'rifle', trigger: [0.026, -0.004], fore: 0.27, muzzle: [1.103, 0.03, 0] },
  // (measured off its outline: the wrist of its stock is at x = 0, its guard just ahead)
  db12: { file: 'world/db12_lod1.glb', carry: 'rifle', trigger: [0.07, -0.02], wrist: true, fore: 0.25, muzzle: [0.565, 0.08, 0] },
  knife: { file: 'world/knife_lod1.glb', carry: 'knife', trigger: [0, 0], grip: [0.0146, -0.004, 0.076], muzzle: [0, 0.24, 0], blade: true },
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
