import React, { useEffect, useMemo, useState } from 'react';
import {
  DOM_IDS,
  type ChatFolder,
  type ChatSummary,
} from '@gpui-telegram/protocol';
import { t } from '../../i18n';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';

export interface ChatFolderTabsProps {
  externalEditFolder?: ChatFolder | null;
  onClearExternalEdit?: () => void;
  className?: string;
}

export function chatMatchesFolder(
  chat: ChatSummary,
  folderId: string | number,
  customFolders: ChatFolder[],
): boolean {
  const key = String(folderId);

  if (key === 'all') {
    return !chat.isArchived;
  }
  if (key === 'personal') {
    return !chat.isArchived && !chat.isGroup && !chat.isSupergroup && !chat.isChannel && !chat.isBot;
  }
  if (key === 'work') {
    return !chat.isArchived && (chat.isGroup || chat.isSupergroup || chat.isChannel);
  }
  if (key === 'bots') {
    return !chat.isArchived && (chat.isBot || chat.kind === 'bot');
  }
  if (key === 'unread') {
    return !chat.isArchived && (chat.unreadCount > 0 || Boolean(chat.unreadMark));
  }

  const custom = customFolders.find(
    (f) => String(f.folderId) === key || String(f.id) === key,
  );
  if (!custom) {
    return !chat.isArchived;
  }

  if (custom.excludeArchived && chat.isArchived) {
    return false;
  }
  if (custom.excludedChatIds.includes(chat.chatId)) {
    return false;
  }
  if (custom.includedChatIds.includes(chat.chatId) || chat.folderId === custom.id) {
    return true;
  }
  if (custom.excludeMuted && chat.isMuted) {
    return false;
  }
  if (custom.excludeRead && chat.unreadCount === 0 && !chat.unreadMark) {
    return false;
  }

  if (custom.includeBots && (chat.isBot || chat.kind === 'bot')) {
    return true;
  }
  if (custom.includeChannels && chat.isChannel) {
    return true;
  }
  if (custom.includeGroups && (chat.isGroup || chat.isSupergroup)) {
    return true;
  }
  if (
    (custom.includeContacts || custom.includeNonContacts) &&
    !chat.isGroup &&
    !chat.isSupergroup &&
    !chat.isChannel &&
    !chat.isBot
  ) {
    return true;
  }

  return false;
}

const BUILTIN_FOLDER_TABS: Array<{ id: string; i18nKey: string }> = [
  { id: 'all', i18nKey: 'folder.all' },
  { id: 'personal', i18nKey: 'folder.personal' },
  { id: 'work', i18nKey: 'folder.work' },
  { id: 'bots', i18nKey: 'folder.bots' },
  { id: 'unread', i18nKey: 'folder.unread' },
];

