import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DOM_IDS,
  type BotRegistryEntry,
  type ChatSummary,
  type UserProfile,
} from '@gpui-telegram/protocol';
import { getServerAdapter } from '../../adapters';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore, type ComposeRecipient } from '../../store/useUiStore';
import { GrokBotAvatar } from '../common/GrokBotAvatar';

interface CandidateItem {
  userId: number;
  name: string;
  username?: string;
  isBot: boolean;
  avatarShape?: string;
  avatarColor?: string;
  companionChatId?: number | null;
  colorIndex: number;
}

function getInitials(name: string): string {
  const clean = name.trim();
  if (!clean) return '?';
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

export const AppleComposeStage: React.FC = () => {
  const language = useSettingsStore((s) => s.language);
  const isZh = language === 'zh-CN';

  const currentUser = useAuthStore((s) => s.currentUser);
  const contacts = useChatStore((s) => s.contacts);
  const peersById = useChatStore((s) => s.peersById);
  const chatsById = useChatStore((s) => s.chatsById);
  const loadContacts = useChatStore((s) => s.loadContacts);
  const bootstrapChats = useChatStore((s) => s.bootstrapChats);
  const selectChat = useChatStore((s) => s.selectChat);
  const saveDraft = useChatStore((s) => s.saveDraft);
  const sendText = useChatStore((s) => s.sendText);
  const createGroupOrChannel = useChatStore((s) => s.createGroupOrChannel);
  const resolveUsername = useChatStore((s) => s.resolveUsername);

  const bots = useAiWorkspaceStore((s) => s.bots);
  const loadBots = useAiWorkspaceStore((s) => s.loadBots);

  const composeState = useUiStore((s) => s.appleComposeStage);
  const closeAppleComposeStage = useUiStore((s) => s.closeAppleComposeStage);
  const addComposeRecipient = useUiStore((s) => s.addComposeRecipient);
  const removeComposeRecipient = useUiStore((s) => s.removeComposeRecipient);
  const setComposePending = useUiStore((s) => s.setComposePending);
  const openModal = useUiStore((s) => s.openModal);
  const pushToast = useUiStore((s) => s.pushToast);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [composeText, setComposeText] = useState<string>(composeState.carryDraft || '');
  const [remoteUsers, setRemoteUsers] = useState<CandidateItem[]>([]);
  const [fabushiBots, setFabushiBots] = useState<
    Array<{
      bot_user_id: number;
      display_name: string;
      username: string;
      agent_id: string;
      avatar_shape: string;
      avatar_color: string;
      companion_chat_id?: number | null;
    }>
  >([]);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const composeTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Hydrate contacts & bots on open (strictly without touching activeChatId!)
  useEffect(() => {
    void loadContacts().catch(() => undefined);
    void loadBots().catch(() => undefined);
    void getServerAdapter()
      .listFabushiBots()
      .then((list) => setFabushiBots(list))
      .catch(() => undefined);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [loadBots, loadContacts]);

  // Live remote search / username resolution when user types a query
  useEffect(() => {
    const q = searchQuery.trim().replace(/^@/, '');
    if (q.length < 2) {
      setRemoteUsers([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const adapter = getServerAdapter();
        const found: CandidateItem[] = [];
        const seen = new Set<number>();

        const searchRes = await adapter.searchGlobal(q, { tab: 'chats' }).catch(() => null);
        for (const u of searchRes?.users ?? []) {
          if (u.user_id && u.user_id !== currentUser?.userId && !seen.has(u.user_id)) {
            seen.add(u.user_id);
            found.push({
              userId: u.user_id,
              name: `${u.first_name}${u.last_name ? ` ${u.last_name}` : ''}`.trim() || u.username || `User #${u.user_id}`,
              username: u.username,
              isBot: Boolean(u.is_bot),
              colorIndex: Math.abs(u.user_id) % 7,
            });
          }
        }

        if (q.length >= 3 && /^[a-zA-Z0-9_]+$/.test(q)) {
          const resolved = await resolveUsername(q).catch(() => null);
          if (resolved?.user && resolved.user.userId !== currentUser?.userId && !seen.has(resolved.user.userId)) {
            seen.add(resolved.user.userId);
            found.push({
              userId: resolved.user.userId,
              name: `${resolved.user.firstName}${resolved.user.lastName ? ` ${resolved.user.lastName}` : ''}`.trim(),
              username: resolved.user.username,
              isBot: Boolean(resolved.user.isBot),
              colorIndex: resolved.user.colorIndex,
            });
          }
        }

        if (!cancelled) {
          setRemoteUsers(found);
        }
      } catch {
        if (!cancelled) setRemoteUsers([]);
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentUser?.userId, resolveUsername, searchQuery]);

  // Build deduplicated candidate list from real contacts, 1v1 chats, peers, bots, and remote hits
  const candidates = useMemo<CandidateItem[]>(() => {
    const map = new Map<number, CandidateItem>();
    const myUid = currentUser?.userId;
    const selectedIds = new Set(composeState.recipients.map((r) => r.userId));

    const addUser = (u: UserProfile): void => {
      if (u.userId === myUid || selectedIds.has(u.userId)) return;
      if (!map.has(u.userId)) {
        map.set(u.userId, {
          userId: u.userId,
          name: `${u.firstName}${u.lastName ? ` ${u.lastName}` : ''}`.trim() || u.username || `User #${u.userId}`,
          username: u.username,
          isBot: Boolean(u.isBot),
          colorIndex: u.colorIndex,
        });
      }
    };

    const addBot = (b: BotRegistryEntry): void => {
      if (selectedIds.has(b.bot_user_id)) return;
      map.set(b.bot_user_id, {
        userId: b.bot_user_id,
        name: b.display_name || b.username,
        username: b.username,
        isBot: true,
        avatarShape: b.avatar_shape,
        avatarColor: b.avatar_color,
        colorIndex: Math.abs(b.bot_user_id) % 7,
      });
    };

    for (const fb of fabushiBots) {
      if (selectedIds.has(fb.bot_user_id)) continue;
      map.set(fb.bot_user_id, {
        userId: fb.bot_user_id,
        name: fb.display_name || fb.username,
        username: fb.username,
        isBot: true,
        avatarShape: fb.avatar_shape,
        avatarColor: fb.avatar_color,
        companionChatId: fb.companion_chat_id,
        colorIndex: Math.abs(fb.bot_user_id) % 7,
      });
    }

    for (const b of bots) addBot(b);
    for (const c of contacts) addUser(c);
    for (const p of Object.values(peersById)) addUser(p);

    for (const ch of Object.values(chatsById)) {
      if (ch.isSavedMessages || ch.isGroup || ch.isSupergroup || ch.isChannel || ch.isSecret) {
        continue;
      }
      const uid = ch.peerUserId;
      if (!uid || uid === myUid || selectedIds.has(uid)) continue;
      const existing = map.get(uid);
      if (existing) {
        existing.companionChatId = existing.companionChatId ?? ch.chatId;
      } else {
        map.set(uid, {
          userId: uid,
          name: ch.title,
          username: ch.username,
          isBot: Boolean(ch.isBot || ch.kind === 'bot'),
          companionChatId: ch.chatId,
          colorIndex: ch.colorIndex,
        });
      }
    }

    for (const ru of remoteUsers) {
      if (ru.userId !== myUid && !selectedIds.has(ru.userId) && !map.has(ru.userId)) {
        map.set(ru.userId, ru);
      }
    }

    const q = searchQuery.trim().toLowerCase().replace(/^@/, '');
    const all = Array.from(map.values());
    if (!q) return all.slice(0, 40);
    return all
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.username && c.username.toLowerCase().includes(q)),
      )
      .slice(0, 40);
  }, [
    bots,
    chatsById,
    composeState.recipients,
    contacts,
    currentUser?.userId,
    fabushiBots,
    peersById,
    remoteUsers,
    searchQuery,
  ]);

  const handleSelectCandidate = (cand: CandidateItem): void => {
    const rec: ComposeRecipient = {
      userId: cand.userId,
      name: cand.name,
      username: cand.username,
      isBot: cand.isBot,
      avatarShape: cand.avatarShape,
      avatarColor: cand.avatarColor,
    };
    addComposeRecipient(rec);
    setSearchQuery('');
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  };

  const findExistingDirectChat = (recipient: ComposeRecipient): ChatSummary | undefined => {
    const fromFabushi = fabushiBots.find((b) => b.bot_user_id === recipient.userId);
    if (fromFabushi?.companion_chat_id && chatsById[fromFabushi.companion_chat_id]) {
      return chatsById[fromFabushi.companion_chat_id];
    }
    return Object.values(chatsById).find(
      (c) =>
        !c.isGroup &&
        !c.isSupergroup &&
        !c.isChannel &&
        !c.isSecret &&
        !c.isSavedMessages &&
        (c.peerUserId === recipient.userId ||
          (recipient.username &&
            c.username?.toLowerCase() === recipient.username.toLowerCase())),
    );
  };

  const handleCommitCompose = async (sendImmediately: boolean): Promise<void> => {
    const recipients = composeState.recipients;
    if (recipients.length === 0 || composeState.pendingCreation) return;

    const trimmedMsg = composeText.trim();
    setComposePending(true);
    try {
      // 1-Recipient DM Commit
      if (recipients.length === 1) {
        const target = recipients[0]!;
        let targetChatId: number;
        const existing = findExistingDirectChat(target);
        if (existing) {
          targetChatId = existing.chatId;
        } else {
          const adapter = getServerAdapter();
          const created = await adapter.createChat({
            chatType: target.isBot ? 4 : 0,
            title: target.name,
            peerUserId: target.userId,
            memberIds: [target.userId],
            memberUsernames: target.username ? [target.username] : undefined,
            clientNonce: crypto.randomUUID(),
          });
          await bootstrapChats();
          targetChatId = created.chatId;
        }

        closeAppleComposeStage();
        await selectChat(targetChatId);

        if (trimmedMsg) {
          if (sendImmediately) {
            await sendText(targetChatId, trimmedMsg);
          } else {
            await saveDraft(targetChatId, trimmedMsg);
          }
        }
        return;
      }

      // 2+ Recipients Multi-Select Auto-Titled Group Commit (server generates CJK `、` or Latin `, ` title <= 72 chars)
      const createdGroup = await createGroupOrChannel({
        kind: 'group',
        title: '',
        memberIds: recipients.map((r) => r.userId),
        memberUsernames: recipients
          .map((r) => r.username)
          .filter((u): u is string => Boolean(u)),
        clientNonce: crypto.randomUUID(),
      });

      closeAppleComposeStage();
      await selectChat(createdGroup.chatId);

      if (trimmedMsg) {
        if (sendImmediately) {
          await sendText(createdGroup.chatId, trimmedMsg);
        } else {
          await saveDraft(createdGroup.chatId, trimmedMsg);
        }
      }
    } catch (err) {
      setComposePending(false);
      pushToast(
        err instanceof Error ? err.message : isZh ? '创建对话失败' : 'Failed to start conversation',
        'error',
      );
    }
  };

  const recipientCount = composeState.recipients.length;
  const showIsolatedComposer = recipientCount > 0 && !composeState.pendingCreation;
  const singleRecipient = recipientCount === 1 ? composeState.recipients[0] : null;

  return (
    <div id={DOM_IDS.APPLE_COMPOSE_STAGE} className="tg-apple-compose-stage">
      {/* Header Bar */}
      <div className="tg-apple-compose-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          <strong style={{ fontSize: '15px', fontWeight: 700 }}>
            {isZh ? '新消息 · New Message' : 'New Message · 新消息'}
          </strong>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => {
                closeAppleComposeStage();
                openModal('create_group');
              }}
              className="tg-btn tg-btn--secondary"
              style={{ padding: '4px 10px', fontSize: '12px' }}
            >
              💬 {isZh ? '新建群组' : 'New Group'}
            </button>
            <button
              type="button"
              onClick={() => {
                closeAppleComposeStage();
                openModal('create_channel');
              }}
              className="tg-btn tg-btn--secondary"
              style={{ padding: '4px 10px', fontSize: '12px' }}
            >
              📢 {isZh ? '新建频道' : 'New Channel'}
            </button>
            <button
              type="button"
              onClick={() => {
                closeAppleComposeStage();
                openModal('create_bot');
              }}
              className="tg-btn tg-btn--secondary"
              style={{ padding: '4px 10px', fontSize: '12px' }}
            >
              🤖 {isZh ? '新建 Bot' : 'New Bot'}
            </button>
          </div>
        </div>

        <button
          id="apple-compose-close-btn"
          type="button"
          aria-label={isZh ? '关闭新建消息' : 'Close compose'}
          onClick={() => closeAppleComposeStage()}
          className="tg-icon-btn"
        >
          ✕
        </button>
      </div>

      {/* Recipient Token Bar (To:) */}
      <div className="tg-apple-compose-to-bar">
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--tg-text-secondary)' }}>
          {isZh ? '收件人:' : 'To:'}
        </span>

        {composeState.recipients.map((rec) => (
          <span
            key={rec.userId}
            data-testid="compose-recipient-chip"
            data-user-id={String(rec.userId)}
            className="tg-compose-chip"
          >
            <span>{rec.name}</span>
            <button
              type="button"
              aria-label={`Remove ${rec.name}`}
              onClick={() => removeComposeRecipient(rec.userId)}
              style={{
                fontSize: '12px',
                lineHeight: 1,
                color: 'inherit',
                padding: '0 2px',
              }}
            >
              ×
            </button>
          </span>
        ))}

        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && searchQuery.length === 0 && recipientCount > 0) {
              const last = composeState.recipients[recipientCount - 1];
              if (last) removeComposeRecipient(last.userId);
            } else if (e.key === 'Enter' && searchQuery.trim().length > 0 && candidates.length > 0) {
              e.preventDefault();
              handleSelectCandidate(candidates[0]!);
            }
          }}
          placeholder={
            isZh
              ? '搜索联系人、@用户名或智能体 Bot…'
              : 'Search contacts, @username, or bots…'
          }
          aria-label={isZh ? '搜索收件人' : 'Search recipients'}
          style={{
            flex: '1 1 180px',
            minWidth: '140px',
            border: 'none',
            background: 'transparent',
            color: 'var(--tg-text-primary)',
            fontSize: '13.5px',
            padding: '4px 2px',
          }}
        />

        {recipientCount === 1 && !composeState.pendingCreation && (
          <button
            id="apple-compose-open-dm-btn"
            type="button"
            onClick={() => void handleCommitCompose(false)}
            className="tg-btn tg-btn--primary"
            style={{ padding: '5px 12px', fontSize: '12.5px', flexShrink: 0 }}
          >
            {isZh ? '确认 · 打开对话' : 'Confirm · Open Chat'}
          </button>
        )}
      </div>

      {/* Candidate List or Creating Indicator */}
      <div className="tg-apple-compose-candidates">
        {composeState.pendingCreation ? (
          <div
            data-testid="compose-creating-state"
            style={{
              margin: 'auto',
              padding: '24px',
              textAlign: 'center',
              color: 'var(--tg-text-secondary)',
              fontSize: '14px',
            }}
          >
            {isZh ? '正在创建会话…' : 'Creating conversation…'}
          </div>
        ) : (
          <>
            {candidates.length === 0 ? (
              <div
                style={{
                  padding: '28px 16px',
                  textAlign: 'center',
                  color: 'var(--tg-text-secondary)',
                  fontSize: '13px',
                }}
              >
                {searchQuery.trim()
                  ? isZh
                    ? '未找到匹配的联系人或机器人'
                    : 'No matching contacts or bots found'
                  : isZh
                    ? '选择一位或多位联系人/机器人开始对话'
                    : 'Select one or more contacts or bots to start a conversation'}
              </div>
            ) : (
              candidates.map((cand) => (
                <button
                  key={cand.userId}
                  type="button"
                  data-testid="compose-candidate"
                  data-user-id={String(cand.userId)}
                  onClick={() => handleSelectCandidate(cand)}
                  className="tg-compose-candidate-row"
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                    {cand.isBot ? (
                      <GrokBotAvatar
                        sourceId={cand.username || String(cand.userId)}
                        shape={cand.avatarShape}
                        color={cand.avatarColor}
                        sizePx={36}
                        initials={getInitials(cand.name)}
                      />
                    ) : (
                      <span
                        className="tg-avatar tg-avatar--sm"
                        data-avatar="true"
                        data-color-index={String(cand.colorIndex)}
                        style={{ width: '36px', height: '36px', fontSize: '13px' }}
                      >
                        {getInitials(cand.name)}
                      </span>
                    )}
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <strong className="tg-truncate" style={{ fontSize: '13.5px' }}>
                        {cand.name}
                      </strong>
                      <span
                        className="tg-truncate"
                        style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}
                      >
                        {cand.username ? `@${cand.username}` : `ID #${cand.userId}`}
                        {cand.isBot ? ' · AI Bot' : ''}
                      </span>
                    </span>
                  </span>

                  <span
                    style={{
                      fontSize: '12px',
                      color: 'var(--tg-accent)',
                      fontWeight: 600,
                      flexShrink: 0,
                    }}
                  >
                    + {isZh ? '添加' : 'Add'}
                  </span>
                </button>
              ))
            )}
          </>
        )}
      </div>

      {/* Isolated Composer Capsule — STRICTLY SUPPRESSED when 0 recipients or pendingCreation (A10-T2-03) */}
      {showIsolatedComposer && (
        <div className="tg-composer-shell">
          <div className="tg-composer-row">
            <div id={DOM_IDS.CMP_INPUT_WRAP} className="tg-cmp-input-wrap">
              <textarea
                ref={composeTextareaRef}
                id={DOM_IDS.MESSAGE_COMPOSER_INPUT}
                rows={1}
                dir="auto"
                value={composeText}
                onChange={(e) => setComposeText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void handleCommitCompose(true);
                  }
                }}
                placeholder={
                  singleRecipient
                    ? isZh
                      ? `发消息给 ${singleRecipient.name}…`
                      : `Message ${singleRecipient.name}…`
                    : isZh
                      ? `发送首条消息并创建 ${recipientCount} 人群组…`
                      : `Send first message to create ${recipientCount}-member group…`
                }
                aria-label="Message input"
              />
              <button
                id={DOM_IDS.BTN_SEND_MESSAGE}
                type="button"
                aria-label={isZh ? '发送消息' : 'Send message'}
                onClick={() => void handleCommitCompose(true)}
                className="tg-send-pill-btn"
              >
                ↑
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
