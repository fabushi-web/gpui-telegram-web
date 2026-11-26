import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  extractPlainTextFromContent,
  peerAvatarColorIndex,
  type ChatSummary,
  type MessageItem,
  type ReactionDetail,
} from '@gpui-telegram/protocol';
import { t } from '../../i18n';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';
import { GrokBotAvatar, resolveBotHueName } from '../common/GrokBotAvatar';
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
  '#0A84FF',
  '#00BA69',
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

/** Local-timezone 24-hour HH:MM formatting avoiding '24:xx' locale quirk (A03-T1-06) */
function formatMessageTime(isoDate: string, dateMs?: number): string {
  const ts = dateMs ?? Date.parse(isoDate);
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
  const closePoll = useChatStore((s) => s.closePoll);
  const translatedMessagesByKey = useChatStore((s) => s.translatedMessagesByKey);
  const translatingMessageKeys = useChatStore((s) => s.translatingMessageKeys);
  const translationErrorByKey = useChatStore((s) => s.translationErrorByKey);
  const translateMessage = useChatStore((s) => s.translateMessage);
  const clearMessageTranslation = useChatStore((s) => s.clearMessageTranslation);

  const language = useSettingsStore((s) => s.language);
  const bots = useAiWorkspaceStore((s) => s.bots);
  const openModal = useUiStore((s) => s.openModal);
  const openSettings = useUiStore((s) => s.openSettings);
  const pushToast = useUiStore((s) => s.pushToast);
  const currentUser = useAuthStore((s) => s.currentUser);

  const translationKey = `${message.chat_id}:${message.id}`;
  const translationResult = translatedMessagesByKey[translationKey];
  const isTranslating = Boolean(translatingMessageKeys[translationKey]);
  const translationError = translationErrorByKey[translationKey];

  const [hovered, setHovered] = useState<boolean>(false);
  const [stripBelow, setStripBelow] = useState<boolean>(false);
  const [pickerPos, setPickerPos] = useState<{ x: number; y: number } | null>(null);
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
            backgroundColor: 'var(--tg-bg-elevated)',
            border: '1px solid var(--tg-hairline-border)',
            color: 'var(--tg-text-secondary)',
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
  const senderBot = bots.find((b) => b.bot_user_id === message.sender_id);
  const isBotSender = Boolean(senderBot || senderPeer?.isBot || (!isOut && (chat.isBot || chat.kind === 'bot')));
  const botHue = isBotSender
    ? resolveBotHueName(
        senderBot?.agent_id || senderBot?.username || chat.username || String(message.sender_id),
        senderBot?.avatar_color,
      )
    : undefined;

  const senderDisplayName =
    message.sender_id === myUserId
      ? currentUser?.firstName || 'You'
      : senderBot
        ? senderBot.display_name || senderBot.username
        : senderPeer
          ? `${senderPeer.firstName}${senderPeer.lastName ? ` ${senderPeer.lastName}` : ''}`
          : chat.isChannel
            ? chat.title
            : `User #${message.sender_id}`;

  const plainBodyText =
    message.text ?? extractPlainTextFromContent(message.content);

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
    const clamped = clampPositionToViewport(e.clientX, e.clientY, 224, 360);
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

  const isOpenPoll = message.content.type === 'Poll' && !message.content.data.is_closed;

  return (
    <div
      className={`tg-message-row ${isOut ? 'is-outgoing' : 'is-incoming'}`}
      onClick={() => {
        if (isMultiSelectMode) {
          toggleMessageSelection(message.id);
        }
      }}
      style={{
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
            accentColor: 'var(--tg-accent)',
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
            width: '30px',
            height: '30px',
            flexShrink: 0,
            visibility: showTail ? 'visible' : 'hidden',
          }}
        >
          {showTail &&
            (isBotSender ? (
              <GrokBotAvatar
                sourceId={senderBot?.agent_id || senderBot?.username || String(message.sender_id)}
                shape={senderBot?.avatar_shape}
                color={senderBot?.avatar_color}
                sizePx={30}
                initials={senderDisplayName.slice(0, 2).toUpperCase()}
              />
            ) : (
              <div
                data-avatar="true"
                className="tg-avatar"
                style={{
                  width: '30px',
                  height: '30px',
                  borderRadius: '50%',
                  backgroundColor:
                    SENDER_NAME_COLORS[peerAvatarColorIndex(message.sender_id)] ??
                    '#0A84FF',
                  color: '#FFFFFF',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '11.5px',
                  fontWeight: 700,
                }}
              >
                {senderDisplayName.slice(0, 1).toUpperCase()}
              </div>
            ))}
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
        data-bot-hue={!isOut ? botHue : undefined}
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
          minWidth: '38px',
          maxWidth: 'min(520px, 84%)',
          padding: isSticker ? '4px' : '8px 13px 6px',
          borderRadius: 'var(--tg-bubble-radius, 18px)',
          borderBottomRightRadius: isOut && showTail ? '6px' : undefined,
          borderBottomLeftRadius: !isOut && showTail ? '6px' : undefined,
          backgroundColor: isSticker
            ? 'transparent'
            : isHighlighted
              ? 'var(--tg-accent-strong)'
              : isOut
                ? 'var(--tg-bubble-out)'
                : 'var(--tg-bubble-in)',
          backgroundImage:
            isOut && !isSticker && !isHighlighted
              ? 'var(--tg-bubble-out-gradient)'
              : 'none',
          color: isOut ? 'var(--tg-bubble-out-text)' : 'var(--tg-bubble-in-text)',
          boxShadow: isSticker ? 'none' : 'var(--tg-shadow-sm)',
          outline: isHighlighted || isSelected ? '2px solid var(--tg-accent)' : 'none',
        }}
      >
        {/* Out-of-Flow Floating Partial Quote Pill */}
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
              top: '-32px',
              left: '8px',
              zIndex: 45,
              padding: '3px 9px',
              borderRadius: '999px',
              border: '1px solid var(--tg-accent)',
              backgroundColor: 'var(--tg-bg-elevated)',
              color: 'var(--tg-accent)',
              fontSize: '11.5px',
              fontWeight: 700,
              cursor: 'pointer',
              boxShadow: 'var(--tg-shadow-md)',
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
              fontSize: '12px',
              fontWeight: 700,
              color:
                SENDER_NAME_COLORS[peerAvatarColorIndex(message.sender_id)] ??
                '#0A84FF',
              marginBottom: '3px',
            }}
          >
            {senderDisplayName}
          </div>
        )}

        {/* Forwarded Header */}
        {showForwardHeader && message.forward_info && (
          <div
            data-testid="forward-header"
            style={{
              fontSize: '12px',
              color: isOut ? 'var(--tg-bubble-out-meta)' : 'var(--tg-accent)',
              marginBottom: '4px',
              fontWeight: 500,
            }}
          >
            ↪ Forwarded from {message.forward_info.from_name || 'User'}
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
              borderLeft: `3px solid ${isOut ? 'rgba(255,255,255,0.75)' : 'var(--tg-accent)'}`,
              borderRadius: '4px 6px 6px 4px',
              backgroundColor: isOut ? 'rgba(0, 0, 0, 0.16)' : 'var(--tg-bubble-quote-bg)',
              cursor: isReplyDeleted ? 'default' : 'pointer',
              fontSize: '12px',
            }}
          >
            <div
              style={{
                fontWeight: 700,
                color: isOut ? '#FFFFFF' : 'var(--tg-accent)',
                fontSize: '11.5px',
              }}
            >
              {replyQuoteOnly ? `❝ ${resolvedReplySender}` : resolvedReplySender}
            </div>
            <div
              style={{
                color: isReplyDeleted
                  ? isOut
                    ? 'var(--tg-bubble-out-meta)'
                    : 'var(--tg-text-secondary)'
                  : 'inherit',
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

        {/* Inline Per-Message Translation Block (live Magpie API / honest 503 guidance) */}
        {(isTranslating || translationResult || translationError) && (
          <div data-testid="message-translation" className="tg-message-translation">
            {isTranslating ? (
              <span>🌐 {t('message.translating', language)}</span>
            ) : translationResult ? (
              <>
                <div className="tg-message-translation-head">
                  <span>
                    🌐 {t('message.translatedLabel', language)} ({translationResult.target_lang})
                  </span>
                  <button
                    type="button"
                    className="tg-message-translation-dismiss"
                    onClick={(e) => {
                      e.stopPropagation();
                      clearMessageTranslation(message.chat_id, message.id);
                    }}
                  >
                    {t('message.hideTranslation', language)}
                  </button>
                </div>
                <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {translationResult.translated_text}
                </div>
              </>
            ) : translationError ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div className="tg-message-translation-head">
                  <span>
                    ⚠️{' '}
                    {translationError.needsProviderConfig
                      ? t('message.translateUnconfigured', language)
                      : translationError.message}
                  </span>
                  <button
                    type="button"
                    className="tg-message-translation-dismiss"
                    onClick={(e) => {
                      e.stopPropagation();
                      clearMessageTranslation(message.chat_id, message.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
                {translationError.needsProviderConfig && (
                  <button
                    type="button"
                    data-testid="btn-translate-open-magpie"
                    className="tg-btn tg-btn--secondary"
                    style={{
                      alignSelf: 'flex-start',
                      padding: '3px 9px',
                      fontSize: '11.5px',
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      openSettings('magpie_gateway');
                    }}
                  >
                    {t('message.configureAiProvider', language)}
                  </button>
                )}
              </div>
            ) : null}
          </div>
        )}

        {/* Reaction Counter Chips (Trap #10: data-testid="reaction-chip") */}
        {visibleReactions.length > 0 && (
          <div
            data-testid="reaction-pills"
            className="tg-reactions-row"
          >
            {visibleReactions.map((r) => {
              const chosen = Boolean(r.chosen ?? r.is_chosen_by_me);
              return (
                <button
                  key={r.emoji}
                  type="button"
                  data-testid="reaction-chip"
                  data-emoji={r.emoji}
                  data-reaction={r.emoji}
                  data-chosen={chosen ? 'true' : 'false'}
                  aria-pressed={chosen}
                  aria-label={`Reaction ${r.emoji} ${r.count}`}
                  className={`tg-reaction-pill${chosen ? ' is-chosen' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setHovered(false);
                    void toggleReaction(message.chat_id, message.id, r.emoji);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleOpenReactorList(e.clientX, e.clientY);
                  }}
                >
                  <span>{r.emoji}</span>{' '}
                  <span>{r.count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Metadata Footer: Views, Pinned, Edited, Local HH:MM Timestamp, Outgoing Read Receipt */}
        {' '}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: '5px',
            marginTop: '3px',
            fontSize: '11px',
            color: isOut ? 'var(--tg-bubble-out-meta)' : 'var(--tg-bubble-in-meta)',
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

          <time
            dateTime={message.date}
            data-testid="message-timestamp"
            className="tg-bubble-timestamp"
          >
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
                      ? '#FFFFFF'
                      : 'var(--tg-bubble-out-meta)',
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
              [isOut ? 'right' : 'left']: '-6px',
              color: isHighlighted
                ? 'var(--tg-accent)'
                : isOut
                  ? 'var(--tg-bubble-out-bottom)'
                  : 'var(--tg-bubble-in)',
            }}
          >
            {isOut ? (
              <path d="M0 0 L0 16 L9 16 C4 14 1 9 0 0 Z" fill="currentColor" />
            ) : (
              <path d="M9 0 L9 16 L0 16 C5 14 8 9 9 0 Z" fill="currentColor" />
            )}
          </svg>
        )}

        {/* Out-of-Flow Hover Action Bar (Trap #10: 0px layout shift & reaction-trigger FIRST!) */}
        {hovered && !isMultiSelectMode && (
          <div
            role="toolbar"
            data-testid="hover-action-bar"
            aria-label="Message quick actions"
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              [stripBelow ? 'bottom' : 'top']: '-38px',
              [isOut ? 'right' : 'left']: '0px',
              paddingBottom: stripBelow ? 0 : '6px',
              paddingTop: stripBelow ? '6px' : 0,
              zIndex: 40,
            }}
          >
            <div className="tg-hover-action-bar" style={{ position: 'static' }}>
              {/* First button matching [data-testid*="reaction" i] opens 32-emoji picker (no double-toggle!) */}
              <button
                type="button"
                data-testid="reaction-trigger"
                aria-label="React to message"
                aria-expanded={Boolean(pickerPos)}
                onClick={handleOpenExtendedPicker}
                style={{
                  width: '26px',
                  height: '26px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--tg-accent-soft)',
                  color: 'var(--tg-accent)',
                  fontSize: '14px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                ☺
              </button>

              {QUICK_7_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  data-testid="quick-emoji-btn"
                  data-quick-emoji={emoji}
                  aria-label={`Emoji ${emoji}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setHovered(false);
                    void toggleReaction(message.chat_id, message.id, emoji);
                  }}
                  style={{
                    width: '26px',
                    height: '26px',
                    borderRadius: '50%',
                    backgroundColor: 'transparent',
                    fontSize: '15px',
                    lineHeight: 1,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Viewport-Clamped 8x4 = 32 Emoji Reaction Picker (Trap #10: data-testid="reaction-picker") */}
      {pickerPos &&
        (() => {
          const pickerEl = (
            <div
              role="dialog"
              aria-label="Choose a reaction"
              data-testid="reaction-picker"
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: `${pickerPos.x}px`,
                top: `${pickerPos.y}px`,
                padding: '8px',
                borderRadius: '12px',
                backgroundColor: 'var(--tg-bg-elevated)',
                border: '1px solid var(--tg-hairline-border)',
                boxShadow: 'inset 0 1px 0 var(--tg-specular-top), var(--tg-shadow-lg)',
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
                  aria-label={`Emoji ${emoji}`}
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
                    backgroundColor: 'transparent',
                    fontSize: '19px',
                    lineHeight: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          );
          return typeof document !== 'undefined' ? createPortal(pickerEl, document.body) : pickerEl;
        })()}

      {/* Viewport-Clamped Message Context Menu */}
      {ctxMenuPos &&
        (() => {
          const menuEl = (
            <div
              id="message-context-menu"
              role="menu"
              data-testid="context-menu"
              aria-label="Message actions"
              className="tg-context-menu"
              onClick={(e) => e.stopPropagation()}
              style={{
                left: `${ctxMenuPos.x}px`,
                top: `${ctxMenuPos.y}px`,
                width: '226px',
              }}
            >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setCtxMenuPos(null);
              handleReply();
            }}
            className="tg-context-menu-item"
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
              className="tg-context-menu-item"
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
              className="tg-context-menu-item"
            >
              ✎ Edit · 编辑
            </button>
          )}

          {/* Trap #12: Stop Poll menuitem for open polls */}
          {isOpenPoll && message.content.type === 'Poll' && (
            <button
              type="button"
              role="menuitem"
              data-testid="ctx-stop-poll"
              onClick={() => {
                const pollId = message.content.type === 'Poll' ? message.content.data.poll_id : 0;
                setCtxMenuPos(null);
                if (pollId) {
                  void closePoll(message.chat_id, message.id, pollId);
                }
              }}
              className="tg-context-menu-item"
            >
              ⏹ Stop Poll · 结束投票
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
            className="tg-context-menu-item"
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
            className="tg-context-menu-item"
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
            className="tg-context-menu-item"
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
                pushToast('Message copied', 'success', { scope: 'stage', chatId: message.chat_id });
              } catch {
                pushToast('Clipboard unavailable', 'warning');
              }
            }}
            className="tg-context-menu-item"
          >
            ⧉ Copy Text · 复制文本
          </button>

          {plainBodyText.trim().length > 0 && (
            <button
              type="button"
              role="menuitem"
              data-testid="ctx-translate-message"
              onClick={() => {
                setCtxMenuPos(null);
                if (translationResult || translationError) {
                  clearMessageTranslation(message.chat_id, message.id);
                  return;
                }
                const hasCjk = /[\u4e00-\u9fff]/.test(plainBodyText);
                const targetLang =
                  language === 'zh-CN' ? (hasCjk ? 'en' : 'zh-CN') : hasCjk ? 'en' : 'zh-CN';
                void translateMessage(message.chat_id, message.id, targetLang).catch(() => undefined);
              }}
              className="tg-context-menu-item"
            >
              🌐{' '}
              {translationResult
                ? t('message.hideTranslation', language)
                : t('message.translate', language)}
            </button>
          )}

          {visibleReactions.length > 0 && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const pos = ctxMenuPos;
                setCtxMenuPos(null);
                void handleOpenReactorList(pos.x, pos.y);
              }}
              className="tg-context-menu-item"
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
            className="tg-context-menu-item is-danger"
          >
            🗑 Delete · 删除
          </button>
            </div>
          );
          return typeof document !== 'undefined' ? createPortal(menuEl, document.body) : menuEl;
        })()}

      {/* Reactor List Popover */}
      {reactorModalPos &&
        (() => {
          const reactorEl = (
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
            backgroundColor: 'var(--tg-bg-elevated)',
            border: '1px solid var(--tg-hairline-border)',
            boxShadow: 'inset 0 1px 0 var(--tg-specular-top), var(--tg-shadow-lg)',
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
              className="tg-icon-btn"
              style={{ width: '24px', height: '24px', fontSize: '13px' }}
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
                    ? `${currentUser?.firstName || 'You'} ${currentUser?.lastName || ''}`.trim()
                    : peer
                      ? `${peer.firstName}${peer.lastName ? ` ${peer.lastName}` : ''}`
                      : `User #${uid}`;
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
                      backgroundColor: 'var(--tg-bg-hover)',
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
                            SENDER_NAME_COLORS[peerAvatarColorIndex(uid)] ?? '#0A84FF',
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
          );
          return typeof document !== 'undefined' ? createPortal(reactorEl, document.body) : reactorEl;
        })()}
    </div>
  );
};
