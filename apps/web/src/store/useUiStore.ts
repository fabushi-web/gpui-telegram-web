import { create } from 'zustand';
import type { MessageItem, StoryGroup } from '@gpui-telegram/protocol';
import {
  webrtcManager,
  type ActiveWebRtcCallRuntime,
} from '../services/webrtcManager';

export type NavDestinationId =
  | 'chats'
  | 'contacts'
  | 'calls'
  | 'saved'
  | 'hermes'
  | 'tasks'
  | 'mcp'
  | 'talk'
  | 'computers'
  | 'browser_control'
  | 'settings';

export type RightInspectorTab =
  | 'info'
  | 'members'
  | 'media'
  | 'files'
  | 'links'
  | 'voice'
  | 'admin'
  | 'statistics';

export type MobilePaneId = 'left' | 'middle' | 'right' | 'workspace';

export type SettingsSectionId =
  | 'root'
  | 'edit_profile'
  | 'general'
  | 'appearance'
  | 'wallpaper'
  | 'notifications'
  | 'privacy'
  | 'passcode'
  | 'two_fa'
  | 'passkeys'
  | 'blocked_users'
  | 'auto_delete'
  | 'folders'
  | 'devices'
  | 'data_storage'
  | 'language'
  | 'stickers'
  | 'power_saving'
  | 'chat_export'
  | 'connection_mode'
  | 'magpie_gateway'
  | 'hermes_studio'
  | 'browser_control'
  | 'wallet'
  | 'about';

export type ModalId =
  | 'create_group'
  | 'create_channel'
  | 'create_secret_chat'
  | 'contacts'
  | 'forward_messages'
  | 'delete_confirm'
  | 'create_poll'
  | 'create_todo'
  | 'create_invoice'
  | 'create_story'
  | 'create_topic'
  | 'folder_editor'
  | 'wallet_stars'
  | 'miniapp_catalog'
  | 'qr_invite'
  | 'reaction_details'
  | 'passcode_setup'
  | null;

export interface ContextMenuState {
  kind: 'message' | 'chat';
  x: number;
  y: number;
  chatId: number;
  messageId?: number;
}

export interface LightboxViewerState {
  isOpen: boolean;
  chatId: number;
  messageId: number;
  mediaUrl: string;
  mimeType: string;
  caption?: string;
  zoom: number; // 1..4
  rotation: 0 | 90 | 180 | 270;
}

export interface MediaEditorState {
  isOpen: boolean;
  chatId: number;
  file: File | Blob;
  previewUrl: string;
  fileName: string;
  mimeType: string;
  caption: string;
  hasSpoiler: boolean;
  cropRatio: 'free' | '1:1' | '16:9' | '4:3';
  annotations: Array<{ points: Array<{ x: number; y: number }>; color: string }>;
}

export interface InstantViewState {
  isOpen: boolean;
  url: string;
  title: string;
  siteName: string;
  contentHtml: string;
  readingTimeMinutes: number;
}

export interface StoriesViewerState {
  isOpen: boolean;
  groups: StoryGroup[];
  activeGroupIndex: number;
  activeStoryIndex: number;
}

export type AudioPlaybackRate = 1 | 1.5 | 2;

export interface AudioPlayerState {
  isOpen: boolean;
  isPlaying: boolean;
  chatId: number | null;
  message: MessageItem | null;
  srcUrl: string | null;
  rate: AudioPlaybackRate;
  progress: number; // 0..1
  currentTimeSec: number;
  durationSec: number;
}

export interface ActiveCallUiState {
  isOpen: boolean;
  isMinimized: boolean;
  runtime: ActiveWebRtcCallRuntime | null;
}

export interface ToastNotification {
  id: string;
  message: string;
  kind: 'info' | 'success' | 'warning' | 'error';
}

export interface UiState {
  leftSidebarWidth: number; // [260..424]
  isLeftCollapsed: boolean; // 64px rail mode
  isRightOpen: boolean;
  rightTab: RightInspectorTab;
  inChatSearchOpen: boolean;
  mobilePane: MobilePaneId;
  tabletLeftDrawerOpen: boolean;

  activeNavDest: NavDestinationId;
  isBurgerOpen: boolean;
  isAccountSwitcherOpen: boolean;
  composerPopover: 'emoji' | 'attach' | 'ai' | null;

  settingsStack: SettingsSectionId[]; // Empty when #settings-panel is closed
  activeModal: ModalId;
  modalPayload: Record<string, unknown> | null;
  miniAppModalOpen: boolean;

