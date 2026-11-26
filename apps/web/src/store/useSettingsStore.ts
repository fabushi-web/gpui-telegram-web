import { create } from 'zustand';
import { broadcastSync, type SyncThemeName } from '../adapters/broadcastSync';
import { normalizeLocale, setActiveLocale, type LocaleCode } from '../i18n';
import {
  computeBt601Luma,
  ensureWhiteTextContrast,
  mixRgbHex,
  sanitizeNonPurpleHex,
} from '../utils/coreParityM1B';

export type ThemeName = SyncThemeName;
export type ConcreteThemeName = 'night' | 'tinted' | 'day' | 'classic';

export { computeBt601Luma, ensureWhiteTextContrast };

export const NON_PURPLE_ACCENT_SWATCHES = [
  '#0A84FF',
  '#3390EC',
  '#1084FE',
  '#3FC1B0',
  '#00C972',
  '#E5A030',
  '#E86C52',
  '#E15B64',
  '#29B6F6',
] as const;

export const INTERFACE_SCALE_PRESETS = [100, 125, 150, 200] as const;

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
  bubbleRadius: number; // 6..22 px
  uiScale: number; // 50..300 (%)
  interfaceScalePct: number; // 50..300 (%) synchronized alias for desktop parity
  language: LocaleCode;
  sendByEnter: boolean;
  autoTranslate: boolean;
  notificationsEnabled: boolean;
  powerSaving: boolean;
  globalTtl: number;

  setTheme: (theme: ThemeName) => void;
  cycleTheme: () => void;
  toggleNightMode: () => void;
  setAccentColor: (hex: string) => void;
  setWallpaper: (wallpaper: WallpaperPreset, blur?: boolean) => void;
  setWallpaperBlur: (blur: boolean) => void;
  setFontSize: (px: number) => void;
  setBubbleRadius: (px: number) => void;
  setUiScale: (scale: number) => void;
  setInterfaceScalePct: (pct: number) => void;
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
  interfaceScalePct?: number;
  language: LocaleCode;
  sendByEnter: boolean;
  autoTranslate: boolean;
  notificationsEnabled: boolean;
  powerSaving: boolean;
  globalTtl: number;
}

const DEFAULT_SETTINGS: PersistedSettingsSnapshot = {
  theme: 'night',
  accentColor: '#0A84FF',
  wallpaper: 'default',
  wallpaperBlur: false,
  fontSize: 14,
  bubbleRadius: 18,
  uiScale: 100,
  interfaceScalePct: 100,
  language: 'en-US',
  sendByEnter: true,
  autoTranslate: false,
  notificationsEnabled: true,
  powerSaving: false,
  globalTtl: 0,
};

const DEFAULT_ACCENT_FAMILY = new Set(['#0A84FF', '#3390EC', '#1687FF', '#40A7E3', '#007AFF']);

export function resolveEffectiveTheme(theme: ThemeName): ConcreteThemeName {
  if (theme !== 'system') return theme;
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day';
    }
  } catch {
    // Fallback to dark when matchMedia is unavailable
  }
  return 'night';
}

function defaultAccentForThemeName(theme: ThemeName): string {
  const effective = resolveEffectiveTheme(theme);
  return effective === 'classic' ? '#40A7E3' : '#0A84FF';
}

export function sanitizeNonPurpleAccent(hex: string): string {
  return sanitizeNonPurpleHex(hex);
}

function clampNumber(val: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(val)) return fallback;
  return Math.max(min, Math.min(max, val));
}

function normalizeUiScalePercent(raw: number): number {
  if (!Number.isFinite(raw)) return 100;
  const pct = raw <= 3 ? Math.round(raw * 100) : Math.round(raw);
  return clampNumber(pct, 50, 300, 100);
}

