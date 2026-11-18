import React from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { t } from '../../i18n';
import { useSettingsStore } from '../../store/useSettingsStore';

export interface ShortcutsModalProps {
  onClose: () => void;
}

interface ShortcutRow {
  keys: string;
  descEn: string;
  descZh: string;
}

const KEYBOARD_SHORTCUTS: readonly ShortcutRow[] = [
  { keys: 'Ctrl+K', descEn: 'Focus Global Search', descZh: '聚焦全局搜索框' },
  { keys: 'Ctrl+F', descEn: 'Search Inside Active Chat', descZh: '当前会话内搜索消息' },
  { keys: 'Ctrl+B', descEn: 'Collapse / Expand Left Sidebar', descZh: '折叠或展开左侧栏' },
  { keys: 'Ctrl+I', descEn: 'Toggle Right Context Inspector', descZh: '打开或收起右侧详情面板' },
  { keys: 'Ctrl+D', descEn: 'Toggle Night / Day Theme', descZh: '快速切换夜间与日间模式' },
  { keys: 'Ctrl+L', descEn: 'Switch Language (EN / 中文)', descZh: '实时切换中英文界面' },
  { keys: 'Ctrl+Shift+L', descEn: 'Lock App with Local Passcode', descZh: '立即使用本地密码锁锁定' },
  { keys: 'Ctrl+,', descEn: 'Open Settings Slide-Stack', descZh: '打开设置抽屉面板' },
  { keys: 'Ctrl+0', descEn: 'Open Saved Messages Vault', descZh: '直达个人云端收藏夹' },
  { keys: 'Ctrl+J', descEn: 'Open Hermes AI Studio', descZh: '打开 Hermes 智能工作台' },
  { keys: 'Ctrl+N', descEn: 'Create New Group', descZh: '新建群组会话' },
  { keys: 'Ctrl+P', descEn: 'Next Unread / Pinned Chat', descZh: '跳转置顶或下一会话' },
  { keys: 'ArrowUp', descEn: 'Edit Last Sent Message (in empty composer)', descZh: '输入框为空时编辑上一条已发消息' },
  { keys: 'Esc', descEn: 'Pop Topmost Overlay / Drawer / Chat Layer', descZh: '逐层关闭顶层弹窗或抽屉' },
  { keys: '?', descEn: 'Show Keyboard Shortcuts Reference', descZh: '打开键盘快捷键参考表' },
];

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const isZh = language === 'zh-CN';

  return (
    <div
      className="tg-modal-overlay"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        id={DOM_IDS.MODAL_SHORTCUTS}
        role="dialog"
        aria-modal="true"
        aria-label={isZh ? '键盘快捷键' : 'Keyboard Shortcuts'}
        className="tg-modal-card"
        style={{ width: 'min(540px, 94vw)' }}
      >
        <div className="tg-modal-header">
          <span>⌨️ {isZh ? '键盘快捷键一览 (Keyboard Shortcuts)' : 'Keyboard Shortcuts'}</span>
          <button
            type="button"
            className="tg-icon-btn"
            aria-label={t('common.close', language)}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="tg-modal-body" style={{ padding: '12px 18px' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '13px',
            }}
          >
            <thead>
              <tr style={{ borderBottom: '1px solid var(--tg-border)', textAlign: 'left' }}>
                <th style={{ padding: '8px 6px', color: 'var(--tg-text-secondary)', fontWeight: 600 }}>
                  {isZh ? '快捷键 (Shortcut)' : 'Shortcut'}
                </th>
                <th style={{ padding: '8px 6px', color: 'var(--tg-text-secondary)', fontWeight: 600 }}>
                  {isZh ? '功能说明 (Action)' : 'Action'}
                </th>
              </tr>
            </thead>
            <tbody>
              {KEYBOARD_SHORTCUTS.map((row) => (
                <tr
                  key={row.keys}
                  style={{ borderBottom: '1px solid var(--tg-border-subtle)' }}
                >
                  <td style={{ padding: '8px 6px', whiteSpace: 'nowrap' }}>
                    <kbd
                      style={{
                        display: 'inline-block',
                        padding: '2px 7px',
                        borderRadius: '5px',
                        background: 'var(--tg-bg-elevated)',
                        border: '1px solid var(--tg-border)',
                        fontFamily: 'var(--tg-font-mono)',
                        fontSize: '12px',
                        color: 'var(--tg-accent)',
                        fontWeight: 600,
                      }}
                    >
                      {row.keys}
                    </kbd>
                  </td>
                  <td style={{ padding: '8px 6px', color: 'var(--tg-text-primary)' }}>
                    {isZh ? `${row.descZh} · ${row.descEn}` : row.descEn}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="tg-modal-footer">
          <button type="button" className="tg-btn tg-btn--primary" onClick={onClose}>
            {t('common.close', language)}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ShortcutsModal;
