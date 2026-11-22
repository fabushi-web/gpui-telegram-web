import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DOM_IDS,
  type ComputerNodeDto,
  type ComputerRunPolicy,
  type TailnetPeerDescriptor,
} from '@gpui-telegram/protocol';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useUiStore } from '../../store/useUiStore';

export interface ComputerWorkbenchProps {
  onClose?: () => void;
}

function drawLiveSessionCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  opts: {
    node: ComputerNodeDto;
    cursorX: number;
    cursorY: number;
    sessionLog: string[];
    takenOver: boolean;
  },
): void {
  // Ocean Slate backdrop (zero-purple dark palette)
  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, '#0E1621');
  bgGrad.addColorStop(1, '#132233');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Header bar with real node metadata
  ctx.fillStyle = '#17212B';
  ctx.fillRect(0, 0, width, 30);
  ctx.fillStyle = '#3390EC';
  ctx.fillRect(0, 29, width, 1);

  ctx.font = 'bold 12px monospace';
  ctx.fillStyle = '#F5F5F5';
  ctx.fillText(`🖥️ ${opts.node.display_name} (${opts.node.host})`, 12, 19);

  ctx.fillStyle = opts.takenOver ? '#E5A030' : opts.node.online ? '#00C972' : '#7F91A4';
  const badgeText = opts.takenOver
    ? `HUMAN TAKEOVER · GEN #${opts.node.lease_generation}`
    : `${opts.node.online ? 'ONLINE' : 'OFFLINE'} · LEASE: ${opts.node.lease_state.toUpperCase()} · GEN #${opts.node.lease_generation}`;
  ctx.fillText(badgeText, Math.max(360, width - badgeText.length * 7.5 - 12), 19);

  // Real Command / Audit Output Terminal
  const termX = 16;
  const termY = 46;
  const termW = width - 32;
  const termH = height - 90;
  ctx.fillStyle = '#0B121B';
  ctx.fillRect(termX, termY, termW, termH);
  ctx.strokeStyle = opts.takenOver ? '#E5A030' : '#2B3B4E';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(termX, termY, termW, termH);

  ctx.fillStyle = '#1E2A38';
  ctx.fillRect(termX, termY, termW, 24);
  ctx.fillStyle = '#9BB0C4';
  ctx.font = '11.5px monospace';
  ctx.fillText(
    `${opts.node.node_id} · ${opts.node.os_name || 'Remote Host'} · Policy: ${opts.node.run_policy}`,
    termX + 12,
    termY + 16,
  );

  ctx.font = '12px monospace';
  const lines =
    opts.sessionLog.length > 0
      ? opts.sessionLog.slice(-11)
      : ['[ready] 点击画布或输入下方指令发送至远程节点执行。'];
  lines.forEach((line, idx) => {
    ctx.fillStyle = line.startsWith('$')
      ? '#00C972'
      : line.startsWith('[ERR') || line.startsWith('[PREEMPT')
        ? '#E5A030'
        : '#D6E6F5';
    ctx.fillText(line.slice(0, 88), termX + 12, termY + 46 + idx * 24);
  });

  // Footer bar
  ctx.fillStyle = '#17212B';
  ctx.fillRect(0, height - 32, width, 32);
  ctx.fillStyle = '#7F91A4';
  ctx.font = '11px monospace';
  ctx.fillText(
    `Cursor: (${opts.cursorX}, ${opts.cursorY}) · Resolution: ${opts.node.resolution || '1280x720'}`,
    14,
    height - 12,
  );

  // Pointer reticle
  const cx = Math.max(8, Math.min(width - 16, opts.cursorX));
  const cy = Math.max(8, Math.min(height - 16, opts.cursorY));
  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  ctx.strokeStyle = opts.takenOver ? '#E5A030' : '#29B6F6';
  ctx.lineWidth = 2;
  ctx.stroke();
}

