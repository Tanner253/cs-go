// Player settings, persisted in localStorage.

export type QualitySetting = 'auto' | 'high' | 'medium' | 'low';
/** Shape of the play area. Anything but 'fill' adds black bars rather than stretching. */
export type AspectSetting = 'fill' | '21:9' | '16:9' | '16:10' | '4:3' | '5:4';

/** Everything a key can be bound to (the mouse buttons stay fire and alt-fire). */
export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'crouch' | 'walk'
  | 'reload' | 'use' | 'drop' | 'dropCharge' | 'inspect' | 'buy' | 'scoreboard'
  | 'primary' | 'secondary' | 'knife' | 'grenade' | 'last';

/** The actions in the order the controls list shows them, with what each is called there. */
export const ACTIONS: [Action, string][] = [
  ['forward', 'Forward'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'],
  ['jump', 'Jump'], ['crouch', 'Crouch'], ['walk', 'Walk (silent)'],
  ['reload', 'Reload'], ['use', 'Use: plant, disarm, pick up'], ['drop', 'Drop the gun in hand'], ['dropCharge', 'Drop the charge'],
  ['inspect', 'Inspect weapon'], ['buy', 'Armory'], ['scoreboard', 'Scoreboard'],
  ['primary', 'Main gun'], ['secondary', 'Sidearm'], ['knife', 'Knife'], ['grenade', 'Grenades (again: next kind)'], ['last', 'Last weapon'],
];

/** Each action's keys (KeyboardEvent.code), the first being the one shown. */
export type Binds = Record<Action, string[]>;

export const DEFAULT_BINDS: Binds = {
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  jump: ['Space'], crouch: ['ControlLeft', 'KeyC'], walk: ['ShiftLeft'],
  reload: ['KeyR'], use: ['KeyE'], drop: ['KeyG'], dropCharge: ['Digit5'], inspect: ['KeyF'], buy: ['KeyB'], scoreboard: ['Tab'],
  primary: ['Digit1'], secondary: ['Digit2'], knife: ['Digit3'], grenade: ['Digit4'], last: ['KeyQ'],
};

/** A key as a person would name it. */
export function keyName(code: string | undefined): string {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  const named: Record<string, string> = {
    Space: 'Space', ControlLeft: 'Ctrl', ControlRight: 'R-Ctrl', ShiftLeft: 'Shift', ShiftRight: 'R-Shift', AltLeft: 'Alt', AltRight: 'R-Alt',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', CapsLock: 'Caps', Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backslash: '\\', Comma: ',', Period: '.', Slash: '/', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace',
  };
  return named[code] ?? code;
}

export const ASPECTS: Record<AspectSetting, number> = { fill: 0, '21:9': 21 / 9, '16:9': 16 / 9, '16:10': 16 / 10, '4:3': 4 / 3, '5:4': 5 / 4 };

export interface Settings {
  name: string;
  sensitivity: number;
  /** Multiplier applied to sensitivity while scoped. */
  zoomSensitivity: number;
  invertY: boolean;
  /** Vertical field of view in degrees. */
  fov: number;
  volume: number;
  quality: QualitySetting;
  crosshairColor: string;
  crosshairSize: number;
  crosshairDot: boolean;
  /** Line thickness and the gap's own offset (px), outline, opacity, and whether it opens with movement and fire. */
  crosshairThickness: number;
  crosshairGap: number;
  crosshairOutline: boolean;
  crosshairAlpha: number;
  crosshairDynamic: boolean;
  /** Leave out the top line (a "T"). */
  crosshairT: boolean;
  binds: Binds;
  showFps: boolean;
  /** Go fullscreen in matches. Fullscreen lets the game capture Ctrl+W and similar browser shortcuts. */
  fullscreen: boolean;
  /** Play-area shape; on an ultrawide monitor 16:9 or 4:3 keeps the picture from spanning the whole screen. */
  aspect: AspectSetting;
  /** Rendered picture height in pixels (0 = native). Lower is faster; the picture is scaled up to the play area. */
  resolution: number;
}

const DEFAULTS: Settings = {
  name: '',
  sensitivity: 2,
  zoomSensitivity: 1,
  invertY: false,
  fov: 74,
  volume: 0.7,
  quality: 'auto',
  crosshairColor: '#3dff8a',
  crosshairSize: 8,
  crosshairDot: true,
  crosshairThickness: 2,
  crosshairGap: 0,
  crosshairOutline: true,
  crosshairAlpha: 1,
  crosshairDynamic: true,
  crosshairT: false,
  binds: DEFAULT_BINDS,
  showFps: true,
  fullscreen: true,
  aspect: 'fill',
  resolution: 0,
};

const KEY = 'np.settings.v1';
type Listener = (s: Settings) => void;
const listeners: Listener[] = [];

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    // (actions added since the binds were saved get their defaults)
    return { ...DEFAULTS, ...raw, binds: { ...DEFAULT_BINDS, ...(raw.binds ?? {}) } };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings: Settings = load();

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  settings[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode: keep in memory */
  }
  for (const l of listeners) l(settings);
}

export function onSettings(l: Listener): void {
  listeners.push(l);
  l(settings);
}

/** Put `code` on `action` alone, taking it off any other action it was on. */
export function bindKey(action: Action, code: string): void {
  const binds = { ...settings.binds };
  for (const a of Object.keys(binds) as Action[]) binds[a] = binds[a].filter((c) => c !== code);
  binds[action] = [code];
  setSetting('binds', binds);
}

export function resetSettings(): void {
  const name = settings.name;
  Object.assign(settings, DEFAULTS, { name });
  setSetting('name', name);
}
