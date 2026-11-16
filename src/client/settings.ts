// Player settings, persisted in localStorage.

export type QualitySetting = 'auto' | 'high' | 'medium' | 'low';

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
  showFps: boolean;
  /** Go fullscreen in matches. Fullscreen lets the game capture Ctrl+W and similar browser shortcuts. */
  fullscreen: boolean;
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
  showFps: true,
  fullscreen: true,
};

const KEY = 'np.settings.v1';
type Listener = (s: Settings) => void;
const listeners: Listener[] = [];

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    return { ...DEFAULTS, ...raw };
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

export function resetSettings(): void {
  const name = settings.name;
  Object.assign(settings, DEFAULTS, { name });
  setSetting('name', name);
}
