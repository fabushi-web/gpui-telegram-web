import { create } from 'zustand';
import { broadcastSync, type SyncThemeName } from '../adapters/broadcastSync';
import { normalizeLocale, setActiveLocale, type LocaleCode } from '../i18n';

export type ThemeName = SyncThemeName;

export const NON_PURPLE_ACCENT_SWATCHES = [
  '#3390EC',
  '#1084FE',
  '#3FC1B0',
  '#00C972',
  '#E5A030',
  '#E86C52',
  '#E15B64',
  '#29B6F6',
] as const;

export type WallpaperPreset =
  | 'default'
  | 'ocean'
  | 'emerald'
  | 'amber'
  | 'graphite'
  | 'solid'
  | (string & {});

export interface SettingsState {
  theme: ThemeName;
  accentColor: string;
  wallpaper: WallpaperPreset;
  wallpaperBlur: boolean;
  fontSize: number; // 12..20 px
  bubbleRadius: number; // 6..18 px
  uiScale: number; // 50..200 (%)
  language: LocaleCode;
  sendByEnter: boolean;
  autoTranslate: boolean;
  notificationsEnabled: boolean;
  powerSaving: boolean;
  globalTtl: number;

  setTheme: (theme: ThemeName) => void;
  toggleNightMode: () => void;
  setAccentColor: (hex: string) => void;
  setWallpaper: (wallpaper: WallpaperPreset, blur?: boolean) => void;
  setWallpaperBlur: (blur: boolean) => void;
  setFontSize: (px: number) => void;
  setBubbleRadius: (px: number) => void;
  setUiScale: (scale: number) => void;
  setLanguage: (language: LocaleCode) => void;
  toggleLanguage: () => void;
  setSendByEnter: (enabled: boolean) => void;
  setAutoTranslate: (enabled: boolean) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setPowerSaving: (enabled: boolean) => void;
  setGlobalTtl: (ttlSeconds: number) => void;
  resetAppearance: () => void;
  hydrateSettings: () => void;
}

const SETTINGS_STORAGE_KEY = 'gpui_tg_settings_v1';

interface PersistedSettingsSnapshot {
  theme: ThemeName;
  accentColor: string;
  wallpaper: WallpaperPreset;
  wallpaperBlur: boolean;
  fontSize: number;
  bubbleRadius: number;
  uiScale: number;
  language: LocaleCode;
  sendByEnter: boolean;
  autoTranslate: boolean;
  notificationsEnabled: boolean;
  powerSaving: boolean;
  globalTtl: number;
}

const DEFAULT_SETTINGS: PersistedSettingsSnapshot = {
  theme: 'night',
  accentColor: '#3390EC',
  wallpaper: 'default',
  wallpaperBlur: false,
  fontSize: 14,
  bubbleRadius: 14,
  uiScale: 100,
  language: 'en-US',
  sendByEnter: true,
  autoTranslate: false,
  notificationsEnabled: true,
  powerSaving: false,
  globalTtl: 0,
};

function sanitizeNonPurpleAccent(hex: string): string {
  const trimmed = hex.trim();
  const m = trimmed.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return '#3390EC';
  const num = parseInt(m[1], 16);
  const r = ((num >> 16) & 0xff) / 255;
  const g = ((num >> 8) & 0xff) / 255;
  const b = (num & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d > 0) {
    let h = 0;
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    // Guard against purple/violet hue band (238°..312°)
    if (h >= 235 && h <= 315) {
      return '#3390EC';
    }
  }
  return `#${m[1].toUpperCase()}`;
}

function clampNumber(val: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(val)) return fallback;
  return Math.max(min, Math.min(max, val));
}

function normalizeUiScalePercent(raw: number): number {
  if (!Number.isFinite(raw)) return 100;
  // Accept both ratio (0.5..2.0) and percent (50..200)
  const pct = raw <= 3 ? Math.round(raw * 100) : Math.round(raw);
  return clampNumber(pct, 50, 200, 100);
}

