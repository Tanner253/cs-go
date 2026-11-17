// The paint each weapon wears (see finish.ts for how a skin is drawn).
//
// Attackers' guns burn: black and ember, orange light. Defenders' are cold: navy, ice and
// cyan. The weapons both sides can buy pick up the violet and magenta of the city's signs.

import type { Skin } from './finish';

/** The suit on the player's own arms: a dark weave with a thread of their side's colour. */
export const SUIT: Skin = {
  name: 'Suit', pattern: 'carbon', scale: 120,
  a: 0x252a32, b: 0x14171c, accent: 0x14171c, glow: 0xffffff, glowStrength: 1, metal: 0, rough: 0.8,
};
/** The colour of each side's thread (attackers, defenders) and how strongly it is lit. */
export const SIDE_GLOW = [0xff7a2e, 0x35e0ff];
export const SUIT_GLOW = 0.42;

export const SKINS: Record<string, Skin> = {
  // ---- attackers ----
  kite: {
    name: 'Cinder', pattern: 'hex', scale: 62,
    a: 0x17181c, b: 0x6a2410, accent: 0x24262c, glow: 0xff6a1f, glowStrength: 2.6,
  },
  wasp: {
    name: 'Hazard', pattern: 'chevron', scale: 26,
    a: 0x131417, b: 0x4f3c00, accent: 0x26272b, glow: 0xffa000, glowStrength: 2.2, metal: 0.3, rough: 0.6,
  },
  hammerhead: {
    name: 'Magma', pattern: 'tiger', scale: 34,
    a: 0x141315, b: 0x7a1a0a, accent: 0x2a1c18, glow: 0xff4a14, glowStrength: 2.8,
  },
  vipers: {
    name: 'Brimstone', pattern: 'tiger', scale: 22,
    a: 0x151316, b: 0x5c1408, accent: 0x2a1a16, glow: 0xff5a1a, glowStrength: 2.4, metal: 0.35, rough: 0.55,
  },
  mako: {
    name: 'Rust Reef', pattern: 'digital', scale: 80,
    a: 0x17181b, b: 0x7a3b10, accent: 0x2a2017, glow: 0xff8a1f, glowStrength: 2.6,
  },
  // ---- defenders ----
  tern: {
    name: 'Glacier', pattern: 'digital', scale: 95,
    a: 0x8a95a3, b: 0x33445a, accent: 0x18222f, glow: 0x35e0ff, glowStrength: 3.0, metal: 0.5,
  },
  wrens: {
    name: 'Frostbite', pattern: 'hex', scale: 40,
    a: 0x7d8a99, b: 0x24364d, accent: 0x162030, glow: 0x35e0ff, glowStrength: 2.6, metal: 0.45,
  },
  hornet: {
    name: 'Gridline', pattern: 'circuit', scale: 70,
    a: 0x0f1a2a, b: 0x1d3a5e, accent: 0x15233a, glow: 0x35e0ff, glowStrength: 2.6,
  },
  lumen: {
    name: 'Aurora', pattern: 'hex', scale: 56,
    a: 0x10151d, b: 0x1f3a6c, accent: 0x161c27, glow: 0x35e0ff, glow2: 0xb04aff, glowStrength: 2.1,
  },
  osprey: {
    name: 'Halo', pattern: 'carbon', scale: 140,
    a: 0x7f8a98, b: 0x505e70, accent: 0x18222f, glow: 0x35e0ff, glowStrength: 2.6, metal: 0.45,
  },
  // ---- both sides ----
  stinger: {
    name: 'Venom', pattern: 'tiger', scale: 60,
    a: 0x101512, b: 0x1c5a2a, accent: 0x18201a, glow: 0x5dff7a, glowStrength: 2.4,
  },
  thresher: {
    name: 'Brimstone', pattern: 'hex', scale: 48,
    a: 0x1a1613, b: 0x4d2210, accent: 0x241a14, glow: 0xff5a1f, glowStrength: 2.4, metal: 0.35, rough: 0.55,
  },
  colossus: {
    name: 'Monolith', pattern: 'hex', scale: 44,
    a: 0x0d0e11, b: 0x3b3342, accent: 0x17161c, glow: 0xffc83a, glow2: 0xff3df0, glowStrength: 2.4,
  },
  maul: {
    name: 'Regent', pattern: 'carbon', scale: 150,
    a: 0x767d8a, b: 0x444a56, accent: 0x1c1626, glow: 0xc050ff, glowStrength: 3.0, metal: 1, rough: 0.36,
  },
  breaker: {
    name: 'Riot', pattern: 'digital', scale: 70,
    a: 0x25282e, b: 0x6a6f78, accent: 0x1a1c20, glow: 0xff2e63, glowStrength: 3.0,
  },
  longsight: {
    name: 'Nightglass', pattern: 'carbon', scale: 120,
    a: 0x0a0e1a, b: 0x1b2a55, accent: 0x10131f, glow: 0xff3df0, glowStrength: 2.8,
  },
  edge: {
    name: 'Arc', pattern: 'circuit', scale: 120,
    a: 0x6f7a89, b: 0x3f4856, accent: 0x6f7a89, glow: 0x5fe9ff, glowStrength: 2.2, metal: 0.7, rough: 0.35,
  },
};