  contextMenu: ContextMenuState | null;
  lightboxState: LightboxViewerState | null;
  mediaEditorState: MediaEditorState | null;
  instantViewState: InstantViewState | null;
  storiesViewerState: StoriesViewerState | null;
  audioPlayerState: AudioPlayerState;
  activeCall: ActiveCallUiState;
  toasts: ToastNotification[];

  setLeftSidebarWidth: (width: number) => void;
  toggleLeftCollapsed: (collapsed?: boolean) => void;
  toggleRightSidebar: (open?: boolean, tab?: RightInspectorTab) => void;
  setRightTab: (tab: RightInspectorTab) => void;
  setInChatSearchOpen: (open: boolean) => void;
  setMobilePane: (pane: MobilePaneId) => void;
  setTabletLeftDrawerOpen: (open: boolean) => void;

  setActiveNavDest: (dest: NavDestinationId) => void;
  setBurgerOpen: (open: boolean) => void;
  setAccountSwitcherOpen: (open: boolean) => void;
  setComposerPopover: (popover: 'emoji' | 'attach' | 'ai' | null) => void;

  openSettings: (initialSection?: SettingsSectionId) => void;
  pushSettingsSection: (section: SettingsSectionId) => void;
  popSettingsSection: () => void;
  closeSettings: () => void;

  openModal: (modal: Exclude<ModalId, null>, payload?: Record<string, unknown> | null) => void;
  closeModal: () => void;
  setMiniAppModalOpen: (open: boolean) => void;

  openContextMenu: (menu: ContextMenuState) => void;
  closeContextMenu: () => void;

  openLightbox: (params: Omit<LightboxViewerState, 'isOpen' | 'zoom' | 'rotation'>) => void;
  zoomLightbox: (deltaOrValue: number, absolute?: boolean) => void;
  rotateLightbox: () => void;
  closeLightbox: () => void;

  openMediaEditor: (params: Omit<MediaEditorState, 'isOpen'>) => void;
  updateMediaEditor: (patch: Partial<MediaEditorState>) => void;
  closeMediaEditor: () => void;

  openInstantView: (params: Omit<InstantViewState, 'isOpen'>) => void;
  closeInstantView: () => void;

  openStoriesViewer: (groups: StoryGroup[], groupIdx?: number, storyIdx?: number) => void;
  advanceStory: (delta: 1 | -1) => void;
  closeStoriesViewer: () => void;

  playVoiceOrAudio: (chatId: number, message: MessageItem, srcUrl: string, durationSec?: number) => void;
  toggleAudioPlayPause: () => void;
  seekAudioProgress: (ratio: number) => void;
  cycleAudioRate: () => AudioPlaybackRate;
  closeAudioPlayer: () => void;

  startOutgoingCall: (params: {
    calleeId: number;
    localUserId: number;
    isVideo: boolean;
    chatId?: number;
  }) => Promise<void>;
  toggleCallMinimize: (minimized?: boolean) => void;
  toggleCallMute: () => boolean;
  toggleCallVideo: () => boolean;
  toggleCallScreenShare: () => Promise<boolean>;
  endActiveCall: () => Promise<void>;

  pushToast: (message: string, kind?: ToastNotification['kind']) => void;
  dismissToast: (id: string) => void;

  /**
   * Deterministic 7-Layer Escape Stack: pops strictly ONE topmost layer per Escape press!
   */
  popTopEscapeLayer: (externalChatLayerHandler?: () => boolean) => boolean;
}

const SIDEBAR_WIDTH_KEY = 'gpui_tg_sidebar_width_v1';

function loadInitialSidebarWidth(): number {
  try {
    if (typeof localStorage !== 'undefined') {
      const v = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
      if (Number.isFinite(v) && v >= 260 && v <= 424) return v;
    }
  } catch {
    // Ignore
  }
  return 340;
}

function applySidebarWidthCss(width: number): void {
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--tg-left-sidebar-width', `${width}px`);
  }
}

const initialWidth = loadInitialSidebarWidth();
applySidebarWidthCss(initialWidth);

// Shared singleton HTMLAudioElement + synthetic progress ticker for headless environments
let sharedAudioEl: HTMLAudioElement | null = null;
let synthAudioTicker: ReturnType<typeof setInterval> | null = null;

function clearSynthTicker(): void {
  if (synthAudioTicker) {
    clearInterval(synthAudioTicker);
    synthAudioTicker = null;
  }
}

