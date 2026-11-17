// Keyboard/mouse (pointer lock, raw input) and touch, both reduced to the same per-tick Cmd.

import {
  BTN_ALT, BTN_CROUCH, BTN_FIRE, BTN_JUMP, BTN_RELOAD, BTN_USE, BTN_WALK, SLOT_LAST, type Cmd,
} from '../sim/types';
import { settings } from './settings';

/** `Cmd.slot` as the input leaves it, before the game turns it into a slot: the next and previous weapon. */
export const WHEEL_NEXT = 100;
export const WHEEL_PREV = 101;

const PITCH_LIMIT = Math.PI / 2 - 0.02;
/** Radians per mouse count at sensitivity 1 (0.022 degrees, the classic FPS scale). */
const M_YAW = 0.022 * (Math.PI / 180);
/**
 * A single mouse event larger than this is a browser glitch (pointer-lock warp), not a
 * real hand movement, and is dropped so the view never snaps.
 */
const MAX_COUNTS = 1800;

/** Phones and tablets: coarse primary pointer, or a touch screen on a mobile browser. */
export function isTouchDevice(): boolean {
  return matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent));
}

export class Input {
  yaw = 0;
  pitch = 0;
  /** FOV-based multiplier applied while scoped. */
  zoomScale = 1;
  locked = false;
  /** Testing aid (?nolock): accept mouse input without pointer lock. */
  fake = new URLSearchParams(location.search).has('nolock');
  readonly touch: boolean;

  /** Look movement since the renderer last consumed it (for viewmodel sway). */
  lookDX = 0;
  lookDY = 0;

  private keys = new Set<string>();
  private mouse = 0;
  private slot = -1;
  private buy = '';
  private jumpTap = false;

  private touchButtons = 0;
  private stickId = -1;
  private stickX = 0;
  private stickY = 0;
  private stickOX = 0;
  private stickOY = 0;
  private lookId = -1;
  private lookX = 0;
  private lookY = 0;
  private crouchToggle = false;
  private stickEl: HTMLElement | null = null;
  private knobEl: HTMLElement | null = null;

  onToggleBuy: () => void = () => {};
  onScoreboard: (show: boolean) => void = () => {};
  /** Pointer lock was lost (Esc, alt-tab). */
  onUnlock: () => void = () => {};
  onEscape: () => void = () => {};
  onInspect: () => void = () => {};
  onMenuKey: (digit: number) => boolean = () => false;
  onFirstGesture: () => void = () => {};

