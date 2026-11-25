import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DOM_IDS, type BotRegistryEntry } from '@gpui-telegram/protocol';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';
import { GrokBotAvatar } from '../common/GrokBotAvatar';
import { StageToastLayer } from '../layout/ToastBanners';
import { AppleComposeStage } from './AppleComposeStage';
import { BotPreStartBar } from './BotPreStartBar';
import {
  CanonicalComposer,
  type CanonicalComposerHandle,
} from './CanonicalComposer';
import { ChatHeader } from './ChatHeader';
import { InChatSearchBar } from './InChatSearchBar';
import { MessageList, type MessageListHandle } from './MessageList';
import { PinnedBanner } from './PinnedBanner';
import { SelectionToolbar } from './SelectionToolbar';

const RoomAgentFloorBanner: React.FC<{ chatId: number }> = ({ chatId }) => {
  const language = useSettingsStore((s) => s.language);
  const isZh = language === 'zh-CN';
  const roomState = useChatStore((s) => s.roomAgentStateByChat[chatId]);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!roomState || !roomState.currentSpeaker) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [roomState]);

  if (!roomState) return null;
  const isFresh = nowMs - roomState.updatedAtMs < 60_000;
  const hasSpeaker = Boolean(roomState.currentSpeaker && isFresh);
  const hasWorkspace = Boolean(roomState.workspaceRevision && roomState.workspaceRevision > 0);
  if (!hasSpeaker && !hasWorkspace) return null;

  return (
    <div
      data-testid="room-agent-floor-banner"
      className="tg-room-floor-banner"
      role="status"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
        {hasSpeaker && roomState.currentSpeaker && (
          <>
            <GrokBotAvatar
              sourceId={roomState.currentSpeaker}
              sizePx={20}
              state="thinking"
            />
            <span className="tg-truncate" style={{ fontWeight: 600 }}>
              {isZh
                ? `${roomState.currentSpeaker} 正在发言…`
                : `${roomState.currentSpeaker} speaking…`}
            </span>
          </>
        )}
        {roomState.queuedCount > 0 && (
          <span className="tg-badge tg-badge--muted">
            {isZh ? `排队 ${roomState.queuedCount}` : `${roomState.queuedCount} queued`}
          </span>
        )}
        {roomState.loopHops > 0 && (
          <span
            style={{
              fontSize: '11px',
              color: 'var(--tg-text-secondary)',
              fontFamily: 'var(--tg-font-mono)',
            }}
          >
            hop {roomState.loopHops}/5
          </span>
        )}
      </div>
      {hasWorkspace && (
        <span
          style={{
            fontSize: '11px',
            color: 'var(--tg-accent)',
            fontFamily: 'var(--tg-font-mono)',
            flexShrink: 0,
          }}
        >
          {isZh ? `共享工作区 v${roomState.workspaceRevision}` : `Workspace v${roomState.workspaceRevision}`}
          {roomState.lastWorkspaceKey ? ` · ${roomState.lastWorkspaceKey}` : ''}
        </span>
      )}
    </div>
  );
};

