import React, { useEffect, useMemo, useState } from 'react';
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
  const trimmed = rawExpr.trim();
  if (!trimmed) {
    return {
      valid: true,
      nextRunPreview: 'Manual Trigger · 手动按需执行 (未设置 Cron)',
    };
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return {
      valid: false,
      error: `Invalid 5-field cron: expected 5 fields (min hour dom mon dow), got ${fields.length} · 请输入标准 5 段 Cron 表达式`,
    };
  }
  const bounds: Array<[number, number, string]> = [
    [0, 59, 'minute (0-59)'],
    [0, 23, 'hour (0-23)'],
    [1, 31, 'day-of-month (1-31)'],
    [1, 12, 'month (1-12)'],
    [0, 7, 'day-of-week (0-7)'],
  ];
  for (let i = 0; i < 5; i += 1) {
    const [min, max, label] = bounds[i];
    if (!validateFieldToken(fields[i], min, max)) {
      return {
        valid: false,
        error: `Invalid cron ${label}: "${fields[i]}" · 字段超出范围`,
      };
    }
  }

  const now = Date.now();
  const [minField, hourField] = fields;
  let offsetMs = 60_000;
  if (minField.startsWith('*/')) {
    const step = Math.max(1, Number(minField.slice(2)) || 15);
    offsetMs = step * 60_000;
  } else if (hourField.startsWith('*/')) {
    const step = Math.max(1, Number(hourField.slice(2)) || 1);
    offsetMs = step * 3_600_000;
  } else if (/^\d+$/.test(minField) && /^\d+$/.test(hourField)) {
    const target = new Date(now);
    target.setSeconds(0, 0);
    target.setHours(Number(hourField), Number(minField));
    if (target.getTime() <= now) {
      target.setDate(target.getDate() + 1);
    }
    offsetMs = target.getTime() - now;
  }
  const nextDate = new Date(now + offsetMs);
  return {
    valid: true,
    nextRunPreview: `${describeCronExpression(trimmed)} · Next Run: ${nextDate.toLocaleString()}`,
  };
}

function getStateBadgeStyle(state: TaskFsmState): { bg: string; color: string } {
  switch (state) {
    case 'running':
      return { bg: 'var(--tg-info-soft)', color: 'var(--tg-info)' };
    case 'completed':
      return { bg: 'var(--tg-success-soft)', color: 'var(--tg-success)' };
    case 'waiting_approval':
    case 'paused':
      return { bg: 'var(--tg-warning-soft)', color: 'var(--tg-warning)' };
    case 'failed':
    case 'cancelled':
      return { bg: 'var(--tg-danger-soft)', color: 'var(--tg-danger)' };
    default:
      return { bg: 'var(--tg-accent-soft)', color: 'var(--tg-accent)' };
  }
}