  constructor(private canvas: HTMLElement, private touchRoot: HTMLElement) {
    this.touch = isTouchDevice();

    document.addEventListener('keydown', (e) => this.key(e, true));
    document.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse = 0; });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.keys.clear(); this.mouse = 0; this.onUnlock(); }
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked && !(this.fake && e.buttons & 4)) return;
      const dx = e.movementX, dy = e.movementY;
      if (dx > MAX_COUNTS || dx < -MAX_COUNTS || dy > MAX_COUNTS || dy < -MAX_COUNTS) return;
      this.look(dx, dy, settings.sensitivity * M_YAW * this.zoomScale);
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.locked && !this.fake) return;
      if (e.button === 0) this.mouse |= BTN_FIRE;
      else if (e.button === 2) this.mouse |= BTN_ALT;
      e.preventDefault();
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse &= ~BTN_FIRE;
      else if (e.button === 2) this.mouse &= ~BTN_ALT;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      this.slot = e.deltaY > 0 ? WHEEL_NEXT : WHEEL_PREV;
      e.preventDefault();
    }, { passive: false });

    if (this.touch) this.buildTouch();
  }

  /**
   * Ask for pointer lock with raw (unaccelerated) mouse input where the browser supports
   * it: OS acceleration and its occasional jumps are what make fast spins feel wrong.
   */
  requestLock(): void {
    if (this.touch || this.locked || this.fake) return;
    const el = this.canvas as HTMLElement & { requestPointerLock(o?: { unadjustedMovement?: boolean }): Promise<void> | void };
    try {
      const p = el.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          const q = el.requestPointerLock();
          if (q && typeof q.catch === 'function') q.catch(() => {});
        });
      }
    } catch {
      /* not allowed right now (no user gesture): the next click will retry */
    }
  }
  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /**
   * Fullscreen with the Keyboard Lock API (Chromium): while it is active the page, not the
   * browser, receives Ctrl+W, Ctrl+T, Ctrl+N and friends, so crouching on Ctrl while
   * moving cannot close the tab. Must be called from a user gesture.
   */
  enterFullscreen(): void {
    if (this.touch || this.fake || !settings.fullscreen || document.fullscreenElement) return;
    const root = document.documentElement;
    const kb = (navigator as Navigator & { keyboard?: { lock(keys?: string[]): Promise<void> } }).keyboard;
    try {
      const p = root.requestFullscreen({ navigationUI: 'hide' });
      if (p && typeof p.then === 'function') p.then(() => kb?.lock?.().catch(() => {})).catch(() => {});
    } catch {
      /* fullscreen refused: the page-leave guard still protects the match */
    }
  }

  private look(dx: number, dy: number, scale: number): void {
    const ddx = dx * scale;
    const ddy = dy * scale * (settings.invertY ? -1 : 1);
    this.yaw -= ddx;
    // Keep yaw bounded so precision never degrades after many turns.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - ddy));
    this.lookDX += ddx;
    this.lookDY += ddy;
  }

  private key(e: KeyboardEvent, down: boolean): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const c = e.code;
    if (down && !e.repeat) {
      this.onFirstGesture();
      if (c.startsWith('Digit')) {
        const d = Number(c.slice(5));
        if (this.onMenuKey(d)) { e.preventDefault(); return; }
        // (4 is the grenades: again, the next kind carried)
        if (d >= 1 && d <= 4) this.slot = d - 1;
      } else if (c === 'KeyQ') this.slot = SLOT_LAST;
      else if (c === 'KeyB') this.onToggleBuy();
      else if (c === 'KeyF') this.onInspect();
      else if (c === 'Tab') this.onScoreboard(true);
      else if (c === 'Space') this.jumpTap = true;
      else if (c === 'Escape') this.onEscape();
    }
    if (!down && c === 'Tab') this.onScoreboard(false);
    if (down) this.keys.add(c);
    else this.keys.delete(c);
    // Stop the browser acting on game keys (scrolling, tab focus, quick find...).
    if (this.locked || c === 'Tab' || c === 'Space') e.preventDefault();
  }

  queueBuy(item: string): void {
    this.buy = item;
  }

  /** Fill in the command for this tick. One-shot requests are consumed. */
  build(cmd: Cmd, active: boolean): void {
    const k = this.keys;
    let fwd = 0, side = 0, buttons = 0;
    if (active) {
      if (k.has('KeyW') || k.has('ArrowUp')) fwd += 1;
      if (k.has('KeyS') || k.has('ArrowDown')) fwd -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) side += 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) side -= 1;
      buttons = this.mouse;
      if (k.has('Space') || this.jumpTap) buttons |= BTN_JUMP;
      if (k.has('ControlLeft') || k.has('KeyC')) buttons |= BTN_CROUCH;
      if (k.has('ShiftLeft')) buttons |= BTN_WALK;
      if (k.has('KeyR')) buttons |= BTN_RELOAD;
      if (k.has('KeyE')) buttons |= BTN_USE;
      if (this.touch) {
        fwd += -this.stickY;
        side += this.stickX;
        buttons |= this.touchButtons;
        if (this.crouchToggle) buttons |= BTN_CROUCH;
      }
    }
    this.jumpTap = false;
    cmd.fwd = Math.max(-1, Math.min(1, fwd));
    cmd.side = Math.max(-1, Math.min(1, side));
    cmd.buttons = buttons;
    cmd.yaw = this.yaw;
    cmd.pitch = this.pitch;
    cmd.slot = active ? this.slot : -1;
    cmd.buy = this.buy;
    cmd.seq = 0;
    cmd.lag = 0;
    this.slot = -1;
    this.buy = '';
  }

  // ---- touch controls ---------------------------------------------------------------

  private buildTouch(): void {
    const root = this.touchRoot;
    root.classList.add('on');
    root.innerHTML = `
      <div class="t-stick" id="t-stick"><div class="t-knob" id="t-knob"></div></div>
      <button class="t-btn t-fire" data-b="${BTN_FIRE}">FIRE</button>
      <button class="t-btn t-jump" data-b="${BTN_JUMP}">JUMP</button>
      <button class="t-btn t-crouch" data-t="crouch">DUCK</button>
      <button class="t-btn t-reload" data-b="${BTN_RELOAD}">RLD</button>
      <button class="t-btn t-use" data-b="${BTN_USE}">USE</button>
      <button class="t-btn t-alt" data-b="${BTN_ALT}">ZOOM</button>
      <button class="t-btn t-swap" data-t="swap">SWAP</button>
      <button class="t-btn t-buy" data-t="buy">BUY</button>
      <button class="t-btn t-menu" data-t="menu">II</button>`;
    this.stickEl = root.querySelector('#t-stick');
    this.knobEl = root.querySelector('#t-knob');
    const touchSens = () => settings.sensitivity * 0.0022 * this.zoomScale;

    const opts = { passive: false } as const;
    root.querySelectorAll<HTMLElement>('.t-btn').forEach((el) => {
      const bit = Number(el.dataset['b'] ?? 0);
      const tag = el.dataset['t'];
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onFirstGesture();
        el.setPointerCapture(e.pointerId);
        el.classList.add('down');
        if (bit) this.touchButtons |= bit;
        if (tag === 'crouch') { this.crouchToggle = !this.crouchToggle; el.classList.toggle('held', this.crouchToggle); }
        else if (tag === 'swap') this.slot = WHEEL_NEXT;
        else if (tag === 'buy') this.onToggleBuy();
        else if (tag === 'menu') this.onEscape();
        if (bit === BTN_FIRE) { this.lookX = e.clientX; this.lookY = e.clientY; }
      }, opts);
      el.addEventListener('pointermove', (e) => {
        if (bit !== BTN_FIRE || !(this.touchButtons & BTN_FIRE)) return;
        this.look(e.clientX - this.lookX, e.clientY - this.lookY, touchSens());
        this.lookX = e.clientX; this.lookY = e.clientY;
      }, opts);
      const up = (e: PointerEvent) => {
        e.preventDefault();
        el.classList.remove('down');
        if (bit) this.touchButtons &= ~bit;
      };
      el.addEventListener('pointerup', up, opts);
      el.addEventListener('pointercancel', up, opts);
    });

    // Left side: floating movement stick. Everywhere else: look.
    const surface = this.canvas;
    surface.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      e.preventDefault();
      this.onFirstGesture();
      if (e.clientX < innerWidth * 0.42 && this.stickId < 0) {
        this.stickId = e.pointerId;
        this.stickOX = e.clientX; this.stickOY = e.clientY;
        if (this.stickEl) {
          this.stickEl.style.left = `${e.clientX}px`;
          this.stickEl.style.top = `${e.clientY}px`;
          this.stickEl.classList.add('show');
        }
      } else if (this.lookId < 0) {
        this.lookId = e.pointerId;
        this.lookX = e.clientX; this.lookY = e.clientY;
      }
      surface.setPointerCapture(e.pointerId);
    }, opts);
    surface.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) {
        const R = 56;
        let dx = (e.clientX - this.stickOX) / R, dy = (e.clientY - this.stickOY) / R;
        const len = Math.hypot(dx, dy);
        if (len > 1) { dx /= len; dy /= len; }
        this.stickX = Math.abs(dx) < 0.12 ? 0 : dx;
        this.stickY = Math.abs(dy) < 0.12 ? 0 : dy;
        if (this.knobEl) this.knobEl.style.transform = `translate(${dx * R}px, ${dy * R}px)`;
      } else if (e.pointerId === this.lookId) {
        this.look(e.clientX - this.lookX, e.clientY - this.lookY, touchSens());
        this.lookX = e.clientX; this.lookY = e.clientY;
      }
    }, opts);
    const end = (e: PointerEvent) => {
      if (e.pointerId === this.stickId) {
        this.stickId = -1;
        this.stickX = this.stickY = 0;
        this.stickEl?.classList.remove('show');
        if (this.knobEl) this.knobEl.style.transform = '';
      } else if (e.pointerId === this.lookId) {
        this.lookId = -1;
      }
    };
    surface.addEventListener('pointerup', end, opts);
    surface.addEventListener('pointercancel', end, opts);
  }
}
