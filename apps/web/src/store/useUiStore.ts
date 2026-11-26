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
  | 'admin_log'
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
  | 'vault'
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
  | 'create_bot'
  | 'shortcuts'
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
  | 'calls_history'
  | null;

export interface ComposeRecipient {
  userId: number;
  name: string;
  username?: string;
  isBot?: boolean;
  avatarShape?: string;
  avatarColor?: string;
}

export interface ComposeIsolationSnapshot {
  chatId: number | null;
  draftText: string;
  replyTarget: {
    messageId: number;
    senderName?: string;
    previewText: string;
    quoteText?: string;
  } | null;
  editingMessage: MessageItem | null;
  pendingAttachments: Array<{ name: string; size?: number; type?: string }>;
  botKeyboardOpen: boolean;
  composerPopover: 'emoji' | 'attach' | 'ai' | null;
}

export interface AppleComposeStageState {
  isOpen: boolean;
  recipients: ComposeRecipient[];
  pendingCreation: boolean;
  carryDraft: string;
}

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
  extraFiles?: File[];
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

export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export type ToastScope = 'window' | 'stage';

export interface StageToastState {
  id: number;
  chatId: number;
  message: string;
  kind: ToastKind;
}

export interface WindowToastState {
  id: number;
  chatId: number | null;
  message: string;
  kind: ToastKind;
}

export interface ToastNotification {
  id: string;
  numericId: number;
  message: string;
  kind: ToastKind;
  scope: ToastScope;
  chatId: number | null;
}

export interface PushToastOptions {
  scope?: ToastScope;
  chatId?: number | null;
  durationMs?: number;
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
  miniAppPipMinimized: boolean;

  appleComposeStage: AppleComposeStageState;
  composeIsolationSnapshot: ComposeIsolationSnapshot | null;

  contextMenu: ContextMenuState | null;
  lightboxState: LightboxViewerState | null;
  mediaEditorState: MediaEditorState | null;
  instantViewState: InstantViewState | null;
  storiesViewerState: StoriesViewerState | null;
  audioPlayerState: AudioPlayerState;
  activeCall: ActiveCallUiState;

  stageToast: StageToastState | null;
  windowToast: WindowToastState | null;
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
  setMiniAppPipMinimized: (minimized: boolean) => void;
  minimizeMiniAppToPip: () => void;
  restoreMiniAppFromPip: () => void;

  openAppleComposeStage: (
    carryDraft?: string,
    snapshotOverride?: ComposeIsolationSnapshot | null,
  ) => void;
  closeAppleComposeStage: (opts?: { committed?: boolean }) => void;
  clearComposeIsolationSnapshot: () => void;
  addComposeRecipient: (recipient: ComposeRecipient) => void;
  removeComposeRecipient: (userId: number) => void;
  setComposePending: (pending: boolean) => void;
  setComposeCarryDraft: (draft: string) => void;

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

  pushToast: (
    message: string,
    kind?: ToastKind,
    scopeOrOpts?: ToastScope | PushToastOptions,
  ) => number;
  pushStageToast: (message: string, kind?: ToastKind, chatId?: number) => number;
  dismissToast: (id: string) => void;
  dismissStageToastIfId: (id: number) => void;
  dismissWindowToastIfId: (id: number) => void;
  clearToastsForChat: (chatId: number | null) => void;

  /**
   * Deterministic 7-Layer Escape Stack: pops strictly ONE topmost layer per Escape press!
   */
  popTopEscapeLayer: (externalChatLayerHandler?: () => boolean) => boolean;

  /**
   * Reset all transient UI overlays, PiP MiniApp, drawers, modals, audio player, and active calls on account switch/logout.
   */
  resetUiStore: () => void;
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
  return 288;
}

function applySidebarWidthCss(width: number): void {
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--tg-left-sidebar-width', `${width}px`);
  }
}

const initialWidth = loadInitialSidebarWidth();
applySidebarWidthCss(initialWidth);

let nextToastSequence = 1;
let sharedAudioEl: HTMLAudioElement | null = null;
let audioProgressTicker: ReturnType<typeof setInterval> | null = null;

