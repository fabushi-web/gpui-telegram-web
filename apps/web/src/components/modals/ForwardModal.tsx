import React, { useMemo, useState } from 'react';
import { DATA_ATTRS, DOM_IDS, peerAvatarColorIndex } from '@gpui-telegram/protocol';
import { t } from '../../i18n';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';

export interface ForwardModalProps {
  onClose: () => void;
}

export const ForwardModal: React.FC<ForwardModalProps> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const modalPayload = useUiStore((s) => s.modalPayload);
  const pushToast = useUiStore((s) => s.pushToast);

  const activeChatId = useChatStore((s) => s.activeChatId);
  const orderedChatIds = useChatStore((s) => s.orderedChatIds);
  const chatsById = useChatStore((s) => s.chatsById);
  const selectedMessageIds = useChatStore((s) => s.selectedMessageIds);
  const forwardMessages = useChatStore((s) => s.forwardMessages);
  const openSavedMessages = useChatStore((s) => s.openSavedMessages);
  const selectChat = useChatStore((s) => s.selectChat);
  const clearMultiSelect = useChatStore((s) => s.clearMultiSelect);

  const isZh = language === 'zh-CN';

  const fromChatId = useMemo(() => {
    const raw = modalPayload?.chatId ?? modalPayload?.fromChatId ?? activeChatId;
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

  const savedChat = useMemo(
    () => Object.values(chatsById).find((c) => c.isSavedMessages) ?? null,
    [chatsById],
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTargetId, setSelectedTargetId] = useState<number | 'saved' | null>(
    savedChat ? savedChat.chatId : 'saved',
  );
  const [hideSender, setHideSender] = useState(false);
  const [comment, setComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const targetChats = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return orderedChatIds
      .map((id) => chatsById[id])
      .filter((c): c is NonNullable<typeof c> => Boolean(c && !c.isSavedMessages))
      .filter((c) => !q || c.title.toLowerCase().includes(q));
  }, [orderedChatIds, chatsById, searchQuery]);

  const showSavedMessagesRow = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const savedLabel = `${t('chat.savedMessages', 'en-US')} ${t('chat.savedMessages', 'zh-CN')} 已保存`.toLowerCase();
    return savedLabel.includes(q);
  }, [searchQuery]);

  const executeForward = async (explicitTarget?: number | 'saved') => {
    const targetChoice = explicitTarget ?? selectedTargetId;
    if (!targetChoice || !fromChatId || messageIds.length === 0) return;

    setIsSubmitting(true);
    try {
      let targetChatId: number;
      if (targetChoice === 'saved') {
        const saved = savedChat ?? (await openSavedMessages());
        targetChatId = saved.chatId;
      } else {
        targetChatId = targetChoice;
      }

      await forwardMessages(fromChatId, targetChatId, messageIds, {
        hideSender,
        comment: comment.trim() || undefined,
      });
      clearMultiSelect();
      await selectChat(targetChatId);
      pushToast(
        isZh ? `已转发 ${messageIds.length} 条消息` : `Forwarded ${messageIds.length} message(s)`,
        'success',
      );
      onClose();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Forward failed', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const savedChatAttr: Record<string, string | number> = savedChat
    ? { [DATA_ATTRS.CHAT_ID]: savedChat.chatId }
    : {};

  return (
    <div
      className="tg-modal-overlay"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        id={DOM_IDS.MODAL_FORWARD}
        role="dialog"
        aria-modal="true"
        aria-label={t('message.forward', language)}
        className="tg-modal-card"
      >
        <div className="tg-modal-header">
          <span>
            ↪ {t('message.forward', language)} ({messageIds.length})
          </span>
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
          {/* Search Target Chats */}
          <div className="tg-search-pill">
            <span>🔍</span>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={isZh ? '搜索转发目标会话…' : 'Search target chat…'}
              aria-label={isZh ? '搜索会话' : 'Search chats'}
              autoFocus
            />
          </div>

          {/* Hide Sender Name Toggle */}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 10px',
              borderRadius: '8px',
              background: 'var(--tg-bg-elevated)',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={hideSender}
              onChange={(e) => setHideSender(e.target.checked)}
              aria-label={isZh ? '隐藏发送者姓名' : 'Hide sender name'}
            />
            <span>{isZh ? '隐藏发送者姓名 (Hide sender name)' : 'Hide sender name'}</span>
          </label>

          {/* Optional Forward Comment */}
          <input
            type="text"
            className="tg-input"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={isZh ? '添加留言附言 (可选)…' : 'Add a comment or note (optional)…'}
            aria-label={isZh ? '转发留言' : 'Forward comment'}
          />

          {/* Target Chat List */}
          <div
            role="listbox"
            aria-label="Target Chats"
            style={{
              maxHeight: '220px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}
          >
            {showSavedMessagesRow && (
              <button
                type="button"
                role="option"
                aria-selected={
                  selectedTargetId === 'saved' ||
                  (savedChat !== null && selectedTargetId === savedChat.chatId)
                }
                {...savedChatAttr}
                onClick={() =>
                  setSelectedTargetId(savedChat ? savedChat.chatId : 'saved')
                }
                onDoubleClick={() =>
                  void executeForward(savedChat ? savedChat.chatId : 'saved')
                }
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '8px 10px',
                  borderRadius: '8px',
                  background:
                    selectedTargetId === 'saved' ||
                    (savedChat !== null && selectedTargetId === savedChat.chatId)
                      ? 'var(--tg-accent-soft)'
                      : 'var(--tg-bg-elevated)',
                  border:
                    selectedTargetId === 'saved' ||
                    (savedChat !== null && selectedTargetId === savedChat.chatId)
                      ? '1px solid var(--tg-accent)'
                      : '1px solid transparent',
                  textAlign: 'left',
                }}
              >
                <div className="tg-avatar tg-avatar--sm" data-color-index="0">
                  🔖
                </div>
                <div>
                  <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
                    {t('chat.savedMessages', language)}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--tg-text-secondary)' }}>
                    {isZh ? '转发至个人云端收藏夹' : 'Forward to private cloud vault'}
                  </div>
                </div>
              </button>
            )}

            {targetChats.map((c) => {
              const selected = selectedTargetId === c.chatId;
              const chatAttr: Record<string, number> = {
                [DATA_ATTRS.CHAT_ID]: c.chatId,
              };
              return (
                <button
                  key={c.chatId}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  {...chatAttr}
                  onClick={() => setSelectedTargetId(c.chatId)}
                  onDoubleClick={() => void executeForward(c.chatId)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '8px 10px',
                    borderRadius: '8px',
                    background: selected ? 'var(--tg-accent-soft)' : 'var(--tg-bg-elevated)',
                    border: selected ? '1px solid var(--tg-accent)' : '1px solid transparent',
                    textAlign: 'left',
                  }}
                >
                  <div
                    className="tg-avatar tg-avatar--sm"
                    data-color-index={peerAvatarColorIndex(c.peerUserId ?? c.chatId)}
                  >
                    {c.title.slice(0, 2).toUpperCase()}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: '13.5px',
                        fontWeight: 600,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.title}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--tg-text-secondary)' }}>
                      {c.kind}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="tg-modal-footer">
          <button type="button" className="tg-btn tg-btn--secondary" onClick={onClose}>
            {t('common.cancel', language)}
          </button>
          <button
            type="button"
            className="tg-btn tg-btn--primary"
            disabled={!selectedTargetId || isSubmitting || messageIds.length === 0}
            onClick={() => void executeForward()}
          >
            {t('message.forward', language)}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ForwardModal;
