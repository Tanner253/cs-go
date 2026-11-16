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
  /** Weapon slot to switch to this tick, or -1. */
  slot: number;
  /** Item id to buy this tick, or ''. */
  buy: string;
}

export const emptyCmd = (): Cmd => ({ fwd: 0, side: 0, yaw: 0, pitch: 0, buttons: 0, slot: -1, buy: '' });

export interface WeaponState {
  def: WeaponDef;
  mag: number;
  reserve: number;
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

  weapons: [WeaponState | null, WeaponState | null, WeaponState | null];
  active: number;
  lastActive: number;
  drawTimer: number;
  reloadTimer: number;
  nextFireAt: number;
  lastShotAt: number;
  recoilIdx: number;
  punchPitch: number;
  punchYaw: number;
  fireSpread: number;
  scope: 0 | 1 | 2;
  /** Progress (seconds) of planting or disarming. */
  useTime: number;
  prevButtons: number;
  /** Who last damaged this player and how recently (for assists / kill credit). */
  spawnIndex: number;
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
  | { type: 'shot'; player: number; weapon: string; ox: number; oy: number; oz: number; ends: number[]; hitKinds: number[] }
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
  | { type: 'buy'; player: number; item: string; ok: boolean }
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
