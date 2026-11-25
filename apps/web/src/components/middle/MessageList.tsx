import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  DOM_IDS,
  type BotRegistryEntry,
  type ChatSummary,
  type MessageItem,
} from '@gpui-telegram/protocol';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useAuthStore } from '../../store/useAuthStore';
import {
  clearLocalTabSend,
  useChatStore,
  wasSentLocallyInTab,
} from '../../store/useChatStore';
import { BotDescriptionCard } from './BotPreStartBar';
import { MessageBubble } from './MessageBubble';
import { ThinkingBubble } from './MessageCards';

export interface MessageListHandle {
  scrollToMessage: (messageId: number) => Promise<void>;
  scrollToBottom: () => void;
}

export interface MessageListProps {
  chat: ChatSummary;
  botMeta?: BotRegistryEntry;
  showBotPrestart?: boolean;
  highlightedMessageId: number | null;
  onHighlightMessage: (messageId: number | null) => void;
  onDropFiles?: (files: File[]) => void;
  onRequestForward?: (messageIds: number[]) => void;
  onRequestDelete?: (messageIds: number[]) => void;
}

interface SavedScrollSnapshot {
  scrollTop: number;
  atBottom: boolean;
}

// Persistent per-chat scroll state across chat switches
const savedChatScrollMap = new Map<number, SavedScrollSnapshot>();
const seenMessageIdsByChat = new Map<number, Set<number>>();

