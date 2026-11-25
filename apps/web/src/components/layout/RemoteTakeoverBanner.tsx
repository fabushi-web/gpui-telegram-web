import React, { useEffect, useState } from 'react';
import type { RemoteSessionDto } from '@gpui-telegram/protocol';
import { getServerAdapter } from '../../adapters';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';

export const RemoteTakeoverBanner: React.FC = () => {
  const language = useSettingsStore((s) => s.language);
  const isZh = language === 'zh-CN';
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLocalBridgeControlled = useAiWorkspaceStore(
    (s) => s.localBridgeState.isRemoteActive,
  );
  const pushToast = useUiStore((s) => s.pushToast);

  const [incomingSessions, setIncomingSessions] = useState<RemoteSessionDto[]>([]);
  const [disconnecting, setDisconnecting] = useState<boolean>(false);

  useEffect(() => {
    if (!isAuthenticated) {
      setIncomingSessions([]);
      return;
    }

    let cancelled = false;
    const adapter = getServerAdapter();

    const refreshSessions = async (): Promise<void> => {
      try {
        const res = await adapter.listRemoteSessions();
        if (cancelled) return;
        setIncomingSessions(res.sessions ?? []);
      } catch {
        // Ignore if remote assist sessions endpoint returns 401/503
      }
    };

    void refreshSessions();
    const unsub = adapter.onUpdate((ev) => {
      const evType = String(ev.type ?? '');
      if (
        evType.toLowerCase().includes('remote') ||
        evType.toLowerCase().includes('computer') ||
        evType.toLowerCase().includes('browser')
      ) {
        void refreshSessions();
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [isAuthenticated]);

  const isControlled = isLocalBridgeControlled || incomingSessions.length > 0;
  if (!isControlled) {
    return null;
  }

  const firstSession = incomingSessions[0];
  const controllerLabel = firstSession
    ? `${firstSession.controller_name}${firstSession.controller_platform ? ` (${firstSession.controller_platform})` : ''}`
    : isLocalBridgeControlled
      ? isZh
        ? '桌面端 / 远端浏览器控制'
        : 'Desktop / Browser Controller'
      : isZh
        ? '远端协助会话'
        : 'Remote Assist Session';

  const handleDisconnectAll = async (): Promise<void> => {
    setDisconnecting(true);
    try {
      const aiStore = useAiWorkspaceStore.getState();
      await Promise.allSettled([
        isLocalBridgeControlled ? aiStore.revokeBrowserControl() : Promise.resolve(),
        aiStore.emergencyTakeover().catch(() => undefined),
        getServerAdapter()
          .disconnectAllRemoteSessions()
          .catch(() => undefined),
      ]);
      setIncomingSessions([]);
      pushToast(
        isZh ? '已立即接管并断开所有远端控制会话' : 'Takeover complete — all remote sessions disconnected',
        'success',
      );
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div
      id="remote-takeover-banner"
      data-testid="remote-takeover-banner"
      role="status"
      aria-live="assertive"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
        <span className="tg-remote-takeover-dot" aria-hidden="true" />
        <span className="tg-truncate">
          {isZh
            ? `本机被控中 · ${controllerLabel}`
            : `本机被控中 · Remote Control Active (${controllerLabel})`}
        </span>
      </div>
      <button
        id="btn-remote-takeover-disconnect"
        type="button"
        disabled={disconnecting}
        onClick={() => void handleDisconnectAll()}
        className="tg-btn tg-btn--danger"
        style={{ padding: '4px 10px', fontSize: '12px', flexShrink: 0 }}
      >
        {disconnecting
          ? isZh
            ? '断开中…'
            : 'Disconnecting…'
          : isZh
            ? '接管 / 断开全部'
            : 'Takeover / Disconnect'}
      </button>
    </div>
  );
};
