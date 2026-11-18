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

const KEYBOARD_SHORTCUT_LIST: Array<{ keys: string; en: string; zh: string }> = [
  { keys: 'Ctrl + K / /', en: 'Global Search', zh: '全局搜索' },
  { keys: 'Ctrl + B', en: 'Toggle 64px Collapsed Sidebar', zh: '折叠 / 展开侧栏 (64px)' },
  { keys: 'Ctrl + D', en: 'Toggle Night / Day Theme', zh: '切换夜间 / 日间主题' },
  { keys: 'Ctrl + L', en: 'Switch Language (EN / 中文)', zh: '切换中英文界面' },
  { keys: 'Ctrl + Shift + L', en: 'Lock App with Passcode', zh: '立即开启本地锁屏' },
  { keys: 'Ctrl + 0', en: 'Open Saved Messages', zh: '打开收藏夹' },
  { keys: 'Escape', en: 'Close Topmost Modal / Drawer / Search', zh: '逐层关闭弹窗 / 抽屉 / 搜索' },
];

export const LeftColumn: React.FC<LeftColumnProps> = ({ className }) => {
  const language = useSettingsStore((s) => s.language);

  const isLeftCollapsed = useUiStore((s) => s.isLeftCollapsed);
  const tabletLeftDrawerOpen = useUiStore((s) => s.tabletLeftDrawerOpen);
  const isBurgerOpen = useUiStore((s) => s.isBurgerOpen);
  const setLeftSidebarWidth = useUiStore((s) => s.setLeftSidebarWidth);
  const toggleLeftCollapsed = useUiStore((s) => s.toggleLeftCollapsed);
  const setBurgerOpen = useUiStore((s) => s.setBurgerOpen);
  const openModal = useUiStore((s) => s.openModal);

  const showArchived = useChatStore((s) => s.showArchived);
  const globalSearchQuery = useChatStore((s) => s.globalSearchQuery);
  const searchGlobal = useChatStore((s) => s.searchGlobal);

  const [searchInput, setSearchInput] = useState<string>(globalSearchQuery);
  const [searchFocused, setSearchFocused] = useState<boolean>(false);
  const [fabMenuOpen, setFabMenuOpen] = useState<boolean>(false);
  const [isDraggingResizer, setIsDraggingResizer] = useState<boolean>(false);
  const [externalEditFolder, setExternalEditFolder] = useState<ChatFolder | null>(null);
  const [fallbackShortcutsOpen, setFallbackShortcutsOpen] = useState<boolean>(false);

  const columnRef = useRef<HTMLElement | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSearchInput(globalSearchQuery);
  }, [globalSearchQuery]);

  // Dismiss FAB popover on outside click or Escape
  useEffect(() => {
    if (!fabMenuOpen || typeof window === 'undefined') return;
    const close = (): void => setFabMenuOpen(false);
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setFabMenuOpen(false);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [fabMenuOpen]);

  // Close fallback shortcuts modal on Escape
  useEffect(() => {
    if (!fallbackShortcutsOpen || typeof window === 'undefined') return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        setFallbackShortcutsOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [fallbackShortcutsOpen]);

  const handleSearchChange = (val: string): void => {
    setSearchInput(val);
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }
    searchDebounceRef.current = setTimeout(() => {
      void searchGlobal(val);
    }, 120);
  };

  const handleClearSearch = (): void => {
    setSearchInput('');
    setSearchFocused(false);
    void searchGlobal('');
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
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('gpui:open-shortcuts-modal'));
      // If modals engineer hasn't mounted #modal-shortcuts, provide built-in modal
      setTimeout(() => {
        if (!document.getElementById(DOM_IDS.MODAL_SHORTCUTS)) {
          setFallbackShortcutsOpen(true);
        }
      }, 20);
    }
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
        {/* Top Header: Burger Button + Global Search Input */}
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
            <div className="tg-search-pill">
              <svg
                width="16"
                height="16"
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

        {/* Floating New Chat Action Button (#btn-new-chat-fab) */}
        {!isLeftCollapsed && !isSearchActive && (
          <div
            style={{
              position: 'absolute',
              right: '16px',
              bottom: '16px',
              zIndex: 18,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {fabMenuOpen && (
              <div
                role="menu"
                data-testid="fab-menu"
                className="tg-context-menu"
                style={{
                  position: 'absolute',
                  right: 0,
                  bottom: '56px',
                  minWidth: '190px',
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setFabMenuOpen(false);
                    openModal('create_group');
                  }}
                  className="tg-context-menu-item"
                >
                  💬 {t('menu.newGroup', language)}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setFabMenuOpen(false);
                    openModal('create_channel');
                  }}
                  className="tg-context-menu-item"
                >
                  📢 {t('menu.newChannel', language)}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setFabMenuOpen(false);
                    openModal('create_secret_chat');
                  }}
                  className="tg-context-menu-item"
                >
                  🔒 {t('menu.newSecretChat', language)}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setFabMenuOpen(false);
                    openModal('contacts');
                  }}
                  className="tg-context-menu-item"
                >
                  👥 {t('menu.contacts', language)}
                </button>
              </div>
            )}

            <button
              id={DOM_IDS.BTN_NEW_CHAT_FAB}
              type="button"
              aria-label={t('menu.newGroup', language)}
              aria-expanded={fabMenuOpen}
              onClick={() => setFabMenuOpen((v) => !v)}
              style={{
                width: '48px',
                height: '48px',
                borderRadius: '50%',
                backgroundColor: 'var(--tg-accent)',
                color: 'var(--tg-on-accent)',
                boxShadow: 'var(--tg-shadow-md)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '20px',
                fontWeight: 600,
              }}
            >
              ✎
            </button>
          </div>
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

      {/* Fallback Keyboard Shortcuts Modal (#modal-shortcuts) if not rendered elsewhere */}
      {fallbackShortcutsOpen && (
        <div
          className="tg-modal-overlay"
          onClick={() => setFallbackShortcutsOpen(false)}
        >
          <div
            id={DOM_IDS.MODAL_SHORTCUTS}
            role="dialog"
            aria-modal="true"
            aria-label={language === 'zh-CN' ? '键盘快捷键' : 'Keyboard Shortcuts'}
            className="tg-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tg-modal-header">
              <span>⌨️ {language === 'zh-CN' ? '键盘快捷键' : 'Keyboard Shortcuts'}</span>
              <button
                type="button"
                onClick={() => setFallbackShortcutsOpen(false)}
                aria-label={t('common.close', language)}
                className="tg-icon-btn"
              >
                ✕
              </button>
            </div>
            <div
              className="tg-modal-body"
              style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
            >
              {KEYBOARD_SHORTCUT_LIST.map((item) => (
                <div
                  key={item.keys}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 8px',
                    borderRadius: 'var(--tg-radius-sm)',
                    backgroundColor: 'var(--tg-bg-elevated)',
                    fontSize: '13px',
                  }}
                >
                  <span>{language === 'zh-CN' ? item.zh : item.en}</span>
                  <kbd
                    style={{
                      fontFamily: 'var(--tg-font-mono)',
                      fontSize: '11.5px',
                      padding: '2px 7px',
                      borderRadius: '4px',
                      border: '1px solid var(--tg-border)',
                      backgroundColor: 'var(--tg-bg-surface)',
                    }}
                  >
                    {item.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
