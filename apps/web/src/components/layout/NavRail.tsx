import React, { useMemo } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { t } from '../../i18n';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore, type NavDestinationId } from '../../store/useUiStore';

export interface NavRailProps {
  className?: string;
}

interface RailDestinationItem {
  domId: string;
  dest: NavDestinationId;
  labelKey: string;
  shortEn: string;
  shortZh: string;
  icon: React.ReactNode;
}

export const NavRail: React.FC<NavRailProps> = ({ className }) => {
  const language = useSettingsStore((s) => s.language);
  const isLeftCollapsed = useUiStore((s) => s.isLeftCollapsed);
  const activeNavDest = useUiStore((s) => s.activeNavDest);
  const settingsStack = useUiStore((s) => s.settingsStack);
  const toggleLeftCollapsed = useUiStore((s) => s.toggleLeftCollapsed);
  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);
  const openSettings = useUiStore((s) => s.openSettings);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const pushToast = useUiStore((s) => s.pushToast);

  const chatsById = useChatStore((s) => s.chatsById);
  const activeChatId = useChatStore((s) => s.activeChatId);

  const totalUnread = useMemo(() => {
    let sum = 0;
    for (const chat of Object.values(chatsById)) {
      if (!chat.isArchived) {
        sum += chat.unreadCount || (chat.unreadMark ? 1 : 0);
      }
    }
    return sum;
  }, [chatsById]);

  const isSettingsOpen = settingsStack.length > 0;

  const destinations: RailDestinationItem[] = useMemo(
    () => [
      {
        domId: DOM_IDS.NAV_DEST_CHATS,
        dest: 'chats',
        labelKey: 'nav.chats',
        shortEn: 'Chats',
        shortZh: '会话',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z" />
          </svg>
        ),
      },
      {
        domId: DOM_IDS.NAV_DEST_TASKS,
        dest: 'tasks',
        labelKey: 'nav.tasks',
        shortEn: 'Tasks',
        shortZh: '任务',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M8 10l2 2 4-4M8 16h8" />
          </svg>
        ),
      },
      {
        domId: DOM_IDS.NAV_DEST_MCP,
        dest: 'mcp',
        labelKey: 'nav.mcp',
        shortEn: 'MCP',
        shortZh: 'MCP',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        ),
      },
      {
        domId: DOM_IDS.NAV_DEST_TALK,
        dest: 'talk',
        labelKey: 'nav.talk',
        shortEn: 'Talk',
        shortZh: '语音',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <rect x="9" y="2" width="6" height="11" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" />
          </svg>
        ),
      },
      {
        domId: DOM_IDS.NAV_DEST_COMPUTER,
        dest: 'computers',
        labelKey: 'nav.computers',
        shortEn: 'PC',
        shortZh: '电脑',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
        ),
      },
      {
        domId: DOM_IDS.NAV_DEST_HERMES,
        dest: 'hermes',
        labelKey: 'nav.hermes',
        shortEn: 'Hermes',
        shortZh: 'AI',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <path d="M12 3l2.4 5.4L20 10.8l-5.6 2.4L12 18.6l-2.4-5.4L4 10.8l5.6-2.4L12 3z" />
          </svg>
        ),
      },
      {
        domId: DOM_IDS.NAV_DEST_BROWSER,
        dest: 'browser_control',
        labelKey: 'nav.browserControl',
        shortEn: 'Browser',
        shortZh: '浏览器',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <circle cx="12" cy="12" r="9" />
            <path d="M3.6 9h16.8M3.6 15h16.8M12 3a14.5 14.5 0 0 1 0 18M12 3a14.5 14.5 0 0 0 0 18" />
          </svg>
        ),
      },
    ],
    [],
  );

  const handleSelectDest = (dest: NavDestinationId): void => {
    if (isSettingsOpen) {
      closeSettings();
    }
    setActiveNavDest(dest);
  };

  const handleLaunchFabushiMiniApp = (): void => {
    if (isSettingsOpen) {
      closeSettings();
    }
    void useAiWorkspaceStore
      .getState()
      .launchMiniApp('FabushiBot', 'fabushi-globe', activeChatId ?? undefined)
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        pushToast(msg || 'Failed to launch Fabushi Mini App', 'error');
      });
  };

  return (
    <nav
      id={DOM_IDS.NAV_RAIL}
      aria-label="Workspace Navigation"
      className={`tg-nav-rail ${className ?? ''}`.trim()}
    >
      <div className="tg-nav-rail-group">
        <button
          id={DOM_IDS.BTN_COLLAPSE_SIDEBAR}
          type="button"
          onClick={() => toggleLeftCollapsed()}
          aria-expanded={!isLeftCollapsed}
          aria-label={
            isLeftCollapsed
              ? t('nav.expandSidebar', language)
              : t('nav.collapseSidebar', language)
          }
          title={`${
            isLeftCollapsed
              ? t('nav.expandSidebar', language)
              : t('nav.collapseSidebar', language)
          } (Ctrl+B)`}
          className={`tg-nav-rail-item ${isLeftCollapsed ? 'is-active' : ''}`.trim()}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16" />
          </svg>
        </button>

        {destinations.map((item) => {
          const isActive = !isSettingsOpen && activeNavDest === item.dest;
          const fullLabel = t(item.labelKey, language);
          const shortLabel = language === 'zh-CN' ? item.shortZh : item.shortEn;

          return (
            <button
              key={item.domId}
              id={item.domId}
              type="button"
              data-active={String(isActive)}
              aria-selected={isActive}
              aria-label={fullLabel}
              title={fullLabel}
              onClick={() => handleSelectDest(item.dest)}
              className={`tg-nav-rail-item ${isActive ? 'is-active' : ''}`.trim()}
            >
              {item.icon}
              <span style={{ lineHeight: 1 }}>{shortLabel}</span>
              {item.dest === 'chats' && totalUnread > 0 && (
                <span
                  className="tg-badge"
                  data-unread="true"
                  style={{
                    position: 'absolute',
                    top: '2px',
                    right: '2px',
                    minWidth: '17px',
                    height: '17px',
                    padding: '0 4px',
                    fontSize: '10px',
                  }}
                >
                  {totalUnread > 99 ? '99+' : totalUnread}
                </span>
              )}
            </button>
          );
        })}

        {/* Permanently visible Fabushi 3D MiniApp launch button (even on empty workspaces) */}
        <button
          id="nav-miniapp-fabushi"
          data-testid="nav-miniapp-fabushi"
          data-miniapp-short-name="fabushi-globe"
          type="button"
          aria-label={
            language === 'zh-CN'
              ? '法布施小程序 · Fabushi Mini App'
              : 'Fabushi Mini App · 法布施小程序'
          }
          title={language === 'zh-CN' ? '全球法布施 3D 小程序' : 'Fabushi 3D Mini App'}
          onClick={handleLaunchFabushiMiniApp}
          className="tg-nav-rail-item tg-nav-rail-fabushi"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 3c2.8 2.6 4.2 5.6 4.2 9s-1.4 6.4-4.2 9c-2.8-2.6-4.2-5.6-4.2-9s1.4-6.4 4.2-9z" />
            <path d="M3.5 12h17" />
          </svg>
          <span style={{ lineHeight: 1 }}>
            {language === 'zh-CN' ? '法布施' : 'Fabushi'}
          </span>
        </button>
      </div>

      <div className="tg-nav-rail-group">
        <button
          id={DOM_IDS.NAV_DEST_SETTINGS}
          type="button"
          data-active={String(isSettingsOpen)}
          aria-selected={isSettingsOpen}
          aria-label={t('nav.settings', language)}
          title={t('nav.settings', language)}
          onClick={() => {
            if (isSettingsOpen) {
              closeSettings();
            } else {
              openSettings('root');
            }
          }}
          className={`tg-nav-rail-item ${isSettingsOpen ? 'is-active' : ''}`.trim()}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.77 1.02 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span style={{ lineHeight: 1 }}>
            {language === 'zh-CN' ? '设置' : 'Settings'}
          </span>
        </button>
      </div>
    </nav>
  );
};
