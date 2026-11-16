// Player settings, persisted in localStorage.

export type QualitySetting = 'auto' | 'high' | 'medium' | 'low';
/** Shape of the play area. Anything but 'fill' adds black bars rather than stretching. */
export type AspectSetting = 'fill' | '21:9' | '16:9' | '16:10' | '4:3' | '5:4';

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
