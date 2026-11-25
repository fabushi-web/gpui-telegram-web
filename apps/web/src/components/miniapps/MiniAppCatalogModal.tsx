import React, { useEffect, useMemo, useState } from 'react';
import type { MiniAppEntry } from '@gpui-telegram/protocol';
import { getServerAdapter } from '../../adapters';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useChatStore } from '../../store/useChatStore';
import { useUiStore } from '../../store/useUiStore';

export interface MiniAppCatalogModalProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export function MiniAppCatalogModal({
  isOpen,
  onClose,
}: MiniAppCatalogModalProps = {}): React.JSX.Element | null {
  const activeModal = useUiStore((s) => s.activeModal);
  const closeModal = useUiStore((s) => s.closeModal);
  const pushToast = useUiStore((s) => s.pushToast);

  const miniApps = useAiWorkspaceStore((s) => s.miniApps);
  const bots = useAiWorkspaceStore((s) => s.bots);
  const lastCreatedBotToken = useAiWorkspaceStore((s) => s.lastCreatedBotToken);
  const loadMiniApps = useAiWorkspaceStore((s) => s.loadMiniApps);
  const loadBots = useAiWorkspaceStore((s) => s.loadBots);
  const launchMiniApp = useAiWorkspaceStore((s) => s.launchMiniApp);
  const createBot = useAiWorkspaceStore((s) => s.createBot);

  const activeChatId = useChatStore((s) => s.activeChatId);
  const selectChat = useChatStore((s) => s.selectChat);

  const [searchQuery, setSearchQuery] = useState('');
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [installedKeys, setInstalledKeys] = useState<Set<string>>(new Set());
  const [recentApps, setRecentApps] = useState<MiniAppEntry[]>([]);
  const [togglingInstallKey, setTogglingInstallKey] = useState<string | null>(null);

  // Quick @BotFather form state
  const [botDisplayName, setBotDisplayName] = useState('');
  const [botUsername, setBotUsername] = useState('');
  const [botDescription, setBotDescription] = useState('');
  const [creatingBot, setCreatingBot] = useState(false);
  const [createdBotChatId, setCreatedBotChatId] = useState<number | null>(null);
  const [botError, setBotError] = useState<string | null>(null);

  const visible = isOpen !== undefined ? isOpen : activeModal === 'miniapp_catalog';

  const appKey = (app: MiniAppEntry): string =>
    `${app.bot_username.toLowerCase()}/${app.short_name.toLowerCase()}`;

  useEffect(() => {
    if (!visible) return;
    const server = getServerAdapter();
    void loadMiniApps().catch(() => undefined);
    void loadBots().catch(() => undefined);
    void server
      .listInstalledMiniApps()
      .then((list) => setInstalledKeys(new Set(list.map(appKey))))
      .catch(() => undefined);
    void server
      .listRecentMiniApps()
      .then((list) => setRecentApps(list))
      .catch(() => undefined);
  }, [visible, loadMiniApps, loadBots]);

  const mergedApps = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return miniApps;
    return miniApps.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.bot_username.toLowerCase().includes(q) ||
        item.short_name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q),
    );
  }, [miniApps, searchQuery]);

  const handleClose = () => {
    closeModal();
    onClose?.();
  };

  const handleLaunch = async (app: MiniAppEntry) => {
    setLaunchingId(app.app_id);
    try {
      await launchMiniApp(app.bot_username, app.short_name, activeChatId ?? undefined);
      closeModal();
      onClose?.();
    } catch (err) {
      pushToast(
        `Launch failed · 启动失败: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    } finally {
      setLaunchingId(null);
    }
  };

  const handleToggleInstall = async (app: MiniAppEntry) => {
    const key = appKey(app);
    const isInstalled = installedKeys.has(key);
    setTogglingInstallKey(key);
    try {
      const server = getServerAdapter();
      if (isInstalled) {
        await server.uninstallMiniApp(app.bot_username, app.short_name);
        setInstalledKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        pushToast(`Uninstalled ${app.title} · 已卸载`, 'info');
      } else {
        await server.installMiniApp(app.bot_username, app.short_name);
        setInstalledKeys((prev) => new Set(prev).add(key));
        pushToast(`Installed ${app.title} · 已安装`, 'success');
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setTogglingInstallKey(null);
    }
  };

  const handleCreateBot = async (e: React.FormEvent) => {
    e.preventDefault();
    setBotError(null);
    const cleanName = botDisplayName.trim();
    let cleanUser = botUsername.trim().replace(/^@/, '');
    if (!cleanName || !cleanUser) {
      setBotError('Please enter both display name and @username · 请填写名称与用户名');
      return;
    }
    if (!cleanUser.toLowerCase().endsWith('bot')) {
      cleanUser = `${cleanUser}_bot`;
    }
    setCreatingBot(true);
    try {
      const res = await createBot({
        displayName: cleanName,
        username: cleanUser,
        description: botDescription.trim() || undefined,
      });
      setCreatedBotChatId(res.chatId);
      setBotDisplayName('');
      setBotUsername('');
      setBotDescription('');
      pushToast(`Created @${res.bot.username} via @BotFather · 机器人已创建`, 'success');
      await loadMiniApps().catch(() => undefined);
    } catch (err) {
      setBotError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingBot(false);
    }
  };

  if (!visible) return null;

  return (
    <div
      id="miniapp-catalog-modal"
      className="tg-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Fabushi Mini Apps Catalog & @BotFather 小程序中心"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleClose();
        }
      }}
    >
      <div
        className="tg-modal-card"
        style={{ width: 'min(660px, 95vw)', maxHeight: '90dvh' }}
      >
        <div className="tg-modal-header">
          <div>
            <div style={{ fontSize: '16px', fontWeight: 600 }}>
              🧩 Mini Apps Center &amp; @BotFather · 小程序与机器人中心
            </div>
            <div style={{ fontSize: '12px', fontWeight: 400, color: 'var(--tg-text-secondary)' }}>
              Fabushi Web v1.6.11 · WebApp v8.0 + WebMCP Host · Rust/WASM 3D Globe &amp; External Mini Apps
            </div>
          </div>
          <button
            type="button"
            className="tg-icon-btn"
            aria-label="Close Catalog 关闭"
            onClick={handleClose}
          >
            ×
          </button>
        </div>

        <div className="tg-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Search Bar */}
          <div>
            <input
              type="search"
              className="tg-input"
              aria-label="Search Mini Apps 搜索小程序"
              placeholder="Search Mini Apps by title, @bot, or short_name · 搜索小程序..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Recent Mini Apps Strip */}
          {recentApps.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--tg-text-secondary)' }}>
                Recent Mini Apps · 最近使用 ({recentApps.length})
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {recentApps.map((app) => (
                  <button
                    key={`recent_${appKey(app)}`}
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    style={{ padding: '5px 10px', fontSize: '12px' }}
                    onClick={() => void handleLaunch(app)}
                  >
                    {app.icon_emoji || '🧩'} {app.title}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Mini Apps Grid */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--tg-text-secondary)' }}>
              Available Mini Apps · 可用小程序 ({mergedApps.length})
            </div>

            {mergedApps.map((app) => {
              const key = appKey(app);
              const isInstalled = installedKeys.has(key);
              return (
                <div
                  key={`${app.bot_username}_${app.short_name}`}
                  data-miniapp-id={app.app_id}
                  data-miniapp-short-name={app.short_name}
                  className="tg-surface-card"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                    padding: '12px 14px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                    <div
                      style={{
                        width: '44px',
                        height: '44px',
                        borderRadius: '12px',
                        backgroundColor: 'var(--tg-accent-soft)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '22px',
                        flexShrink: 0,
                      }}
                    >
                      {app.icon_emoji || '🧩'}
                    </div>

                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          flexWrap: 'wrap',
                          fontWeight: 600,
                          fontSize: '14px',
                        }}
                      >
                        <span>{app.title}</span>
                        {app.has_wasm && (
                          <span
                            style={{
                              fontSize: '10.5px',
                              padding: '1px 6px',
                              borderRadius: '999px',
                              backgroundColor: 'var(--tg-info-soft)',
                              color: 'var(--tg-info)',
                            }}
                          >
                            WASM 3D
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)', marginTop: '2px' }}>
                        {app.description}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          fontSize: '11.5px',
                          color: 'var(--tg-text-muted)',
                          marginTop: '4px',
                        }}
                      >
                        <span>@{app.bot_username}</span>
                        <span>·</span>
                        <code>{app.short_name}</code>
                        <span>·</span>
                        <span>{app.category}</span>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                    <button
                      type="button"
                      className="tg-btn tg-btn--secondary"
                      disabled={togglingInstallKey === key}
                      onClick={() => void handleToggleInstall(app)}
                      style={{ padding: '6px 10px', fontSize: '12px' }}
                    >
                      {isInstalled ? 'Uninstall · 卸载' : 'Install · 安装'}
                    </button>
                    <button
                      type="button"
                      className="tg-btn tg-btn--primary"
                      disabled={launchingId === app.app_id}
                      onClick={() => void handleLaunch(app)}
                    >
                      {launchingId === app.app_id ? 'Launching...' : 'Launch · 打开'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Quick @BotFather Creator */}
          <form
            onSubmit={(e) => void handleCreateBot(e)}
            className="tg-surface-card"
            style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>
                🤖 Quick @BotFather Creator · 快速创建机器人
              </div>
              <span style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)' }}>
                Registered Bots: {bots.length}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <input
                type="text"
                className="tg-input"
                aria-label="Bot Display Name 机器人显示名"
                placeholder="Display Name (e.g. Deploy Helper)"
                value={botDisplayName}
                onChange={(e) => setBotDisplayName(e.target.value)}
              />
              <input
                type="text"
                className="tg-input"
                aria-label="Bot Username 机器人用户名"
                placeholder="@username_bot"
                value={botUsername}
                onChange={(e) => setBotUsername(e.target.value)}
              />
            </div>

            <input
              type="text"
              className="tg-input"
              aria-label="Bot Description 机器人描述"
              placeholder="Optional description or persona · 机器人描述 (支持在 @BotFather 中使用 /newapp 绑定小程序)"
              value={botDescription}
              onChange={(e) => setBotDescription(e.target.value)}
            />

            {botError && (
              <div style={{ fontSize: '12px', color: 'var(--tg-danger)' }}>{botError}</div>
            )}

            {lastCreatedBotToken && (
              <div
                style={{
                  padding: '8px 10px',
                  borderRadius: '8px',
                  backgroundColor: 'var(--tg-success-soft)',
                  color: 'var(--tg-success)',
                  fontSize: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  flexWrap: 'wrap',
                }}
              >
                <span>
                  Bot Token Issued · 已签发密钥: <code>{lastCreatedBotToken}</code>
                </span>
                {createdBotChatId && (
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    style={{ padding: '4px 10px', fontSize: '12px' }}
                    onClick={() => {
                      void selectChat(createdBotChatId);
                      handleClose();
                    }}
                  >
                    Open Bot Chat · 打开会话
                  </button>
                )}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                type="submit"
                className="tg-btn tg-btn--primary"
                disabled={creatingBot}
              >
                {creatingBot ? 'Creating...' : 'Create Bot (/newbot) · 创建机器人'}
              </button>
            </div>
          </form>
        </div>

        <div className="tg-modal-footer">
          <button type="button" className="tg-btn tg-btn--secondary" onClick={handleClose}>
            Close · 关闭
          </button>
        </div>
      </div>
    </div>
  );
}
