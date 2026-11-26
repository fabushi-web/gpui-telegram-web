import { browserControlAgent } from '../services/browserControlAgent';
import { registerAccountActivatedHook, registerAuthClearedHook, useAuthStore } from './useAuthStore';
import { useAiWorkspaceStore } from './useAiWorkspaceStore';
import { useChatStore } from './useChatStore';
import { useSettingsStore, type ThemeName } from './useSettingsStore';
import {
  registerUiComposeIsolationHooks,
  registerUiEscapeHooks,
  useUiStore,
  type NavDestinationId,
} from './useUiStore';

export * from './useSettingsStore';
export * from './useAuthStore';
export * from './useUiStore';
export * from './useChatStore';
export * from './useAiWorkspaceStore';

// Wire complete multi-tenant cleanup on logout / account switch / deletion / session invalidation (F-03)
registerAuthClearedHook(() => {
  browserControlAgent.resetForAccountChange();
  useAiWorkspaceStore.getState().resetAiWorkspaceStore();
  useUiStore.getState().resetUiStore();
  useChatStore.getState().resetChatStore();
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('gpui_tg_active_chat_id');
    }
  } catch {
    // Ignore storage error
  }
});

// Wire account activation to auto-bootstrap chats, realtime WS sync, and AI workspaces
registerAccountActivatedHook((accountId) => {
  const chatStore = useChatStore.getState();
  if (chatStore.hydratedAccountId !== accountId) {
    chatStore.resetChatStore({ preserveFrame0: true });
  }
  chatStore.bindRealtimeEvents();
  void chatStore.bootstrapChats();
  void useAiWorkspaceStore.getState().bootstrapWorkspaces();
});

// Dismiss sensitive overlays (Settings, Burger Drawer, Modals) when locking the app
useAuthStore.subscribe((state, prev) => {
  if (state.isLocked && !prev.isLocked) {
    const ui = useUiStore.getState();
    ui.closeSettings();
    ui.setBurgerOpen(false);
    ui.closeModal();
  }
});

// Wire v1.6.14 ComposeIsolationSnapshot hooks across #apple-compose-stage open/cancel/commit
registerUiComposeIsolationHooks({
  captureAndClear: (composerPopover) => {
    const cs = useChatStore.getState();
    const cid = cs.activeChatId;
    if (cid === null) return null;
    const replyTarget = cs.replyTargetByChat[cid] ?? null;
    const editingMessage = cs.editingMessageByChat[cid] ?? null;
    const draftText = cs.draftsByChat[cid]?.text ?? '';
    useChatStore.setState((prev) => ({
      replyTargetByChat: { ...prev.replyTargetByChat, [cid]: null },
      editingMessageByChat: { ...prev.editingMessageByChat, [cid]: null },
    }));
    return {
      chatId: cid,
      draftText,
      replyTarget,
      editingMessage,
      pendingAttachments: [],
      botKeyboardOpen: false,
      composerPopover,
    };
  },
  restore: (snapshot) => {
    if (snapshot.chatId === null) return;
    const cid = snapshot.chatId;
    useChatStore.setState((prev) => {
      const nextDrafts = { ...prev.draftsByChat };
      if (snapshot.draftText) {
        const existing = nextDrafts[cid];
        nextDrafts[cid] = {
          chatId: cid,
          text: snapshot.draftText,
          entities: existing?.entities ?? [],
          replyToMsgId: snapshot.replyTarget?.messageId ?? existing?.replyToMsgId,
          quoteText: snapshot.replyTarget?.quoteText ?? existing?.quoteText,
          topicId: existing?.topicId,
          dateMs: Date.now(),
        };
      }
      return {
        replyTargetByChat: { ...prev.replyTargetByChat, [cid]: snapshot.replyTarget },
        editingMessageByChat: { ...prev.editingMessageByChat, [cid]: snapshot.editingMessage },
        draftsByChat: nextDrafts,
      };
    });
  },
});

// Wire 7-Layer Escape stack hooks between UI store, Chat store, and MiniApp runtime
registerUiEscapeHooks({
  clearChatSelectionOrReply: () => {
    const cs = useChatStore.getState();
    if (cs.isMultiSelectMode || cs.selectedMessageIds.length > 0) {
      cs.clearMultiSelect();
      return true;
    }
    const cid = cs.activeChatId;
    if (cid !== null) {
      if (cs.editingMessageByChat[cid]) {
        cs.setEditingMessage(cid, null);
        return true;
      }
      if (cs.replyTargetByChat[cid]) {
        cs.setReplyTarget(cid, null);
        return true;
      }
    }
    return false;
  },
  clearActiveChat: () => {
    const cs = useChatStore.getState();
    if (cs.activeChatId !== null) {
      void cs.selectChat(null);
      return true;
    }
    return false;
  },
  closeMiniApp: () => {
    useUiStore.getState().setMiniAppPipMinimized(false);
    useAiWorkspaceStore.getState().closeMiniApp();
  },
});

// Wire Live Browser Control Agent (`window.__GPUI_TELEGRAM_BROWSER_BRIDGE__`) context & high-level app actions
browserControlAgent.setContextProvider(() => ({
  activeChatId: useChatStore.getState().activeChatId,
  activeNavDest: useUiStore.getState().activeNavDest,
}));

browserControlAgent.setAppActionHandler(async (appAction, payload = {}) => {
  switch (appAction) {
    case 'select_chat': {
      const chatId = payload.chatId !== undefined ? Number(payload.chatId) : null;
      await useChatStore.getState().selectChat(chatId);
      return { activeChatId: chatId };
    }
    case 'send_message': {
      const chatId = Number(payload.chatId ?? useChatStore.getState().activeChatId ?? 0);
      const text = String(payload.text ?? '');
      if (!chatId || !text) throw new Error('chatId and text are required');
      const sent = await useChatStore.getState().sendText(chatId, text);
      return { messageId: sent.id, chatId };
    }
    case 'switch_theme': {
      const theme = String(payload.theme ?? 'night') as ThemeName;
      useSettingsStore.getState().setTheme(theme);
      return { theme };
    }
    case 'switch_language': {
      const lang = String(payload.language ?? 'en-US') as 'zh-CN' | 'en-US';
      useSettingsStore.getState().setLanguage(lang);
      return { language: lang };
    }
    case 'navigate_workspace': {
      const dest = String(payload.dest ?? 'chats') as NavDestinationId;
      useUiStore.getState().setActiveNavDest(dest);
      return { activeNavDest: dest };
    }
    case 'get_app_state': {
      return {
        isAuthenticated: useAuthStore.getState().isAuthenticated,
        currentUser: useAuthStore.getState().currentUser,
        activeChatId: useChatStore.getState().activeChatId,
        chatCount: useChatStore.getState().orderedChatIds.length,
        theme: useSettingsStore.getState().theme,
        language: useSettingsStore.getState().language,
      };
    }
    default:
      throw new Error(`Unknown app_action: ${appAction}`);
  }
});