function clearAudioProgressTicker(): void {
  if (audioProgressTicker) {
    clearInterval(audioProgressTicker);
    audioProgressTicker = null;
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

let composeIsolationHooks: {
  captureAndClear?: (
    composerPopover: 'emoji' | 'attach' | 'ai' | null,
  ) => ComposeIsolationSnapshot | null;
  restore?: (snapshot: ComposeIsolationSnapshot) => void;
} = {};

export function registerUiComposeIsolationHooks(hooks: typeof composeIsolationHooks): void {
  composeIsolationHooks = { ...composeIsolationHooks, ...hooks };
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
  miniAppPipMinimized: false,

  appleComposeStage: {
    isOpen: false,
    recipients: [],
    pendingCreation: false,
    carryDraft: '',
  },
  composeIsolationSnapshot: null,

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

  stageToast: null,
  windowToast: null,
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

  setMiniAppModalOpen: (miniAppModalOpen) =>
    set((prev) => ({
      miniAppModalOpen,
      miniAppPipMinimized: miniAppModalOpen ? false : prev.miniAppPipMinimized,
    })),

  setMiniAppPipMinimized: (miniAppPipMinimized) => set({ miniAppPipMinimized }),

  minimizeMiniAppToPip: () => set({ miniAppModalOpen: false, miniAppPipMinimized: true }),

  restoreMiniAppFromPip: () => set({ miniAppModalOpen: true, miniAppPipMinimized: false }),

  openAppleComposeStage: (carryDraft = '', snapshotOverride) => {
    const prev = get();
    const capturedSnapshot =
      snapshotOverride !== undefined
        ? snapshotOverride
        : prev.appleComposeStage.isOpen
          ? prev.composeIsolationSnapshot
          : (composeIsolationHooks.captureAndClear?.(prev.composerPopover) ?? null);
    prev.clearToastsForChat(null);
    set({
      activeNavDest: 'chats',
      mobilePane: 'middle',
      isBurgerOpen: false,
      composerPopover: null,
      composeIsolationSnapshot: capturedSnapshot,
      appleComposeStage: {
        isOpen: true,
        recipients: [],
        pendingCreation: false,
        carryDraft,
      },
    });
  },

  closeAppleComposeStage: (opts) => {
    const committed = Boolean(opts?.committed);
    const snapshot = get().composeIsolationSnapshot;
    set({
      appleComposeStage: {
        isOpen: false,
        recipients: [],
        pendingCreation: false,
        carryDraft: '',
      },
      composeIsolationSnapshot: null,
      composerPopover: !committed && snapshot ? snapshot.composerPopover : null,
    });
    if (!committed && snapshot) {
      composeIsolationHooks.restore?.(snapshot);
    }
  },

  clearComposeIsolationSnapshot: () => set({ composeIsolationSnapshot: null }),

  addComposeRecipient: (recipient) =>
    set((prev) => {
      if (prev.appleComposeStage.recipients.some((r) => r.userId === recipient.userId)) {
        return prev;
      }
      return {
        appleComposeStage: {
          ...prev.appleComposeStage,
          recipients: [...prev.appleComposeStage.recipients, recipient],
        },
      };
    }),

  removeComposeRecipient: (userId) =>
    set((prev) => ({
      appleComposeStage: {
        ...prev.appleComposeStage,
        recipients: prev.appleComposeStage.recipients.filter((r) => r.userId !== userId),
      },
    })),

  setComposePending: (pendingCreation) =>
    set((prev) => ({
      appleComposeStage: {
        ...prev.appleComposeStage,
        pendingCreation,
      },
    })),

  setComposeCarryDraft: (carryDraft) =>
    set((prev) => ({
      appleComposeStage: {
        ...prev.appleComposeStage,
        carryDraft,
      },
    })),

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
        const targetStories = sv.groups[nextGroupIdx]!.stories;
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
    clearAudioProgressTicker();
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
          clearAudioProgressTicker();
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
          // Autoplay restriction handled gracefully
        });
      } catch {
        // Ignore Audio init error
      }
    }

    audioProgressTicker = setInterval(() => {
      const st = get().audioPlayerState;
      if (!st.isOpen || !st.isPlaying) return;
      if (sharedAudioEl && !sharedAudioEl.paused && sharedAudioEl.currentTime > 0) {
        return;
      }
      const nextSec = st.currentTimeSec + 0.1 * st.rate;
      if (nextSec >= st.durationSec) {
        clearAudioProgressTicker();
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
    clearAudioProgressTicker();
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
    const { getServerAdapter } = await import('../adapters');
    const adapter = getServerAdapter();
    webrtcManager.setSignalSender((sig) => adapter.sendCallSignal(sig));
    const [session, turnCreds] = await Promise.all([
      adapter.startCall(calleeId, isVideo, chatId),
      adapter.getTurnCredentials().catch(() => undefined),
    ]);
    const iceServers: RTCIceServer[] | undefined =
      turnCreds && Array.isArray(turnCreds.uris) && turnCreds.uris.length > 0
        ? turnCreds.uris.map((uri) =>
            uri.startsWith('turn:') || uri.startsWith('turns:')
              ? { urls: uri, username: turnCreds.username, credential: turnCreds.credential }
              : { urls: uri },
          )
        : undefined;
    const runtime = await webrtcManager.startCallSession({
      callSession: session,
      localUserId,
      chatId,
      iceServers,
    });
    set({
      activeCall: {
        isOpen: true,
        isMinimized: false,
        runtime,
      },
    });
    if (runtime.mediaError) {
      get().pushToast(runtime.mediaError, 'error', 'window');
    }
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

  pushToast: (message, kind = 'info', scopeOrOpts) => {
    const numericId = nextToastSequence++;
    const id = `toast_${numericId}`;
    const opts: PushToastOptions =
      typeof scopeOrOpts === 'string' ? { scope: scopeOrOpts } : (scopeOrOpts ?? {});
    const scope: ToastScope = opts.scope ?? 'window';
    const chatId = opts.chatId ?? null;
    const durationMs = opts.durationMs ?? 3_500;

    set((prev) => ({
      stageToast:
        scope === 'stage'
          ? { id: numericId, chatId: chatId ?? 0, message, kind }
          : prev.stageToast,
      windowToast:
        scope === 'window'
          ? { id: numericId, chatId, message, kind }
          : prev.windowToast,
      toasts: [...prev.toasts.slice(-4), { id, numericId, message, kind, scope, chatId }],
    }));

    setTimeout(() => {
      if (scope === 'stage') {
        get().dismissStageToastIfId(numericId);
      } else {
        get().dismissWindowToastIfId(numericId);
      }
    }, durationMs);

    return numericId;
  },

  pushStageToast: (message, kind = 'info', chatId = 0) =>
    get().pushToast(message, kind, { scope: 'stage', chatId }),

  dismissStageToastIfId: (id) =>
    set((prev) => ({
      stageToast: prev.stageToast?.id === id ? null : prev.stageToast,
      toasts: prev.toasts.filter((t) => !(t.scope === 'stage' && t.numericId === id)),
    })),

  dismissWindowToastIfId: (id) =>
    set((prev) => ({
      windowToast: prev.windowToast?.id === id ? null : prev.windowToast,
      toasts: prev.toasts.filter((t) => !(t.scope === 'window' && t.numericId === id)),
    })),

  dismissToast: (id) =>
    set((prev) => {
      const target = prev.toasts.find((t) => t.id === id);
      return {
        toasts: prev.toasts.filter((t) => t.id !== id),
        stageToast:
          target && prev.stageToast?.id === target.numericId ? null : prev.stageToast,
        windowToast:
          target && prev.windowToast?.id === target.numericId ? null : prev.windowToast,
      };
    }),

  clearToastsForChat: (chatId) =>
    set((prev) => ({
      stageToast:
        prev.stageToast && (chatId === null || prev.stageToast.chatId === chatId)
          ? null
          : prev.stageToast,
      windowToast:
        prev.windowToast && chatId !== null && prev.windowToast.chatId === chatId
          ? null
          : prev.windowToast,
      toasts: prev.toasts.filter((t) => {
        if (t.scope === 'stage') return chatId !== null && t.chatId !== chatId;
        return !(chatId !== null && t.chatId === chatId);
      }),
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

    // Layer 3: Modals, Apple Compose Stage, MiniApp Modal, or Expanded Call Overlay
    if (s.activeModal !== null) {
      set({ activeModal: null, modalPayload: null });
      return true;
    }
    if (s.appleComposeStage.isOpen) {
      get().closeAppleComposeStage({ committed: false });
      return true;
    }
    if (s.miniAppModalOpen) {
      set({ miniAppModalOpen: false, miniAppPipMinimized: false });
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

    // Layer 5: Settings Overlay (2-pane Apple System Settings: Escape closes panel cleanly)
    if (s.settingsStack.length > 0) {
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

  resetUiStore: () => {
    get().closeAudioPlayer();
    void webrtcManager.endCurrentCall().catch(() => undefined);
    set({
      isRightOpen: false,
      rightTab: 'media',
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
      miniAppPipMinimized: false,
      appleComposeStage: {
        isOpen: false,
        recipients: [],
        pendingCreation: false,
        carryDraft: '',
      },
      composeIsolationSnapshot: null,
      contextMenu: null,
      lightboxState: null,
      mediaEditorState: null,
      instantViewState: null,
      storiesViewerState: null,
      activeCall: {
        isOpen: false,
        isMinimized: false,
        runtime: null,
      },
      stageToast: null,
      windowToast: null,
      toasts: [],
    });
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
