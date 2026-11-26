import React, { useEffect, useMemo } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { getClientAdapter } from './adapters';
import {
  BrowserControlWorkspace,
  ComputerWorkbench,
  HermesStudioPanel,
  McpToolsDock,
  TalkModeOrb,
  TaskCenterWorkspace,
  WalletStarsModal,
} from './components/ai';
import { AuthScreen, PasscodeLockScreen } from './components/auth';
import { CallOverlay } from './components/calls';
import { GlobalToastBannerFallback, MainShell } from './components/layout';
import { LeftColumn } from './components/left';
import {
  InstantViewModal,
  LightboxViewer,
  MediaEditorModal,
} from './components/media';
import { MiddleColumn } from './components/middle';
import { MiniAppCatalogModal, MiniAppModal } from './components/miniapps';
import { ModalHost } from './components/modals';
import { RightColumn } from './components/right';
import { SettingsPanel } from './components/settings';
import { browserControlAgent } from './services/browserControlAgent';
import {
  useAuthStore,
  useChatStore,
  useSettingsStore,
  useUiStore,
} from './store';

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

export function App(): React.JSX.Element {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isAddingAccount = useAuthStore((s) => s.isAddingAccount);
  const isLocked = useAuthStore((s) => s.isLocked);

  const theme = useSettingsStore((s) => s.theme);
  const language = useSettingsStore((s) => s.language);

  const activeNavDest = useUiStore((s) => s.activeNavDest);
  const openSettings = useUiStore((s) => s.openSettings);
  const toggleRightSidebar = useUiStore((s) => s.toggleRightSidebar);
  const setInChatSearchOpen = useUiStore((s) => s.setInChatSearchOpen);
  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);
  const openModal = useUiStore((s) => s.openModal);

  const activeChatId = useChatStore((s) => s.activeChatId);
  const chatsById = useChatStore((s) => s.chatsById);

  // Hydrate persisted settings and session accounts on initial mount
  useEffect(() => {
    useSettingsStore.getState().hydrateSettings();
    void useAuthStore.getState().hydrateAuth();
  }, []);

  // Bridge custom shortcut modal & Magpie Gateway events across SettingsPanel / LeftColumn / ModalHost
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onOpenShortcuts = (): void => {
      useUiStore.setState({
        activeModal: 'shortcuts',
        modalPayload: { source: 'menu' },
      });
    };
    const onOpenMagpieGateway = (): void => {
      useUiStore.getState().closeSettings();
      useUiStore.getState().setActiveNavDest('hermes');
    };
    window.addEventListener('gpui:open-shortcuts-modal', onOpenShortcuts);
    window.addEventListener('gpui:open-shortcuts', onOpenShortcuts);
    window.addEventListener('gpui:open-magpie-gateway', onOpenMagpieGateway);
    return () => {
      window.removeEventListener('gpui:open-shortcuts-modal', onOpenShortcuts);
      window.removeEventListener('gpui:open-shortcuts', onOpenShortcuts);
      window.removeEventListener('gpui:open-magpie-gateway', onOpenMagpieGateway);
    };
  }, []);

  // Keep document title & F17 live browser bridge metadata synchronized
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const activeChat = activeChatId !== null ? chatsById[activeChatId] : undefined;
    const titlePrefix = activeChat?.title ? `${activeChat.title} · ` : '';
    document.title = `${titlePrefix}Fabushi Web v1.7.0`;
    document.documentElement.lang = language === 'zh-CN' ? 'zh-CN' : 'en';

    if (!isAuthenticated || isLocked) return;
    if (!browserControlAgent.getState().allowDesktopControl) return;

    const timer = setTimeout(() => {
      if (!browserControlAgent.getState().allowDesktopControl) return;
      const statePayload = browserControlAgent.buildStateReportPayload();
      void getClientAdapter()
        .reportBrowserState({
          ...statePayload,
          theme,
          active_chat_id: activeChatId,
          active_nav_dest: activeNavDest,
        })
        .catch(() => {
          // Non-fatal if tab not yet registered over REST
        });
    }, 150);

    return () => clearTimeout(timer);
  }, [
    isAuthenticated,
    isLocked,
    activeChatId,
    activeNavDest,
    theme,
    language,
    chatsById,
  ]);

  // Supplemental global keyboard shortcuts when authenticated & unlocked
  useEffect(() => {
    if (!isAuthenticated || isAddingAccount || isLocked || typeof window === 'undefined') {
      return;
    }

    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.defaultPrevented) return;
      const mod = ev.ctrlKey || ev.metaKey;
      const lowerKey = ev.key.toLowerCase();

      // Ctrl/Cmd + , -> Open Settings
      if (mod && !ev.shiftKey && !ev.altKey && ev.key === ',') {
        ev.preventDefault();
        openSettings('root');
        return;
      }

      // Ctrl/Cmd + F -> Open In-Chat Search when a chat is active
      if (mod && !ev.shiftKey && !ev.altKey && lowerKey === 'f') {
        const cid = useChatStore.getState().activeChatId;
        if (cid !== null) {
          ev.preventDefault();
          setInChatSearchOpen(true);
          window.requestAnimationFrame(() => {
            const input = document.getElementById(DOM_IDS.IN_CHAT_SEARCH_INPUT);
            if (input instanceof HTMLInputElement) {
              input.focus();
              input.select();
            }
          });
          return;
        }
      }

      // Ctrl/Cmd + I -> Toggle Right Inspector (only outside editable composer so *italic* works!)
      if (mod && !ev.shiftKey && !ev.altKey && lowerKey === 'i' && !isEditableElement(ev.target)) {
        ev.preventDefault();
        toggleRightSidebar();
        return;
      }

      // Ctrl/Cmd + J -> Toggle Hermes AI Studio workspace
      if (mod && !ev.shiftKey && !ev.altKey && lowerKey === 'j') {
        ev.preventDefault();
        const cur = useUiStore.getState().activeNavDest;
        setActiveNavDest(cur === 'hermes' ? 'chats' : 'hermes');
        return;
      }

      // Ctrl/Cmd + [ -> Settings Back Stack Pop
      if (mod && !ev.shiftKey && !ev.altKey && ev.key === '[') {
        const ui = useUiStore.getState();
        if (ui.settingsStack.length > 0) {
          ev.preventDefault();
          ui.popSettingsSection();
          return;
        }
      }

      // Ctrl/Cmd + Shift + B -> Toggle Built-in Browser Workspace (v1.6.15)
      if (mod && ev.shiftKey && !ev.altKey && lowerKey === 'b') {
        ev.preventDefault();
        const cur = useUiStore.getState().activeNavDest;
        setActiveNavDest(cur === 'browser_control' ? 'chats' : 'browser_control');
        return;
      }

      // Ctrl/Cmd + P -> Open Create Poll Modal (v1.6.15; gates off blocking modals & suppresses Print)
      if (mod && !ev.shiftKey && !ev.altKey && lowerKey === 'p') {
        const ui = useUiStore.getState();
        const hasBlockingOverlay = Boolean(
          ui.activeModal !== null ||
            ui.settingsStack.length > 0 ||
            ui.lightboxState?.isOpen ||
            (ui.activeCall.isOpen && !ui.activeCall.isMinimized),
        );
        if (!hasBlockingOverlay) {
          ev.preventDefault();
          openModal('create_poll', { chatId: useChatStore.getState().activeChatId });
          return;
        }
      }

      // Alt + 3 -> Open Calls History Modal (web-safe navigation shortcut)
      if (!mod && ev.altKey && !ev.shiftKey && ev.key === '3') {
        ev.preventDefault();
        openModal('calls_history');
        return;
      }

      // Ctrl/Cmd + Shift + N -> Create Channel modal
      if (mod && ev.shiftKey && !ev.altKey && lowerKey === 'n') {
        ev.preventDefault();
        openModal('create_channel');
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    isAuthenticated,
    isAddingAccount,
    isLocked,
    openSettings,
    setInChatSearchOpen,
    toggleRightSidebar,
    setActiveNavDest,
    openModal,
  ]);

  const activeWorkspaceOverlay = useMemo<React.ReactNode>(() => {
    switch (activeNavDest) {
      case 'hermes':
        return <HermesStudioPanel />;
      case 'tasks':
        return <TaskCenterWorkspace />;
      case 'mcp':
        return <McpToolsDock />;
      case 'talk':
        return <TalkModeOrb />;
      case 'computers':
        return <ComputerWorkbench />;
      case 'browser_control':
        return <BrowserControlWorkspace />;
      default:
        return null;
    }
  }, [activeNavDest]);

  // Gate 1: Unauthenticated or adding a secondary account -> AuthScreen only (no #app-shell)
  if (!isAuthenticated || isAddingAccount) {
    return (
      <>
        <AuthScreen />
        <GlobalToastBannerFallback />
      </>
    );
  }

  // Gate 2: Passcode Lock active -> PasscodeLockScreen ONLY (strictly never mount #app-shell while locked!)
  if (isLocked) {
    return (
      <>
        <PasscodeLockScreen />
        <GlobalToastBannerFallback />
      </>
    );
  }

  // Gate 3: Full Authenticated 4-Breakpoint Shell + All Domain Overlays
  return (
    <MainShell
      leftSlot={<LeftColumn />}
      middleSlot={<MiddleColumn />}
      rightSlot={<RightColumn />}
      workspaceOverlaySlot={activeWorkspaceOverlay}
    >
      <SettingsPanel />
      <ModalHost />
      <MiniAppCatalogModal />
      <WalletStarsModal />
      <MiniAppModal />
      <LightboxViewer />
      <MediaEditorModal />
      <InstantViewModal />
      <CallOverlay />
      <GlobalToastBannerFallback />
    </MainShell>
  );
}

export default App;
