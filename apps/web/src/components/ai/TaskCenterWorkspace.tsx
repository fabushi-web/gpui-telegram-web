import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DOM_IDS, type TaskFsmState, type TaskItemDto } from '@gpui-telegram/protocol';
import { describeCronExpression, useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useChatStore } from '../../store/useChatStore';
import { useUiStore } from '../../store/useUiStore';

export interface TaskCenterWorkspaceProps {
  onClose?: () => void;
}

type FilterPillId = 'all' | Exclude<TaskFsmState, 'draft'>;

const FSM_FILTER_PILLS: Array<{ id: FilterPillId; label: string }> = [
  { id: 'all', label: 'All · 全部' },
  { id: 'queued', label: 'Queued · 排队中' },
  { id: 'running', label: 'Running · 运行中' },
  { id: 'waiting_approval', label: 'Waiting Approval · 待审批' },
  { id: 'paused', label: 'Paused · 已暂停' },
  { id: 'completed', label: 'Completed · 已完成' },
  { id: 'failed', label: 'Failed · 失败' },
  { id: 'cancelled', label: 'Cancelled · 已取消' },
];

interface CronValidationResult {
  valid: boolean;
  error?: string;
  nextRunPreview?: string;
}

function validateFieldToken(token: string, min: number, max: number): boolean {
  if (token === '*') return true;
  const segments = token.split(',');
  for (const seg of segments) {
    if (!seg) return false;
    const stepParts = seg.split('/');
    if (stepParts.length > 2) return false;
    const [rangePart, stepStr] = stepParts;
    if (stepStr !== undefined) {
      const stepNum = Number(stepStr);
      if (!Number.isInteger(stepNum) || stepNum <= 0 || stepNum > max) return false;
    }
    if (rangePart === '*') continue;
    if (rangePart.includes('-')) {
      const [startStr, endStr] = rangePart.split('-');
      const start = Number(startStr);
      const end = Number(endStr);
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < min ||
        end > max ||
        start > end
      ) {
        return false;
      }
    } else {
      const val = Number(rangePart);
      if (!Number.isInteger(val) || val < min || val > max) return false;
    }
  }
  return true;
}

export function validateFiveFieldCron(rawExpr: string): CronValidationResult {
  const expr = rawExpr.trim();
  if (!expr) {
    return { valid: true, nextRunPreview: 'Manual / immediate trigger · 手动或立即触发' };
  }
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) {
    return {
      valid: false,
      error: `Expected 5 cron fields (min hour dom mon dow), received ${fields.length}`,
    };
  }
  const bounds: Array<[number, number, string]> = [
    [0, 59, 'minute'],
    [0, 23, 'hour'],
    [1, 31, 'day-of-month'],
    [1, 12, 'month'],
    [0, 7, 'day-of-week'],
  ];
  for (let i = 0; i < 5; i++) {
    const [min, max, name] = bounds[i];
    if (!validateFieldToken(fields[i], min, max)) {
      return { valid: false, error: `Invalid ${name} field "${fields[i]}" (${min}..${max})` };
    }
  }
  return {
    valid: true,
    nextRunPreview: describeCronExpression(expr),
  };
}

const STATE_BADGE_CLASS: Record<TaskFsmState, string> = {
  draft: '',
  queued: 'tg-ai-badge--info',
  running: 'tg-ai-badge--accent',
  waiting_approval: 'tg-ai-badge--warning',
  paused: '',
  completed: 'tg-ai-badge--success',
  failed: 'tg-ai-badge--danger',
  cancelled: '',
};

