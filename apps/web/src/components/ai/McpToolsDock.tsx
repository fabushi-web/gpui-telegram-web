import React, { useEffect, useMemo, useState } from 'react';
import {
  DOM_IDS,
  type McpPendingApprovalDto,
} from '@gpui-telegram/protocol';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useUiStore } from '../../store/useUiStore';

export interface McpToolsDockProps {
  onClose?: () => void;
}

const DEFAULT_ARGS_BY_TOOL: Record<string, string> = {
  read_file: '{\n  "path": "README.md"\n}',
  list_directory: '{\n  "path": "."\n}',
  write_file: '{\n  "path": "notes/mcp-audit.md",\n  "content": "Verified MCP approval gate"\n}',
  browser_list_targets: '{}',
  browser_tab_command: '{\n  "action": "snapshot"\n}',
  browser_headless_open: '{\n  "url": "https://ombhrum.com"\n}',
  browser_headless_action: '{\n  "session_id": "",\n  "action": "snapshot"\n}',
  browser_headless_screenshot: '{\n  "session_id": ""\n}',
  browser_headless_close: '{\n  "session_id": ""\n}',
};

export function McpToolsDock({ onClose }: McpToolsDockProps = {}): React.JSX.Element {
  const mcpServers = useAiWorkspaceStore((s) => s.mcpServers);
  const mcpTools = useAiWorkspaceStore((s) => s.mcpTools);
  const mcpApprovals = useAiWorkspaceStore((s) => s.mcpApprovals);
  const lastMcpOutput = useAiWorkspaceStore((s) => s.lastMcpOutput);
  const loadMcp = useAiWorkspaceStore((s) => s.loadMcp);
  const registerMcpServer = useAiWorkspaceStore((s) => s.registerMcpServer);
  const deleteMcpServer = useAiWorkspaceStore((s) => s.deleteMcpServer);
  const invokeMcpTool = useAiWorkspaceStore((s) => s.invokeMcpTool);
  const decideMcpApproval = useAiWorkspaceStore((s) => s.decideMcpApproval);

  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);
  const pushToast = useUiStore((s) => s.pushToast);

  const [newServerName, setNewServerName] = useState('');
  const [newServerEndpoint, setNewServerEndpoint] = useState('');
  const [newServerTransport, setNewServerTransport] = useState<'http' | 'sse' | 'stdio'>('http');
  const [addingServer, setAddingServer] = useState(false);

  const [selectedToolName, setSelectedToolName] = useState('');
  const [argsJson, setArgsJson] = useState('{}');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [invoking, setInvoking] = useState(false);

  const [toolAutoAllow, setToolAutoAllow] = useState<Record<string, boolean>>({});
  const [defaultRiskPolicy, setDefaultRiskPolicy] = useState<
    'manual_high_risk' | 'auto_read_only' | 'strict_all'
  >('manual_high_risk');
  const [copiedRpc, setCopiedRpc] = useState(false);

  useEffect(() => {
    void loadMcp().catch(() => undefined);
  }, [loadMcp]);

  useEffect(() => {
    if (mcpTools.length > 0 && !mcpTools.some((t) => t.name === selectedToolName)) {
      const first = mcpTools[0].name;
      setSelectedToolName(first);
      setArgsJson(DEFAULT_ARGS_BY_TOOL[first] || '{}');
    }
  }, [mcpTools, selectedToolName]);

  const pendingApprovals = useMemo(
    () => mcpApprovals.filter((a) => a.status === 'pending'),
    [mcpApprovals],
  );

  const rpcEndpointUrl = useMemo(() => {
    if (typeof window === 'undefined') return '/api/v1/mcp/rpc';
    return `${window.location.origin}/api/v1/mcp/rpc`;
  }, []);

  const handleSelectTool = (name: string) => {
    setSelectedToolName(name);
    setArgsJson(DEFAULT_ARGS_BY_TOOL[name] || '{}');
    setJsonError(null);
  };

  const handleAddServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newServerName.trim() || !newServerEndpoint.trim()) return;
    setAddingServer(true);
    try {
      const created = await registerMcpServer({
        name: newServerName.trim(),
        transport: newServerTransport,
        url: newServerTransport === 'stdio' ? undefined : newServerEndpoint.trim(),
        command: newServerTransport === 'stdio' ? newServerEndpoint.trim() : undefined,
      });
      setNewServerName('');
      setNewServerEndpoint('');
      pushToast(`已注册 MCP 服务：${created.name || created.server_id}`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setAddingServer(false);
    }
  };

  const handleRemoveServer = async (serverId: string) => {
    try {
      await deleteMcpServer(serverId);
      pushToast(`已移除 MCP 服务：${serverId}`, 'info');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleInvokeTool = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedToolName) return;
    setJsonError(null);
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
    } catch (err) {
      setJsonError(`Invalid JSON arguments: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const toolSpec = mcpTools.find((t) => t.name === selectedToolName);
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

      if (res.status === 'approval_required') {
        pushToast(`Approval required for ${selectedToolName} · 高风险工具等待人工审批`, 'warning');
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
              {mcpServers.length} Servers · {mcpTools.length} Tools
            </span>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
            JSON-RPC 2.0 Host &amp; Human-in-the-Loop High-Risk Permission Gate
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

        {/* Connected MCP Servers + Real Backend Registration Form */}
        <section className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontSize: '14.5px', fontWeight: 600 }}>
            🖥️ Connected MCP Servers · 已连接 MCP 服务 ({mcpServers.length})
          </div>

          {mcpServers.length === 0 ? (
            <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)' }}>
              当前尚未配置外部 MCP 服务器。请在下方添加 HTTP/SSE 或 STDIO MCP 服务。
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' }}>
              {mcpServers.map((srv) => (
                <div
                  key={srv.server_id}
                  style={{
                    padding: '12px',
                    borderRadius: '8px',
                    backgroundColor: 'var(--tg-bg-elevated)',
                    border: '1px solid var(--tg-border)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                    <strong style={{ fontSize: '13.5px' }}>{srv.server_id}</strong>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '11px', color: 'var(--tg-success)' }}>● {srv.status}</span>
                      <button
                        type="button"
                        className="tg-btn tg-btn--ghost"
                        style={{ padding: '2px 6px', fontSize: '11px', color: 'var(--tg-danger)' }}
                        onClick={() => void handleRemoveServer(srv.server_id)}
                      >
                        移除
                      </button>
                    </div>
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
          )}

          <form
            onSubmit={(e) => void handleAddServer(e)}
            style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', paddingTop: '6px' }}
          >
            <input
              type="text"
              className="tg-input"
              aria-label="New MCP Server Name 服务器名称"
              placeholder="服务器名称（如 git_tools）"
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
              placeholder={newServerTransport === 'stdio' ? 'Command (e.g. npx @modelcontextprotocol/server-filesystem)' : 'Endpoint URL (https://...)'}
              value={newServerEndpoint}
              onChange={(e) => setNewServerEndpoint(e.target.value)}
              style={{ flex: '1 1 240px' }}
            />
            <button type="submit" className="tg-btn tg-btn--secondary" disabled={addingServer}>
              {addingServer ? '添加中...' : '+ Add Server · 添加服务'}
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
              disabled={mcpTools.length === 0}
            >
              {mcpTools.length === 0 ? (
                <option value="">暂无可用工具</option>
              ) : (
                mcpTools.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name} ({t.risk_level}{t.requires_approval ? ' · approval gate' : ''})
                  </option>
                ))
              )}
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
            <button
              type="submit"
              className="tg-btn tg-btn--primary"
              disabled={invoking || !selectedToolName}
            >
              {invoking ? 'Invoking...' : `Invoke ${selectedToolName || 'Tool'} · 调用工具`}
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

        {/* Real Tools Catalog */}
        <section className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ fontSize: '14.5px', fontWeight: 600 }}>
            🧰 MCP Tools Catalog &amp; Risk Policy · 工具目录与风险分级 ({mcpTools.length})
          </div>

          {mcpTools.length === 0 ? (
            <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)' }}>
              服务端当前未注册 MCP 工具。添加 MCP 服务器后会自动列出其可用工具。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {mcpTools.map((tool) => {
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
          )}
        </section>
      </div>
    </div>
  );
}
