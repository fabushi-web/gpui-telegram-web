import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  extractPlainTextFromContent,
  peerAvatarColorIndex,
  type ChatSummary,
  type MessageItem,
  type ReactionDetail,
} from '@gpui-telegram/protocol';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useUiStore } from '../../store/useUiStore';
import { MessageCards } from './MessageCards';

export const QUICK_7_REACTIONS = [
  '👍',
  '❤️',
  '🔥',
  '🎉',
  '😂',
  '😮',
  '😢',
] as const;

export const EXTENDED_32_REACTION_EMOJIS = [
  '👍', '👎', '❤️', '🔥', '🥰', '👏', '😁', '🤔',
  '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩',
  '🙏', '👌', '🕊️', '🤡', '🥱', '🥴', '😍', '🐳',
  '❤️‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆',
] as const;

const SENDER_NAME_COLORS = [
  '#3390EC',
  '#00C972',
  '#E5A030',
  '#E86C52',
  '#E15B64',
  '#3FC1B0',
  '#29B6F6',
];

export interface MessageBubbleProps {
  message: MessageItem;
  chat: ChatSummary;
  showSenderHeader: boolean;
  showTail: boolean;
  isHighlighted: boolean;
  repliedMessage?: MessageItem | null;
  isReplyDeleted?: boolean;
  onJumpToMessage: (messageId: number) => void;
  onRequestForward?: (messageIds: number[]) => void;
  onRequestDelete?: (messageIds: number[]) => void;
}

function clampPositionToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  return {
    x: Math.max(8, Math.min(x, vw - width - 8)),
    y: Math.max(8, Math.min(y, vh - height - 8)),
  };
}