export function TaskCenterWorkspace({ onClose }: TaskCenterWorkspaceProps = {}): React.JSX.Element {
  const tasks = useAiWorkspaceStore((s) => s.tasks);
  const loadTasks = useAiWorkspaceStore((s) => s.loadTasks);
  const createTask = useAiWorkspaceStore((s) => s.createTask);
  const updateTask = useAiWorkspaceStore((s) => s.updateTask);
  const deleteTask = useAiWorkspaceStore((s) => s.deleteTask);

  const activeChatId = useChatStore((s) => s.activeChatId);
  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);
  const pushToast = useUiStore((s) => s.pushToast);

  const [activeFilter, setActiveFilter] = useState<FilterPillId>('all');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [cronExpr, setCronExpr] = useState('');
  const [creating, setCreating] = useState(false);
  const [expandedLogIds, setExpandedLogIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void loadTasks().catch(() => undefined);
  }, [loadTasks]);

  const cronValidation = useMemo(() => validateFiveFieldCron(cronExpr), [cronExpr]);

  const filteredTasks = useMemo(() => {
    if (activeFilter === 'all') return tasks;
    return tasks.filter((t) => t.state === activeFilter);
  }, [tasks, activeFilter]);

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      pushToast('Please enter a task title · 请输入任务标题', 'warning');
      return;
    }
    if (!cronValidation.valid) {
      pushToast(cronValidation.error || 'Invalid cron expression', 'error');
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
      pushToast('Task created · 任务创建成功', 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleTransition = async (task: TaskItemDto, nextState: TaskFsmState) => {
    try {
      await updateTask(task.task_id, { state: nextState });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <div id={DOM_IDS.TASK_CENTER_WORKSPACE}>
      {/* Workspace Header */}
      <div className="tg-workspace-header">
        <div>
          <div style={{ fontSize: '16px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>📋 Global Task Center &amp; Cron Scheduler · 全局任务状态机与定时中心</span>
            <span
              style={{
                fontSize: '11.5px',
                padding: '2px 8px',
                borderRadius: '999px',
                backgroundColor: 'var(--tg-accent-soft)',
                color: 'var(--tg-accent)',
              }}
            >
              {tasks.length} Tasks
            </span>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
            7-State Deterministic FSM (Queued · Running · Waiting Approval · Paused · Completed · Failed · Cancelled) + 5-Field Cron
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

      {/* 7-State FSM Filter Pills */}
      <div className="tg-workspace-tabs" role="tablist" aria-label="Task FSM State Filters">
        {FSM_FILTER_PILLS.map((pill) => {
          const isSelected = activeFilter === pill.id;
          const count =
            pill.id === 'all' ? tasks.length : tasks.filter((t) => t.state === pill.id).length;
          return (
            <button
              key={pill.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              className={`tg-workspace-tab${isSelected ? ' is-active' : ''}`}
              onClick={() => setActiveFilter(pill.id)}
            >
              {pill.label} ({count})
            </button>
          );
        })}
      </div>

      <div className="tg-workspace-content">
        {/* Create Task & 5-Field Cron Form (First text input in workspace is Title!) */}
        <form
          onSubmit={(e) => void handleCreateTask(e)}
          className="tg-surface-card"
          style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
        >
          <div style={{ fontSize: '14.5px', fontWeight: 600 }}>
            + Create Task or Scheduled Cron Job · 新建后台任务或定时调度
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' }}>
            <input
              type="text"
              className="tg-input"
              aria-label="Task Title 任务标题"
              placeholder="Task title · 任务标题 (e.g. Daily Sync Audit)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <input
              type="text"
              className="tg-input"
              aria-label="Task Description 任务描述"
              placeholder="Description · 任务描述说明 (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <input
              type="text"
              className="tg-input"
              aria-label="5-Field Cron Expression 定时表达式"
              placeholder="*/15 * * * * (5-field cron schedule)"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
            />
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              flexWrap: 'wrap',
            }}
          >
            <div
              role={cronValidation.valid ? 'status' : 'alert'}
              style={{
                fontSize: '12px',
                color: cronValidation.valid ? 'var(--tg-text-secondary)' : 'var(--tg-danger)',
              }}
            >
              {cronValidation.valid ? cronValidation.nextRunPreview : cronValidation.error}
            </div>

            <button
              type="submit"
              className="tg-btn tg-btn--primary"
              disabled={creating || !cronValidation.valid}
            >
              {creating ? 'Creating...' : 'Create Task / Schedule Cron · 创建任务'}
            </button>
          </div>
        </form>

        {/* Task Cards */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {filteredTasks.length === 0 ? (
            <div className="tg-surface-card" style={{ color: 'var(--tg-text-secondary)', fontSize: '13px' }}>
              No tasks in this state filter · 当前筛选状态下暂无任务
            </div>
          ) : (
            filteredTasks.map((task) => {
              const badge = getStateBadgeStyle(task.state);
              const logsOpen = Boolean(expandedLogIds[task.task_id]);
              return (
                <div
                  key={task.task_id}
                  data-task-id={task.task_id}
                  data-task-state={task.state}
                  className="tg-surface-card"
                  style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: '12px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ minWidth: 0, flex: '1 1 260px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: '14.5px' }}>{task.title}</strong>
                        <span
                          style={{
                            fontSize: '11.5px',
                            padding: '2px 8px',
                            borderRadius: '999px',
                            backgroundColor: badge.bg,
                            color: badge.color,
                            fontWeight: 600,
                          }}
                        >
                          {task.state}
                        </span>
                        {task.cron_expr && (
                          <span
                            style={{
                              fontSize: '11.5px',
                              padding: '2px 8px',
                              borderRadius: '999px',
                              backgroundColor: 'var(--tg-bg-elevated)',
                              border: '1px solid var(--tg-border)',
                            }}
                          >
                            ⏱️ <code>{task.cron_expr}</code> · {describeCronExpression(task.cron_expr)}
                          </span>
                        )}
                      </div>

                      {task.description && (
                        <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)', marginTop: '4px' }}>
                          {task.description}
                        </div>
                      )}

                      {task.next_run_ms ? (
                        <div style={{ fontSize: '11.5px', color: 'var(--tg-text-muted)', marginTop: '4px' }}>
                          Next Scheduled Run · 下次执行: {new Date(task.next_run_ms).toLocaleString()}
                        </div>
                      ) : null}
                    </div>

                    {/* FSM Action Controls */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      {task.state !== 'running' && task.state !== 'completed' && (
                        <button
                          type="button"
                          className="tg-btn tg-btn--secondary"
                          style={{ padding: '5px 10px', fontSize: '12px' }}
                          onClick={() => void handleTransition(task, 'running')}
                        >
                          ▶ Start · 开始
                        </button>
                      )}
                      {task.state === 'running' && (
                        <button
                          type="button"
                          className="tg-btn tg-btn--secondary"
                          style={{ padding: '5px 10px', fontSize: '12px' }}
                          onClick={() => void handleTransition(task, 'paused')}
                        >
                          ⏸ Pause · 暂停
                        </button>
                      )}
                      {task.state !== 'completed' && (
                        <button
                          type="button"
                          className="tg-btn tg-btn--secondary"
                          style={{ padding: '5px 10px', fontSize: '12px' }}
                          onClick={() => void handleTransition(task, 'completed')}
                        >
                          ✓ Complete · 完成
                        </button>
                      )}
                      {task.state !== 'cancelled' && task.state !== 'completed' && (
                        <button
                          type="button"
                          className="tg-btn tg-btn--secondary"
                          style={{ padding: '5px 10px', fontSize: '12px' }}
                          onClick={() => void handleTransition(task, 'cancelled')}
                        >
                          Cancel · 取消
                        </button>
                      )}
                      <button
                        type="button"
                        className="tg-btn tg-btn--secondary"
                        style={{ padding: '5px 10px', fontSize: '12px' }}
                        onClick={() =>
                          setExpandedLogIds((prev) => ({
                            ...prev,
                            [task.task_id]: !prev[task.task_id],
                          }))
                        }
                      >
                        {logsOpen ? 'Hide Logs' : `Logs (${task.logs?.length ?? 0})`}
                      </button>
                      <button
                        type="button"
                        className="tg-btn tg-btn--danger-soft"
                        style={{ padding: '5px 10px', fontSize: '12px' }}
                        onClick={() => void deleteTask(task.task_id)}
                      >
                        Delete · 删除
                      </button>
                    </div>
                  </div>

                  {/* Progress Bar */}
                  <div
                    style={{
                      height: '5px',
                      borderRadius: '999px',
                      backgroundColor: 'var(--tg-bg-elevated)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.max(0, Math.min(100, task.progress || (task.state === 'completed' ? 100 : 25)))}%`,
                        backgroundColor:
                          task.state === 'completed' ? 'var(--tg-success)' : 'var(--tg-accent)',
                        transition: 'width 200ms ease',
                      }}
                    />
                  </div>

                  {/* Expandable Execution Logs */}
                  {logsOpen && (
                    <pre
                      style={{
                        margin: 0,
                        padding: '10px',
                        borderRadius: '8px',
                        backgroundColor: '#0E1621',
                        border: '1px solid var(--tg-border)',
                        color: 'var(--tg-text-secondary)',
                        fontSize: '12px',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {(task.logs?.length ?? 0) > 0
                        ? task.logs.join('\n')
                        : `[${new Date(task.created_at_ms).toISOString()}] Task ${task.task_id} initialized in state "${task.state}".`}
                    </pre>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
