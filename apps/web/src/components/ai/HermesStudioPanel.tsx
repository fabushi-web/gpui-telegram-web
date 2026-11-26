import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CODING_PERMISSION_MODES,
  CODING_PROVIDER_KINDS,
  CODING_PROVIDER_META,
  DOM_IDS,
  HERMES_TOOLSET_IDS,
  ImeSafetyFsm,
  type CodingPermissionMode,
  type CodingProviderKind,
  type HermesKanbanCardDto,
  type HermesStudioTab,
} from '@gpui-telegram/protocol';
import { describeCronExpression, useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useChatStore } from '../../store/useChatStore';
import { useUiStore } from '../../store/useUiStore';
import { MagpieGatewayPanel } from './MagpieGatewayPanel';

export interface HermesStudioPanelProps {
  onClose?: () => void;
  onOpenMagpie?: () => void;
}

type StudioTabWithMagpie = HermesStudioTab | 'magpie';

const STUDIO_TAB_META: Array<{ id: StudioTabWithMagpie; label: string; icon: string }> = [
  { id: 'sessions', label: 'Sessions & Bots · 会话与智能体', icon: '💬' },
  { id: 'memory', label: 'Memory & Soul · 记忆与灵魂', icon: '🧠' },
  { id: 'skills', label: 'Skills Hub · 技能中心', icon: '⚡' },
  { id: 'toolsets', label: 'Toolsets & Terminal · 工具集', icon: '🛠️' },
  { id: 'cron', label: 'Cron & Heartbeat · 定时调度', icon: '⏱️' },
  { id: 'kanban', label: 'Kanban & Approvals · 看板与审批', icon: '📋' },
  { id: 'magpie', label: 'Magpie Providers · 模型网关', icon: '🧭' },
];

const QUICK_SLASH_COMMANDS = [
  '/help',
  '/status',
  '/memory',
  '/soul',
  '/skills',
  '/model',
  '/compact',
  '/branch',
];

const KANBAN_COLUMNS: Array<{ id: string; label: string }> = [
  { id: 'todo', label: 'To Do · 待办' },
  { id: 'in_progress', label: 'In Progress · 进行中' },
  { id: 'done', label: 'Done · 已完成' },
];

