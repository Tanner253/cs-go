// Movements of the whole gun and both hands that the arm packs' own clips do not have.
//
// The packs animate the hands on a gun that stays low in the view, so a magazine change
// happens under the bottom edge of the screen, and they have one inspection between them.
// A movement here carries the gun where the eye can follow it (turned on its side to show the
// magazine well, across the body to be looked at) while the pack's clip, or the code in
// viewmodel.ts, moves the hands. Each also says when something is heard and felt, so the
// sounds of a reload come from the same timeline as the picture.

/**
 * Where the gun is carried, relative to its hold: metres right, up and back; radians pitched
 * up, turned left and canted (negative: its left side rolled up towards the eye), all about the
 * hand on the grip; and how far the left hand has let go of it (0..1).
 */
export type Carry = readonly [x: number, y: number, z: number, pitch: number, yaw: number, roll: number, off: number];

/** What a movement sounds like at one of its moments. */
export type Foley =
  | 'cloth' | 'magout' | 'magin' | 'boltback' | 'boltfwd' | 'tap' | 'shell' | 'open' | 'close' | 'pump' | 'catch';

export interface Move {
  /** Seconds it lasts, where the game does not set that itself (a reload lasts as long as the weapon's reload). */
  seconds?: number;
  /** Poses at moments 0..1; the gun eases from each to the next. */
  keys: readonly (readonly [at: number, pose: Carry])[];
  /** Moments something is heard, and how hard the gun jolts with it. */
  cues: readonly (readonly [at: number, sound: Foley, jolt: number])[];
}

const REST: Carry = [0, 0, 0, 0, 0, 0, 0];
const plus = (a: Carry, b: Partial<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, number>>): Carry =>
  a.map((v, i) => v + (b[i as 0] ?? 0)) as unknown as Carry;

/** The pose `k` of the way through a movement, eased between its keys. */
export function carryAt(m: Move, k: number, out: number[]): void {
  const keys = m.keys;
  let i = 0;
  while (i < keys.length - 2 && k > keys[i + 1]![0]) i++;
  const a = keys[i]!, b = keys[i + 1] ?? a;
  const span = b[0] - a[0];
  let u = span > 0 ? (k - a[0]) / span : 1;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const e = u * u * (3 - 2 * u);
  for (let j = 0; j < 7; j++) out[j] = a[1][j]! + (b[1][j]! - a[1][j]!) * e;
}

// ---- reloads -----------------------------------------------------------------------------

/** A rifle shown for its magazine change: lifted, muzzle up, its left side rolled up so the well faces the eye. */
const SHOW: Carry = [-0.09, 0.055, -0.095, 0.22, 0.06, -0.4, 0];
/** And as its action is worked by the left hand, reaching under it. */
const WORK: Carry = [-0.07, 0.03, -0.065, 0.15, 0.1, -0.3, 0];

/** How far through a rifle's reload the pack's magazine-change clip has finished, and when the left hand works the action. */
export const RIFLE_CLIP_ENDS = 0.62;
export const RIFLE_RACK: readonly [from: number, to: number] = [0.63, 0.93];

/** A self-loading rifle: magazine out and in (the pack's clip), then the action worked by the left hand. */
export const RIFLE_RELOAD: Move = {
  keys: [
    [0, REST], [0.11, SHOW],
    [0.185, plus(SHOW, { 1: -0.014, 3: -0.05, 5: -0.03 })], [0.26, SHOW],
    [0.385, SHOW], [0.42, plus(SHOW, { 1: 0.012, 3: 0.045, 5: 0.03 })], [0.49, SHOW],
    [0.63, WORK], [0.9, WORK], [1, REST],
  ],
  cues: [[0.03, 'cloth', 0], [0.185, 'magout', 0.35], [0.41, 'magin', 0.7], [0.765, 'boltback', 0.45], [0.812, 'boltfwd', 0.9]],
};

/** A rifle whose action is only tapped shut (a bolt release on its left side). */
export const RIFLE_RELOAD_TAP: Move = {
  keys: RIFLE_RELOAD.keys,
  cues: [[0.03, 'cloth', 0], [0.185, 'magout', 0.35], [0.41, 'magin', 0.7], [0.78, 'tap', 0.5], [0.8, 'boltfwd', 0.8]],
};

/** The bolt-action: the magazine change shown, then put back for the pack's own bolt stroke. */
export const BOLT_RELOAD: Move = {
  keys: [[0, REST], [0.07, SHOW], [0.165, plus(SHOW, { 1: -0.014, 3: -0.05 })], [0.23, SHOW], [0.35, SHOW], [0.38, plus(SHOW, { 1: 0.012, 3: 0.045 })], [0.44, SHOW], [0.55, REST], [1, REST]],
  cues: [[0.03, 'cloth', 0], [0.165, 'magout', 0.35], [0.37, 'magin', 0.7], [0.7, 'boltback', 0.3], [0.86, 'boltfwd', 0.6]],
};

