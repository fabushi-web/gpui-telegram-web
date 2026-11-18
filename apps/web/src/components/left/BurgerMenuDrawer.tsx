import React, { useMemo } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { t } from '../../i18n';
import { MAX_STORED_ACCOUNTS, useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';

export interface BurgerMenuDrawerProps {
  onOpenShortcuts?: () => void;
  className?: string;
}

function getInitials(firstName?: string, lastName?: string, fallback = 'U'): string {
  const f = (firstName ?? '').trim();
  const l = (lastName ?? '').trim();
  if (f && l) return `${f[0]}${l[0]}`.toUpperCase();
  if (f) return f.slice(0, 2).toUpperCase();
  return fallback.slice(0, 2).toUpperCase();
}

export const BurgerMenuDrawer: React.FC<BurgerMenuDrawerProps> = ({
  onOpenShortcuts,
  className,
}) => {
  const language = useSettingsStore((s) => s.language);
  const theme = useSettingsStore((s) => s.theme);
  const toggleNightMode = useSettingsStore((s) => s.toggleNightMode);
  const toggleLanguage = useSettingsStore((s) => s.toggleLanguage);

  const isBurgerOpen = useUiStore((s) => s.isBurgerOpen);
  const setBurgerOpen = useUiStore((s) => s.setBurgerOpen);
  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);
  const openSettings = useUiStore((s) => s.openSettings);
  const openModal = useUiStore((s) => s.openModal);

  const accounts = useAuthStore((s) => s.accounts);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const currentUser = useAuthStore((s) => s.currentUser);
  const passcodeHash = useAuthStore((s) => s.passcodeHash);
  const switchAccount = useAuthStore((s) => s.switchAccount);
  const addAccountFlow = useAuthStore((s) => s.addAccountFlow);
  const lockApp = useAuthStore((s) => s.lockApp);
  const logout = useAuthStore((s) => s.logout);

  const chatsById = useChatStore((s) => s.chatsById);
  const showArchived = useChatStore((s) => s.showArchived);
  const setShowArchived = useChatStore((s) => s.setShowArchived);
  const openSavedMessages = useChatStore((s) => s.openSavedMessages);

  const archivedCount = useMemo(
    () => Object.values(chatsById).filter((c) => c.isArchived).length,
    [chatsById],
  );

  if (!isBurgerOpen) {
    return null;
  }

  const isDarkTheme = theme === 'night' || theme === 'tinted';
  const storedAccounts = accounts.slice(0, MAX_STORED_ACCOUNTS);

  return (
    <>
      <div
        className="tg-drawer-backdrop"
        data-testid="burger-drawer-backdrop"
        onClick={() => setBurgerOpen(false)}
      />

      <aside
        id={DOM_IDS.MAIN_MENU_DRAWER}
        role="menu"
        aria-label="Main Menu"
        className={className}
      >
        {/* Multi-Account Switcher Header (#menu-account-switcher) */}
        <div
          id={DOM_IDS.MENU_ACCOUNT_SWITCHER}
          style={{
            padding: '14px 14px 10px',
            borderBottom: '1px solid var(--tg-border)',
            backgroundColor: 'var(--tg-bg-elevated)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          {currentUser && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div
                className="tg-avatar"
                data-avatar="true"
                data-color-index={String(currentUser.colorIndex)}
              >
                {getInitials(currentUser.firstName, currentUser.lastName, currentUser.username)}
              </div>
              <div style={{ minWidth: 0, flex: '1 1 auto' }}>
                <div
                  style={{
                    fontSize: '14.5px',
                    fontWeight: 700,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {currentUser.firstName} {currentUser.lastName ?? ''}
                </div>
                <div
                  style={{
                    fontSize: '12px',
                    color: 'var(--tg-text-secondary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {currentUser.username ? `@${currentUser.username}` : `ID #${currentUser.userId}`}
                </div>
              </div>
            </div>
          )}

          {/* Stored Accounts List (up to 6 accounts) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
            {storedAccounts.map((acc) => {
              const isCurrent = acc.accountId === activeAccountId;
              return (
                <button
                  key={acc.accountId}
                  type="button"
                  role="menuitem"
                  data-account-id={acc.accountId}
                  aria-current={isCurrent ? 'true' : undefined}
                  onClick={() => {
                    if (!isCurrent) {
                      setBurgerOpen(false);
                      void switchAccount(acc.accountId);
                    }
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    padding: '6px 8px',
                    borderRadius: 'var(--tg-radius-sm)',
                    backgroundColor: isCurrent ? 'var(--tg-accent-soft)' : 'transparent',
                    color: 'var(--tg-text-primary)',
                    fontSize: '12.5px',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                    <span
                      className="tg-avatar tg-avatar--sm"
                      data-color-index={String(acc.user.colorIndex)}
                      style={{ width: '26px', height: '26px', fontSize: '11px' }}
                    >
                      {getInitials(acc.user.firstName, acc.user.lastName, acc.user.username)}
                    </span>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: isCurrent ? 600 : 500,
                      }}
                    >
                      {acc.user.firstName}{' '}
                      {acc.user.username ? `(@${acc.user.username})` : ''}
                    </span>
                  </span>
                  {isCurrent && (
                    <span style={{ color: 'var(--tg-accent)', fontWeight: 700, flexShrink: 0 }}>
                      ✓
                    </span>
                  )}
                </button>
              );
            })}

            {storedAccounts.length < MAX_STORED_ACCOUNTS && (
              <button
                type="button"
                data-testid="btn-add-account"
                onClick={() => {
                  setBurgerOpen(false);
                  addAccountFlow();
                }}
                className="tg-btn tg-btn--ghost"
                style={{
                  width: '100%',
                  justifyContent: 'flex-start',
                  padding: '6px 8px',
                  fontSize: '12.5px',
                  fontWeight: 600,
                }}
              >
                ＋ {t('menu.addAccount', language)} ({storedAccounts.length}/{MAX_STORED_ACCOUNTS})
              </button>
            )}
          </div>
        </div>

        {/* Canonical Menu Items */}
        <div
          style={{
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
            flex: '1 1 auto',
          }}
        >
          <button
            id={DOM_IDS.MENU_ITEM_SAVED_MESSAGES}
            type="button"
            role="menuitem"
            onClick={() => {
              setBurgerOpen(false);
              setActiveNavDest('chats');
              void openSavedMessages();
            }}
            className="tg-context-menu-item"
          >
            <span aria-hidden="true">🔖</span>
            <span>{t('menu.savedMessages', language)}</span>
          </button>

          <button
            id={DOM_IDS.MENU_ITEM_ARCHIVED}
            type="button"
            role="menuitem"
            onClick={() => {
              setBurgerOpen(false);
              setActiveNavDest('chats');
              setShowArchived(!showArchived);
            }}
            className="tg-context-menu-item"
            style={{ justifyContent: 'space-between' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span aria-hidden="true">📥</span>
              <span>{t('menu.archivedChats', language)}</span>
            </span>
            {archivedCount > 0 && (
              <span className="tg-badge tg-badge--muted">{archivedCount}</span>
            )}
          </button>

          <button
            id={DOM_IDS.MENU_ITEM_CONTACTS}
            type="button"
            role="menuitem"
            onClick={() => openModal('contacts')}
            className="tg-context-menu-item"
          >
            <span aria-hidden="true">👥</span>
            <span>{t('menu.contacts', language)}</span>
          </button>

          <button
            id={DOM_IDS.MENU_ITEM_NEW_GROUP}
            type="button"
            role="menuitem"
            onClick={() => openModal('create_group')}
            className="tg-context-menu-item"
          >
            <span aria-hidden="true">💬</span>
            <span>{t('menu.newGroup', language)}</span>
          </button>

          <button
            id={DOM_IDS.MENU_ITEM_NEW_CHANNEL}
            type="button"
            role="menuitem"
            onClick={() => openModal('create_channel')}
            className="tg-context-menu-item"
          >
            <span aria-hidden="true">📢</span>
            <span>{t('menu.newChannel', language)}</span>
          </button>

          <button
            id={DOM_IDS.MENU_ITEM_WALLET}
            type="button"
            role="menuitem"
            onClick={() => openModal('wallet_stars')}
            className="tg-context-menu-item"
          >
            <span aria-hidden="true">⭐</span>
            <span>{t('menu.wallet', language)}</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => openModal('miniapp_catalog')}
            className="tg-context-menu-item"
          >
            <span aria-hidden="true">🧩</span>
            <span>{t('menu.miniApps', language)}</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setBurgerOpen(false);
              setActiveNavDest('browser_control');
            }}
            className="tg-context-menu-item"
          >
            <span aria-hidden="true">🌐</span>
            <span>{t('browserControl.title', language)}</span>
          </button>

          <button
            id={DOM_IDS.MENU_ITEM_SETTINGS}
            type="button"
            role="menuitem"
            onClick={() => openSettings('root')}
            className="tg-context-menu-item"
          >
            <span aria-hidden="true">⚙️</span>
            <span>{t('menu.settings', language)}</span>
          </button>

          <div
            style={{
              height: '1px',
              backgroundColor: 'var(--tg-border-subtle)',
              margin: '4px 6px',
            }}
          />

          {/* In-Place Night Mode & Language Toggles */}
          <button
            id={DOM_IDS.MENU_TOGGLE_NIGHT_MODE}
            type="button"
            role="menuitem"
            onClick={toggleNightMode}
            className="tg-context-menu-item"
            style={{ justifyContent: 'space-between' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span aria-hidden="true">🌙</span>
              <span>{t('menu.nightMode', language)}</span>
            </span>
            <span
              className={`tg-switch ${isDarkTheme ? 'is-checked' : ''}`.trim()}
              aria-checked={isDarkTheme}
              role="switch"
            >
              <span className="tg-switch-thumb" />
            </span>
          </button>

          <button
            id={DOM_IDS.MENU_TOGGLE_LANGUAGE}
            type="button"
            role="menuitem"
            onClick={toggleLanguage}
            className="tg-context-menu-item"
            style={{ justifyContent: 'space-between' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span aria-hidden="true">🌍</span>
              <span>{t('menu.language', language)}</span>
            </span>
            <span
              style={{
                fontSize: '11.5px',
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 'var(--tg-radius-pill)',
                backgroundColor: 'var(--tg-accent-soft)',
                color: 'var(--tg-accent)',
              }}
            >
              {language === 'zh-CN' ? '中文 → EN' : 'EN → 中文'}
            </span>
          </button>

          {/* Passcode Lock & Keyboard Shortcuts */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              if (passcodeHash) {
                setBurgerOpen(false);
                lockApp();
              } else {
                openModal('passcode_setup');
              }
            }}
            className="tg-context-menu-item"
          >
            <span aria-hidden="true">🔒</span>
            <span>
              {passcodeHash
                ? t('menu.lockApp', language)
                : t('passcode.enable', language)}
            </span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setBurgerOpen(false);
              onOpenShortcuts?.();
            }}
            className="tg-context-menu-item"
          >
            <span aria-hidden="true">⌨️</span>
            <span>{language === 'zh-CN' ? '键盘快捷键' : 'Keyboard Shortcuts'}</span>
          </button>

          <div
            style={{
              height: '1px',
              backgroundColor: 'var(--tg-border-subtle)',
              margin: '4px 6px',
            }}
          />

          <button
            id={DOM_IDS.MENU_ITEM_LOGOUT}
            type="button"
            role="menuitem"
            onClick={() => {
              setBurgerOpen(false);
              void logout();
            }}
            className="tg-context-menu-item is-danger"
          >
            <span aria-hidden="true">🚪</span>
            <span>{t('menu.logout', language)}</span>
          </button>
        </div>
      </aside>
    </>
  );
};
