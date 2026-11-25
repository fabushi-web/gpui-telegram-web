import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DOM_IDS,
  type ComputerNodeDto,
  type ComputerRunPolicy,
  type RemoteControlMode,
} from '@gpui-telegram/protocol';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useUiStore } from '../../store/useUiStore';

export interface ComputerWorkbenchProps {
  onClose?: () => void;
}

function formatAssistId(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 9) return raw;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 9)}`;
}

const RUN_POLICY_OPTIONS: Array<{ value: ComputerRunPolicy; label: string }> = [
  { value: 'ask_every_time', label: 'Ask Every Time · 每次确认' },
  { value: 'allow_read_only', label: 'Allow Read-Only · 仅允许只读操作' },
  { value: 'always_allow_authorized', label: 'Always Allow Authorized · 信任已授权控制器' },
  { value: 'disabled', label: 'Disabled · 禁止远程执行' },
];

export function ComputerWorkbench({ onClose }: ComputerWorkbenchProps = {}): React.JSX.Element {
  const computers = useAiWorkspaceStore((s) => s.computers);
  const computerApprovals = useAiWorkspaceStore((s) => s.computerApprovals);
  const tailnet = useAiWorkspaceStore((s) => s.tailnet);
  const remoteAssistInfo = useAiWorkspaceStore((s) => s.remoteAssistInfo);
  const remoteSessions = useAiWorkspaceStore((s) => s.remoteSessions);
  const computerFrames = useAiWorkspaceStore((s) => s.computerFrames);
  const lastKillSwitchLatencyMs = useAiWorkspaceStore((s) => s.lastKillSwitchLatencyMs);

  const loadComputers = useAiWorkspaceStore((s) => s.loadComputers);
  const loadRemoteAssist = useAiWorkspaceStore((s) => s.loadRemoteAssist);
  const resetRemoteAssistCode = useAiWorkspaceStore((s) => s.resetRemoteAssistCode);
  const setRemoteAssistCode = useAiWorkspaceStore((s) => s.setRemoteAssistCode);
  const setAllowRemoteAssist = useAiWorkspaceStore((s) => s.setAllowRemoteAssist);
  const startRemoteAssist = useAiWorkspaceStore((s) => s.startRemoteAssist);
  const disconnectRemoteSession = useAiWorkspaceStore((s) => s.disconnectRemoteSession);
  const loadComputerFrame = useAiWorkspaceStore((s) => s.loadComputerFrame);
  const createCloudComputer = useAiWorkspaceStore((s) => s.createCloudComputer);
  const testComputerConnection = useAiWorkspaceStore((s) => s.testComputerConnection);
  const deleteComputer = useAiWorkspaceStore((s) => s.deleteComputer);
  const runComputerOp = useAiWorkspaceStore((s) => s.runComputerOp);
  const decideComputerApproval = useAiWorkspaceStore((s) => s.decideComputerApproval);
  const setComputerPolicy = useAiWorkspaceStore((s) => s.setComputerPolicy);
  const emergencyTakeover = useAiWorkspaceStore((s) => s.emergencyTakeover);

  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);
  const pushToast = useUiStore((s) => s.pushToast);

  const [selectedNodeId, setSelectedNodeId] = useState<string>('');
  const [killSwitchBusy, setKillSwitchBusy] = useState(false);
  const [lastKillDisconnectedCount, setLastKillDisconnectedCount] = useState<number>(0);

  // Remote Assist forms
  const [customCodeInput, setCustomCodeInput] = useState('');
  const [assistError, setAssistError] = useState<string | null>(null);
  const [guestAssistId, setGuestAssistId] = useState('');
  const [guestAccessCode, setGuestAccessCode] = useState('');
  const [guestMode, setGuestMode] = useState<RemoteControlMode>('desktop');
  const [guestSessionResult, setGuestSessionResult] = useState<string | null>(null);

  // Cloud SSH host form
  const [showCloudForm, setShowCloudForm] = useState(false);
  const [cloudName, setCloudName] = useState('');
  const [cloudHost, setCloudHost] = useState('');
  const [cloudPort, setCloudPort] = useState('22');
  const [cloudUser, setCloudUser] = useState('');
  const [cloudSecret, setCloudSecret] = useState('');

  // Real RemoteComputerOp runner
  const [shellCmd, setShellCmd] = useState('');
  const [lastOpOutput, setLastOpOutput] = useState<string | null>(null);

  useEffect(() => {
    void Promise.allSettled([loadComputers(), loadRemoteAssist()]);
  }, [loadComputers, loadRemoteAssist]);

  useEffect(() => {
    if (!selectedNodeId && computers.length > 0) {
      setSelectedNodeId(computers[0].node_id);
    }
  }, [computers, selectedNodeId]);

  const activeNode: ComputerNodeDto | null = useMemo(() => {
    if (computers.length === 0) return null;
    return computers.find((c) => c.node_id === selectedNodeId) ?? computers[0];
  }, [computers, selectedNodeId]);

  useEffect(() => {
    if (activeNode) {
      void loadComputerFrame(activeNode.node_id).catch(() => undefined);
    }
  }, [activeNode?.node_id, loadComputerFrame]);

  const handleEmergencyKillSwitch = useCallback(async () => {
    setKillSwitchBusy(true);
    try {
      const res = await emergencyTakeover(activeNode?.node_id);
      setLastKillDisconnectedCount(res.disconnectedCount);
      pushToast(
        `Emergency Kill Switch disconnected ${res.disconnectedCount} session(s) in ${res.latencyMs}ms`,
        'warning',
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setKillSwitchBusy(false);
    }
  }, [activeNode?.node_id, emergencyTakeover, pushToast]);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        void handleEmergencyKillSwitch();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleEmergencyKillSwitch]);

  const handleToggleAllowAssist = async () => {
    if (!remoteAssistInfo) return;
    setAssistError(null);
    try {
      const next = await setAllowRemoteAssist(!remoteAssistInfo.allow_assist);
      pushToast(
        next.allow_assist
          ? 'Remote Assist enabled · 已开启远程协助'
          : 'Remote Assist disabled & guest sessions disconnected · 已关闭远程协助',
        'info',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAssistError(msg);
      pushToast(msg, 'error');
    }
  };

  const handleResetTempCode = async () => {
    setAssistError(null);
    try {
      await resetRemoteAssistCode();
      pushToast('Generated fresh temporary access code · 已刷新临时验证码', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAssistError(msg);
      pushToast(msg, 'error');
    }
  };

  const handleSetCustomCode = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setAssistError(null);
    try {
      await setRemoteAssistCode(customCodeInput.trim());
      setCustomCodeInput('');
      pushToast('Custom access code saved (masked at rest) · 自定义验证码已保存', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAssistError(msg);
      pushToast(msg, 'error');
    }
  };

  const handleStartGuestAssist = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setAssistError(null);
    setGuestSessionResult(null);
    try {
      const res = await startRemoteAssist({
        assist_id: guestAssistId.replace(/\D/g, ''),
        access_code: guestAccessCode.trim(),
        mode: guestMode,
        requester_platform: 'web',
      });
      setGuestSessionResult(
        `Connected session ${res.session_id} → target ${res.target_node_id} (relay token issued)`,
      );
      setGuestAccessCode('');
      pushToast(`Connected to Assist ID ${guestAssistId}`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAssistError(msg);
      pushToast(msg, 'error');
    }
  };

  const handleAddCloudHost = async (ev: React.FormEvent) => {
    ev.preventDefault();
    try {
      const created = await createCloudComputer({
        display_name: cloudName.trim(),
        host: cloudHost.trim(),
        port: Number(cloudPort) || 22,
        ssh_user: cloudUser.trim(),
        secret: cloudSecret || undefined,
      });
      setSelectedNodeId(created.node_id);
      setCloudName('');
      setCloudHost('');
      setCloudUser('');
      setCloudSecret('');
      setShowCloudForm(false);
      pushToast(`Added cloud host "${created.display_name}"`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleRunRemoteOp = async (operation: Record<string, unknown>) => {
    if (!activeNode) return;
    try {
      const res = await runComputerOp(activeNode.node_id, operation, 'Fabushi Web Operator');
      setLastOpOutput(JSON.stringify(res, null, 2));
      pushToast(`Executed ${String(operation.op ?? 'op')} on ${activeNode.display_name}`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastOpOutput(`Error: ${msg}`);
      pushToast(msg, 'error');
    }
  };

  const activeFrameUrl = activeNode ? (computerFrames[activeNode.node_id] ?? null) : null;

  // Truthful Tailnet peers (strictly filter out disconnected / empty-IP self entries)
  const validTailnetPeers = useMemo(() => {
    if (!tailnet || !tailnet.connected) return [];
    const list = Array.isArray(tailnet.peers) ? tailnet.peers.filter((p) => Boolean(p.ipv4)) : [];
    if (tailnet.self_peer && tailnet.self_peer.online && tailnet.self_peer.ipv4) {
      if (!list.some((p) => p.device_id === tailnet.self_peer?.device_id)) {
        return [tailnet.self_peer, ...list];
      }
    }
    return list;
  }, [tailnet]);

  return (
    <section id={DOM_IDS.COMPUTER_WORKBENCH} className="tg-ai-workspace">
      <header className="tg-ai-workspace__header">
        <div className="tg-ai-workspace__title-group">
          <h2 className="tg-ai-workspace__title">
            🖥️ Remote Assist & Computer Workbench · 远程协助与电脑工作台
          </h2>
          <span className="tg-ai-workspace__subtitle">
            Fabushi Desktop / 法布施桌面端 UU-Parity Remote Assist, Real Host Control & Emergency Kill Switch
          </span>
        </div>
        <div className="tg-ai-workspace__actions">
          <button
            id={DOM_IDS.BTN_COMPUTER_TAKEOVER}
            type="button"
            className="tg-btn tg-btn--danger"
            disabled={killSwitchBusy}
            onClick={() => void handleEmergencyKillSwitch()}
          >
            {killSwitchBusy
              ? 'Disconnecting…'
              : '🚨 Disconnect All & Take Over (Esc) · 一键紧急断开与接管'}
          </button>
          <button
            type="button"
            className="tg-btn tg-btn--ghost"
            onClick={() => void Promise.allSettled([loadComputers(), loadRemoteAssist()])}
          >
            ↻ Refresh · 刷新
          </button>
          <button
            type="button"
            className="tg-btn tg-btn--ghost"
            onClick={() => (onClose ? onClose() : setActiveNavDest('chats'))}
          >
            ← Chats · 返回
          </button>
        </div>
      </header>

      <div className="tg-ai-workspace__body">
        {/* Un-clamped Kill Switch Latency Banner — ALWAYS visible once triggered even with 0 nodes */}
        {lastKillSwitchLatencyMs !== null && (
          <div
            role="status"
            data-testid="computer-takeover-banner"
            className="tg-kill-switch-banner"
          >
            <span>
              🛡️ Emergency Kill Switch Completed · 紧急断开已完成 — Measured round-trip:{' '}
              <strong>{lastKillSwitchLatencyMs}ms</strong> ({lastKillDisconnectedCount} session(s)
              terminated)
            </span>
          </div>
        )}

        {/* Active Remote Control Warning Banner */}
        {remoteSessions.length > 0 && (
          <div role="alert" className="tg-provider-error-card">
            <div className="tg-provider-error-title">
              🔴 本机被控中 · Active Remote Control Sessions ({remoteSessions.length})
            </div>
            <div className="tg-provider-error-body">
              One or more remote controllers are actively connected. Use Disconnect All above to terminate immediately.
            </div>
          </div>
        )}

        {/* UU-Parity Remote Assist Panel (#remote-assist-panel) */}
        <section id={DOM_IDS.REMOTE_ASSIST_PANEL} className="tg-ai-card">
          <div className="tg-ai-card__header">
            <h3 className="tg-ai-card__title">🔗 UU-Parity Remote Assist · 远程协助码</h3>
            {remoteAssistInfo && (
              <div className="tg-ai-row">
                <span style={{ fontSize: 12, color: 'var(--tg-text-secondary)' }}>
                  Allow Remote Assist · 允许远程协助
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={remoteAssistInfo.allow_assist}
                  aria-label="Allow Remote Assist"
                  className="tg-settings-switch"
                  onClick={() => void handleToggleAllowAssist()}
                />
              </div>
            )}
          </div>

          {assistError && (
            <div role="alert" className="tg-secret-leak-alert">
              {assistError}
            </div>
          )}

          <div className="tg-ai-grid">
            {/* Host Identity & Access Code */}
            <div className="tg-ai-card tg-ai-card--elevated">
              <span className="tg-ai-workspace__subtitle">
                Permanent 9-Digit Assist ID · 本机永久协助识别码
              </span>
              <div className="tg-ai-row tg-ai-row--between">
                <span
                  className="tg-assist-id-code"
                  data-assist-id={remoteAssistInfo?.assist_id ?? ''}
                >
                  {remoteAssistInfo ? formatAssistId(remoteAssistInfo.assist_id) : 'Loading…'}
                </span>
                {remoteAssistInfo && (
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    onClick={() => {
                      void navigator.clipboard
                        ?.writeText(remoteAssistInfo.assist_id)
                        .catch(() => undefined);
                      pushToast(`Copied Assist ID ${remoteAssistInfo.assist_id}`, 'success');
                    }}
                  >
                    Copy ID · 复制
                  </button>
                )}
              </div>

              <div className="tg-ai-row tg-ai-row--between" style={{ marginTop: 6 }}>
                <div>
                  <span className="tg-ai-workspace__subtitle">
                    Access Code ({remoteAssistInfo?.code_mode ?? 'temporary'}) · 验证码
                  </span>
                  <div style={{ fontFamily: 'var(--tg-font-mono)', fontSize: 16, fontWeight: 700 }}>
                    {remoteAssistInfo?.code_mode === 'custom'
                      ? '•••••••• (Custom · 自定义)'
                      : remoteAssistInfo?.current_code || '—'}
                  </div>
                </div>
                <button
                  type="button"
                  className="tg-btn tg-btn--secondary"
                  onClick={() => void handleResetTempCode()}
                >
                  ↻ Reset Temp Code · 刷新临时码
                </button>
              </div>

              <form
                onSubmit={(e) => void handleSetCustomCode(e)}
                className="tg-ai-row"
                style={{ marginTop: 8 }}
              >
                <input
                  type="text"
                  value={customCodeInput}
                  onChange={(e) => setCustomCodeInput(e.target.value)}
                  placeholder="Custom 8–16 alphanumeric code (letters + digits)"
                  style={{
                    flex: 1,
                    background: 'var(--tg-bg-input)',
                    color: 'var(--tg-text-primary)',
                    border: '1px solid var(--tg-border)',
                    borderRadius: 8,
                    padding: '7px 10px',
                    fontSize: 12,
                  }}
                />
                <button type="submit" className="tg-btn tg-btn--secondary">
                  Set Custom Code · 设为固定码
                </button>
              </form>
            </div>

            {/* Guest Connect Form */}
            <form
              onSubmit={(e) => void handleStartGuestAssist(e)}
              className="tg-ai-card tg-ai-card--elevated"
            >
              <strong style={{ fontSize: 13 }}>
                🚀 Connect to Remote Device (Guest) · 协助他人设备
              </strong>
              <label className="tg-ai-field">
                <span>Target 9-Digit Assist ID · 对方协助识别码</span>
                <input
                  type="text"
                  value={guestAssistId}
                  onChange={(e) => setGuestAssistId(e.target.value)}
                  placeholder="123 456 789"
                  required
                />
              </label>
              <label className="tg-ai-field">
                <span>Access Code · 验证码</span>
                <input
                  type="password"
                  value={guestAccessCode}
                  onChange={(e) => setGuestAccessCode(e.target.value)}
                  placeholder="Temporary or custom code"
                  required
                />
              </label>
              <label className="tg-ai-field">
                <span>Control Mode · 控制模式</span>
                <select
                  value={guestMode}
                  onChange={(e) => setGuestMode(e.target.value as RemoteControlMode)}
                >
                  <option value="desktop">Desktop · 桌面控制</option>
                  <option value="terminal">Terminal · 终端控制</option>
                  <option value="file_transfer">File Transfer · 文件传输</option>
                  <option value="ai_control">AI Control · 智能体接管</option>
                </select>
              </label>
              <button type="submit" className="tg-btn tg-btn--primary">
                Connect · 发起协助
              </button>
              {guestSessionResult && (
                <div className="tg-ai-badge tg-ai-badge--success">{guestSessionResult}</div>
              )}
            </form>
          </div>

          {/* Active Remote Sessions */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="tg-ai-row tg-ai-row--between">
              <strong style={{ fontSize: 13 }}>
                Active Remote Sessions · 活跃远程会话 ({remoteSessions.length})
              </strong>
              {remoteSessions.length > 0 && (
                <button
                  type="button"
                  className="tg-btn tg-btn--danger"
                  onClick={() => void handleEmergencyKillSwitch()}
                >
                  Disconnect All · 全部断开
                </button>
              )}
            </div>

            {remoteSessions.length === 0 ? (
              <div className="tg-ai-empty">
                No active remote control sessions. · 当前无活跃远程控制会话。
              </div>
            ) : (
              <div className="tg-ai-grid">
                {remoteSessions.map((sess) => (
                  <div key={sess.session_id} className="tg-ai-card tg-ai-card--elevated">
                    <div className="tg-ai-row tg-ai-row--between">
                      <strong>{sess.controller_name}</strong>
                      <span className="tg-ai-badge tg-ai-badge--warning">
                        {sess.controller_kind} · {sess.mode}
                      </span>
                    </div>
                    <div className="tg-ai-workspace__subtitle">
                      Session: <code>{sess.session_id}</code> · Relay: {sess.relay_mode}
                    </div>
                    <button
                      type="button"
                      className="tg-btn tg-btn--danger"
                      onClick={() => void disconnectRemoteSession(sess.session_id)}
                    >
                      Disconnect · 断开
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Connected Computers & Real Screen Frame Viewer (ZERO fake canvas!) */}
        <section className="tg-ai-card">
          <div className="tg-ai-card__header">
            <h3 className="tg-ai-card__title">
              💻 Connected Computers · 已连接电脑 ({computers.length})
            </h3>
            <button
              type="button"
              className="tg-btn tg-btn--secondary"
              onClick={() => setShowCloudForm((v) => !v)}
            >
              {showCloudForm ? 'Hide Form' : '+ Bind Cloud SSH Host · 绑定云主机'}
            </button>
          </div>

          {showCloudForm && (
            <form onSubmit={(e) => void handleAddCloudHost(e)} className="tg-ai-field-grid">
              <label className="tg-ai-field">
                <span>Display Name</span>
                <input
                  type="text"
                  value={cloudName}
                  onChange={(e) => setCloudName(e.target.value)}
                  placeholder="Production Linux Box"
                  required
                />
              </label>
              <label className="tg-ai-field">
                <span>Host / IP</span>
                <input
                  type="text"
                  value={cloudHost}
                  onChange={(e) => setCloudHost(e.target.value)}
                  placeholder="203.0.113.10"
                  required
                />
              </label>
              <label className="tg-ai-field">
                <span>Port</span>
                <input
                  type="number"
                  value={cloudPort}
                  onChange={(e) => setCloudPort(e.target.value)}
                />
              </label>
              <label className="tg-ai-field">
                <span>SSH User</span>
                <input
                  type="text"
                  value={cloudUser}
                  onChange={(e) => setCloudUser(e.target.value)}
                  placeholder="ubuntu"
                  required
                />
              </label>
              <label className="tg-ai-field">
                <span>Password / Key Secret</span>
                <input
                  type="password"
                  value={cloudSecret}
                  onChange={(e) => setCloudSecret(e.target.value)}
                />
              </label>
              <div className="tg-ai-row" style={{ alignItems: 'flex-end' }}>
                <button type="submit" className="tg-btn tg-btn--primary">
                  Save Host · 保存主机
                </button>
              </div>
            </form>
          )}

          {!activeNode ? (
            <div className="tg-ai-empty">
              No Connected Computers · 暂无已连接的远程电脑 — Register a Fabushi Desktop local agent or bind a cloud SSH host above.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="tg-ai-row tg-ai-row--between">
                <div className="tg-ai-row">
                  <select
                    value={activeNode.node_id}
                    onChange={(e) => setSelectedNodeId(e.target.value)}
                    style={{
                      background: 'var(--tg-bg-input)',
                      color: 'var(--tg-text-primary)',
                      border: '1px solid var(--tg-border)',
                      borderRadius: 8,
                      padding: '6px 10px',
                    }}
                  >
                    {computers.map((node) => (
                      <option key={node.node_id} value={node.node_id}>
                        {node.display_name} ({node.host || node.node_id})
                      </option>
                    ))}
                  </select>
                  <span
                    className={`tg-ai-badge ${
                      activeNode.online ? 'tg-ai-badge--success' : 'tg-ai-badge--warning'
                    }`}
                  >
                    {activeNode.online ? 'Online' : 'Offline'} · {activeNode.lease_state}
                  </span>
                </div>

                <div className="tg-ai-row">
                  <select
                    value={activeNode.run_policy}
                    onChange={(e) =>
                      void setComputerPolicy(
                        activeNode.node_id,
                        e.target.value as ComputerRunPolicy,
                      )
                    }
                    style={{
                      background: 'var(--tg-bg-input)',
                      color: 'var(--tg-text-primary)',
                      border: '1px solid var(--tg-border)',
                      borderRadius: 8,
                      padding: '6px 10px',
                    }}
                  >
                    {RUN_POLICY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    onClick={async () => {
                      try {
                        const res = await testComputerConnection(activeNode.node_id);
                        pushToast(
                          res.ok
                            ? `Host reachable (${res.message || 'OK'})`
                            : `Host test failed: ${res.message || 'unreachable'}`,
                          res.ok ? 'success' : 'error',
                        );
                      } catch (err) {
                        pushToast(err instanceof Error ? err.message : String(err), 'error');
                      }
                    }}
                  >
                    Test Connection · 连通性测试
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--danger"
                    onClick={() => void deleteComputer(activeNode.node_id)}
                  >
                    Remove · 移除
                  </button>
                </div>
              </div>

              {/* Authentic Remote Frame Viewer (ZERO synthetic canvas) */}
              <div className="tg-remote-frame-box">
                {activeFrameUrl ? (
                  <img
                    src={activeFrameUrl}
                    alt={`Live frame from ${activeNode.display_name}`}
                  />
                ) : (
                  <div className="tg-ai-workspace__subtitle" style={{ padding: 24, textAlign: 'center' }}>
                    Host connected ({activeNode.display_name}) — awaiting live screen frame capture. Click Capture Screen below when host agent is active.
                  </div>
                )}
              </div>

              {/* Real RemoteComputerOp Controls */}
              <div className="tg-ai-row">
                <button
                  type="button"
                  className="tg-btn tg-btn--secondary"
                  onClick={() => void handleRunRemoteOp({ op: 'capture_screen' })}
                >
                  📷 Capture Screen · 截屏
                </button>
                <button
                  type="button"
                  className="tg-btn tg-btn--secondary"
                  onClick={() => void handleRunRemoteOp({ op: 'display_list' })}
                >
                  🖥️ List Displays · 显示器列表
                </button>
                <input
                  type="text"
                  value={shellCmd}
                  onChange={(e) => setShellCmd(e.target.value)}
                  placeholder="Enter shell command to dispatch via RemoteComputerOp..."
                  style={{
                    flex: 1,
                    background: 'var(--tg-bg-input)',
                    color: 'var(--tg-text-primary)',
                    border: '1px solid var(--tg-border)',
                    borderRadius: 8,
                    padding: '7px 10px',
                    fontSize: 12,
                  }}
                />
                <button
                  type="button"
                  className="tg-btn tg-btn--primary"
                  disabled={!shellCmd.trim()}
                  onClick={() =>
                    void handleRunRemoteOp({ op: 'shell_exec', command: shellCmd.trim() })
                  }
                >
                  ▶ Run Command
                </button>
              </div>

              {lastOpOutput && <pre className="tg-ai-code-block">{lastOpOutput}</pre>}
            </div>
          )}

          {/* Pending High-Risk Computer Approvals */}
          {computerApprovals.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              <strong style={{ fontSize: 13 }}>
                Pending Command Approvals ({computerApprovals.length})
              </strong>
              {computerApprovals.map((cmd) => (
                <div key={cmd.command_id} className="tg-ai-card tg-ai-card--elevated">
                  <div className="tg-ai-row tg-ai-row--between">
                    <strong>
                      {String(cmd.operation.op ?? 'operation')} ({cmd.caller_label})
                    </strong>
                    <span className="tg-ai-badge tg-ai-badge--warning">{cmd.status}</span>
                  </div>
                  <div className="tg-ai-workspace__subtitle">
                    {JSON.stringify(cmd.operation)}
                  </div>
                  <div className="tg-ai-row">
                    <button
                      type="button"
                      className="tg-btn tg-btn--primary"
                      onClick={() => void decideComputerApproval(cmd.command_id, true)}
                    >
                      Approve · 允许
                    </button>
                    <button
                      type="button"
                      className="tg-btn tg-btn--danger"
                      onClick={() => void decideComputerApproval(cmd.command_id, false)}
                    >
                      Deny · 拒绝
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Truthful Tailnet Mesh Status (strictly real server peers only) */}
        <section className="tg-ai-card">
          <div className="tg-ai-card__header">
            <h3 className="tg-ai-card__title">🌐 Tailnet P2P Mesh · 组网状态</h3>
            <span
              className={`tg-ai-badge ${
                tailnet?.connected ? 'tg-ai-badge--success' : ''
              }`}
            >
              {tailnet?.connected ? 'Connected · 已组网' : 'Disconnected · 未连接'}
            </span>
          </div>
          {validTailnetPeers.length === 0 ? (
            <div className="tg-ai-empty">
              Tailnet Disconnected · 未连接组网设备 — No active Tailnet mesh peers detected.
            </div>
          ) : (
            <div className="tg-ai-grid">
              {validTailnetPeers.map((peer) => (
                <div key={peer.device_id} className="tg-ai-card tg-ai-card--elevated">
                  <strong>{peer.display_name}</strong>
                  <div className="tg-ai-workspace__subtitle">
                    IP: <code>{peer.ipv4}</code> · Relay: {peer.relay_mode}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
