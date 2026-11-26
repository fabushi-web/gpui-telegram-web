import React, { useEffect, useState } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { getClientAdapter } from '../../adapters';
import { t } from '../../i18n';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import {
  CONNECTING_BANNER_GRACE_MS,
  CONNECTING_BANNER_TIMER_BUFFER_MS,
  evaluateConnectionBannerVisibility,
} from '../../utils/coreParityM1B';

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
  const [transientStartedAtMs, setTransientStartedAtMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
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

  const isTransient =
    !browserOfflineEvent &&
    (connectionState === 'connecting' ||
      connectionState === 'reconnecting' ||
      connectionState === 'updating' ||
      (connectionState === 'disconnected' && pendingOutboxCount === 0));

  useEffect(() => {
    if (!isTransient) {
      setTransientStartedAtMs(null);
      return;
    }
    const started = Date.now();
    setTransientStartedAtMs((prev) => prev ?? started);
    setNowMs(started);
    const timer = setTimeout(() => {
      setNowMs(Date.now());
    }, CONNECTING_BANNER_GRACE_MS + CONNECTING_BANNER_TIMER_BUFFER_MS);
    return () => clearTimeout(timer);
  }, [isTransient]);

  const evaluation = evaluateConnectionBannerVisibility({
    connectionState,
    browserOfflineEvent,
    transientStartedAtMs,
    nowMs,
    pendingOutboxCount,
  });

  if (!evaluation.visible) {
    return null;
  }

  const bannerState = evaluation.state;

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
      pendingOutboxCount > 0
        ? language === 'zh-CN'
          ? '离线 — 消息已加入待发队列'
          : 'Offline — queued in outbox'
        : language === 'zh-CN'
          ? '等待网络…'
          : 'Waiting for network…';
  } else if (bannerState === 'reconnecting') {
    statusLabel = t('sync.reconnecting', language);
  } else if (bannerState === 'updating') {
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
      data-testid="connection-status-pill"
      className={className ? `tg-connection-pill ${className}` : 'tg-connection-pill'}
    >
      <div className="tg-connection-pill-main">
        <span aria-hidden="true" className="tg-connection-pill-dot" />
        <span className="tg-connection-pill-label">{statusLabel}</span>
        {pendingOutboxCount > 0 && (
          <span data-testid="pending-outbox-badge" className="tg-connection-pill-outbox">
            {t('sync.pendingOutbox', language, { count: pendingOutboxCount })}
          </span>
        )}
      </div>

      <button
        type="button"
        disabled={retrying}
        onClick={() => void handleRetryNow()}
        className="tg-btn tg-btn--secondary tg-connection-pill-retry"
      >
        {language === 'zh-CN' ? '立即重试' : 'Retry Now'}
      </button>
    </div>
  );
};