function resolveWallpaperCss(preset: WallpaperPreset): string | null {
  switch (preset) {
    case 'ocean':
      return 'linear-gradient(135deg, rgba(14, 22, 33, 0.92) 0%, rgba(27, 73, 120, 0.45) 100%)';
    case 'emerald':
      return 'linear-gradient(135deg, rgba(14, 22, 33, 0.90) 0%, rgba(0, 201, 114, 0.22) 100%)';
    case 'amber':
      return 'linear-gradient(135deg, rgba(14, 22, 33, 0.92) 0%, rgba(229, 160, 48, 0.20) 100%)';
    case 'graphite':
      return 'radial-gradient(circle at 50% 30%, rgba(41, 182, 246, 0.08), transparent 60%)';
    case 'solid':
      return 'none';
    case 'default':
    default:
      return null;
  }
}

export function applySettingsToDocument(snap: PersistedSettingsSnapshot): void {
  setActiveLocale(snap.language);
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  root.setAttribute('data-theme', snap.theme);
  root.setAttribute('data-power-saving', String(snap.powerSaving));
  root.lang = snap.language;

  root.style.setProperty('--tg-font-size', `${snap.fontSize}px`);
  root.style.setProperty('--tg-bubble-radius', `${snap.bubbleRadius}px`);
  root.style.setProperty('--tg-ui-scale', String(Number((snap.uiScale / 100).toFixed(2))));

  const defaultThemeAccent =
    snap.theme === 'tinted'
      ? '#1687FF'
      : snap.theme === 'classic'
        ? '#40A7E3'
        : '#3390EC';
  const effectiveAccent = sanitizeNonPurpleAccent(snap.accentColor || defaultThemeAccent);
  root.style.setProperty('--tg-accent', effectiveAccent);

  const customWp = resolveWallpaperCss(snap.wallpaper);
  if (customWp !== null) {
    root.style.setProperty('--tg-chat-wallpaper', customWp);
  } else {
    root.style.removeProperty('--tg-chat-wallpaper');
  }
}

function loadPersistedSettings(): PersistedSettingsSnapshot {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedSettingsSnapshot>;
        const validThemes: ThemeName[] = ['night', 'tinted', 'day', 'classic'];
        const theme: ThemeName =
          parsed.theme && validThemes.includes(parsed.theme) ? parsed.theme : 'night';
        return {
          theme,
          accentColor: sanitizeNonPurpleAccent(parsed.accentColor ?? '#3390EC'),
          wallpaper: parsed.wallpaper ?? 'default',
          wallpaperBlur: Boolean(parsed.wallpaperBlur),
          fontSize: clampNumber(Number(parsed.fontSize ?? 14), 12, 20, 14),
          bubbleRadius: clampNumber(Number(parsed.bubbleRadius ?? 14), 6, 18, 14),
          uiScale: normalizeUiScalePercent(Number(parsed.uiScale ?? 100)),
          language: normalizeLocale(parsed.language),
          sendByEnter: parsed.sendByEnter !== undefined ? Boolean(parsed.sendByEnter) : true,
          autoTranslate: Boolean(parsed.autoTranslate),
          notificationsEnabled:
            parsed.notificationsEnabled !== undefined
              ? Boolean(parsed.notificationsEnabled)
              : true,
          powerSaving: Boolean(parsed.powerSaving),
          globalTtl: Math.max(0, Number(parsed.globalTtl ?? 0)),
        };
      }
    }
  } catch {
    // Ignore storage read failure
  }
  return { ...DEFAULT_SETTINGS };
}

function savePersistedSettings(state: SettingsState): PersistedSettingsSnapshot {
  const snap: PersistedSettingsSnapshot = {
    theme: state.theme,
    accentColor: state.accentColor,
    wallpaper: state.wallpaper,
    wallpaperBlur: state.wallpaperBlur,
    fontSize: state.fontSize,
    bubbleRadius: state.bubbleRadius,
    uiScale: state.uiScale,
    language: state.language,
    sendByEnter: state.sendByEnter,
    autoTranslate: state.autoTranslate,
    notificationsEnabled: state.notificationsEnabled,
    powerSaving: state.powerSaving,
    globalTtl: state.globalTtl,
  };
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(snap));
    }
  } catch {
    // Ignore quota error
  }
  applySettingsToDocument(snap);
  return snap;
}