export const MiddleColumn: React.FC = () => {
  const activeChatId = useChatStore((s) => s.activeChatId);
  const chatsById = useChatStore((s) => s.chatsById);
  const messagesByChat = useChatStore((s) => s.messagesByChat);
  const activeTopicId = useChatStore((s) => s.activeTopicId);
  const isLoadingMessages = useChatStore((s) => s.isLoadingMessages);

  const bots = useAiWorkspaceStore((s) => s.bots);

  const appleComposeStageOpen = useUiStore((s) => s.appleComposeStage.isOpen);
  const openModal = useUiStore((s) => s.openModal);

  const wallpaper = useSettingsStore((s) => s.wallpaper);
  const wallpaperBlur = useSettingsStore((s) => s.wallpaperBlur);
  const language = useSettingsStore((s) => s.language);
  const isZh = language === 'zh-CN';

  const messageListRef = useRef<MessageListHandle | null>(null);
  const composerRef = useRef<CanonicalComposerHandle | null>(null);

  const [highlightedMessageId, setHighlightedMessageId] = useState<number | null>(null);
  const [startedBotChats, setStartedBotChats] = useState<Record<number, boolean>>({});

  const activeChat = activeChatId !== null ? (chatsById[activeChatId] ?? null) : null;

  useEffect(() => {
    setHighlightedMessageId(null);
  }, [activeChatId]);

  const activeBotMeta = useMemo<BotRegistryEntry | undefined>(() => {
    if (!activeChat || (!activeChat.isBot && activeChat.kind !== 'bot')) return undefined;
    return bots.find(
      (b) =>
        (activeChat.peerUserId !== undefined && b.bot_user_id === activeChat.peerUserId) ||
        (activeChat.username &&
          b.username.toLowerCase() === activeChat.username.replace(/^@/, '').toLowerCase()),
    );
  }, [activeChat, bots]);

  const activeChatMessages = useMemo(() => {
    if (!activeChat) return [];
    const raw = messagesByChat[activeChat.chatId] ?? [];
    if (activeTopicId === null) return raw;
    return raw.filter((m) => m.topic_id === activeTopicId || m.id === activeTopicId);
  }, [activeChat, activeTopicId, messagesByChat]);

  const showBotPrestart = Boolean(
    activeChat &&
      (activeChat.isBot || activeChat.kind === 'bot') &&
      activeChatMessages.length === 0 &&
      !isLoadingMessages &&
      !startedBotChats[activeChat.chatId],
  );

  const handleJumpToMessage = useCallback((messageId: number) => {
    void messageListRef.current?.scrollToMessage(messageId);
  }, []);

  const handleRequestDelete = useCallback(
    (messageIds: number[]) => {
      if (!activeChat) return;
      openModal('delete_confirm', {
        chatId: activeChat.chatId,
        messageIds,
      });
    },
    [activeChat, openModal],
  );

  const handleRequestForward = useCallback(
    (messageIds: number[]) => {
      if (!activeChat) return;
      openModal('forward_messages', {
        fromChatId: activeChat.chatId,
        messageIds,
      });
    },
    [activeChat, openModal],
  );

  const handleRequestCreator = useCallback(
    (kind: 'poll' | 'todo' | 'invoice') => {
      if (!activeChat) return;
      const modalMap = {
        poll: 'create_poll',
        todo: 'create_todo',
        invoice: 'create_invoice',
      } as const;
      openModal(modalMap[kind], { chatId: activeChat.chatId });
    },
    [activeChat, openModal],
  );

  const handleBotStarted = useCallback(() => {
    if (!activeChat) return;
    setStartedBotChats((prev) => ({ ...prev, [activeChat.chatId]: true }));
    window.requestAnimationFrame(() => {
      composerRef.current?.focusInput();
    });
  }, [activeChat]);

  return (
    <section
      id={DOM_IDS.MIDDLE_COLUMN}
      className="tg-middle-column"
      data-wallpaper={wallpaper}
      data-wallpaper-blur={wallpaperBlur ? 'true' : 'false'}
    >
      {appleComposeStageOpen ? (
        <AppleComposeStage />
      ) : !activeChat ? (
        <div
          data-testid="middle-empty-state"
          style={{
            flex: '1 1 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
          }}
        >
          <div
            style={{
              padding: '10px 20px',
              borderRadius: '999px',
              backgroundColor: 'var(--tg-bg-elevated)',
              border: '1px solid var(--tg-hairline-border)',
              color: 'var(--tg-text-secondary)',
              fontSize: '13.5px',
              fontWeight: 500,
            }}
          >
            {isZh
              ? '选择会话开始聊天 · Select a chat to start messaging'
              : 'Select a chat to start messaging · 选择会话开始聊天'}
          </div>
        </div>
      ) : (
        <>
          <ChatHeader
            chat={activeChat}
            botMeta={activeBotMeta}
            onOpenLocalCreator={handleRequestCreator}
          />
          <InChatSearchBar
            chatId={activeChat.chatId}
            onJumpToMessage={handleJumpToMessage}
          />
          <PinnedBanner
            chatId={activeChat.chatId}
            onJumpToMessage={handleJumpToMessage}
          />
          <RoomAgentFloorBanner chatId={activeChat.chatId} />

          {/* Stage Viewport Slot — shrinks dynamically above Composer / BotPreStartBar! */}
          <div id="app-shell-stage-slot" className="tg-stage-slot">
            <MessageList
              ref={messageListRef}
              chat={activeChat}
              botMeta={activeBotMeta}
              showBotPrestart={showBotPrestart}
              highlightedMessageId={highlightedMessageId}
              onHighlightMessage={setHighlightedMessageId}
              onDropFiles={(files) =>
                void composerRef.current?.handleIncomingFiles(files)
              }
              onRequestForward={handleRequestForward}
              onRequestDelete={handleRequestDelete}
            />
            <StageToastLayer chatId={activeChat.chatId} />
          </div>

          <SelectionToolbar
            chatId={activeChat.chatId}
            onRequestForward={handleRequestForward}
            onRequestDelete={handleRequestDelete}
          />

          {showBotPrestart ? (
            <BotPreStartBar chat={activeChat} onStarted={handleBotStarted} />
          ) : (
            <CanonicalComposer
              ref={composerRef}
              chat={activeChat}
              botMeta={activeBotMeta}
              onSentScrollToBottom={() => messageListRef.current?.scrollToBottom()}
              onOpenLocalCreator={handleRequestCreator}
            />
          )}
        </>
      )}
    </section>
  );
};
