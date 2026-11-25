import { browserControlAgent } from '../services/browserControlAgent';
import { registerAccountActivatedHook, useAuthStore } from './useAuthStore';
import { useAiWorkspaceStore } from './useAiWorkspaceStore';
import { useChatStore } from './useChatStore';
import { useSettingsStore, type ThemeName } from './useSettingsStore';
import { registerUiEscapeHooks, useUiStore, type NavDestinationId } from './useUiStore';

export * from './useSettingsStore';
export * from './useAuthStore';
export * from './useUiStore';
export * from './useChatStore';
export * from './useAiWorkspaceStore';

// Wire account activation to auto-bootstrap chats, realtime WS sync, and AI workspaces
registerAccountActivatedHook(() => {
  const chatStore = useChatStore.getState();
  chatStore.resetChatStore();
  chatStore.bindRealtimeEvents();
  void chatStore.bootstrapChats();
  void useAiWorkspaceStore.getState().bootstrapWorkspaces();
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