export function TaskCenterWorkspace({
  onClose,
}: TaskCenterWorkspaceProps = {}): React.JSX.Element {
  const tasks = useAiWorkspaceStore((s) => s.tasks);
  const loadTasks = useAiWorkspaceStore((s) => s.loadTasks);
  const createTask = useAiWorkspaceStore((s) => s.createTask);
  const updateTask = useAiWorkspaceStore((s) => s.updateTask);
  const deleteTask = useAiWorkspaceStore((s) => s.deleteTask);

  const activeChatId = useChatStore((s) => s.activeChatId);
  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);
  const pushToast = useUiStore((s) => s.pushToast);

  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterPillId>('all');
  const [showCreateForm, setShowCreateForm] = useState(true);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [cronExpr, setCronExpr] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void loadTasks().catch(() => undefined);
  }, [loadTasks]);

  const cronValidation = useMemo(() => validateFiveFieldCron(cronExpr), [cronExpr]);

  const filteredTasks = useMemo(() => {
    if (activeFilter === 'all') return tasks;
    return tasks.filter((t) => t.state === activeFilter);
  }, [tasks, activeFilter]);

  const handleOpenCreateForm = () => {
    setShowCreateForm(true);
    window.setTimeout(() => {
      titleInputRef.current?.focus();
    }, 0);
  };

  const handleCreateTask = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      pushToast('Task title is required · 请填写任务标题', 'warning');
      return;
    }
    if (!cronValidation.valid) {
      pushToast(cronValidation.error ?? 'Invalid cron expression', 'error');
      return;
    }
    setCreating(true);
    try {
      await createTask({
        title: cleanTitle,
        description: description.trim() || undefined,
        cronExpr: cronExpr.trim() || undefined,
        chatId: activeChatId ?? undefined,
      });
      setTitle('');
      setDescription('');
      setCronExpr('');
      pushToast(`Created task "${cleanTitle}"`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleTransition = async (task: TaskItemDto, nextState: TaskFsmState) => {
    try {
      await updateTask(task.task_id, { state: nextState });
      pushToast(`Task "${task.title}" → ${nextState}`, 'info');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleDelete = async (task: TaskItemDto) => {
    try {
      await deleteTask(task.task_id);
      pushToast(`Deleted task "${task.title}"`, 'info');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <section id={DOM_IDS.TASK_CENTER_WORKSPACE} className="tg-ai-workspace">
      <header className="tg-ai-workspace__header">
        <div className="tg-ai-workspace__title-group">
          <h2 className="tg-ai-workspace__title">📋 Global Task Center · 全局任务中心</h2>
          <span className="tg-ai-workspace__subtitle">
            7-State FSM orchestration & 5-field cron schedules backed by SQLite WAL
          </span>
        </div>
        <div className="tg-ai-workspace__actions">
          <button
            type="button"
            className="tg-btn tg-btn--primary"
            onClick={handleOpenCreateForm}
          >
            + New Task · 新建任务
          </button>
          <button
            type="button"
            className="tg-btn tg-btn--ghost"
            onClick={() => void loadTasks()}
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
        {/* Create Task Form */}
        {showCreateForm && (
          <section className="tg-ai-card">
            <h3 className="tg-ai-card__title">✨ Create Real Task · 创建任务</h3>
            <form
              onSubmit={(e) => void handleCreateTask(e)}
              style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
            >
              <div className="tg-ai-field-grid">
                <label className="tg-ai-field">
                  <span>Task Title · 任务标题</span>
                  <input
                    ref={titleInputRef}
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Enter task title · 输入任务标题"
                    aria-label="Task Title 任务标题"
                    required
                  />
                </label>

                <label className="tg-ai-field">
                  <span>5-Field Cron (Optional) · 定时表达式</span>
                  <input
                    type="text"
                    value={cronExpr}
                    onChange={(e) => setCronExpr(e.target.value)}
                    placeholder="e.g. 0 9 * * *"
                    aria-label="Cron Expression"
                  />
                </label>
              </div>

              <label className="tg-ai-field">
                <span>Description · 任务描述</span>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional instructions or checklist notes"
                />
              </label>

              <div className="tg-ai-row tg-ai-row--between">
                <span
                  className="tg-ai-workspace__subtitle"
                  style={{ color: cronValidation.valid ? 'var(--tg-text-secondary)' : 'var(--tg-danger)' }}
                >
                  {cronValidation.valid
                    ? cronValidation.nextRunPreview
                    : cronValidation.error}
                </span>
                <button
                  type="submit"
                  className="tg-btn tg-btn--primary"
                  disabled={creating || !cronValidation.valid}
                >
                  {creating ? 'Creating…' : 'Confirm & Create · 确认创建'}
                </button>
              </div>
            </form>
          </section>
        )}

        {/* State Filter Pills */}
        <div className="tg-ai-row" role="tablist" aria-label="Task State Filter">
          {FSM_FILTER_PILLS.map((pill) => {
            const count =
              pill.id === 'all'
                ? tasks.length
                : tasks.filter((t) => t.state === pill.id).length;
            return (
              <button
                key={pill.id}
                type="button"
                role="tab"
                aria-selected={activeFilter === pill.id}
                className={`tg-hermes-tab ${
                  activeFilter === pill.id ? 'tg-hermes-tab--active' : ''
                }`}
                onClick={() => setActiveFilter(pill.id)}
              >
                {pill.label} ({count})
              </button>
            );
          })}
        </div>

        {/* Truthful Task Cards */}
        {filteredTasks.length === 0 ? (
          <div className="tg-ai-empty">
            No tasks found in this state. Create a new task above to begin tracking real execution progress. · 当前筛选下暂无任务。
          </div>
        ) : (
          <div className="tg-ai-grid">
            {filteredTasks.map((task) => {
              // STRICT ZERO-FAKE INVARIANT: Display authentic server progress (0% on new tasks, NEVER fake 25% floor!)
              const pct = Math.max(
                0,
                Math.min(100, Number.isFinite(task.progress) ? task.progress : 0),
              );
              const logs = Array.isArray(task.logs) ? task.logs : [];
              return (
                <article key={task.task_id} className="tg-ai-card">
                  <div className="tg-ai-card__header">
                    <strong>{task.title}</strong>
                    <span className={`tg-ai-badge ${STATE_BADGE_CLASS[task.state] ?? ''}`}>
                      {task.state}
                    </span>
                  </div>

                  {task.description && (
                    <div className="tg-ai-workspace__subtitle">{task.description}</div>
                  )}

                  <div className="tg-ai-row tg-ai-row--between" style={{ fontSize: 12 }}>
                    <span>Schedule: {describeCronExpression(task.cron_expr)}</span>
                    <strong>{pct}%</strong>
                  </div>

                  <div
                    style={{
                      width: '100%',
                      height: 6,
                      borderRadius: 999,
                      background: 'var(--tg-bg-elevated)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        background: 'var(--tg-accent)',
                        transition: 'width 160ms ease',
                      }}
                    />
                  </div>

                  <div className="tg-ai-code-block" style={{ maxHeight: 110, overflowY: 'auto' }}>
                    {logs.length === 0
                      ? 'No execution logs yet · 暂无执行日志'
                      : logs.join('\n')}
                  </div>

                  <div className="tg-ai-row">
                    {task.state !== 'running' && task.state !== 'completed' && (
                      <button
                        type="button"
                        className="tg-btn tg-btn--secondary"
                        onClick={() => void handleTransition(task, 'running')}
                      >
                        ▶ Run
                      </button>
                    )}
                    {task.state === 'running' && (
                      <button
                        type="button"
                        className="tg-btn tg-btn--secondary"
                        onClick={() => void handleTransition(task, 'paused')}
                      >
                        ⏸ Pause
                      </button>
                    )}
                    {task.state !== 'completed' && (
                      <button
                        type="button"
                        className="tg-btn tg-btn--secondary"
                        onClick={() => void handleTransition(task, 'completed')}
                      >
                        ✓ Complete
                      </button>
                    )}
                    {task.state !== 'cancelled' && task.state !== 'completed' && (
                      <button
                        type="button"
                        className="tg-btn tg-btn--ghost"
                        onClick={() => void handleTransition(task, 'cancelled')}
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      type="button"
                      className="tg-btn tg-btn--danger"
                      onClick={() => void handleDelete(task)}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
