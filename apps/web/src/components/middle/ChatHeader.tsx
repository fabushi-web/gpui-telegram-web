import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DOM_IDS,
  extractPlainTextFromContent,
  peerAvatarColorIndex,
  type BotRegistryEntry,
  type ChatSummary,
} from '@gpui-telegram/protocol';
import { getClientAdapter } from '../../adapters';
import { t } from '../../i18n';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';
import { GrokBotAvatar } from '../common/GrokBotAvatar';

export interface ChatHeaderProps {
  chat: ChatSummary;
  botMeta?: BotRegistryEntry;
  onOpenLocalCreator?: (kind: 'poll' | 'todo' | 'invoice') => void;
}

const AVATAR_PALETTE = [
  '#E15B64',
  '#E86C52',
  '#E5A030',
  '#00BA69',
  '#3FC1B0',
  '#29B6F6',
  '#0A84FF',
];

function formatTtlShort(seconds?: number): string {
  if (!seconds || seconds <= 0) return 'Off';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function getInitials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return Array.from(words[0]!)[0]?.toUpperCase() ?? '?';
  return `${Array.from(words[0]!)[0] ?? ''}${Array.from(words[1]!)[0] ?? ''}`.toUpperCase();
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({
  chat,
  botMeta,
  onOpenLocalCreator,
}) => {
  const language = useSettingsStore((s) => s.language);
  const isZh = language === 'zh-CN';

  const activeTopicId = useChatStore((s) => s.activeTopicId);
  const topicsByChat = useChatStore((s) => s.topicsByChat);
  const typingByChat = useChatStore((s) => s.typingByChat);
  const peersById = useChatStore((s) => s.peersById);
  const botActivityByChat = useChatStore((s) => s.botActivityByChat);
  const selectChat = useChatStore((s) => s.selectChat);
  const createSecretChat = useChatStore((s) => s.createSecretChat);
  const setChatTtl = useChatStore((s) => s.setChatTtl);
  const updateChatSettings = useChatStore((s) => s.updateChatSettings);
  const clearChatHistory = useChatStore((s) => s.clearChatHistory);
  const deleteOrLeaveChat = useChatStore((s) => s.deleteOrLeaveChat);
  const exportChatHistory = useChatStore((s) => s.exportChatHistory);
  const scheduledMessagesByChat = useChatStore((s) => s.scheduledMessagesByChat);
  const loadScheduledMessages = useChatStore((s) => s.loadScheduledMessages);
  const cancelScheduledMessage = useChatStore((s) => s.cancelScheduledMessage);
  const sendScheduledMessageNow = useChatStore((s) => s.sendScheduledMessageNow);

  const inChatSearchOpen = useUiStore((s) => s.inChatSearchOpen);
  const isRightOpen = useUiStore((s) => s.isRightOpen);
  const setInChatSearchOpen = useUiStore((s) => s.setInChatSearchOpen);
  const setMobilePane = useUiStore((s) => s.setMobilePane);
  const toggleRightSidebar = useUiStore((s) => s.toggleRightSidebar);
  const startOutgoingCall = useUiStore((s) => s.startOutgoingCall);
  const openModal = useUiStore((s) => s.openModal);
  const setMiniAppModalOpen = useUiStore((s) => s.setMiniAppModalOpen);
  const pushToast = useUiStore((s) => s.pushToast);

  const launchMiniApp = useAiWorkspaceStore((s) => s.launchMiniApp);
  const currentUser = useAuthStore((s) => s.currentUser);

  const [moreMenuPos, setMoreMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [ttlMenuPos, setTtlMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState<boolean>(false);
  const [scheduledDrawerOpen, setScheduledDrawerOpen] = useState<boolean>(false);
  const [scheduledBusyId, setScheduledBusyId] = useState<number | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const ttlBtnRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const ttlMenuRef = useRef<HTMLDivElement | null>(null);
  const scheduledItems = scheduledMessagesByChat[chat.chatId] ?? [];

  const renderOverlay = (node: React.ReactNode): React.ReactNode =>
    typeof document !== 'undefined' && document.body ? createPortal(node, document.body) : node;

  useEffect(() => {
    if (!moreMenuPos && !ttlMenuPos) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && moreBtnRef.current?.contains(target)) return;
      if (target && ttlBtnRef.current?.contains(target)) return;
      if (target && moreMenuRef.current?.contains(target)) return;
      if (target && ttlMenuRef.current?.contains(target)) return;
      setMoreMenuPos(null);
      setTtlMenuPos(null);
    };
    window.addEventListener('click', close);
    return () => {
      window.removeEventListener('click', close);
    };
  }, [moreMenuPos, ttlMenuPos]);

  useEffect(() => {
    if (!moreMenuPos && !ttlMenuPos && !scheduledDrawerOpen && !deleteDialogOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (moreMenuPos || ttlMenuPos) {
        setMoreMenuPos(null);
        setTtlMenuPos(null);
      } else if (deleteDialogOpen) {
        setDeleteDialogOpen(false);
      } else if (scheduledDrawerOpen) {
        setScheduledDrawerOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [moreMenuPos, ttlMenuPos, scheduledDrawerOpen, deleteDialogOpen]);

  const typingUsers = typingByChat[chat.chatId] ?? [];
  const isTyping = typingUsers.length > 0;
  const isBot = Boolean(chat.isBot || chat.kind === 'bot');
  const isPureBroadcastChannel = chat.isChannel && !chat.isGroup && !chat.isSupergroup;
  const activeTopic =
    activeTopicId !== null
      ? (topicsByChat[chat.chatId] ?? []).find((tp) => tp.topicId === activeTopicId)
      : undefined;

  const peerUser = chat.peerUserId !== undefined ? peersById[chat.peerUserId] : undefined;
  const botActivity = botActivityByChat[chat.chatId];
  const hasFreshBotActivity = Boolean(
    (isBot || chat.isGroup || chat.isSupergroup) &&
      botActivity &&
      botActivity.state &&
      botActivity.state !== 'idle' &&
      Date.now() - botActivity.updatedAtMs < 45_000,
  );

  let statusText = '';
  if (isTyping) {
    if (typingUsers.length === 1 && (chat.isGroup || chat.isSupergroup)) {
      const typer = peersById[typingUsers[0]!];
      statusText = typer ? `${typer.firstName} is typing…` : 'typing… · 正在输入…';
    } else {
      statusText = 'typing… · 正在输入…';
    }
  } else if (hasFreshBotActivity && botActivity) {
    statusText = botActivity.detail || botActivity.state;
  } else if (chat.isSavedMessages) {
    statusText = isZh ? '云端个人收藏' : 'Cloud personal notes';
  } else if (chat.isSecret) {
    const ttlPart = chat.ttlSeconds ? ` · ⏱ ${formatTtlShort(chat.ttlSeconds)}` : '';
    const fpPart =
      chat.emojiFingerprint && chat.emojiFingerprint.length > 0
        ? ` · ${chat.emojiFingerprint.join('')}`
        : '';
    statusText = `E2EE Secret Chat${ttlPart}${fpPart}`;
  } else if (isPureBroadcastChannel) {
    const subs = Math.max(1, chat.memberCount || 1);
    statusText = `${subs.toLocaleString()} subscribers · ${subs} 订阅者`;
  } else if (chat.isGroup || chat.isSupergroup) {
    const members = Math.max(1, chat.memberCount || 1);
    statusText = `${members.toLocaleString()} members · ${members} 位成员`;
  } else if (isBot) {
    statusText = botMeta?.coding_agent
      ? `bot · Coding Agent (${botMeta.coding_agent.provider_kind})`
      : 'bot · 智能体';
  } else if (peerUser?.status === 'online') {
    statusText = 'online · 在线';
  } else {
    statusText = isZh ? '最近在线' : 'last seen recently';
  }

  const avatarBg =
    AVATAR_PALETTE[peerAvatarColorIndex(chat.peerUserId ?? chat.chatId)] ?? '#0A84FF';
  const avatarPhotoUrl = chat.photoFileId
    ? getClientAdapter().getMediaStreamUrl(chat.photoFileId)
    : undefined;

  const handleStartCall = async (isVideo: boolean) => {
    const localUserId = currentUser?.userId ?? 1;
    const calleeId = chat.peerUserId ?? chat.chatId;
    try {
      await startOutgoingCall({
        calleeId,
        localUserId,
        isVideo,
        chatId: chat.chatId,
      });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Unable to start call', 'error');
    }
  };

  const handleOpenMoreMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setTtlMenuPos(null);
    if (moreMenuPos) {
      setMoreMenuPos(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const menuWidth = 248;
    const menuHeight = 390;
    const x = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8));
    const y = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - menuHeight - 8));
    setMoreMenuPos({ x, y });
  };

  const handleOpenTtlMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setMoreMenuPos(null);
    if (ttlMenuPos) {
      setTtlMenuPos(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setTtlMenuPos({
      x: Math.max(8, Math.min(rect.left, window.innerWidth - 200)),
      y: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 240)),
    });
  };

  const ttlChoices: Array<{ label: string; secs: number }> = [
    { label: 'Off', secs: 0 },
    { label: '5s', secs: 5 },
    { label: '10s', secs: 10 },
    { label: '30s', secs: 30 },
    { label: '1m', secs: 60 },
    { label: '1h', secs: 3600 },
  ];

  const botSourceId =
    botMeta?.agent_id || botMeta?.username || chat.username || String(chat.peerUserId ?? chat.chatId);

  return (
    <header id={DOM_IDS.CHAT_HEADER} className="tg-chat-header">
      {/* Left Zone: Mobile Back + Topic Pill + Explicit Secret Chat TTL Button (Trap #15) */}
      <div className="tg-chat-header-left">
        <button
          id={DOM_IDS.BTN_BACK_TO_CHATS}
          type="button"
          aria-label="Back to chats"
          onClick={() => setMobilePane('left')}
          className="tg-icon-btn"
          style={{ border: '1px solid var(--tg-hairline-border)', fontSize: '15px' }}
        >
          ←
        </button>

        {chat.isSecret && (
          <button
            ref={ttlBtnRef}
            type="button"
            data-testid="chat-ttl-badge"
            aria-label="Self-Destruct Timer (TTL)"
            aria-haspopup="menu"
            aria-expanded={Boolean(ttlMenuPos)}
            onClick={handleOpenTtlMenu}
            className="tg-btn tg-btn--secondary"
            style={{
              padding: '3px 9px',
              borderRadius: 'var(--tg-radius-pill)',
              fontSize: '11.5px',
              fontWeight: 600,
              color: 'var(--tg-accent)',
            }}
          >
            ⏱ {formatTtlShort(chat.ttlSeconds)}
          </button>
        )}

        {activeTopic && (
          <button
            type="button"
            data-testid="active-topic-badge"
            onClick={(e) => {
              e.stopPropagation();
              void selectChat(chat.chatId, null);
            }}
            title="Clear topic filter"
            style={{
              padding: '2px 9px',
              borderRadius: 'var(--tg-radius-pill)',
              backgroundColor: 'var(--tg-success-soft)',
              color: 'var(--tg-success)',
              fontSize: '11.5px',
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {activeTopic.iconEmoji ?? '#'} {activeTopic.title} ×
          </button>
        )}
      </div>

      {/* Center Zone: Centered Apple Messages Identity Stack (#topbar-peer-header) */}
      <div
        id="topbar-peer-header"
        className="tg-chat-header-peer"
        data-inspector-open={String(isRightOpen)}
        role="button"
        tabIndex={0}
        aria-label={isZh ? '查看会话详情' : 'Open chat info'}
        onClick={() => {
          toggleRightSidebar(true, 'info');
          if (window.innerWidth <= 925) {
            setMobilePane('right');
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleRightSidebar(true, 'info');
          }
        }}
      >
        {isBot ? (
          <GrokBotAvatar
            sourceId={botSourceId}
            shape={botMeta?.avatar_shape}
            color={botMeta?.avatar_color}
            sizePx={38}
            state={botActivity?.state}
            initials={getInitials(chat.title)}
            title={chat.title}
          />
        ) : (
          <div
            data-avatar="true"
            className="tg-avatar"
            style={{
              width: '38px',
              height: '38px',
              backgroundColor: avatarBg,
              fontSize: '13px',
            }}
          >
            {avatarPhotoUrl ? (
              <img
                src={avatarPhotoUrl}
                alt={chat.title}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : chat.isSavedMessages ? (
              '🔖'
            ) : (
              getInitials(chat.title)
            )}
          </div>
        )}

        <div className="tg-header-identity-pill">
          <span id={DOM_IDS.CHAT_HEADER_TITLE}>
            {chat.isSecret ? `🔒 ${chat.title}` : chat.title}
          </span>
          {(chat.isVerified || peerUser?.isVerified) && (
            <span
              title="Verified"
              aria-label="Verified"
              style={{ color: 'var(--tg-accent)', fontSize: '11.5px', flexShrink: 0 }}
            >
              ✓
            </span>
          )}
          {chat.isMuted && (
            <span
              title="Muted"
              style={{ color: 'var(--tg-text-secondary)', fontSize: '11px', flexShrink: 0 }}
            >
              🔕
            </span>
          )}
          <span
            aria-hidden="true"
            style={{ color: 'var(--tg-text-secondary)', fontSize: '11px', flexShrink: 0 }}
          >
            ›
          </span>
        </div>

        <div
          id={DOM_IDS.CHAT_HEADER_STATUS}
          data-typing={isTyping || hasFreshBotActivity ? 'true' : 'false'}
        >
          {statusText}
        </div>
      </div>

      {/* Right Zone: Floating Translucent Actions Pill (#topbar-right-actions-pill) */}
      <div className="tg-chat-header-right">
        <div id="topbar-right-actions-pill" className="tg-chat-header-actions">
          {scheduledItems.length > 0 && (
            <button
              id="btn-scheduled-messages"
              type="button"
              data-testid="btn-scheduled-messages"
              aria-label={t('scheduled.title', language)}
              title={t('scheduled.count', language, { count: scheduledItems.length })}
              onClick={() => {
                setScheduledDrawerOpen(true);
                void loadScheduledMessages(chat.chatId).catch(() => []);
              }}
              className="tg-icon-btn"
              style={{
                height: '32px',
                padding: '0 8px',
                borderRadius: '999px',
                fontSize: '12px',
                fontWeight: 600,
                gap: '4px',
                color: 'var(--tg-accent)',
              }}
            >
              <span aria-hidden="true">📅</span>
              <span>{scheduledItems.length}</span>
            </button>
          )}

          <button
            id={DOM_IDS.BTN_IN_CHAT_SEARCH}
            type="button"
            aria-label="Search in chat"
            aria-pressed={inChatSearchOpen}
            title="Search in chat"
            onClick={() => setInChatSearchOpen(!inChatSearchOpen)}
            className={`tg-icon-btn ${inChatSearchOpen ? 'is-active' : ''}`.trim()}
            style={{ width: '32px', height: '32px', fontSize: '15px' }}
          >
            🔍
          </button>

          {!isPureBroadcastChannel && !chat.isSavedMessages && !isBot && (
            <>
              <button
                id={DOM_IDS.BTN_START_AUDIO_CALL}
                type="button"
                aria-label="Start audio call"
                title="Audio Call"
                onClick={() => void handleStartCall(false)}
                className="tg-icon-btn"
                style={{ width: '32px', height: '32px', fontSize: '15px' }}
              >
                📞
              </button>
              <button
                id={DOM_IDS.BTN_START_VIDEO_CALL}
                type="button"
                aria-label="Start video call"
                title="Video Call"
                onClick={() => void handleStartCall(true)}
                className="tg-icon-btn"
                style={{ width: '32px', height: '32px', fontSize: '15px' }}
              >
                📹
              </button>
            </>
          )}

          <button
            id={DOM_IDS.BTN_TOGGLE_RIGHT_COLUMN}
            type="button"
            aria-label="Toggle profile sidebar"
            aria-pressed={isRightOpen}
            title="Chat Info"
            onClick={() => toggleRightSidebar()}
            className={`tg-icon-btn ${isRightOpen ? 'is-active' : ''}`.trim()}
            style={{ width: '32px', height: '32px', fontSize: '15px' }}
          >
            ◫
          </button>

          <button
            ref={moreBtnRef}
            id={DOM_IDS.BTN_CHAT_MORE}
            type="button"
            aria-label="More chat actions"
            aria-haspopup="menu"
            aria-expanded={Boolean(moreMenuPos)}
            title="More actions"
            onClick={handleOpenMoreMenu}
            className={`tg-icon-btn ${moreMenuPos ? 'is-active' : ''}`.trim()}
            style={{ width: '32px', height: '32px', fontSize: '15px' }}
          >
            ⋮
          </button>
        </div>
      </div>

      {/* Explicit Secret Chat TTL Menu (Trap #15: role="menu" / role="menuitem") */}
      {ttlMenuPos &&
        renderOverlay(
          <div
            ref={ttlMenuRef}
            role="menu"
            data-testid="secret-ttl-menu"
            aria-label="Self-Destruct Timer (TTL)"
            className="tg-context-menu"
            onClick={(e) => e.stopPropagation()}
            style={{
              left: `${ttlMenuPos.x}px`,
              top: `${ttlMenuPos.y}px`,
              minWidth: '176px',
            }}
          >
            {ttlChoices.map((choice) => {
              const active = (chat.ttlSeconds ?? 0) === choice.secs;
              return (
                <button
                  key={choice.secs}
                  type="button"
                  role="menuitem"
                  aria-label={`Self-Destruct ${choice.label}`}
                  onClick={() => {
                    setTtlMenuPos(null);
                    void setChatTtl(chat.chatId, choice.secs);
                  }}
                  className="tg-context-menu-item"
                  style={{
                    justifyContent: 'space-between',
                    color: active ? 'var(--tg-accent)' : undefined,
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  <span>⏱ {choice.label}</span>
                  {active && <span>✓</span>}
                </button>
              );
            })}
          </div>,
        )}

      {/* Viewport-Clamped Chat More Menu */}
      {moreMenuPos &&
        renderOverlay(
          <div
            ref={moreMenuRef}
            role="menu"
            data-testid="context-menu"
            aria-label="Chat options"
            className="tg-context-menu"
            onClick={(e) => e.stopPropagation()}
          style={{
            left: `${moreMenuPos.x}px`,
            top: `${moreMenuPos.y}px`,
            width: '248px',
          }}
        >
          {!chat.isSecret && !chat.isGroup && !chat.isChannel && !chat.isSavedMessages && !isBot && (
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                setMoreMenuPos(null);
                const secret = await createSecretChat(chat.peerUserId ?? chat.chatId, 30);
                await selectChat(secret.chatId);
              }}
              className="tg-context-menu-item"
            >
              🔒 Start Secret Chat
            </button>
          )}

          {/* Self-Destruct Timer TTL Selector */}
          <div
            style={{
              padding: '5px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              borderBottom: '1px solid var(--tg-border-subtle)',
              marginBottom: '2px',
            }}
          >
            <span style={{ fontSize: '11px', color: 'var(--tg-text-secondary)' }}>
              ⏱ Self-Destruct Timer (TTL)
            </span>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {ttlChoices.map((choice) => {
                const active = (chat.ttlSeconds ?? 0) === choice.secs;
                return (
                  <button
                    key={choice.secs}
                    type="button"
                    role="menuitem"
                    aria-label={`Self-Destruct ${choice.label}`}
                    onClick={() => {
                      setMoreMenuPos(null);
                      void setChatTtl(chat.chatId, choice.secs);
                    }}
                    style={{
                      padding: '2px 7px',
                      borderRadius: '5px',
                      border: active
                        ? '1px solid var(--tg-accent)'
                        : '1px solid var(--tg-hairline-border)',
                      backgroundColor: active ? 'var(--tg-accent-soft)' : 'transparent',
                      color: active ? 'var(--tg-accent)' : 'var(--tg-text-primary)',
                      fontSize: '11px',
                    }}
                  >
                    {choice.label}
                  </button>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMoreMenuPos(null);
              openModal('create_poll', { chatId: chat.chatId });
              onOpenLocalCreator?.('poll');
            }}
            className="tg-context-menu-item"
          >
            📊 Create Poll · 发起投票
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMoreMenuPos(null);
              openModal('create_todo', { chatId: chat.chatId });
              onOpenLocalCreator?.('todo');
            }}
            className="tg-context-menu-item"
          >
            ☑️ Create Todo · 待办清单
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMoreMenuPos(null);
              openModal('create_invoice', { chatId: chat.chatId });
              onOpenLocalCreator?.('invoice');
            }}
            className="tg-context-menu-item"
          >
            💳 Create Invoice · 创建账单
          </button>

          <button
            type="button"
            role="menuitem"
            data-testid="chat-more-scheduled"
            onClick={() => {
              setMoreMenuPos(null);
              setScheduledDrawerOpen(true);
              void loadScheduledMessages(chat.chatId).catch(() => []);
            }}
            className="tg-context-menu-item"
          >
            📅 {t('scheduled.title', language)}
            {scheduledItems.length > 0 ? ` (${scheduledItems.length})` : ''}
          </button>

          {/* Non-colliding data-testid; canonical #btn-export-chat-json / html live visibly in RightColumn (Trap #14) */}
          <button
            type="button"
            role="menuitem"
            data-testid="chat-more-export-json"
            onClick={() => {
              setMoreMenuPos(null);
              void exportChatHistory(chat.chatId, 'json');
            }}
            className="tg-context-menu-item"
          >
            ⬇ Export Chat JSON
          </button>

          <button
            type="button"
            role="menuitem"
            data-testid="chat-more-export-html"
            onClick={() => {
              setMoreMenuPos(null);
              void exportChatHistory(chat.chatId, 'html');
            }}
            className="tg-context-menu-item"
          >
            ⬇ Export Chat HTML
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMoreMenuPos(null);
              if (botMeta?.has_main_app && botMeta.username && botMeta.main_app_short_name) {
                setMiniAppModalOpen(true);
                void launchMiniApp(
                  botMeta.username,
                  botMeta.main_app_short_name,
                  chat.chatId,
                ).catch(() => {
                  openModal('miniapp_catalog', { chatId: chat.chatId });
                });
              } else {
                openModal('miniapp_catalog', { chatId: chat.chatId });
              }
            }}
            className="tg-context-menu-item"
          >
            🧩 Open Mini App
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMoreMenuPos(null);
              void updateChatSettings(chat.chatId, { isMuted: !chat.isMuted });
            }}
            className="tg-context-menu-item"
          >
            {chat.isMuted ? '🔔 Unmute Chat' : '🔕 Mute Chat'}
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMoreMenuPos(null);
              void clearChatHistory(chat.chatId, false);
            }}
            className="tg-context-menu-item"
          >
            🧹 Clear History
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMoreMenuPos(null);
              setDeleteDialogOpen(true);
            }}
            className="tg-context-menu-item is-danger"
          >
            🗑 {chat.isGroup || chat.isChannel ? 'Leave Chat' : 'Delete Chat'}
          </button>
        </div>,
        )}

      {/* Confirmation dialog before deleting/leaving active chat */}
      {deleteDialogOpen &&
        renderOverlay(
          <div
            className="tg-modal-overlay"
            onClick={(e) => {
              e.stopPropagation();
              setDeleteDialogOpen(false);
            }}
          >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={chat.isGroup || chat.isChannel ? 'Leave Chat' : 'Delete Chat'}
            className="tg-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tg-modal-header">
              <span>{chat.isGroup || chat.isChannel ? 'Leave Chat' : 'Delete Chat'}</span>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setDeleteDialogOpen(false)}
                className="tg-icon-btn"
              >
                ✕
              </button>
            </div>
            <div className="tg-modal-body" style={{ fontSize: '13.5px' }}>
              {isZh
                ? `确定要${chat.isGroup || chat.isChannel ? '退出' : '删除'}「${chat.title}」吗？`
                : `Are you sure you want to ${chat.isGroup || chat.isChannel ? 'leave' : 'delete'} "${chat.title}"?`}
            </div>
            <div className="tg-modal-footer">
              <button
                type="button"
                onClick={() => setDeleteDialogOpen(false)}
                className="tg-btn tg-btn--secondary"
              >
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDeleteDialogOpen(false);
                  void deleteOrLeaveChat(chat.chatId);
                }}
                className="tg-btn tg-btn--danger"
              >
                {chat.isGroup || chat.isChannel ? 'Leave' : 'Delete'}
              </button>
            </div>
          </div>
        </div>,
        )}
      {/* Scheduled Messages Drawer */}
      {scheduledDrawerOpen &&
        renderOverlay(
          <div
            className="tg-scheduled-drawer-backdrop"
            onClick={(e) => {
              e.stopPropagation();
              setScheduledDrawerOpen(false);
            }}
          >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('scheduled.title', language)}
            data-testid="scheduled-messages-drawer"
            className="tg-scheduled-drawer"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tg-modal-header">
              <span>
                📅 {t('scheduled.title', language)} ({scheduledItems.length})
              </span>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setScheduledDrawerOpen(false)}
                className="tg-icon-btn"
              >
                ✕
              </button>
            </div>
            <div style={{ overflowY: 'auto', flex: '1 1 auto' }}>
              {scheduledItems.length === 0 ? (
                <div
                  style={{
                    padding: '28px 16px',
                    textAlign: 'center',
                    color: 'var(--tg-text-secondary)',
                    fontSize: '13px',
                  }}
                >
                  {t('scheduled.empty', language)}
                </div>
              ) : (
                scheduledItems.map((item) => {
                  const body =
                    item.text?.trim() ||
                    extractPlainTextFromContent(item.content) ||
                    `Message #${item.message_id}`;
                  const scheduledTime = new Date(item.scheduled_at_ms).toLocaleString(
                    language === 'zh-CN' ? 'zh-CN' : 'en-US',
                    {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    },
                  );
                  const busy = scheduledBusyId === item.message_id;
                  return (
                    <div
                      key={item.message_id}
                      data-testid="scheduled-message-item"
                      data-message-id={String(item.message_id)}
                      className="tg-scheduled-item-row"
                    >
                      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
                        <div
                          style={{
                            fontSize: '13.5px',
                            color: 'var(--tg-text-primary)',
                            overflowWrap: 'anywhere',
                          }}
                        >
                          {body}
                        </div>
                        <div
                          style={{
                            marginTop: '3px',
                            fontSize: '11.5px',
                            color: 'var(--tg-text-secondary)',
                          }}
                        >
                          ⏰ {scheduledTime}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                        <button
                          type="button"
                          disabled={busy}
                          data-testid="btn-scheduled-send-now"
                          onClick={async () => {
                            setScheduledBusyId(item.message_id);
                            try {
                              await sendScheduledMessageNow(chat.chatId, item.message_id);
                              pushToast(t('scheduled.sendNow', language), 'success', {
                                scope: 'stage',
                                chatId: chat.chatId,
                              });
                            } catch (err) {
                              pushToast(
                                err instanceof Error ? err.message : String(err),
                                'error',
                              );
                            } finally {
                              setScheduledBusyId(null);
                            }
                          }}
                          className="tg-btn tg-btn--primary"
                          style={{ padding: '4px 10px', fontSize: '12px' }}
                        >
                          {t('scheduled.sendNow', language)}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          data-testid="btn-scheduled-cancel"
                          onClick={async () => {
                            setScheduledBusyId(item.message_id);
                            try {
                              await cancelScheduledMessage(chat.chatId, item.message_id);
                              pushToast(t('scheduled.cancel', language), 'info', {
                                scope: 'stage',
                                chatId: chat.chatId,
                              });
                            } catch (err) {
                              pushToast(
                                err instanceof Error ? err.message : String(err),
                                'error',
                              );
                            } finally {
                              setScheduledBusyId(null);
                            }
                          }}
                          className="tg-btn tg-btn--danger"
                          style={{ padding: '4px 10px', fontSize: '12px' }}
                        >
                          {t('scheduled.cancel', language)}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>,
        )}
    </header>
  );
};