let externalEscapeHooks: {
  clearChatSelectionOrReply?: () => boolean;
  clearActiveChat?: () => boolean;
  closeMiniApp?: () => void;
} = {};

export function registerUiEscapeHooks(hooks: typeof externalEscapeHooks): void {
  externalEscapeHooks = { ...externalEscapeHooks, ...hooks };
}

export const useUiStore = create<UiState>((set, get) => ({
  leftSidebarWidth: initialWidth,
  isLeftCollapsed: false,
  isRightOpen: false,
  rightTab: 'info',
  inChatSearchOpen: false,
  mobilePane: 'left',
  tabletLeftDrawerOpen: false,

  activeNavDest: 'chats',
  isBurgerOpen: false,
  isAccountSwitcherOpen: false,
  composerPopover: null,

  settingsStack: [],
  activeModal: null,
  modalPayload: null,
  miniAppModalOpen: false,

  contextMenu: null,
  lightboxState: null,
  mediaEditorState: null,
  instantViewState: null,
  storiesViewerState: null,
  audioPlayerState: {
    isOpen: false,
    isPlaying: false,
    chatId: null,
    message: null,
    srcUrl: null,
    rate: 1,
    progress: 0,
    currentTimeSec: 0,
    durationSec: 0,
  },
  activeCall: {
    isOpen: false,
    isMinimized: false,
    runtime: null,
  },
  toasts: [],

  setLeftSidebarWidth: (width) => {
    const clamped = Math.max(260, Math.min(424, Math.round(width)));
    applySidebarWidthCss(clamped);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
      }
    } catch {
      // Ignore
    }
    set({ leftSidebarWidth: clamped, isLeftCollapsed: false });
  },

  toggleLeftCollapsed: (collapsed) => {
    set((prev) => ({
      isLeftCollapsed: collapsed ?? !prev.isLeftCollapsed,
    }));
  },

  toggleRightSidebar: (open, tab) => {
    set((prev) => {
      const nextOpen = open ?? !prev.isRightOpen;
      return {
        isRightOpen: nextOpen,
        rightTab: tab ?? prev.rightTab,
        mobilePane: nextOpen ? 'right' : prev.mobilePane === 'right' ? 'middle' : prev.mobilePane,
      };
    });
  },

  setRightTab: (rightTab) => set({ rightTab, isRightOpen: true }),

  setInChatSearchOpen: (inChatSearchOpen) => set({ inChatSearchOpen }),

  setMobilePane: (mobilePane) => set({ mobilePane }),

  setTabletLeftDrawerOpen: (tabletLeftDrawerOpen) => set({ tabletLeftDrawerOpen }),

  setActiveNavDest: (dest) => {
    if (dest === 'settings') {
      get().openSettings('root');
      return;
    }
    set({
      activeNavDest: dest,
      isBurgerOpen: false,
      mobilePane: dest === 'chats' ? 'left' : 'workspace',
    });
  },

  setBurgerOpen: (isBurgerOpen) =>
    set((prev) => ({
      isBurgerOpen,
      isAccountSwitcherOpen: isBurgerOpen ? prev.isAccountSwitcherOpen : false,
    })),

  setAccountSwitcherOpen: (isAccountSwitcherOpen) => set({ isAccountSwitcherOpen }),

  setComposerPopover: (composerPopover) => set({ composerPopover }),

  openSettings: (initialSection = 'root') => {
    set({
      settingsStack: initialSection === 'root' ? ['root'] : ['root', initialSection],
      isBurgerOpen: false,
    });
  },

  pushSettingsSection: (section) => {
    set((prev) => {
      const base = prev.settingsStack.length === 0 ? (['root'] as SettingsSectionId[]) : prev.settingsStack;
      if (base[base.length - 1] === section) return prev;
      return { settingsStack: [...base, section] };
    });
  },

  popSettingsSection: () => {
    set((prev) => {
      if (prev.settingsStack.length <= 1) {
        return { settingsStack: [] };
      }
      return { settingsStack: prev.settingsStack.slice(0, -1) };
    });
  },

  closeSettings: () => set({ settingsStack: [] }),

  openModal: (activeModal, modalPayload = null) =>
    set({ activeModal, modalPayload, isBurgerOpen: false, contextMenu: null }),

  closeModal: () => set({ activeModal: null, modalPayload: null }),

  setMiniAppModalOpen: (miniAppModalOpen) => set({ miniAppModalOpen }),

  openContextMenu: (contextMenu) => set({ contextMenu }),
  closeContextMenu: () => set({ contextMenu: null }),

  openLightbox: (params) =>
    set({
      lightboxState: {
        ...params,
        isOpen: true,
        zoom: 1,
        rotation: 0,
      },
    }),

  zoomLightbox: (deltaOrValue, absolute = false) =>
    set((prev) => {
      if (!prev.lightboxState) return prev;
      const raw = absolute ? deltaOrValue : prev.lightboxState.zoom + deltaOrValue;
      const zoom = Math.max(1, Math.min(4, Number(raw.toFixed(2))));
      return { lightboxState: { ...prev.lightboxState, zoom } };
    }),

  rotateLightbox: () =>
    set((prev) => {
      if (!prev.lightboxState) return prev;
      const nextRot = ((prev.lightboxState.rotation + 90) % 360) as 0 | 90 | 180 | 270;
      return { lightboxState: { ...prev.lightboxState, rotation: nextRot } };
    }),

  closeLightbox: () => set({ lightboxState: null }),

  openMediaEditor: (params) =>
    set({
      mediaEditorState: {
        ...params,
        isOpen: true,
      },
    }),

  updateMediaEditor: (patch) =>
    set((prev) =>
      prev.mediaEditorState
        ? { mediaEditorState: { ...prev.mediaEditorState, ...patch } }
        : prev,
    ),

  closeMediaEditor: () => set({ mediaEditorState: null }),

  openInstantView: (params) =>
    set({
      instantViewState: {
        ...params,
        isOpen: true,
      },
    }),

  closeInstantView: () => set({ instantViewState: null }),

  openStoriesViewer: (groups, activeGroupIndex = 0, activeStoryIndex = 0) =>
    set({
      storiesViewerState: {
        isOpen: true,
        groups,
        activeGroupIndex,
        activeStoryIndex,
      },
    }),

  advanceStory: (delta) =>
    set((prev) => {
      const sv = prev.storiesViewerState;
      if (!sv) return prev;
      const currentGroup = sv.groups[sv.activeGroupIndex];
      if (!currentGroup) return { storiesViewerState: null };

      const nextStoryIdx = sv.activeStoryIndex + delta;
      if (nextStoryIdx >= 0 && nextStoryIdx < currentGroup.stories.length) {
        return {
          storiesViewerState: { ...sv, activeStoryIndex: nextStoryIdx },
        };
      }
      const nextGroupIdx = sv.activeGroupIndex + delta;
      if (nextGroupIdx >= 0 && nextGroupIdx < sv.groups.length) {
        const targetStories = sv.groups[nextGroupIdx].stories;
        return {
          storiesViewerState: {
            ...sv,
            activeGroupIndex: nextGroupIdx,
            activeStoryIndex: delta > 0 ? 0 : Math.max(0, targetStories.length - 1),
          },
        };
      }
      return { storiesViewerState: null };
    }),

  closeStoriesViewer: () => set({ storiesViewerState: null }),

  playVoiceOrAudio: (chatId, message, srcUrl, fallbackDuration = 3) => {
    clearSynthTicker();
    const rate = get().audioPlayerState.rate;
    const durationSec = Math.max(1, fallbackDuration);

    set({
      audioPlayerState: {
        isOpen: true,
        isPlaying: true,
        chatId,
        message,
        srcUrl,
        rate,
        progress: 0,
        currentTimeSec: 0,
        durationSec,
      },
    });

    if (typeof Audio !== 'undefined') {
      try {
        if (!sharedAudioEl) {
          sharedAudioEl = new Audio();
        }
        sharedAudioEl.pause();
        sharedAudioEl.src = srcUrl;
        sharedAudioEl.playbackRate = rate;
        sharedAudioEl.ontimeupdate = () => {
          if (!sharedAudioEl) return;
          const dur =
            Number.isFinite(sharedAudioEl.duration) && sharedAudioEl.duration > 0
              ? sharedAudioEl.duration
              : get().audioPlayerState.durationSec;
          const cur = sharedAudioEl.currentTime;
          set((prev) => ({
            audioPlayerState: {
              ...prev.audioPlayerState,
              currentTimeSec: cur,
              durationSec: dur,
              progress: Math.max(0, Math.min(1, cur / Math.max(0.1, dur))),
            },
          }));
        };
        sharedAudioEl.onended = () => {
          clearSynthTicker();
          set((prev) => ({
            audioPlayerState: {
              ...prev.audioPlayerState,
              isPlaying: false,
              progress: 1,
              currentTimeSec: prev.audioPlayerState.durationSec,
            },
          }));
        };
        void sharedAudioEl.play().catch(() => {
          // Headless autoplay fallback ticker
        });
      } catch {
        // Fallback ticker below handles headless environments cleanly
      }
    }

    // Deterministic progress ticker guarantees smooth progress even if headless Audio output is muted
    synthAudioTicker = setInterval(() => {
      const st = get().audioPlayerState;
      if (!st.isOpen || !st.isPlaying) return;
      if (sharedAudioEl && !sharedAudioEl.paused && sharedAudioEl.currentTime > 0) {
        return;
      }
      const nextSec = st.currentTimeSec + 0.1 * st.rate;
      if (nextSec >= st.durationSec) {
        clearSynthTicker();
        set((prev) => ({
          audioPlayerState: {
            ...prev.audioPlayerState,
            isPlaying: false,
            progress: 1,
            currentTimeSec: prev.audioPlayerState.durationSec,
          },
        }));
      } else {
        set((prev) => ({
          audioPlayerState: {
            ...prev.audioPlayerState,
            currentTimeSec: nextSec,
            progress: Math.min(1, nextSec / Math.max(0.1, prev.audioPlayerState.durationSec)),
          },
        }));
      }
    }, 100);
  },

  toggleAudioPlayPause: () => {
    const st = get().audioPlayerState;
    if (!st.isOpen) return;
    const nextPlaying = !st.isPlaying;
    const resetFromEnd = nextPlaying && st.progress >= 0.99;

    if (sharedAudioEl) {
      if (nextPlaying) {
        if (resetFromEnd) sharedAudioEl.currentTime = 0;
        void sharedAudioEl.play().catch(() => undefined);
      } else {
        sharedAudioEl.pause();
      }
    }

    set((prev) => ({
      audioPlayerState: {
        ...prev.audioPlayerState,
        isPlaying: nextPlaying,
        progress: resetFromEnd ? 0 : prev.audioPlayerState.progress,
        currentTimeSec: resetFromEnd ? 0 : prev.audioPlayerState.currentTimeSec,
      },
    }));
  },

  seekAudioProgress: (ratio) => {
    const clamped = Math.max(0, Math.min(1, ratio));
    const st = get().audioPlayerState;
    const targetSec = clamped * Math.max(1, st.durationSec);
    if (sharedAudioEl && Number.isFinite(sharedAudioEl.duration) && sharedAudioEl.duration > 0) {
      sharedAudioEl.currentTime = clamped * sharedAudioEl.duration;
    }
    set((prev) => ({
      audioPlayerState: {
        ...prev.audioPlayerState,
        progress: clamped,
        currentTimeSec: targetSec,
      },
    }));
  },

  cycleAudioRate: () => {
    const curr = get().audioPlayerState.rate;
    const next: AudioPlaybackRate = curr === 1 ? 1.5 : curr === 1.5 ? 2 : 1;
    if (sharedAudioEl) {
      sharedAudioEl.playbackRate = next;
    }
    set((prev) => ({
      audioPlayerState: {
        ...prev.audioPlayerState,
        rate: next,
      },
    }));
    return next;
  },

  closeAudioPlayer: () => {
    clearSynthTicker();
    if (sharedAudioEl) {
      sharedAudioEl.pause();
    }
    set((prev) => ({
      audioPlayerState: {
        ...prev.audioPlayerState,
        isOpen: false,
        isPlaying: false,
        progress: 0,
        currentTimeSec: 0,
      },
    }));
  },

  startOutgoingCall: async ({ calleeId, localUserId, isVideo, chatId }) => {
    const { getClientAdapter } = await import('../adapters');
    const adapter = getClientAdapter();
    webrtcManager.setSignalSender((sig) => adapter.sendCallSignal(sig));
    const session = await adapter.startCall(calleeId, isVideo, chatId);
    const runtime = await webrtcManager.startCallSession({
      callSession: session,
      localUserId,
      chatId,
    });
    set({
      activeCall: {
        isOpen: true,
        isMinimized: false,
        runtime,
      },
    });
  },

  toggleCallMinimize: (minimized) =>
    set((prev) => ({
      activeCall: {
        ...prev.activeCall,
        isMinimized: minimized ?? !prev.activeCall.isMinimized,
      },
    })),

  toggleCallMute: () => webrtcManager.setMuted(),

  toggleCallVideo: () => webrtcManager.setVideoEnabled(),

  toggleCallScreenShare: () => webrtcManager.toggleScreenShare(),

  endActiveCall: async () => {
    const callId = get().activeCall.runtime?.callId;
    await webrtcManager.endCurrentCall();
    if (callId) {
      const { getClientAdapter } = await import('../adapters');
      await getClientAdapter().endCall(callId).catch(() => undefined);
    }
    set({
      activeCall: {
        isOpen: false,
        isMinimized: false,
        runtime: null,
      },
    });
  },

  pushToast: (message, kind = 'info') => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    set((prev) => ({
      toasts: [...prev.toasts.slice(-4), { id, message, kind }],
    }));
    setTimeout(() => {
      get().dismissToast(id);
    }, 3_500);
  },

  dismissToast: (id) =>
    set((prev) => ({
      toasts: prev.toasts.filter((t) => t.id !== id),
    })),

  popTopEscapeLayer: (externalChatLayerHandler) => {
    const s = get();

    // Layer 1: Context Menu or Composer Popover (Emoji / Attach / AI)
    if (s.contextMenu) {
      set({ contextMenu: null });
      return true;
    }
    if (s.composerPopover) {
      set({ composerPopover: null });
      return true;
    }

    // Layer 2: Fullscreen Media Viewers (Lightbox, Media Editor, Stories, Instant View)
    if (s.lightboxState?.isOpen) {
      set({ lightboxState: null });
      return true;
    }
    if (s.mediaEditorState?.isOpen) {
      set({ mediaEditorState: null });
      return true;
    }
    if (s.storiesViewerState?.isOpen) {
      set({ storiesViewerState: null });
      return true;
    }
    if (s.instantViewState?.isOpen) {
      set({ instantViewState: null });
      return true;
    }

    // Layer 3: Modals, MiniApp Modal, or Expanded Call Overlay (minimizes call to top bar!)
    if (s.activeModal !== null) {
      set({ activeModal: null, modalPayload: null });
      return true;
    }
    if (s.miniAppModalOpen) {
      set({ miniAppModalOpen: false });
      externalEscapeHooks.closeMiniApp?.();
      return true;
    }
    if (s.activeCall.isOpen && !s.activeCall.isMinimized) {
      set({ activeCall: { ...s.activeCall, isMinimized: true } });
      return true;
    }

    // Layer 4: In-Chat Search, Multi-Select Toolbar, or Reply/Edit Target
    if (s.inChatSearchOpen) {
      set({ inChatSearchOpen: false });
      return true;
    }
    if (externalChatLayerHandler?.() || externalEscapeHooks.clearChatSelectionOrReply?.()) {
      return true;
    }

    // Layer 5: Settings 25-Section Slide-Stack (pops sub-section first, then closes panel)
    if (s.settingsStack.length > 1) {
      set({ settingsStack: s.settingsStack.slice(0, -1) });
      return true;
    }
    if (s.settingsStack.length === 1) {
      set({ settingsStack: [] });
      return true;
    }

    // Layer 6: Slide-Over Drawers (Account Switcher -> Burger Drawer -> Tablet Left -> Right Inspector)
    if (s.isAccountSwitcherOpen) {
      set({ isAccountSwitcherOpen: false });
      return true;
    }
    if (s.isBurgerOpen) {
      set({ isBurgerOpen: false });
      return true;
    }
    if (s.tabletLeftDrawerOpen) {
      set({ tabletLeftDrawerOpen: false });
      return true;
    }
    if (s.isRightOpen) {
      set({
        isRightOpen: false,
        mobilePane: s.mobilePane === 'right' ? 'middle' : s.mobilePane,
      });
      return true;
    }

    // Layer 7: Active Workspace -> Chats, or Mobile/Desktop Active Chat -> Chat List
    if (s.activeNavDest !== 'chats') {
      set({ activeNavDest: 'chats', mobilePane: 'left' });
      return true;
    }
    if (s.mobilePane === 'middle') {
      set({ mobilePane: 'left' });
      externalEscapeHooks.clearActiveChat?.();
      return true;
    }
    if (externalEscapeHooks.clearActiveChat?.()) {
      return true;
    }

    return false;
  },
}));

// Keep activeCall.runtime live-synced with webrtcManager transitions
webrtcManager.subscribe((runtime) => {
  useUiStore.setState((prev) => ({
    activeCall: runtime
      ? {
          isOpen: true,
          isMinimized: prev.activeCall.isMinimized,
          runtime,
        }
      : {
          isOpen: false,
          isMinimized: false,
          runtime: null,
        },
  }));
});
