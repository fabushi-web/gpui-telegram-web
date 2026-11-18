import React, { useState } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { t } from '../../i18n';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';

export interface CreateChannelModalProps {
  onClose: () => void;
}

export const CreateChannelModal: React.FC<CreateChannelModalProps> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const createGroupOrChannel = useChatStore((s) => s.createGroupOrChannel);
  const selectChat = useChatStore((s) => s.selectChat);

  const isZh = language === 'zh-CN';
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [username, setUsername] = useState('');
  const [errorAlert, setErrorAlert] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setErrorAlert(
        isZh ? '请输入有效的频道名称（不能为空白）' : 'Channel title is required and cannot be blank.',
      );
      return;
    }

    const cleanHandle = username.trim().replace(/^@+/, '');
    setIsSubmitting(true);
    setErrorAlert(null);
    try {
      const created = await createGroupOrChannel({
        title: trimmed,
        kind: 'channel',
        about: description.trim() || undefined,
        username: cleanHandle || undefined,
      });
      await selectChat(created.chatId);
      onClose();
    } catch (err) {
      setErrorAlert(err instanceof Error ? err.message : 'Failed to create channel');
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
        id={DOM_IDS.MODAL_CREATE_CHANNEL}
        role="dialog"
        aria-modal="true"
        aria-label={t('menu.newChannel', language)}
        className="tg-modal-card"
      >
        <div className="tg-modal-header">
          <span>📢 {t('menu.newChannel', language)}</span>
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
              <span>{isZh ? '频道名称 *' : 'Channel Name *'}</span>
              <input
                type="text"
                className="tg-input"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (errorAlert) setErrorAlert(null);
                }}
                placeholder={isZh ? '输入频道名称…' : 'Enter channel name…'}
                aria-label={isZh ? '频道名称' : 'Channel Name'}
                autoFocus
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <span>{isZh ? '频道简介 (可选)' : 'Description (optional)'}</span>
              <textarea
                className="tg-textarea"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={isZh ? '向订阅者介绍该频道…' : 'Describe what your channel is about…'}
                aria-label={isZh ? '频道简介' : 'Channel Description'}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <span>{isZh ? '公开链接用户名 @username (可选)' : 'Public Link @username (optional)'}</span>
              <input
                type="text"
                className="tg-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="channel_public_link"
                aria-label={isZh ? '公开链接用户名' : 'Public Link Username'}
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
              {t('common.create', language)}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateChannelModal;