export function HermesStudioPanel({
  onClose,
  onOpenMagpie,
}: HermesStudioPanelProps = {}): React.JSX.Element {
  const hermesStudio = useAiWorkspaceStore((s) => s.hermesStudio);
  const activeStudioTab = useAiWorkspaceStore((s) => s.activeStudioTab);
  const hermesApprovals = useAiWorkspaceStore((s) => s.hermesApprovals);
  const hermesProviderError = useAiWorkspaceStore((s) => s.hermesProviderError);
  const streamingTurn = useAiWorkspaceStore((s) => s.streamingTurn);
  const lastSlashResponse = useAiWorkspaceStore((s) => s.lastSlashResponse);
  const fabushiBots = useAiWorkspaceStore((s) => s.fabushiBots);
  const codingHosts = useAiWorkspaceStore((s) => s.codingHosts);
  const codingProbeResult = useAiWorkspaceStore((s) => s.codingProbeResult);
  const groupWorkspaces = useAiWorkspaceStore((s) => s.groupWorkspaces);
  const groupFloors = useAiWorkspaceStore((s) => s.groupFloors);
  const magpieConfig = useAiWorkspaceStore((s) => s.magpieConfig);

  const loadHermesStudio = useAiWorkspaceStore((s) => s.loadHermesStudio);
  const setActiveStudioTab = useAiWorkspaceStore((s) => s.setActiveStudioTab);
  const updateStudioTab = useAiWorkspaceStore((s) => s.updateStudioTab);
  const createHermesSession = useAiWorkspaceStore((s) => s.createHermesSession);
  const branchHermesSession = useAiWorkspaceStore((s) => s.branchHermesSession);
  const compressHermesSession = useAiWorkspaceStore((s) => s.compressHermesSession);
  const toggleHermesSkill = useAiWorkspaceStore((s) => s.toggleHermesSkill);
  const decideHermesApproval = useAiWorkspaceStore((s) => s.decideHermesApproval);
  const streamPrompt = useAiWorkspaceStore((s) => s.streamPrompt);
  const runSlashCommand = useAiWorkspaceStore((s) => s.runSlashCommand);
  const loadMagpie = useAiWorkspaceStore((s) => s.loadMagpie);
  const loadFabushiBots = useAiWorkspaceStore((s) => s.loadFabushiBots);
  const createFabushiBot = useAiWorkspaceStore((s) => s.createFabushiBot);
  const deleteFabushiBot = useAiWorkspaceStore((s) => s.deleteFabushiBot);
  const loadCodingHosts = useAiWorkspaceStore((s) => s.loadCodingHosts);
  const probeCodingAgents = useAiWorkspaceStore((s) => s.probeCodingAgents);
  const loadGroupWorkspace = useAiWorkspaceStore((s) => s.loadGroupWorkspace);
  const putGroupWorkspaceKey = useAiWorkspaceStore((s) => s.putGroupWorkspaceKey);
  const loadGroupFloor = useAiWorkspaceStore((s) => s.loadGroupFloor);

  const activeChatId = useChatStore((s) => s.activeChatId);
  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);
  const pushToast = useUiStore((s) => s.pushToast);

  const [magpieModalOpen, setMagpieModalOpen] = useState(false);

  // Prompt & Session console
  const [promptInput, setPromptInput] = useState('');
  const hermesImeFsmRef = useRef<ImeSafetyFsm>(new ImeSafetyFsm({ sendByEnter: true }));
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [newSessionTitle, setNewSessionTitle] = useState('');

  // Fabushi & Coding Agent Bot creation form
  const [botDisplayName, setBotDisplayName] = useState('');
  const [botUsername, setBotUsername] = useState('');
  const [botDescription, setBotDescription] = useState('');
  const [enableCodingAgent, setEnableCodingAgent] = useState(false);
  const [codingProviderKind, setCodingProviderKind] = useState<CodingProviderKind>('claude_code');
  const [codingWorkspacePath, setCodingWorkspacePath] = useState('');
  const [codingUseWorktree, setCodingUseWorktree] = useState(true);
  const [codingPermissionMode, setCodingPermissionMode] = useState<CodingPermissionMode>('ask');
  const [codingBoundDeviceId, setCodingBoundDeviceId] = useState('');
  const [codingAllowGroupMembers, setCodingAllowGroupMembers] = useState(false);
  const [creatingBot, setCreatingBot] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  // Multi-Agent Workspace KV form
  const [wsKey, setWsKey] = useState('');
  const [wsValue, setWsValue] = useState('');

  // Memory & Soul editors (strictly server-persisted, zero localStorage fallback)
  const [memoryDraft, setMemoryDraft] = useState('');
  const [userDraft, setUserDraft] = useState('');
  const [soulDraft, setSoulDraft] = useState('');

  // Skills install form
  const [skillName, setSkillName] = useState('');
  const [skillDesc, setSkillDesc] = useState('');
  const [skillBody, setSkillBody] = useState('');

  // Cron form
  const [cronName, setCronName] = useState('');
  const [cronExpr, setCronExpr] = useState('0 9 * * *');
  const [cronPrompt, setCronPrompt] = useState('');

  // Kanban card form
  const [cardTitle, setCardTitle] = useState('');
  const [cardColumn, setCardColumn] = useState('todo');

  useEffect(() => {
    void Promise.allSettled([
      loadHermesStudio(),
      loadMagpie(),
      loadFabushiBots(),
      loadCodingHosts(),
    ]);
  }, [loadHermesStudio, loadMagpie, loadFabushiBots, loadCodingHosts]);

  useEffect(() => {
    if (activeChatId) {
      void Promise.allSettled([loadGroupWorkspace(activeChatId), loadGroupFloor(activeChatId)]);
    }
  }, [activeChatId, loadGroupWorkspace, loadGroupFloor]);

  useEffect(() => {
    const onOpenProviders = () => {
      setMagpieModalOpen(true);
    };
    window.addEventListener('hermes:open_ai_providers', onOpenProviders);
    window.addEventListener('gpui:open-magpie-gateway', onOpenProviders);
    return () => {
      window.removeEventListener('hermes:open_ai_providers', onOpenProviders);
      window.removeEventListener('gpui:open-magpie-gateway', onOpenProviders);
    };
  }, []);

  useEffect(() => {
    if (hermesStudio?.memory) {
      setMemoryDraft(hermesStudio.memory.memory.raw ?? '');
      setUserDraft(hermesStudio.memory.user.raw ?? '');
      setSoulDraft(hermesStudio.memory.soul ?? '');
    }
  }, [
    hermesStudio?.memory.memory.raw,
    hermesStudio?.memory.user.raw,
    hermesStudio?.memory.soul,
  ]);

  const openProviderConfig = () => {
    if (onOpenMagpie) onOpenMagpie();
    setMagpieModalOpen(true);
  };

  const handleSubmitPrompt = async (ev?: React.FormEvent) => {
    ev?.preventDefault();
    const text = promptInput.trim();
    if (!text) return;
    setPromptInput('');
    if (text.startsWith('/')) {
      try {
        await runSlashCommand(text, activeChatId ?? undefined, activeSessionId || undefined);
      } catch (err) {
        pushToast(err instanceof Error ? err.message : String(err), 'error');
      }
      return;
    }
    await streamPrompt({
      prompt: text,
      sessionId: activeSessionId || undefined,
      chatId: activeChatId ?? undefined,
      model: magpieConfig?.activeModel || undefined,
    });
  };

  const handleCreateSession = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const title = newSessionTitle.trim() || `Session ${new Date().toLocaleTimeString()}`;
    try {
      const created = await createHermesSession(title, activeChatId ?? undefined);
      setActiveSessionId(created.session_id);
      setNewSessionTitle('');
      pushToast(`Created server session "${created.title}"`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleCreateBot = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!botDisplayName.trim() || !botUsername.trim()) {
      pushToast('Display name and username are required', 'warning');
      return;
    }
    setCreatingBot(true);
    try {
      await createFabushiBot({
        display_name: botDisplayName.trim(),
        username: botUsername.trim(),
        description: botDescription.trim() || undefined,
        coding_agent: enableCodingAgent
          ? {
              provider_kind: codingProviderKind,
              workspace_path: codingWorkspacePath.trim() || '.',
              use_worktree: codingUseWorktree,
              permission_mode: codingPermissionMode,
              extra_args: [],
              bound_device_id: codingBoundDeviceId.trim() || null,
              allow_group_members: codingAllowGroupMembers,
            }
          : null,
      });
      setBotDisplayName('');
      setBotUsername('');
      setBotDescription('');
      pushToast('Created Fabushi Bot cleanly', 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setCreatingBot(false);
    }
  };

  const handleProbeCodingHosts = async () => {
    setProbeError(null);
    try {
      const res = await probeCodingAgents();
      if (!res.ok) {
        setProbeError(res.error || 'No coding agent host responded');
      } else {
        pushToast(`Probed ${res.providers.length} coding agent provider(s)`, 'success');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setProbeError(msg);
      pushToast(msg, 'error');
    }
  };

  const handleToggleToolset = async (toolsetId: string) => {
    const current = new Set(hermesStudio?.enabledToolsets ?? []);
    if (current.has(toolsetId)) current.delete(toolsetId);
    else current.add(toolsetId);
    try {
      await updateStudioTab('toolsets', { enabled_toolsets: Array.from(current) });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const kanbanCards: HermesKanbanCardDto[] = useMemo(() => {
    return (hermesStudio?.kanbanBoards ?? []).flatMap((b) => b.cards ?? []);
  }, [hermesStudio?.kanbanBoards]);

  const activeGroupWorkspace = activeChatId ? groupWorkspaces[activeChatId] : undefined;
  const activeGroupFloor = activeChatId ? groupFloors[activeChatId] : undefined;

  return (
    <section id={DOM_IDS.HERMES_STUDIO_PANEL} className="tg-ai-workspace">
      {/* Header */}
      <header className="tg-ai-workspace__header">
        <div className="tg-ai-workspace__title-group">
          <h2 className="tg-ai-workspace__title">⚡ Fabushi / Hermes AI Studio · 法布施智能体工作台</h2>
          <span className="tg-ai-workspace__subtitle">
            Unified /api/v1/fabushi/* runtime · Multi-Agent Floor · Coding Agent Bots · Magpie v1.6
          </span>
        </div>
        <div className="tg-ai-workspace__actions">
          <button
            type="button"
            className="tg-btn tg-btn--secondary"
            onClick={openProviderConfig}
          >
            🧭 Magpie LLM Gateway · 模型网关
          </button>
          <button
            type="button"
            className="tg-btn tg-btn--ghost"
            onClick={() => void loadHermesStudio()}
          >
            ↻ Refresh
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

      {/* Studio Tabs including [data-hermes-tab="magpie"] */}
      <nav className="tg-hermes-tabs" role="tablist" aria-label="Hermes Studio Sections">
        {STUDIO_TAB_META.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeStudioTab === tab.id}
            data-hermes-tab={tab.id}
            className={`tg-hermes-tab ${
              activeStudioTab === tab.id ? 'tg-hermes-tab--active' : ''
            }`}
            onClick={() => setActiveStudioTab(tab.id)}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>

      <div className="tg-ai-workspace__body">
        {/* TAB 1: Sessions, Prompt Console, Inline PROVIDER_ERROR, Fabushi/Coding Bots & Multi-Agent */}
        {activeStudioTab === 'sessions' && (
          <>
            {/* Prompt & /slash Console — FIRST <textarea> in #hermes-studio-panel */}
            <section className="tg-ai-card">
              <div className="tg-ai-card__header">
                <h3 className="tg-ai-card__title">💬 Prompt & Slash Console · 对话与斜杠命令</h3>
                <div className="tg-ai-row">
                  {QUICK_SLASH_COMMANDS.map((cmd) => (
                    <button
                      key={cmd}
                      type="button"
                      className="tg-catalog-model-btn"
                      onClick={() => {
                        setPromptInput(cmd);
                        void runSlashCommand(cmd, activeChatId ?? undefined, activeSessionId || undefined);
                      }}
                    >
                      {cmd}
                    </button>
                  ))}
                </div>
              </div>

              <form
                onSubmit={(e) => void handleSubmitPrompt(e)}
                style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                <div className="tg-ai-field">
                  <textarea
                    rows={3}
                    value={promptInput}
                    onChange={(e) => setPromptInput(e.target.value)}
                    onCompositionStart={(e) => hermesImeFsmRef.current.onCompositionStart(e.data)}
                    onCompositionUpdate={(e) => hermesImeFsmRef.current.onCompositionUpdate(e.data)}
                    onCompositionEnd={(e) => {
                      hermesImeFsmRef.current.onCompositionEnd(e.data);
                      window.requestAnimationFrame(() => {
                        window.requestAnimationFrame(() => {
                          hermesImeFsmRef.current.resetCommitFence();
                        });
                      });
                    }}
                    onBlur={() => hermesImeFsmRef.current.onCompositionCancel()}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      const rawKeyCode = e.nativeEvent.keyCode || e.keyCode;
                      if (e.nativeEvent.isComposing || rawKeyCode === 229) {
                        hermesImeFsmRef.current.handleKeyDown(
                          {
                            key: e.key,
                            keyCode: rawKeyCode,
                            shiftKey: e.shiftKey,
                            ctrlKey: e.ctrlKey,
                            metaKey: e.metaKey,
                            isComposing: e.nativeEvent.isComposing,
                          },
                          { text: promptInput, sendByEnter: true },
                        );
                        return;
                      }
                      const action = hermesImeFsmRef.current.handleKeyDown(
                        {
                          key: e.key,
                          keyCode: rawKeyCode,
                          shiftKey: e.shiftKey,
                          ctrlKey: e.ctrlKey,
                          metaKey: e.metaKey,
                          isComposing: e.nativeEvent.isComposing,
                        },
                        { text: promptInput, sendByEnter: true },
                      );
                      if (action === 'SendMessage') {
                        e.preventDefault();
                        void handleSubmitPrompt();
                      }
                    }}
                    placeholder="Ask Fabushi AI or enter a /slash command (Enter to send, Shift+Enter for newline)..."
                    aria-label="Fabushi AI Prompt Input"
                  />
                </div>
                <div className="tg-ai-row tg-ai-row--between">
                  <span className="tg-ai-workspace__subtitle">
                    Active Provider:{' '}
                    {magpieConfig?.activeProvider
                      ? `${magpieConfig.activeProvider} / ${magpieConfig.activeModel}`
                      : 'None configured (503 fail-closed)'}
                  </span>
                  <button
                    type="submit"
                    className="tg-btn tg-btn--primary"
                    disabled={Boolean(streamingTurn?.isStreaming)}
                  >
                    {streamingTurn?.isStreaming ? 'Streaming…' : 'Send · 发送'}
                  </button>
                </div>
              </form>

              {/* Inline 503 PROVIDER_ERROR Card */}
              {hermesProviderError && (
                <div
                  role="alert"
                  data-testid="provider-error-card"
                  data-error-code="PROVIDER_ERROR"
                  className="tg-provider-error-card provider-error-card"
                >
                  <div className="tg-provider-error-title">
                    ⚠️ PROVIDER_ERROR ({hermesProviderError.error}) · 未配置模型供应商
                  </div>
                  <div className="tg-provider-error-body">{hermesProviderError.message}</div>
                  <div>
                    <button
                      type="button"
                      className="tg-btn tg-btn--primary"
                      onClick={openProviderConfig}
                    >
                      Configure AI Provider · 配置模型供应商
                    </button>
                  </div>
                </div>
              )}

              {/* Live Streaming Output */}
              {streamingTurn && !hermesProviderError && (
                <div className="tg-ai-card tg-ai-card--elevated">
                  <div className="tg-ai-row tg-ai-row--between">
                    <strong>
                      {streamingTurn.isStreaming ? '⏳ Streaming Response…' : '✅ Turn Complete'}
                    </strong>
                    <span className="tg-ai-badge">
                      {streamingTurn.provider || 'fabushi'} · {streamingTurn.model || '—'}
                    </span>
                  </div>
                  {streamingTurn.thinkingText && (
                    <div className="tg-thinking-bubble">{streamingTurn.thinkingText}</div>
                  )}
                  {streamingTurn.outputText && (
                    <pre className="tg-ai-code-block">{streamingTurn.outputText}</pre>
                  )}
                  {streamingTurn.error && (
                    <div role="alert" className="tg-secret-leak-alert">
                      {streamingTurn.error}
                    </div>
                  )}
                </div>
              )}

              {lastSlashResponse && (
                <pre className="tg-ai-code-block">{lastSlashResponse}</pre>
              )}
            </section>

            {/* Server-Persisted Sessions */}
            <section className="tg-ai-card">
              <div className="tg-ai-card__header">
                <h3 className="tg-ai-card__title">
                  🗂️ Server-Persisted Sessions · 持久化会话 ({hermesStudio?.sessions.length ?? 0})
                </h3>
                <form onSubmit={(e) => void handleCreateSession(e)} className="tg-ai-row">
                  <input
                    type="text"
                    value={newSessionTitle}
                    onChange={(e) => setNewSessionTitle(e.target.value)}
                    placeholder="New session title..."
                    style={{
                      background: 'var(--tg-bg-input)',
                      color: 'var(--tg-text-primary)',
                      border: '1px solid var(--tg-border)',
                      borderRadius: 8,
                      padding: '6px 10px',
                      fontSize: 12,
                    }}
                  />
                  <button type="submit" className="tg-btn tg-btn--primary">
                    + New Session · 新建会话
                  </button>
                </form>
              </div>

              {(hermesStudio?.sessions ?? []).length === 0 ? (
                <div className="tg-ai-empty">No persisted sessions yet · 暂无持久化会话</div>
              ) : (
                <div className="tg-ai-grid">
                  {(hermesStudio?.sessions ?? []).map((sess) => (
                    <div key={sess.session_id} className="tg-ai-card tg-ai-card--elevated">
                      <div className="tg-ai-row tg-ai-row--between">
                        <strong>{sess.title}</strong>
                        <span className="tg-ai-badge">
                          {sess.message_count} msgs · {sess.total_tokens} tok
                        </span>
                      </div>
                      <div className="tg-ai-workspace__subtitle">
                        ID: <code>{sess.session_id}</code>
                      </div>
                      <div className="tg-ai-row">
                        <button
                          type="button"
                          className={`tg-btn ${
                            activeSessionId === sess.session_id
                              ? 'tg-btn--primary'
                              : 'tg-btn--secondary'
                          }`}
                          onClick={() => setActiveSessionId(sess.session_id)}
                        >
                          {activeSessionId === sess.session_id ? 'Active' : 'Select'}
                        </button>
                        <button
                          type="button"
                          className="tg-btn tg-btn--ghost"
                          onClick={() => void branchHermesSession(sess.session_id)}
                        >
                          Branch
                        </button>
                        <button
                          type="button"
                          className="tg-btn tg-btn--ghost"
                          onClick={() => void compressHermesSession(sess.session_id)}
                        >
                          Compress
                        </button>
                        <button
                          type="button"
                          className="tg-btn tg-btn--danger"
                          onClick={() =>
                            void updateStudioTab('sessions', { deleteSessionId: sess.session_id })
                          }
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Fabushi & Coding Agent Bots Panel */}
            <section className="tg-ai-card">
              <div className="tg-ai-card__header">
                <h3 className="tg-ai-card__title">
                  🤖 Fabushi & Coding Agent Bots · 智能体与编程机器人 ({fabushiBots.length})
                </h3>
                <button
                  type="button"
                  className="tg-btn tg-btn--secondary"
                  onClick={() => void handleProbeCodingHosts()}
                >
                  🔍 Probe Coding Hosts · 探测编程主机
                </button>
              </div>

              {probeError && (
                <div role="alert" className="tg-secret-leak-alert">
                  {probeError}
                </div>
              )}

              {codingProbeResult && (
                <div className="tg-ai-card tg-ai-card--elevated">
                  <strong>
                    Coding Probe ({codingProbeResult.device_id || 'local'}):{' '}
                    {codingProbeResult.providers.length} provider(s)
                  </strong>
                  <div className="tg-ai-row">
                    {codingProbeResult.providers.map((p) => (
                      <span
                        key={p.kind}
                        className={`tg-ai-badge ${
                          p.installed ? 'tg-ai-badge--success' : ''
                        }`}
                      >
                        {p.display_name}: {p.installed ? p.version || 'installed' : 'not found'}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {codingHosts.length > 0 && (
                <div className="tg-ai-row">
                  {codingHosts.map((host) => (
                    <span key={host.device_id} className="tg-ai-badge tg-ai-badge--info">
                      Host: {host.display_name} ({host.os_name}) · {host.providers.length} CLIs
                    </span>
                  ))}
                </div>
              )}

              <form
                onSubmit={(e) => void handleCreateBot(e)}
                style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                <div className="tg-ai-field-grid">
                  <label className="tg-ai-field">
                    <span>Bot Display Name · 机器人名称</span>
                    <input
                      type="text"
                      value={botDisplayName}
                      onChange={(e) => setBotDisplayName(e.target.value)}
                      placeholder="Claude Code Reviewer"
                      required
                    />
                  </label>
                  <label className="tg-ai-field">
                    <span>Bot @username (ending with _bot)</span>
                    <input
                      type="text"
                      value={botUsername}
                      onChange={(e) => setBotUsername(e.target.value)}
                      placeholder="claude_reviewer_bot"
                      required
                    />
                  </label>
                  <label className="tg-ai-field">
                    <span>Description · 描述</span>
                    <input
                      type="text"
                      value={botDescription}
                      onChange={(e) => setBotDescription(e.target.value)}
                      placeholder="Automated code review & workspace edits"
                    />
                  </label>
                </div>

                <label className="tg-ai-row" style={{ cursor: 'pointer', fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={enableCodingAgent}
                    onChange={(e) => setEnableCodingAgent(e.target.checked)}
                  />
                  <span>Enable Coding Agent Bot Configuration · 启用编程智能体配置 (6 Providers)</span>
                </label>

                {enableCodingAgent && (
                  <div className="tg-ai-field-grid">
                    <label className="tg-ai-field">
                      <span>Coding Provider</span>
                      <select
                        value={codingProviderKind}
                        onChange={(e) =>
                          setCodingProviderKind(e.target.value as CodingProviderKind)
                        }
                      >
                        {CODING_PROVIDER_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {CODING_PROVIDER_META[kind].display_name} ({kind})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="tg-ai-field">
                      <span>Workspace Path</span>
                      <input
                        type="text"
                        value={codingWorkspacePath}
                        onChange={(e) => setCodingWorkspacePath(e.target.value)}
                        placeholder="/path/to/repo"
                      />
                    </label>
                    <label className="tg-ai-field">
                      <span>Permission Mode</span>
                      <select
                        value={codingPermissionMode}
                        onChange={(e) =>
                          setCodingPermissionMode(e.target.value as CodingPermissionMode)
                        }
                      >
                        {CODING_PERMISSION_MODES.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="tg-ai-field">
                      <span>Bound Device ID (Optional)</span>
                      <input
                        type="text"
                        value={codingBoundDeviceId}
                        onChange={(e) => setCodingBoundDeviceId(e.target.value)}
                        placeholder="dev_workstation_1"
                      />
                    </label>
                    <label className="tg-ai-row" style={{ cursor: 'pointer', fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={codingUseWorktree}
                        onChange={(e) => setCodingUseWorktree(e.target.checked)}
                      />
                      <span>Use Git Worktree Isolation</span>
                    </label>
                    <label className="tg-ai-row" style={{ cursor: 'pointer', fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={codingAllowGroupMembers}
                        onChange={(e) => setCodingAllowGroupMembers(e.target.checked)}
                      />
                      <span>Allow Group Members</span>
                    </label>
                  </div>
                )}

                <div>
                  <button type="submit" className="tg-btn tg-btn--primary" disabled={creatingBot}>
                    {creatingBot ? 'Creating…' : '+ Create Bot · 创建机器人'}
                  </button>
                </div>
              </form>

              {fabushiBots.length > 0 && (
                <div className="tg-ai-grid">
                  {fabushiBots.map((bot) => (
                    <div key={bot.bot_user_id} className="tg-ai-card tg-ai-card--elevated">
                      <div className="tg-ai-row tg-ai-row--between">
                        <strong>{bot.display_name}</strong>
                        <span className="tg-ai-badge tg-ai-badge--accent">
                          {bot.coding_agent
                            ? CODING_PROVIDER_META[bot.coding_agent.provider_kind]?.display_name ||
                              bot.coding_agent.provider_kind
                            : 'Fabushi Bot'}
                        </span>
                      </div>
                      <div className="tg-ai-workspace__subtitle">
                        @{bot.username} {bot.description ? `· ${bot.description}` : ''}
                      </div>
                      <button
                        type="button"
                        className="tg-btn tg-btn--danger"
                        onClick={() => void deleteFabushiBot(bot.bot_user_id)}
                      >
                        Delete · 删除
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Multi-Agent Group Shared Workspace & Floor Inspector */}
            {activeChatId && (
              <section className="tg-ai-card">
                <div className="tg-ai-card__header">
                  <h3 className="tg-ai-card__title">
                    🤝 Multi-Agent Group Workspace & Floor (Chat #{activeChatId})
                  </h3>
                  <button
                    type="button"
                    className="tg-btn tg-btn--ghost"
                    onClick={() =>
                      void Promise.allSettled([
                        loadGroupWorkspace(activeChatId),
                        loadGroupFloor(activeChatId),
                      ])
                    }
                  >
                    ↻ Sync
                  </button>
                </div>

                <div className="tg-ai-row">
                  <span className="tg-ai-badge tg-ai-badge--info">
                    Current Speaker: {activeGroupFloor?.current_speaker ?? 'Idle'}
                  </span>
                  <span className="tg-ai-badge">
                    Queue: {activeGroupFloor?.queued_count ?? 0}
                  </span>
                  <span className="tg-ai-badge">
                    Loop Hops: {activeGroupFloor?.loop_hops ?? 0} / 5
                  </span>
                  <span className="tg-ai-badge">
                    Workspace Rev #{activeGroupWorkspace?.revision ?? 0}
                  </span>
                </div>

                <div className="tg-ai-row">
                  <input
                    type="text"
                    value={wsKey}
                    onChange={(e) => setWsKey(e.target.value)}
                    placeholder="Key (e.g. sprint_goal)"
                    style={{
                      background: 'var(--tg-bg-input)',
                      color: 'var(--tg-text-primary)',
                      border: '1px solid var(--tg-border)',
                      borderRadius: 8,
                      padding: '6px 10px',
                      fontSize: 12,
                    }}
                  />
                  <input
                    type="text"
                    value={wsValue}
                    onChange={(e) => setWsValue(e.target.value)}
                    placeholder="JSON or string value"
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
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    disabled={!wsKey.trim()}
                    onClick={async () => {
                      await putGroupWorkspaceKey(activeChatId, wsKey.trim(), wsValue);
                      setWsKey('');
                      setWsValue('');
                    }}
                  >
                    Save KV · 写入共享键
                  </button>
                </div>

                <pre className="tg-ai-code-block">
                  {JSON.stringify(activeGroupWorkspace?.entries ?? {}, null, 2)}
                </pre>
              </section>
            )}
          </>
        )}

        {/* TAB 2: Server-Persisted Memory & Soul */}
        {activeStudioTab === 'memory' && (
          <section className="tg-ai-card">
            <h3 className="tg-ai-card__title">🧠 Server-Persisted Memory & Soul · 持久记忆</h3>
            <label className="tg-ai-field">
              <span>MEMORY.md ({memoryDraft.length} / 2200 chars)</span>
              <textarea
                rows={5}
                value={memoryDraft}
                onChange={(e) => setMemoryDraft(e.target.value)}
              />
            </label>
            <label className="tg-ai-field">
              <span>USER.md ({userDraft.length} / 1375 chars)</span>
              <textarea
                rows={4}
                value={userDraft}
                onChange={(e) => setUserDraft(e.target.value)}
              />
            </label>
            <div className="tg-ai-row">
              <button
                type="button"
                className="tg-btn tg-btn--primary"
                onClick={async () => {
                  await updateStudioTab('memory', { memory_raw: memoryDraft, user_raw: userDraft });
                  pushToast('Saved MEMORY.md & USER.md to server', 'success');
                }}
              >
                Save Memory · 保存记忆
              </button>
            </div>

            <label className="tg-ai-field">
              <span>SOUL.md · 系统人格</span>
              <textarea
                rows={4}
                value={soulDraft}
                onChange={(e) => setSoulDraft(e.target.value)}
              />
            </label>
            <div className="tg-ai-row">
              <button
                type="button"
                className="tg-btn tg-btn--secondary"
                onClick={async () => {
                  await updateStudioTab('memory', { soul_markdown: soulDraft });
                  pushToast('Saved SOUL.md to server', 'success');
                }}
              >
                Save Soul · 保存人格
              </button>
            </div>
          </section>
        )}

        {/* TAB 3: Server-Persisted Skills Hub */}
        {activeStudioTab === 'skills' && (
          <section className="tg-ai-card">
            <h3 className="tg-ai-card__title">
              ⚡ Skills Hub · 技能中心 ({hermesStudio?.skills.length ?? 0})
            </h3>

            <div className="tg-ai-field-grid">
              <label className="tg-ai-field">
                <span>Skill Name</span>
                <input
                  type="text"
                  value={skillName}
                  onChange={(e) => setSkillName(e.target.value)}
                  placeholder="code-auditor"
                />
              </label>
              <label className="tg-ai-field">
                <span>Description</span>
                <input
                  type="text"
                  value={skillDesc}
                  onChange={(e) => setSkillDesc(e.target.value)}
                  placeholder="Audit PR diffs for security issues"
                />
              </label>
            </div>
            <label className="tg-ai-field">
              <span>Skill Instructions Markdown</span>
              <textarea
                rows={3}
                value={skillBody}
                onChange={(e) => setSkillBody(e.target.value)}
                placeholder="Write skill instructions..."
              />
            </label>
            <div>
              <button
                type="button"
                className="tg-btn tg-btn--primary"
                disabled={!skillName.trim()}
                onClick={async () => {
                  await updateStudioTab('skills', {
                    name: skillName.trim(),
                    description: skillDesc.trim(),
                    body: skillBody,
                  });
                  setSkillName('');
                  setSkillDesc('');
                  setSkillBody('');
                  pushToast('Installed skill on server', 'success');
                }}
              >
                + Install Skill · 安装技能
              </button>
            </div>

            {(hermesStudio?.skills ?? []).length === 0 ? (
              <div className="tg-ai-empty">No skills installed yet · 暂无已安装技能</div>
            ) : (
              <div className="tg-ai-grid">
                {(hermesStudio?.skills ?? []).map((skill) => (
                  <div key={skill.name} className="tg-ai-card tg-ai-card--elevated">
                    <div className="tg-ai-row tg-ai-row--between">
                      <strong>{skill.name}</strong>
                      <span
                        className={`tg-ai-badge ${
                          skill.enabled ? 'tg-ai-badge--success' : ''
                        }`}
                      >
                        {skill.enabled ? 'Enabled' : 'Disabled'} · {skill.status}
                      </span>
                    </div>
                    <div className="tg-ai-workspace__subtitle">{skill.description}</div>
                    <div className="tg-ai-row">
                      <button
                        type="button"
                        className="tg-btn tg-btn--secondary"
                        onClick={() => void toggleHermesSkill(skill.name, !skill.enabled)}
                      >
                        {skill.enabled ? 'Disable · 停用' : 'Enable · 启用'}
                      </button>
                      {!skill.trusted && (
                        <button
                          type="button"
                          className="tg-btn tg-btn--secondary"
                          onClick={() =>
                            void updateStudioTab('skills', { trustSkillName: skill.name })
                          }
                        >
                          Trust · 信任
                        </button>
                      )}
                      <button
                        type="button"
                        className="tg-btn tg-btn--danger"
                        onClick={() =>
                          void updateStudioTab('skills', { deleteSkillName: skill.name })
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* TAB 4: Toolsets */}
        {activeStudioTab === 'toolsets' && (
          <section className="tg-ai-card">
            <h3 className="tg-ai-card__title">
              🛠️ Canonical Toolsets ({hermesStudio?.enabledToolsets.length ?? 0} /{' '}
              {HERMES_TOOLSET_IDS.length} enabled)
            </h3>
            <div className="tg-ai-row">
              {HERMES_TOOLSET_IDS.map((id) => {
                const enabled = (hermesStudio?.enabledToolsets ?? []).includes(id);
                return (
                  <button
                    key={id}
                    type="button"
                    className={`tg-btn ${enabled ? 'tg-btn--primary' : 'tg-btn--ghost'}`}
                    onClick={() => void handleToggleToolset(id)}
                  >
                    {enabled ? '✓ ' : ''}
                    {id}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* TAB 5: Cron */}
        {activeStudioTab === 'cron' && (
          <section className="tg-ai-card">
            <h3 className="tg-ai-card__title">
              ⏱️ Cron & Heartbeat Jobs ({hermesStudio?.cronJobs.length ?? 0})
            </h3>
            <div className="tg-ai-field-grid">
              <label className="tg-ai-field">
                <span>Job Name</span>
                <input
                  type="text"
                  value={cronName}
                  onChange={(e) => setCronName(e.target.value)}
                  placeholder="Daily Digest"
                />
              </label>
              <label className="tg-ai-field">
                <span>Schedule Expression</span>
                <input
                  type="text"
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                />
              </label>
              <label className="tg-ai-field">
                <span>Prompt</span>
                <input
                  type="text"
                  value={cronPrompt}
                  onChange={(e) => setCronPrompt(e.target.value)}
                  placeholder="Summarize unread engineering notes"
                />
              </label>
            </div>
            <div>
              <button
                type="button"
                className="tg-btn tg-btn--primary"
                disabled={!cronName.trim() || !cronPrompt.trim()}
                onClick={async () => {
                  await updateStudioTab('cron', {
                    name: cronName.trim(),
                    schedule_expr: cronExpr.trim(),
                    prompt: cronPrompt.trim(),
                  });
                  setCronName('');
                  setCronPrompt('');
                  pushToast('Created cron job', 'success');
                }}
              >
                + Add Cron Job
              </button>
            </div>
            {(hermesStudio?.cronJobs ?? []).length === 0 ? (
              <div className="tg-ai-empty">No scheduled cron jobs · 暂无定时任务</div>
            ) : (
              <div className="tg-ai-grid">
                {(hermesStudio?.cronJobs ?? []).map((job) => (
                  <div key={job.job_id} className="tg-ai-card tg-ai-card--elevated">
                    <strong>{job.name}</strong>
                    <div className="tg-ai-workspace__subtitle">
                      {describeCronExpression(job.schedule_expr)} · Runs: {job.run_count}
                    </div>
                    <div className="tg-ai-row">
                      <button
                        type="button"
                        className="tg-btn tg-btn--secondary"
                        onClick={() => void updateStudioTab('cron', { triggerJobId: job.job_id })}
                      >
                        ▶ Trigger
                      </button>
                      <button
                        type="button"
                        className="tg-btn tg-btn--danger"
                        onClick={() => void updateStudioTab('cron', { deleteJobId: job.job_id })}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* TAB 6: Kanban & Real Server Approvals Queue */}
        {activeStudioTab === 'kanban' && (
          <>
            <section className="tg-ai-card">
              <h3 className="tg-ai-card__title">
                🛡️ Real Server Approvals Queue · 审批队列 ({hermesApprovals.length})
              </h3>
              {hermesApprovals.length === 0 ? (
                <div className="tg-ai-empty">No pending security approvals · 暂无待审批操作</div>
              ) : (
                <div className="tg-ai-grid">
                  {hermesApprovals.map((appr) => (
                    <div key={appr.approval_id} className="tg-ai-card tg-ai-card--elevated">
                      <div className="tg-ai-row tg-ai-row--between">
                        <strong>{appr.tool_name}</strong>
                        <span className="tg-ai-badge tg-ai-badge--warning">
                          {appr.risk_level} · {appr.status}
                        </span>
                      </div>
                      <pre className="tg-ai-code-block">{appr.command}</pre>
                      <div className="tg-ai-workspace__subtitle">{appr.reason}</div>
                      {appr.status === 'pending' && (
                        <div className="tg-ai-row">
                          <button
                            type="button"
                            className="tg-btn tg-btn--primary"
                            onClick={() =>
                              void decideHermesApproval(appr.approval_id, 'approve_once')
                            }
                          >
                            Approve · 允许
                          </button>
                          <button
                            type="button"
                            className="tg-btn tg-btn--danger"
                            onClick={() => void decideHermesApproval(appr.approval_id, 'deny')}
                          >
                            Deny · 拒绝
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="tg-ai-card">
              <h3 className="tg-ai-card__title">📋 Kanban Board · 任务看板</h3>
              <div className="tg-ai-row">
                <input
                  type="text"
                  value={cardTitle}
                  onChange={(e) => setCardTitle(e.target.value)}
                  placeholder="New card title..."
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
                <select
                  value={cardColumn}
                  onChange={(e) => setCardColumn(e.target.value)}
                  style={{
                    background: 'var(--tg-bg-input)',
                    color: 'var(--tg-text-primary)',
                    border: '1px solid var(--tg-border)',
                    borderRadius: 8,
                    padding: '6px 10px',
                    fontSize: 12,
                  }}
                >
                  {KANBAN_COLUMNS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="tg-btn tg-btn--primary"
                  disabled={!cardTitle.trim()}
                  onClick={async () => {
                    await updateStudioTab('kanban', {
                      title: cardTitle.trim(),
                      column_id: cardColumn,
                    });
                    setCardTitle('');
                  }}
                >
                  + Add Card
                </button>
              </div>
              <div className="tg-ai-grid">
                {KANBAN_COLUMNS.map((col) => {
                  const colCards = kanbanCards.filter((c) => c.column_id === col.id);
                  return (
                    <div key={col.id} className="tg-ai-card tg-ai-card--elevated">
                      <strong>
                        {col.label} ({colCards.length})
                      </strong>
                      {colCards.map((card) => (
                        <div key={card.card_id} className="tg-ai-card">
                          <div className="tg-ai-row tg-ai-row--between">
                            <span>{card.title}</span>
                            <button
                              type="button"
                              className="tg-btn tg-btn--ghost"
                              onClick={() =>
                                void updateStudioTab('kanban', { deleteCardId: card.card_id })
                              }
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )}

        {/* TAB 7: Embedded Magpie Providers Gateway */}
        {activeStudioTab === 'magpie' && <MagpieGatewayPanel embedded />}
      </div>

      {magpieModalOpen && (
        <MagpieGatewayPanel asModal onClose={() => setMagpieModalOpen(false)} />
      )}
    </section>
  );
}
