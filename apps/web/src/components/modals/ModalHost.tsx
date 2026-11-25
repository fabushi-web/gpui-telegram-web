import React, { useEffect, useState } from 'react';
import {
  peerAvatarColorIndex,
  type ReactionDetail,
} from '@gpui-telegram/protocol';
import { t } from '../../i18n';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore, type ModalId } from '../../store/useUiStore';
import { ContactsModal } from './ContactsModal';
import { CreateBotModal } from './CreateBotModal';
import { CreateChannelModal } from './CreateChannelModal';
import { CreateGroupModal } from './CreateGroupModal';
import { CreateInvoiceModal } from './CreateInvoiceModal';
import { CreatePollModal } from './CreatePollModal';
import { CreateTodoModal } from './CreateTodoModal';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { ForwardModal } from './ForwardModal';
import { ShortcutsModal } from './ShortcutsModal';

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

const SecretChatPickerModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const currentUser = useAuthStore((s) => s.currentUser);
  const contacts = useChatStore((s) => s.contacts);
  const peersById = useChatStore((s) => s.peersById);
  const loadContacts = useChatStore((s) => s.loadContacts);
  const createSecretChat = useChatStore((s) => s.createSecretChat);
  const isZh = language === 'zh-CN';

  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  const users = [...contacts, ...Object.values(peersById)].filter(
    (u, idx, arr) =>
      u.userId !== currentUser?.userId &&
      arr.findIndex((x) => x.userId === u.userId) === idx,
  );

  return (
    <div className="tg-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={t('menu.newSecretChat', language)} className="tg-modal-card">
        <div className="tg-modal-header">
          <span>🔒 {t('menu.newSecretChat', language)}</span>
          <button type="button" className="tg-icon-btn" onClick={onClose} aria-label={t('common.close', language)}>×</button>
        </div>
        <div className="tg-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)' }}>
            {isZh ? '选择联系人开启 ECDH + AES-256-GCM 端到端加密对话' : 'Select a contact to start an ECDH + AES-256-GCM Secret Chat:'}
          </div>
          {users.map((u) => {
            const name = `${u.firstName} ${u.lastName ?? ''}`.trim() || u.username || `User ${u.userId}`;
            return (
              <button
                key={u.userId}
                type="button"
                className="tg-btn tg-btn--secondary"
                style={{ justifyContent: 'flex-start', gap: '10px' }}
                onClick={async () => {
                  await createSecretChat(u.userId, 30);
                  onClose();
                }}
              >
                <span className="tg-avatar tg-avatar--sm" data-color-index={peerAvatarColorIndex(u.userId)}>
                  {name.slice(0, 2).toUpperCase()}
                </span>
                <span>{name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const CreateStoryModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const createStory = useChatStore((s) => s.createStory);
  const [caption, setCaption] = useState('');
  const isZh = language === 'zh-CN';

  return (
    <div className="tg-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={t('stories.post', language)} className="tg-modal-card">
        <div className="tg-modal-header">
          <span>✨ {t('stories.post', language)}</span>
          <button type="button" className="tg-icon-btn" onClick={onClose} aria-label={t('common.close', language)}>×</button>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!caption.trim()) return;
            await createStory({
              caption: caption.trim(),
              backgroundGradient: 'linear-gradient(135deg, #1B4978 0%, #00C972 100%)',
            });
            onClose();
          }}
        >
          <div className="tg-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <textarea
              className="tg-textarea"
              rows={3}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder={isZh ? '输入 24 小时动态文案…' : 'Write your story update…'}
              aria-label="Story Caption"
              autoFocus
            />
          </div>
          <div className="tg-modal-footer">
            <button type="button" className="tg-btn tg-btn--secondary" onClick={onClose}>{t('common.cancel', language)}</button>
            <button type="submit" className="tg-btn tg-btn--primary">{t('stories.post', language)}</button>
          </div>
        </form>
      </div>
    </div>
  );
};

const CreateTopicModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const modalPayload = useUiStore((s) => s.modalPayload);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const createTopic = useChatStore((s) => s.createTopic);
  const selectChat = useChatStore((s) => s.selectChat);
  const [title, setTitle] = useState('');
  const [emoji, setEmoji] = useState('💬');
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const isZh = language === 'zh-CN';
  const targetChatId = Number(modalPayload?.chatId ?? activeChatId ?? 0);

  return (
    <div className="tg-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={t('topics.create', language)} className="tg-modal-card">
        <div className="tg-modal-header">
          <span>💬 {t('topics.create', language)}</span>
          <button type="button" className="tg-icon-btn" onClick={onClose} aria-label={t('common.close', language)}>×</button>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim()) {
              setAlertMsg(isZh ? '话题标题不能为空' : 'Topic title is required.');
              return;
            }
            if (!targetChatId) return;
            const created = await createTopic(targetChatId, title.trim(), emoji || '💬');
            await selectChat(targetChatId, created.topicId);
            onClose();
          }}
        >
          <div className="tg-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {alertMsg && (
              <div role="alert" style={{ color: 'var(--tg-danger)', fontSize: '12.5px' }}>
                {alertMsg}
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                className="tg-input"
                style={{ width: '56px', textAlign: 'center' }}
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                aria-label="Topic Icon"
              />
              <input
                type="text"
                className="tg-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={isZh ? '输入话题名称…' : 'Enter topic title…'}
                aria-label="Topic Title"
                autoFocus
              />
            </div>
          </div>
          <div className="tg-modal-footer">
            <button type="button" className="tg-btn tg-btn--secondary" onClick={onClose}>{t('common.cancel', language)}</button>
            <button type="submit" className="tg-btn tg-btn--primary">{t('common.create', language)}</button>
          </div>
        </form>
      </div>
    </div>
  );
};

const FolderEditorModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const modalPayload = useUiStore((s) => s.modalPayload);
  const upsertFolder = useChatStore((s) => s.upsertFolder);
  const chatsById = useChatStore((s) => s.chatsById);
  const orderedChatIds = useChatStore((s) => s.orderedChatIds);
  const [title, setTitle] = useState(String(modalPayload?.title ?? ''));
  const [includedIds, setIncludedIds] = useState<number[]>(
    Array.isArray(modalPayload?.includedChatIds)
      ? (modalPayload.includedChatIds as number[])
      : [],
  );
  const isZh = language === 'zh-CN';

  return (
    <div className="tg-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={t('folder.create', language)} className="tg-modal-card">
        <div className="tg-modal-header">
          <span>📁 {t('folder.create', language)}</span>
          <button type="button" className="tg-icon-btn" onClick={onClose} aria-label={t('common.close', language)}>×</button>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim()) return;
            await upsertFolder({
              id: typeof modalPayload?.id === 'number' ? modalPayload.id : undefined,
              title: title.trim(),
              includedChatIds: includedIds,
            });
            onClose();
          }}
        >
          <div className="tg-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <input
              type="text"
              className="tg-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={isZh ? '分组名称…' : 'Folder name…'}
              aria-label="Folder Title"
              autoFocus
            />
            <div style={{ maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {orderedChatIds.map((cid) => {
                const c = chatsById[cid];
                if (!c) return null;
                const checked = includedIds.includes(cid);
                return (
                  <label key={cid} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px', fontSize: '13px' }}>
                    <span>{c.title}</span>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setIncludedIds((prev) =>
                          checked ? prev.filter((x) => x !== cid) : [...prev, cid],
                        )
                      }
                    />
                  </label>
                );
              })}
            </div>
          </div>
          <div className="tg-modal-footer">
            <button type="button" className="tg-btn tg-btn--secondary" onClick={onClose}>{t('common.cancel', language)}</button>
            <button type="submit" className="tg-btn tg-btn--primary">{t('common.save', language)}</button>
          </div>
        </form>
      </div>
    </div>
  );
};

const ReactionDetailsModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const modalPayload = useUiStore((s) => s.modalPayload);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const peersById = useChatStore((s) => s.peersById);
  const fetchReactionDetails = useChatStore((s) => s.fetchReactionDetails);
  const [details, setDetails] = useState<ReactionDetail[]>([]);

  useEffect(() => {
    const chatId = Number(modalPayload?.chatId ?? activeChatId ?? 0);
    const messageId = Number(modalPayload?.messageId ?? 0);
    if (!chatId || !messageId) return;
    void fetchReactionDetails(chatId, messageId).then(setDetails).catch(() => undefined);
  }, [modalPayload, activeChatId, fetchReactionDetails]);

  return (
    <div className="tg-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={t('reactions.whoReacted', language)} className="tg-modal-card">
        <div className="tg-modal-header">
          <span>👍 {t('reactions.whoReacted', language)}</span>
          <button type="button" className="tg-icon-btn" onClick={onClose} aria-label={t('common.close', language)}>×</button>
        </div>
        <div className="tg-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {details.map((d) => (
            <div key={d.emoji} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px', background: 'var(--tg-bg-elevated)', borderRadius: '8px' }}>
              <span>
                {d.emoji} ({d.count})
              </span>
              <span style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                {d.user_ids.map((uid) => peersById[uid]?.firstName ?? `User ${uid}`).join(', ')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const PasscodeSetupModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const setPasscode = useAuthStore((s) => s.setPasscode);
  const [pin, setPin] = useState('');

  return (
    <div className="tg-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={t('passcode.enable', language)} className="tg-modal-card">
        <div className="tg-modal-header">
          <span>🔐 {t('passcode.enable', language)}</span>
          <button type="button" className="tg-icon-btn" onClick={onClose} aria-label={t('common.close', language)}>×</button>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!pin.trim()) return;
            await setPasscode(pin.trim());
            onClose();
          }}
        >
          <div className="tg-modal-body">
            <input
              type="password"
              name="passcode"
              className="tg-input"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder={t('passcode.placeholder', language)}
              aria-label="Passcode"
              autoFocus
            />
          </div>
          <div className="tg-modal-footer">
            <button type="button" className="tg-btn tg-btn--secondary" onClick={onClose}>{t('common.cancel', language)}</button>
            <button type="submit" className="tg-btn tg-btn--primary">{t('common.save', language)}</button>
          </div>
        </form>
      </div>
    </div>
  );
};

