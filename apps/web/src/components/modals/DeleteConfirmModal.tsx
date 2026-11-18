import React, { useMemo, useState } from 'react';
import { t } from '../../i18n';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';

export interface DeleteConfirmModalProps {
  onClose: () => void;
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const modalPayload = useUiStore((s) => s.modalPayload);

  const activeChatId = useChatStore((s) => s.activeChatId);
  const selectedMessageIds = useChatStore((s) => s.selectedMessageIds);
  const deleteMessages = useChatStore((s) => s.deleteMessages);
  const clearMultiSelect = useChatStore((s) => s.clearMultiSelect);

  const isZh = language === 'zh-CN';
  const [isDeleting, setIsDeleting] = useState(false);

  const targetChatId = useMemo(() => {
    const raw = modalPayload?.chatId ?? activeChatId;
    return typeof raw === 'number' ? raw : Number(raw) || activeChatId || 0;
  }, [modalPayload, activeChatId]);

  const messageIds = useMemo<number[]>(() => {
    if (Array.isArray(modalPayload?.messageIds)) {
      return (modalPayload.messageIds as Array<number | string>).map(Number).filter(Number.isFinite);
    }
    if (modalPayload?.messageId !== undefined) {
      return [Number(modalPayload.messageId)];
    }
    return selectedMessageIds;
  }, [modalPayload, selectedMessageIds]);

  const handleConfirmDelete = async (forEveryone: boolean) => {
    if (!targetChatId || messageIds.length === 0) {
      onClose();
      return;
    }
    setIsDeleting(true);
    try {
      await deleteMessages(targetChatId, messageIds, forEveryone);
      clearMultiSelect();
      onClose();
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div
      className="tg-modal-overlay"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('message.delete', language)}
        className="tg-modal-card"
        style={{ width: 'min(400px, 92vw)' }}
      >
        <div className="tg-modal-header">
          <span>🗑️ {t('message.delete', language)}</span>
          <button
            type="button"
            className="tg-icon-btn"
            aria-label={t('common.close', language)}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="tg-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <p style={{ margin: 0, fontSize: '14px', color: 'var(--tg-text-primary)', lineHeight: 1.5 }}>
            {isZh
              ? `确定要删除选中的 ${messageIds.length} 条消息吗？你可以选择为所有人撤回，或仅为自己本地删除。`
              : `Are you sure you want to delete ${messageIds.length} selected message(s)?`}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
            <button
              type="button"
              data-testid="btn-delete-for-everyone"
              className="tg-btn tg-btn--danger"
              disabled={isDeleting}
              onClick={() => void handleConfirmDelete(true)}
            >
              {isZh ? '为所有人删除 (Delete for everyone)' : 'Delete for everyone'}
            </button>

            <button
              type="button"
              data-testid="btn-delete-for-me"
              className="tg-btn tg-btn--danger-soft"
              disabled={isDeleting}
              onClick={() => void handleConfirmDelete(false)}
            >
              {isZh ? '仅为我删除 (Delete for me)' : 'Delete for me'}
            </button>

            <button
              type="button"
              className="tg-btn tg-btn--secondary"
              disabled={isDeleting}
              onClick={onClose}
            >
              {t('common.cancel', language)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DeleteConfirmModal;
