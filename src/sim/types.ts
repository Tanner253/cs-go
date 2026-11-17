import type { Vec3 } from './math';
import type { WeaponDef } from './weapons';

export const TICK_RATE = 64;
export const TICK = 1 / TICK_RATE;

export const ATK = 0;
export const DEF = 1;
export type Team = 0 | 1;

// Button bitmask carried in every input command.
export const BTN_FIRE = 1;
export const BTN_ALT = 2;
export const BTN_JUMP = 4;
export const BTN_CROUCH = 8;
export const BTN_WALK = 16;
export const BTN_RELOAD = 32;
export const BTN_USE = 64;
export const BTN_GRAPPLE = 128;

/** One tick of player intent. This is the only thing a client would send to a server. */
export interface Cmd {
  fwd: number; // -1..1
  side: number; // -1..1 (right is positive)
  yaw: number;
  pitch: number;
  buttons: number;
  /**
   * Weapon slot to switch to this tick (0..3; 3 is the grenades, and asking for it again goes
   * on to the next kind carried), SLOT_LAST, SLOT_NADE + a grenade's index, or -1.
   */
  slot: number;
  /** Item id to buy this tick, or ''. */
  buy: string;
  /** Client sequence number (0 offline). Also seeds weapon spread so client and server agree. */
  seq: number;
  /** Ticks of lag compensation to apply to this command's shots (set by the server). */
  lag: number;
}

/** `Cmd.slot`: back to the weapon held before this one. */
export const SLOT_LAST = 8;
/** `Cmd.slot`: SLOT_NADE + i takes out grenade NADES[i]. */
export const SLOT_NADE = 16;
/** Weapon slots: primary, secondary, melee, grenade. */
export const SLOTS = 4;

export const emptyCmd = (): Cmd => ({ fwd: 0, side: 0, yaw: 0, pitch: 0, buttons: 0, slot: -1, buy: '', seq: 0, lag: 0 });

export interface WeaponState {
  def: WeaponDef;
  mag: number;
  reserve: number;
  /** A suppressor is on the muzzle. */
  quiet: boolean;
}

export const HULL_HALF = 0.4;
export const HEIGHT_STAND = 1.83;
export const HEIGHT_CROUCH = 1.37;
export const EYE_STAND = 1.63;
export const EYE_CROUCH = 1.17;

export interface Player {
  id: number;
  name: string;
  team: Team;
  isBot: boolean;

  alive: boolean;
  hp: number;
  armor: number;
  helmet: boolean;
  kit: boolean;
  money: number;
  kills: number;
  deaths: number;
  hasCharge: boolean;

  pos: Vec3; // feet
  prevPos: Vec3; // previous tick, for render interpolation
  vel: Vec3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  ducked: boolean;
  /** 0 standing .. 1 fully crouched (smoothed eye height). */
  crouchT: number;
  prevCrouchT: number;
  stepDist: number;
  fallSpeed: number;
  /** Spent by jumping and landing (0..STAMINA_MAX); while any is spent the player is slowed. */
  stamina: number;
  /** Run speed left after being shot (1 = untouched), growing back over a second or so. */
  tag: number;
  /** How fast crouching and standing go (crouchT per second): spent by spamming crouch. */
  duckSpeed: number;
  /** Wall-jumps used since last touching the ground, and the last wall normal used. */
  wallJumps: number;
  lastWallNx: number;
  lastWallNz: number;

  /** Mantle (ledge climb) in progress. */
  mantleT: number; // <0 = not mantling, else 0..1
  mantleFrom: Vec3;
  mantleTo: Vec3;

  /** Grapple hook. */
  grappleOn: boolean;
  grapplePoint: Vec3;
  grappleTime: number;
  grappleReadyAt: number;

