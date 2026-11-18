import React from 'react';
import {
  DOM_IDS,
  extractPlainTextFromContent,
} from '@gpui-telegram/protocol';
import { useChatStore } from '../../store/useChatStore';
import { useUiStore } from '../../store/useUiStore';

export interface SelectionToolbarProps {
  chatId: number;
  onRequestForward?: (messageIds: number[]) => void;
  onRequestDelete?: (messageIds: number[]) => void;
}

export const SelectionToolbar: React.FC<SelectionToolbarProps> = ({
  chatId,
  onRequestForward,
  onRequestDelete,
}) => {
  const selectedMessageIds = useChatStore((s) => s.selectedMessageIds);
  const messagesByChat = useChatStore((s) => s.messagesByChat);
  const clearMultiSelect = useChatStore((s) => s.clearMultiSelect);
  const deleteMessages = useChatStore((s) => s.deleteMessages);

  const openModal = useUiStore((s) => s.openModal);
  const pushToast = useUiStore((s) => s.pushToast);

  if (selectedMessageIds.length === 0) {
    return null;
  }

  const handleBatchCopy = async () => {
    const idSet = new Set(selectedMessageIds);
    const ordered = (messagesByChat[chatId] ?? [])
      .filter((m) => idSet.has(m.id))
      .sort((a, b) => a.id - b.id);
    const joined = ordered
      .map((m) => m.text ?? extractPlainTextFromContent(m.content))
      .join('\n');

    try {
      await navigator.clipboard.writeText(joined);
      pushToast(`Copied ${ordered.length} message(s)`, 'success');
    } catch {
      pushToast('Clipboard unavailable', 'warning');
    }
  };

  const handleBatchForward = () => {
    const ids = [...selectedMessageIds];
    openModal('forward_messages', {
      fromChatId: chatId,
      messageIds: ids,
    });
    onRequestForward?.(ids);
  };

  const handleBatchDelete = () => {
    const ids = [...selectedMessageIds];
    if (onRequestDelete) {
      onRequestDelete(ids);
      return;
    }
    void deleteMessages(chatId, ids, true);
    clearMultiSelect();
  };

  return (
    <div
      id={DOM_IDS.SELECTION_TOOLBAR}
      data-testid="selection-toolbar"
      role="toolbar"
      aria-label="Batch message actions"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '10px',
        padding: '8px 14px',
        margin: '0 auto 6px',
        width: '100%',
        maxWidth: '780px',
        boxSizing: 'border-box',
        borderRadius: '10px',
        backgroundColor: 'var(--tg-bg-surface, #17212B)',
        border: '1px solid var(--tg-border, #242F3D)',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.28)',
        zIndex: 7,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button
          type="button"
          data-testid="selection-cancel"
          aria-label="Cancel selection"
          onClick={() => clearMultiSelect()}
          style={toolbarActionBtnStyle('neutral')}
        >
          ✕ Cancel
        </button>
        <strong
          data-testid="selection-count"
          style={{ fontSize: '13px', color: 'var(--tg-text-primary, #F5F5F5)' }}
        >
          {selectedMessageIds.length} selected · 已选 {selectedMessageIds.length} 条
        </strong>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <button
          type="button"
          data-testid="selection-forward"
          aria-label="Forward selected messages"
          onClick={handleBatchForward}
          style={toolbarActionBtnStyle('accent')}
        >
          ↪ Forward · 转发
        </button>

        <button
          type="button"
          data-testid="selection-copy"
          aria-label="Copy selected messages"
          onClick={() => void handleBatchCopy()}
          style={toolbarActionBtnStyle('neutral')}
        >
          ⧉ Copy · 复制
        </button>

        <button
          type="button"
          data-testid="selection-delete"
          aria-label="Delete selected messages"
          onClick={handleBatchDelete}
          style={toolbarActionBtnStyle('danger')}
        >
          🗑 Delete · 删除
        </button>
      </div>
    </div>
  );
};

function toolbarActionBtnStyle(
  variant: 'neutral' | 'accent' | 'danger',
): React.CSSProperties {
  const color =
    variant === 'accent'
      ? '#FFFFFF'
      : variant === 'danger'
        ? '#E15B64'
        : 'var(--tg-text-primary, #F5F5F5)';
  const bg =
    variant === 'accent'
      ? 'var(--tg-accent, #3390EC)'
      : variant === 'danger'
        ? 'rgba(225, 91, 100, 0.14)'
        : 'rgba(255, 255, 255, 0.06)';
  return {
    padding: '6px 11px',
    borderRadius: '7px',
    border:
      variant === 'accent' ? 'none' : '1px solid var(--tg-border, #242F3D)',
    backgroundColor: bg,
    color,
    fontSize: '12.5px',
    fontWeight: 600,
    cursor: 'pointer',
  };
}
