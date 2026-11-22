import React, { useEffect, useMemo, useState } from 'react';
import {
  DOM_IDS,
  HERMES_TOOLSET_IDS,
  type HermesKanbanCardDto,
  type HermesStudioTab,
} from '@gpui-telegram/protocol';
import { getClientAdapter } from '../../adapters';
import { describeCronExpression, useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useChatStore } from '../../store/useChatStore';
import { useUiStore } from '../../store/useUiStore';
import { MagpieGatewayPanel } from './MagpieGatewayPanel';

export interface HermesStudioPanelProps {
  onClose?: () => void;
  onOpenMagpie?: () => void;
}

const STUDIO_TAB_META: Array<{ id: HermesStudioTab; label: string; icon: string }> = [
  { id: 'sessions', label: 'Sessions & Providers · 会话与模型', icon: '💬' },
  { id: 'memory', label: 'Memory & Soul · 记忆与灵魂', icon: '🧠' },
  { id: 'skills', label: 'Skills Hub · 技能中心', icon: '⚡' },
  { id: 'toolsets', label: 'Toolsets & Terminal · 工具集与终端', icon: '🛠️' },
  { id: 'cron', label: 'Cron & Heartbeat · 定时与心跳', icon: '⏱️' },
  { id: 'kanban', label: 'Kanban & Approvals · 看板与审批', icon: '📋' },
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

const TOOLSET_DISPLAY_LABELS: Record<string, string> = {
  core: 'core · 核心引擎',
  file: 'filesystem (file) · 文件系统',
  terminal: 'terminal · 终端执行',
  web: 'web_search (web) · 联网搜索',
  browser: 'browser_control (browser) · 浏览器控制',
  mcp: 'mcp · MCP 协议工具',
  memory: 'memory · 持久记忆',
  skills: 'skills · 技能包',
  vision: 'vision · 视觉理解',
  image_gen: 'image_gen · 图像生成',
  video_gen: 'video_gen · 视频生成',
  audio_tts: 'audio_tts · 语音合成',
  audio_stt: 'audio_stt · 语音识别',
  cronjob: 'cronjob · 定时调度',
  subagents: 'subagents · 子智能体',
  code_execution: 'code_execution · 沙箱代码',
  clarify: 'clarify · 澄清提问',
  todo: 'todo · 待办清单',
  planning: 'planning · 多步规划',
  reasoning: 'reasoning · 深度推理',
  kanban: 'kanban · 看板协作',
  desktop_ui: 'desktop_ui · 桌面界面',
  computer_use: 'computer_use · 远程电脑',
  connections: 'connections · 外部连接',
  honcho: 'honcho · 记忆归纳',
  session_search: 'session_search · 会话检索',
  workspace: 'workspace · 工作空间',
  voice: 'voice · 全双工语音',
  platform_im: 'platform_im · 即时通讯桥',
};

const HERMES_MEMORY_BACKUP_KEY = 'gpui_hermes_memory_backup_v1';

interface ConsoleEntry {
  id: string;
  kind: 'prompt' | 'slash';
  input: string;
  thinking: string;
  output: string;
  model: string;
  timestampMs: number;
}

function readLocalMemoryBackup(): { soul?: string; memory?: string; user?: string } | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(HERMES_MEMORY_BACKUP_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as { soul?: string; memory?: string; user?: string };
  } catch {
    return null;
  }
}