  /** Slot 3 is the grenade picked out of `nades` (its `mag` is how many of that kind). */
  weapons: [WeaponState | null, WeaponState | null, WeaponState | null, WeaponState | null];
  /** Grenades carried, per kind, in NADES order. */
  nades: number[];
  /** Index in NADES of the grenade in slot 3. */
  nadeSel: number;
  /** When the pin was pulled (sim time), or -1. */
  pinAt: number;
  /** How hard the grenade will be thrown: 1 overarm, 0.5 both buttons, 0 underarm lob. */
  throwStr: number;
  /** When the last grenade left the hand (sim time), or -1 once the throw is over. */
  throwAt: number;
  /** Blinded by a flashbang until this sim time, from a blindness this many seconds long. */
  flashEnd: number;
  flashLen: number;
  active: number;
  lastActive: number;
  drawTimer: number;
  reloadTimer: number;
  /** Seconds left of fitting or taking off the suppressor (0 = not). */
  fitTimer: number;
  nextFireAt: number;
  lastShotAt: number;
  recoilIdx: number;
  punchPitch: number;
  punchYaw: number;
  fireSpread: number;
  scope: 0 | 1 | 2;
  /** Sniper: zoom level to return to once the bolt has cycled (0 = none). */
  rescope: 0 | 1 | 2;
  /** Semi-auto weapons: a click slightly before the gun is ready still fires (sim time). */
  fireBuffer: number;
  /** Progress (seconds) of planting or disarming. */
  useTime: number;
  prevButtons: number;
  /** Who last damaged this player and how recently (for assists / kill credit). */
  spawnIndex: number;
}

/** A grenade in the world: flying, at rest, or (smoke, fire) burning. */
export interface Grenade {
  id: number;
  /** Index in NADES. */
  kind: number;
  owner: number;
  team: Team;
  pos: Vec3;
  vel: Vec3;
  /** Sim time thrown. */
  born: number;
  /** 0 flying, 1 at rest, 2 smoke or fire going, 3 spent (removed next tick). */
  state: 0 | 1 | 2 | 3;
  /** Smoke / fire: sim time it went off and the time it is gone. */
  popAt: number;
  endAt: number;
}

export interface Charge {
  state: 'carried' | 'dropped' | 'planted' | 'disarmed' | 'detonated';
  carrier: number;
  pos: Vec3;
  /** Seconds until detonation once planted. */
  timer: number;
  site: number;
}

export type Phase = 'freeze' | 'live' | 'planted' | 'end' | 'over';

export type WinReason = 'elimination' | 'time' | 'detonation' | 'disarm';

export type SimEvent =
  | { type: 'shot'; player: number; weapon: string; ox: number; oy: number; oz: number; ends: number[]; hitKinds: number[]; quiet?: boolean }
  | { type: 'hit'; victim: number; attacker: number; damage: number; head: boolean; x: number; y: number; z: number }
  | { type: 'kill'; victim: number; killer: number; weapon: string; head: boolean; wallbang: boolean }
  | { type: 'step'; player: number; x: number; y: number; z: number }
  | { type: 'jump'; player: number }
  | { type: 'land'; player: number; speed: number }
  | { type: 'walljump'; player: number }
  | { type: 'mantle'; player: number }
  | { type: 'grapple'; player: number; x: number; y: number; z: number; ok: boolean }
  | { type: 'grappleEnd'; player: number }
  | { type: 'reload'; player: number; weapon: string }
  | { type: 'dry'; player: number }
  | { type: 'draw'; player: number; weapon: string }
  | { type: 'scope'; player: number; level: number }
  | { type: 'fit'; player: number; weapon: string; on: boolean }
  | { type: 'buy'; player: number; item: string; ok: boolean }
  | { type: 'pin'; player: number; weapon: string }
  | { type: 'throw'; player: number; weapon: string; strength: number }
  | { type: 'bounce'; id: number; x: number; y: number; z: number; speed: number }
  /** A grenade going off: kind 'out' is a fire put out (or landing in smoke). */
  | { type: 'boom'; id: number; kind: 'he' | 'flash' | 'smoke' | 'fire' | 'out'; x: number; y: number; z: number }
  | { type: 'flashed'; player: number; by: number; seconds: number }
  | { type: 'knife'; player: number; hit: boolean }
  | { type: 'planted'; player: number; site: number; x: number; y: number; z: number }
  | { type: 'disarmed'; player: number }
  | { type: 'detonated'; x: number; y: number; z: number }
  | { type: 'chargeDrop'; x: number; y: number; z: number }
  | { type: 'chargePickup'; player: number }
  | { type: 'roundStart'; round: number }
  | { type: 'roundLive' }
  | { type: 'roundEnd'; winner: Team; reason: WinReason }
  | { type: 'halftime' }
  | { type: 'matchEnd'; winner: -1 | Team };

/** hitKinds for a shot's end points. */
export const HIT_NONE = 0;
export const HIT_WORLD = 1;
export const HIT_PLAYER = 2;
