import React, { useEffect, useMemo, useState } from 'react';
import { DOM_IDS, peerAvatarColorIndex } from '@gpui-telegram/protocol';
import { getClientAdapter } from '../../adapters';
import { t } from '../../i18n';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';

export interface CreateGroupModalProps {
  onClose: () => void;
}

export const CreateGroupModal: React.FC<CreateGroupModalProps> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const currentUser = useAuthStore((s) => s.currentUser);
  const contacts = useChatStore((s) => s.contacts);
  const peersById = useChatStore((s) => s.peersById);
  const loadContacts = useChatStore((s) => s.loadContacts);
  const createGroupOrChannel = useChatStore((s) => s.createGroupOrChannel);
  const selectChat = useChatStore((s) => s.selectChat);

  const isZh = language === 'zh-CN';
  const [title, setTitle] = useState('');
  const [about, setAbout] = useState('');
  const [isForum, setIsForum] = useState(false);
  const [memberQuery, setMemberQuery] = useState('');
  const [searchedPeers, setSearchedPeers] = useState<
    Array<{ userId: number; name: string; username?: string }>
  >([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [errorAlert, setErrorAlert] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  useEffect(() => {
    const q = memberQuery.trim();
    if (!q) {
      setSearchedPeers([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const adapter = getClientAdapter();
      const found: Array<{ userId: number; name: string; username?: string }> = [];
      try {
        const res = await adapter.searchGlobal(q, { tab: 'chats' });
        for (const u of res?.users ?? []) {
          const uid = Number(u.user_id);
          if (!uid || uid === currentUser?.userId) continue;
          found.push({
            userId: uid,
            name: `${u.first_name} ${u.last_name ?? ''}`.trim() || u.username || `User ${uid}`,
            username: u.username,
          });
        }
      } catch {
        // Ignore transient search error
      }
      if (found.length === 0) {
        try {
          const resolved = await adapter.resolveUsername(q.replace(/^@/, ''));
          if (resolved.user && resolved.user.userId !== currentUser?.userId) {
            found.push({
              userId: resolved.user.userId,
              name:
                `${resolved.user.firstName} ${resolved.user.lastName ?? ''}`.trim() ||
                resolved.user.username ||
                `User ${resolved.user.userId}`,
              username: resolved.user.username,
            });
          }
        } catch {
          // Ignore not found
        }
      }
      if (!cancelled) {
        setSearchedPeers(found);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [memberQuery, currentUser?.userId]);

  const candidateUsers = useMemo(() => {
    const map = new Map<
      number,
      { userId: number; name: string; username?: string }
    >();
    for (const u of [...contacts, ...Object.values(peersById)]) {
      if (!u.userId || u.userId === currentUser?.userId) continue;
      map.set(u.userId, {
        userId: u.userId,
        name: `${u.firstName} ${u.lastName ?? ''}`.trim() || u.username || `User ${u.userId}`,
        username: u.username,
      });
    }
    for (const sp of searchedPeers) {
      map.set(sp.userId, sp);
    }
    const all = Array.from(map.values());
    const q = memberQuery.trim().toLowerCase().replace(/^@/, '');
    if (!q) return all;
    return all.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        (u.username?.toLowerCase().includes(q) ?? false) ||
        selectedIds.includes(u.userId),
    );
  }, [contacts, peersById, searchedPeers, memberQuery, selectedIds, currentUser?.userId]);

  const toggleMember = (userId: number) => {
    setSelectedIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  };

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setErrorAlert(
        isZh ? '请输入有效的群组名称（不能为空白）' : 'Group title is required and cannot be blank.',
      );
      return;
    }

    setIsSubmitting(true);
    setErrorAlert(null);
    try {
      const created = await createGroupOrChannel({
        title: trimmed,
        kind: isForum ? 'supergroup' : 'group',
        about: about.trim() || undefined,
        isForum,
        memberIds: selectedIds,
      });
      await selectChat(created.chatId);
      onClose();
    } catch (err) {
      setErrorAlert(err instanceof Error ? err.message : 'Failed to create group');
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
        id={DOM_IDS.MODAL_CREATE_GROUP}
        role="dialog"
        aria-modal="true"
        aria-label={t('menu.newGroup', language)}
        className="tg-modal-card"
      >
        <div className="tg-modal-header">
          <span>👥 {t('menu.newGroup', language)}</span>
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
              <span>{isZh ? '群组名称 *' : 'Group Name *'}</span>
              <input
                type="text"
                className="tg-input"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (errorAlert) setErrorAlert(null);
                }}
                placeholder={isZh ? '输入群组名称…' : 'Enter group title…'}
                aria-label={isZh ? '群组名称' : 'Group Name'}
                autoFocus
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <span>{isZh ? '群组简介 (可选)' : 'About / Description (optional)'}</span>
              <input
                type="text"
                className="tg-input"
                value={about}
                onChange={(e) => setAbout(e.target.value)}
                placeholder={isZh ? '群组用途说明…' : 'Group purpose or description…'}
                aria-label={isZh ? '群组简介' : 'Group Description'}
              />
            </label>

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
                checked={isForum}
                onChange={(e) => setIsForum(e.target.checked)}
              />
              <span>
                💬 {isZh ? '启用超级群组话题模式 (Topics)' : 'Forum Supergroup (Enable Topics)'}
              </span>
            </label>

            <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--tg-text-secondary)' }}>
              {isZh ? `选择初始成员 (${selectedIds.length})` : `Add Members (${selectedIds.length})`}
            </div>

            <input
              type="search"
              className="tg-input"
              value={memberQuery}
              onChange={(e) => setMemberQuery(e.target.value)}
              placeholder={isZh ? '搜索成员或 @用户名…' : 'Search members or @username…'}
              aria-label={isZh ? '搜索成员' : 'Search members'}
            />

            <div
              role="listbox"
              aria-multiselectable="true"
              style={{
                maxHeight: '190px',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}
            >
              {candidateUsers.map((u) => {
                const checked = selectedIds.includes(u.userId);
                return (
                  <label
                    key={u.userId}
                    role="option"
                    aria-selected={checked}
                    data-user-id={u.userId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '10px',
                      padding: '7px 10px',
                      borderRadius: '8px',
                      background: checked ? 'var(--tg-accent-soft)' : 'var(--tg-bg-elevated)',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div
                        className="tg-avatar tg-avatar--sm"
                        data-color-index={peerAvatarColorIndex(u.userId)}
                      >
                        {u.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 600 }}>{u.name}</div>
                        {u.username && (
                          <div style={{ fontSize: '11px', color: 'var(--tg-text-secondary)' }}>
                            @{u.username}
                          </div>
                        )}
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleMember(u.userId)}
                    />
                  </label>
                );
              })}
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

export default CreateGroupModal;