function getDayKey(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function formatDatePillLabel(tsMs: number): string {
  if (!Number.isFinite(tsMs)) return 'Today';
  const d = new Date(tsMs);
  const now = new Date();
  const todayKey = getDayKey(now.getTime());
  const targetKey = getDayKey(tsMs);
  if (targetKey === todayKey) {
    return 'Today · 今天';
  }
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (targetKey === getDayKey(yesterday.getTime())) {
    return 'Yesterday · 昨天';
  }
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

export const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(
  function MessageList(
    {
      chat,
      botMeta,
      showBotPrestart = false,
      highlightedMessageId,
      onHighlightMessage,
      onDropFiles,
      onRequestForward,
      onRequestDelete,
    },
    ref,
  ) {
    const listRef = useRef<HTMLDivElement | null>(null);
    const isNearBottomRef = useRef<boolean>(true);
    const restoredChatIdRef = useRef<number | null>(null);
    const prevLastMessageIdRef = useRef<number | null>(null);
    const highlightTimerRef = useRef<number | null>(null);

    const messagesByChat = useChatStore((s) => s.messagesByChat);
    const hasMoreByChat = useChatStore((s) => s.hasMoreByChat);
    const activeTopicId = useChatStore((s) => s.activeTopicId);
    const isLoadingMessages = useChatStore((s) => s.isLoadingMessages);
    const loadOlderMessages = useChatStore((s) => s.loadOlderMessages);
    const markChatRead = useChatStore((s) => s.markChatRead);

    const streamingTurn = useAiWorkspaceStore((s) => s.streamingTurn);
    const currentUser = useAuthStore((s) => s.currentUser);

    const [showScrollFab, setShowScrollFab] = useState<boolean>(false);
    const [unreadBelowCount, setUnreadBelowCount] = useState<number>(0);
    const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);

    const rawMessages = messagesByChat[chat.chatId] ?? [];
    const hasMore = Boolean(hasMoreByChat[chat.chatId]);

    const filteredMessages = useMemo<MessageItem[]>(() => {
      const sorted = [...rawMessages].sort((a, b) => a.id - b.id);
      if (activeTopicId === null) {
        return sorted;
      }
      return sorted.filter(
        (m) => m.topic_id === activeTopicId || m.id === activeTopicId,
      );
    }, [activeTopicId, rawMessages]);

    const messageMap = useMemo(() => {
      let seen = seenMessageIdsByChat.get(chat.chatId);
      if (!seen) {
        seen = new Set<number>();
        seenMessageIdsByChat.set(chat.chatId, seen);
      }
      const map = new Map<number, MessageItem>();
      for (const m of rawMessages) {
        map.set(m.id, m);
        seen.add(m.id);
      }
      return map;
    }, [chat.chatId, rawMessages]);

    const minLoadedId =
      rawMessages.length > 0
        ? Math.min(...rawMessages.map((m) => m.id))
        : Number.MAX_SAFE_INTEGER;

    const scrollToBottom = useCallback(() => {
      const el = listRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      isNearBottomRef.current = true;
      setShowScrollFab(false);
      setUnreadBelowCount(0);
      savedChatScrollMap.set(chat.chatId, {
        scrollTop: el.scrollTop,
        atBottom: true,
      });

      const lastMsg = filteredMessages[filteredMessages.length - 1];
      if (lastMsg && chat.unreadCount > 0) {
        void markChatRead(chat.chatId, lastMsg.id);
      }
    }, [chat.chatId, chat.unreadCount, filteredMessages, markChatRead]);

    const triggerHighlight = useCallback(
      (messageId: number) => {
        onHighlightMessage(messageId);
        if (highlightTimerRef.current !== null) {
          window.clearTimeout(highlightTimerRef.current);
        }
        highlightTimerRef.current = window.setTimeout(() => {
          onHighlightMessage(null);
        }, 2600);
      },
      [onHighlightMessage],
    );

    const scrollToMessage = useCallback(
      async (messageId: number) => {
        const tryLocate = (): HTMLElement | null => {
          const root = listRef.current;
          if (!root) return null;
          return root.querySelector<HTMLElement>(
            `[data-testid="message-bubble"][data-message-id="${messageId}"], [data-message-id="${messageId}"]`,
          );
        };

        let targetEl = tryLocate();
        if (!targetEl && hasMore) {
          await loadOlderMessages(chat.chatId);
          await new Promise<void>((resolve) =>
            window.requestAnimationFrame(() => resolve()),
          );
          targetEl = tryLocate();
        }

        if (targetEl) {
          targetEl.scrollIntoView({ block: 'center', behavior: 'auto' });
          triggerHighlight(messageId);
        }
      },
      [chat.chatId, hasMore, loadOlderMessages, triggerHighlight],
    );

    useImperativeHandle(
      ref,
      () => ({
        scrollToMessage,
        scrollToBottom,
      }),
      [scrollToBottom, scrollToMessage],
    );

    // Restore per-chat scroll position on chat switch
    useLayoutEffect(() => {
      const el = listRef.current;
      if (!el) return;

      if (restoredChatIdRef.current !== chat.chatId) {
        if (filteredMessages.length === 0 && isLoadingMessages) {
          return;
        }
        restoredChatIdRef.current = chat.chatId;
        prevLastMessageIdRef.current =
          filteredMessages[filteredMessages.length - 1]?.id ?? null;

        const saved = savedChatScrollMap.get(chat.chatId);
        if (saved && !saved.atBottom) {
          el.scrollTop = saved.scrollTop;
          isNearBottomRef.current = false;
          setShowScrollFab(true);
          window.requestAnimationFrame(() => {
            if (listRef.current && restoredChatIdRef.current === chat.chatId) {
              listRef.current.scrollTop = saved.scrollTop;
            }
          });
        } else {
          el.scrollTop = el.scrollHeight;
          isNearBottomRef.current = true;
          setShowScrollFab(false);
          setUnreadBelowCount(0);
          savedChatScrollMap.set(chat.chatId, {
            scrollTop: el.scrollTop,
            atBottom: true,
          });
          const lastMsg = filteredMessages[filteredMessages.length - 1];
          if (lastMsg && chat.unreadCount > 0) {
            void markChatRead(chat.chatId, lastMsg.id);
          }
        }
      }
    }, [
      chat.chatId,
      chat.unreadCount,
      filteredMessages,
      isLoadingMessages,
      markChatRead,
    ]);

    // Auto-stick to bottom on new message iff near bottom (<=48px) or sent locally in this tab
    useEffect(() => {
      const el = listRef.current;
      if (!el || restoredChatIdRef.current !== chat.chatId) return;

      const newest = filteredMessages[filteredMessages.length - 1];
      const newestId = newest?.id ?? null;
      if (newestId === null || newestId === prevLastMessageIdRef.current) {
        return;
      }

      const prevId = prevLastMessageIdRef.current;
      prevLastMessageIdRef.current = newestId;

      if (prevId !== null && (newestId > prevId || newestId < 0)) {
        const myUid = currentUser?.userId ?? 1;
        const sentByMe = Boolean(
          newest?.flags?.is_out || newest?.sender_id === myUid,
        );
        const sentInThisTab =
          newestId < 0 ||
          newest?.delivery_status === 'sending' ||
          wasSentLocallyInTab(chat.chatId);

        if (isNearBottomRef.current || sentInThisTab) {
          window.requestAnimationFrame(() => {
            if (!listRef.current) return;
            listRef.current.scrollTop = listRef.current.scrollHeight;
            isNearBottomRef.current = true;
            setShowScrollFab(false);
            setUnreadBelowCount(0);
            savedChatScrollMap.set(chat.chatId, {
              scrollTop: listRef.current.scrollTop,
              atBottom: true,
            });
          });
          if (!sentByMe) {
            void markChatRead(chat.chatId, newestId);
          }
        } else {
          setUnreadBelowCount((c) => c + 1);
          setShowScrollFab(true);
        }
      }
    }, [chat.chatId, currentUser?.userId, filteredMessages, markChatRead]);

    // IntersectionObserver read-receipt trigger for visible incoming unread bubbles
    useEffect(() => {
      const root = listRef.current;
      if (!root || chat.unreadCount <= 0 || typeof IntersectionObserver === 'undefined') {
        return;
      }

      const myUid = currentUser?.userId ?? 1;
      const unreadIncoming = filteredMessages.filter(
        (m) =>
          !m.flags?.is_out &&
          m.sender_id !== myUid &&
          m.id > (chat.readInboxMaxId || 0),
      );
      if (unreadIncoming.length === 0) return;

      let highestVisibleId = 0;
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const rawId = Number(
                (entry.target as HTMLElement).getAttribute('data-message-id'),
              );
              if (Number.isFinite(rawId) && rawId > highestVisibleId) {
                highestVisibleId = rawId;
              }
            }
          }
          if (highestVisibleId > (chat.readInboxMaxId || 0)) {
            void markChatRead(chat.chatId, highestVisibleId);
          }
        },
        { root, threshold: 0.6 },
      );

      for (const msg of unreadIncoming) {
        const node = root.querySelector(
          `[data-testid="message-bubble"][data-message-id="${msg.id}"]`,
        );
        if (node) observer.observe(node);
      }

      return () => observer.disconnect();
    }, [
      chat.chatId,
      chat.readInboxMaxId,
      chat.unreadCount,
      currentUser?.userId,
      filteredMessages,
      markChatRead,
    ]);

    const handleScroll = async (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nearBottom = distFromBottom <= 48;

      isNearBottomRef.current = nearBottom;
      setShowScrollFab(!nearBottom);
      if (nearBottom) {
        setUnreadBelowCount(0);
        const lastMsg = filteredMessages[filteredMessages.length - 1];
        if (lastMsg && chat.unreadCount > 0) {
          void markChatRead(chat.chatId, lastMsg.id);
        }
      } else {
        clearLocalTabSend(chat.chatId);
      }

      savedChatScrollMap.set(chat.chatId, {
        scrollTop: el.scrollTop,
        atBottom: nearBottom,
      });

      // Top pagination with zero scroll jump
      if (el.scrollTop <= 36 && hasMore && !isLoadingMessages) {
        const prevHeight = el.scrollHeight;
        const prevTop = el.scrollTop;
        const loaded = await loadOlderMessages(chat.chatId);
        if (loaded && listRef.current) {
          window.requestAnimationFrame(() => {
            if (!listRef.current) return;
            const delta = listRef.current.scrollHeight - prevHeight;
            if (delta > 0) {
              listRef.current.scrollTop = prevTop + delta;
            }
          });
        }
      }
    };

    const myUid = currentUser?.userId ?? 1;
    const firstUnreadMsgId = useMemo(() => {
      if (chat.unreadCount <= 0) return null;
      const first = filteredMessages.find(
        (m) =>
          m.content.type !== 'Service' &&
          !m.flags?.is_out &&
          m.sender_id !== myUid &&
          m.id > (chat.readInboxMaxId || 0),
      );
      return first?.id ?? null;
    }, [chat.readInboxMaxId, chat.unreadCount, filteredMessages, myUid]);

    const showHermesThinking = Boolean(
      streamingTurn &&
        (streamingTurn.isStreaming || streamingTurn.thinkingText) &&
        (chat.isBot ||
          chat.title.toLowerCase().includes('hermes') ||
          chat.username?.toLowerCase().includes('hermes')),
    );

    const seenSet = seenMessageIdsByChat.get(chat.chatId);

    return (
      <div
        style={{
          position: 'relative',
          flex: '1 1 auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          ref={listRef}
          id={DOM_IDS.MESSAGE_LIST}
          className="tg-message-list"
          onScroll={(e) => void handleScroll(e)}
          onDragEnter={(e) => {
            if (e.dataTransfer?.types?.includes('Files')) {
              e.preventDefault();
              setIsDraggingOver(true);
            }
          }}
          onDragOver={(e) => {
            if (e.dataTransfer) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              setIsDraggingOver(true);
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) {
              setIsDraggingOver(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            setIsDraggingOver(false);
            const dropped = Array.from(e.dataTransfer?.files ?? []);
            if (dropped.length > 0) {
              onDropFiles?.(dropped);
            }
          }}
          style={{
            position: 'relative',
            flex: '1 1 auto',
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '12px 16px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          }}
        >
          {isDraggingOver && (
            <div
              data-testid="dropzone-overlay"
              style={{
                position: 'sticky',
                top: '12px',
                zIndex: 25,
                padding: '14px',
                borderRadius: '12px',
                border: '2px dashed var(--tg-accent, #3390EC)',
                backgroundColor: 'rgba(14, 22, 33, 0.88)',
                color: '#7CC2FF',
                textAlign: 'center',
                fontWeight: 600,
                pointerEvents: 'none',
              }}
            >
              Drop files here to send to {chat.title}
            </div>
          )}

          {hasMore && (
            <div style={{ textAlign: 'center', padding: '6px 0' }}>
              <button
                type="button"
                data-testid="btn-load-older"
                disabled={isLoadingMessages}
                onClick={() => void loadOlderMessages(chat.chatId)}
                style={{
                  padding: '4px 12px',
                  borderRadius: '999px',
                  border: '1px solid var(--tg-border, #242F3D)',
                  backgroundColor: 'rgba(14, 22, 33, 0.65)',
                  color: 'var(--tg-text-secondary, #8FA2B7)',
                  fontSize: '12px',
                  cursor: 'pointer',
                }}
              >
                {isLoadingMessages ? 'Loading history…' : 'Load earlier messages'}
              </button>
            </div>
          )}

          {filteredMessages.length === 0 && !isLoadingMessages && (
            showBotPrestart ? (
              <BotDescriptionCard chat={chat} bot={botMeta} />
            ) : (
              <div
                data-testid="empty-timeline"
                style={{
                  margin: 'auto',
                  padding: '20px 24px',
                  borderRadius: '14px',
                  backgroundColor: 'var(--tg-bg-elevated)',
                  border: '1px solid var(--tg-hairline-border)',
                  color: 'var(--tg-text-secondary)',
                  textAlign: 'center',
                  fontSize: '13.5px',
                }}
              >
                No messages here yet · Say hello to {chat.title}!
              </div>
            )
          )}

          {filteredMessages.map((msg, idx) => {
            const msgMs = msg.date_ms ?? Date.parse(msg.date);
            const prevMsg = idx > 0 ? filteredMessages[idx - 1] : undefined;
            const nextMsg =
              idx < filteredMessages.length - 1
                ? filteredMessages[idx + 1]
                : undefined;

            const prevMs = prevMsg
              ? (prevMsg.date_ms ?? Date.parse(prevMsg.date))
              : NaN;
            const nextMs = nextMsg
              ? (nextMsg.date_ms ?? Date.parse(nextMsg.date))
              : NaN;

            const dayKey = getDayKey(msgMs);
            const showDatePill = !prevMsg || getDayKey(prevMs) !== dayKey;

            const samePrevGroup = Boolean(
              prevMsg &&
                prevMsg.content.type !== 'Service' &&
                msg.content.type !== 'Service' &&
                prevMsg.sender_id === msg.sender_id &&
                !showDatePill &&
                Math.abs(msgMs - prevMs) <= 900_000,
            );

            const sameNextGroup = Boolean(
              nextMsg &&
                nextMsg.content.type !== 'Service' &&
                msg.content.type !== 'Service' &&
                nextMsg.sender_id === msg.sender_id &&
                getDayKey(nextMs) === dayKey &&
                Math.abs(nextMs - msgMs) <= 900_000,
            );

            const showSenderHeader =
              (chat.isGroup || chat.isSupergroup) && !samePrevGroup;
            const showTail = !sameNextGroup;

            const replyId = msg.reply_to?.reply_to_msg_id;
            const repliedMsg =
              replyId !== undefined ? (messageMap.get(replyId) ?? null) : null;
            const isReplyDeleted = Boolean(
              replyId !== undefined &&
                !repliedMsg &&
                (seenSet?.has(replyId) || !hasMore || replyId >= minLoadedId),
            );

            return (
              <React.Fragment key={msg.id}>
                {showDatePill && (
                  <div
                    data-testid="date-divider"
                    style={{
                      position: 'sticky',
                      top: '4px',
                      zIndex: 9,
                      alignSelf: 'center',
                      margin: '8px 0 6px',
                      padding: '3px 12px',
                      borderRadius: '999px',
                      backgroundColor: 'var(--tg-bg-glass)',
                      border: '1px solid var(--tg-hairline-border)',
                      color: 'var(--tg-text-secondary)',
                      fontSize: '12px',
                      fontWeight: 600,
                      backdropFilter: 'blur(12px)',
                      userSelect: 'none',
                    }}
                  >
                    {formatDatePillLabel(msgMs)}
                  </div>
                )}

                {firstUnreadMsgId === msg.id && (
                  <div
                    data-testid="unread-divider"
                    style={{
                      width: '100%',
                      maxWidth: '780px',
                      margin: '8px auto',
                      padding: '4px 12px',
                      borderRadius: '8px',
                      backgroundColor: 'var(--tg-accent-soft)',
                      color: 'var(--tg-accent)',
                      textAlign: 'center',
                      fontSize: '12px',
                      fontWeight: 600,
                    }}
                  >
                    Unread Messages · 未读消息
                  </div>
                )}

                <div
                  style={{
                    marginTop: samePrevGroup ? '2px' : '8px',
                  }}
                >
                  <MessageBubble
                    message={msg}
                    chat={chat}
                    showSenderHeader={showSenderHeader}
                    showTail={showTail}
                    isHighlighted={highlightedMessageId === msg.id}
                    repliedMessage={repliedMsg}
                    isReplyDeleted={isReplyDeleted}
                    onJumpToMessage={(targetId) => void scrollToMessage(targetId)}
                    onRequestForward={onRequestForward}
                    onRequestDelete={onRequestDelete}
                  />
                </div>
              </React.Fragment>
            );
          })}

          {showHermesThinking && streamingTurn && (
            <div
              style={{
                width: '100%',
                maxWidth: '780px',
                margin: '8px auto 0',
                display: 'flex',
                justifyContent: 'flex-start',
              }}
            >
              <ThinkingBubble turn={streamingTurn} />
            </div>
          )}
        </div>

        {/* Floating Scroll-to-Bottom FAB */}
        {showScrollFab && (
          <button
            id={DOM_IDS.BTN_SCROLL_TO_BOTTOM}
            type="button"
            data-testid="btn-scroll-to-bottom"
            aria-label="Scroll to bottom"
            onClick={scrollToBottom}
            style={{
              fontSize: '18px',
            }}
          >
            ↓
            {unreadBelowCount > 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: '-6px',
                  right: '-4px',
                  minWidth: '18px',
                  height: '18px',
                  padding: '0 5px',
                  borderRadius: '999px',
                  backgroundColor: 'var(--tg-accent)',
                  color: '#FFFFFF',
                  fontSize: '11px',
                  fontWeight: 700,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {unreadBelowCount}
              </span>
            )}
          </button>
        )}
      </div>
    );
  },
);
