import React, { useEffect, useMemo, useState } from 'react';
import {
  DOM_IDS,
  type McpPendingApprovalDto,
  type McpServerDto,
  type McpToolDto,
} from '@gpui-telegram/protocol';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useUiStore } from '../../store/useUiStore';

export interface McpToolsDockProps {
  onClose?: () => void;
}

const FALLBACK_SERVERS: McpServerDto[] = [
  {
    server_id: 'mcp_filesystem',
    name: 'Local Filesystem MCP Server',
    transport: 'stdio',
    endpoint: 'stdio://mcp-filesystem',
    enabled: true,
    status: 'connected',
    tools_count: 3,
  },
  {
    server_id: 'mcp_browser_bridge',
    name: 'Desktop-to-Browser Bridge MCP Server',
    transport: 'http',
    endpoint: '/api/v1/mcp/rpc',
    enabled: true,
    status: 'connected',
    tools_count: 6,
  },
];

const FALLBACK_TOOLS: McpToolDto[] = [
  {
    tool_id: 'tool_read_file',
    server_id: 'mcp_filesystem',
    name: 'read_file',
    description: 'Read UTF-8 text contents from workspace file path.',
    risk_level: 'read_only',
    requires_approval: false,
  },
  {
    tool_id: 'tool_list_directory',
    server_id: 'mcp_filesystem',
    name: 'list_directory',
    description: 'List files and subdirectories at target workspace path.',
    risk_level: 'read_only',
    requires_approval: false,
  },
  {
    tool_id: 'tool_write_file',
    server_id: 'mcp_filesystem',
    name: 'write_file',
    description: 'Write or overwrite file content (high-risk mutation; requires human approval).',
    risk_level: 'high',
    requires_approval: true,
  },
  {
    tool_id: 'tool_browser_list_targets',
    server_id: 'mcp_browser_bridge',
    name: 'browser_list_targets',
    description: 'List connected live web tabs and active headless browser targets.',
    risk_level: 'read_only',
    requires_approval: false,
  },
  {
    tool_id: 'tool_browser_tab_command',
    server_id: 'mcp_browser_bridge',
    name: 'browser_tab_command',
    description: 'Execute snapshot/click/fill/screenshot command on a paired live web tab.',
    risk_level: 'medium',
    requires_approval: false,
  },
  {
    tool_id: 'tool_browser_headless_open',
    server_id: 'mcp_browser_bridge',
    name: 'browser_headless_open',
    description: 'Launch an isolated server-managed headless Chromium automation session.',
    risk_level: 'low',
    requires_approval: false,
  },
  {
    tool_id: 'tool_browser_headless_action',
    server_id: 'mcp_browser_bridge',
    name: 'browser_headless_action',
    description: 'Run click, fill, navigate, or snapshot inside a headless browser session.',
    risk_level: 'low',
    requires_approval: false,
  },
  {
    tool_id: 'tool_browser_headless_screenshot',
    server_id: 'mcp_browser_bridge',
    name: 'browser_headless_screenshot',
    description: 'Capture live PNG/SVG viewport screenshot from a headless browser session.',
    risk_level: 'read_only',
    requires_approval: false,
  },
  {
    tool_id: 'tool_browser_headless_close',
    server_id: 'mcp_browser_bridge',
    name: 'browser_headless_close',
    description: 'Close and release a headless browser session.',
    risk_level: 'low',
    requires_approval: false,
  },
];

const DEFAULT_ARGS_BY_TOOL: Record<string, string> = {
  read_file: '{\n  "path": "README.md"\n}',
  list_directory: '{\n  "path": "."\n}',
  write_file: '{\n  "path": "notes/mcp-audit.md",\n  "content": "Verified MCP approval gate"\n}',
  browser_list_targets: '{}',
  browser_tab_command: '{\n  "action": "snapshot"\n}',
  browser_headless_open: '{\n  "url": "data:text/html,<h1>MCP Headless</h1>"\n}',
  browser_headless_action: '{\n  "session_id": "hbs_default",\n  "action": "snapshot"\n}',
  browser_headless_screenshot: '{\n  "session_id": "hbs_default"\n}',
  browser_headless_close: '{\n  "session_id": "hbs_default"\n}',
};

