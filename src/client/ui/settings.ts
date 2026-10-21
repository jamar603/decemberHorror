// Paramètres joueur (localStorage). Le shell (main.ts) s'abonne pour appliquer rendu / contrôles / audio.
import { setLang, type Lang } from './i18n';

export type Action = 'forward' | 'back' | 'left' | 'right' | 'sprint' | 'map';
export const ACTIONS: Action[] = ['forward', 'back', 'left', 'right', 'sprint', 'map'];
export type Quality = 'low' | 'medium' | 'high';
export const QUALITY_RATIO: Record<Quality, number> = { low: 0.75, medium: 1, high: 1.5 }; // perf : ≤ 1.5

export interface Settings {
  quality: Quality;
  renderScale: number; // 0.5 … 1
  fov: number; // 60 … 100
  brightness: number; // 0.6 … 1.6
  showFps: boolean;
  master: number; music: number; sfx: number; // 0 … 1
  sensitivity: number; // multiplicateur 0.2 … 3
  invertY: boolean;
  binds: Record<Action, string>; // KeyboardEvent.code (touche physique : marche en AZERTY comme en QWERTY)
  lang: Lang;
  reduceMotion: boolean;
  highContrast: boolean;
  textScale: number; // 1 · 1.15 · 1.3
  crosshair: boolean;
  grain: boolean;
}

const KEY = 'december.settings';
export const DEFAULTS: Settings = {
  quality: 'high', renderScale: 1, fov: 75, brightness: 1, showFps: false,
  master: 0.8, music: 0.7, sfx: 0.8,
  sensitivity: 1, invertY: false,
  binds: { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', sprint: 'ShiftLeft', map: 'KeyM' },
  lang: navigator.language?.toLowerCase().startsWith('fr') !== false ? 'fr' : 'en',
  reduceMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  highContrast: false, textScale: 1, crosshair: true, grain: true,
};

function load(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEFAULTS, ...s, binds: { ...DEFAULTS.binds, ...s.binds } };
  } catch { return structuredClone(DEFAULTS); }
}

type Listener = (s: Settings) => void;
const listeners = new Set<Listener>();
export const settings: Settings = load();
setLang(settings.lang);

export function onSettings(fn: Listener) { listeners.add(fn); fn(settings); return () => listeners.delete(fn); }

export function setSetting<K extends keyof Settings>(k: K, v: Settings[K]) {
  settings[k] = v;
  if (k === 'lang') setLang(v as Lang);
  save();
}
export function resetSettings(keys: (keyof Settings)[]) {
  for (const k of keys) (settings as unknown as Record<string, unknown>)[k] = structuredClone(DEFAULTS[k]);
  setLang(settings.lang);
  save();
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {}
  for (const fn of listeners) fn(settings);
}

// Libellé d'une touche physique selon la disposition du clavier (Chrome : Keyboard Map API ; sinon nom générique)
let layout: Map<string, string> | null = null;
(navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard?.getLayoutMap()
  .then((m) => { layout = m; for (const fn of listeners) fn(settings); }).catch(() => {});
const NAMES: Record<string, string> = {
  ShiftLeft: 'Maj', ShiftRight: 'Maj D', ControlLeft: 'Ctrl', ControlRight: 'Ctrl D', AltLeft: 'Alt', Space: 'Espace',
  Tab: 'Tab', CapsLock: 'Verr. Maj', Enter: 'Entrée', Backspace: '⌫', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};
export function keyLabel(code: string) {
  const l = layout?.get(code);
  if (l && l.trim()) return l.toUpperCase();
  return NAMES[code] ?? code.replace(/^Key|^Digit/, '');
}