export const ChatFolderTabs: React.FC<ChatFolderTabsProps> = ({
  externalEditFolder,
  onClearExternalEdit,
  className,
}) => {
  const language = useSettingsStore((s) => s.language);
  const chatsById = useChatStore((s) => s.chatsById);
  const orderedChatIds = useChatStore((s) => s.orderedChatIds);
  const folders = useChatStore((s) => s.folders);
  const activeFolderId = useChatStore((s) => s.activeFolderId);
  const setActiveFolder = useChatStore((s) => s.setActiveFolder);
  const upsertFolder = useChatStore((s) => s.upsertFolder);
  const deleteFolder = useChatStore((s) => s.deleteFolder);

  const [editorOpen, setEditorOpen] = useState<boolean>(false);
  const [editingFolder, setEditingFolder] = useState<ChatFolder | null>(null);
  const [folderTitle, setFolderTitle] = useState<string>('');
  const [includedIds, setIncludedIds] = useState<number[]>([]);
  const [saving, setSaving] = useState<boolean>(false);

  const [folderContextMenu, setFolderContextMenu] = useState<{
    folder: ChatFolder;
    x: number;
    y: number;
  } | null>(null);

  const nonArchivedChats = useMemo(
    () =>
      orderedChatIds
        .map((id) => chatsById[id])
        .filter((c): c is ChatSummary => Boolean(c && !c.isArchived)),
    [orderedChatIds, chatsById],
  );

  // Open editor if requested externally (e.g. from Empty Folder "Add Chats" button)
  useEffect(() => {
    if (externalEditFolder) {
      setEditingFolder(externalEditFolder);
      setFolderTitle(externalEditFolder.title);
      setIncludedIds([...externalEditFolder.includedChatIds]);
      setEditorOpen(true);
      onClearExternalEdit?.();
    }
  }, [externalEditFolder, onClearExternalEdit]);

  // Dismiss folder context menu on outside click or Escape
  useEffect(() => {
    if (!folderContextMenu || typeof window === 'undefined') return;
    const close = (): void => setFolderContextMenu(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFolderContextMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [folderContextMenu]);

  const openCreateDialog = (): void => {
    setEditingFolder(null);
    setFolderTitle('');
    setIncludedIds([]);
    setEditorOpen(true);
  };

  const openEditDialog = (folder: ChatFolder): void => {
    setEditingFolder(folder);
    setFolderTitle(folder.title);
    setIncludedIds([...folder.includedChatIds]);
    setEditorOpen(true);
  };

  const toggleIncludedChat = (chatId: number): void => {
    setIncludedIds((prev) =>
      prev.includes(chatId) ? prev.filter((id) => id !== chatId) : [...prev, chatId],
    );
  };

  const handleSaveFolder = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const cleanTitle = folderTitle.trim();
    if (!cleanTitle) return;

    setSaving(true);
    try {
      const saved = await upsertFolder({
        ...(editingFolder ?? {}),
        title: cleanTitle,
        includedChatIds: includedIds,
      });
      setActiveFolder(saved.folderId || saved.id);
      setEditorOpen(false);
      setEditingFolder(null);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteFolder = async (folder: ChatFolder): Promise<void> => {
    await deleteFolder(folder.id ?? folder.folderId);
    if (
      String(activeFolderId) === String(folder.folderId) ||
      String(activeFolderId) === String(folder.id)
    ) {
      setActiveFolder('all');
    }
    setEditorOpen(false);
    setEditingFolder(null);
    setFolderContextMenu(null);
  };

  const countUnreadForFolder = (fid: string | number): number => {
    let sum = 0;
    for (const chat of nonArchivedChats) {
      if (chatMatchesFolder(chat, fid, folders)) {
        sum += chat.unreadCount || (chat.unreadMark ? 1 : 0);
      }
    }
    return sum;
  };

  return (
    <>
      <div
        id={DOM_IDS.CHAT_FOLDER_TABS}
        role="tablist"
        aria-label={t('settings.chatFolders', language)}
        className={`tg-folder-tabs ${className ?? ''}`.trim()}
      >
        {BUILTIN_FOLDER_TABS.map((tab) => {
          const isActive = String(activeFolderId) === tab.id;
          const unread = countUnreadForFolder(tab.id);

          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-folder-id={tab.id}
              aria-selected={isActive}
              onClick={() => setActiveFolder(tab.id)}
              className={`tg-folder-tab ${isActive ? 'is-active' : ''}`.trim()}
            >
              <span>{t(tab.i18nKey, language)}</span>
              {unread > 0 && (
                <span
                  className="tg-badge tg-badge--muted"
                  style={{ height: '17px', minWidth: '17px', fontSize: '10.5px', padding: '0 5px' }}
                >
                  {unread}
                </span>
              )}
            </button>
          );
        })}

        {folders.map((folder) => {
          const folderKey = folder.folderId || String(folder.id);
          const isActive =
            String(activeFolderId) === String(folder.folderId) ||
            String(activeFolderId) === String(folder.id);
          const unread = countUnreadForFolder(folderKey);

          return (
            <button
              key={folderKey}
              type="button"
              role="tab"
              data-folder-id={folderKey}
              aria-selected={isActive}
              onClick={() => setActiveFolder(folderKey)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setFolderContextMenu({
                  folder,
                  x: Math.min(e.clientX, window.innerWidth - 200),
                  y: Math.min(e.clientY, window.innerHeight - 120),
                });
              }}
              className={`tg-folder-tab ${isActive ? 'is-active' : ''}`.trim()}
            >
              <span>{folder.emoticon ? `${folder.emoticon} ${folder.title}` : folder.title}</span>
              {unread > 0 && (
                <span
                  className="tg-badge tg-badge--muted"
                  style={{ height: '17px', minWidth: '17px', fontSize: '10.5px', padding: '0 5px' }}
                >
                  {unread}
                </span>
              )}
            </button>
          );
        })}

        {/* Inline + Create / Manage Folder Button */}
        <button
          type="button"
          data-testid="btn-create-folder"
          aria-label={t('folder.create', language)}
          title={t('folder.create', language)}
          onClick={openCreateDialog}
          className="tg-folder-tab"
          style={{ paddingLeft: '8px', paddingRight: '8px', fontWeight: 700 }}
        >
          +
        </button>
      </div>

      {/* Right-Click Context Menu on Custom Folder Tab */}
      {folderContextMenu && (
        <div
          role="menu"
          data-testid="context-menu"
          className="tg-context-menu"
          style={{ left: `${folderContextMenu.x}px`, top: `${folderContextMenu.y}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const target = folderContextMenu.folder;
              setFolderContextMenu(null);
              openEditDialog(target);
            }}
            className="tg-context-menu-item"
          >
            ✏️ {t('folder.edit', language)}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleDeleteFolder(folderContextMenu.folder)}
            className="tg-context-menu-item is-danger"
          >
            🗑️ {t('folder.delete', language)}
          </button>
        </div>
      )}

      {/* Create / Edit Custom Folder Modal Dialog */}
      {editorOpen && (
        <div
          className="tg-modal-overlay"
          onClick={() => setEditorOpen(false)}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-label={editingFolder ? t('folder.edit', language) : t('folder.create', language)}
            data-testid="folder-editor-dialog"
            className="tg-modal-card"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => void handleSaveFolder(e)}
          >
            <div className="tg-modal-header">
              <span>
                {editingFolder ? t('folder.edit', language) : t('folder.create', language)}
              </span>
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
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
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12.5px' }}>
                <span style={{ fontWeight: 600 }}>
                  {language === 'zh-CN' ? '分组名称' : 'Folder Name'}
                </span>
                <input
                  type="text"
                  autoFocus
                  value={folderTitle}
                  onChange={(e) => setFolderTitle(e.target.value)}
                  placeholder={language === 'zh-CN' ? '例如：核心项目' : 'e.g. VIP Projects'}
                  aria-label="Folder name"
                  className="tg-input"
                />
              </label>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '12.5px', fontWeight: 600 }}>
                  {language === 'zh-CN' ? '包含的会话 (Add Chats)' : 'Included Chats (Add Chats)'}
                </span>

                <div
                  style={{
                    maxHeight: '220px',
                    overflowY: 'auto',
                    border: '1px solid var(--tg-border)',
                    borderRadius: 'var(--tg-radius-sm)',
                    padding: '4px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px',
                  }}
                >
                  {nonArchivedChats.map((chat) => {
                    const checked = includedIds.includes(chat.chatId);
                    const displayTitle = chat.isSavedMessages
                      ? t('chat.savedMessages', language)
                      : chat.title;
                    return (
                      <label
                        key={chat.chatId}
                        data-chat-id={String(chat.chatId)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          padding: '6px 8px',
                          borderRadius: 'var(--tg-radius-sm)',
                          cursor: 'pointer',
                          backgroundColor: checked ? 'var(--tg-accent-soft)' : 'transparent',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleIncludedChat(chat.chatId)}
                        />
                        <span style={{ fontSize: '13px', fontWeight: 500 }}>{displayTitle}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="tg-modal-footer" style={{ justifyContent: 'space-between' }}>
              <div>
                {editingFolder && (
                  <button
                    type="button"
                    onClick={() => void handleDeleteFolder(editingFolder)}
                    className="tg-btn tg-btn--danger-soft"
                  >
                    {t('folder.delete', language)}
                  </button>
                )}
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => setEditorOpen(false)}
                  className="tg-btn tg-btn--secondary"
                >
                  {t('common.cancel', language)}
                </button>
                <button
                  type="submit"
                  disabled={saving || !folderTitle.trim()}
                  className="tg-btn tg-btn--primary"
                >
                  {t('common.save', language)}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </>
  );
};
