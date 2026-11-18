import React, { useMemo, useState } from 'react';
import {
  DOM_IDS,
  extractPlainTextFromContent,
  type MessageItem,
} from '@gpui-telegram/protocol';
import { useChatStore } from '../../store/useChatStore';

export interface PinnedBannerProps {
  chatId: number;
  onJumpToMessage: (messageId: number) => void;
}

export const PinnedBanner: React.FC<PinnedBannerProps> = ({
  chatId,
  onJumpToMessage,
}) => {
  const pinnedByChat = useChatStore((s) => s.pinnedByChat);
  const messagesByChat = useChatStore((s) => s.messagesByChat);
  const chatsById = useChatStore((s) => s.chatsById);
  const pinMessage = useChatStore((s) => s.pinMessage);

  const [cursorIndex, setCursorIndex] = useState<number>(0);

  const pinnedMessages = useMemo<MessageItem[]>(() => {
    const byId = new Map<number, MessageItem>();
    const fromStore = pinnedByChat[chatId] ?? [];
    for (const item of fromStore) {
      byId.set(item.id, item);
    }

    const timeline = messagesByChat[chatId] ?? [];
    const chatPinnedIds = new Set(chatsById[chatId]?.pinnedMessageIds ?? []);

    for (const msg of timeline) {
      if (msg.flags?.is_pinned || chatPinnedIds.has(msg.id)) {
        byId.set(msg.id, msg);
      } else if (byId.has(msg.id) && msg.flags && !msg.flags.is_pinned) {
        // Respect explicit unpin reflected in timeline flags
        byId.delete(msg.id);
      }
    }

    return Array.from(byId.values()).sort((a, b) => a.id - b.id);
  }, [chatId, chatsById, messagesByChat, pinnedByChat]);

  if (pinnedMessages.length === 0) {
    return null;
  }

  const safeIdx =
    ((cursorIndex % pinnedMessages.length) + pinnedMessages.length) %
    pinnedMessages.length;
  const activePinned = pinnedMessages[safeIdx]!;
  const previewText =
    (activePinned.text ?? extractPlainTextFromContent(activePinned.content)).trim() ||
    'Pinned Message';

  const handleCycleAndJump = () => {
    onJumpToMessage(activePinned.id);
    if (pinnedMessages.length > 1) {
      setCursorIndex((prev) => (prev + 1) % pinnedMessages.length);
    }
  };

  return (
    <div
      id={DOM_IDS.PINNED_MESSAGE_BANNER}
      data-testid="pinned-message-banner"
      data-pinned-message-id={String(activePinned.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        padding: '6px 14px',
        backgroundColor: 'var(--tg-bg-elevated, #1E2C3A)',
        borderBottom: '1px solid var(--tg-border, #242F3D)',
        flexShrink: 0,
        zIndex: 5,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={handleCycleAndJump}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleCycleAndJump();
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
          style={{
            width: '3px',
            height: '28px',
            borderRadius: '2px',
            backgroundColor: 'var(--tg-accent, #3390EC)',
            flexShrink: 0,
          }}
        />
        <div style={{ minWidth: 0, flex: '1 1 auto' }}>
          <div
            style={{
              fontSize: '11px',
              fontWeight: 600,
              color: 'var(--tg-accent, #3390EC)',
            }}
          >
            📌 Pinned Message{' '}
            {pinnedMessages.length > 1
              ? `#${safeIdx + 1} / ${pinnedMessages.length}`
              : '#1 / 1'}
          </div>
          <div
            style={{
              fontSize: '12.5px',
              color: 'var(--tg-text-primary, #F5F5F5)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {previewText}
          </div>
        </div>
      </div>

      <button
        type="button"
        data-testid="btn-unpin-banner"
        aria-label="Unpin message"
        title="Unpin message"
        onClick={(e) => {
          e.stopPropagation();
          void pinMessage(chatId, activePinned.id, false);
        }}
        style={{
          padding: '4px 8px',
          borderRadius: '6px',
          border: 'none',
          backgroundColor: 'transparent',
          color: 'var(--tg-text-secondary, #8FA2B7)',
          fontSize: '15px',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        ×
      </button>
    </div>
  );
};