function formatMessageTime(isoDate: string, dateMs?: number): string {
  const ts = dateMs ?? Date.parse(isoDate);
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatServiceEventCopy(message: MessageItem): string {
  if (message.content.type !== 'Service') return '';
  const d = message.content.data;
  switch (d.kind) {
    case 'chat_created':
      return `Group "${d.title}" created`;
    case 'user_joined':
      return `User #${d.user_id} joined the chat`;
    case 'user_left':
      return `User #${d.user_id} left the chat`;
    case 'title_changed':
      return `Chat title changed to "${d.new_title}"`;
    case 'photo_changed':
      return 'Chat photo updated';
    case 'message_pinned':
      return `Pinned message #${d.message_id}`;
    case 'call_ended':
      return `${d.is_video ? 'Video' : 'Voice'} call ended (${d.duration_secs}s)`;
    case 'history_cleared':
      return 'Chat history cleared';
    case 'custom_text':
      return d.text;
  }
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  chat,
  showSenderHeader,
  showTail,
  isHighlighted,
  repliedMessage,
  isReplyDeleted,
  onJumpToMessage,
  onRequestForward,
  onRequestDelete,
}) => {
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  const selectedMessageIds = useChatStore((s) => s.selectedMessageIds);
  const isMultiSelectMode = useChatStore((s) => s.isMultiSelectMode);
  const peersById = useChatStore((s) => s.peersById);
  const setReplyTarget = useChatStore((s) => s.setReplyTarget);
  const setEditingMessage = useChatStore((s) => s.setEditingMessage);
  const toggleMessageSelection = useChatStore((s) => s.toggleMessageSelection);
  const pinMessage = useChatStore((s) => s.pinMessage);
  const deleteMessages = useChatStore((s) => s.deleteMessages);
  const toggleReaction = useChatStore((s) => s.toggleReaction);
  const fetchReactionDetails = useChatStore((s) => s.fetchReactionDetails);

  const openModal = useUiStore((s) => s.openModal);
  const pushToast = useUiStore((s) => s.pushToast);
  const currentUser = useAuthStore((s) => s.currentUser);

  const [hovered, setHovered] = useState<boolean>(false);
  const [stripBelow, setStripBelow] = useState<boolean>(false);
  const [pickerPos, setPickerPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [ctxMenuPos, setCtxMenuPos] = useState<{
    x: number;
    y: number;
    selectedQuote: string;
  } | null>(null);
  const [selectedQuoteText, setSelectedQuoteText] = useState<string>('');
  const [reactorModalPos, setReactorModalPos] = useState<{
    x: number;
    y: number;
    details: ReactionDetail[];
  } | null>(null);

  // Close local popovers on outside click or Escape
  useEffect(() => {
    if (!pickerPos && !ctxMenuPos && !reactorModalPos) return;
    const onWindowClick = () => {
      setPickerPos(null);
      setCtxMenuPos(null);
      setReactorModalPos(null);
    };
    const onWindowKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (pickerPos) {
          setPickerPos(null);
        } else if (reactorModalPos) {
          setReactorModalPos(null);
        } else if (ctxMenuPos) {
          setCtxMenuPos(null);
        }
      }
    };
    window.addEventListener('click', onWindowClick);
    window.addEventListener('keydown', onWindowKey, true);
    return () => {
      window.removeEventListener('click', onWindowClick);
      window.removeEventListener('keydown', onWindowKey, true);
    };
  }, [ctxMenuPos, pickerPos, reactorModalPos]);

  const readBubbleSelection = useCallback((): string => {
    if (typeof window === 'undefined' || !bubbleRef.current) return '';
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return '';
    const raw = sel.toString().trim();
    if (!raw) return '';
    const anchor = sel.anchorNode;
    const focus = sel.focusNode;
    if (
      (anchor && bubbleRef.current.contains(anchor)) ||
      (focus && bubbleRef.current.contains(focus))
    ) {
      return raw;
    }
    return '';
  }, []);

  const visibleReactions = useMemo(
    () => (message.reactions ?? []).filter((r) => r.count > 0),
    [message.reactions],
  );

  if (message.content.type === 'Service') {
    return (
      <div
        className="tg-message-row is-service"
        data-testid="service-message"
        data-message-id={String(message.id)}
        style={{
          display: 'flex',
          justifyContent: 'center',
          margin: '4px 0',
        }}
      >
        <span
          style={{
            padding: '3px 12px',
            borderRadius: '999px',
            backgroundColor: 'rgba(14, 22, 33, 0.56)',
            color: 'var(--tg-text-secondary, #8FA2B7)',
            fontSize: '12px',
            fontWeight: 500,
          }}
        >
          {formatServiceEventCopy(message)}
        </span>
      </div>
    );
  }

  const myUserId = currentUser?.userId ?? 1;
  const isOut = Boolean(message.flags?.is_out || message.sender_id === myUserId);
  const isSelected = selectedMessageIds.includes(message.id);
  const isSticker = message.content.type === 'Sticker';
  const isEditable =
    isOut &&
    (message.content.type === 'Text' ||
      message.content.type === 'Photo' ||
      message.content.type === 'Video' ||
      message.content.type === 'Document' ||
      message.content.type === 'Media');

  const senderPeer = peersById[message.sender_id];
  const senderDisplayName =
    message.sender_id === myUserId
      ? currentUser?.firstName || 'You'
      : senderPeer
        ? `${senderPeer.firstName}${senderPeer.lastName ? ` ${senderPeer.lastName}` : ''}`
        : chat.isChannel
          ? chat.title
          : `User #${message.sender_id}`;

  const plainBodyText =
    message.text ?? extractPlainTextFromContent(message.content);

  // Delivery / Read receipt status
  const deliveryStatus: 'pending' | 'sent' | 'read' =
    message.delivery_status === 'sending'
      ? 'pending'
      : message.delivery_status === 'read' ||
          (chat.readOutboxMaxId > 0 && message.id <= chat.readOutboxMaxId) ||
          chat.isSavedMessages
        ? 'read'
        : 'sent';

  const showForwardHeader = Boolean(
    message.forward_info && !message.forward_info.hidden_sender,
  );

  const handleOpenExtendedPicker = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const pickerWidth = 316;
    const pickerHeight = 168;
    const clamped = clampPositionToViewport(
      isOut ? rect.right - pickerWidth : rect.left,
      rect.bottom + 6,
      pickerWidth,
      pickerHeight,
    );
    setPickerPos(clamped);
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const sel = readBubbleSelection() || selectedQuoteText;
    const clamped = clampPositionToViewport(e.clientX, e.clientY, 224, 340);
    setPickerPos(null);
    setCtxMenuPos({
      x: clamped.x,
      y: clamped.y,
      selectedQuote: sel,
    });
  };

  const handleOpenReactorList = async (clientX: number, clientY: number) => {
    const fallbackDetails: ReactionDetail[] = visibleReactions.map((r) => {
      const chosen = Boolean(r.chosen ?? r.is_chosen_by_me);
      const ids =
        r.user_ids && r.user_ids.length > 0
          ? r.user_ids
          : chosen
            ? [myUserId]
            : [chat.peerUserId ?? 2];
      return {
        emoji: r.emoji,
        count: r.count,
        chosen,
        user_ids: ids,
      };
    });

    const clamped = clampPositionToViewport(clientX, clientY, 280, 260);
    setReactorModalPos({
      x: clamped.x,
      y: clamped.y,
      details: fallbackDetails,
    });

    const remoteDetails = await fetchReactionDetails(message.chat_id, message.id);
    if (remoteDetails && remoteDetails.length > 0) {
      setReactorModalPos((prev) =>
        prev ? { ...prev, details: remoteDetails.filter((d) => d.count > 0) } : null,
      );
    }
  };

  const handleReply = (quote?: string) => {
    const cleanQuote = quote?.trim();
    setReplyTarget(message.chat_id, {
      messageId: message.id,
      senderName: senderDisplayName,
      previewText: cleanQuote || plainBodyText,
      quoteText: cleanQuote || undefined,
    });
    setSelectedQuoteText('');
  };

  // Reply header resolution
  const replyHeader = message.reply_to;
  const replyQuoteOnly = replyHeader?.quote_text?.trim();
  const resolvedReplyPreview = isReplyDeleted
    ? 'Deleted message · 消息已删除'
    : replyQuoteOnly
      ? replyQuoteOnly
      : repliedMessage
        ? repliedMessage.text ?? extractPlainTextFromContent(repliedMessage.content)
        : replyHeader?.preview_text || `Message #${replyHeader?.reply_to_msg_id ?? ''}`;

  const resolvedReplySender = isReplyDeleted
    ? 'Deleted'
    : replyHeader?.sender_name ||
      (repliedMessage
        ? peersById[repliedMessage.sender_id]?.firstName ||
          (repliedMessage.sender_id === myUserId
            ? currentUser?.firstName || 'You'
            : `User #${repliedMessage.sender_id}`)
        : 'Reply');

  return (
    <div
      className={`tg-message-row ${isOut ? 'is-outgoing' : 'is-incoming'}`}
      onClick={() => {
        if (isMultiSelectMode) {
          toggleMessageSelection(message.id);
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: isOut ? 'flex-end' : 'flex-start',
        gap: '8px',
        width: '100%',
        maxWidth: '780px',
        margin: '0 auto',
        cursor: isMultiSelectMode ? 'pointer' : 'default',
      }}
    >
      {isMultiSelectMode && (
        <input
          type="checkbox"
          data-testid="message-select-checkbox"
          aria-label={`Select message ${message.id}`}
          checked={isSelected}
          onChange={() => toggleMessageSelection(message.id)}
          onClick={(e) => e.stopPropagation()}
          style={{
            width: '18px',
            height: '18px',
            accentColor: '#3390EC',
            cursor: 'pointer',
            marginBottom: '8px',
            flexShrink: 0,
          }}
        />
      )}

      {/* Peer Avatar in Group Incoming Tails */}
      {!isOut && (chat.isGroup || chat.isSupergroup) && (
        <div
          style={{
            width: '32px',
            height: '32px',
            flexShrink: 0,
            visibility: showTail ? 'visible' : 'hidden',
          }}
        >
          {showTail && (
            <div
              data-avatar="true"
              className="tg-avatar"
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                backgroundColor:
                  SENDER_NAME_COLORS[peerAvatarColorIndex(message.sender_id)] ??
                  '#3390EC',
                color: '#FFFFFF',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '12px',
                fontWeight: 700,
              }}
            >
              {senderDisplayName.slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>
      )}

      <div
        ref={bubbleRef}
        data-testid="message-bubble"
        data-message-id={String(message.id)}
        data-outgoing={isOut ? 'true' : 'false'}
        data-direction={isOut ? 'out' : 'in'}
        data-selected={isSelected ? 'true' : 'false'}
        data-pinned={message.flags?.is_pinned ? 'true' : 'false'}
        data-highlighted={isHighlighted ? 'true' : 'false'}
        data-forwarded={showForwardHeader ? 'true' : undefined}
        dir="auto"
        className={`tg-message-bubble ${isOut ? 'is-outgoing' : 'is-incoming'}${
          isSelected ? ' is-selected' : ''
        }`}
        onMouseEnter={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setStripBelow(rect.top < 54);
          setHovered(true);
        }}
        onMouseLeave={() => {
          setHovered(false);
        }}
        onMouseUp={() => {
          const q = readBubbleSelection();
          setSelectedQuoteText(q);
        }}
        onDoubleClick={(e) => {
          if (isMultiSelectMode) return;
          e.stopPropagation();
          handleReply();
        }}
        onContextMenu={handleContextMenu}
        style={{
          position: 'relative',
          minWidth: '160px',
          maxWidth: 'min(480px, 84%)',
          padding: isSticker ? '4px' : '8px 12px 6px',
          borderRadius: isOut ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
          backgroundColor: isSticker
            ? 'transparent'
            : isHighlighted
              ? 'rgba(51, 144, 236, 0.3)'
              : isOut
                ? 'var(--tg-bubble-out, #2B5278)'
                : 'var(--tg-bubble-in, #182533)',
          color: 'var(--tg-text-primary, #F5F5F5)',
          boxShadow: isHighlighted
            ? '0 0 0 2px var(--tg-accent, #3390EC), 0 8px 24px rgba(51, 144, 236, 0.3)'
            : isSticker
              ? 'none'
              : 'var(--tg-shadow-sm)',
          outline: isSelected ? '2px solid var(--tg-accent, #3390EC)' : 'none',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
          transition: 'background-color 180ms ease, box-shadow 180ms ease',
        }}
      >
        {/* Out-of-Flow Floating Partial Quote Pill when text is selected inside bubble */}
        {selectedQuoteText.length > 0 && !isMultiSelectMode && (
          <button
            type="button"
            data-testid="btn-floating-quote"
            onClick={(e) => {
              e.stopPropagation();
              handleReply(selectedQuoteText);
            }}
            style={{
              position: 'absolute',
              top: '-30px',
              left: '8px',
              zIndex: 45,
              padding: '3px 9px',
              borderRadius: '999px',
              border: '1px solid var(--tg-accent, #3390EC)',
              backgroundColor: 'var(--tg-bg-surface, #17212B)',
              color: 'var(--tg-accent, #3390EC)',
              fontSize: '11.5px',
              fontWeight: 700,
              cursor: 'pointer',
              boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
            }}
          >
            ❝ Quote Selection
          </button>
        )}

        {/* Sender Name in Groups */}
        {showSenderHeader && !isOut && !isSticker && (
          <div
            data-testid="message-sender-name"
            style={{
              fontSize: '12.5px',
              fontWeight: 700,
              color:
                SENDER_NAME_COLORS[peerAvatarColorIndex(message.sender_id)] ??
                '#3390EC',
              marginBottom: '3px',
            }}
          >
            {senderDisplayName}
          </div>
        )}

        {/* Forwarded Header (omitted when hidden_sender is true) */}
        {showForwardHeader && message.forward_info && (
          <div
            data-testid="forward-header"
            style={{
              fontSize: '12px',
              color: 'var(--tg-accent, #6AB8FF)',
              marginBottom: '4px',
              fontWeight: 500,
            }}
          >
            ↪ Forwarded from {message.forward_info.from_name || 'Telegram User'}
          </div>
        )}

        {/* Reply / Partial Quote Header */}
        {replyHeader && (
          <div
            data-testid="reply-header"
            data-reply-to-id={String(replyHeader.reply_to_msg_id)}
            data-reply-deleted={isReplyDeleted ? 'true' : 'false'}
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              if (!isReplyDeleted) {
                onJumpToMessage(replyHeader.reply_to_msg_id);
              }
            }}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !isReplyDeleted) {
                e.preventDefault();
                e.stopPropagation();
                onJumpToMessage(replyHeader.reply_to_msg_id);
              }
            }}
            style={{
              marginBottom: '6px',
              padding: '4px 8px',
              borderLeft: '3px solid var(--tg-accent, #3390EC)',
              borderRadius: '3px 6px 6px 3px',
              backgroundColor: 'rgba(0, 0, 0, 0.18)',
              cursor: isReplyDeleted ? 'default' : 'pointer',
              fontSize: '12px',
            }}
          >
            <div
              style={{
                fontWeight: 700,
                color: 'var(--tg-accent, #6AB8FF)',
                fontSize: '11.5px',
              }}
            >
              {replyQuoteOnly ? `❝ ${resolvedReplySender}` : resolvedReplySender}
            </div>
            <div
              style={{
                color: isReplyDeleted
                  ? 'var(--tg-text-secondary, #8FA2B7)'
                  : 'var(--tg-text-primary, #F5F5F5)',
                fontStyle: isReplyDeleted ? 'italic' : 'normal',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {resolvedReplyPreview}
            </div>
          </div>
        )}

        {/* Primary Rich Message Content / Cards */}
        <MessageCards message={message} peerUserId={chat.peerUserId} />

        {/* Reaction Counter Pills */}
        {visibleReactions.length > 0 && (
          <div
            data-testid="reaction-pills"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '4px',
              marginTop: '6px',
            }}
          >
            {visibleReactions.map((r) => {
              const chosen = Boolean(r.chosen ?? r.is_chosen_by_me);
              return (
                <button
                  key={r.emoji}
                  type="button"
                  data-testid="reaction-pill"
                  data-emoji={r.emoji}
                  data-reaction={r.emoji}
                  data-chosen={chosen ? 'true' : 'false'}
                  aria-pressed={chosen}
                  aria-label={`Reaction ${r.emoji} ${r.count}`}
                  className={`tg-reaction-pill${chosen ? ' is-chosen' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggleReaction(message.chat_id, message.id, r.emoji);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleOpenReactorList(e.clientX, e.clientY);
                  }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '2px 8px',
                    borderRadius: '999px',
                    border: chosen
                      ? '1px solid var(--tg-accent, #3390EC)'
                      : '1px solid rgba(255, 255, 255, 0.14)',
                    backgroundColor: chosen
                      ? 'rgba(51, 144, 236, 0.28)'
                      : 'rgba(255, 255, 255, 0.1)',
                    color: chosen ? '#82C8FF' : 'var(--tg-text-primary, #F5F5F5)',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <span>{r.emoji}</span>{' '}
                  <span>{r.count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Metadata Footer: Views, Pinned, Edited, Timestamp, Outgoing Read Receipt */}
        {' '}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: '5px',
            marginTop: '3px',
            fontSize: '11px',
            color: 'rgba(220, 230, 242, 0.68)',
            userSelect: 'none',
          }}
        >
          {(chat.isChannel || message.views !== undefined) && (
            <>
              <span data-testid="message-views" title="Post views">
                👁 {Math.max(1, message.views ?? 1)}
              </span>{' '}
            </>
          )}

          {message.flags?.is_pinned && (
            <>
              <span data-testid="message-pin-icon" title="Pinned">
                📌
              </span>{' '}
            </>
          )}

          {Boolean(
            message.isEdited || message.flags?.is_edited || message.edit_date,
          ) && (
            <>
              <span data-testid="message-edited">edited</span>{' '}
            </>
          )}

          <time dateTime={message.date} data-testid="message-timestamp">
            {formatMessageTime(message.date, message.date_ms)}
          </time>

          {isOut && (
            <>
              {' '}
              <span
                data-testid="message-status"
                data-status={deliveryStatus}
                aria-label={
                  deliveryStatus === 'read'
                    ? 'Read'
                    : deliveryStatus === 'sent'
                      ? 'Sent'
                      : 'Sending'
                }
                style={{
                  color:
                    deliveryStatus === 'read'
                      ? '#62C0FF'
                      : 'rgba(220, 230, 242, 0.72)',
                  fontWeight: 700,
                  letterSpacing: '-1px',
                }}
              >
                {deliveryStatus === 'pending'
                  ? '🕒'
                  : deliveryStatus === 'read'
                    ? '✓✓'
                    : '✓'}
              </span>
            </>
          )}
        </div>

        {/* SVG Bubble Corner Tail */}
        {showTail && !isSticker && (
          <svg
            data-testid="bubble-tail"
            aria-hidden="true"
            viewBox="0 0 9 16"
            className={`tg-bubble-tail ${
              isOut ? 'tg-bubble-tail--out' : 'tg-bubble-tail--in'
            }`}
            style={{
              position: 'absolute',
              bottom: 0,
              [isOut ? 'right' : 'left']: '-6px',
              width: '9px',
              height: '16px',
              pointerEvents: 'none',
              color: isHighlighted
                ? '#3390EC'
                : isOut
                  ? 'var(--tg-bubble-out, #2B5278)'
                  : 'var(--tg-bubble-in, #182533)',
            }}
          >
            {isOut ? (
              <path d="M0 0 L0 16 L9 16 C4 14 1 9 0 0 Z" fill="currentColor" />
            ) : (
              <path d="M9 0 L9 16 L0 16 C5 14 8 9 9 0 Z" fill="currentColor" />
            )}
          </svg>
        )}

        {/* Out-of-Flow Hover Quick Reaction Strip (0px layout shift!) */}
        {hovered && !isMultiSelectMode && (
          <div
            role="toolbar"
            data-testid="quick-reaction-strip"
            aria-label="Quick reactions"
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              [stripBelow ? 'bottom' : 'top']: '-36px',
              [isOut ? 'right' : 'left']: '0px',
              paddingBottom: stripBelow ? 0 : '6px',
              paddingTop: stripBelow ? '6px' : 0,
              zIndex: 40,
            }}
          >
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '2px',
                padding: '3px 6px',
                borderRadius: '999px',
                backgroundColor: 'var(--tg-bg-surface, #17212B)',
                border: '1px solid var(--tg-border, #242F3D)',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.42)',
              }}
            >
              {QUICK_7_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  data-testid="btn-quick-react"
                  data-quick-reaction={emoji}
                  aria-label={`React ${emoji}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setHovered(false);
                    void toggleReaction(message.chat_id, message.id, emoji);
                  }}
                  style={{
                    width: '26px',
                    height: '26px',
                    borderRadius: '50%',
                    border: 'none',
                    backgroundColor: 'transparent',
                    fontSize: '15px',
                    lineHeight: 1,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  {emoji}
                </button>
              ))}
              <button
                type="button"
                data-testid="btn-quick-react-more"
                aria-label="More reactions"
                aria-expanded={Boolean(pickerPos)}
                onClick={handleOpenExtendedPicker}
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  border: 'none',
                  backgroundColor: 'rgba(255, 255, 255, 0.08)',
                  color: 'var(--tg-text-secondary, #8FA2B7)',
                  fontSize: '11px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                ▼
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Viewport-Clamped 8x4 = 32 Emoji Extended Reaction Picker */}
      {pickerPos && (
        <div
          role="dialog"
          aria-label="Choose a reaction"
          data-testid="extended-reaction-picker"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: `${pickerPos.x}px`,
            top: `${pickerPos.y}px`,
            padding: '8px',
            borderRadius: '12px',
            backgroundColor: 'var(--tg-bg-surface, #17212B)',
            border: '1px solid var(--tg-border, #242F3D)',
            boxShadow: '0 14px 36px rgba(0, 0, 0, 0.5)',
            zIndex: 1350,
            display: 'grid',
            gridTemplateColumns: 'repeat(8, 34px)',
            gap: '4px',
          }}
        >
          {EXTENDED_32_REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              data-reaction-option={emoji}
              aria-label={`React ${emoji}`}
              onClick={(e) => {
                e.stopPropagation();
                setPickerPos(null);
                setHovered(false);
                void toggleReaction(message.chat_id, message.id, emoji);
              }}
              style={{
                width: '34px',
                height: '34px',
                borderRadius: '8px',
                border: 'none',
                backgroundColor: 'rgba(255, 255, 255, 0.04)',
                fontSize: '19px',
                lineHeight: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      {/* Viewport-Clamped Message Context Menu */}
      {ctxMenuPos && (
        <div
          role="menu"
          data-testid="context-menu"
          aria-label="Message actions"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: `${ctxMenuPos.x}px`,
            top: `${ctxMenuPos.y}px`,
            width: '220px',
            padding: '6px',
            borderRadius: '10px',
            backgroundColor: 'var(--tg-bg-surface, #17212B)',
            border: '1px solid var(--tg-border, #242F3D)',
            boxShadow: '0 14px 36px rgba(0, 0, 0, 0.5)',
            zIndex: 1350,
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setCtxMenuPos(null);
              handleReply();
            }}
            style={ctxMenuItemStyle(false)}
          >
            ↩ Reply · 回复
          </button>

          {ctxMenuPos.selectedQuote.length > 0 && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const q = ctxMenuPos.selectedQuote;
                setCtxMenuPos(null);
                handleReply(q);
              }}
              style={ctxMenuItemStyle(false)}
            >
              ❝ Quote · 引用选中文本
            </button>
          )}

          {isEditable && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setCtxMenuPos(null);
                setEditingMessage(message.chat_id, message);
              }}
              style={ctxMenuItemStyle(false)}
            >
              ✎ Edit · 编辑
            </button>
          )}

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setCtxMenuPos(null);
              void pinMessage(
                message.chat_id,
                message.id,
                !message.flags?.is_pinned,
              );
            }}
            style={ctxMenuItemStyle(false)}
          >
            📌 {message.flags?.is_pinned ? 'Unpin · 取消置顶' : 'Pin · 置顶'}
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setCtxMenuPos(null);
              openModal('forward_messages', {
                fromChatId: message.chat_id,
                messageIds: [message.id],
              });
              onRequestForward?.([message.id]);
            }}
            style={ctxMenuItemStyle(false)}
          >
            ↪ Forward · 转发
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setCtxMenuPos(null);
              toggleMessageSelection(message.id, true);
            }}
            style={ctxMenuItemStyle(false)}
          >
            ☑ Select · 多选
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={async () => {
              setCtxMenuPos(null);
              try {
                await navigator.clipboard.writeText(plainBodyText);
                pushToast('Message copied', 'success');
              } catch {
                pushToast('Clipboard unavailable', 'warning');
              }
            }}
            style={ctxMenuItemStyle(false)}
          >
            ⧉ Copy Text · 复制文本
          </button>

          {visibleReactions.length > 0 && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const pos = ctxMenuPos;
                setCtxMenuPos(null);
                void handleOpenReactorList(pos.x, pos.y);
              }}
              style={ctxMenuItemStyle(false)}
            >
              ❤️ Reactions ({visibleReactions.reduce((s, r) => s + r.count, 0)})
            </button>
          )}

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setCtxMenuPos(null);
              if (onRequestDelete) {
                onRequestDelete([message.id]);
              } else {
                void deleteMessages(message.chat_id, [message.id], true);
              }
            }}
            style={ctxMenuItemStyle(true)}
          >
            🗑 Delete · 删除
          </button>
        </div>
      )}

      {/* Reactor List Popover */}
      {reactorModalPos && (
        <div
          role="dialog"
          aria-label="Reactions"
          data-testid="reactor-list-popover"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: `${reactorModalPos.x}px`,
            top: `${reactorModalPos.y}px`,
            width: '276px',
            maxHeight: '260px',
            overflowY: 'auto',
            padding: '12px',
            borderRadius: '12px',
            backgroundColor: 'var(--tg-bg-surface, #17212B)',
            border: '1px solid var(--tg-border, #242F3D)',
            boxShadow: '0 14px 36px rgba(0, 0, 0, 0.5)',
            zIndex: 1360,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '8px',
            }}
          >
            <strong style={{ fontSize: '13px' }}>Reactions · 回应列表</strong>
            <button
              type="button"
              aria-label="Close reactions"
              onClick={() => setReactorModalPos(null)}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--tg-text-secondary, #8FA2B7)',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              ✕
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {reactorModalPos.details.flatMap((detail) => {
              const userIds =
                detail.user_ids && detail.user_ids.length > 0
                  ? detail.user_ids
                  : [detail.chosen ? myUserId : chat.peerUserId ?? 2];
              return userIds.map((uid, idx) => {
                const peer = peersById[uid];
                const fullName =
                  uid === myUserId
                    ? `${currentUser?.firstName || 'Telegram'} ${currentUser?.lastName || 'User'}`.trim()
                    : peer
                      ? `${peer.firstName}${peer.lastName ? ` ${peer.lastName}` : ''}`
                      : `Telegram User #${uid}`;
                return (
                  <div
                    key={`${detail.emoji}-${uid}-${idx}`}
                    data-testid="reactor-row"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      padding: '4px 6px',
                      borderRadius: '8px',
                      backgroundColor: 'rgba(255, 255, 255, 0.04)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                      <div
                        data-avatar="true"
                        className="tg-avatar"
                        style={{
                          width: '28px',
                          height: '28px',
                          borderRadius: '50%',
                          backgroundColor:
                            SENDER_NAME_COLORS[peerAvatarColorIndex(uid)] ?? '#3390EC',
                          color: '#FFFFFF',
                          fontSize: '12px',
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {fullName.slice(0, 1).toUpperCase()}
                      </div>
                      <span
                        style={{
                          fontSize: '13px',
                          fontWeight: 500,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {fullName}
                      </span>
                    </div>
                    <span style={{ fontSize: '16px', flexShrink: 0 }}>
                      {detail.emoji}
                    </span>
                  </div>
                );
              });
            })}
          </div>
        </div>
      )}
    </div>
  );
};

function ctxMenuItemStyle(danger: boolean): React.CSSProperties {
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
