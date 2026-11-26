import React, { useEffect, useRef, useState } from 'react';
import { DOM_IDS, type ChatFolder } from '@gpui-telegram/protocol';
import { t } from '../../i18n';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';
import { BurgerMenuDrawer } from './BurgerMenuDrawer';
import { ChatFolderTabs } from './ChatFolderTabs';
import { ChatList } from './ChatList';
import { GlobalSearchPanel } from './GlobalSearchPanel';
import { StoriesBar, StoriesViewerModal } from './StoriesBar';

export interface LeftColumnProps {
  className?: string;
}

export const LeftColumn: React.FC<LeftColumnProps> = ({ className }) => {
  const language = useSettingsStore((s) => s.language);

  const isLeftCollapsed = useUiStore((s) => s.isLeftCollapsed);
  const tabletLeftDrawerOpen = useUiStore((s) => s.tabletLeftDrawerOpen);
  const isBurgerOpen = useUiStore((s) => s.isBurgerOpen);
  const setLeftSidebarWidth = useUiStore((s) => s.setLeftSidebarWidth);
  const toggleLeftCollapsed = useUiStore((s) => s.toggleLeftCollapsed);
  const setBurgerOpen = useUiStore((s) => s.setBurgerOpen);
  const openModal = useUiStore((s) => s.openModal);
  const openAppleComposeStage = useUiStore((s) => s.openAppleComposeStage);

  const showArchived = useChatStore((s) => s.showArchived);
  const globalSearchQuery = useChatStore((s) => s.globalSearchQuery);
  const searchGlobal = useChatStore((s) => s.searchGlobal);

  const [searchInput, setSearchInput] = useState<string>(globalSearchQuery);
  const [searchFocused, setSearchFocused] = useState<boolean>(false);
  const [isDraggingResizer, setIsDraggingResizer] = useState<boolean>(false);
  const [externalEditFolder, setExternalEditFolder] = useState<ChatFolder | null>(null);

  const columnRef = useRef<HTMLElement | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSearchInput(globalSearchQuery);
  }, [globalSearchQuery]);

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = null;
      }
    };
  }, []);

  const handleSearchChange = (val: string): void => {
    setSearchInput(val);
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    if (!val.trim()) {
      void searchGlobal('');
      return;
    }
    searchDebounceRef.current = setTimeout(() => {
      searchDebounceRef.current = null;
      void searchGlobal(val);
    }, 120);
  };

  const handleClearSearch = (): void => {
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    setSearchInput('');
    setSearchFocused(false);
    void searchGlobal('');
  };

  const handleOpenComposeStage = (): void => {
    const chatState = useChatStore.getState();
    const bgChatId = chatState.activeChatId;
    if (bgChatId !== null) {
      const existingDraft = chatState.draftsByChat[bgChatId]?.text;
      if (existingDraft !== undefined) {
        void chatState.saveDraft(bgChatId, existingDraft).catch(() => undefined);
      }
      useUiStore.getState().clearToastsForChat(bgChatId);
    }
    openAppleComposeStage();
  };

  const handleResizerPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setIsDraggingResizer(true);
    const startLeft = columnRef.current?.getBoundingClientRect().left ?? 64;

    const onMove = (moveEv: PointerEvent): void => {
      const nextWidth = moveEv.clientX - startLeft;
      setLeftSidebarWidth(nextWidth);
    };

    const onUp = (): void => {
      setIsDraggingResizer(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleOpenShortcuts = (): void => {
    openModal('shortcuts');
  };

  const isSearchActive = !isLeftCollapsed && (searchFocused || searchInput.trim().length > 0);

  return (
    <>
      <aside
        id={DOM_IDS.LEFT_COLUMN}
        ref={columnRef}
        data-collapsed={String(isLeftCollapsed)}
        data-drawer-open={String(tabletLeftDrawerOpen)}
        className={`tg-left-column ${isLeftCollapsed ? 'is-collapsed' : ''} ${className ?? ''}`.trim()}
      >
        {/* Top Header: Burger Button + Apple Pill Search + Compact '+' Compose Trigger */}
        <div
          className="tg-left-header"
          style={{
            justifyContent: isLeftCollapsed ? 'center' : 'space-between',
            padding: isLeftCollapsed ? '8px 6px' : undefined,
          }}
        >
          <button
            id={DOM_IDS.BTN_MAIN_MENU}
            type="button"
            aria-label="Open Main Menu"
            aria-expanded={isBurgerOpen}
            onClick={() => setBurgerOpen(!isBurgerOpen)}
            className="tg-icon-btn"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>

          {!isLeftCollapsed && (
            <>
              <div className="tg-search-pill">
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  style={{ color: 'var(--tg-text-secondary)', flexShrink: 0 }}
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20 20l-3.5-3.5" />
                </svg>

                <input
                  id={DOM_IDS.GLOBAL_SEARCH_INPUT}
                  type="search"
                  value={searchInput}
                  onFocus={() => setSearchFocused(true)}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      handleClearSearch();
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                  placeholder={t('search.globalPlaceholder', language)}
                  aria-label={t('search.globalPlaceholder', language)}
                />

                {isSearchActive && (
                  <button
                    type="button"
                    onClick={handleClearSearch}
                    aria-label={t('common.close', language)}
                    className="tg-icon-btn"
                    style={{ width: '24px', height: '24px', fontSize: '12px' }}
                  >
                    ✕
                  </button>
                )}
              </div>

              <button
                id="sidebar-plus-action-btn"
                type="button"
                aria-label={language === 'zh-CN' ? '新建对话' : 'New Message'}
                title={`${language === 'zh-CN' ? '新建对话' : 'New Message'} (Ctrl+N)`}
                onClick={handleOpenComposeStage}
                className="tg-icon-btn"
                style={{ width: '30px', height: '30px', fontSize: '17px', fontWeight: 600 }}
              >
                +
              </button>
            </>
          )}
        </div>

        {/* Collapsed 64px Expand Pill + Compact Chat Avatars */}
        {isLeftCollapsed ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0' }}>
              <button
                type="button"
                onClick={() => toggleLeftCollapsed(false)}
                aria-label={t('nav.expandSidebar', language)}
                title={t('nav.expandSidebar', language)}
                className="tg-icon-btn"
              >
                »
              </button>
            </div>
            <ChatList isCollapsed />
          </>
        ) : isSearchActive ? (
          <GlobalSearchPanel query={searchInput} onCloseSearch={handleClearSearch} />
        ) : (
          <>
            <StoriesBar />
            {!showArchived && (
              <ChatFolderTabs
                externalEditFolder={externalEditFolder}
                onClearExternalEdit={() => setExternalEditFolder(null)}
              />
            )}
            <ChatList
              isCollapsed={false}
              onEditCustomFolder={(folder) => setExternalEditFolder(folder)}
            />
          </>
        )}

        {/* Compose Floating Action Button (#btn-new-chat-fab -> opens inline #apple-compose-stage) */}
        {!isLeftCollapsed && !isSearchActive && (
          <button
            id={DOM_IDS.BTN_NEW_CHAT_FAB}
            type="button"
            aria-label={language === 'zh-CN' ? '新建消息' : 'New Message'}
            title={`${language === 'zh-CN' ? '新建消息' : 'New Message'} (Ctrl+N)`}
            onClick={handleOpenComposeStage}
            style={{ fontSize: '19px', fontWeight: 600 }}
          >
            ✎
          </button>
        )}

        {/* Draggable Width Splitter ([260px..424px]) */}
        {!isLeftCollapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize left sidebar"
            onPointerDown={handleResizerPointerDown}
            className={`tg-sidebar-resizer ${isDraggingResizer ? 'is-dragging' : ''}`.trim()}
          />
        )}
      </aside>

      {/* Slide-Over Burger Menu & Fullscreen Stories Viewer */}
      <BurgerMenuDrawer onOpenShortcuts={handleOpenShortcuts} />
      <StoriesViewerModal />
    </>
  );
};