export const ModalHost: React.FC = () => {
  const activeModal = useUiStore((s) => s.activeModal);
  const closeModal = useUiStore((s) => s.closeModal);

  const modalKey = activeModal as string | null;

  const isOwnedModalOpen =
    modalKey === 'create_group' ||
    modalKey === 'create_channel' ||
    modalKey === 'create_bot' ||
    modalKey === 'contacts' ||
    modalKey === 'forward_messages' ||
    modalKey === 'create_poll' ||
    modalKey === 'create_todo' ||
    modalKey === 'create_invoice' ||
    modalKey === 'delete_confirm' ||
    modalKey === 'shortcuts' ||
    modalKey === 'create_secret_chat' ||
    modalKey === 'create_story' ||
    modalKey === 'create_topic' ||
    modalKey === 'folder_editor' ||
    modalKey === 'reaction_details' ||
    modalKey === 'passcode_setup';

  useEffect(() => {
    const onOpenShortcuts = () => {
      useUiStore.setState({
        activeModal: 'shortcuts' as unknown as ModalId,
        modalPayload: { source: 'event' },
      });
    };

    const onKeyDownCapture = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && isOwnedModalOpen) {
        const ui = useUiStore.getState();
        // Respect higher-priority Layer 1/2 overlays if open
        if (
          ui.contextMenu ||
          ui.composerPopover ||
          ui.lightboxState?.isOpen ||
          ui.mediaEditorState?.isOpen ||
          ui.storiesViewerState?.isOpen ||
          ui.instantViewState?.isOpen
        ) {
          return;
        }
        ev.preventDefault();
        ev.stopImmediatePropagation();
        closeModal();
        return;
      }

      if (
        (ev.key === '?' || (ev.code === 'Slash' && ev.shiftKey)) &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        !ev.altKey &&
        !ev.defaultPrevented &&
        !isEditableElement(ev.target)
      ) {
        const auth = useAuthStore.getState();
        if (!auth.isAuthenticated || auth.isLocked) return;
        ev.preventDefault();
        useUiStore.setState({
          activeModal: 'shortcuts' as unknown as ModalId,
          modalPayload: { source: 'keyboard' },
        });
      }
    };

    window.addEventListener('gpui:open-shortcuts', onOpenShortcuts);
    window.addEventListener('keydown', onKeyDownCapture, true);
    return () => {
      window.removeEventListener('gpui:open-shortcuts', onOpenShortcuts);
      window.removeEventListener('keydown', onKeyDownCapture, true);
    };
  }, [isOwnedModalOpen, closeModal]);

  switch (modalKey) {
    case 'create_group':
      return <CreateGroupModal onClose={closeModal} />;
    case 'create_channel':
      return <CreateChannelModal onClose={closeModal} />;
    case 'create_bot':
      return <CreateBotModal onClose={closeModal} />;
    case 'contacts':
      return <ContactsModal onClose={closeModal} />;
    case 'forward_messages':
      return <ForwardModal onClose={closeModal} />;
    case 'create_poll':
      return <CreatePollModal onClose={closeModal} />;
    case 'create_todo':
      return <CreateTodoModal onClose={closeModal} />;
    case 'create_invoice':
      return <CreateInvoiceModal onClose={closeModal} />;
    case 'delete_confirm':
      return <DeleteConfirmModal onClose={closeModal} />;
    case 'shortcuts':
      return <ShortcutsModal onClose={closeModal} />;
    case 'create_secret_chat':
      return <SecretChatPickerModal onClose={closeModal} />;
    case 'create_story':
      return <CreateStoryModal onClose={closeModal} />;
    case 'create_topic':
      return <CreateTopicModal onClose={closeModal} />;
    case 'folder_editor':
      return <FolderEditorModal onClose={closeModal} />;
    case 'reaction_details':
      return <ReactionDetailsModal onClose={closeModal} />;
    case 'passcode_setup':
      return <PasscodeSetupModal onClose={closeModal} />;
    default:
      return null;
  }
};

export default ModalHost;
