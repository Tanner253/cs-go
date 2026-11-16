// The paint each weapon wears (see finish.ts for how a skin is drawn).
//
// Attackers' guns burn: black and ember, orange light. Defenders' are cold: navy, ice and
// cyan. The weapons both sides can buy pick up the violet and magenta of the city's signs.

import type { Skin } from './finish';

export const SKINS: Record<string, Skin> = {
  // ---- attackers ----
  kite: {
    name: 'Cinder', pattern: 'hex', scale: 62,
    a: 0x17181c, b: 0x6a2410, accent: 0x24262c, glow: 0xff6a1f, glowStrength: 2.6,
  },
  wasp: {
    name: 'Hazard', pattern: 'chevron', scale: 26,
    a: 0x131417, b: 0x6e5200, accent: 0x26272b, glow: 0xffa000, glowStrength: 0.8, metal: 0.45,
  },
  hammerhead: {
    name: 'Magma', pattern: 'tiger', scale: 34,
    a: 0x141315, b: 0x7a1a0a, accent: 0x2a1c18, glow: 0xff4a14, glowStrength: 2.8,
  },
  // ---- defenders ----
  tern: {
    name: 'Glacier', pattern: 'digital', scale: 95,
    a: 0xaeb9c6, b: 0x3d5068, accent: 0x18222f, glow: 0x35e0ff, glowStrength: 3.0, metal: 0.5,
  },
  hornet: {
    name: 'Gridline', pattern: 'circuit', scale: 70,
    a: 0x0f1a2a, b: 0x1d3a5e, accent: 0x15233a, glow: 0x35e0ff, glowStrength: 2.6,
  },
  lumen: {
    name: 'Aurora', pattern: 'hex', scale: 56,
    a: 0x10151d, b: 0x1f3a6c, accent: 0x161c27, glow: 0x35e0ff, glow2: 0xb04aff, glowStrength: 2.1,
  },
  // ---- both sides ----
  maul: {
    name: 'Regent', pattern: 'carbon', scale: 150,
    a: 0x8d94a1, b: 0x4f5562, accent: 0x1c1626, glow: 0xc050ff, glowStrength: 3.0, metal: 1, rough: 0.3,
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
    a: 0x6f7a89, b: 0x3f4856, accent: 0x6f7a89, glow: 0x5fe9ff, glowStrength: 1.1, metal: 0.7, rough: 0.35,
  },
};
