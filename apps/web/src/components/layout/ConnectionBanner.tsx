import React, { useEffect, useState } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { getClientAdapter } from '../../adapters';
import { t } from '../../i18n';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';

export interface ConnectionBannerProps {
  className?: string;
}

export const ConnectionBanner: React.FC<ConnectionBannerProps> = ({ className }) => {
  const language = useSettingsStore((s) => s.language);
  const connectionState = useChatStore((s) => s.connectionState);
  const pendingOutboxCount = useChatStore((s) => s.pendingOutboxCount);
  const bootstrapChats = useChatStore((s) => s.bootstrapChats);
  const token = useAuthStore((s) => s.token);

  const [browserOfflineEvent, setBrowserOfflineEvent] = useState<boolean>(
    () => typeof navigator !== 'undefined' && navigator.onLine === false,
  );
  const [retrying, setRetrying] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onOnline = (): void => setBrowserOfflineEvent(false);
    const onOffline = (): void => setBrowserOfflineEvent(true);

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Must be hidden / unmounted when WebSocket is connected and no explicit offline event is active (F3-01)
  if (connectionState === 'connected' && !browserOfflineEvent) {
    return null;
  }

  const isOffline =
    browserOfflineEvent || (connectionState === 'disconnected' && pendingOutboxCount > 0);
  const bannerState: 'offline' | 'reconnecting' | 'connecting' = isOffline
    ? 'offline'
    : connectionState === 'reconnecting'
      ? 'reconnecting'
      : 'connecting';

  const handleRetryNow = async (): Promise<void> => {
    setRetrying(true);
    try {
      await getClientAdapter().connect(token ?? undefined);
      await bootstrapChats();
    } catch {
      // Adapter state machine handles retry backoff
    } finally {
      setRetrying(false);
    }
  };

  let statusLabel: string;
  if (bannerState === 'offline') {
    statusLabel =
      language === 'zh-CN'
        ? '离线 — 消息已加入待发队列'
        : 'Offline — queued in outbox';
  } else if (bannerState === 'reconnecting') {
    statusLabel = t('sync.reconnecting', language);
  } else if (connectionState === 'updating') {
    statusLabel = t('sync.updating', language);
  } else {
    statusLabel = t('sync.connecting', language);
  }

  return (
    <div
      id={DOM_IDS.CONNECTION_STATUS_BANNER}
      role="status"
      aria-live="polite"
      data-state={bannerState}
      className={className}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
        <span
          aria-hidden="true"
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: 'currentColor',
            flexShrink: 0,
          }}
        />
        <span style={{ fontWeight: 600 }}>{statusLabel}</span>
        {pendingOutboxCount > 0 && (
          <span
            data-testid="pending-outbox-badge"
            style={{
              padding: '2px 8px',
              borderRadius: 'var(--tg-radius-pill)',
              backgroundColor: 'rgba(0, 0, 0, 0.14)',
              fontSize: '11.5px',
              fontWeight: 600,
            }}
          >
            {t('sync.pendingOutbox', language, { count: pendingOutboxCount })}
          </span>
        )}
      </div>

      <button
        type="button"
        disabled={retrying}
        onClick={() => void handleRetryNow()}
        className="tg-btn tg-btn--secondary"
        style={{ padding: '4px 10px', fontSize: '12px', flexShrink: 0 }}
      >
        {language === 'zh-CN' ? '立即重试' : 'Retry Now'}
      </button>
    </div>
  );
};
