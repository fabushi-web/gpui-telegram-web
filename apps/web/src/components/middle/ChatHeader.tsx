import React, { useEffect, useRef, useState } from 'react';
import {
  DOM_IDS,
  peerAvatarColorIndex,
  type ChatSummary,
} from '@gpui-telegram/protocol';
import { getClientAdapter } from '../../adapters';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useUiStore } from '../../store/useUiStore';

export interface ChatHeaderProps {
  chat: ChatSummary;
  onOpenLocalCreator?: (kind: 'poll' | 'todo' | 'invoice') => void;
}

const AVATAR_PALETTE = [
  '#3390EC',
  '#00C972',
  '#E5A030',
  '#E86C52',
  '#E15B64',
  '#3FC1B0',
  '#29B6F6',
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
  onOpenLocalCreator,
}) => {
  const activeTopicId = useChatStore((s) => s.activeTopicId);
  const topicsByChat = useChatStore((s) => s.topicsByChat);
  const typingByChat = useChatStore((s) => s.typingByChat);
  const peersById = useChatStore((s) => s.peersById);
  const selectChat = useChatStore((s) => s.selectChat);
  const createSecretChat = useChatStore((s) => s.createSecretChat);
  const setChatTtl = useChatStore((s) => s.setChatTtl);
  const updateChatSettings = useChatStore((s) => s.updateChatSettings);
  const clearChatHistory = useChatStore((s) => s.clearChatHistory);
  const deleteOrLeaveChat = useChatStore((s) => s.deleteOrLeaveChat);
  const exportChatHistory = useChatStore((s) => s.exportChatHistory);

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

  const [moreMenuPos, setMoreMenuPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!moreMenuPos) return;
    const close = (e: MouseEvent) => {
      if (moreBtnRef.current && moreBtnRef.current.contains(e.target as Node)) {
        return;
      }
      setMoreMenuPos(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMoreMenuPos(null);
      }
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onEsc);
    };
  }, [moreMenuPos]);

  const typingUsers = typingByChat[chat.chatId] ?? [];
  const isTyping = typingUsers.length > 0;
  const isPureBroadcastChannel =
    chat.isChannel && !chat.isGroup && !chat.isSupergroup;
  const activeTopic =
    activeTopicId !== null
      ? (topicsByChat[chat.chatId] ?? []).find(
          (tp) => tp.topicId === activeTopicId,
        )
      : undefined;

  const peerUser =
    chat.peerUserId !== undefined ? peersById[chat.peerUserId] : undefined;

  let statusText = '';
  if (isTyping) {
    if (typingUsers.length === 1 && (chat.isGroup || chat.isSupergroup)) {
      const typer = peersById[typingUsers[0]!];
      statusText = typer
        ? `${typer.firstName} is typing…`
        : 'typing… · 正在输入…';
    } else {
      statusText = 'typing… · 正在输入…';
    }
  } else if (chat.isSavedMessages) {
    statusText = 'Cloud personal notes';
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
  } else if (chat.isBot) {
    statusText = 'bot · 机器人';
  } else if (peerUser?.status === 'online') {
    statusText = 'online · 在线';
  } else {
    statusText = 'last seen recently';
  }

  const avatarBg =
    AVATAR_PALETTE[peerAvatarColorIndex(chat.peerUserId ?? chat.chatId)] ??
    '#3390EC';
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
      pushToast(
        err instanceof Error ? err.message : 'Unable to start call',
        'error',
      );
    }
  };

  const handleOpenMoreMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (moreMenuPos) {
      setMoreMenuPos(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const menuWidth = 248;
    const menuHeight = 390;
    const x = Math.max(
      8,
      Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8),
    );
    const y = Math.max(
      8,
      Math.min(rect.bottom + 6, window.innerHeight - menuHeight - 8),
    );
    setMoreMenuPos({ x, y });
  };

  const ttlChoices: Array<{ label: string; secs: number }> = [
    { label: 'Off', secs: 0 },
    { label: '5s', secs: 5 },
    { label: '30s', secs: 30 },
    { label: '1m', secs: 60 },
    { label: '1h', secs: 3600 },
  ];

  return (
    <header
      id={DOM_IDS.CHAT_HEADER}
      className="tg-chat-header"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        minHeight: '56px',
        padding: '6px 14px',
        backgroundColor: 'var(--tg-bg-surface, #17212B)',
        borderBottom: '1px solid var(--tg-border, #242F3D)',
        flexShrink: 0,
        position: 'relative',
        zIndex: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: '1 1 auto' }}>
        {/* Back button for mobile/tablet <=925px */}
        <button
          id={DOM_IDS.BTN_BACK_TO_CHATS}
          type="button"
          aria-label="Back to chats"
          onClick={() => setMobilePane('left')}
          style={{
            padding: '6px 10px',
            borderRadius: '8px',
            border: '1px solid var(--tg-border, #242F3D)',
            backgroundColor: 'transparent',
            color: 'var(--tg-text-primary, #F5F5F5)',
            fontSize: '15px',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          ←
        </button>

        {/* Peer Avatar + Title + Status */}
        <div
          className="tg-chat-header-peer"
          role="button"
          tabIndex={0}
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
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            minWidth: 0,
            flex: '1 1 auto',
            cursor: 'pointer',
          }}
        >
          <div
            data-avatar="true"
            className="tg-avatar"
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              backgroundColor: avatarBg,
              color: '#FFFFFF',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: '14px',
              flexShrink: 0,
              overflow: 'hidden',
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

          <div style={{ minWidth: 0, flex: '1 1 auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
              <span
                id={DOM_IDS.CHAT_HEADER_TITLE}
                style={{
                  fontSize: '15px',
                  fontWeight: 600,
                  color: 'var(--tg-text-primary, #F5F5F5)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {chat.isSecret ? `🔒 ${chat.title}` : chat.title}
              </span>

              {(chat.isVerified || peerUser?.isVerified) && (
                <span
                  title="Verified"
                  aria-label="Verified"
                  style={{
                    color: 'var(--tg-accent, #3390EC)',
                    fontSize: '13px',
                    flexShrink: 0,
                  }}
                >
                  ✓
                </span>
              )}

              {chat.isMuted && (
                <span
                  title="Muted"
                  style={{ color: 'var(--tg-text-secondary, #7F91A4)', fontSize: '12px' }}
                >
                  🔕
                </span>
              )}

              {Boolean(chat.ttlSeconds && chat.ttlSeconds > 0) && (
                <span
                  data-testid="chat-ttl-badge"
                  style={{
                    padding: '1px 6px',
                    borderRadius: '999px',
                    backgroundColor: 'rgba(51, 144, 236, 0.16)',
                    color: 'var(--tg-accent, #3390EC)',
                    fontSize: '11px',
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  ⏱ {formatTtlShort(chat.ttlSeconds)}
                </span>
              )}

              {activeTopic && (
                <span
                  data-testid="active-topic-badge"
                  onClick={(e) => {
                    e.stopPropagation();
                    void selectChat(chat.chatId, null);
                  }}
                  title="Clear topic filter"
                  style={{
                    padding: '1px 8px',
                    borderRadius: '999px',
                    backgroundColor: 'rgba(0, 201, 114, 0.16)',
                    color: '#00C972',
                    fontSize: '11px',
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  {activeTopic.iconEmoji ?? '#'} {activeTopic.title} ×
                </span>
              )}
            </div>

            <div
              id={DOM_IDS.CHAT_HEADER_STATUS}
              data-typing={isTyping ? 'true' : 'false'}
              style={{
                fontSize: '12px',
                color: isTyping
                  ? 'var(--tg-accent, #3390EC)'
                  : 'var(--tg-text-secondary, #7F91A4)',
                fontWeight: isTyping ? 500 : 400,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {statusText}
            </div>
          </div>
        </div>
      </div>

      {/* Header Action Buttons */}
      <div className="tg-chat-header-actions" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <button
          id={DOM_IDS.BTN_IN_CHAT_SEARCH}
          type="button"
          aria-label="Search in chat"
          aria-pressed={inChatSearchOpen}
          title="Search in chat"
          onClick={() => setInChatSearchOpen(!inChatSearchOpen)}
          style={headerIconBtnStyle(inChatSearchOpen)}
        >
          🔍
        </button>

        {!isPureBroadcastChannel && !chat.isSavedMessages && (
          <>
            <button
              id={DOM_IDS.BTN_START_AUDIO_CALL}
              type="button"
              aria-label="Start audio call"
              title="Audio Call"
              onClick={() => void handleStartCall(false)}
              style={headerIconBtnStyle(false)}
            >
              📞
            </button>
            <button
              id={DOM_IDS.BTN_START_VIDEO_CALL}
              type="button"
              aria-label="Start video call"
              title="Video Call"
              onClick={() => void handleStartCall(true)}
              style={headerIconBtnStyle(false)}
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
          style={headerIconBtnStyle(isRightOpen)}
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
          style={headerIconBtnStyle(Boolean(moreMenuPos))}
        >
          ⋮
        </button>
      </div>

      {/* Viewport-Clamped Chat More Menu */}
      {moreMenuPos && (
        <div
          role="menu"
          data-testid="context-menu"
          aria-label="Chat options"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: `${moreMenuPos.x}px`,
            top: `${moreMenuPos.y}px`,
            width: '248px',
            backgroundColor: 'var(--tg-bg-surface, #17212B)',
            border: '1px solid var(--tg-border, #242F3D)',
            borderRadius: '10px',
            padding: '6px',
            boxShadow: '0 14px 36px rgba(0, 0, 0, 0.48)',
            zIndex: 1300,
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          }}
        >
          {!chat.isSecret && !chat.isGroup && !chat.isChannel && !chat.isSavedMessages && (
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                setMoreMenuPos(null);
                const secret = await createSecretChat(
                  chat.peerUserId ?? chat.chatId,
                  30,
                );
                await selectChat(secret.chatId);
              }}
              style={menuItemBtnStyle(false)}
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
              borderBottom: '1px solid var(--tg-border, #242F3D)',
              marginBottom: '2px',
            }}
          >
            <span style={{ fontSize: '11px', color: 'var(--tg-text-secondary, #7F91A4)' }}>
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
                        ? '1px solid var(--tg-accent, #3390EC)'
                        : '1px solid var(--tg-border, #242F3D)',
                      backgroundColor: active
                        ? 'rgba(51, 144, 236, 0.2)'
                        : 'transparent',
                      color: active
                        ? 'var(--tg-accent, #3390EC)'
                        : 'var(--tg-text-primary, #F5F5F5)',
                      fontSize: '11px',
                      cursor: 'pointer',
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
            style={menuItemBtnStyle(false)}
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
            style={menuItemBtnStyle(false)}
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
            style={menuItemBtnStyle(false)}
          >
            💳 Create Invoice · 创建账单
          </button>

          <button
            id={DOM_IDS.BTN_EXPORT_CHAT_JSON}
            type="button"
            role="menuitem"
            onClick={() => {
              setMoreMenuPos(null);
              void exportChatHistory(chat.chatId, 'json');
            }}
            style={menuItemBtnStyle(false)}
          >
            ⬇ Export Chat JSON
          </button>

          <button
            id={DOM_IDS.BTN_EXPORT_CHAT_HTML}
            type="button"
            role="menuitem"
            onClick={() => {
              setMoreMenuPos(null);
              void exportChatHistory(chat.chatId, 'html');
            }}
            style={menuItemBtnStyle(false)}
          >
            ⬇ Export Chat HTML
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMoreMenuPos(null);
              setMiniAppModalOpen(true);
              void launchMiniApp(
                chat.username || 'storebot',
                'app',
                chat.chatId,
              ).catch(() => {
                openModal('miniapp_catalog', { chatId: chat.chatId });
              });
            }}
            style={menuItemBtnStyle(false)}
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
            style={menuItemBtnStyle(false)}
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
            style={menuItemBtnStyle(false)}
          >
            🧹 Clear History
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMoreMenuPos(null);
              void deleteOrLeaveChat(chat.chatId);
            }}
            style={menuItemBtnStyle(true)}
          >
            🗑 {chat.isGroup || chat.isChannel ? 'Leave Chat' : 'Delete Chat'}
          </button>
        </div>
      )}
    </header>
  );
};

function headerIconBtnStyle(active: boolean): React.CSSProperties {
  return {
    width: '36px',
    height: '36px',
    borderRadius: '8px',
    border: 'none',
    backgroundColor: active ? 'rgba(51, 144, 236, 0.18)' : 'transparent',
    color: active
      ? 'var(--tg-accent, #3390EC)'
      : 'var(--tg-text-secondary, #8FA2B7)',
    fontSize: '16px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  };
}

function menuItemBtnStyle(danger: boolean): React.CSSProperties {
  return {
    width: '100%',
    textAlign: 'left',
    padding: '7px 10px',
    borderRadius: '6px',
    border: 'none',
    backgroundColor: 'transparent',
    color: danger ? '#E15B64' : 'var(--tg-text-primary, #F5F5F5)',
    fontSize: '13px',
    cursor: 'pointer',
  };
}
