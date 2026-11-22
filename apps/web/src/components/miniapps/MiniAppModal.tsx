import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DOM_IDS, type MiniAppThemeParams } from '@gpui-telegram/protocol';
import { getClientAdapter } from '../../adapters';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { registerUiEscapeHooks, useUiStore } from '../../store/useUiStore';

export interface MiniAppModalProps {
  isOpen?: boolean;
  onClose?: () => void;
}

function sanitizeSafeButtonHex(rawHex: string | undefined, fallback = '#3390EC'): string {
  if (!rawHex) return fallback;
  const trimmed = rawHex.trim();
  const match = trimmed.match(/^#?([0-9a-f]{6})$/i);
  if (!match) return fallback;
  const num = parseInt(match[1], 16);
  const r = ((num >> 16) & 0xff) / 255;
  const g = ((num >> 8) & 0xff) / 255;
  const b = (num & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d > 0) {
    let h = 0;
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    if (h >= 235 && h <= 315) {
      return fallback;
    }
  }
  return `#${match[1].toUpperCase()}`;
}

function buildThemeParams(theme: string, accentColor: string): MiniAppThemeParams {
  const safeAccent = sanitizeSafeButtonHex(accentColor, '#3390EC');
  if (theme === 'day') {
    return {
      bg_color: '#FFFFFF',
      text_color: '#111827',
      hint_color: '#6B7280',
      link_color: safeAccent,
      button_color: safeAccent,
      button_text_color: '#FFFFFF',
      secondary_bg_color: '#F1F3F5',
      header_bg_color: '#FFFFFF',
    };
  }
  if (theme === 'tinted') {
    return {
      bg_color: '#15191E',
      text_color: '#F3F5F8',
      hint_color: '#8594A6',
      link_color: safeAccent,
      button_color: safeAccent,
      button_text_color: '#FFFFFF',
      secondary_bg_color: '#0E1013',
      header_bg_color: '#15191E',
    };
  }
  return {
    bg_color: '#17212B',
    text_color: '#F5F5F5',
    hint_color: '#7F91A4',
    link_color: safeAccent,
    button_color: safeAccent,
    button_text_color: '#FFFFFF',
    secondary_bg_color: '#0E1621',
    header_bg_color: '#17212B',
  };
}

function resolveTrustedOrigin(launchUrl: string): string {
  if (typeof window === 'undefined') return '';
  try {
    const resolved = new URL(launchUrl, window.location.origin);
    return resolved.origin;
  } catch {
    return window.location.origin;
  }
}

export function MiniAppModal({ isOpen, onClose }: MiniAppModalProps = {}): React.JSX.Element | null {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const autoLaunchedRef = useRef(false);

  const miniAppModalOpen = useUiStore((s) => s.miniAppModalOpen);
  const pushToast = useUiStore((s) => s.pushToast);

  const activeMiniApp = useAiWorkspaceStore((s) => s.activeMiniApp);
  const miniAppMainButton = useAiWorkspaceStore((s) => s.miniAppMainButton);
  const miniAppBackVisible = useAiWorkspaceStore((s) => s.miniAppBackButtonVisible);
  const lastMiniAppWebData = useAiWorkspaceStore((s) => s.lastMiniAppWebData);
  const launchMiniApp = useAiWorkspaceStore((s) => s.launchMiniApp);
  const setMiniAppIframeRef = useAiWorkspaceStore((s) => s.setMiniAppIframeRef);
  const closeMiniApp = useAiWorkspaceStore((s) => s.closeMiniApp);

  const serverUrl = useAuthStore((s) => s.serverUrl);
  const authToken = useAuthStore((s) => s.token);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const theme = useSettingsStore((s) => s.theme);
  const accentColor = useSettingsStore((s) => s.accentColor);

  const [isExpanded, setIsExpanded] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [rejectedSpoofCount, setRejectedSpoofCount] = useState(0);

  const visible = isOpen !== undefined ? isOpen : miniAppModalOpen || Boolean(activeMiniApp);

  const handleClose = useCallback(() => {
    setIsExpanded(false);
    setIsReady(false);
    closeMiniApp();
    onClose?.();
  }, [closeMiniApp, onClose]);

  // Register deterministic Escape stack Layer 3 hook
  useEffect(() => {
    registerUiEscapeHooks({
      closeMiniApp: () => {
        useAiWorkspaceStore.getState().closeMiniApp();
      },
    });
  }, []);

  // Ensure default MiniApp launches if modal was opened directly without launch context
  useEffect(() => {
    if (!visible) {
      autoLaunchedRef.current = false;
      return;
    }
    if (!activeMiniApp && !autoLaunchedRef.current) {
      autoLaunchedRef.current = true;
      void launchMiniApp('FabushiBot', 'fabushi-globe', activeChatId ?? undefined).catch(() => {
        // Fallback iframe URL still renders cleanly
      });
    }
  }, [visible, activeMiniApp, launchMiniApp, activeChatId]);

  const baseLaunchUrl = useMemo(() => {
    const raw = activeMiniApp?.launch_url || '/miniapps/fabushi-globe/index.html';
    const basePrefix = (
      (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL || '/'
    ).replace(/\/$/, '');
    const withBase =
      basePrefix && raw.startsWith('/miniapps/') ? `${basePrefix}${raw}` : raw;

    const hashIdx = withBase.indexOf('#');
    const beforeHash = hashIdx >= 0 ? withBase.slice(0, hashIdx) : withBase;
    const hashParams = new URLSearchParams(hashIdx >= 0 ? withBase.slice(hashIdx + 1) : '');
    if (activeMiniApp?.init_data && !hashParams.has('tgWebAppData')) {
      hashParams.set('tgWebAppData', activeMiniApp.init_data);
    }
    const effectiveApiBase =
      serverUrl || (typeof window !== 'undefined' ? window.location.origin : '');
    if (effectiveApiBase && !hashParams.has('api_base')) {
      hashParams.set('api_base', effectiveApiBase);
    }
    if (authToken && !hashParams.has('auth_token')) {
      hashParams.set('auth_token', authToken);
    }
    const nextHash = hashParams.toString();
    return nextHash ? `${beforeHash}#${nextHash}` : beforeHash;
  }, [activeMiniApp?.launch_url, activeMiniApp?.init_data, serverUrl, authToken]);

  const effectiveSrc = useMemo(() => {
    if (reloadNonce === 0) return baseLaunchUrl;
    const hashIdx = baseLaunchUrl.indexOf('#');
    const beforeHash = hashIdx >= 0 ? baseLaunchUrl.slice(0, hashIdx) : baseLaunchUrl;
    const hashPart = hashIdx >= 0 ? baseLaunchUrl.slice(hashIdx) : '';
    const sep = beforeHash.includes('?') ? '&' : '?';
    return `${beforeHash}${sep}_reload=${reloadNonce}${hashPart}`;
  }, [baseLaunchUrl, reloadNonce]);

  const trustedOrigin = useMemo(() => resolveTrustedOrigin(baseLaunchUrl), [baseLaunchUrl]);

  const postToMiniApp = useCallback(
    (eventType: string, eventData?: Record<string, unknown>) => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      const targetOrigin = trustedOrigin || window.location.origin;
      win.postMessage({ eventType, eventData }, targetOrigin);
    },
    [trustedOrigin],
  );

  // Sync iframe ref with store
  const bindIframeElement = useCallback(
    (el: HTMLIFrameElement | null) => {
      iframeRef.current = el;
      setMiniAppIframeRef(el);
    },
    [setMiniAppIframeRef],
  );

  // Sync live theme changes into MiniApp iframe
  useEffect(() => {
    if (!visible) return;
    const themeParams = buildThemeParams(theme, accentColor);
    postToMiniApp('theme_changed', { theme_params: themeParams });
  }, [visible, theme, accentColor, isReady, postToMiniApp]);

  // Strict origin + source validated Telegram.WebApp postMessage host bridge
  useEffect(() => {
    if (!visible || typeof window === 'undefined') return undefined;

    const onMessage = async (ev: MessageEvent) => {
      if (!ev.data) return;

      let parsed: Record<string, unknown> | null = null;
      if (typeof ev.data === 'string') {
        try {
          parsed = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return;
        }
      } else if (typeof ev.data === 'object') {
        parsed = ev.data as Record<string, unknown>;
      }
      if (!parsed) return;

      const eventType = String(parsed.eventType ?? parsed.type ?? '');
      if (!eventType.startsWith('web_app_')) return;

      const iframeWin = iframeRef.current?.contentWindow;
      const sameWindowOrigin = ev.origin === window.location.origin;
      const matchesLaunchOrigin = Boolean(trustedOrigin) && ev.origin === trustedOrigin;

      // Strict security check: must originate from the mounted #miniapp-iframe contentWindow
      // AND match same-origin or trusted MiniApp launch origin!
      if (!iframeWin || ev.source !== iframeWin || (!sameWindowOrigin && !matchesLaunchOrigin)) {
        ev.stopImmediatePropagation();
        setRejectedSpoofCount((c) => c + 1);
        return;
      }

      // Prevent duplicate handling if any global bubble-phase listener was also bound
      ev.stopImmediatePropagation();

      const eventData = (parsed.eventData ?? parsed.data ?? {}) as Record<string, unknown>;

      switch (eventType) {
        case 'web_app_ready': {
          setIsReady(true);
          const themeParams = buildThemeParams(
            useSettingsStore.getState().theme,
            useSettingsStore.getState().accentColor,
          );
          postToMiniApp('theme_changed', { theme_params: themeParams });
          break;
        }
        case 'web_app_expand': {
          setIsExpanded(true);
          break;
        }
        case 'web_app_setup_main_button': {
          useAiWorkspaceStore.setState((prev) => ({
            miniAppMainButton: {
              isVisible:
                eventData.is_visible !== undefined
                  ? Boolean(eventData.is_visible)
                  : prev.miniAppMainButton.isVisible,
              isActive:
                eventData.is_active !== undefined
                  ? Boolean(eventData.is_active)
                  : prev.miniAppMainButton.isActive,
              text:
                typeof eventData.text === 'string' && eventData.text.trim()
                  ? eventData.text
                  : prev.miniAppMainButton.text,
              color:
                typeof eventData.color === 'string'
                  ? sanitizeSafeButtonHex(eventData.color, prev.miniAppMainButton.color)
                  : prev.miniAppMainButton.color,
              textColor:
                typeof eventData.text_color === 'string'
                  ? eventData.text_color
                  : prev.miniAppMainButton.textColor,
            },
          }));
          break;
        }
        case 'web_app_setup_back_button': {
          useAiWorkspaceStore.setState({
            miniAppBackButtonVisible: Boolean(eventData.is_visible),
          });
          break;
        }
        case 'web_app_data_send': {
          const rawData =
            typeof eventData.data === 'string'
              ? eventData.data
              : JSON.stringify(eventData.data ?? '');
          useAiWorkspaceStore.setState({ lastMiniAppWebData: rawData });

          const currentCtx = useAiWorkspaceStore.getState().activeMiniApp;
          const targetChatId =
            currentCtx?.companion_chat_id || useChatStore.getState().activeChatId;
          const appTitle = currentCtx?.app.title || 'Mini App';
          if (targetChatId) {
            await useChatStore
              .getState()
              .sendText(targetChatId, `🧩 MiniApp (${appTitle}): ${rawData}`)
              .catch(() => undefined);
          }
          pushToast(`Mini App data sent · 已发送小程序数据`, 'success');
          break;
        }
        case 'web_app_close': {
          handleClose();
          break;
        }
        case 'web_app_invoke_custom_method': {
          const reqId = eventData.req_id;
          const method = String(eventData.method ?? '');
          const params = (eventData.params ?? {}) as Record<string, unknown>;
          const adapter = getClientAdapter();
          const currentCtx = useAiWorkspaceStore.getState().activeMiniApp;
          const botUsername = currentCtx?.app.bot_username || 'FabushiBot';
          const shortName = currentCtx?.app.short_name || 'fabushi-globe';
          try {
            let result: unknown = null;
            if (method === 'saveStorageValue') {
              await adapter.setMiniAppCloudStorage(
                botUsername,
                shortName,
                String(params.key ?? ''),
                String(params.value ?? ''),
              );
              result = true;
            } else if (method === 'getStorageValues') {
              const keys = Array.isArray(params.keys) ? params.keys.map(String) : undefined;
              result = await adapter.getMiniAppCloudStorage(botUsername, shortName, keys);
            } else if (method === 'deleteStorageValues') {
              const keys = Array.isArray(params.keys) ? params.keys.map(String) : [];
              await adapter.deleteMiniAppCloudStorage(botUsername, shortName, keys);
              result = true;
            }
            postToMiniApp('custom_method_invoked', { req_id: reqId, result });
          } catch (err) {
            postToMiniApp('custom_method_invoked', {
              req_id: reqId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }
        default:
          break;
      }
    };

    // Capture phase ensures spoofing protection runs ahead of any unguarded window listeners
    window.addEventListener('message', onMessage, true);
    return () => {
      window.removeEventListener('message', onMessage, true);
    };
  }, [visible, trustedOrigin, postToMiniApp, handleClose, pushToast]);

  const handleHostBackClick = useCallback(() => {
    postToMiniApp('back_button_pressed');
  }, [postToMiniApp]);

  const handleHostMainButtonClick = useCallback(() => {
    if (!miniAppMainButton.isActive) return;
    postToMiniApp('main_button_pressed');
  }, [miniAppMainButton.isActive, postToMiniApp]);

  const handleReload = useCallback(() => {
    setIsReady(false);
    setReloadNonce((n) => n + 1);
  }, []);

  if (!visible) return null;

  const appTitle = activeMiniApp?.app.title || '全球法布施 · Global Dharma & Merit 3D';
  const botUsername = activeMiniApp?.app.bot_username || 'FabushiBot';
  const iconEmoji = activeMiniApp?.app.icon_emoji || '🌏';

  return (
    <div
      id={DOM_IDS.MINIAPP_MODAL}
      role="dialog"
      aria-modal="true"
      aria-label={`${appTitle} (@${botUsername}) Mini App`}
      data-expanded={isExpanded ? 'true' : 'false'}
      data-ready={isReady ? 'true' : 'false'}
      data-rejected-spoofs={rejectedSpoofCount}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleClose();
        }
      }}
    >
      <div
        className="tg-miniapp-sheet"
        style={
          isExpanded
            ? {
                width: 'min(920px, 96vw)',
                height: 'min(860px, 94dvh)',
              }
            : undefined
        }
      >
        {/* Host Header Bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            padding: '10px 14px',
            backgroundColor: 'var(--tg-bg-surface)',
            borderBottom: '1px solid var(--tg-border)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            {miniAppBackVisible && (
              <button
                type="button"
                id="miniapp-host-back-btn"
                data-testid="miniapp-host-back-btn"
                className="tg-btn tg-btn--secondary"
                aria-label="Back 返回"
                onClick={handleHostBackClick}
                style={{ padding: '5px 10px', fontSize: '12.5px' }}
              >
                ← Back · 返回
              </button>
            )}

            <span style={{ fontSize: '18px', lineHeight: 1 }} aria-hidden="true">
              {iconEmoji}
            </span>

            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: '14px',
                  fontWeight: 600,
                  color: 'var(--tg-text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {appTitle}
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '11.5px',
                  color: 'var(--tg-text-secondary)',
                }}
              >
                <span
                  style={{
                    padding: '1px 6px',
                    borderRadius: '999px',
                    backgroundColor: 'var(--tg-accent-soft)',
                    color: 'var(--tg-accent)',
                    fontWeight: 500,
                  }}
                >
                  @{botUsername}
                </span>
                <span>{isReady ? 'WebApp Ready · 已就绪' : 'Sandboxed Mini App · 小程序'}</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
            <button
              type="button"
              className="tg-btn tg-btn--secondary"
              aria-label="Expand Mini App 展开窗口"
              title="Expand / Compact · 切换尺寸"
              onClick={() => setIsExpanded((v) => !v)}
              style={{ padding: '5px 9px', fontSize: '12px' }}
            >
              {isExpanded ? 'Compact' : 'Expand'}
            </button>
            <button
              type="button"
              className="tg-btn tg-btn--secondary"
              aria-label="Reload Mini App 刷新小程序"
              title="Reload · 重新加载"
              onClick={handleReload}
              style={{ padding: '5px 9px', fontSize: '12px' }}
            >
              ↻ Reload
            </button>
            <button
              type="button"
              className="tg-icon-btn"
              aria-label="Close Mini App 关闭小程序"
              title="Close · 关闭 (Esc)"
              onClick={handleClose}
            >
              ×
            </button>
          </div>
        </div>

        {/* Sandboxed Mini App Iframe */}
        <iframe
          key={`${baseLaunchUrl}_${reloadNonce}`}
          ref={bindIframeElement}
          id={DOM_IDS.MINIAPP_IFRAME}
          title={appTitle}
          src={effectiveSrc}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          onLoad={() => {
            const themeParams = buildThemeParams(theme, accentColor);
            postToMiniApp('theme_changed', { theme_params: themeParams });
          }}
        />

        {/* Optional WebApp Data Telemetry Strip */}
        {lastMiniAppWebData && (
          <div
            data-testid="miniapp-last-webdata"
            style={{
              padding: '6px 14px',
              fontSize: '11.5px',
              backgroundColor: 'var(--tg-bg-elevated)',
              borderTop: '1px solid var(--tg-border)',
              color: 'var(--tg-text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            Last sendData · 最近回传: <code>{lastMiniAppWebData}</code>
          </div>
        )}

        {/* Host MainButton Footer */}
        {miniAppMainButton.isVisible && (
          <div
            style={{
              padding: '10px 14px',
              backgroundColor: 'var(--tg-bg-surface)',
              borderTop: '1px solid var(--tg-border)',
              flexShrink: 0,
            }}
          >
            <button
              type="button"
              data-testid="miniapp-host-main-btn"
              disabled={!miniAppMainButton.isActive}
              onClick={handleHostMainButtonClick}
              style={{
                width: '100%',
                padding: '11px 16px',
                borderRadius: '10px',
                border: 'none',
                backgroundColor: sanitizeSafeButtonHex(miniAppMainButton.color, '#3390EC'),
                color: miniAppMainButton.textColor || '#FFFFFF',
                fontSize: '14px',
                fontWeight: 600,
                cursor: miniAppMainButton.isActive ? 'pointer' : 'not-allowed',
                opacity: miniAppMainButton.isActive ? 1 : 0.55,
              }}
            >
              {miniAppMainButton.text}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
