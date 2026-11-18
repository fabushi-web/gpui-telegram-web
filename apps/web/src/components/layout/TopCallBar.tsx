import React, { useEffect, useState } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { formatDurationClock, t } from '../../i18n';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';

export interface TopCallBarProps {
  className?: string;
}

export const TopCallBar: React.FC<TopCallBarProps> = ({ className }) => {
  const language = useSettingsStore((s) => s.language);
  const activeCall = useUiStore((s) => s.activeCall);
  const toggleCallMinimize = useUiStore((s) => s.toggleCallMinimize);
  const toggleCallMute = useUiStore((s) => s.toggleCallMute);
  const endActiveCall = useUiStore((s) => s.endActiveCall);

  const peersById = useChatStore((s) => s.peersById);
  const chatsById = useChatStore((s) => s.chatsById);

  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const isVisible = Boolean(activeCall.isOpen && activeCall.isMinimized && activeCall.runtime);

  useEffect(() => {
    if (!isVisible) return;
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [isVisible]);

  if (!isVisible || !activeCall.runtime) {
    return null;
  }

  const rt = activeCall.runtime;
  const peerUser = peersById[rt.peerUserId];
  const chat = rt.chatId !== undefined ? chatsById[rt.chatId] : undefined;
  const peerName =
    (peerUser ? `${peerUser.firstName} ${peerUser.lastName ?? ''}`.trim() : '') ||
    chat?.title ||
    `User #${rt.peerUserId}`;

  const anchorMs = rt.connectedAtMs ?? rt.startedAtMs;
  const elapsedSecs = Math.max(0, Math.floor((nowMs - anchorMs) / 1000));

  return (
    <div
      id={DOM_IDS.TOP_CALL_BAR}
      role="region"
      aria-label="Active Minimized Call"
      className={className}
      onClick={() => toggleCallMinimize(false)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
        <span
          aria-hidden="true"
          style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            backgroundColor: 'var(--tg-success)',
            flexShrink: 0,
          }}
        />
        <strong
          style={{
            fontSize: '13px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {peerName}
        </strong>
        <span
          style={{
            fontSize: '12px',
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--tg-text-secondary)',
          }}
        >
          {formatDurationClock(elapsedSecs)}
        </span>
      </div>

      <div
        style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => toggleCallMute()}
          aria-pressed={rt.isMuted}
          aria-label={rt.isMuted ? t('call.unmute', language) : t('call.mute', language)}
          className="tg-btn tg-btn--secondary"
          style={{ padding: '4px 10px', fontSize: '12px' }}
        >
          {rt.isMuted ? '🔇' : '🎙️'}{' '}
          {rt.isMuted ? t('call.unmute', language) : t('call.mute', language)}
        </button>

        <button
          type="button"
          onClick={() => toggleCallMinimize(false)}
          className="tg-btn tg-btn--secondary"
          style={{ padding: '4px 10px', fontSize: '12px' }}
        >
          ⤢ {language === 'zh-CN' ? '展开通话' : 'Restore'}
        </button>

        <button
          type="button"
          onClick={() => void endActiveCall()}
          aria-label={t('call.endCall', language)}
          className="tg-btn tg-btn--danger"
          style={{ padding: '4px 10px', fontSize: '12px' }}
        >
          {t('call.endCall', language)}
        </button>
      </div>
    </div>
  );
};