/** A pistol: the pack's clip carries the gun itself; only the sounds and jolts are added. */
export const PISTOL_RELOAD: Move = {
  keys: [[0, REST], [1, REST]],
  cues: [[0.02, 'cloth', 0], [0.14, 'magout', 0.3], [0.52, 'magin', 0.6]],
};
/** The same from empty: the slide is let go at the end. */
export const PISTOL_RELOAD_EMPTY: Move = {
  keys: [[0, REST], [1, REST]],
  cues: [[0.02, 'cloth', 0], [0.12, 'magout', 0.3], [0.38, 'magin', 0.6], [0.62, 'boltback', 0.3], [0.76, 'boltfwd', 0.7]],
};

/** How many shells are seen going into a tube-fed shotgun, the part of the reload that takes, and when it is pumped. */
export const PUMP_SHELLS = 4;
export const PUMP_LOADING = 0.8;
/** A pump shotgun rolled over to show its loading port, fed shell by shell, then pumped. */
const FEED: Carry = [-0.05, 0.0, -0.13, 0.22, 0.3, -1.0, 0];
export const PUMP_RELOAD: Move = {
  keys: [[0, REST], [0.09, FEED], [0.76, FEED], [0.85, plus(REST, { 1: 0.01, 3: 0.04 })], [1, REST]],
  cues: [
    [0.03, 'cloth', 0],
    ...Array.from({ length: PUMP_SHELLS }, (_, i) => [((i + 0.66) / PUMP_SHELLS) * PUMP_LOADING, 'shell', 0.4] as const),
    [0.885, 'pump', 0.6], [0.94, 'boltfwd', 0.8],
  ],
};

/** A break-action turned across the body, side on, so the breech is seen to open; both shells changed, snapped shut. */
const BROKEN: Carry = [-0.02, 0.07, -0.2, 0, 0.85, -0.05, 0];
export const BREAK_RELOAD: Move = {
  keys: [[0, REST], [0.12, BROKEN], [0.8, BROKEN], [0.9, plus(REST, { 3: 0.08 })], [1, REST]],
  cues: [[0.03, 'cloth', 0], [0.13, 'open', 0.5], [0.4, 'shell', 0.3], [0.6, 'shell', 0.3], [0.845, 'close', 0.9]],
};

// ---- looking the gun over ------------------------------------------------------------------

/** A long gun: across the body to show its left side, then tipped up and rolled the other way to show the right. */
const LEFT_SIDE: Carry = [0.09, 0.06, -0.2, 0.12, 0.98, 0.2, 0];
const RIGHT_SIDE: Carry = [-0.1, 0.06, 0.02, 0.5, -0.42, 0.62, 1];
export const INSPECT_RIFLE: Move = {
  seconds: 3.6,
  keys: [
    [0, REST], [0.15, LEFT_SIDE], [0.27, plus(LEFT_SIDE, { 3: 0.05, 4: 0.07 })], [0.4, plus(LEFT_SIDE, { 3: -0.03, 4: -0.04, 6: 0.4 })],
    [0.56, RIGHT_SIDE], [0.7, plus(RIGHT_SIDE, { 3: 0.06, 5: 0.1 })], [0.82, plus(RIGHT_SIDE, { 5: -0.06, 6: -0.3 })], [1, REST],
  ],
  cues: [[0.03, 'cloth', 0], [0.46, 'cloth', 0], [0.88, 'catch', 0.3]],
};

/** A handgun or a small automatic, turned in the right hand alone. */
const PISTOL_LEFT: Carry = [0.1, 0.05, -0.26, 0.1, 1.02, 0.12, 1];
const PISTOL_RIGHT: Carry = [-0.07, 0.06, 0.0, 0.62, -0.5, 0.5, 1];
export const INSPECT_PISTOL: Move = {
  seconds: 3.1,
  keys: [
    [0, REST], [0.16, PISTOL_LEFT], [0.28, plus(PISTOL_LEFT, { 3: 0.06, 4: 0.08 })], [0.4, PISTOL_LEFT],
    [0.56, PISTOL_RIGHT], [0.68, plus(PISTOL_RIGHT, { 3: 0.07, 5: 0.12 })], [0.8, PISTOL_RIGHT], [1, REST],
  ],
  cues: [[0.03, 'cloth', 0], [0.46, 'cloth', 0], [0.9, 'catch', 0.2]],
};

/** The knife, turned over to show both flats of the blade. */
const FLAT: Carry = [-0.04, 0.05, 0.03, 0.2, 0.5, -0.9, 1];
const OTHER_FLAT: Carry = [-0.02, 0.06, 0.03, 0.3, -0.35, 0.8, 1];
export const INSPECT_KNIFE: Move = {
  seconds: 2.6,
  keys: [[0, REST], [0.2, FLAT], [0.38, plus(FLAT, { 5: -0.12 })], [0.58, OTHER_FLAT], [0.78, plus(OTHER_FLAT, { 5: 0.12 })], [1, REST]],
  cues: [[0.04, 'cloth', 0], [0.5, 'cloth', 0]],
};