function resolveWallpaperCss(preset: WallpaperPreset): string | null {
  switch (preset) {
    case 'ocean':
      return 'linear-gradient(135deg, rgba(14, 14, 14, 0.94) 0%, rgba(10, 132, 255, 0.28) 100%)';
    case 'emerald':
      return 'linear-gradient(135deg, rgba(14, 14, 14, 0.92) 0%, rgba(0, 201, 114, 0.22) 100%)';
    case 'amber':
      return 'linear-gradient(135deg, rgba(14, 14, 14, 0.94) 0%, rgba(229, 160, 48, 0.20) 100%)';
    case 'graphite':
      return 'radial-gradient(circle at 50% 30%, rgba(41, 182, 246, 0.08), transparent 60%)';
    case 'solid':
      return 'none';
    case 'default':
    default:
      return null;
  }
}

export async function requestNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  if (typeof Notification === 'undefined') {
    return 'unsupported';
  }
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function applySettingsToDocument(snap: PersistedSettingsSnapshot): void {
  setActiveLocale(snap.language);
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  const effectiveTheme = resolveEffectiveTheme(snap.theme);
  const isDark = effectiveTheme === 'night' || effectiveTheme === 'tinted';
  const scalePct = normalizeUiScalePercent(snap.interfaceScalePct ?? snap.uiScale);

  // Set concrete theme on data-theme (CRITICAL for dark-mode CSS & assertNoPurpleOnDark)
  root.setAttribute('data-theme', effectiveTheme);
  root.setAttribute('data-theme-mode', snap.theme);
  root.setAttribute('data-power-saving', String(snap.powerSaving));
  root.lang = snap.language;

  root.style.setProperty('--tg-font-size', `${snap.fontSize}px`);
  root.style.setProperty('--tg-bubble-radius', `${snap.bubbleRadius}px`);
  root.style.setProperty('--tg-ui-scale', String(Number((scalePct / 100).toFixed(2))));
  root.style.setProperty('--tg-interface-scale-pct', `${scalePct}%`);

  const defaultThemeAccent = defaultAccentForThemeName(effectiveTheme);
  const safeAccent = sanitizeNonPurpleAccent(snap.accentColor || defaultThemeAccent);
  const contrastFill = ensureWhiteTextContrast(safeAccent);
  root.style.setProperty('--tg-accent', contrastFill);
  root.style.setProperty('--tg-accent-fill', contrastFill);

  const isCustomAccent = !DEFAULT_ACCENT_FAMILY.has(safeAccent);
  if (isCustomAccent && effectiveTheme !== 'classic') {
    const outTop = sanitizeNonPurpleAccent(
      mixRgbHex(contrastFill, '#FFFFFF', isDark ? 0.1 : 0.16),
    );
    const outMeta = sanitizeNonPurpleAccent(mixRgbHex('#FFFFFF', contrastFill, 0.16));
    const linkColor = sanitizeNonPurpleAccent(
      isDark ? mixRgbHex('#FFFFFF', safeAccent, 0.72) : mixRgbHex(safeAccent, '#111111', 0.12),
    );
    root.style.setProperty('--tg-bubble-out-top', outTop);
    root.style.setProperty('--tg-bubble-out-bottom', contrastFill);
    root.style.setProperty(
      '--tg-bubble-out-gradient',
      `linear-gradient(180deg, ${outTop} 0%, ${contrastFill} 100%)`,
    );
    root.style.setProperty('--tg-bubble-out-meta', outMeta);
    root.style.setProperty('--tg-text-link', linkColor);
  } else {
    root.style.removeProperty('--tg-bubble-out-top');
    root.style.removeProperty('--tg-bubble-out-bottom');
    root.style.removeProperty('--tg-bubble-out-gradient');
    root.style.removeProperty('--tg-bubble-out-meta');
    root.style.removeProperty('--tg-text-link');
  }

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
        const validThemes: ThemeName[] = ['night', 'tinted', 'day', 'classic', 'system'];
        const theme: ThemeName =
          parsed.theme && validThemes.includes(parsed.theme) ? parsed.theme : 'night';
        const scale = normalizeUiScalePercent(
          Number(parsed.interfaceScalePct ?? parsed.uiScale ?? 100),
        );
        return {
          theme,
          accentColor: sanitizeNonPurpleAccent(
            parsed.accentColor ?? defaultAccentForThemeName(theme),
          ),
          wallpaper: parsed.wallpaper ?? 'default',
          wallpaperBlur: Boolean(parsed.wallpaperBlur),
          fontSize: clampNumber(Number(parsed.fontSize ?? 14), 12, 20, 14),
          bubbleRadius: clampNumber(Number(parsed.bubbleRadius ?? 18), 6, 22, 18),
          uiScale: scale,
          interfaceScalePct: scale,
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
  const scale = normalizeUiScalePercent(state.interfaceScalePct ?? state.uiScale);
  const snap: PersistedSettingsSnapshot = {
    theme: state.theme,
    accentColor: state.accentColor,
    wallpaper: state.wallpaper,
    wallpaperBlur: state.wallpaperBlur,
    fontSize: state.fontSize,
    bubbleRadius: state.bubbleRadius,
    uiScale: scale,
    interfaceScalePct: scale,
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
  interfaceScalePct: initialSettings.interfaceScalePct ?? initialSettings.uiScale,

  setTheme: (theme) => {
    const defaultAccentForTheme = defaultAccentForThemeName(theme);
    set((prev) => ({
      theme,
      accentColor: DEFAULT_ACCENT_FAMILY.has(prev.accentColor.toUpperCase())
        ? defaultAccentForTheme
        : prev.accentColor,
    }));
    const snap = savePersistedSettings(get());
    broadcastSync.publish({
      kind: 'settings_updated',
      patch: { theme: snap.theme, accentColor: snap.accentColor },
    });
  },

  cycleTheme: () => {
    const eff = resolveEffectiveTheme(get().theme);
    const order: ConcreteThemeName[] = ['night', 'tinted', 'day', 'classic'];
    const idx = order.indexOf(eff);
    const next = order[(idx + 1) % order.length] ?? 'night';
    get().setTheme(next);
  },

  toggleNightMode: () => {
    const eff = resolveEffectiveTheme(get().theme);
    const next: ThemeName = eff === 'night' || eff === 'tinted' ? 'day' : 'night';
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
    const bubbleRadius = clampNumber(Math.round(px), 6, 22, 18);
    set({ bubbleRadius });
    savePersistedSettings(get());
    broadcastSync.publish({ kind: 'settings_updated', patch: { bubbleRadius } });
  },

  setUiScale: (scale) => {
    const pct = normalizeUiScalePercent(scale);
    set({ uiScale: pct, interfaceScalePct: pct });
    savePersistedSettings(get());
    broadcastSync.publish({ kind: 'settings_updated', patch: { uiScale: pct } });
  },

  setInterfaceScalePct: (pct) => {
    get().setUiScale(pct);
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
    if (
      notificationsEnabled &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'default'
    ) {
      void Notification.requestPermission().catch(() => undefined);
    }
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
      interfaceScalePct: DEFAULT_SETTINGS.uiScale,
    });
    const snap = savePersistedSettings(get());
    broadcastSync.publish({ kind: 'settings_updated', patch: snap });
  },

  hydrateSettings: () => {
    const loaded = loadPersistedSettings();
    set({
      ...loaded,
      interfaceScalePct: loaded.interfaceScalePct ?? loaded.uiScale,
    });
    applySettingsToDocument(loaded);
  },
}));

// Live OS color-scheme listener when theme === 'system'
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  try {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSchemeChange = (): void => {
      const current = useSettingsStore.getState();
      if (current.theme === 'system') {
        applySettingsToDocument(current);
      }
    };
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handleSchemeChange);
    }
  } catch {
    // Ignore matchMedia listener restriction
  }
}

// Cross-tab live appearance & language synchronization
broadcastSync.subscribe((payload) => {
  if (payload.kind !== 'settings_updated') return;
  useSettingsStore.setState((prev) => {
    const scale =
      payload.patch.uiScale !== undefined
        ? normalizeUiScalePercent(payload.patch.uiScale)
        : prev.uiScale;
    const merged: SettingsState = {
      ...prev,
      ...payload.patch,
      uiScale: scale,
      interfaceScalePct: scale,
    };
    applySettingsToDocument(merged);
    return merged;
  });
});
