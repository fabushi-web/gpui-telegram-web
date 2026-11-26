import React, { useEffect, useState } from 'react';
import type { CallRecordDto } from '@gpui-telegram/protocol';
import { formatChatTimestamp, t } from '../../i18n';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';

export interface CallsHistoryModalProps {
  onClose: () => void;
}

type CallsFilter = 'all' | 'missed' | 'video';

function formatCallDuration(call: CallRecordDto): string {
  const sec = Math.max(
    0,
    Math.round(
      call.started_at_ms && call.ended_at_ms
        ? (call.ended_at_ms - call.started_at_ms) / 1000
        : 0,
    ),
  );
  if (sec <= 0) return '';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

export const CallsHistoryModal: React.FC<CallsHistoryModalProps> = ({ onClose }) => {
  const language = useSettingsStore((s) => s.language);
  const currentUser = useAuthStore((s) => s.currentUser);
  const callsHistory = useChatStore((s) => s.callsHistory);
  const peersById = useChatStore((s) => s.peersById);
  const loadCallsHistory = useChatStore((s) => s.loadCallsHistory);
  const startOutgoingCall = useUiStore((s) => s.startOutgoingCall);
  const pushToast = useUiStore((s) => s.pushToast);

  const [filter, setFilter] = useState<CallsFilter>('all');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void loadCallsHistory({ limit: 50, filter })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [filter, loadCallsHistory]);

  const handleRedial = async (call: CallRecordDto, isVideo: boolean): Promise<void> => {
    const myUid = currentUser?.userId;
    if (!myUid) return;
    const peerId = call.caller_id === myUid ? call.callee_id : call.caller_id;
    if (!peerId || peerId === myUid) return;
    onClose();
    try {
      await startOutgoingCall({
        calleeId: peerId,
        localUserId: myUid,
        isVideo,
        chatId: call.chat_id,
      });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <div className="tg-modal-overlay" onClick={onClose}>
      <div
        id="modal-calls-history"
        data-testid="modal-calls-history"
        role="dialog"
        aria-modal="true"
        aria-label={t('calls.historyTitle', language)}
        className="tg-modal-card"
        style={{ width: 'min(440px, 94vw)', maxHeight: '82dvh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tg-modal-header">
          <span>📞 {t('calls.historyTitle', language)}</span>
          <button
            type="button"
            aria-label={t('common.close', language)}
            onClick={onClose}
            className="tg-icon-btn"
          >
            ✕
          </button>
        </div>

        <div
          role="tablist"
          aria-label="Calls filter"
          style={{
            display: 'flex',
            gap: '6px',
            padding: '10px 14px',
            borderBottom: '1px solid var(--tg-hairline-border)',
          }}
        >
          {(
            [
              { id: 'all', label: t('calls.filterAll', language) },
              { id: 'missed', label: t('calls.filterMissed', language) },
              { id: 'video', label: t('calls.filterVideo', language) },
            ] as const
          ).map((tab) => {
            const active = filter === tab.id;
            const activeBg =
              tab.id === 'missed' && active
                ? 'var(--tg-danger)'
                : active
                  ? 'var(--tg-accent)'
                  : 'var(--tg-bg-elevated)';
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`calls-filter-${tab.id}`}
                onClick={() => setFilter(tab.id)}
                style={{
                  padding: '5px 12px',
                  borderRadius: '999px',
                  border: '1px solid var(--tg-hairline-border)',
                  backgroundColor: activeBg,
                  color: active ? '#FFFFFF' : 'var(--tg-text-primary)',
                  fontSize: '12.5px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div
          className="tg-modal-body"
          style={{
            overflowY: 'auto',
            flex: '1 1 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          {loading ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--tg-text-secondary)', fontSize: '13px' }}>
              {t('common.loading', language)}
            </div>
          ) : error ? (
            <div style={{ padding: '16px', color: 'var(--tg-danger)', fontSize: '13px' }}>{error}</div>
          ) : callsHistory.length === 0 ? (
            <div
              data-testid="calls-history-empty"
              style={{
                padding: '32px 16px',
                textAlign: 'center',
                color: 'var(--tg-text-secondary)',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
              }}
            >
              <div style={{ fontSize: '28px' }} aria-hidden="true">
                📞
              </div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--tg-text-primary)' }}>
                {t('calls.empty', language)}
              </div>
              <div style={{ fontSize: '12.5px' }}>{t('calls.emptySub', language)}</div>
            </div>
          ) : (
            callsHistory.map((call) => {
              const myUid = currentUser?.userId;
              const isOutgoing = myUid !== undefined && call.caller_id === myUid;
              const peerId = isOutgoing ? call.callee_id : call.caller_id;
              const peer = peersById[peerId];
              const peerName =
                [peer?.firstName, peer?.lastName].filter(Boolean).join(' ') ||
                peer?.username ||
                `User #${peerId}`;
              const stateLower = String(call.state ?? '').toLowerCase();
              const isMissed =
                stateLower === 'declined' || stateLower === 'missed' || stateLower === 'rejected';
              const duration = formatCallDuration(call);
              const ts = formatChatTimestamp(
                call.started_at_ms ?? call.ended_at_ms ?? Date.now(),
                language,
              );

              return (
                <div
                  key={call.call_id}
                  data-testid="call-history-row"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '10px',
                    padding: '10px 12px',
                    borderRadius: '12px',
                    backgroundColor: 'var(--tg-bg-elevated)',
                    border: '1px solid var(--tg-hairline-border)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        fontSize: '18px',
                        color: isMissed ? 'var(--tg-danger)' : 'var(--tg-accent)',
                        flexShrink: 0,
                      }}
                    >
                      {call.is_video ? '📹' : '📞'}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: '13.5px',
                          fontWeight: 600,
                          color: isMissed ? 'var(--tg-danger)' : 'var(--tg-text-primary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {peerName}
                      </div>
                      <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)' }}>
                        {isOutgoing ? '↗' : '↙'} {call.state}
                        {duration ? ` · ${duration}` : ''}
                        {ts ? ` · ${ts}` : ''}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                    <button
                      type="button"
                      aria-label={`${t('calls.redial', language)} audio`}
                      title={t('calls.redial', language)}
                      onClick={() => void handleRedial(call, false)}
                      className="tg-icon-btn"
                    >
                      📞
                    </button>
                    <button
                      type="button"
                      aria-label={`${t('calls.redial', language)} video`}
                      title={`${t('calls.redial', language)} video`}
                      onClick={() => void handleRedial(call, true)}
                      className="tg-icon-btn"
                    >
                      📹
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
