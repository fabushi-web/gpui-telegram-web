import React, { useState } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { t } from '../../i18n';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';

export interface CreateTodoModalProps {
  onClose: () => void;
}

const MAX_TODO_ITEMS = 30;

export const CreateTodoModal: React.FC<CreateTodoModalProps> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const modalPayload = useUiStore((s) => s.modalPayload);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const activeTopicId = useChatStore((s) => s.activeTopicId);
  const createTodo = useChatStore((s) => s.createTodo);

  const isZh = language === 'zh-CN';
  const targetChatId = Number(modalPayload?.chatId ?? activeChatId ?? 0);

  const [title, setTitle] = useState('');
  const [items, setItems] = useState<string[]>(['', '']);
  const [errorAlert, setErrorAlert] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleItemChange = (idx: number, val: string) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? val : it)));
    if (errorAlert) setErrorAlert(null);
  };

  const handleAddItem = () => {
    if (items.length >= MAX_TODO_ITEMS) return;
    setItems((prev) => [...prev, '']);
  };

  const handleRemoveItem = (idx: number) => {
    if (items.length <= 1) return;
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const cleanTitle = title.trim();
    const cleanItems = items.map((i) => i.trim()).filter(Boolean);

    if (!cleanTitle) {
      setErrorAlert(
        isZh ? '请输入待办清单标题' : 'Checklist title cannot be empty.',
      );
      return;
    }

    if (cleanItems.length < 1 || cleanItems.length > MAX_TODO_ITEMS) {
      setErrorAlert(
        isZh
          ? `请填写 1 至 ${MAX_TODO_ITEMS} 个非空待办项`
          : `Please enter between 1 and ${MAX_TODO_ITEMS} non-empty checklist items.`,
      );
      return;
    }

    if (!targetChatId) {
      setErrorAlert(isZh ? '请先选择一个会话' : 'Please select an active chat first.');
      return;
    }

    setIsSubmitting(true);
    setErrorAlert(null);
    try {
      await createTodo(targetChatId, cleanTitle, cleanItems, activeTopicId ?? undefined);
      onClose();
    } catch (err) {
      setErrorAlert(err instanceof Error ? err.message : 'Failed to create checklist');
    } finally {
      setIsSubmitting(false);
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
        id={DOM_IDS.MODAL_CREATE_TODO}
        role="dialog"
        aria-modal="true"
        aria-label={t('todo.createTitle', language)}
        className="tg-modal-card"
      >
        <div className="tg-modal-header">
          <span>☑️ {t('todo.createTitle', language)}</span>
          <button
            type="button"
            className="tg-icon-btn"
            aria-label={t('common.close', language)}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}>
          <div className="tg-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {errorAlert && (
              <div
                role="alert"
                style={{
                  padding: '8px 12px',
                  borderRadius: '8px',
                  background: 'var(--tg-danger-soft)',
                  color: 'var(--tg-danger)',
                  fontSize: '13px',
                }}
              >
                {errorAlert}
              </div>
            )}

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <span>{t('todo.listTitle', language)} *</span>
              <input
                type="text"
                className="tg-input"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (errorAlert) setErrorAlert(null);
                }}
                placeholder={isZh ? '输入待办清单标题…' : 'Enter checklist title…'}
                aria-label={isZh ? '清单标题' : 'Checklist Title'}
                autoFocus
              />
            </label>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--tg-text-secondary)' }}>
                {isZh
                  ? `待办事项 (${items.length}/${MAX_TODO_ITEMS})`
                  : `Checklist Items (${items.length}/${MAX_TODO_ITEMS})`}
              </div>

              {items.map((val, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="text"
                    className="tg-input"
                    value={val}
                    onChange={(e) => handleItemChange(idx, e.target.value)}
                    placeholder={isZh ? `待办事项 ${idx + 1}` : `Todo item ${idx + 1}`}
                    aria-label={isZh ? `待办事项 ${idx + 1}` : `Todo item ${idx + 1}`}
                  />
                  {items.length > 1 && (
                    <button
                      type="button"
                      className="tg-icon-btn"
                      aria-label={`Remove item ${idx + 1}`}
                      onClick={() => handleRemoveItem(idx)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}

              {items.length < MAX_TODO_ITEMS && (
                <button
                  type="button"
                  className="tg-btn tg-btn--secondary"
                  style={{ alignSelf: 'flex-start', padding: '5px 12px', fontSize: '12.5px' }}
                  onClick={handleAddItem}
                >
                  + {t('todo.addItem', language)}
                </button>
              )}
            </div>
          </div>

          <div className="tg-modal-footer">
            <button type="button" className="tg-btn tg-btn--secondary" onClick={onClose}>
              {t('common.cancel', language)}
            </button>
            <button
              type="submit"
              className="tg-btn tg-btn--primary"
              disabled={isSubmitting}
            >
              {t('common.create', language)}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateTodoModal;