function writeLocalMemoryBackup(data: { soul: string; memory: string; user: string }): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(HERMES_MEMORY_BACKUP_KEY, JSON.stringify(data));
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function HermesStudioPanel({
  onClose,
  onOpenMagpie,
}: HermesStudioPanelProps = {}): React.JSX.Element {
  const hermesStudio = useAiWorkspaceStore((s) => s.hermesStudio);
  const activeStudioTab = useAiWorkspaceStore((s) => s.activeStudioTab);
  const hermesCommands = useAiWorkspaceStore((s) => s.hermesCommands);
  const streamingTurn = useAiWorkspaceStore((s) => s.streamingTurn);
  const lastSlashResponse = useAiWorkspaceStore((s) => s.lastSlashResponse);
  const loadHermesStudio = useAiWorkspaceStore((s) => s.loadHermesStudio);
  const setActiveStudioTab = useAiWorkspaceStore((s) => s.setActiveStudioTab);
  const updateStudioTab = useAiWorkspaceStore((s) => s.updateStudioTab);
  const streamPrompt = useAiWorkspaceStore((s) => s.streamPrompt);
  const runSlashCommand = useAiWorkspaceStore((s) => s.runSlashCommand);

  const activeChatId = useChatStore((s) => s.activeChatId);
  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);
  const pushToast = useUiStore((s) => s.pushToast);

  const magpieConfig = useAiWorkspaceStore((s) => s.magpieConfig);
  const loadMagpie = useAiWorkspaceStore((s) => s.loadMagpie);

  const [selectedModel, setSelectedModel] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [promptInput, setPromptInput] = useState('');
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const [magpieModalOpen, setMagpieModalOpen] = useState(false);

  // Memory & Soul drafts
  const [soulDraft, setSoulDraft] = useState('');
  const [memoryDraft, setMemoryDraft] = useState('');
  const [userDraft, setUserDraft] = useState('');
  const [memoryInitialized, setMemoryInitialized] = useState(false);
  const [savingMemory, setSavingMemory] = useState(false);
  const [memorySavedAt, setMemorySavedAt] = useState<number | null>(null);

  // Skills form
  const [skillName, setSkillName] = useState('');
  const [skillDesc, setSkillDesc] = useState('');
  const [skillBody, setSkillBody] = useState('');
  const [disabledSkills, setDisabledSkills] = useState<Record<string, boolean>>({});

  // Toolsets diagnostic log (starts empty; populated by real toolset changes / commands)
  const [terminalCmdInput, setTerminalCmdInput] = useState('');
  const [terminalLog, setTerminalLog] = useState<string[]>([]);

  // Cron form
  const [cronName, setCronName] = useState('');
  const [cronExpr, setCronExpr] = useState('*/30 * * * *');
  const [cronPrompt, setCronPrompt] = useState('');

  // Kanban form & pending approvals
  const [cardTitle, setCardTitle] = useState('');
  const [cardDesc, setCardDesc] = useState('');
  const [cardColumn, setCardColumn] = useState<'todo' | 'in_progress' | 'done'>('todo');
  const [cardPriority, setCardPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium');

  useEffect(() => {
    void loadHermesStudio().catch(() => undefined);
    void loadMagpie().catch(() => undefined);
  }, [loadHermesStudio, loadMagpie]);

  useEffect(() => {
    if (selectedModel) return;
    const statusModel =
      typeof hermesStudio?.status?.active_model === 'string'
        ? hermesStudio.status.active_model
        : '';
    const nextModel = magpieConfig?.activeModel || statusModel;
    if (nextModel) {
      setSelectedModel(nextModel);
    }
  }, [magpieConfig?.activeModel, hermesStudio?.status?.active_model, selectedModel]);

  // Hydrate Memory & Soul drafts when studio snapshot arrives
  useEffect(() => {
    if (!hermesStudio?.memory || memoryInitialized) return;
    const backup = readLocalMemoryBackup();
    const serverSoul = hermesStudio.memory.soul || '';
    const serverMem = hermesStudio.memory.memory?.raw || '';
    const serverUser = hermesStudio.memory.user?.raw || '';

    setSoulDraft(
      getClientAdapter().mode === 'sandbox' && backup?.soul ? backup.soul : serverSoul,
    );
    setMemoryDraft(
      getClientAdapter().mode === 'sandbox' && backup?.memory ? backup.memory : serverMem,
    );
    setUserDraft(
      getClientAdapter().mode === 'sandbox' && backup?.user ? backup.user : serverUser,
    );
    setMemoryInitialized(true);
  }, [hermesStudio?.memory, memoryInitialized]);

  useEffect(() => {
    if (hermesStudio?.sessions?.length && !selectedSessionId) {
      setSelectedSessionId(hermesStudio.sessions[0].session_id);
    }
  }, [hermesStudio?.sessions, selectedSessionId]);

  const handleCloseStudio = () => {
    setActiveNavDest('chats');
    onClose?.();
  };

  const handlePromptSubmit = async (e?: React.FormEvent, overridePrompt?: string) => {
    e?.preventDefault();
    const text = (overridePrompt ?? promptInput).trim();
    if (!text) return;
    if (!overridePrompt) setPromptInput('');

    if (text.startsWith('/')) {
      try {
        const reply = await runSlashCommand(
          text,
          activeChatId ?? undefined,
          selectedSessionId || undefined,
        );
        setConsoleEntries((prev) => [
          ...prev,
          {
            id: `slash_${Date.now()}`,
            kind: 'slash',
            input: text,
            thinking: '',
            output: reply,
            model: selectedModel || 'server',
            timestampMs: Date.now(),
          },
        ]);
      } catch (err) {
        pushToast(err instanceof Error ? err.message : String(err), 'error');
      }
      return;
    }

    try {
      await streamPrompt({
        prompt: text,
        sessionId: selectedSessionId || undefined,
        chatId: activeChatId ?? undefined,
        model: selectedModel || undefined,
      });
      const finished = useAiWorkspaceStore.getState().streamingTurn;
      if (finished) {
        setConsoleEntries((prev) => [
          ...prev,
          {
            id: finished.turnId || `turn_${Date.now()}`,
            kind: 'prompt',
            input: text,
            thinking: finished.thinkingText || '',
            output: finished.outputText,
            model: finished.model || selectedModel || 'default',
            timestampMs: Date.now(),
          },
        ]);
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleCreateNewSession = () => {
    const nextId = `sess_${Date.now().toString(36)}`;
    setSelectedSessionId(nextId);
    setConsoleEntries([]);
    pushToast(`Switched to new Hermes session: ${nextId} · 已新建会话`, 'info');
  };

  const handleSaveMemory = async () => {
    setSavingMemory(true);
    try {
      const clampedMemory = memoryDraft.slice(0, 2200);
      const clampedUser = userDraft.slice(0, 1375);
      writeLocalMemoryBackup({
        soul: soulDraft,
        memory: clampedMemory,
        user: clampedUser,
      });

      // Persist SOUL.md, MEMORY.md, and USER.md atomically via server endpoint
      await updateStudioTab('memory', {
        memory_md: clampedMemory,
        user_md: clampedUser,
        soul_md: soulDraft,
      });

      // Also sync sandbox adapter soul_markdown field when in offline sandbox mode
      if (getClientAdapter().mode === 'sandbox') {
        await updateStudioTab('memory', {
          soul_markdown: soulDraft,
        });
      }

      setMemorySavedAt(Date.now());
      pushToast('Saved SOUL.md & MEMORY.md · 记忆与灵魂设定已保存', 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSavingMemory(false);
    }
  };

  const handleInstallSkill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!skillName.trim() || !skillBody.trim()) return;
    try {
      await updateStudioTab('skills', {
        name: skillName.trim().toLowerCase().replace(/\s+/g, '-'),
        description: skillDesc.trim() || 'Custom Hermes Studio skill',
        body: skillBody.trim(),
        tags: ['custom', 'studio'],
        toolsets: ['core', 'file'],
      });
      setSkillName('');
      setSkillDesc('');
      setSkillBody('');
      pushToast('Skill installed · 技能安装成功', 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const enabledToolsetsSet = useMemo(
    () => new Set(hermesStudio?.enabledToolsets ?? ['core', 'web', 'file', 'memory', 'skills']),
    [hermesStudio?.enabledToolsets],
  );

  const handleToggleToolset = async (toolsetId: string) => {
    const next = new Set(enabledToolsetsSet);
    if (next.has(toolsetId)) {
      next.delete(toolsetId);
    } else {
      next.add(toolsetId);
    }
    const arr = Array.from(next);
    setTerminalLog((prev) => [
      ...prev,
      `$ hermes toolsets set [${arr.length} enabled] (${next.has(toolsetId) ? '+' : '-'}${toolsetId})`,
    ]);
    await updateStudioTab('toolsets', {
      enabled_ids: arr,
      enabled_toolsets: arr,
    }).catch(() => undefined);
  };

  const handleApplyToolsetPreset = async (preset: 'safe' | 'full' | 'minimal') => {
    const nextIds =
      preset === 'full'
        ? [...HERMES_TOOLSET_IDS]
        : preset === 'minimal'
          ? ['core', 'memory', 'clarify']
          : ['core', 'web', 'file', 'memory', 'skills', 'reasoning', 'planning', 'todo', 'mcp'];
    setTerminalLog((prev) => [...prev, `$ hermes toolsets preset --apply=${preset} (${nextIds.length} active)`]);
    await updateStudioTab('toolsets', {
      preset,
      enabled_ids: nextIds,
      enabled_toolsets: nextIds,
    }).catch(() => undefined);
  };

  const handleCreateCronJob = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cronName.trim() || !cronExpr.trim()) return;
    try {
      await updateStudioTab('cron', {
        name: cronName.trim(),
        schedule_expr: cronExpr.trim(),
        prompt: cronPrompt.trim() || `Automated heartbeat check: ${cronName.trim()}`,
        enabled: true,
      });
      setCronName('');
      setCronPrompt('');
      pushToast('Hermes Cron Job scheduled · 定时心跳已创建', 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const primaryBoard = hermesStudio?.kanbanBoards?.[0];
  const kanbanCards = primaryBoard?.cards ?? [];

  const handleAddKanbanCard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cardTitle.trim()) return;
    try {
      await updateStudioTab('kanban', {
        board_id: primaryBoard?.board_id || 'board_main',
        column_id: cardColumn,
        title: cardTitle.trim(),
        description: cardDesc.trim(),
        priority: cardPriority,
      });
      setCardTitle('');
      setCardDesc('');
      pushToast('Added Kanban card · 已添加看板卡片', 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleMoveKanbanCard = async (
    card: HermesKanbanCardDto,
    nextColumn: 'todo' | 'in_progress' | 'done',
  ) => {
    await updateStudioTab('kanban', {
      cardId: card.card_id,
      column_id: nextColumn,
    }).catch(() => undefined);
  };

  return (
    <div id={DOM_IDS.HERMES_STUDIO_PANEL}>
      {/* Studio Header */}
      <div className="tg-workspace-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '18px' }} aria-hidden="true">
            🪽
          </span>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '16px', fontWeight: 700 }}>
                Hermes AI Agent Studio · 智能体六维工作台
              </span>
              <span
                style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: '999px',
                  backgroundColor: 'var(--tg-success-soft)',
                  color: 'var(--tg-success)',
                  fontWeight: 600,
                }}
              >
                ● Runtime Online · {enabledToolsetsSet.size}/29 Toolsets
              </span>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
              SSE Reasoning Stream · Persistent SOUL/MEMORY · Skills · 29 Toolsets · Cron Heartbeat · Kanban
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <select
            className="tg-select"
            aria-label="Active Hermes Model 选择模型"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            style={{ width: 'auto', padding: '6px 10px', fontSize: '12.5px' }}
          >
            {(() => {
              const configured = (magpieConfig?.providers ?? []).filter((p) => p.enabled);
              const options: Array<{ value: string; label: string }> = [];
              const seen = new Set<string>();
              if (magpieConfig?.activeModel) {
                seen.add(magpieConfig.activeModel);
                options.push({
                  value: magpieConfig.activeModel,
                  label: `${magpieConfig.activeModel} (${magpieConfig.activeProvider || 'Active'})`,
                });
              }
              for (const p of configured) {
                if (p.default_model && !seen.has(p.default_model)) {
                  seen.add(p.default_model);
                  options.push({ value: p.default_model, label: `${p.default_model} (${p.name})` });
                }
              }
              if (options.length === 0) {
                return <option value="">未配置模型 · 请打开 Magpie 网关配置</option>;
              }
              return options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ));
            })()}
          </select>

          <button
            type="button"
            className="tg-btn tg-btn--secondary"
            onClick={() => {
              setMagpieModalOpen(true);
              onOpenMagpie?.();
            }}
          >
            🧭 Magpie LLM Gateway · 模型网关
          </button>

          <button
            type="button"
            className="tg-btn tg-btn--secondary"
            aria-label="Back to Chats 返回聊天"
            onClick={handleCloseStudio}
          >
            ← Chats · 返回
          </button>
        </div>
      </div>

      {/* 6 Canonical Studio Tabs */}
      <div className="tg-workspace-tabs" role="tablist" aria-label="Hermes Studio 6 Tabs">
        {STUDIO_TAB_META.map((tab) => {
          const isSelected = activeStudioTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              data-hermes-tab={tab.id}
              className={`tg-workspace-tab${isSelected ? ' is-active' : ''}`}
              onClick={() => setActiveStudioTab(tab.id)}
            >
              {tab.icon} {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab Body */}
      <div className="tg-workspace-content">
        {/* TAB 1: SESSIONS & SSE STREAMING PROMPT CONSOLE */}
        {activeStudioTab === 'sessions' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Interactive SSE Streaming Prompt & /slash Console (FIRST input in DOM!) */}
            <form
              onSubmit={(e) => void handlePromptSubmit(e)}
              className="tg-surface-card"
              style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600 }}>
                  ⚡ SSE Streaming Prompt &amp; /slash Console · 流式推理与斜杠命令台
                </div>
                <span style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                  Session: <code>{selectedSessionId || 'auto'}</code> · {hermesCommands.length} commands ready
                </span>
              </div>

              <textarea
                rows={3}
                className="tg-textarea"
                aria-label="Hermes Prompt or Slash Command 输入提示词或斜杠指令"
                placeholder="Ask Hermes to reason step-by-step, or run /help, /status, /memory, /soul, /skills..."
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handlePromptSubmit();
                  }
                }}
              />

              {/* Quick /slash bar */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  {QUICK_SLASH_COMMANDS.map((cmd) => (
                    <button
                      key={cmd}
                      type="button"
                      className="tg-btn tg-btn--secondary"
                      style={{ padding: '3px 8px', fontSize: '11.5px' }}
                      onClick={() => void handlePromptSubmit(undefined, cmd)}
                    >
                      {cmd}
                    </button>
                  ))}
                </div>

                <button
                  type="submit"
                  className="tg-btn tg-btn--primary"
                  disabled={Boolean(streamingTurn?.isStreaming)}
                >
                  {streamingTurn?.isStreaming ? 'Streaming · 推理中...' : 'Send / Run · 发送运行'}
                </button>
              </div>
            </form>

            {/* Live Streaming Turn & ThinkingBubble */}
            {streamingTurn && (
              <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)' }}>
                  Prompt: <strong>{streamingTurn.prompt}</strong> · Model: <code>{streamingTurn.model}</code>
                </div>

                {(streamingTurn.thinkingText || streamingTurn.isStreaming) && (
                  <div data-testid="thinking-bubble" className="tg-thinking-bubble">
                    <div style={{ fontWeight: 600, color: 'var(--tg-info)', marginBottom: '4px' }}>
                      🧠 Thinking / 思考推理 {streamingTurn.isStreaming ? '(Streaming...)' : '(Completed)'}
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>
                      {streamingTurn.thinkingText || '等待模型返回推理内容…'}
                    </div>
                  </div>
                )}

                {streamingTurn.toolCalls.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {streamingTurn.toolCalls.map((tc) => (
                      <span
                        key={tc.id}
                        style={{
                          fontSize: '11.5px',
                          padding: '3px 8px',
                          borderRadius: '6px',
                          backgroundColor: 'var(--tg-bg-elevated)',
                          border: '1px solid var(--tg-border)',
                        }}
                      >
                        🔧 {tc.name} {tc.durationMs !== undefined ? `(${tc.durationMs}ms)` : ''}
                      </span>
                    ))}
                  </div>
                )}

                <div
                  data-testid="hermes-stream-output"
                  style={{
                    padding: '10px 12px',
                    borderRadius: '8px',
                    backgroundColor: 'var(--tg-bg-elevated)',
                    whiteSpace: 'pre-wrap',
                    fontSize: '13.5px',
                    lineHeight: 1.55,
                  }}
                >
                  {streamingTurn.outputText || (streamingTurn.isStreaming ? 'Generating tokens...' : '')}
                </div>
              </div>
            )}

            {/* Slash Output & Recent Turn History */}
            {(lastSlashResponse || consoleEntries.length > 0) && (
              <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
                  📜 Console Transcript · 控制台输出记录
                </div>

                {lastSlashResponse && consoleEntries.length === 0 && (
                  <pre
                    style={{
                      margin: 0,
                      padding: '10px',
                      borderRadius: '8px',
                      backgroundColor: 'var(--tg-bg-elevated)',
                      whiteSpace: 'pre-wrap',
                      fontSize: '12.5px',
                    }}
                  >
                    {lastSlashResponse}
                  </pre>
                )}

                {consoleEntries
                  .slice()
                  .reverse()
                  .map((entry) => (
                    <div
                      key={entry.id}
                      style={{
                        padding: '10px 12px',
                        borderRadius: '8px',
                        backgroundColor: 'var(--tg-bg-elevated)',
                        border: '1px solid var(--tg-border)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                      }}
                    >
                      <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                        <code>{entry.input}</code> · {entry.model}
                      </div>
                      {entry.kind === 'prompt' && (
                        <div data-testid="thinking-bubble" className="tg-thinking-bubble">
                          <strong>Thinking / 思考推理:</strong> {entry.thinking}
                        </div>
                      )}
                      <div style={{ whiteSpace: 'pre-wrap', fontSize: '13px' }}>{entry.output}</div>
                    </div>
                  ))}
              </div>
            )}

            {/* Sessions List */}
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: '14px', fontWeight: 600 }}>
                  🗂️ Active Hermes Sessions · 会话列表 ({hermesStudio?.sessions?.length ?? 0})
                </div>
                <button
                  type="button"
                  className="tg-btn tg-btn--secondary"
                  onClick={handleCreateNewSession}
                >
                  + New Session · 新建会话
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '8px' }}>
                {(hermesStudio?.sessions ?? []).map((sess) => {
                  const isActive = sess.session_id === selectedSessionId;
                  return (
                    <button
                      key={sess.session_id}
                      type="button"
                      onClick={() => setSelectedSessionId(sess.session_id)}
                      style={{
                        textAlign: 'left',
                        padding: '10px 12px',
                        borderRadius: '8px',
                        backgroundColor: isActive ? 'var(--tg-accent-soft)' : 'var(--tg-bg-elevated)',
                        border: isActive ? '1px solid var(--tg-accent)' : '1px solid var(--tg-border)',
                        color: 'var(--tg-text-primary)',
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: '13px' }}>{sess.title}</div>
                      <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)', marginTop: '3px' }}>
                        <code>{sess.model}</code> · {sess.message_count} msgs · {sess.total_tokens} tok
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: PERSISTENT MEMORY & SOUL */}
        {activeStudioTab === 'memory' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                <div>
                  <div style={{ fontSize: '15px', fontWeight: 600 }}>
                    🧠 Persistent SOUL.md &amp; MEMORY.md · 核心灵魂与持久记忆
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                    Persisted across sessions, tab switches, and browser reloads
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  {memorySavedAt && (
                    <span style={{ fontSize: '12px', color: 'var(--tg-success)' }}>
                      ✓ Saved · 已持久化保存
                    </span>
                  )}
                  <button
                    type="button"
                    className="tg-btn tg-btn--primary"
                    disabled={savingMemory}
                    onClick={() => void handleSaveMemory()}
                  >
                    {savingMemory ? 'Saving...' : 'Save Memory · 保存记忆'}
                  </button>
                </div>
              </div>

              {/* SOUL.md (First textarea in Memory tab) */}
              <div>
                <label style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, marginBottom: '6px' }}>
                  SOUL.md — Agent Identity, Architectural Principles &amp; Persona · 灵魂准则
                </label>
                <textarea
                  rows={5}
                  className="tg-textarea"
                  aria-label="SOUL.md Persona and Principles"
                  placeholder="# Hermes Soul Invariant..."
                  value={soulDraft}
                  onChange={(e) => setSoulDraft(e.target.value)}
                />
              </div>

              {/* MEMORY.md */}
              <div>
                <label style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, marginBottom: '6px' }}>
                  MEMORY.md — Long-Term Facts &amp; Decisions ({memoryDraft.length} / 2200 chars) · 长期记忆
                </label>
                <textarea
                  rows={5}
                  className="tg-textarea"
                  aria-label="MEMORY.md Persistent Memory"
                  placeholder="- Key project facts and user preferences..."
                  value={memoryDraft}
                  onChange={(e) => setMemoryDraft(e.target.value)}
                />
              </div>

              {/* USER.md */}
              <div>
                <label style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, marginBottom: '6px' }}>
                  USER.md — User Context Profile ({userDraft.length} / 1375 chars) · 用户画像
                </label>
                <textarea
                  rows={3}
                  className="tg-textarea"
                  aria-label="USER.md User Profile"
                  placeholder="- Preferred language, workflow habits..."
                  value={userDraft}
                  onChange={(e) => setUserDraft(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: SKILLS HUB */}
        {activeStudioTab === 'skills' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ fontSize: '14.5px', fontWeight: 600 }}>
                ⚡ Installed Hermes Skills · 已安装技能包 ({hermesStudio?.skills?.length ?? 0})
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {(hermesStudio?.skills ?? []).map((skill) => {
                  const isEnabled = disabledSkills[skill.name] ? false : skill.enabled;
                  return (
                    <div
                      key={skill.name}
                      style={{
                        padding: '12px',
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
                      <div style={{ minWidth: 0, flex: '1 1 280px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <strong style={{ fontSize: '13.5px' }}>{skill.name}</strong>
                          <span
                            style={{
                              fontSize: '11px',
                              padding: '1px 7px',
                              borderRadius: '999px',
                              backgroundColor: skill.trusted
                                ? 'var(--tg-success-soft)'
                                : 'var(--tg-warning-soft)',
                              color: skill.trusted ? 'var(--tg-success)' : 'var(--tg-warning)',
                            }}
                          >
                            {skill.trusted ? 'Trusted · 已信任' : 'Quarantined · 待信任'}
                          </span>
                          <span style={{ fontSize: '11px', color: 'var(--tg-text-secondary)' }}>
                            v{skill.version} · risk: {skill.security_risk}
                          </span>
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)', marginTop: '4px' }}>
                          {skill.description}
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={isEnabled}
                          aria-label={`Toggle skill ${skill.name}`}
                          className={`tg-switch${isEnabled ? ' is-checked' : ''}`}
                          onClick={() => {
                            setDisabledSkills((prev) => ({ ...prev, [skill.name]: isEnabled }));
                          }}
                        >
                          <span
                            className="tg-switch-thumb"
                            style={{
                              left: isEnabled ? '20px' : '2px',
                              width: '18px',
                              height: '18px',
                              borderRadius: '50%',
                              backgroundColor: '#FFFFFF',
                              position: 'absolute',
                              top: '2px',
                            }}
                          />
                        </button>

                        {!skill.trusted && (
                          <button
                            type="button"
                            className="tg-btn tg-btn--secondary"
                            style={{ padding: '4px 10px', fontSize: '12px' }}
                            onClick={() =>
                              void updateStudioTab('skills', { trustSkillName: skill.name })
                            }
                          >
                            Trust · 信任
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Install New Skill Form */}
            <form
              onSubmit={(e) => void handleInstallSkill(e)}
              className="tg-surface-card"
              style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
            >
              <div style={{ fontSize: '14px', fontWeight: 600 }}>
                + Install New Skill · 安装新技能 (SKILL.md)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <input
                  type="text"
                  className="tg-input"
                  aria-label="Skill Name 技能名称"
                  placeholder="skill-slug (e.g. rust-audit)"
                  value={skillName}
                  onChange={(e) => setSkillName(e.target.value)}
                />
                <input
                  type="text"
                  className="tg-input"
                  aria-label="Skill Description 技能描述"
                  placeholder="Short description · 技能用途简介"
                  value={skillDesc}
                  onChange={(e) => setSkillDesc(e.target.value)}
                />
              </div>
              <textarea
                rows={3}
                className="tg-textarea"
                aria-label="Skill Markdown Instructions 技能指令正文"
                placeholder="# Skill Instructions..."
                value={skillBody}
                onChange={(e) => setSkillBody(e.target.value)}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button type="submit" className="tg-btn tg-btn--primary">
                  Install Skill · 安装技能
                </button>
              </div>
            </form>
          </div>
        )}

        {/* TAB 4: 29 TOOLSETS & TERMINAL */}
        {activeStudioTab === 'toolsets' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                <div>
                  <div style={{ fontSize: '14.5px', fontWeight: 600 }}>
                    🛠️ 29 Canonical Toolsets Matrix · 工具集矩阵 ({enabledToolsetsSet.size} / {HERMES_TOOLSET_IDS.length} enabled)
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                    filesystem, terminal, web_search, browser_control, mcp, computer_use &amp; full agentic capabilities
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    style={{ padding: '5px 10px', fontSize: '12px' }}
                    onClick={() => void handleApplyToolsetPreset('safe')}
                  >
                    Safe Preset
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    style={{ padding: '5px 10px', fontSize: '12px' }}
                    onClick={() => void handleApplyToolsetPreset('full')}
                  >
                    Enable All 29
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    style={{ padding: '5px 10px', fontSize: '12px' }}
                    onClick={() => void handleApplyToolsetPreset('minimal')}
                  >
                    Minimal
                  </button>
                </div>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(225px, 1fr))',
                  gap: '8px',
                }}
              >
                {HERMES_TOOLSET_IDS.map((id) => {
                  const checked = enabledToolsetsSet.has(id);
                  return (
                    <label
                      key={id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '8px 10px',
                        borderRadius: '8px',
                        backgroundColor: checked ? 'var(--tg-accent-soft)' : 'var(--tg-bg-elevated)',
                        border: checked
                          ? '1px solid var(--tg-accent)'
                          : '1px solid var(--tg-border)',
                        cursor: 'pointer',
                        fontSize: '12.5px',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => void handleToggleToolset(id)}
                      />
                      <span>{TOOLSET_DISPLAY_LABELS[id] || id}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Interactive Command Output Log */}
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>
                💻 Interactive Toolset &amp; Terminal Output Log · 终端诊断日志
              </div>

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const cmd = terminalCmdInput.trim();
                  if (!cmd) return;
                  setTerminalCmdInput('');
                  const slashCmd = cmd.startsWith('/') ? cmd : `/${cmd}`;
                  setTerminalLog((prev) => [...prev, `$ ${slashCmd}`]);
                  try {
                    const reply = await runSlashCommand(
                      slashCmd,
                      activeChatId ?? undefined,
                      selectedSessionId || undefined,
                    );
                    setTerminalLog((prev) => [...prev, reply]);
                  } catch (err) {
                    setTerminalLog((prev) => [
                      ...prev,
                      `[error] ${err instanceof Error ? err.message : String(err)}`,
                    ]);
                  }
                }}
                style={{ display: 'flex', gap: '8px' }}
              >
                <input
                  type="text"
                  className="tg-input"
                  aria-label="Toolset Diagnostic Command 终端命令"
                  placeholder="输入服务端斜杠指令，例如 /status 或 /skills..."
                  value={terminalCmdInput}
                  onChange={(e) => setTerminalCmdInput(e.target.value)}
                />
                <button type="submit" className="tg-btn tg-btn--primary">
                  Run · 执行
                </button>
              </form>

              <pre
                style={{
                  margin: 0,
                  padding: '12px',
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
                {terminalLog.length > 0
                  ? terminalLog.join('\n')
                  : '暂无诊断日志 · 输入 /status 等服务端指令后显示真实输出'}
              </pre>
            </div>
          </div>
        )}

        {/* TAB 5: CRON & HEARTBEAT */}
        {activeStudioTab === 'cron' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <form
              onSubmit={(e) => void handleCreateCronJob(e)}
              className="tg-surface-card"
              style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
            >
              <div style={{ fontSize: '14.5px', fontWeight: 600 }}>
                ⏱️ Create Hermes Scheduled Cron / Heartbeat · 创建定时与心跳任务
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <input
                  type="text"
                  className="tg-input"
                  aria-label="Cron Job Name 任务名称"
                  placeholder="Job Name (e.g. Morning Digest)"
                  value={cronName}
                  onChange={(e) => setCronName(e.target.value)}
                />
                <input
                  type="text"
                  className="tg-input"
                  aria-label="5-Field Cron Expression 定时表达式"
                  placeholder="*/30 * * * * (5-field cron)"
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                />
              </div>

              <input
                type="text"
                className="tg-input"
                aria-label="Cron Prompt 定时执行提示词"
                placeholder="Prompt executed on each heartbeat · 每次触发执行的智能体指令..."
                value={cronPrompt}
                onChange={(e) => setCronPrompt(e.target.value)}
              />

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                  Schedule Preview: <strong>{describeCronExpression(cronExpr)}</strong>
                </span>
                <button type="submit" className="tg-btn tg-btn--primary">
                  Create Cron Job · 创建定时任务
                </button>
              </div>
            </form>

            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>
                Scheduled Heartbeat Jobs · 已配置定时任务 ({hermesStudio?.cronJobs?.length ?? 0})
              </div>

              {(hermesStudio?.cronJobs ?? []).map((job) => (
                <div
                  key={job.job_id}
                  style={{
                    padding: '12px',
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
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '13.5px' }}>
                      {job.name} · <code>{job.schedule_expr}</code>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)', marginTop: '2px' }}>
                      {job.prompt}
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--tg-text-muted)', marginTop: '4px' }}>
                      {describeCronExpression(job.schedule_expr)} · Runs: {job.run_count}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      type="button"
                      className="tg-btn tg-btn--secondary"
                      style={{ padding: '5px 10px', fontSize: '12px' }}
                      onClick={() =>
                        void updateStudioTab('cron', { triggerJobId: job.job_id })
                      }
                    >
                      ▶ Trigger Now
                    </button>
                    <button
                      type="button"
                      className="tg-btn tg-btn--danger-soft"
                      style={{ padding: '5px 10px', fontSize: '12px' }}
                      onClick={() =>
                        void updateStudioTab('cron', { deleteJobId: job.job_id })
                      }
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 6: KANBAN & APPROVALS */}
        {activeStudioTab === 'kanban' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Add Card Form */}
            <form
              onSubmit={(e) => void handleAddKanbanCard(e)}
              className="tg-surface-card"
              style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}
            >
              <input
                type="text"
                className="tg-input"
                aria-label="Kanban Card Title 卡片标题"
                placeholder="New Kanban card title · 新增看板任务标题..."
                value={cardTitle}
                onChange={(e) => setCardTitle(e.target.value)}
                style={{ flex: '1 1 220px' }}
              />
              <input
                type="text"
                className="tg-input"
                aria-label="Kanban Card Description 卡片详情"
                placeholder="Optional details · 详情说明"
                value={cardDesc}
                onChange={(e) => setCardDesc(e.target.value)}
                style={{ flex: '1 1 200px' }}
              />
              <select
                className="tg-select"
                aria-label="Column 所属列"
                value={cardColumn}
                onChange={(e) => setCardColumn(e.target.value as 'todo' | 'in_progress' | 'done')}
                style={{ width: 'auto' }}
              >
                <option value="todo">Todo · 待办</option>
                <option value="in_progress">In Progress · 进行中</option>
                <option value="done">Done · 已完成</option>
              </select>
              <select
                className="tg-select"
                aria-label="Priority 优先级"
                value={cardPriority}
                onChange={(e) =>
                  setCardPriority(e.target.value as 'low' | 'medium' | 'high' | 'urgent')
                }
                style={{ width: 'auto' }}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
              <button type="submit" className="tg-btn tg-btn--primary">
                + Add Card · 添加卡片
              </button>
            </form>

            {/* 3-Column Kanban Board */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(220px, 1fr))',
                gap: '12px',
                overflowX: 'auto',
              }}
            >
              {(
                [
                  { id: 'todo', title: '📌 Todo · 待办', match: ['inbox', 'todo'] },
                  {
                    id: 'in_progress',
                    title: '🚧 In Progress · 进行中',
                    match: ['in_progress', 'review'],
                  },
                  { id: 'done', title: '✅ Done · 已完成', match: ['done'] },
                ] as const
              ).map((col) => {
                const colCards = kanbanCards.filter((c) =>
                  (col.match as readonly string[]).includes(c.column_id),
                );
                return (
                  <div
                    key={col.id}
                    className="tg-surface-card"
                    style={{ display: 'flex', flexDirection: 'column', gap: '10px', minHeight: '240px' }}
                  >
                    <div style={{ fontWeight: 600, fontSize: '13.5px', display: 'flex', justifyContent: 'space-between' }}>
                      <span>{col.title}</span>
                      <span style={{ color: 'var(--tg-text-secondary)' }}>{colCards.length}</span>
                    </div>

                    {colCards.map((card) => (
                      <div
                        key={card.card_id}
                        style={{
                          padding: '10px',
                          borderRadius: '8px',
                          backgroundColor: 'var(--tg-bg-elevated)',
                          border: '1px solid var(--tg-border)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px',
                        }}
                      >
                        <div style={{ fontWeight: 600, fontSize: '13px' }}>{card.title}</div>
                        {card.description && (
                          <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                            {card.description}
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px', marginTop: '4px' }}>
                          <span style={{ fontSize: '11px', color: 'var(--tg-info)' }}>
                            {card.priority.toUpperCase()}
                          </span>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            {col.id !== 'todo' && (
                              <button
                                type="button"
                                className="tg-btn tg-btn--secondary"
                                style={{ padding: '2px 7px', fontSize: '11px' }}
                                onClick={() =>
                                  void handleMoveKanbanCard(
                                    card,
                                    col.id === 'done' ? 'in_progress' : 'todo',
                                  )
                                }
                              >
                                ←
                              </button>
                            )}
                            {col.id !== 'done' && (
                              <button
                                type="button"
                                className="tg-btn tg-btn--secondary"
                                style={{ padding: '2px 7px', fontSize: '11px' }}
                                onClick={() =>
                                  void handleMoveKanbanCard(
                                    card,
                                    col.id === 'todo' ? 'in_progress' : 'done',
                                  )
                                }
                              >
                                →
                              </button>
                            )}
                            <button
                              type="button"
                              className="tg-btn tg-btn--danger-soft"
                              style={{ padding: '2px 7px', fontSize: '11px' }}
                              onClick={() =>
                                void updateStudioTab('kanban', { deleteCardId: card.card_id })
                              }
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>

            {/* Pending Approvals Section */}
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>
                🛡️ Pending Hermes Execution Approvals · 待审批高危动作
              </div>
              {streamingTurn?.pendingApproval ? (
                <div
                  style={{
                    padding: '10px 12px',
                    borderRadius: '8px',
                    backgroundColor: 'var(--tg-warning-soft)',
                    border: '1px solid var(--tg-warning)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {streamingTurn.pendingApproval.toolName}:{' '}
                      <code>{streamingTurn.pendingApproval.command}</code>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                      {streamingTurn.pendingApproval.reason}
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)' }}>
                  No blocked Hermes approvals right now · 当前无待审批的高风险工具请求
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Magpie Gateway Modal Overlay launched directly from Hermes Studio */}
      {magpieModalOpen && (
        <MagpieGatewayPanel asModal onClose={() => setMagpieModalOpen(false)} />
      )}
    </div>
  );
}