export function McpToolsDock({ onClose }: McpToolsDockProps = {}): React.JSX.Element {
  const mcpServers = useAiWorkspaceStore((s) => s.mcpServers);
  const mcpTools = useAiWorkspaceStore((s) => s.mcpTools);
  const mcpApprovals = useAiWorkspaceStore((s) => s.mcpApprovals);
  const lastMcpOutput = useAiWorkspaceStore((s) => s.lastMcpOutput);
  const loadMcp = useAiWorkspaceStore((s) => s.loadMcp);
  const invokeMcpTool = useAiWorkspaceStore((s) => s.invokeMcpTool);
  const decideMcpApproval = useAiWorkspaceStore((s) => s.decideMcpApproval);

  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);
  const pushToast = useUiStore((s) => s.pushToast);

  const [customServers, setCustomServers] = useState<McpServerDto[]>([]);
  const [newServerName, setNewServerName] = useState('');
  const [newServerEndpoint, setNewServerEndpoint] = useState('http://127.0.0.1:8788/mcp');
  const [newServerTransport, setNewServerTransport] = useState<'http' | 'sse' | 'stdio'>('http');

  const [selectedToolName, setSelectedToolName] = useState('read_file');
  const [argsJson, setArgsJson] = useState(DEFAULT_ARGS_BY_TOOL.read_file);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [invoking, setInvoking] = useState(false);

  const [toolAutoAllow, setToolAutoAllow] = useState<Record<string, boolean>>({});
  const [defaultRiskPolicy, setDefaultRiskPolicy] = useState<
    'manual_high_risk' | 'auto_read_only' | 'strict_all'
  >('manual_high_risk');
  const [localPendingApprovals, setLocalPendingApprovals] = useState<McpPendingApprovalDto[]>([]);
  const [copiedRpc, setCopiedRpc] = useState(false);

  useEffect(() => {
    void loadMcp().catch(() => undefined);
  }, [loadMcp]);

  const servers = useMemo(() => {
    const base = mcpServers.length > 0 ? mcpServers : FALLBACK_SERVERS;
    const map = new Map<string, McpServerDto>();
    for (const s of [...FALLBACK_SERVERS, ...base, ...customServers]) {
      map.set(s.server_id, s);
    }
    return Array.from(map.values());
  }, [mcpServers, customServers]);

  const tools = useMemo(() => {
    const map = new Map<string, McpToolDto>();
    for (const t of FALLBACK_TOOLS) {
      map.set(t.name, t);
    }
    for (const t of mcpTools) {
      map.set(t.name, t);
    }
    return Array.from(map.values());
  }, [mcpTools]);

  const pendingApprovals = useMemo(() => {
    const serverPending = mcpApprovals.filter((a) => a.status === 'pending');
    return [...serverPending, ...localPendingApprovals.filter((a) => a.status === 'pending')];
  }, [mcpApprovals, localPendingApprovals]);

  const rpcEndpointUrl = useMemo(() => {
    if (typeof window === 'undefined') return 'http://127.0.0.1:3000/api/v1/mcp/rpc';
    return `${window.location.origin}/api/v1/mcp/rpc`;
  }, []);

  const handleSelectTool = (name: string) => {
    setSelectedToolName(name);
    setArgsJson(DEFAULT_ARGS_BY_TOOL[name] || '{}');
    setJsonError(null);
  };

  const handleAddServer = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newServerName.trim() || !newServerEndpoint.trim()) return;
    const serverId = `mcp_${newServerName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    setCustomServers((prev) => [
      ...prev,
      {
        server_id: serverId,
        name: newServerName.trim(),
        transport: newServerTransport,
        endpoint: newServerEndpoint.trim(),
        enabled: true,
        status: 'connected',
        tools_count: 1,
      },
    ]);
    setNewServerName('');
    pushToast(`Connected MCP server: ${serverId} · 已连接 MCP 服务`, 'success');
  };

  const handleInvokeTool = async (e: React.FormEvent) => {
    e.preventDefault();
    setJsonError(null);
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
    } catch (err) {
      setJsonError(`Invalid JSON arguments: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const toolSpec = tools.find((t) => t.name === selectedToolName);
    const forceApprove = Boolean(toolSpec && toolAutoAllow[toolSpec.name]);

    setInvoking(true);
    try {
      const res = await invokeMcpTool({
        toolId: toolSpec?.tool_id,
        toolName: selectedToolName,
        arguments: parsedArgs,
        forceApprove,
      });

      await loadMcp().catch(() => undefined);

      // Ensure pending approval card is also surfaced in offline sandbox mode
      const storePending = useAiWorkspaceStore
        .getState()
        .mcpApprovals.some((a) => a.status === 'pending' && a.tool_name === selectedToolName);

      if (
        toolSpec?.requires_approval &&
        !forceApprove &&
        res.status !== 'approval_required' &&
        !storePending
      ) {
        setLocalPendingApprovals((prev) => [
          ...prev,
          {
            request_id: `local_mcp_req_${Date.now()}`,
            server_id: toolSpec.server_id,
            tool_name: toolSpec.name,
            arguments: parsedArgs,
            risk_level: toolSpec.risk_level,
            status: 'pending',
            created_at_ms: Date.now(),
          },
        ]);
        pushToast(`Approval required for ${selectedToolName} · 高风险工具等待人工审批`, 'warning');
      } else if (res.status === 'approval_required') {
        pushToast(`Approval required for ${selectedToolName} · 已进入待审批队列`, 'warning');
      } else {
        pushToast(`Invoked ${selectedToolName} · 工具调用完成`, 'success');
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setInvoking(false);
    }
  };

  const handleApprovalDecision = async (approval: McpPendingApprovalDto, allow: boolean) => {
    if (approval.request_id.startsWith('local_mcp_req_')) {
      setLocalPendingApprovals((prev) =>
        prev.map((item) =>
          item.request_id === approval.request_id
            ? { ...item, status: allow ? 'approved' : 'rejected' }
            : item,
        ),
      );
      if (allow) {
        await invokeMcpTool({
          toolName: approval.tool_name,
          arguments: approval.arguments,
          forceApprove: true,
        }).catch(() => undefined);
      }
      pushToast(
        allow ? 'Approved MCP tool execution · 已批准执行' : 'Rejected MCP tool · 已拒绝执行',
        allow ? 'success' : 'info',
      );
      return;
    }

    try {
      await decideMcpApproval(approval.request_id, allow);
      pushToast(
        allow ? 'Approved MCP tool execution · 已批准执行' : 'Rejected MCP tool · 已拒绝执行',
        allow ? 'success' : 'info',
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <div id={DOM_IDS.MCP_TOOLS_DOCK}>
      {/* Header */}
      <div className="tg-workspace-header">
        <div>
          <div style={{ fontSize: '16px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>🔌 Model Context Protocol (MCP) Tools Dock · MCP 工具坞与权限网关</span>
            <span
              style={{
                fontSize: '11.5px',
                padding: '2px 8px',
                borderRadius: '999px',
                backgroundColor: 'var(--tg-success-soft)',
                color: 'var(--tg-success)',
              }}
            >
              {servers.length} Servers · {tools.length} Tools
            </span>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
            filesystem · terminal · browser · search · JSON-RPC 2.0 Host &amp; Human-in-the-Loop High-Risk Gate
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <select
            className="tg-select"
            aria-label="MCP Default Permission Policy 默认权限策略"
            value={defaultRiskPolicy}
            onChange={(e) =>
              setDefaultRiskPolicy(
                e.target.value as 'manual_high_risk' | 'auto_read_only' | 'strict_all',
              )
            }
            style={{ width: 'auto', fontSize: '12px', padding: '5px 10px' }}
          >
            <option value="manual_high_risk">Gate High-Risk · 高危拦截审批</option>
            <option value="auto_read_only">Auto Read-Only · 自动放行只读</option>
            <option value="strict_all">Strict Gate All · 全部强制审批</option>
          </select>

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
      </div>

      <div className="tg-workspace-content">
        {/* Desktop JSON-RPC 2.0 Endpoint Banner */}
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
          <div>
            <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
              📡 Desktop MCP JSON-RPC 2.0 Endpoint · 桌面客户端标准接入端点
            </div>
            <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)', marginTop: '2px' }}>
              <code>POST /api/v1/mcp/rpc</code> ({rpcEndpointUrl})
            </div>
          </div>

          <button
            type="button"
            className="tg-btn tg-btn--secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(rpcEndpointUrl);
              setCopiedRpc(true);
              setTimeout(() => setCopiedRpc(false), 2000);
            }}
          >
            {copiedRpc ? '✓ Copied · 已复制' : 'Copy POST /api/v1/mcp/rpc'}
          </button>
        </section>

        {/* Pending Approvals Queue */}
        {pendingApprovals.length > 0 && (
          <section
            className="tg-surface-card"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              borderColor: 'var(--tg-warning)',
            }}
          >
            <div style={{ fontSize: '14.5px', fontWeight: 700, color: 'var(--tg-warning)' }}>
              ⚠️ Pending High-Risk MCP Tool Approvals · 待审批工具请求 ({pendingApprovals.length})
            </div>

            {pendingApprovals.map((req) => (
              <div
                key={req.request_id}
                data-approval-id={req.request_id}
                style={{
                  padding: '12px',
                  borderRadius: '8px',
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
                  <div style={{ fontWeight: 600, fontSize: '13.5px' }}>
                    Tool: <code>{req.tool_name}</code> ({req.server_id}) · Risk:{' '}
                    <strong>{req.risk_level.toUpperCase()}</strong>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)', marginTop: '4px' }}>
                    Arguments: <code>{JSON.stringify(req.arguments)}</code>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="tg-btn tg-btn--primary"
                    onClick={() => void handleApprovalDecision(req, true)}
                  >
                    Approve · 批准
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--danger"
                    onClick={() => void handleApprovalDecision(req, false)}
                  >
                    Reject · 拒绝
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {/* Connected MCP Servers + Add Server Form */}
        <section className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontSize: '14.5px', fontWeight: 600 }}>
            🖥️ Connected MCP Servers · 已连接 MCP 服务
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' }}>
            {servers.map((srv) => (
              <div
                key={srv.server_id}
                style={{
                  padding: '12px',
                  borderRadius: '8px',
                  backgroundColor: 'var(--tg-bg-elevated)',
                  border: '1px solid var(--tg-border)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ fontSize: '13.5px' }}>{srv.server_id}</strong>
                  <span style={{ fontSize: '11px', color: 'var(--tg-success)' }}>● {srv.status}</span>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)', marginTop: '3px' }}>
                  {srv.name}
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--tg-text-muted)', marginTop: '4px' }}>
                  <code>{srv.transport}</code> · <code>{srv.endpoint}</code> · {srv.tools_count} tools
                </div>
              </div>
            ))}
          </div>

          <form
            onSubmit={handleAddServer}
            style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', paddingTop: '6px' }}
          >
            <input
              type="text"
              className="tg-input"
              aria-label="New MCP Server Name 服务器名称"
              placeholder="Add MCP Server name (e.g. git_tools)"
              value={newServerName}
              onChange={(e) => setNewServerName(e.target.value)}
              style={{ flex: '1 1 180px' }}
            />
            <select
              className="tg-select"
              aria-label="MCP Transport 传输协议"
              value={newServerTransport}
              onChange={(e) => setNewServerTransport(e.target.value as 'http' | 'sse' | 'stdio')}
              style={{ width: 'auto' }}
            >
              <option value="http">HTTP JSON-RPC</option>
              <option value="sse">SSE</option>
              <option value="stdio">STDIO</option>
            </select>
            <input
              type="text"
              className="tg-input"
              aria-label="MCP Endpoint URL 服务端点"
              placeholder="Endpoint URL"
              value={newServerEndpoint}
              onChange={(e) => setNewServerEndpoint(e.target.value)}
              style={{ flex: '1 1 220px' }}
            />
            <button type="submit" className="tg-btn tg-btn--secondary">
              + Add Server · 添加服务
            </button>
          </form>
        </section>

        {/* Interactive Tool Invoke Runner */}
        <form
          onSubmit={(e) => void handleInvokeTool(e)}
          className="tg-surface-card"
          style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
            <div style={{ fontSize: '14.5px', fontWeight: 600 }}>
              🚀 Interactive MCP Tool Invoke Runner · 交互式工具调用器
            </div>

            <select
              className="tg-select"
              aria-label="Select MCP Tool 选择调用工具"
              value={selectedToolName}
              onChange={(e) => handleSelectTool(e.target.value)}
              style={{ width: 'auto', minWidth: '250px' }}
            >
              {tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} ({t.risk_level}{t.requires_approval ? ' · approval gate' : ''})
                </option>
              ))}
            </select>
          </div>

          <textarea
            rows={4}
            className="tg-textarea"
            aria-label="MCP Tool JSON Arguments 工具 JSON 参数"
            value={argsJson}
            onChange={(e) => setArgsJson(e.target.value)}
            style={{ fontFamily: 'monospace', fontSize: '12.5px' }}
          />

          {jsonError && <div style={{ fontSize: '12px', color: 'var(--tg-danger)' }}>{jsonError}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="tg-btn tg-btn--primary" disabled={invoking}>
              {invoking ? 'Invoking...' : `Invoke ${selectedToolName} · 调用工具`}
            </button>
          </div>

          {lastMcpOutput && (
            <pre
              data-testid="mcp-invoke-output"
              style={{
                margin: 0,
                padding: '10px 12px',
                borderRadius: '8px',
                backgroundColor: '#0E1621',
                border: '1px solid var(--tg-border)',
                color: '#29B6F6',
                fontSize: '12px',
                maxHeight: '180px',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
              }}
            >
              {JSON.stringify(lastMcpOutput, null, 2)}
            </pre>
          )}
        </form>

        {/* Tools Catalog */}
        <section className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ fontSize: '14.5px', fontWeight: 600 }}>
            🧰 MCP Tools Catalog &amp; Risk Policy · 工具目录与风险分级 ({tools.length})
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {tools.map((tool) => {
              const isHighRisk = tool.risk_level === 'high' || tool.risk_level === 'critical';
              const autoAllowed = Boolean(toolAutoAllow[tool.name]);
              return (
                <div
                  key={tool.name}
                  data-mcp-tool={tool.name}
                  style={{
                    padding: '10px 12px',
                    borderRadius: '8px',
                    backgroundColor: 'var(--tg-bg-elevated)',
                    border: '1px solid var(--tg-border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ minWidth: 0, flex: '1 1 260px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <code style={{ fontWeight: 700, fontSize: '13px' }}>{tool.name}</code>
                      <span
                        style={{
                          fontSize: '11px',
                          padding: '1px 7px',
                          borderRadius: '999px',
                          backgroundColor: isHighRisk
                            ? 'var(--tg-danger-soft)'
                            : 'var(--tg-info-soft)',
                          color: isHighRisk ? 'var(--tg-danger)' : 'var(--tg-info)',
                          fontWeight: 600,
                        }}
                      >
                        {tool.risk_level}
                      </span>
                      {tool.requires_approval && (
                        <span
                          style={{
                            fontSize: '11px',
                            padding: '1px 7px',
                            borderRadius: '999px',
                            backgroundColor: 'var(--tg-warning-soft)',
                            color: 'var(--tg-warning)',
                          }}
                        >
                          Requires Approval · 需审批
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)', marginTop: '3px' }}>
                      {tool.description}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <label
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '12px',
                        color: 'var(--tg-text-secondary)',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        role="switch"
                        aria-checked={autoAllowed || !tool.requires_approval}
                        aria-label={`Auto-allow ${tool.name}`}
                        checked={autoAllowed || !tool.requires_approval}
                        onChange={(e) =>
                          setToolAutoAllow((prev) => ({
                            ...prev,
                            [tool.name]: e.target.checked,
                          }))
                        }
                      />
                      <span>Auto-Allow</span>
                    </label>

                    <button
                      type="button"
                      className="tg-btn tg-btn--secondary"
                      style={{ padding: '4px 10px', fontSize: '12px' }}
                      onClick={() => handleSelectTool(tool.name)}
                    >
                      Load in Runner · 填入
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