const initialSettings = loadPersistedSettings();
applySettingsToDocument(initialSettings);

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...initialSettings,

  setTheme: (theme) => {
    const defaultAccentForTheme =
      theme === 'tinted' ? '#1687FF' : theme === 'classic' ? '#40A7E3' : '#3390EC';
    set((prev) => ({
      theme,
      accentColor:
        prev.accentColor === '#3390EC' ||
        prev.accentColor === '#1687FF' ||
        prev.accentColor === '#40A7E3'
          ? defaultAccentForTheme
          : prev.accentColor,
    }));
    const snap = savePersistedSettings(get());
    broadcastSync.publish({
      kind: 'settings_updated',
      patch: { theme: snap.theme, accentColor: snap.accentColor },
    });
  },

  toggleNightMode: () => {
    const current = get().theme;
    const next: ThemeName = current === 'night' || current === 'tinted' ? 'day' : 'night';
    get().setTheme(next);
  },

  setAccentColor: (hex) => {
    const clean = sanitizeNonPurpleAccent(hex);
    set({ accentColor: clean });
    savePersistedSettings(get());
    broadcastSync.publish({
      kind: 'settings_updated',
      patch: { accentColor: clean },
    });
  },

  setWallpaper: (wallpaper, blur) => {
    set((prev) => ({
      wallpaper,
      wallpaperBlur: blur !== undefined ? blur : prev.wallpaperBlur,
    }));
    savePersistedSettings(get());
  },

  setWallpaperBlur: (wallpaperBlur) => {
    set({ wallpaperBlur });
    savePersistedSettings(get());
  },

  setFontSize: (px) => {
    const fontSize = clampNumber(Math.round(px), 12, 20, 14);
    set({ fontSize });
    savePersistedSettings(get());
    broadcastSync.publish({ kind: 'settings_updated', patch: { fontSize } });
  },

  setBubbleRadius: (px) => {
    const bubbleRadius = clampNumber(Math.round(px), 6, 18, 14);
    set({ bubbleRadius });
    savePersistedSettings(get());
    broadcastSync.publish({ kind: 'settings_updated', patch: { bubbleRadius } });
  },

  setUiScale: (scale) => {
    const uiScale = normalizeUiScalePercent(scale);
    set({ uiScale });
    savePersistedSettings(get());
    broadcastSync.publish({ kind: 'settings_updated', patch: { uiScale } });
  },

  setLanguage: (language) => {
    const normalized = normalizeLocale(language);
    set({ language: normalized });
    savePersistedSettings(get());
    broadcastSync.publish({ kind: 'settings_updated', patch: { language: normalized } });
  },

  toggleLanguage: () => {
    const next: LocaleCode = get().language === 'en-US' ? 'zh-CN' : 'en-US';
    get().setLanguage(next);
  },

  setSendByEnter: (sendByEnter) => {
    set({ sendByEnter });
    savePersistedSettings(get());
    broadcastSync.publish({ kind: 'settings_updated', patch: { sendByEnter } });
  },

  setAutoTranslate: (autoTranslate) => {
    set({ autoTranslate });
    savePersistedSettings(get());
  },

  setNotificationsEnabled: (notificationsEnabled) => {
    set({ notificationsEnabled });
    savePersistedSettings(get());
  },

  setPowerSaving: (powerSaving) => {
    set({ powerSaving });
    savePersistedSettings(get());
  },

  setGlobalTtl: (ttlSeconds) => {
    set({ globalTtl: Math.max(0, Math.floor(ttlSeconds)) });
    savePersistedSettings(get());
  },

  resetAppearance: () => {
    set({
      theme: DEFAULT_SETTINGS.theme,
      accentColor: DEFAULT_SETTINGS.accentColor,
      wallpaper: DEFAULT_SETTINGS.wallpaper,
      wallpaperBlur: DEFAULT_SETTINGS.wallpaperBlur,
      fontSize: DEFAULT_SETTINGS.fontSize,
      bubbleRadius: DEFAULT_SETTINGS.bubbleRadius,
      uiScale: DEFAULT_SETTINGS.uiScale,
    });
    const snap = savePersistedSettings(get());
    broadcastSync.publish({ kind: 'settings_updated', patch: snap });
  },

  hydrateSettings: () => {
    const loaded = loadPersistedSettings();
    set(loaded);
    applySettingsToDocument(loaded);
  },
}));

// Cross-tab live appearance & language synchronization
broadcastSync.subscribe((payload) => {
  if (payload.kind !== 'settings_updated') return;
  useSettingsStore.setState((prev) => {
    const merged = { ...prev, ...payload.patch };
    applySettingsToDocument(merged);
    return merged;
  });
});
