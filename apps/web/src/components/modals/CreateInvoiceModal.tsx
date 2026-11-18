import React, { useState } from 'react';
import { t } from '../../i18n';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';

export interface CreateInvoiceModalProps {
  onClose: () => void;
}

export const CreateInvoiceModal: React.FC<CreateInvoiceModalProps> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const modalPayload = useUiStore((s) => s.modalPayload);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const createInvoice = useChatStore((s) => s.createInvoice);

  const isZh = language === 'zh-CN';
  const targetChatId = Number(modalPayload?.chatId ?? activeChatId ?? 0);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('25');
  const [errorAlert, setErrorAlert] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const cleanTitle = title.trim();
    const parsedAmount = Math.round(Number(amount));

    if (!cleanTitle) {
      setErrorAlert(isZh ? '请输入账单标题' : 'Invoice title is required.');
      return;
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setErrorAlert(isZh ? '星币金额必须大于 0' : 'Amount in Stars must be greater than 0.');
      return;
    }
    if (!targetChatId) {
      setErrorAlert(isZh ? '请先选择一个会话' : 'Please select an active chat first.');
      return;
    }

    setIsSubmitting(true);
    setErrorAlert(null);
    try {
      await createInvoice(targetChatId, {
        title: cleanTitle,
        description: description.trim() || cleanTitle,
        currency: 'XTR',
        amount: parsedAmount,
      });
      onClose();
    } catch (err) {
      setErrorAlert(err instanceof Error ? err.message : 'Failed to create invoice');
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
        role="dialog"
        aria-modal="true"
        aria-label={t('invoice.createTitle', language)}
        className="tg-modal-card"
      >
        <div className="tg-modal-header">
          <span>⭐ {t('invoice.createTitle', language)}</span>
          <button
            type="button"
            className="tg-icon-btn"
            aria-label={t('common.close', language)}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit}>
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
              <span>{isZh ? '商品或服务标题 *' : 'Invoice Title *'}</span>
              <input
                type="text"
                className="tg-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={isZh ? '例如：高级工作流订阅' : 'e.g. Premium AI Workflow Pack'}
                aria-label="Invoice Title"
                autoFocus
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <span>{isZh ? '账单说明' : 'Description'}</span>
              <input
                type="text"
                className="tg-input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={isZh ? '补充说明购买内容…' : 'Describe what is included…'}
                aria-label="Invoice Description"
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <span>★ {isZh ? '金额 (Telegram Stars 星币) *' : 'Amount (Telegram Stars) *'}</span>
              <input
                type="number"
                min={1}
                step={1}
                className="tg-input"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-label="Amount in Stars"
              />
            </label>
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
              {isZh ? '创建星币账单' : 'Create Invoice'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateInvoiceModal;
