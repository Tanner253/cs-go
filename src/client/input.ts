// Keyboard/mouse (pointer lock) and touch input, both reduced to the same per-tick Cmd.

import {
  BTN_ALT, BTN_CROUCH, BTN_FIRE, BTN_GRAPPLE, BTN_JUMP, BTN_RELOAD, BTN_USE, BTN_WALK, type Cmd,
} from '../sim/types';

/** Phones and tablets: coarse primary pointer, or a touch screen on a mobile browser. */
export function isTouchDevice(): boolean {
  return matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent));
}

const PITCH_LIMIT = Math.PI / 2 - 0.02;
/** Radians per mouse count at sensitivity 1 (0.022 degrees, the classic FPS scale). */
const M_YAW = 0.022 * (Math.PI / 180);

export class Input {
  yaw = 0;
  pitch = 0;
  sensitivity: number;
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

  // Touch state.
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
  onPause: () => void = () => {};
  onMenuKey: (digit: number) => boolean = () => false;
  onFirstGesture: () => void = () => {};

  constructor(private canvas: HTMLElement, private touchRoot: HTMLElement) {
    this.touch = isTouchDevice();
    const saved = Number(localStorage.getItem('np.sens'));
    this.sensitivity = saved > 0 ? saved : 2.0;

    document.addEventListener('keydown', (e) => this.key(e, true));
    document.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse = 0; });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.keys.clear(); this.mouse = 0; this.onPause(); }
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked && !(this.fake && e.buttons & 4)) return;
      this.look(e.movementX, e.movementY, this.sensitivity * M_YAW * this.zoomScale);
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.locked && !this.fake) return;
      if (e.button === 0) this.mouse |= BTN_FIRE;
      else if (e.button === 2) this.mouse |= BTN_ALT;
      else if (e.button === 1 || e.button === 3) this.mouse |= BTN_GRAPPLE;
      e.preventDefault();
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse &= ~BTN_FIRE;
      else if (e.button === 2) this.mouse &= ~BTN_ALT;
      else if (e.button === 1 || e.button === 3) this.mouse &= ~BTN_GRAPPLE;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      this.slot = e.deltaY > 0 ? 4 : 5; // next / previous
      e.preventDefault();
    }, { passive: false });

    if (this.touch) this.buildTouch();
  }

  setSensitivity(v: number): void {
    this.sensitivity = v;
    localStorage.setItem('np.sens', String(v));
  }

  requestLock(): void {
    if (this.touch || this.locked || this.fake) return;
    const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private look(dx: number, dy: number, scale: number): void {
    const ddx = dx * scale, ddy = dy * scale;
    this.yaw -= ddx;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - ddy));
    this.lookDX += ddx;
    this.lookDY += ddy;
  }

  private key(e: KeyboardEvent, down: boolean): void {
    if (e.target instanceof HTMLInputElement) return;
    const c = e.code;
    if (down && !e.repeat) {
      this.onFirstGesture();
      if (c.startsWith('Digit')) {
        const d = Number(c.slice(5));
        if (this.onMenuKey(d)) { e.preventDefault(); return; }
        if (d >= 1 && d <= 3) this.slot = d - 1;
      } else if (c === 'KeyQ') this.slot = 3;
      else if (c === 'KeyB') this.onToggleBuy();
      else if (c === 'Tab') this.onScoreboard(true);
      else if (c === 'Space') this.jumpTap = true;
    }
    if (!down && c === 'Tab') this.onScoreboard(false);
    if (down) this.keys.add(c);
    else this.keys.delete(c);
    // Stop the browser acting on game keys (scrolling, tab focus, quick find...).
    if (this.locked || c === 'Tab' || c === 'Space') e.preventDefault();
  }

  /** Request a purchase on the next tick. */
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
      if (k.has('KeyF')) buttons |= BTN_GRAPPLE;
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
      <button class="t-btn t-grap" data-b="${BTN_GRAPPLE}">HOOK</button>
      <button class="t-btn t-crouch" data-t="crouch">DUCK</button>
      <button class="t-btn t-reload" data-b="${BTN_RELOAD}">RLD</button>
      <button class="t-btn t-use" data-b="${BTN_USE}">USE</button>
      <button class="t-btn t-alt" data-b="${BTN_ALT}">ZOOM</button>
      <button class="t-btn t-swap" data-t="swap">SWAP</button>
      <button class="t-btn t-buy" data-t="buy">BUY</button>`;
    this.stickEl = root.querySelector('#t-stick');
    this.knobEl = root.querySelector('#t-knob');

    const opts = { passive: false } as const;
    // Buttons: hold-to-press, and dragging on FIRE still aims.
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
        else if (tag === 'swap') this.slot = 4;
        else if (tag === 'buy') this.onToggleBuy();
        if (bit === BTN_FIRE) { this.lookX = e.clientX; this.lookY = e.clientY; }
      }, opts);
      el.addEventListener('pointermove', (e) => {
        if (bit !== BTN_FIRE || !(this.touchButtons & BTN_FIRE)) return;
        this.look(e.clientX - this.lookX, e.clientY - this.lookY, this.sensitivity * 0.0022 * this.zoomScale);
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

    // Left half: floating movement stick. Right half: look.
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
        this.look(e.clientX - this.lookX, e.clientY - this.lookY, this.sensitivity * 0.0022 * this.zoomScale);
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
