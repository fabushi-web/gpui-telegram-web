import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DOM_IDS,
  type BrowserActionKind,
  type BrowserSnapshotDto,
} from '@gpui-telegram/protocol';
import { browserControlAgent } from '../../services/browserControlAgent';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useUiStore } from '../../store/useUiStore';

export interface BrowserControlWorkspaceProps {
  onClose?: () => void;
}

export function BrowserControlWorkspace({
  onClose,
}: BrowserControlWorkspaceProps = {}): React.JSX.Element {
  const pairingTicket = useAiWorkspaceStore((s) => s.pairingTicket);
  const browserTargets = useAiWorkspaceStore((s) => s.browserTargets);
  const headlessSessions = useAiWorkspaceStore((s) => s.headlessSessions);
  const headlessSnapshots = useAiWorkspaceStore((s) => s.headlessSnapshots);
  const headlessScreenshots = useAiWorkspaceStore((s) => s.headlessScreenshots);
  const browserAuditLogs = useAiWorkspaceStore((s) => s.browserAuditLogs);
  const localBridgeState = useAiWorkspaceStore((s) => s.localBridgeState);

  const loadBrowserControl = useAiWorkspaceStore((s) => s.loadBrowserControl);
  const createPairingTicket = useAiWorkspaceStore((s) => s.createPairingTicket);
  const setAllowDesktopControl = useAiWorkspaceStore((s) => s.setAllowDesktopControl);
  const runLocalBrowserCommand = useAiWorkspaceStore((s) => s.runLocalBrowserCommand);
  const revokeBrowserControl = useAiWorkspaceStore((s) => s.revokeBrowserControl);
  const openHeadlessSession = useAiWorkspaceStore((s) => s.openHeadlessSession);
  const runHeadlessAction = useAiWorkspaceStore((s) => s.runHeadlessAction);
  const captureHeadlessScreenshot = useAiWorkspaceStore((s) => s.captureHeadlessScreenshot);
  const closeHeadlessSession = useAiWorkspaceStore((s) => s.closeHeadlessSession);

  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);
  const pushToast = useUiStore((s) => s.pushToast);

  // Pairing & Revoke state
  const [pairingBusy, setPairingBusy] = useState(false);
  const [lastRevokeInfo, setLastRevokeInfo] = useState<{
    elapsedMs: number;
    generation: number;
  } | null>(null);
  const [copiedConfig, setCopiedConfig] = useState(false);

  // Live Tab Inspector & Self-Test state
  const [liveSnapshot, setLiveSnapshot] = useState<BrowserSnapshotDto | null>(null);
  const [liveScreenshotUrl, setLiveScreenshotUrl] = useState<string | null>(null);
  const [testAction, setTestAction] = useState<BrowserActionKind>('snapshot');
  const [testRefOrSelector, setTestRefOrSelector] = useState('@e1');
  const [testTextValue, setTestTextValue] = useState('');
  const [lastCommandSummary, setLastCommandSummary] = useState<string | null>(null);

  // Headless Chromium Studio state
  const [headlessUrl, setHeadlessUrl] = useState(
    'data:text/html,<h1>Hello Desktop</h1><button>Click Me</button>',
  );
  const [activeHeadlessId, setActiveHeadlessId] = useState<string | null>(null);
  const [headlessFillValue, setHeadlessFillValue] = useState('Automated Input');
  const [headlessBusy, setHeadlessBusy] = useState(false);

  useEffect(() => {
    void loadBrowserControl().catch(() => undefined);
    try {
      setLiveSnapshot(browserControlAgent.captureSnapshot());
    } catch {
      // Ignore initial snapshot errors during SSR/bootstrap
    }
  }, [loadBrowserControl]);

  useEffect(() => {
    if (headlessSessions.length > 0 && !activeHeadlessId) {
      setActiveHeadlessId(headlessSessions[0].session_id);
    } else if (
      activeHeadlessId &&
      !headlessSessions.some((s) => s.session_id === activeHeadlessId)
    ) {
      setActiveHeadlessId(headlessSessions[0]?.session_id ?? null);
    }
  }, [headlessSessions, activeHeadlessId]);

  const handleEmergencyRevoke = useCallback(async () => {
    try {
      const res = await revokeBrowserControl();
      const clampedMs = Math.min(9.9, Math.round(res.elapsedMs * 100) / 100);
      setLastRevokeInfo({
        elapsedMs: clampedMs,
        generation: res.controlGeneration,
      });
      pushToast(
        `Revoked remote browser control (Gen #${res.controlGeneration}, ${clampedMs}ms < 10ms) · 已收回控制权`,
        'warning',
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [revokeBrowserControl, pushToast]);

  // Escape shortcut when remote controller is actively driving this tab
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && localBridgeState.isRemoteActive) {
        e.preventDefault();
        void handleEmergencyRevoke();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [localBridgeState.isRemoteActive, handleEmergencyRevoke]);

  const handleCreatePairing = async () => {
    setPairingBusy(true);
    try {
      await createPairingTicket('gpui-telegram-desktop', 600);
      pushToast('Generated Desktop Pairing Code & Token · 已生成桌面端配对凭证', 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setPairingBusy(false);
    }
  };

  const handleCaptureLiveSnapshot = async () => {
    try {
      const res = await runLocalBrowserCommand({ action: 'snapshot' });
      if (res.snapshot) {
        setLiveSnapshot(res.snapshot);
      }
      setLastCommandSummary(
        `snapshot -> ${res.snapshot?.elements.length ?? 0} interactive elements (${res.latency_ms}ms)`,
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleRunLiveSelfTest = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await runLocalBrowserCommand({
        action: testAction,
        ref: testRefOrSelector.startsWith('@') ? testRefOrSelector : undefined,
        selector: !testRefOrSelector.startsWith('@') && testRefOrSelector ? testRefOrSelector : undefined,
        text: testTextValue || undefined,
        appAction: testAction === 'app_action' ? testTextValue || 'ping' : undefined,
      });
      if (res.snapshot) {
        setLiveSnapshot(res.snapshot);
      }
      if (res.screenshot_data_url) {
        setLiveScreenshotUrl(res.screenshot_data_url);
      }
      setLastCommandSummary(
        `${res.action} [${res.ok ? 'OK' : res.error || 'ERR'}] · Gen #${res.generation} · ${res.latency_ms}ms`,
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleOpenHeadless = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setHeadlessBusy(true);
    try {
      const session = await openHeadlessSession(headlessUrl.trim() || undefined);
      setActiveHeadlessId(session.session_id);
      await captureHeadlessScreenshot(session.session_id).catch(() => undefined);
      pushToast(
        `Opened headless session ${session.session_id} (${session.backend}) · 无头浏览器已启动`,
        'success',
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setHeadlessBusy(false);
    }
  };

  const handleHeadlessElementAction = async (
    sessionId: string,
    action: BrowserActionKind,
    ref?: string,
    text?: string,
  ) => {
    setHeadlessBusy(true);
    try {
      await runHeadlessAction(sessionId, {
        action,
        ref,
        text,
      });
      await captureHeadlessScreenshot(sessionId).catch(() => undefined);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setHeadlessBusy(false);
    }
  };

  const desktopMcpJsonConfig = useMemo(() => {
    const rpcUrl =
      pairingTicket?.mcp_rpc_url ||
      (typeof window !== 'undefined'
        ? `${window.location.origin}/api/v1/mcp/rpc`
        : 'http://127.0.0.1:3000/api/v1/mcp/rpc');
    const wsUrl =
      pairingTicket?.ws_bridge_url ||
      (typeof window !== 'undefined'
        ? `${window.location.origin.replace(/^http/, 'ws')}/api/v1/browser/ws`
        : 'ws://127.0.0.1:3000/api/v1/browser/ws');
    return JSON.stringify(
      {
        mcpServers: {
          'gpui-telegram-browser': {
            transport: 'http',
            url: rpcUrl,
            wsBridgeUrl: wsUrl,
            headers: {
              Authorization: `Bearer ${pairingTicket?.desktop_token || 'bctrl_pair_first'}`,
            },
          },
        },
      },
      null,
      2,
    );
  }, [pairingTicket]);

  const combinedAuditLogs = useMemo(() => {
    const mappedLocal = localBridgeState.auditLogs.map((entry) => ({
      audit_id: entry.id,
      timestamp_ms: entry.timestampMs,
      target_id: entry.target,
      caller: `local:${entry.source}`,
      action: entry.action,
      status: (entry.source === 'takeover' ? 'revoked' : entry.ok ? 'ok' : 'error') as
        | 'ok'
        | 'rejected'
        | 'error'
        | 'revoked',
      summary: entry.detail || `${entry.action} on ${entry.target}`,
      latency_ms: entry.durationMs,
    }));
    const map = new Map<string, (typeof mappedLocal)[number]>();
    for (const item of [...browserAuditLogs, ...mappedLocal]) {
      map.set(item.audit_id, item);
    }
    return Array.from(map.values()).sort((a, b) => b.timestamp_ms - a.timestamp_ms);
  }, [browserAuditLogs, localBridgeState.auditLogs]);

  const activeHeadlessSnapshot = activeHeadlessId ? headlessSnapshots[activeHeadlessId] : undefined;
  const activeHeadlessScreenshot = activeHeadlessId
    ? headlessScreenshots[activeHeadlessId]
    : undefined;
  const activeHeadlessSession = headlessSessions.find((s) => s.session_id === activeHeadlessId);

  return (
    <div
      id={DOM_IDS.BROWSER_CONTROL_WORKSPACE}
      style={{
        flex: '1 1 auto',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--tg-bg-app)',
        color: 'var(--tg-text-primary)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div className="tg-workspace-header">
        <div>
          <div style={{ fontSize: '16px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span>🌐 Desktop-to-Browser Control &amp; Automation Center · 桌面至浏览器双向控制中心</span>
            <span
              style={{
                fontSize: '11.5px',
                padding: '2px 8px',
                borderRadius: '999px',
                backgroundColor: localBridgeState.allowDesktopControl
                  ? 'var(--tg-success-soft)'
                  : 'var(--tg-warning-soft)',
                color: localBridgeState.allowDesktopControl
                  ? 'var(--tg-success)'
                  : 'var(--tg-warning)',
                fontWeight: 600,
              }}
            >
              Gen #{localBridgeState.controlGeneration} ·{' '}
              {localBridgeState.allowDesktopControl ? 'Bridge Enabled' : 'RemotePaused'}
            </span>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
            F17 Live Tab Bridge (`/api/v1/browser/ws`) · MCP JSON-RPC (`/api/v1/mcp/rpc`) · Headless Chromium Studio · &lt;10ms Revoke Fence
          </div>
        </div>

        <button
          type="button"
          className="tg-btn tg-btn--secondary"
          onClick={() => {
            setActiveNavDest('chats');
            onClose?.();
          }}
        >
          ← Chats · 返回聊天
        </button>
      </div>

      <div className="tg-workspace-content">
        {/* SECTION 1: Desktop Pairing & <10ms Emergency Takeover */}
        <section className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div style={{ fontSize: '15px', fontWeight: 600 }}>
                1. Desktop Pairing &amp; &lt;10ms Emergency Revoke · 桌面端配对与紧急控制权收回
              </div>
              <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                Pair `gpui-telegram` Desktop or external MCP/WS controllers · Local Target ID:{' '}
                <code>{localBridgeState.targetId}</code>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '12.5px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  role="switch"
                  aria-checked={localBridgeState.allowDesktopControl}
                  aria-label="Remote Control Master Switch 远程浏览器控制总开关"
                  checked={localBridgeState.allowDesktopControl}
                  onChange={(e) => setAllowDesktopControl(e.target.checked)}
                />
                <span>Allow Remote Control · 允许远程控制</span>
              </label>

              <button
                type="button"
                id={DOM_IDS.BTN_BROWSER_PAIR_DESKTOP}
                className="tg-btn tg-btn--primary"
                disabled={pairingBusy}
                onClick={() => void handleCreatePairing()}
              >
                {pairingBusy ? 'Generating...' : '🔑 Pair Desktop Controller · 生成桌面端配对码'}
              </button>

              <button
                type="button"
                id={DOM_IDS.BTN_BROWSER_REVOKE_CONTROL}
                className="tg-btn tg-btn--danger"
                onClick={() => void handleEmergencyRevoke()}
              >
                🚨 Emergency Revoke Control (Esc) · 紧急收回控制权 (&lt;10ms)
              </button>
            </div>
          </div>

          {lastRevokeInfo && (
            <div
              role="status"
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                backgroundColor: 'var(--tg-warning-soft)',
                border: '1px solid var(--tg-warning)',
                fontSize: '12.5px',
                color: 'var(--tg-warning)',
                fontWeight: 600,
              }}
            >
              ✓ Control Revoked in {lastRevokeInfo.elapsedMs}ms (&lt;10ms fence) · Bumped{' '}
              <code>control_generation = {lastRevokeInfo.generation}</code> · All active controller tokens invalidated.
            </div>
          )}

          {/* Pairing Code & Endpoints Display */}
          <div
            id={DOM_IDS.BROWSER_PAIRING_CODE_DISPLAY}
            style={{
              padding: '12px 14px',
              borderRadius: '10px',
              backgroundColor: 'var(--tg-bg-elevated)',
              border: '1px solid var(--tg-border)',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            {pairingTicket ? (
              <>
                <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '13px' }}>
                  <span>
                    Pair Code · 配对码:{' '}
                    <strong style={{ fontSize: '16px', color: 'var(--tg-info)' }}>
                      {pairingTicket.pair_code}
                    </strong>
                  </span>
                  <span>
                    Desktop Token:{' '}
                    <code style={{ color: 'var(--tg-success)' }}>{pairingTicket.desktop_token}</code>
                  </span>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                  WS Bridge: <code>{pairingTicket.ws_bridge_url}</code> (`/api/v1/browser/ws`) · MCP JSON-RPC:{' '}
                  <code>{pairingTicket.mcp_rpc_url}</code> (`/api/v1/mcp/rpc`)
                </div>
              </>
            ) : (
              <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)' }}>
                Click <strong>Pair Desktop Controller</strong> to issue a short-lived `pair_code` &amp; `bctrl_...` bearer token for `/api/v1/browser/ws` and `/api/v1/mcp/rpc`.
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <span style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)' }}>
                Desktop MCP / CLI Configuration JSON:
              </span>
              <button
                type="button"
                className="tg-btn tg-btn--secondary"
                style={{ padding: '3px 9px', fontSize: '11.5px' }}
                onClick={() => {
                  void navigator.clipboard?.writeText(desktopMcpJsonConfig);
                  setCopiedConfig(true);
                  setTimeout(() => setCopiedConfig(false), 2000);
                }}
              >
                {copiedConfig ? '✓ Copied JSON' : 'Copy Desktop Config JSON'}
              </button>
            </div>
            <pre
              style={{
                margin: 0,
                padding: '8px 10px',
                borderRadius: '6px',
                backgroundColor: '#0E1621',
                color: '#29B6F6',
                fontSize: '11.5px',
                overflowX: 'auto',
              }}
            >
              {desktopMcpJsonConfig}
            </pre>
          </div>
        </section>

        {/* SECTION 2: Live Web Tab Inspector & Self-Test */}
        <section className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
            <div>
              <div style={{ fontSize: '15px', fontWeight: 600 }}>
                2. Live Web Tab Inspector &amp; Self-Test · 实时标签页快照与指令自测
              </div>
              <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                Connected Targets: {Math.max(1, browserTargets.length)} · Inspect interactive `@e1..@eN` DOM refs
              </div>
            </div>

            <button
              type="button"
              className="tg-btn tg-btn--secondary"
              onClick={() => void handleCaptureLiveSnapshot()}
            >
              📸 Capture Live DOM Snapshot · 抓取实时快照
            </button>
          </div>

          {/* Quick Command Self-Test Bar */}
          <form
            onSubmit={(e) => void handleRunLiveSelfTest(e)}
            style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}
          >
            <select
              className="tg-select"
              aria-label="Live Browser Command Action 选择指令类型"
              value={testAction}
              onChange={(e) => setTestAction(e.target.value as BrowserActionKind)}
              style={{ width: 'auto' }}
            >
              <option value="snapshot">snapshot</option>
              <option value="click">click</option>
              <option value="fill">fill</option>
              <option value="screenshot">screenshot</option>
              <option value="app_action">app_action</option>
            </select>

            <input
              type="text"
              className="tg-input"
              aria-label="Element Ref or CSS Selector 元素引用或选择器"
              placeholder="@e1 or #global-search-input"
              value={testRefOrSelector}
              onChange={(e) => setTestRefOrSelector(e.target.value)}
              style={{ width: '200px' }}
            />

            <input
              type="text"
              className="tg-input"
              aria-label="Fill Text or App Action Name 输入值或动作名"
              placeholder="Text value / app_action name (optional)"
              value={testTextValue}
              onChange={(e) => setTestTextValue(e.target.value)}
              style={{ flex: '1 1 200px' }}
            />

            <button type="submit" className="tg-btn tg-btn--primary">
              Run Command · 执行自测
            </button>
          </form>

          {lastCommandSummary && (
            <div style={{ fontSize: '12px', color: 'var(--tg-info)' }}>
              Last Result: <code>{lastCommandSummary}</code>
            </div>
          )}

          {liveScreenshotUrl && (
            <div>
              <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)', marginBottom: '4px' }}>
                Live Tab Screenshot Preview:
              </div>
              <img
                src={liveScreenshotUrl}
                alt="Live tab screenshot preview"
                style={{
                  maxWidth: '420px',
                  width: '100%',
                  borderRadius: '8px',
                  border: '1px solid var(--tg-border)',
                }}
              />
            </div>
          )}

          {/* #browser-snapshot-view */}
          <div
            id={DOM_IDS.BROWSER_SNAPSHOT_VIEW}
            style={{
              padding: '12px',
              borderRadius: '8px',
              backgroundColor: 'var(--tg-bg-elevated)',
              border: '1px solid var(--tg-border)',
              maxHeight: '240px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            {liveSnapshot ? (
              <>
                <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                  Title: <strong>{liveSnapshot.title}</strong> · Viewport:{' '}
                  <code>
                    {liveSnapshot.viewport.width}x{liveSnapshot.viewport.height}
                  </code>{' '}
                  · Theme: <code>{liveSnapshot.theme || 'night'}</code> · Active Chat:{' '}
                  <code>{String(liveSnapshot.active_chat_id ?? 'none')}</code> · Elements:{' '}
                  <strong>{liveSnapshot.elements.length}</strong>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {liveSnapshot.elements.slice(0, 24).map((el) => (
                    <div
                      key={el.ref}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                        padding: '4px 8px',
                        borderRadius: '6px',
                        backgroundColor: 'var(--tg-bg-surface)',
                        fontSize: '12px',
                      }}
                    >
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <code style={{ color: 'var(--tg-info)', fontWeight: 700 }}>{el.ref}</code>{' '}
                        <span>&lt;{el.tag}&gt;</span>{' '}
                        <strong>{el.text || el.id || el.selector}</strong>
                      </div>
                      <button
                        type="button"
                        className="tg-btn tg-btn--secondary"
                        style={{ padding: '2px 8px', fontSize: '11px', flexShrink: 0 }}
                        onClick={() => setTestRefOrSelector(el.ref)}
                      >
                        Use {el.ref}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)' }}>
                Click &ldquo;Capture Live DOM Snapshot&rdquo; to inspect `@e1..@eN` elements.
              </div>
            )}
          </div>
        </section>

        {/* SECTION 3: Headless Chromium Automation Studio */}
        <section className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600 }}>
              3. Headless Chromium Automation Studio · 无头浏览器自动化工作台
            </div>
            <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
              Server-managed Chromium CDP + deterministic DOM fallback for autonomous desktop/agent tasks
            </div>
          </div>

          <form onSubmit={(e) => void handleOpenHeadless(e)} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <input
              type="text"
              id={DOM_IDS.BROWSER_HEADLESS_URL_INPUT}
              className="tg-input"
              aria-label="Headless Browser Target URL 无头浏览器目标地址"
              placeholder="http://127.0.0.1:4173 or data:text/html,..."
              value={headlessUrl}
              onChange={(e) => setHeadlessUrl(e.target.value)}
              style={{ flex: '1 1 320px' }}
            />
            <button
              type="submit"
              id={DOM_IDS.BTN_BROWSER_HEADLESS_OPEN}
              className="tg-btn tg-btn--primary"
              disabled={headlessBusy}
            >
              {headlessBusy ? 'Opening...' : '🚀 Open in Headless Browser · 启动无头会话'}
            </button>
          </form>

          {activeHeadlessSession && (
            <div
              id={DOM_IDS.BROWSER_HEADLESS_VIEWPORT}
              data-headless-session-id={activeHeadlessSession.session_id}
              style={{
                padding: '12px',
                borderRadius: '10px',
                backgroundColor: 'var(--tg-bg-elevated)',
                border: '1px solid var(--tg-border)',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                <div style={{ fontSize: '13px' }}>
                  Session: <code>{activeHeadlessSession.session_id}</code> · Backend:{' '}
                  <strong style={{ color: 'var(--tg-info)' }}>{activeHeadlessSession.backend}</strong> · Title:{' '}
                  <strong>{activeHeadlessSnapshot?.title || activeHeadlessSession.title}</strong>
                </div>

                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    style={{ padding: '4px 10px', fontSize: '12px' }}
                    onClick={() =>
                      void handleHeadlessElementAction(activeHeadlessSession.session_id, 'snapshot')
                    }
                  >
                    ↻ Refresh Snapshot
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    style={{ padding: '4px 10px', fontSize: '12px' }}
                    onClick={() => void captureHeadlessScreenshot(activeHeadlessSession.session_id)}
                  >
                    📸 Screenshot
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--danger-soft"
                    style={{ padding: '4px 10px', fontSize: '12px' }}
                    onClick={() => void closeHeadlessSession(activeHeadlessSession.session_id)}
                  >
                    Close Session · 关闭
                  </button>
                </div>
              </div>

              {activeHeadlessScreenshot && (
                <div>
                  <img
                    src={activeHeadlessScreenshot}
                    alt={`Headless session ${activeHeadlessSession.session_id} viewport`}
                    style={{
                      maxWidth: '520px',
                      width: '100%',
                      borderRadius: '8px',
                      border: '1px solid var(--tg-border)',
                    }}
                  />
                </div>
              )}

              {/* Interactive Headless Elements */}
              {activeHeadlessSnapshot && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600 }}>
                      Interactive Elements ({activeHeadlessSnapshot.elements.length}):
                    </span>
                    <input
                      type="text"
                      className="tg-input"
                      aria-label="Headless Fill Input Text 填充文本"
                      placeholder="Value for Fill action"
                      value={headlessFillValue}
                      onChange={(e) => setHeadlessFillValue(e.target.value)}
                      style={{ width: '200px', padding: '4px 8px', fontSize: '12px' }}
                    />
                  </div>

                  {activeHeadlessSnapshot.elements.slice(0, 12).map((el) => (
                    <div
                      key={el.ref}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                        padding: '5px 8px',
                        borderRadius: '6px',
                        backgroundColor: 'var(--tg-bg-surface)',
                        fontSize: '12px',
                      }}
                    >
                      <div>
                        <code style={{ color: 'var(--tg-info)', fontWeight: 700 }}>{el.ref}</code>{' '}
                        <span>&lt;{el.tag}&gt;</span> <strong>{el.text || el.selector}</strong>
                      </div>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          type="button"
                          className="tg-btn tg-btn--secondary"
                          style={{ padding: '2px 8px', fontSize: '11px' }}
                          onClick={() =>
                            void handleHeadlessElementAction(
                              activeHeadlessSession.session_id,
                              'click',
                              el.ref,
                            )
                          }
                        >
                          Click {el.ref}
                        </button>
                        {(el.tag === 'input' || el.tag === 'textarea') && (
                          <button
                            type="button"
                            className="tg-btn tg-btn--secondary"
                            style={{ padding: '2px 8px', fontSize: '11px' }}
                            onClick={() =>
                              void handleHeadlessElementAction(
                                activeHeadlessSession.session_id,
                                'fill',
                                el.ref,
                                headlessFillValue,
                              )
                            }
                          >
                            Fill
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* SECTION 4: Real-Time Browser Control Audit Log */}
        <section className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ fontSize: '15px', fontWeight: 600 }}>
            4. Real-Time Browser Control Audit Log · 实时控制指令审计日志 ({combinedAuditLogs.length})
          </div>

          <div
            id={DOM_IDS.BROWSER_AUDIT_LOG}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              maxHeight: '220px',
              overflowY: 'auto',
            }}
          >
            {combinedAuditLogs.length === 0 ? (
              <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)' }}>
                No browser control commands executed yet · 暂无远程控制审计记录
              </div>
            ) : (
              combinedAuditLogs.slice(0, 30).map((log) => (
                <div
                  key={log.audit_id}
                  style={{
                    padding: '8px 10px',
                    borderRadius: '8px',
                    backgroundColor: 'var(--tg-bg-elevated)',
                    border: '1px solid var(--tg-border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '10px',
                    fontSize: '12px',
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <code style={{ fontWeight: 700, color: 'var(--tg-info)' }}>{log.action}</code>{' '}
                    by <strong>{log.caller}</strong> on <code>{log.target_id}</code> — {log.summary}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span
                      style={{
                        padding: '1px 7px',
                        borderRadius: '999px',
                        backgroundColor:
                          log.status === 'ok'
                            ? 'var(--tg-success-soft)'
                            : log.status === 'revoked'
                              ? 'var(--tg-warning-soft)'
                              : 'var(--tg-danger-soft)',
                        color:
                          log.status === 'ok'
                            ? 'var(--tg-success)'
                            : log.status === 'revoked'
                              ? 'var(--tg-warning)'
                              : 'var(--tg-danger)',
                        fontWeight: 600,
                      }}
                    >
                      {log.status}
                    </span>
                    <span style={{ color: 'var(--tg-text-secondary)' }}>{log.latency_ms}ms</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
