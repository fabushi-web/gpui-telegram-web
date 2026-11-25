import React, { useState } from 'react';
import {
  CLASSIC_INITIALS_AVATAR_SHAPE,
  CODING_PERMISSION_MODES,
  CODING_PROVIDER_KINDS,
  CODING_PROVIDER_META,
  GROK_AVATAR_SHAPES,
  GROK_COLOR_PALETTE,
  type CodingPermissionMode,
  type CodingProviderKind,
} from '@gpui-telegram/protocol';
import { getServerAdapter } from '../../adapters';
import { t } from '../../i18n';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';
import { GrokBotAvatar } from '../common/GrokBotAvatar';

export interface CreateBotModalProps {
  onClose: () => void;
}

const SHAPE_OPTIONS: readonly string[] = [
  ...GROK_AVATAR_SHAPES,
  CLASSIC_INITIALS_AVATAR_SHAPE,
];

export const CreateBotModal: React.FC<CreateBotModalProps> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const isZh = language === 'zh-CN';
  const pushToast = useUiStore((s) => s.pushToast);
  const loadBots = useAiWorkspaceStore((s) => s.loadBots);
  const bootstrapChats = useChatStore((s) => s.bootstrapChats);
  const selectChat = useChatStore((s) => s.selectChat);

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [description, setDescription] = useState('');
  const [avatarShape, setAvatarShape] = useState<string>('blob');
  const [avatarColor, setAvatarColor] = useState<string>('blue');
  const [enableCodingAgent, setEnableCodingAgent] = useState(false);
  const [codingProvider, setCodingProvider] = useState<CodingProviderKind>('claude_code');
  const [workspacePath, setWorkspacePath] = useState('');
  const [permissionMode, setPermissionMode] = useState<CodingPermissionMode>('ask');
  const [useWorktree, setUseWorktree] = useState(false);
  const [allowGroupMembers, setAllowGroupMembers] = useState(false);
  const [errorAlert, setErrorAlert] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const previewSourceId = (username.trim() || displayName.trim() || 'fabushi_bot').replace(/^@/, '');

  const handleSubmit = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault();
    const cleanName = displayName.trim();
    if (!cleanName) {
      setErrorAlert(isZh ? '请输入智能体名称' : 'Bot display name is required.');
      return;
    }

    let cleanHandle = username.trim().replace(/^@+/, '');
    if (cleanHandle && !cleanHandle.toLowerCase().endsWith('bot')) {
      cleanHandle = `${cleanHandle}_bot`;
    }

    setSubmitting(true);
    setErrorAlert(null);
    try {
      const adapter = getServerAdapter();
      const created = await adapter.createFabushiBot({
        display_name: cleanName,
        username: cleanHandle || undefined,
        description: description.trim() || undefined,
        avatar_shape: avatarShape,
        avatar_color: avatarColor,
        coding_agent: enableCodingAgent
          ? {
              provider_kind: codingProvider,
              workspace_path: workspacePath.trim() || '.',
              use_worktree: useWorktree,
              permission_mode: permissionMode,
              extra_args: [],
              allow_group_members: allowGroupMembers,
            }
          : null,
      });

      await Promise.allSettled([loadBots(), bootstrapChats()]);
      if (created.companion_chat_id) {
        await selectChat(created.companion_chat_id);
      }
      pushToast(
        isZh ? `已创建智能体 ${cleanName}` : `Created bot ${cleanName}`,
        'success',
      );
      onClose();
    } catch (err) {
      setErrorAlert(err instanceof Error ? err.message : 'Failed to create bot');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="tg-modal-overlay"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        id="modal-create-bot"
        data-testid="modal-create-bot"
        role="dialog"
        aria-modal="true"
        aria-label={isZh ? '创建智能体 Bot' : 'Create Bot'}
        className="tg-modal-card"
        style={{ width: 'min(520px, 95vw)' }}
      >
        <div className="tg-modal-header">
          <span>🤖 {isZh ? '创建智能体 Bot · Grok Avatar Wizard' : 'Create Bot · Grok Avatar Wizard'}</span>
          <button
            type="button"
            className="tg-icon-btn"
            aria-label={t('common.close', language)}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <form
          onSubmit={(e) => void handleSubmit(e)}
          style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}
        >
          <div className="tg-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {errorAlert && (
              <div
                role="alert"
                style={{
                  padding: '8px 12px',
                  borderRadius: '8px',
                  background: 'var(--tg-danger-soft)',
                  color: 'var(--tg-danger)',
                  fontSize: '13px',
                }}
              >
                {errorAlert}
              </div>
            )}

            {/* Live Grok Avatar Preview */}
            <div
              className="tg-surface-card"
              style={{
                padding: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
              }}
            >
              <GrokBotAvatar
                sourceId={previewSourceId}
                shape={avatarShape}
                color={avatarColor}
                sizePx={64}
                initials={(displayName.trim() || 'AI').slice(0, 2).toUpperCase()}
              />
              <div style={{ minWidth: 0, flex: '1 1 auto' }}>
                <div style={{ fontSize: '15px', fontWeight: 700 }} className="tg-truncate">
                  {displayName.trim() || (isZh ? '新建智能体' : 'New AI Bot')}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                  @{previewSourceId} · {avatarShape} / {avatarColor}
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12.5px' }}>
                <span>{isZh ? '名称 *' : 'Display Name *'}</span>
                <input
                  type="text"
                  className="tg-input"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={isZh ? '例如：架构助手' : 'e.g. Code Reviewer'}
                  autoFocus
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12.5px' }}>
                <span>{isZh ? '@用户名 (可选)' : '@username (optional)'}</span>
                <input
                  type="text"
                  className="tg-input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="my_assistant_bot"
                />
              </label>
            </div>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12.5px' }}>
              <span>{isZh ? '简介与指令说明' : 'Description / What can this bot do?'}</span>
              <textarea
                className="tg-textarea"
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={isZh ? '描述该智能体的能力与使用方式…' : 'Describe what this bot can help with…'}
              />
            </label>

            {/* 8 Organic Shapes + Classic Initials */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--tg-text-secondary)' }}>
                {isZh ? '头像外形 (Shape)' : 'Avatar Shape'}
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {SHAPE_OPTIONS.map((sh) => {
                  const selected = avatarShape === sh;
                  return (
                    <button
                      key={sh}
                      type="button"
                      data-avatar="true"
                      aria-pressed={selected}
                      onClick={() => setAvatarShape(sh)}
                      className={`tg-btn ${selected ? 'tg-btn--primary' : 'tg-btn--secondary'}`}
                      style={{ padding: '4px 10px', fontSize: '12px', textTransform: 'capitalize' }}
                    >
                      {sh}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 11-Color Swatch Palette (data-avatar="true" preserves dark-mode zero-purple compliance) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--tg-text-secondary)' }}>
                {isZh ? '主题色 (Color)' : 'Avatar Color'}
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {GROK_COLOR_PALETTE.map((spec) => {
                  const selected = avatarColor === spec.id;
                  const label = isZh ? spec.label_zh : spec.label_en;
                  return (
                    <button
                      key={spec.id}
                      type="button"
                      data-avatar="true"
                      title={label}
                      aria-label={`Color ${label}`}
                      aria-pressed={selected}
                      onClick={() => setAvatarColor(spec.id)}
                      style={{
                        width: '26px',
                        height: '26px',
                        borderRadius: '50%',
                        backgroundColor: spec.swatch_hex,
                        border: selected
                          ? '2.5px solid var(--tg-text-primary)'
                          : '1px solid var(--tg-hairline-border)',
                        transform: selected ? 'scale(1.12)' : 'none',
                      }}
                    />
                  );
                })}
              </div>
            </div>

            {/* Optional Coding Agent Binding */}
            <div
              className="tg-surface-card"
              style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '10px' }}
            >
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={enableCodingAgent}
                  onChange={(e) => setEnableCodingAgent(e.target.checked)}
                />
                <strong>{isZh ? '绑定本地编程智能体 (Coding Agent Bot)' : 'Enable Coding Agent Mode'}</strong>
              </label>

              {enableCodingAgent && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                      <span>{isZh ? 'CLI 引擎 (Provider)' : 'Provider'}</span>
                      <select
                        className="tg-select"
                        value={codingProvider}
                        onChange={(e) => setCodingProvider(e.target.value as CodingProviderKind)}
                      >
                        {CODING_PROVIDER_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {CODING_PROVIDER_META[k].display_name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                      <span>{isZh ? '权限模式 (Permission)' : 'Permission Mode'}</span>
                      <select
                        className="tg-select"
                        value={permissionMode}
                        onChange={(e) => setPermissionMode(e.target.value as CodingPermissionMode)}
                      >
                        {CODING_PERMISSION_MODES.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                    <span>{isZh ? '本地项目工作区路径 (Workspace Path)' : 'Workspace Directory Path'}</span>
                    <input
                      type="text"
                      className="tg-input"
                      value={workspacePath}
                      onChange={(e) => setWorkspacePath(e.target.value)}
                      placeholder="/path/to/repository"
                    />
                  </label>

                  <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', fontSize: '12px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={useWorktree}
                        onChange={(e) => setUseWorktree(e.target.checked)}
                      />
                      <span>Git Worktree</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={allowGroupMembers}
                        onChange={(e) => setAllowGroupMembers(e.target.checked)}
                      />
                      <span>{isZh ? '允许群成员操作' : 'Allow Group Members'}</span>
                    </label>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="tg-modal-footer">
            <button type="button" className="tg-btn tg-btn--secondary" onClick={onClose}>
              {t('common.cancel', language)}
            </button>
            <button type="submit" className="tg-btn tg-btn--primary" disabled={submitting}>
              {submitting ? (isZh ? '创建中…' : 'Creating…') : t('common.create', language)}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateBotModal;
