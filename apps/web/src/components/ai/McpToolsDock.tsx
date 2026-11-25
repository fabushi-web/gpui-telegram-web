import React, { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_MCP_PROTOCOL_VERSION,
  DOM_IDS,
  MCP_OAUTH_SCOPES,
  type McpPendingApprovalDto,
} from '@gpui-telegram/protocol';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useUiStore } from '../../store/useUiStore';

export interface McpToolsDockProps {
  onClose?: () => void;
}

const BROWSER_TOOL_ARG_TEMPLATES: Record<string, string> = {
  browser_list_targets: '{}',
  browser_tab_command: '{\n  "action": "snapshot"\n}',
  browser_headless_open: '{\n  "url": "https://example.com"\n}',
  browser_headless_action: '{\n  "session_id": "",\n  "action": "snapshot"\n}',
  browser_headless_screenshot: '{\n  "session_id": ""\n}',
  browser_headless_close: '{\n  "session_id": ""\n}',
};

export function McpToolsDock({ onClose }: McpToolsDockProps = {}): React.JSX.Element {
  const mcpServers = useAiWorkspaceStore((s) => s.mcpServers);
  const mcpTools = useAiWorkspaceStore((s) => s.mcpTools);
  const mcpApprovals = useAiWorkspaceStore((s) => s.mcpApprovals);
  const lastMcpOutput = useAiWorkspaceStore((s) => s.lastMcpOutput);
  const oauthMcpGrants = useAiWorkspaceStore((s) => s.oauthMcpGrants);
  const oauthMcpAudit = useAiWorkspaceStore((s) => s.oauthMcpAudit);

  const loadMcp = useAiWorkspaceStore((s) => s.loadMcp);
  const registerMcpServer = useAiWorkspaceStore((s) => s.registerMcpServer);
  const deleteMcpServer = useAiWorkspaceStore((s) => s.deleteMcpServer);
  const invokeMcpTool = useAiWorkspaceStore((s) => s.invokeMcpTool);
  const decideMcpApproval = useAiWorkspaceStore((s) => s.decideMcpApproval);
  const revokeOAuthMcpGrant = useAiWorkspaceStore((s) => s.revokeOAuthMcpGrant);

  const serverUrl = useAuthStore((s) => s.serverUrl);
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
  const [revokingFamilyId, setRevokingFamilyId] = useState<string | null>(null);

  useEffect(() => {
    void loadMcp().catch(() => undefined);
  }, [loadMcp]);

  useEffect(() => {
    if (!selectedToolName && mcpTools.length > 0) {
      const first = mcpTools[0].name;
      setSelectedToolName(first);
      setArgsJson(BROWSER_TOOL_ARG_TEMPLATES[first] ?? '{}');
    }
  }, [mcpTools, selectedToolName]);

  const mcpBaseOrigin = useMemo(() => {
    const configured = serverUrl?.trim().replace(/\/+$/, '');
    if (configured) return configured;
    if (typeof window !== 'undefined') return window.location.origin;
    return 'http://127.0.0.1:4173';
  }, [serverUrl]);

  const officialMcpEndpoint = `${mcpBaseOrigin}/mcp`;

  const selectedTool = useMemo(
    () => mcpTools.find((t) => t.name === selectedToolName) ?? null,
    [mcpTools, selectedToolName],
  );

  const handleCopyEndpoint = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      pushToast(`Copied ${label}`, 'success');
    } catch {
      pushToast(text, 'info');
    }
  };

  const handleAddServer = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const cleanName = newServerName.trim();
    const cleanEndpoint = newServerEndpoint.trim();
    if (!cleanName || !cleanEndpoint) {
      pushToast('Server name and endpoint are required · 请填写名称与接入地址', 'warning');
      return;
    }
    setAddingServer(true);
    try {
      await registerMcpServer({
        name: cleanName,
        transport: newServerTransport,
        endpoint: cleanEndpoint,
      });
      setNewServerName('');
      setNewServerEndpoint('');
      pushToast(`Registered MCP server "${cleanName}"`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setAddingServer(false);
    }
  };

  const handleInvokeTool = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setJsonError(null);
    if (!selectedToolName) return;
    let parsedArgs: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(argsJson || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setJsonError('Arguments must be a JSON object');
        return;
      }
      parsedArgs = parsed as Record<string, unknown>;
    } catch {
      setJsonError('Invalid JSON arguments');
      return;
    }
    setInvoking(true);
    try {
      await invokeMcpTool({
        toolId: selectedTool?.tool_id,
        toolName: selectedToolName,
        arguments: parsedArgs,
      });
      pushToast(`Invoked ${selectedToolName}`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setInvoking(false);
    }
  };

  const handleDecideApproval = async (item: McpPendingApprovalDto, allow: boolean) => {
    try {
      await decideMcpApproval(item.request_id, allow);
      pushToast(allow ? `Approved ${item.tool_name}` : `Denied ${item.tool_name}`, 'info');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleRevokeGrant = async (familyId: string) => {
    setRevokingFamilyId(familyId);
    try {
      await revokeOAuthMcpGrant(familyId);
      pushToast(`Revoked OAuth 2.1 MCP grant ${familyId}`, 'info');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setRevokingFamilyId(null);
    }
  };

  return (
    <section id={DOM_IDS.MCP_TOOLS_DOCK} className="tg-ai-workspace">
      <header className="tg-ai-workspace__header">
        <div className="tg-ai-workspace__title-group">
          <h2 className="tg-ai-workspace__title">🔌 Official OAuth 2.1 Remote MCP & Tools Dock</h2>
          <span className="tg-ai-workspace__subtitle">
            Streamable HTTP + SSE ({DEFAULT_MCP_PROTOCOL_VERSION}), PKCE S256 Grants & Real Tool Audit
          </span>
        </div>
        <div className="tg-ai-workspace__actions">
          <button type="button" className="tg-btn tg-btn--ghost" onClick={() => void loadMcp()}>
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
        {/* Official OAuth 2.1 Remote MCP Grants & Audit Panel */}
        <section id={DOM_IDS.OAUTH_MCP_GRANTS_PANEL} className="tg-ai-card">
          <div className="tg-ai-card__header">
            <h3 className="tg-ai-card__title">
              🛡️ Official OAuth 2.1 Remote MCP Server (/mcp) · 远程授权与审计
            </h3>
            <span className="tg-ai-badge tg-ai-badge--info">
              Protocol {DEFAULT_MCP_PROTOCOL_VERSION} · PKCE S256
            </span>
          </div>

          <div className="tg-ai-card tg-ai-card--elevated">
            <div className="tg-ai-row tg-ai-row--between">
              <div>
                <div style={{ fontSize: 12, color: 'var(--tg-text-secondary)' }}>
                  Streamable HTTP / SSE Endpoint
                </div>
                <code>{officialMcpEndpoint}</code>
              </div>
              <button
                type="button"
                className="tg-btn tg-btn--secondary"
                onClick={() => void handleCopyEndpoint(officialMcpEndpoint, '/mcp endpoint')}
              >
                📋 Copy /mcp URL
              </button>
            </div>
            <div className="tg-ai-workspace__subtitle">
              Discovery: <code>/.well-known/oauth-protected-resource</code> ·{' '}
              <code>/.well-known/oauth-authorization-server</code> · <code>/oauth/register</code>
            </div>
            <div className="tg-ai-row">
              {MCP_OAUTH_SCOPES.map((scope) => (
                <span key={scope} className="tg-scope-pill">
                  {scope}
                </span>
              ))}
            </div>
          </div>

          {/* Active OAuth 2.1 Grants */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="tg-ai-row tg-ai-row--between">
              <strong style={{ fontSize: 13 }}>
                Authorized OAuth 2.1 Clients & Grants · 已授权客户端 ({oauthMcpGrants.length})
              </strong>
            </div>

            {oauthMcpGrants.length === 0 ? (
              <div className="tg-ai-empty">
                No active OAuth 2.1 MCP grants yet. Connect Claude Desktop, Cursor, or Antigravity via PKCE S256 to authorize. · 暂无活跃的 OAuth 2.1 MCP 授权。
              </div>
            ) : (
              <div className="tg-ai-grid">
                {oauthMcpGrants.map((grant) => (
                  <div key={grant.family_id} className="tg-ai-card tg-ai-card--elevated">
                    <div className="tg-ai-row tg-ai-row--between">
                      <strong>{grant.client_name || grant.client_id}</strong>
                      <span className="tg-ai-badge tg-ai-badge--success">Active Grant</span>
                    </div>
                    <div className="tg-ai-workspace__subtitle">
                      Family: <code>{grant.family_id}</code> · Client: <code>{grant.client_id}</code>
                    </div>
                    <div className="tg-ai-workspace__subtitle">
                      Expires: {new Date(grant.expires_at_ms).toLocaleString()}
                      {grant.allowed_node_ids.length > 0
                        ? ` · Nodes: ${grant.allowed_node_ids.join(', ')}`
                        : ''}
                    </div>
                    <div className="tg-ai-row">
                      {grant.scopes.map((sc) => (
                        <span key={sc} className="tg-scope-pill">
                          {sc}
                        </span>
                      ))}
                    </div>
                    <div className="tg-ai-row">
                      <button
                        type="button"
                        className="tg-btn tg-btn--danger"
                        disabled={revokingFamilyId === grant.family_id}
                        onClick={() => void handleRevokeGrant(grant.family_id)}
                      >
                        {revokingFamilyId === grant.family_id ? 'Revoking…' : 'Revoke · 撤销'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Official MCP Audit Trail */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <strong style={{ fontSize: 13 }}>
              Official MCP Tool Audit Trail · 工具调用审计日志 ({oauthMcpAudit.length})
            </strong>
            {oauthMcpAudit.length === 0 ? (
              <div className="tg-ai-empty">No MCP audit entries recorded yet · 暂无工具审计记录</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="tg-audit-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Tool</th>
                      <th>Client</th>
                      <th>Status</th>
                      <th>Duration</th>
                      <th>Summary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {oauthMcpAudit.slice(0, 30).map((entry) => (
                      <tr key={entry.audit_id}>
                        <td>{new Date(entry.created_at_ms).toLocaleTimeString()}</td>
                        <td>
                          <code>{entry.tool_name}</code>
                        </td>
                        <td>{entry.client_id}</td>
                        <td>
                          <span
                            className={`tg-ai-badge ${
                              entry.ok ? 'tg-ai-badge--success' : 'tg-ai-badge--danger'
                            }`}
                          >
                            {entry.ok ? 'OK' : entry.error_code || 'ERR'}
                          </span>
                        </td>
                        <td>{entry.duration_ms}ms</td>
                        <td>{entry.args_summary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* Registered External MCP Servers */}
        <section className="tg-ai-card">
          <div className="tg-ai-card__header">
            <h3 className="tg-ai-card__title">
              🖥️ Connected MCP Servers · 已注册 MCP 服务器 ({mcpServers.length})
            </h3>
          </div>

          <form onSubmit={(e) => void handleAddServer(e)} className="tg-ai-field-grid">
            <label className="tg-ai-field">
              <span>Server Name · 服务器名称</span>
              <input
                type="text"
                value={newServerName}
                onChange={(e) => setNewServerName(e.target.value)}
                placeholder="e.g. Local Dev MCP"
                required
              />
            </label>
            <label className="tg-ai-field">
              <span>Transport · 传输协议</span>
              <select
                value={newServerTransport}
                onChange={(e) => setNewServerTransport(e.target.value as 'http' | 'sse' | 'stdio')}
              >
                <option value="http">HTTP (Streamable)</option>
                <option value="sse">SSE</option>
                <option value="stdio">stdio</option>
              </select>
            </label>
            <label className="tg-ai-field">
              <span>Endpoint URL or Command · 地址或命令</span>
              <input
                type="text"
                value={newServerEndpoint}
                onChange={(e) => setNewServerEndpoint(e.target.value)}
                placeholder="https://mcp.example.com/mcp"
                required
              />
            </label>
            <div className="tg-ai-row" style={{ alignItems: 'flex-end' }}>
              <button type="submit" className="tg-btn tg-btn--primary" disabled={addingServer}>
                {addingServer ? 'Adding…' : '+ Register Server · 注册服务器'}
              </button>
            </div>
          </form>

          {mcpServers.length === 0 ? (
            <div className="tg-ai-empty">
              No external MCP servers registered yet. · 尚未注册外部 MCP 服务器。
            </div>
          ) : (
            <div className="tg-ai-grid">
              {mcpServers.map((srv) => (
                <div key={srv.server_id} className="tg-ai-card tg-ai-card--elevated">
                  <div className="tg-ai-row tg-ai-row--between">
                    <strong>{srv.name}</strong>
                    <span
                      className={`tg-ai-badge ${
                        srv.status === 'connected' ? 'tg-ai-badge--success' : ''
                      }`}
                    >
                      {srv.status} · {srv.tools_count} tools
                    </span>
                  </div>
                  <div className="tg-ai-workspace__subtitle">
                    {srv.transport} · <code>{srv.endpoint}</code>
                  </div>
                  <div className="tg-ai-row">
                    <button
                      type="button"
                      className="tg-btn tg-btn--danger"
                      onClick={() => void deleteMcpServer(srv.server_id)}
                    >
                      Remove · 移除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Interactive MCP Tool Runner & High-Risk Approvals */}
        <div className="tg-ai-grid">
          <section className="tg-ai-card">
            <h3 className="tg-ai-card__title">
              🧪 Interactive MCP Tool Runner · 工具调试 ({mcpTools.length})
            </h3>
            {mcpTools.length === 0 ? (
              <div className="tg-ai-empty">
                No MCP tools advertised yet. Connect a live MCP server or browser bridge toolset. · 暂无可用 MCP 工具。
              </div>
            ) : (
              <form
                onSubmit={(e) => void handleInvokeTool(e)}
                style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                <label className="tg-ai-field">
                  <span>Tool · 选择工具</span>
                  <select
                    value={selectedToolName}
                    onChange={(e) => {
                      setSelectedToolName(e.target.value);
                      setArgsJson(BROWSER_TOOL_ARG_TEMPLATES[e.target.value] ?? '{}');
                    }}
                  >
                    {mcpTools.map((tool) => (
                      <option key={tool.tool_id || tool.name} value={tool.name}>
                        {tool.name} ({tool.risk_level})
                      </option>
                    ))}
                  </select>
                </label>

                {selectedTool?.description && (
                  <div className="tg-ai-workspace__subtitle">{selectedTool.description}</div>
                )}

                <label className="tg-ai-field">
                  <span>Arguments JSON · 参数</span>
                  <textarea
                    rows={4}
                    value={argsJson}
                    onChange={(e) => setArgsJson(e.target.value)}
                  />
                </label>

                {jsonError && (
                  <div role="alert" className="tg-secret-leak-alert">
                    {jsonError}
                  </div>
                )}

                <button type="submit" className="tg-btn tg-btn--primary" disabled={invoking}>
                  {invoking ? 'Invoking…' : '▶ Invoke Tool · 执行调用'}
                </button>
              </form>
            )}

            {lastMcpOutput && (
              <pre className="tg-ai-code-block">{JSON.stringify(lastMcpOutput, null, 2)}</pre>
            )}
          </section>

          <section className="tg-ai-card">
            <h3 className="tg-ai-card__title">
              ⚠️ Pending Tool Approvals · 待审批高危调用 ({mcpApprovals.length})
            </h3>
            {mcpApprovals.length === 0 ? (
              <div className="tg-ai-empty">No pending MCP tool approvals · 暂无待审批调用</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {mcpApprovals.map((appr) => (
                  <div key={appr.request_id} className="tg-ai-card tg-ai-card--elevated">
                    <div className="tg-ai-row tg-ai-row--between">
                      <strong>{appr.tool_name}</strong>
                      <span className="tg-ai-badge tg-ai-badge--warning">{appr.status}</span>
                    </div>
                    <pre className="tg-ai-code-block">
                      {JSON.stringify(appr.arguments, null, 2)}
                    </pre>
                    <div className="tg-ai-row">
                      <button
                        type="button"
                        className="tg-btn tg-btn--primary"
                        onClick={() => void handleDecideApproval(appr, true)}
                      >
                        Approve · 允许
                      </button>
                      <button
                        type="button"
                        className="tg-btn tg-btn--danger"
                        onClick={() => void handleDecideApproval(appr, false)}
                      >
                        Deny · 拒绝
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
