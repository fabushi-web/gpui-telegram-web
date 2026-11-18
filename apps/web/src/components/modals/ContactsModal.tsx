import React, { useEffect, useMemo, useState } from 'react';
import { DOM_IDS, peerAvatarColorIndex, type UserProfile } from '@gpui-telegram/protocol';
import { getClientAdapter } from '../../adapters';
import { t } from '../../i18n';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';

export interface ContactsModalProps {
  onClose: () => void;
}

export const ContactsModal: React.FC<ContactsModalProps> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const pushToast = useUiStore((s) => s.pushToast);

  const contacts = useChatStore((s) => s.contacts);
  const chatsById = useChatStore((s) => s.chatsById);
  const loadContacts = useChatStore((s) => s.loadContacts);
  const addContact = useChatStore((s) => s.addContact);
  const deleteContact = useChatStore((s) => s.deleteContact);
  const joinByInvite = useChatStore((s) => s.joinByInvite);
  const bootstrapChats = useChatStore((s) => s.bootstrapChats);
  const selectChat = useChatStore((s) => s.selectChat);

  const isZh = language === 'zh-CN';
  const [searchQuery, setSearchQuery] = useState('');
  const [firstName, setFirstName] = useState('');
  const [phoneOrUsername, setPhoneOrUsername] = useState('');
  const [lastName, setLastName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [alertError, setAlertError] = useState<string | null>(null);

  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  const filteredContacts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => {
      const full = `${c.firstName} ${c.lastName ?? ''} ${c.username ?? ''} ${c.phone ?? ''}`.toLowerCase();
      return full.includes(q);
    });
  }, [contacts, searchQuery]);

  const ensureAndSelectDirectChat = async (user: UserProfile, shouldCloseModal: boolean) => {
    const existing = Object.values(useChatStore.getState().chatsById).find(
      (c) => !c.isGroup && !c.isSupergroup && !c.isChannel && !c.isSecret && c.peerUserId === user.userId,
    );
    if (existing) {
      await selectChat(existing.chatId);
      if (shouldCloseModal) onClose();
      return;
    }

    try {
      const displayTitle = `${user.firstName} ${user.lastName ?? ''}`.trim() || user.username || `User ${user.userId}`;
      const created = await getClientAdapter().createChat({
        title: displayTitle,
        chatType: 0,
        peerUserId: user.userId,
      });
      await bootstrapChats();
      await selectChat(created.chatId ?? created.chat_id ?? null);
      if (shouldCloseModal) onClose();
    } catch {
      if (shouldCloseModal) onClose();
    }
  };

  const handleAddContact = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const rawFirst = firstName.trim();
    const rawHandle = phoneOrUsername.trim();
    const rawLast = lastName.trim();

    if (!rawFirst && !rawHandle) {
      setAlertError(
        isZh ? '请输入联系人姓名与手机号/@用户名' : 'Please enter a name and phone or @username.',
      );
      return;
    }

    let resolvedFirst = rawFirst || rawHandle.replace(/^@/, '');
    let resolvedLast = rawLast;
    if (!resolvedLast && resolvedFirst.includes(' ')) {
      const parts = resolvedFirst.split(/\s+/);
      resolvedFirst = parts[0] ?? resolvedFirst;
      resolvedLast = parts.slice(1).join(' ');
    }

    const isPhone = /^[+\d][\d\s()-]{3,}$/.test(rawHandle);
    setAlertError(null);
    try {
      const added = await addContact({
        firstName: resolvedFirst,
        lastName: resolvedLast || undefined,
        phone: isPhone ? rawHandle : undefined,
        username: !isPhone && rawHandle ? rawHandle.replace(/^@+/, '') : undefined,
      });
      setFirstName('');
      setPhoneOrUsername('');
      setLastName('');
      await ensureAndSelectDirectChat(added, false);
      pushToast(
        isZh ? `已添加联系人 ${added.firstName}` : `Added ${added.firstName} to contacts`,
        'success',
      );
    } catch (err) {
      setAlertError(err instanceof Error ? err.message : 'Failed to add contact');
    }
  };

  const handleJoinByInvite = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const code = inviteCode.trim();
    if (!code) {
      setAlertError(isZh ? '请输入邀请链接或邀请码' : 'Please enter an invite code or link.');
      return;
    }
    setAlertError(null);
    try {
      const joined = await joinByInvite(code);
      setInviteCode('');
      await selectChat(joined.chatId);
      onClose();
    } catch (err) {
      setAlertError(
        err instanceof Error
          ? err.message
          : isZh
            ? '邀请链接无效或已失效'
            : 'Invite link is invalid or has been revoked.',
      );
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
        id={DOM_IDS.MODAL_CONTACTS}
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.contacts', language)}
        className="tg-modal-card"
      >
        <div className="tg-modal-header">
          <span>📇 {t('nav.contacts', language)}</span>
          <button
            type="button"
            className="tg-icon-btn"
            aria-label={t('common.close', language)}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="tg-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* Search Contacts */}
          <div className="tg-search-pill">
            <span>🔍</span>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={isZh ? '搜索联系人…' : 'Search contacts…'}
              aria-label={isZh ? '搜索联系人' : 'Search contacts'}
            />
          </div>

          {alertError && (
            <div
              role="alert"
              style={{
                padding: '8px 10px',
                borderRadius: '8px',
                background: 'var(--tg-danger-soft)',
                color: 'var(--tg-danger)',
                fontSize: '12.5px',
              }}
            >
              {alertError}
            </div>
          )}

          {/* Add New Contact Form (First Name at nth(0), Phone/@username at nth(1)) */}
          <form
            onSubmit={handleAddContact}
            className="tg-surface-card"
            style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px' }}
          >
            <div style={{ fontSize: '12.5px', fontWeight: 600 }}>
              + {isZh ? '添加新联系人' : 'Add Contact'}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <input
                type="text"
                name="firstName"
                className="tg-input"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder={isZh ? '名字 (First Name)' : 'First Name'}
                aria-label="First Name"
              />
              <input
                type="tel"
                name="phone"
                className="tg-input"
                value={phoneOrUsername}
                onChange={(e) => setPhoneOrUsername(e.target.value)}
                placeholder={isZh ? '手机号或 @用户名' : 'Phone or @username'}
                aria-label="Phone or Username"
              />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                name="lastName"
                className="tg-input"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder={isZh ? '姓氏 (可选)' : 'Last Name (optional)'}
                aria-label="Last Name"
              />
              <button
                type="submit"
                className="tg-btn tg-btn--primary"
                style={{ flexShrink: 0 }}
              >
                {isZh ? '添加联系人' : 'Add Contact'}
              </button>
            </div>
          </form>

          {/* Contact List */}
          <div
            role="listbox"
            aria-label="Contacts List"
            style={{
              maxHeight: '200px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            {filteredContacts.length === 0 ? (
              <div style={{ fontSize: '13px', color: 'var(--tg-text-secondary)', textAlign: 'center', padding: '14px' }}>
                {isZh ? '暂无匹配的联系人' : 'No contacts found.'}
              </div>
            ) : (
              filteredContacts.map((c) => {
                const fullName = `${c.firstName} ${c.lastName ?? ''}`.trim() || c.username || `User ${c.userId}`;
                const hasChat = Object.values(chatsById).some((ch) => ch.peerUserId === c.userId);
                return (
                  <div
                    key={c.userId}
                    role="option"
                    aria-selected={hasChat}
                    data-user-id={c.userId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      padding: '8px 10px',
                      borderRadius: '8px',
                      background: 'var(--tg-bg-elevated)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => void ensureAndSelectDirectChat(c, true)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        flex: '1 1 auto',
                        textAlign: 'left',
                        minWidth: 0,
                      }}
                    >
                      <div
                        className="tg-avatar tg-avatar--sm"
                        data-color-index={peerAvatarColorIndex(c.userId)}
                      >
                        {fullName.slice(0, 2).toUpperCase()}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: '13.5px', fontWeight: 600 }}>{fullName}</div>
                        <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)' }}>
                          {c.phone ? c.phone : c.username ? `@${c.username}` : c.status}
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      className="tg-btn tg-btn--danger-soft"
                      style={{ padding: '4px 8px', fontSize: '11.5px', flexShrink: 0 }}
                      aria-label={`${t('message.delete', language)} ${fullName}`}
                      onClick={() => void deleteContact(c.userId)}
                    >
                      {t('message.delete', language)}
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Join via Invite Code */}
          <form
            onSubmit={handleJoinByInvite}
            style={{
              display: 'flex',
              gap: '8px',
              paddingTop: '8px',
              borderTop: '1px solid var(--tg-border)',
            }}
          >
            <input
              type="text"
              className="tg-input"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder={isZh ? '通过邀请链接或邀请码加入群聊…' : 'Join group/channel via invite code…'}
              aria-label="Invite Code"
            />
            <button type="submit" className="tg-btn tg-btn--secondary" style={{ flexShrink: 0 }}>
              {isZh ? '加入群聊' : 'Join'}
            </button>
          </form>
        </div>

        <div className="tg-modal-footer">
          <button type="button" className="tg-btn tg-btn--secondary" onClick={onClose}>
            {t('common.close', language)}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ContactsModal;