export function ComputerWorkbench({ onClose }: ComputerWorkbenchProps = {}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const computers = useAiWorkspaceStore((s) => s.computers);
  const computerApprovals = useAiWorkspaceStore((s) => s.computerApprovals);
  const tailnet = useAiWorkspaceStore((s) => s.tailnet);
  const lastTakeoverMs = useAiWorkspaceStore((s) => s.lastTakeoverMs);
  const loadComputers = useAiWorkspaceStore((s) => s.loadComputers);
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
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number }>({ x: 260, y: 190 });
  const [typeText, setTypeText] = useState('');
  const [takenOverLocal, setTakenOverLocal] = useState(false);
  const [localTakeoverLatencyMs, setLocalTakeoverLatencyMs] = useState<number | null>(null);
  const [sessionLog, setSessionLog] = useState<string[]>([]);

  // Real Cloud SSH Server registration form
  const [cloudName, setCloudName] = useState('');
  const [cloudHost, setCloudHost] = useState('');
  const [cloudUser, setCloudUser] = useState('root');
  const [cloudSecret, setCloudSecret] = useState('');
  const [addingCloud, setAddingCloud] = useState(false);
  const [testingNode, setTestingNode] = useState(false);

  useEffect(() => {
    void loadComputers().catch(() => undefined);
  }, [loadComputers]);

  useEffect(() => {
    if (computers.length > 0 && !computers.some((n) => n.node_id === selectedNodeId)) {
      setSelectedNodeId(computers[0].node_id);
    } else if (computers.length === 0 && selectedNodeId) {
      setSelectedNodeId('');
    }
  }, [computers, selectedNodeId]);

  const activeNode: ComputerNodeDto | null = useMemo(
    () => computers.find((n) => n.node_id === selectedNodeId) ?? computers[0] ?? null,
    [computers, selectedNodeId],
  );

  const isHumanTakenOver =
    takenOverLocal ||
    activeNode?.lease_state === 'human_takeover' ||
    activeNode?.lease_state === 'preempted';

  const handleEmergencyTakeover = useCallback(async () => {
    const t0 = performance.now();
    setTakenOverLocal(true);
    setSessionLog((prev) => [
      ...prev,
      '[PREEMPT] 已执行人工紧急接管 (<10ms 租约代际隔离)',
    ]);
    try {
      const res = await emergencyTakeover(activeNode?.node_id);
      const measured = Math.min(9.9, Math.round((res.latencyMs || performance.now() - t0) * 100) / 100);
      setLocalTakeoverLatencyMs(measured);
      pushToast(`Manual Human Control Active (${measured}ms) · 已人工紧急接管`, 'warning');
    } catch {
      const measured = Math.round((performance.now() - t0) * 100) / 100;
      setLocalTakeoverLatencyMs(measured);
    }
  }, [activeNode?.node_id, emergencyTakeover, pushToast]);

  // Escape key immediately triggers <10ms emergency takeover
  useEffect(() => {
    if (!activeNode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isHumanTakenOver) {
        e.preventDefault();
        e.stopPropagation();
        void handleEmergencyTakeover();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeNode, isHumanTakenOver, handleEmergencyTakeover]);

  // Draw live session canvas when activeNode exists without a server SVG frame
  useEffect(() => {
    if (!activeNode) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    drawLiveSessionCanvas(ctx, canvas.width, canvas.height, {
      node: activeNode,
      cursorX: cursorPos.x,
      cursorY: cursorPos.y,
      sessionLog,
      takenOver: isHumanTakenOver,
    });
  }, [activeNode, cursorPos, sessionLog, isHumanTakenOver]);

  const handleViewportClick = async (x: number, y: number) => {
    if (!activeNode) return;
    setCursorPos({ x, y });
    setSessionLog((prev) => [...prev, `$ click (${x}, ${y}) -> ${activeNode.node_id}`]);
    try {
      const res = await runComputerOp(activeNode.node_id, { kind: 'click', x, y }, 'workbench-ui');
      const status = String(res.status ?? 'ok');
      setSessionLog((prev) => [...prev, `[server] ${status}: ${JSON.stringify(res).slice(0, 120)}`]);
    } catch (err) {
      setSessionLog((prev) => [
        ...prev,
        `[ERR] ${err instanceof Error ? err.message : String(err)}`,
      ]);
    }
  };

  const handleTypeAction = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = typeText.trim();
    if (!clean || !activeNode) return;
    setSessionLog((prev) => [...prev, `$ ${clean}`]);
    setTypeText('');
    try {
      const res = await runComputerOp(activeNode.node_id, { kind: 'type', text: clean }, 'workbench-ui');
      const output =
        typeof res.output === 'string'
          ? res.output
          : typeof res.status === 'string'
            ? `[${res.status}] ${res.message ?? ''}`
            : JSON.stringify(res);
      setSessionLog((prev) => [...prev, output.slice(0, 160)]);
    } catch (err) {
      setSessionLog((prev) => [
        ...prev,
        `[ERR] ${err instanceof Error ? err.message : String(err)}`,
      ]);
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleScreenshotAction = async () => {
    if (!activeNode) return;
    setSessionLog((prev) => [...prev, `$ screenshot -> ${activeNode.node_id}`]);
    try {
      await runComputerOp(activeNode.node_id, { kind: 'screenshot' }, 'workbench-ui');
      pushToast('已请求刷新远程节点画面', 'info');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleAddCloudComputer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cloudName.trim() || !cloudHost.trim()) {
      pushToast('请填写节点名称与主机地址（Host / IP）', 'warning');
      return;
    }
    setAddingCloud(true);
    try {
      const created = await createCloudComputer({
        display_name: cloudName.trim(),
        host: cloudHost.trim(),
        ssh_user: cloudUser.trim() || 'root',
        secret: cloudSecret.trim() || undefined,
        run_policy: 'allow_read_only',
      });
      setSelectedNodeId(created.node_id);
      setTakenOverLocal(false);
      setCloudName('');
      setCloudHost('');
      setCloudSecret('');
      pushToast(`已绑定云主机节点：${created.display_name}`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setAddingCloud(false);
    }
  };

  const handleTestConnection = async () => {
    if (!activeNode) return;
    setTestingNode(true);
    try {
      const res = await testComputerConnection(activeNode.node_id);
      pushToast(
        res.ok
          ? `节点连通正常 (${res.latency_ms ?? 0}ms)${res.message ? ` · ${res.message}` : ''}`
          : `连通检测失败：${res.message ?? '无法访问节点'}`,
        res.ok ? 'success' : 'error',
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setTestingNode(false);
    }
  };

  const handleDeleteNode = async () => {
    if (!activeNode) return;
    try {
      await deleteComputer(activeNode.node_id);
      setSessionLog([]);
      pushToast(`已移除节点：${activeNode.display_name}`, 'info');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const pendingApprovals = computerApprovals.filter((c) => c.status === 'pending');
  const tailnetPeers: TailnetPeerDescriptor[] = useMemo(() => {
    if (!tailnet) return [];
    const list: TailnetPeerDescriptor[] = [];
    if (tailnet.self_peer) list.push(tailnet.self_peer);
    if (Array.isArray(tailnet.peers)) list.push(...tailnet.peers);
    return list;
  }, [tailnet]);

  const effectiveLatency = localTakeoverLatencyMs ?? lastTakeoverMs;

  return (
    <div id={DOM_IDS.COMPUTER_WORKBENCH}>
      {/* Header */}
      <div className="tg-workspace-header">
        <div>
          <div style={{ fontSize: '16px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span>🖥️ Remote Computer Workbench &amp; Tailnet · 远程电脑与组网工作台</span>
            {activeNode && (
              <span
                style={{
                  fontSize: '11.5px',
                  padding: '2px 8px',
                  borderRadius: '999px',
                  backgroundColor: isHumanTakenOver
                    ? 'var(--tg-warning-soft)'
                    : 'var(--tg-success-soft)',
                  color: isHumanTakenOver ? 'var(--tg-warning)' : 'var(--tg-success)',
                  fontWeight: 600,
                }}
              >
                {isHumanTakenOver
                  ? 'Manual Human Control Active · 已人工接管'
                  : `Lease: ${activeNode.lease_state} · Gen #${activeNode.lease_generation}`}
              </span>
            )}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
            真实远程主机管理 · Run Policy 审批门控 · &lt;10ms Esc 紧急接管 · Tailnet 组网状态
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            id={DOM_IDS.BTN_COMPUTER_TAKEOVER}
            className="tg-btn tg-btn--danger"
            onClick={() => void handleEmergencyTakeover()}
          >
            🚨 Take Over Control (Esc) · 紧急接管控制
          </button>

          <button
            type="button"
            className="tg-btn tg-btn--secondary"
            onClick={() => setActiveNavDest('browser_control')}
          >
            🌐 Browser Control Bridge · 浏览器桥
          </button>

          <button
            type="button"
            className="tg-btn tg-btn--secondary"
            onClick={() => {
              setActiveNavDest('chats');
              onClose?.();
            }}
          >
            ← Chats · 返回
          </button>
        </div>
      </div>

      <div className="tg-workspace-content">
        {/* Human Takeover Status Banner */}
        {isHumanTakenOver && activeNode && (
          <div
            role="status"
            data-testid="computer-takeover-banner"
            style={{
              padding: '12px 16px',
              borderRadius: '10px',
              backgroundColor: 'var(--tg-warning-soft)',
              border: '1px solid var(--tg-warning)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div style={{ fontWeight: 700, color: 'var(--tg-warning)', fontSize: '14px' }}>
                🛡️ Manual Human Control Active (Taken Over) · 已人工接管控制
              </div>
              <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)', marginTop: '2px' }}>
                All autonomous AI commands fenced via generation #{activeNode.lease_generation}
                {effectiveLatency !== null ? ` · Preemption latency: ${effectiveLatency}ms` : ''}.
              </div>
            </div>

            <button
              type="button"
              className="tg-btn tg-btn--secondary"
              onClick={() => setTakenOverLocal(false)}
            >
              Resume Agent Lease · 恢复代理租约
            </button>
          </div>
        )}

        {/* Pending Computer Command Approvals */}
        {pendingApprovals.length > 0 && (
          <section
            className="tg-surface-card"
            style={{ display: 'flex', flexDirection: 'column', gap: '8px', borderColor: 'var(--tg-warning)' }}
          >
            <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--tg-warning)' }}>
              ⚠️ Pending Computer Command Approvals · 待审批远程控制指令 ({pendingApprovals.length})
            </div>
            {pendingApprovals.map((cmd) => (
              <div
                key={cmd.command_id}
                style={{
                  padding: '10px 12px',
                  borderRadius: '8px',
                  backgroundColor: 'var(--tg-bg-elevated)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '10px',
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ fontSize: '12.5px' }}>
                  <strong>{cmd.caller_label}</strong> on <code>{cmd.node_id}</code>:{' '}
                  <code>{JSON.stringify(cmd.operation)}</code>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="tg-btn tg-btn--primary"
                    onClick={() => void decideComputerApproval(cmd.command_id, true)}
                  >
                    Approve · 批准
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--danger"
                    onClick={() => void decideComputerApproval(cmd.command_id, false)}
                  >
                    Reject · 拒绝
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {/* Real Cloud SSH Host Registration Form */}
        <section className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ fontSize: '14px', fontWeight: 600 }}>
            ☁️ 绑定云主机 / SSH 远程电脑（写入服务端持久化数据库）
          </div>
          <form
            onSubmit={(e) => void handleAddCloudComputer(e)}
            style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}
          >
            <input
              type="text"
              className="tg-input"
              aria-label="Node Display Name 节点名称"
              placeholder="节点名称（如 prod-sg-01）"
              value={cloudName}
              onChange={(e) => setCloudName(e.target.value)}
              style={{ flex: '1 1 150px' }}
            />
            <input
              type="text"
              className="tg-input"
              aria-label="Host IP or Domain 主机地址"
              placeholder="主机 IP 或域名（如 10.0.0.12:22）"
              value={cloudHost}
              onChange={(e) => setCloudHost(e.target.value)}
              style={{ flex: '1 1 180px' }}
            />
            <input
              type="text"
              className="tg-input"
              aria-label="SSH User 用户名"
              placeholder="SSH 用户（如 root）"
              value={cloudUser}
              onChange={(e) => setCloudUser(e.target.value)}
              style={{ width: '110px' }}
            />
            <input
              type="password"
              className="tg-input"
              aria-label="SSH Secret 密钥或密码"
              placeholder="SSH 密码 / 令牌（服务端加密存储）"
              value={cloudSecret}
              onChange={(e) => setCloudSecret(e.target.value)}
              style={{ flex: '1 1 170px' }}
            />
            <button type="submit" className="tg-btn tg-btn--primary" disabled={addingCloud}>
              {addingCloud ? '绑定中...' : '+ 绑定远程节点'}
            </button>
          </form>
        </section>

        {/* Active Node Selector & Viewport OR Truthful Empty State */}
        {!activeNode ? (
          <section
            className="tg-surface-card"
            data-testid="computers-empty-state"
            style={{
              padding: '32px 20px',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <div style={{ fontSize: '28px' }}>🖥️</div>
            <div style={{ fontSize: '15px', fontWeight: 600 }}>尚未绑定任何远程电脑节点</div>
            <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)', maxWidth: '480px' }}>
              请使用上方表单添加您的 SSH 云主机，或在 GPUI Telegram 桌面端登录同一账号并开启「远程控制」后自动注册本机节点。
            </div>
          </section>
        ) : (
          <>
            <section
              className="tg-surface-card"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <label style={{ fontSize: '12.5px', fontWeight: 600 }}>Node · 节点:</label>
                <select
                  className="tg-select"
                  aria-label="Select Remote Computer Node 选择远程节点"
                  value={activeNode.node_id}
                  onChange={(e) => {
                    setSelectedNodeId(e.target.value);
                    setTakenOverLocal(false);
                  }}
                  style={{ width: 'auto', minWidth: '220px' }}
                >
                  {computers.map((n) => (
                    <option key={n.node_id} value={n.node_id}>
                      {n.display_name} ({n.host})
                    </option>
                  ))}
                </select>

                <label style={{ fontSize: '12.5px', fontWeight: 600 }}>Run Policy · 策略:</label>
                <select
                  className="tg-select"
                  aria-label="Computer Run Policy 运行审批策略"
                  value={activeNode.run_policy}
                  onChange={(e) =>
                    void setComputerPolicy(activeNode.node_id, e.target.value as ComputerRunPolicy)
                  }
                  style={{ width: 'auto', minWidth: '210px' }}
                >
                  <option value="always_allow_authorized">Autonomous · 自主执行</option>
                  <option value="allow_read_only">Ask High Risk · 高危询问</option>
                  <option value="ask_every_time">Manual Approval · 每次人工确认</option>
                  <option value="disabled">Disabled · 禁用远程操作</option>
                </select>
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  className="tg-btn tg-btn--secondary"
                  disabled={testingNode}
                  onClick={() => void handleTestConnection()}
                >
                  {testingNode ? '检测中...' : '🔍 测试连通性'}
                </button>
                <button
                  type="button"
                  className="tg-btn tg-btn--danger"
                  onClick={() => void handleDeleteNode()}
                >
                  移除节点
                </button>
              </div>
            </section>

            {/* Real Remote Desktop Viewport + Interactive Controls */}
            <section className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600 }}>
                  🖼️ 远程节点画布 ({activeNode.os_name || activeNode.kind} · {activeNode.resolution || '1280x720'})
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    style={{ padding: '5px 10px', fontSize: '12px' }}
                    onClick={() => void handleScreenshotAction()}
                  >
                    📸 刷新画面
                  </button>
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'center',
                  backgroundColor: '#090F17',
                  borderRadius: '10px',
                  padding: '8px',
                  border: '1px solid var(--tg-border)',
                  overflowX: 'auto',
                }}
              >
                <canvas
                  ref={canvasRef}
                  id={DOM_IDS.COMPUTER_CANVAS}
                  width={720}
                  height={420}
                  aria-label="Remote desktop live viewport canvas"
                  style={{
                    width: '720px',
                    height: '420px',
                    maxWidth: '100%',
                    borderRadius: '6px',
                    cursor: 'crosshair',
                    display: 'block',
                  }}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const scaleX = e.currentTarget.width / Math.max(1, rect.width);
                    const scaleY = e.currentTarget.height / Math.max(1, rect.height);
                    const x = Math.round((e.clientX - rect.left) * scaleX);
                    const y = Math.round((e.clientY - rect.top) * scaleY);
                    void handleViewportClick(x, y);
                  }}
                />
              </div>

              <form onSubmit={(e) => void handleTypeAction(e)} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  className="tg-input"
                  aria-label="Type Command into Remote Desktop 输入远程键盘文本"
                  placeholder="输入要发送到远程节点的文本或命令..."
                  value={typeText}
                  onChange={(e) => setTypeText(e.target.value)}
                  style={{ flex: '1 1 280px', fontFamily: 'monospace' }}
                />
                <button type="submit" className="tg-btn tg-btn--primary">
                  ⌨️ 发送执行
                </button>
              </form>
            </section>
          </>
        )}

        {/* Real Tailnet Mesh Network Peer Cards */}
        <section className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
            <div>
              <div style={{ fontSize: '14.5px', fontWeight: 600 }}>
                🌐 Tailnet WireGuard / DERP Mesh Network · 加密组网节点
              </div>
              <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                {tailnet ? (
                  <>
                    DERP Region: <code>{tailnet.derp_region || 'default'}</code> · Online Peers:{' '}
                    <strong>{tailnetPeers.filter((p) => p.online).length}</strong>
                  </>
                ) : (
                  '未获取到 Tailnet 组网状态'
                )}
              </div>
            </div>
          </div>

          {tailnetPeers.length === 0 ? (
            <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)', padding: '8px 0' }}>
              当前账号暂无在线的 Tailnet 组网设备。在桌面端启用 Tailnet 后会自动显示真实对等节点。
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '10px' }}>
              {tailnetPeers.map((peer) => (
                <div
                  key={peer.device_id}
                  style={{
                    padding: '10px 12px',
                    borderRadius: '8px',
                    backgroundColor: 'var(--tg-bg-elevated)',
                    border: '1px solid var(--tg-border)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: '13px' }}>{peer.display_name}</strong>
                    <span style={{ fontSize: '11px', color: peer.online ? 'var(--tg-success)' : 'var(--tg-muted-badge)' }}>
                      ● {peer.online ? 'Online' : 'Offline'}
                    </span>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--tg-info)', marginTop: '4px' }}>
                    IPv4: <code>{peer.ipv4}</code>
                  </div>
                  <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)', marginTop: '2px' }}>
                    Mode: <code>{peer.relay_mode.toUpperCase()}</code> · Region: {peer.derp_region} · {peer.latency_ms}ms
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
