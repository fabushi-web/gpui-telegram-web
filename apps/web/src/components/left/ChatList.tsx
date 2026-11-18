import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  DATA_TEST_IDS,
  DOM_IDS,
  type ChatFolder,
  type ChatSummary,
  type ForumTopic,
} from '@gpui-telegram/protocol';
import { formatChatTimestamp, t } from '../../i18n';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';
import { chatMatchesFolder } from './ChatFolderTabs';

export interface ChatListProps {
  isCollapsed?: boolean;
  onEditCustomFolder?: (folder: ChatFolder) => void;
  className?: string;
}

function getChatInitials(title: string): string {
  const trimmed = (title ?? '').trim();
  if (!trimmed) return 'C';
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

function getMediaPrefixIcon(mediaType?: string): string {
  if (!mediaType) return '';
  const m = mediaType.toLowerCase();
  if (m === 'photo' || m === 'image') return '📷 ';
  if (m === 'video') return '🎬 ';
  if (m === 'voice') return '🎤 ';
  if (m === 'video_note') return '⏺ ';
  if (m === 'audio' || m === 'music') return '🎵 ';
  if (m === 'document' || m === 'file') return '📎 ';
  if (m === 'sticker') return '😊 ';
  if (m === 'gif') return '🎞️ ';
  if (m === 'poll') return '📊 ';
  if (m === 'todo') return '☑️ ';
  if (m === 'invoice') return '⭐ ';
  return '';
}

export const ChatList: React.FC<ChatListProps> = ({
  isCollapsed = false,
  onEditCustomFolder,
  className,
}) => {
  const language = useSettingsStore((s) => s.language);
  const chatsById = useChatStore((s) => s.chatsById);
  const orderedChatIds = useChatStore((s) => s.orderedChatIds);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const activeTopicId = useChatStore((s) => s.activeTopicId);
  const activeFolderId = useChatStore((s) => s.activeFolderId);
  const showArchived = useChatStore((s) => s.showArchived);
  const folders = useChatStore((s) => s.folders);
  const topicsByChat = useChatStore((s) => s.topicsByChat);
  const draftsByChat = useChatStore((s) => s.draftsByChat);
  const peersById = useChatStore((s) => s.peersById);
  const typingByChat = useChatStore((s) => s.typingByChat);

  const selectChat = useChatStore((s) => s.selectChat);
  const setShowArchived = useChatStore((s) => s.setShowArchived);
  const markChatRead = useChatStore((s) => s.markChatRead);
  const updateChatSettings = useChatStore((s) => s.updateChatSettings);
  const deleteOrLeaveChat = useChatStore((s) => s.deleteOrLeaveChat);
  const createTopic = useChatStore((s) => s.createTopic);
  const upsertFolder = useChatStore((s) => s.upsertFolder);

  const setMobilePane = useUiStore((s) => s.setMobilePane);
  const setTabletLeftDrawerOpen = useUiStore((s) => s.setTabletLeftDrawerOpen);
  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);

  const parentRef = useRef<HTMLDivElement | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    chat: ChatSummary;
    x: number;
    y: number;
  } | null>(null);

  const [topicModalOpen, setTopicModalOpen] = useState<boolean>(false);
  const [newTopicTitle, setNewTopicTitle] = useState<string>('');
  const [newTopicEmoji, setNewTopicEmoji] = useState<string>('💬');
  const [creatingTopic, setCreatingTopic] = useState<boolean>(false);

  // Dismiss chat row context menu on outside click or Escape
  useEffect(() => {
    if (!contextMenu || typeof window === 'undefined') return;
    const close = (): void => setContextMenu(null);
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  const archivedChats = useMemo(
    () =>
      orderedChatIds
        .map((id) => chatsById[id])
        .filter((c): c is ChatSummary => Boolean(c && c.isArchived)),
    [orderedChatIds, chatsById],
  );

  const activeCustomFolder = useMemo(
    () =>
      folders.find(
        (f) =>
          String(f.folderId) === String(activeFolderId) ||
          String(f.id) === String(activeFolderId),
      ) ?? null,
    [folders, activeFolderId],
  );

  const visibleChats = useMemo<ChatSummary[]>(() => {
    const allOrdered = orderedChatIds
      .map((id) => chatsById[id])
      .filter((c): c is ChatSummary => Boolean(c));

    if (showArchived) {
      return allOrdered.filter((c) => c.isArchived);
    }

    const filtered = allOrdered.filter((c) =>
      chatMatchesFolder(c, activeFolderId, folders),
    );

    // Ensure pinned chats always appear strictly above unpinned chats
    return filtered.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return (b.lastMessageDateMs ?? 0) - (a.lastMessageDateMs ?? 0);
    });
  }, [orderedChatIds, chatsById, showArchived, activeFolderId, folders]);

  const virtualizer = useVirtualizer({
    count: visibleChats.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 12,
  });

  const virtualItems = virtualizer.getVirtualItems();

  const activeChat = activeChatId !== null ? chatsById[activeChatId] : undefined;
  const activeForumTopics: ForumTopic[] =
    activeChat?.isForum && activeChatId !== null
      ? topicsByChat[activeChatId] ?? []
      : [];

  const handleSelectRow = (chat: ChatSummary): void => {
    setActiveNavDest('chats');
    void selectChat(chat.chatId);
    setMobilePane('middle');
    setTabletLeftDrawerOpen(false);
  };

  const handleCreateTopicSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!activeChat || !newTopicTitle.trim()) return;
    setCreatingTopic(true);
    try {
      const created = await createTopic(
        activeChat.chatId,
        newTopicTitle.trim(),
        newTopicEmoji || '💬',
      );
      await selectChat(activeChat.chatId, created.topicId);
      setNewTopicTitle('');
      setTopicModalOpen(false);
    } finally {
      setCreatingTopic(false);
    }
  };

  const renderChatRowContent = (chat: ChatSummary): React.ReactNode => {
    const isActive = activeChatId === chat.chatId;
    const displayTitle = chat.isSavedMessages
      ? t('chat.savedMessages', language)
      : chat.title;

    const peerUser = chat.peerUserId !== undefined ? peersById[chat.peerUserId] : undefined;
    const isOnline =
      !chat.isSavedMessages &&
      !chat.isGroup &&
      !chat.isChannel &&
      peerUser?.status === 'online';

    const typingUsers = typingByChat[chat.chatId] ?? [];
    const isTyping = typingUsers.length > 0;
    const draftText = (draftsByChat[chat.chatId]?.text ?? chat.draft?.text ?? '').trim();
    const hasUnread = chat.unreadCount > 0 || Boolean(chat.unreadMark);
    const unreadDisplayCount = chat.unreadCount > 0 ? chat.unreadCount : 1;

    if (isCollapsed) {
      return (
        <div
          role="option"
          aria-selected={isActive}
          data-testid={DATA_TEST_IDS.CHAT_ROW}
          data-chat-id={String(chat.chatId)}
          data-active={String(isActive)}
          title={displayTitle}
          onClick={() => handleSelectRow(chat)}
          className={`tg-chat-row ${isActive ? 'is-active' : ''}`.trim()}
          style={{ justifyContent: 'center', padding: '6px 4px', position: 'relative' }}
        >
          <div
            className="tg-avatar"
            data-avatar="true"
            data-color-index={String(chat.colorIndex)}
            style={{ width: '42px', height: '42px' }}
          >
            {chat.isSavedMessages ? '🔖' : getChatInitials(displayTitle)}
            {isOnline && <span className="tg-online-dot" />}
          </div>
          {hasUnread && (
            <span
              className={`tg-badge ${chat.isMuted ? 'tg-badge--muted' : ''}`.trim()}
              data-unread="true"
              data-unread-count={String(unreadDisplayCount)}
              style={{
                position: 'absolute',
                top: '4px',
                right: '4px',
                minWidth: '17px',
                height: '17px',
                fontSize: '10px',
                padding: '0 4px',
              }}
            >
              {unreadDisplayCount > 99 ? '99+' : unreadDisplayCount}
            </span>
          )}
        </div>
      );
    }

    return (
      <div
        role="treeitem"
        aria-selected={isActive}
        data-testid={DATA_TEST_IDS.CHAT_ROW}
        data-chat-id={String(chat.chatId)}
        data-active={String(isActive)}
        data-pinned={chat.isPinned ? 'true' : undefined}
        data-muted={chat.isMuted ? 'true' : undefined}
        onClick={() => handleSelectRow(chat)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setContextMenu({
            chat,
            x: Math.min(e.clientX, window.innerWidth - 230),
            y: Math.min(e.clientY, window.innerHeight - 260),
          });
        }}
        className={`tg-chat-row ${isActive ? 'is-active' : ''}`.trim()}
        style={{ height: '60px' }}
      >
        <div
          className="tg-avatar"
          data-avatar="true"
          data-color-index={String(chat.colorIndex)}
        >
          {chat.isSavedMessages ? '🔖' : getChatInitials(displayTitle)}
          {isOnline && <span className="tg-online-dot" />}
        </div>

        <div className="tg-chat-row-body">
          <div className="tg-chat-row-top">
            <span
              className="tg-chat-row-title"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              {chat.isSecret && (
                <span title={t('secret.badge', language)} aria-label="Secret Chat">
                  🔒
                </span>
              )}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {displayTitle}
              </span>
              {chat.isVerified && (
                <span
                  aria-label="Verified"
                  style={{
                    color: isActive ? '#FFFFFF' : 'var(--tg-accent)',
                    fontSize: '12px',
                    flexShrink: 0,
                  }}
                >
                  ✓
                </span>
              )}
              {chat.isMuted && (
                <span
                  data-muted="true"
                  aria-label="Muted"
                  style={{ fontSize: '11px', opacity: 0.72, flexShrink: 0 }}
                >
                  🔕
                </span>
              )}
            </span>

            <span
              className="tg-chat-row-time"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}
            >
              {chat.lastMessageStatus && (
                <span data-testid="chat-status-check" style={{ fontSize: '11px' }}>
                  {chat.lastMessageStatus === 'sending'
                    ? '🕒'
                    : chat.lastMessageStatus === 'read'
                      ? '✓✓'
                      : '✓'}
                </span>
              )}
              <span>{formatChatTimestamp(chat.lastMessageDateMs, language)}</span>
            </span>
          </div>

          <div className="tg-chat-row-bottom">
            <span className="tg-chat-row-subtitle">
              {isTyping ? (
                <span
                  data-typing="true"
                  style={{
                    color: isActive ? '#FFFFFF' : 'var(--tg-accent)',
                    fontWeight: 500,
                  }}
                >
                  {t('chat.typing', language)}
                </span>
              ) : draftText ? (
                <>
                  <span aria-hidden="true">{'\u200B'}</span>
                  <span
                    data-testid="draft-badge"
                    style={{
                      color: isActive ? '#FFD4D4' : 'var(--tg-danger)',
                      fontWeight: 600,
                    }}
                  >
                    {t('chat.draft', language)}:{' '}
                  </span>
                  <span>{draftText}</span>
                </>
              ) : (
                <>
                  {chat.lastMessageSenderName && (chat.isGroup || chat.isSupergroup) ? (
                    <span
                      style={{
                        color: isActive ? '#FFFFFF' : 'var(--tg-text-primary)',
                        fontWeight: 500,
                      }}
                    >
                      {chat.lastMessageSenderName}:{' '}
                    </span>
                  ) : null}
                  <span>
                    {getMediaPrefixIcon(chat.lastMessageMediaType)}
                    {chat.lastMessagePreview || ''}
                  </span>
                </>
              )}
            </span>

            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', flexShrink: 0 }}>
              {chat.isPinned && (
                <span
                  data-pinned="true"
                  aria-label="Pinned"
                  style={{ fontSize: '11.5px', opacity: 0.78 }}
                >
                  📌
                </span>
              )}
              {hasUnread && (
                <span
                  className={`tg-badge ${chat.isMuted ? 'tg-badge--muted' : ''}`.trim()}
                  data-unread="true"
                  data-unread-count={String(unreadDisplayCount)}
                >
                  {unreadDisplayCount > 999 ? '999+' : unreadDisplayCount}
                </span>
              )}
            </span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      {/* New Forum Topic Creator Dialog (placed before #forum-topic-list in DOM order) */}
      {topicModalOpen && activeChat && (
        <div
          className="tg-modal-overlay"
          onClick={() => setTopicModalOpen(false)}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-label={t('topics.create', language)}
            data-testid="create-topic-dialog"
            className="tg-modal-card"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => void handleCreateTopicSubmit(e)}
          >
            <div className="tg-modal-header">
              <span>{t('topics.create', language)}</span>
              <button
                type="button"
                onClick={() => setTopicModalOpen(false)}
                aria-label={t('common.close', language)}
                className="tg-icon-btn"
              >
                ✕
              </button>
            </div>

            <div
              className="tg-modal-body"
              style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
            >
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="text"
                  value={newTopicEmoji}
                  onChange={(e) => setNewTopicEmoji(e.target.value)}
                  aria-label="Icon emoji"
                  className="tg-input"
                  style={{ width: '54px', textAlign: 'center', fontSize: '18px' }}
                />
                <input
                  type="text"
                  autoFocus
                  value={newTopicTitle}
                  onChange={(e) => setNewTopicTitle(e.target.value)}
                  placeholder={language === 'zh-CN' ? '输入新话题标题…' : 'Enter topic title…'}
                  aria-label="Topic title"
                  className="tg-input"
                />
              </div>
            </div>

            <div className="tg-modal-footer">
              <button
                type="button"
                onClick={() => setTopicModalOpen(false)}
                className="tg-btn tg-btn--secondary"
              >
                {t('common.cancel', language)}
              </button>
              <button
                type="submit"
                disabled={creatingTopic || !newTopicTitle.trim()}
                className="tg-btn tg-btn--primary"
              >
                {t('common.create', language)}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Forum Topic List (#forum-topic-list) when active chat is a Forum Supergroup */}
      {!isCollapsed && activeChat?.isForum && (
        <div
          id={DOM_IDS.FORUM_TOPIC_LIST}
          role="region"
          aria-label={t('topics.title', language)}
          style={{
            borderBottom: '1px solid var(--tg-border)',
            backgroundColor: 'var(--tg-bg-elevated)',
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            maxHeight: '210px',
            overflowY: 'auto',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <strong style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
              # {activeChat.title} · {t('topics.title', language)}
            </strong>
            <button
              type="button"
              data-testid="btn-create-topic"
              onClick={() => setTopicModalOpen(true)}
              className="tg-btn tg-btn--ghost"
              style={{ padding: '2px 8px', fontSize: '12px', fontWeight: 600 }}
            >
              + {t('topics.create', language)}
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {/* Real Forum Topics rendered FIRST so first [data-topic-id] is Topic #1 (General) */}
            {activeForumTopics.map((topic) => {
              const selected = activeTopicId === topic.topicId;
              return (
                <button
                  key={topic.topicId}
                  type="button"
                  data-topic-id={String(topic.topicId)}
                  aria-selected={selected}
                  onClick={() => {
                    void selectChat(activeChat.chatId, topic.topicId);
                    setMobilePane('middle');
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    padding: '6px 8px',
                    borderRadius: 'var(--tg-radius-sm)',
                    backgroundColor: selected ? 'var(--tg-accent-soft)' : 'transparent',
                    color: selected ? 'var(--tg-accent)' : 'var(--tg-text-primary)',
                    fontSize: '12.5px',
                    fontWeight: selected ? 600 : 500,
                    textAlign: 'left',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {topic.iconEmoji || '💬'} {topic.title}
                  </span>
                  {topic.unreadCount > 0 && (
                    <span className="tg-badge" style={{ height: '16px', fontSize: '10px' }}>
                      {topic.unreadCount}
                    </span>
                  )}
                </button>
              );
            })}

            {/* All Topics Stream Option */}
            <button
              type="button"
              data-topic-id="all"
              aria-selected={activeTopicId === null}
              onClick={() => {
                void selectChat(activeChat.chatId, null);
                setMobilePane('middle');
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '5px 8px',
                borderRadius: 'var(--tg-radius-sm)',
                backgroundColor: activeTopicId === null ? 'var(--tg-accent-soft)' : 'transparent',
                color: activeTopicId === null ? 'var(--tg-accent)' : 'var(--tg-text-secondary)',
                fontSize: '12px',
                fontWeight: activeTopicId === null ? 600 : 500,
                textAlign: 'left',
              }}
            >
              <span>📋 {language === 'zh-CN' ? '全部话题消息' : 'All Topics'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Virtualized Chat List Container (#chat-list) */}
      <div
        id={DOM_IDS.CHAT_LIST}
        ref={parentRef}
        role="tree"
        aria-label="Chats"
        className={`tg-chat-list ${className ?? ''}`.trim()}
      >
        {/* Archived Chats Entry / Back Row (#archived-chats-row) */}
        {!isCollapsed && showArchived && (
          <button
            id={DOM_IDS.ARCHIVED_CHATS_ROW}
            type="button"
            onClick={() => setShowArchived(false)}
            className="tg-chat-row"
            style={{
              width: '100%',
              marginBottom: '4px',
              backgroundColor: 'var(--tg-bg-elevated)',
              border: '1px solid var(--tg-border-subtle)',
            }}
          >
            <span className="tg-avatar tg-avatar--sm" data-color-index="5">
              ←
            </span>
            <span className="tg-chat-row-body" style={{ textAlign: 'left' }}>
              <span className="tg-chat-row-title">
                {language === 'zh-CN' ? '返回全部会话' : 'Back to All Chats'}
              </span>
              <span className="tg-chat-row-subtitle">
                {t('menu.archivedChats', language)} ({archivedChats.length})
              </span>
            </span>
          </button>
        )}

        {!isCollapsed &&
          !showArchived &&
          archivedChats.length > 0 &&
          String(activeFolderId) === 'all' && (
            <button
              id={DOM_IDS.ARCHIVED_CHATS_ROW}
              type="button"
              onClick={() => setShowArchived(true)}
              className="tg-chat-row"
              style={{
                width: '100%',
                marginBottom: '4px',
                backgroundColor: 'var(--tg-bg-elevated)',
              }}
            >
              <span className="tg-avatar" data-color-index="5">
                📥
              </span>
              <span className="tg-chat-row-body" style={{ textAlign: 'left' }}>
                <span className="tg-chat-row-top">
                  <span className="tg-chat-row-title">
                    {t('menu.archivedChats', language)}
                  </span>
                  <span className="tg-badge tg-badge--muted">{archivedChats.length}</span>
                </span>
                <span className="tg-chat-row-subtitle">
                  {archivedChats.map((c) => c.title).join(', ')}
                </span>
              </span>
            </button>
          )}

        {/* Empty State for Custom Folder with 0 Chats */}
        {!isCollapsed && !showArchived && activeCustomFolder && visibleChats.length === 0 ? (
          <div
            data-testid="empty-folder-state"
            style={{
              padding: '36px 16px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
              gap: '10px',
              color: 'var(--tg-text-secondary)',
            }}
          >
            <span style={{ fontSize: '30px' }} aria-hidden="true">
              📂
            </span>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--tg-text-primary)' }}>
              {language === 'zh-CN' ? '当前分组暂无会话' : 'No chats in this folder'}
            </div>
            <button
              type="button"
              onClick={() => onEditCustomFolder?.(activeCustomFolder)}
              className="tg-btn tg-btn--primary"
            >
              + {language === 'zh-CN' ? '添加会话' : 'Add Chats'}
            </button>
          </div>
        ) : virtualItems.length > 0 ? (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualItems.map((virtualRow) => {
              const chat = visibleChats[virtualRow.index];
              if (!chat) return null;
              return (
                <div
                  key={chat.chatId}
                  data-index={virtualRow.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {renderChatRowContent(chat)}
                </div>
              );
            })}
          </div>
        ) : (
          /* Immediate first-paint fallback before ResizeObserver measures container height */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {visibleChats.slice(0, 30).map((chat) => (
              <div key={chat.chatId}>{renderChatRowContent(chat)}</div>
            ))}
          </div>
        )}
      </div>

      {/* Right-Click Chat Row Context Menu */}
      {contextMenu && (
        <div
          id="chat-context-menu"
          role="menu"
          data-testid="context-menu"
          className="tg-context-menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Pin / Unpin */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const target = contextMenu.chat;
              setContextMenu(null);
              void updateChatSettings(target.chatId, { isPinned: !target.isPinned });
            }}
            className="tg-context-menu-item"
          >
            <span>📌</span>
            <span>
              {t(contextMenu.chat.isPinned ? 'chatAction.unpin' : 'chatAction.pin', language)}
            </span>
          </button>

          {/* Mute / Unmute */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const target = contextMenu.chat;
              setContextMenu(null);
              void updateChatSettings(target.chatId, { isMuted: !target.isMuted });
            }}
            className="tg-context-menu-item"
          >
            <span>{contextMenu.chat.isMuted ? '🔔' : '🔕'}</span>
            <span>
              {t(contextMenu.chat.isMuted ? 'chatAction.unmute' : 'chatAction.mute', language)}
            </span>
          </button>

          {/* Mark as Read / Mark as Unread */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const target = contextMenu.chat;
              const isCurrentlyUnread = target.unreadCount > 0 || Boolean(target.unreadMark);
              setContextMenu(null);
              if (isCurrentlyUnread) {
                void markChatRead(target.chatId, target.lastMessageId);
                if (target.unreadMark) {
                  void updateChatSettings(target.chatId, { unreadMark: false });
                }
              } else {
                void updateChatSettings(target.chatId, { unreadMark: true });
              }
            }}
            className="tg-context-menu-item"
          >
            <span>✉️</span>
            <span>
              {t(
                contextMenu.chat.unreadCount > 0 || contextMenu.chat.unreadMark
                  ? 'chatAction.markRead'
                  : 'chatAction.markUnread',
                language,
              )}
            </span>
          </button>

          {/* Archive / Unarchive */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const target = contextMenu.chat;
              setContextMenu(null);
              void updateChatSettings(target.chatId, { isArchived: !target.isArchived });
            }}
            className="tg-context-menu-item"
          >
            <span>📥</span>
            <span>
              {t(
                contextMenu.chat.isArchived ? 'chatAction.unarchive' : 'chatAction.archive',
                language,
              )}
            </span>
          </button>

          {/* Folder Quick Toggle */}
          {folders.map((folder) => {
            const target = contextMenu.chat;
            const inFolder = folder.includedChatIds.includes(target.chatId);
            return (
              <button
                key={folder.folderId}
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  const nextIds = inFolder
                    ? folder.includedChatIds.filter((id) => id !== target.chatId)
                    : [...folder.includedChatIds, target.chatId];
                  void upsertFolder({
                    ...folder,
                    includedChatIds: nextIds,
                  });
                }}
                className="tg-context-menu-item"
              >
                <span>📁</span>
                <span>
                  {inFolder
                    ? `${language === 'zh-CN' ? '移出分组' : 'Remove from'} ${folder.title}`
                    : `${language === 'zh-CN' ? '加入分组' : 'Add to'} ${folder.title}`}
                </span>
              </button>
            );
          })}

          {!contextMenu.chat.isSavedMessages && (
            <>
              <div
                style={{
                  height: '1px',
                  backgroundColor: 'var(--tg-border-subtle)',
                  margin: '4px 6px',
                }}
              />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const target = contextMenu.chat;
                  setContextMenu(null);
                  void deleteOrLeaveChat(target.chatId);
                }}
                className="tg-context-menu-item is-danger"
              >
                <span>🗑️</span>
                <span>
                  {t(
                    contextMenu.chat.isGroup || contextMenu.chat.isChannel
                      ? 'chatAction.leaveChat'
                      : 'chatAction.deleteChat',
                    language,
                  )}
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
};
