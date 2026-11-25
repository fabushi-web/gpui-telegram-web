import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DOM_IDS,
  type BrowserActionKind,
  type BrowserSnapshotDto,
  type RecordedActionKind,
} from '@gpui-telegram/protocol';
import { browserControlAgent } from '../../services/browserControlAgent';
import { ApiRequestError, useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useUiStore } from '../../store/useUiStore';

export interface BrowserControlWorkspaceProps {
  onClose?: () => void;
}

type InspectorTabId = 'copilot' | 'recorder' | 'session' | 'app_store';

function SnapshotCanvasFrame({
  snapshot,
}: {
  snapshot: BrowserSnapshotDto | undefined;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#0E0E0E';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#181818';
    ctx.fillRect(0, 0, canvas.width, 36);
    ctx.fillStyle = '#0A84FF';
    ctx.fillRect(0, 35, canvas.width, 1);

    ctx.fillStyle = '#F5F5F5';
    ctx.font = '600 13px sans-serif';
    ctx.fillText(snapshot?.title || 'Live Headless Browser Session', 14, 23);

    ctx.fillStyle = '#9BA3AE';
    ctx.font = '12px monospace';
    ctx.fillText((snapshot?.url || 'about:blank').slice(0, 76), 14, 58);

    const excerpt = (snapshot?.text_excerpt || '').slice(0, 600);
    ctx.fillStyle = '#E5E7EB';
    ctx.font = '13px sans-serif';
    const words = excerpt.split(/\s+/);
    let line = '';
    let y = 86;
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (candidate.length > 68) {
        ctx.fillText(line, 14, y);
        line = w;
        y += 20;
        if (y > canvas.height - 20) break;
      } else {
        line = candidate;
      }
    }
    if (line && y <= canvas.height - 20) {
      ctx.fillText(line, 14, y);
    }
  }, [snapshot]);

  return (
    <canvas
      ref={canvasRef}
      width={640}
      height={320}
      aria-label="Live headless browser viewport frame"
    />
  );
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
  const browserControlMode = useAiWorkspaceStore((s) => s.browserControlMode);
  const chromiumAvailable = useAiWorkspaceStore((s) => s.chromiumAvailable);
  const lastBrowserRevokeLatencyMs = useAiWorkspaceStore((s) => s.lastBrowserRevokeLatencyMs);
  const recordedBrowserTrace = useAiWorkspaceStore((s) => s.recordedBrowserTrace);
  const distilledManifest = useAiWorkspaceStore((s) => s.distilledManifest);
  const lastScriptReplayReport = useAiWorkspaceStore((s) => s.lastScriptReplayReport);
  const automationApps = useAiWorkspaceStore((s) => s.automationApps);
  const installedAutomationApps = useAiWorkspaceStore((s) => s.installedAutomationApps);
  const localBridgeState = useAiWorkspaceStore((s) => s.localBridgeState);

  const loadBrowserControl = useAiWorkspaceStore((s) => s.loadBrowserControl);
  const createPairingTicket = useAiWorkspaceStore((s) => s.createPairingTicket);
  const setAllowDesktopControl = useAiWorkspaceStore((s) => s.setAllowDesktopControl);
  const runLocalBrowserCommand = useAiWorkspaceStore((s) => s.runLocalBrowserCommand);
  const revokeBrowserControl = useAiWorkspaceStore((s) => s.revokeBrowserControl);
  const setBrowserControlModeAction = useAiWorkspaceStore((s) => s.setBrowserControlModeAction);
  const openHeadlessSession = useAiWorkspaceStore((s) => s.openHeadlessSession);
  const runHeadlessAction = useAiWorkspaceStore((s) => s.runHeadlessAction);
  const captureHeadlessScreenshot = useAiWorkspaceStore((s) => s.captureHeadlessScreenshot);
  const closeHeadlessSession = useAiWorkspaceStore((s) => s.closeHeadlessSession);
  const recordBrowserAction = useAiWorkspaceStore((s) => s.recordBrowserAction);
  const clearRecordedBrowserTrace = useAiWorkspaceStore((s) => s.clearRecordedBrowserTrace);
  const distillBrowserScript = useAiWorkspaceStore((s) => s.distillBrowserScript);
  const replayBrowserScript = useAiWorkspaceStore((s) => s.replayBrowserScript);
  const loadAutomationApps = useAiWorkspaceStore((s) => s.loadAutomationApps);
  const loadInstalledAutomationApps = useAiWorkspaceStore((s) => s.loadInstalledAutomationApps);
  const publishAutomationApp = useAiWorkspaceStore((s) => s.publishAutomationApp);
  const installAutomationApp = useAiWorkspaceStore((s) => s.installAutomationApp);
  const uninstallAutomationApp = useAiWorkspaceStore((s) => s.uninstallAutomationApp);
  const recordAutomationRun = useAiWorkspaceStore((s) => s.recordAutomationRun);

  const serverUrl = useAuthStore((s) => s.serverUrl);
  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);
  const pushToast = useUiStore((s) => s.pushToast);

  // STRICT ZERO-FAKE INVARIANT: URL input starts empty until user enters a real destination URL
  const [headlessUrl, setHeadlessUrl] = useState('');
  const [activeHeadlessId, setActiveHeadlessId] = useState<string | null>(null);
  const [headlessFillValue, setHeadlessFillValue] = useState('');
  const [headlessBusy, setHeadlessBusy] = useState(false);

  const [activeInspectorTab, setActiveInspectorTab] = useState<InspectorTabId>('copilot');
  const [liveSnapshot, setLiveSnapshot] = useState<BrowserSnapshotDto | null>(null);
  const [testAction, setTestAction] = useState<BrowserActionKind>('snapshot');
  const [testSelector, setTestSelector] = useState('');
  const [testText, setTestText] = useState('');
  const [lastCommandSummary, setLastCommandSummary] = useState<string | null>(null);

  const [pairingBusy, setPairingBusy] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState(false);

  // Recorder & Distillation state
  const [stepKind, setStepKind] = useState<'navigate' | 'click' | 'fill'>('click');
  const [stepLocator, setStepLocator] = useState('');
  const [stepValue, setStepValue] = useState('');
  const [stepSecretVaultKey, setStepSecretVaultKey] = useState('');
  const [distillName, setDistillName] = useState('');
  const [distillCategory, setDistillCategory] = useState('productivity');
  const [distillError, setDistillError] = useState<string | null>(null);
  const [publishNotice, setPublishNotice] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  // App Store state
  const [storeQuery, setStoreQuery] = useState('');
  const [storeCategory, setStoreCategory] = useState('all');
  const [showManifestPublish, setShowManifestPublish] = useState(false);
  const [rawManifestJson, setRawManifestJson] = useState('');
  const [rawChangelog, setRawChangelog] = useState('');

  useEffect(() => {
    void loadBrowserControl().catch(() => undefined);
  }, [loadBrowserControl]);

  useEffect(() => {
    if (activeInspectorTab === 'app_store') {
      void Promise.allSettled([
        loadAutomationApps({ q: storeQuery.trim() || undefined, category: storeCategory }),
        loadInstalledAutomationApps(),
      ]);
    }
  }, [activeInspectorTab, storeQuery, storeCategory, loadAutomationApps, loadInstalledAutomationApps]);

  useEffect(() => {
    if (!activeHeadlessId && headlessSessions.length > 0) {
      setActiveHeadlessId(headlessSessions[0].session_id);
    }
  }, [headlessSessions, activeHeadlessId]);

  const activeHeadlessSession = useMemo(() => {
    if (!activeHeadlessId) return headlessSessions[0] ?? null;
    return headlessSessions.find((s) => s.session_id === activeHeadlessId) ?? headlessSessions[0] ?? null;
  }, [headlessSessions, activeHeadlessId]);

  const activeHeadlessSnapshot = activeHeadlessSession
    ? headlessSnapshots[activeHeadlessSession.session_id]
    : undefined;

  const activeHeadlessScreenshot = activeHeadlessSession
    ? headlessScreenshots[activeHeadlessSession.session_id]
    : undefined;

  const hasValidRasterScreenshot = Boolean(
    activeHeadlessScreenshot &&
      !activeHeadlessScreenshot.startsWith('data:image/svg+xml') &&
      (activeHeadlessScreenshot.startsWith('data:image/png') ||
        activeHeadlessScreenshot.startsWith('data:image/jpeg') ||
        activeHeadlessScreenshot.startsWith('blob:') ||
        activeHeadlessScreenshot.startsWith('http')),
  );

  const handleOpenHeadless = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const targetUrl = headlessUrl.trim();
    if (!targetUrl) {
      pushToast('Enter a URL to open in headless browser · 请输入网址', 'warning');
      return;
    }
    setHeadlessBusy(true);
    try {
      const session = await openHeadlessSession(targetUrl);
      setActiveHeadlessId(session.session_id);
      await captureHeadlessScreenshot(session.session_id).catch(() => undefined);
      pushToast(`Opened headless session on ${session.title || targetUrl}`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setHeadlessBusy(false);
    }
  };

  const handleRevokeControl = async () => {
    setRevokeBusy(true);
    try {
      const res = await revokeBrowserControl();
      pushToast(
        `Browser control revoked in ${res.elapsedMs}ms (Gen #${res.controlGeneration})`,
        'warning',
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setRevokeBusy(false);
    }
  };

  const handleCreatePair = async () => {
    setPairingBusy(true);
    try {
      await createPairingTicket('Fabushi Desktop Bridge', 300);
      pushToast('Generated desktop pairing ticket · 已生成桌面端配对码', 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setPairingBusy(false);
    }
  };

  const handleAddManualStep = () => {
    let action: RecordedActionKind;
    if (stepKind === 'navigate') {
      if (!stepValue.trim()) return;
      action = { kind: 'navigate', url: stepValue.trim() };
    } else if (stepKind === 'click') {
      if (!stepLocator.trim()) return;
      action = { kind: 'click', locator: { css_selector: stepLocator.trim() } };
    } else {
      if (!stepLocator.trim()) return;
      action = {
        kind: 'fill',
        locator: { css_selector: stepLocator.trim() },
        value: stepValue,
        is_secret: Boolean(stepSecretVaultKey.trim()),
        vault_key_hint: stepSecretVaultKey.trim() || null,
      };
    }
    recordBrowserAction(action, activeHeadlessSnapshot?.url);
    setStepLocator('');
    setStepValue('');
    setStepSecretVaultKey('');
  };

  const handleDistill = async () => {
    setDistillError(null);
    if (recordedBrowserTrace.length === 0) {
      setDistillError('Record at least one browser action before distilling · 请先录制至少一步操作');
      return;
    }
    try {
      await distillBrowserScript({
        name: distillName.trim() || 'Distilled Browser Automation',
        description: 'Compiled deterministic zero-LLM automation script',
        category: distillCategory,
      });
      pushToast('Distilled deterministic AutomationScriptApp manifest', 'success');
    } catch (err) {
      setDistillError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReplayDistilled = async () => {
    if (!distilledManifest) return;
    setDistillError(null);
    try {
      const report = await replayBrowserScript(
        distilledManifest,
        {},
        activeHeadlessSession?.session_id,
      );
      pushToast(
        `Replay finished (used_llm: ${String(report.used_llm)}, steps: ${report.steps_executed})`,
        report.success ? 'success' : 'warning',
      );
    } catch (err) {
      setDistillError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePublishManifest = async (manifest: Record<string, unknown>, changelog?: string) => {
    setPublishError(null);
    setPublishNotice(null);
    try {
      const detail = await publishAutomationApp({
        manifest,
        is_published: true,
        changelog: changelog?.trim() || undefined,
      });
      setPublishNotice(
        `Published ${detail.name} v${detail.latest_version} (SHA-256: ${detail.content_sha256})`,
      );
      pushToast(`Published "${detail.name}" to Automation App Store`, 'success');
    } catch (err) {
      const msg =
        err instanceof ApiRequestError
          ? `${err.status} ${err.errorCode}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setPublishError(msg);
      pushToast(msg, 'error');
    }
  };

  const handlePublishRawJson = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setPublishError(null);
    try {
      const parsed = JSON.parse(rawManifestJson) as Record<string, unknown>;
      await handlePublishManifest(parsed, rawChangelog);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Invalid JSON manifest');
    }
  };

  const displayedSnapshot = activeHeadlessSnapshot ?? liveSnapshot;
  const mcpRpcOrigin =
    serverUrl?.trim().replace(/\/+$/, '') ||
    (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:4173');

  const mcpSnippetJson = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            fabushi_browser: {
              url: pairingTicket?.mcp_rpc_url || `${mcpRpcOrigin}/api/v1/mcp/rpc`,
              headers: pairingTicket?.desktop_token
                ? { Authorization: `Bearer ${pairingTicket.desktop_token}` }
                : {},
            },
          },
        },
        null,
        2,
      ),
    [mcpRpcOrigin, pairingTicket],
  );

  return (
    <section id={DOM_IDS.BROWSER_WORKSPACE} className="tg-ai-workspace">
      {/* Top Toolbar */}
      <header className="tg-browser-toolbar">
        <strong style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>🌐</span>
          <span>Built-in Browser · 内置浏览器</span>
        </strong>

        <form onSubmit={(e) => void handleOpenHeadless(e)} className="tg-browser-url-form">
          <input
            id={DOM_IDS.BROWSER_HEADLESS_URL_INPUT}
            type="text"
            value={headlessUrl}
            onChange={(e) => setHeadlessUrl(e.target.value)}
            placeholder="https://example.com"
            aria-label="Browser URL"
          />
          <button
            id={DOM_IDS.BTN_BROWSER_HEADLESS_OPEN}
            type="submit"
            className="tg-btn tg-btn--primary"
            disabled={headlessBusy}
          >
            {headlessBusy ? 'Opening…' : 'Open · 打开'}
          </button>
        </form>

        <button
          id={DOM_IDS.BTN_BROWSER_REVOKE_CONTROL}
          type="button"
          className="tg-btn tg-btn--danger"
          disabled={revokeBusy}
          onClick={() => void handleRevokeControl()}
        >
          {revokeBusy ? 'Revoking…' : '🚨 Revoke Browser Control · 紧急吊销接管'}
        </button>

        <button
          type="button"
          className="tg-btn tg-btn--ghost"
          onClick={() => (onClose ? onClose() : setActiveNavDest('chats'))}
        >
          ← Chats · 返回
        </button>
      </header>

      {/* Un-clamped Revoke Latency Readout — Rendered ABOVE audit log so first latency token is always truthful */}
      {lastBrowserRevokeLatencyMs !== null && (
        <div
          role="status"
          data-testid="browser-revoke-banner"
          className="tg-kill-switch-banner"
          style={{ margin: '10px 16px 0' }}
        >
          <span>
            🛡️ Browser Control Revoked · 已紧急撤销浏览器控制权 — Measured round-trip:{' '}
            <strong>{lastBrowserRevokeLatencyMs}ms</strong>
          </span>
        </div>
      )}

      {/* BrowserControlMode Takeover Bar */}
      <div
        data-testid="browser-control-mode-bar"
        data-browser-control-mode={browserControlMode.mode}
        className="tg-browser-control-mode-bar"
      >
        <div className="tg-ai-row">
          <span className="tg-ai-badge tg-ai-badge--accent">
            Control Mode: {browserControlMode.mode}
          </span>
          <span className="tg-ai-badge">
            Connected Targets: {browserTargets.length}
          </span>
          {chromiumAvailable !== null && (
            <span
              className={`tg-ai-badge ${
                chromiumAvailable ? 'tg-ai-badge--success' : 'tg-ai-badge--warning'
              }`}
            >
              {chromiumAvailable ? 'Chromium CDP Ready' : 'Chromium CDP Unavailable'}
            </span>
          )}
        </div>

        <div className="tg-ai-row">
          <button
            type="button"
            className="tg-btn tg-btn--secondary"
            onClick={() => void setBrowserControlModeAction({ action: 'takeover' })}
          >
            Take Over · 接管
          </button>
          <button
            type="button"
            className="tg-btn tg-btn--secondary"
            onClick={() => void setBrowserControlModeAction({ action: 'resume' })}
          >
            Resume · 恢复
          </button>
          <button
            type="button"
            className="tg-btn tg-btn--ghost"
            onClick={() => void setBrowserControlModeAction({ action: 'cancel' })}
          >
            Cancel · 取消
          </button>
        </div>
      </div>

      {/* 2-Column Main Body */}
      <div className="tg-browser-body">
        {/* Left Column: Live CDP Headless Viewport, Semantic Snapshot, Permanent Audit Log */}
        <div className="tg-browser-main-col">
          {activeHeadlessSession ? (
            <section id={DOM_IDS.BROWSER_HEADLESS_VIEWPORT}>
              <div className="tg-ai-row tg-ai-row--between">
                <div>
                  <strong>{activeHeadlessSession.title || activeHeadlessSession.url}</strong>
                  <div className="tg-ai-workspace__subtitle">
                    Session: <code>{activeHeadlessSession.session_id}</code> · Backend:{' '}
                    <code>{activeHeadlessSession.backend}</code>
                  </div>
                </div>
                <div className="tg-ai-row">
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    onClick={() =>
                      void runHeadlessAction(activeHeadlessSession.session_id, {
                        action: 'snapshot',
                      })
                    }
                  >
                    ↻ Snapshot
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    onClick={() => void captureHeadlessScreenshot(activeHeadlessSession.session_id)}
                  >
                    📷 Screenshot
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--danger"
                    onClick={() => void closeHeadlessSession(activeHeadlessSession.session_id)}
                  >
                    Close
                  </button>
                </div>
              </div>

              {/* Visual Frame: Real non-SVG PNG/JPEG <img> OR Live HTML5 <canvas> */}
              <div className="tg-browser-frame-stage">
                {hasValidRasterScreenshot ? (
                  <img
                    src={activeHeadlessScreenshot}
                    alt={`CDP screenshot of ${activeHeadlessSession.url}`}
                  />
                ) : (
                  <SnapshotCanvasFrame snapshot={activeHeadlessSnapshot} />
                )}
              </div>

              {/* Interactive Refs from CDP Snapshot */}
              {activeHeadlessSnapshot && activeHeadlessSnapshot.elements.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="tg-ai-row">
                    <input
                      type="text"
                      value={headlessFillValue}
                      onChange={(e) => setHeadlessFillValue(e.target.value)}
                      placeholder="Value to fill into input element..."
                      style={{
                        flex: 1,
                        background: 'var(--tg-bg-input)',
                        color: 'var(--tg-text-primary)',
                        border: '1px solid var(--tg-border)',
                        borderRadius: 8,
                        padding: '6px 10px',
                        fontSize: 12,
                      }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {activeHeadlessSnapshot.elements.slice(0, 12).map((el) => (
                      <div key={el.ref} className="tg-ai-row" style={{ gap: 4 }}>
                        <button
                          type="button"
                          className="tg-btn tg-btn--ghost"
                          onClick={() =>
                            void runHeadlessAction(activeHeadlessSession.session_id, {
                              action: 'click',
                              ref: el.ref,
                            })
                          }
                        >
                          Click @{el.ref} ({el.text || el.tag})
                        </button>
                        {(el.tag === 'input' || el.tag === 'textarea') && (
                          <button
                            type="button"
                            className="tg-btn tg-btn--secondary"
                            onClick={() =>
                              void runHeadlessAction(activeHeadlessSession.session_id, {
                                action: 'fill',
                                ref: el.ref,
                                text: headlessFillValue,
                              })
                            }
                          >
                            Fill
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          ) : (
            <div className="tg-ai-card">
              <div className="tg-ai-empty">
                Enter a URL above and click Open to launch an isolated Chromium CDP browser session. · 输入网址并点击打开以启动隔离的 Chromium 浏览器会话。
              </div>
            </div>
          )}

          {/* Semantic DOM Snapshot View */}
          <section id={DOM_IDS.BROWSER_SNAPSHOT_VIEW} className="tg-ai-card">
            <div className="tg-ai-card__header">
              <h3 className="tg-ai-card__title">🧬 Semantic DOM Snapshot · 语义 DOM 快照</h3>
              <button
                type="button"
                className="tg-btn tg-btn--ghost"
                onClick={async () => {
                  const snap = browserControlAgent.captureSnapshot();
                  setLiveSnapshot(snap);
                }}
              >
                Capture Live DOM Snapshot
              </button>
            </div>
            {displayedSnapshot ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="tg-ai-workspace__subtitle">
                  <strong>{displayedSnapshot.title}</strong> · {displayedSnapshot.url} (
                  {displayedSnapshot.elements.length} refs)
                </div>
                {displayedSnapshot.text_excerpt && (
                  <pre className="tg-ai-code-block">{displayedSnapshot.text_excerpt}</pre>
                )}
                {displayedSnapshot.elements.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {displayedSnapshot.elements.slice(0, 16).map((el) => (
                      <span key={el.ref} className="tg-ai-badge">
                        @{el.ref} &lt;{el.tag}&gt; {el.text}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="tg-ai-empty">
                No DOM snapshot captured yet. · 尚未捕获语义 DOM 快照。
              </div>
            )}
          </section>

          {/* Permanently Visible Browser Audit Log (#browser-audit-log) */}
          <section id={DOM_IDS.BROWSER_AUDIT_LOG} className="tg-ai-card">
            <div className="tg-ai-card__header">
              <h3 className="tg-ai-card__title">
                📜 Browser Control Audit Log · 控制审计日志 ({browserAuditLogs.length})
              </h3>
              <button
                type="button"
                className="tg-btn tg-btn--ghost"
                onClick={() => void loadBrowserControl()}
              >
                ↻ Refresh
              </button>
            </div>
            {browserAuditLogs.length === 0 ? (
              <div className="tg-ai-empty">No browser control audit events yet · 暂无控制审计记录</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
                {browserAuditLogs.slice(0, 25).map((entry) => (
                  <div
                    key={entry.audit_id}
                    className="tg-ai-row tg-ai-row--between"
                    style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--tg-border-subtle)' }}
                  >
                    <span>
                      <strong>{entry.action}</strong> ({entry.status}) — {entry.summary}
                    </span>
                    <span className="tg-ai-workspace__subtitle">
                      {new Date(entry.timestamp_ms).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right Column: 4-Tab Inspector (#browser-inspector-tabs) */}
        <aside className="tg-browser-inspector-col">
          <div
            id={DOM_IDS.BROWSER_INSPECTOR_TABS}
            role="tablist"
            aria-label="Browser Inspector Tabs"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeInspectorTab === 'copilot'}
              className={`tg-browser-inspector-tab ${
                activeInspectorTab === 'copilot' ? 'tg-browser-inspector-tab--active' : ''
              }`}
              onClick={() => setActiveInspectorTab('copilot')}
            >
              🤖 Copilot · 副驾助手
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeInspectorTab === 'recorder'}
              className={`tg-browser-inspector-tab ${
                activeInspectorTab === 'recorder' ? 'tg-browser-inspector-tab--active' : ''
              }`}
              onClick={() => setActiveInspectorTab('recorder')}
            >
              ⏺️ Recorder · 脚本录制
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeInspectorTab === 'session'}
              className={`tg-browser-inspector-tab ${
                activeInspectorTab === 'session' ? 'tg-browser-inspector-tab--active' : ''
              }`}
              onClick={() => setActiveInspectorTab('session')}
            >
              🔗 Session · 会话与配对
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeInspectorTab === 'app_store'}
              className={`tg-browser-inspector-tab ${
                activeInspectorTab === 'app_store' ? 'tg-browser-inspector-tab--active' : ''
              }`}
              onClick={() => setActiveInspectorTab('app_store')}
            >
              🧩 App Store · 应用商店
            </button>
          </div>

          {/* Tab 1: Copilot */}
          {activeInspectorTab === 'copilot' && (
            <section className="tg-ai-card">
              <h3 className="tg-ai-card__title">🤖 Browser AI Copilot · 浏览器副驾</h3>
              <div className="tg-ai-row">
                <span className="tg-ai-badge">Connected Targets: {browserTargets.length}</span>
                <span className="tg-ai-badge tg-ai-badge--info">
                  Headless Sessions: {headlessSessions.length}
                </span>
              </div>

              <div className="tg-ai-field-grid">
                <label className="tg-ai-field">
                  <span>Action · 操作</span>
                  <select
                    value={testAction}
                    onChange={(e) => setTestAction(e.target.value as BrowserActionKind)}
                  >
                    <option value="snapshot">snapshot</option>
                    <option value="click">click</option>
                    <option value="fill">fill</option>
                    <option value="press">press</option>
                    <option value="scroll">scroll</option>
                  </select>
                </label>
                <label className="tg-ai-field">
                  <span>Ref / CSS Selector</span>
                  <input
                    type="text"
                    value={testSelector}
                    onChange={(e) => setTestSelector(e.target.value)}
                    placeholder="@e1 or button.primary"
                  />
                </label>
                <label className="tg-ai-field">
                  <span>Text / Key</span>
                  <input
                    type="text"
                    value={testText}
                    onChange={(e) => setTestText(e.target.value)}
                    placeholder="Optional value"
                  />
                </label>
              </div>

              <button
                type="button"
                className="tg-btn tg-btn--primary"
                onClick={async () => {
                  const res = await runLocalBrowserCommand({
                    action: testAction,
                    ref: testSelector.startsWith('@') ? testSelector : undefined,
                    selector: !testSelector.startsWith('@') ? testSelector || undefined : undefined,
                    text: testText || undefined,
                  });
                  setLastCommandSummary(JSON.stringify(res, null, 2));
                }}
              >
                ▶ Run Local Inspection Command
              </button>

              {lastCommandSummary && <pre className="tg-ai-code-block">{lastCommandSummary}</pre>}
            </section>
          )}

          {/* Tab 2: Recorder & Script Distillation */}
          {activeInspectorTab === 'recorder' && (
            <section className="tg-ai-card">
              <div className="tg-ai-card__header">
                <h3 className="tg-ai-card__title">
                  ⏺️ Script Distillation & Zero-LLM Replay ({recordedBrowserTrace.length} steps)
                </h3>
                <button
                  type="button"
                  className="tg-btn tg-btn--ghost"
                  onClick={clearRecordedBrowserTrace}
                >
                  Clear · 清空
                </button>
              </div>

              <div className="tg-ai-field-grid">
                <label className="tg-ai-field">
                  <span>Step Kind</span>
                  <select
                    value={stepKind}
                    onChange={(e) => setStepKind(e.target.value as 'navigate' | 'click' | 'fill')}
                  >
                    <option value="navigate">navigate</option>
                    <option value="click">click</option>
                    <option value="fill">fill</option>
                  </select>
                </label>
                {stepKind !== 'navigate' && (
                  <label className="tg-ai-field">
                    <span>CSS Locator</span>
                    <input
                      type="text"
                      value={stepLocator}
                      onChange={(e) => setStepLocator(e.target.value)}
                      placeholder='input[name="email"]'
                    />
                  </label>
                )}
                {stepKind !== 'click' && (
                  <label className="tg-ai-field">
                    <span>{stepKind === 'navigate' ? 'URL' : 'Value'}</span>
                    <input
                      type="text"
                      value={stepValue}
                      onChange={(e) => setStepValue(e.target.value)}
                      placeholder={stepKind === 'navigate' ? 'https://example.com' : 'Sample input'}
                    />
                  </label>
                )}
                {stepKind === 'fill' && (
                  <label className="tg-ai-field">
                    <span>Vault Secret Key Hint (scrubbed)</span>
                    <input
                      type="text"
                      value={stepSecretVaultKey}
                      onChange={(e) => setStepSecretVaultKey(e.target.value)}
                      placeholder="portal_password"
                    />
                  </label>
                )}
              </div>

              <button type="button" className="tg-btn tg-btn--secondary" onClick={handleAddManualStep}>
                + Record Step · 添加步骤
              </button>

              {recordedBrowserTrace.length > 0 && (
                <pre className="tg-ai-code-block" style={{ maxHeight: 140 }}>
                  {recordedBrowserTrace
                    .map((a) => `#${a.seq} ${a.action.kind}`)
                    .join('\n')}
                </pre>
              )}

              <div className="tg-ai-field-grid">
                <label className="tg-ai-field">
                  <span>Script App Name · 脚本应用名称</span>
                  <input
                    type="text"
                    value={distillName}
                    onChange={(e) => setDistillName(e.target.value)}
                    placeholder="Invoice Exporter Workflow"
                  />
                </label>
                <label className="tg-ai-field">
                  <span>Category · 分类</span>
                  <select
                    value={distillCategory}
                    onChange={(e) => setDistillCategory(e.target.value)}
                  >
                    <option value="productivity">productivity</option>
                    <option value="devtools">devtools</option>
                    <option value="finance">finance</option>
                    <option value="data">data</option>
                  </select>
                </label>
              </div>

              <div className="tg-ai-row">
                <button type="button" className="tg-btn tg-btn--primary" onClick={() => void handleDistill()}>
                  ⚗️ Distill Script · 蒸馏脚本
                </button>
                {distilledManifest && (
                  <>
                    <button
                      type="button"
                      className="tg-btn tg-btn--secondary"
                      onClick={() => void handleReplayDistilled()}
                    >
                      ▶ Replay (Zero-LLM) · 无模型回放
                    </button>
                    <button
                      type="button"
                      className="tg-btn tg-btn--secondary"
                      onClick={() =>
                        void handlePublishManifest(
                          distilledManifest as unknown as Record<string, unknown>,
                        )
                      }
                    >
                      🚀 Publish to App Store · 发布至商店
                    </button>
                  </>
                )}
              </div>

              {distillError && (
                <div role="alert" className="tg-secret-leak-alert">
                  {distillError}
                </div>
              )}
              {publishError && (
                <div role="alert" className="tg-secret-leak-alert">
                  {publishError}
                </div>
              )}
              {publishNotice && (
                <div className="tg-ai-badge tg-ai-badge--success">{publishNotice}</div>
              )}

              {distilledManifest && (
                <pre className="tg-ai-code-block" style={{ maxHeight: 180 }}>
                  {JSON.stringify(distilledManifest, null, 2)}
                </pre>
              )}

              {lastScriptReplayReport && (
                <div className="tg-ai-card tg-ai-card--elevated">
                  <strong>
                    Replay Report: {lastScriptReplayReport.success ? 'SUCCESS' : 'FAILED'}
                  </strong>
                  <div className="tg-ai-workspace__subtitle">
                    used_llm: {String(lastScriptReplayReport.used_llm)} · steps_executed:{' '}
                    {lastScriptReplayReport.steps_executed} · duration:{' '}
                    {lastScriptReplayReport.total_duration_ms}ms
                  </div>
                </div>
              )}
            </section>
          )}

          {/* Tab 3: Session & Desktop Pairing */}
          {activeInspectorTab === 'session' && (
            <section id={DOM_IDS.BROWSER_CONTROL_WORKSPACE} className="tg-ai-card">
              <div className="tg-ai-card__header">
                <h3 className="tg-ai-card__title">🔗 Desktop Pairing & Bridge · 桌面配对与桥接</h3>
                <button
                  id={DOM_IDS.BTN_BROWSER_PAIR_DESKTOP}
                  type="button"
                  className="tg-btn tg-btn--primary"
                  disabled={pairingBusy}
                  onClick={() => void handleCreatePair()}
                >
                  {pairingBusy ? 'Creating…' : '+ Pair Desktop · 生成配对码'}
                </button>
              </div>

              <label className="tg-settings-switch-row" style={{ cursor: 'pointer' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    Register This Tab for Remote Control · 显式注册当前标签页
                  </div>
                  <div className="tg-ai-workspace__subtitle">
                    Off by default (0 initial targets) — opt-in explicitly to expose this tab
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={localBridgeState.allowDesktopControl}
                  onChange={(e) => setAllowDesktopControl(e.target.checked)}
                />
              </label>

              {pairingTicket && (
                <div
                  id={DOM_IDS.BROWSER_PAIRING_CODE_DISPLAY}
                  className="tg-ai-card tg-ai-card--elevated"
                >
                  <div className="tg-ai-workspace__subtitle">Pairing Code · 配对码</div>
                  <strong style={{ fontFamily: 'var(--tg-font-mono)', fontSize: 18 }}>
                    {pairingTicket.pair_code}
                  </strong>
                  <div className="tg-ai-workspace__subtitle">
                    Expires: {new Date(pairingTicket.expires_at_ms).toLocaleTimeString()}
                  </div>
                </div>
              )}

              <div>
                <div className="tg-ai-workspace__subtitle" style={{ marginBottom: 4 }}>
                  MCP Bridge JSON Config
                </div>
                <pre className="tg-ai-code-block">{mcpSnippetJson}</pre>
              </div>
            </section>
          )}

          {/* Tab 4: Automation Script App Store (#automation-app-store-panel) */}
          {activeInspectorTab === 'app_store' && (
            <section id={DOM_IDS.AUTOMATION_APP_STORE_PANEL} className="tg-ai-card">
              <div className="tg-ai-card__header">
                <h3 className="tg-ai-card__title">
                  🧩 Automation Script App Store · 自动化脚本商店 ({automationApps.length})
                </h3>
                <button
                  type="button"
                  className="tg-btn tg-btn--secondary"
                  onClick={() => setShowManifestPublish((v) => !v)}
                >
                  {showManifestPublish ? 'Hide Form' : '+ Publish Manifest JSON · 发布脚本应用'}
                </button>
              </div>

              <div className="tg-ai-field-grid">
                <label className="tg-ai-field">
                  <span>Search · 搜索应用</span>
                  <input
                    type="text"
                    value={storeQuery}
                    onChange={(e) => setStoreQuery(e.target.value)}
                    placeholder="Search automation apps..."
                  />
                </label>
                <label className="tg-ai-field">
                  <span>Category · 分类</span>
                  <select
                    value={storeCategory}
                    onChange={(e) => setStoreCategory(e.target.value)}
                  >
                    <option value="all">All Categories</option>
                    <option value="productivity">productivity</option>
                    <option value="devtools">devtools</option>
                    <option value="finance">finance</option>
                    <option value="data">data</option>
                  </select>
                </label>
              </div>

              {showManifestPublish && (
                <form
                  onSubmit={(e) => void handlePublishRawJson(e)}
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <label className="tg-ai-field">
                    <span>Manifest JSON (checked by 422 secret_leak_detected scanner)</span>
                    <textarea
                      rows={5}
                      value={rawManifestJson}
                      onChange={(e) => setRawManifestJson(e.target.value)}
                      placeholder='{"schema_version":1,"app_id":"my_app","slug":"my_app","name":"My App","version":"1.0.0","description":"...","category":"devtools","target_domains":["example.com"],"parameters":[],"steps":[],"required_capabilities":[]}'
                      required
                    />
                  </label>
                  <label className="tg-ai-field">
                    <span>Changelog · 更新说明</span>
                    <input
                      type="text"
                      value={rawChangelog}
                      onChange={(e) => setRawChangelog(e.target.value)}
                      placeholder="Initial deterministic release"
                    />
                  </label>
                  <button type="submit" className="tg-btn tg-btn--primary">
                    Publish · 发布
                  </button>
                </form>
              )}

              {publishError && (
                <div role="alert" className="tg-secret-leak-alert">
                  {publishError}
                </div>
              )}
              {publishNotice && (
                <div className="tg-ai-badge tg-ai-badge--success">{publishNotice}</div>
              )}

              {automationApps.length === 0 ? (
                <div className="tg-ai-empty">
                  No automation script apps published yet. Distill a recording or publish a secret-free manifest above. · 暂无已发布的自动化脚本应用。
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {automationApps.map((app) => (
                    <article key={app.app_id} className="tg-ai-card tg-ai-card--elevated">
                      <div className="tg-ai-row tg-ai-row--between">
                        <strong>{app.name}</strong>
                        <span className="tg-ai-badge tg-ai-badge--accent">
                          v{app.latest_version} · {app.category}
                        </span>
                      </div>
                      <div className="tg-ai-workspace__subtitle">{app.description}</div>
                      <div className="tg-ai-row">
                        <span className="tg-ai-badge">Steps: {app.step_count}</span>
                        <span className="tg-ai-badge">Installs: {app.install_count}</span>
                        <span className="tg-ai-badge">Runs: {app.run_count}</span>
                      </div>
                      <div className="tg-ai-row">
                        {app.is_installed ? (
                          <button
                            type="button"
                            className="tg-btn tg-btn--ghost"
                            onClick={() => void uninstallAutomationApp(app.app_id)}
                          >
                            Uninstall · 卸载
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="tg-btn tg-btn--primary"
                            onClick={() => void installAutomationApp(app.app_id)}
                          >
                            Install · 安装
                          </button>
                        )}
                        <button
                          type="button"
                          className="tg-btn tg-btn--secondary"
                          onClick={async () => {
                            try {
                              await recordAutomationRun(app.app_id, {
                                version: app.latest_version,
                                success: true,
                                steps_executed: app.step_count,
                                total_duration_ms: 0,
                                used_llm: false,
                              });
                              pushToast(`Recorded zero-LLM run for ${app.name}`, 'success');
                            } catch (err) {
                              pushToast(err instanceof Error ? err.message : String(err), 'error');
                            }
                          }}
                        >
                          ▶ Run (Zero-LLM) · 运行
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}

              {installedAutomationApps.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <strong style={{ fontSize: 12 }}>
                    Installed Apps ({installedAutomationApps.length})
                  </strong>
                  {installedAutomationApps.map((inst) => (
                    <div
                      key={inst.app_id}
                      className="tg-ai-row tg-ai-row--between"
                      style={{ fontSize: 12 }}
                    >
                      <span>
                        {inst.name} (v{inst.installed_version})
                      </span>
                      <span className="tg-ai-workspace__subtitle">
                        Local runs: {inst.local_run_count}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </aside>
      </div>
    </section>
  );
}
