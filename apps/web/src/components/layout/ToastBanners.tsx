import React, { useEffect, useSyncExternalStore } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { useUiStore } from '../../store/useUiStore';

/**
 * Tracks whether an in-stage `#app-shell-stage-slot` toast host is currently mounted.
 * Ensures `#window-toast-banner` and `#stage-toast-pill` are NEVER duplicated in the DOM,
 * while guaranteeing every toast renders strictly above `#cmp-input-wrap` inside the stage
 * whenever a chat stage is active, and at top-center globally otherwise.
 */
let mountedStageHostCount = 0;
const stageHostListeners = new Set<() => void>();

function notifyStageHostChange(): void {
  for (const listener of stageHostListeners) {
    listener();
  }
}

function subscribeStageHost(listener: () => void): () => void {
  stageHostListeners.add(listener);
  return () => {
    stageHostListeners.delete(listener);
  };
}

function getHasMountedStageHost(): boolean {
  return mountedStageHostCount > 0;
}

export interface StageToastLayerProps {
  chatId: number | null;
}

export const StageToastLayer: React.FC<StageToastLayerProps> = ({ chatId }) => {
  const stageToast = useUiStore((s) => s.stageToast);
  const windowToast = useUiStore((s) => s.windowToast);
  const dismissStageToastIfId = useUiStore((s) => s.dismissStageToastIfId);
  const dismissWindowToastIfId = useUiStore((s) => s.dismissWindowToastIfId);

  useEffect(() => {
    mountedStageHostCount += 1;
    notifyStageHostChange();
    return () => {
      mountedStageHostCount = Math.max(0, mountedStageHostCount - 1);
      notifyStageHostChange();
    };
  }, []);

  const showStagePill =
    stageToast !== null &&
    (stageToast.chatId === 0 || chatId === null || stageToast.chatId === chatId);

  if (!showStagePill && !windowToast) {
    return null;
  }

  return (
    <div className="tg-stage-toast-host" data-testid="stage-toast-host">
      {showStagePill && stageToast && (
        <div
          id={DOM_IDS.STAGE_TOAST_PILL}
          data-testid="toast-notification"
          data-toast-scope="stage"
          data-toast-kind={stageToast.kind}
          role={stageToast.kind === 'error' ? 'alert' : 'status'}
          aria-live={stageToast.kind === 'error' ? 'assertive' : 'polite'}
          onClick={() => dismissStageToastIfId(stageToast.id)}
        >
          <span>{stageToast.message}</span>
        </div>
      )}

      {windowToast && (
        <div
          id={DOM_IDS.WINDOW_TOAST_BANNER}
          data-testid="toast-notification"
          data-toast-scope="window"
          data-toast-kind={windowToast.kind}
          role={windowToast.kind === 'error' ? 'alert' : 'status'}
          aria-live={windowToast.kind === 'error' ? 'assertive' : 'polite'}
        >
          {windowToast.kind === 'error' && (
            <span className="tg-toast-error-badge" aria-hidden="true">
              !
            </span>
          )}
          <span className="tg-wrap-anywhere" style={{ flex: '1 1 auto' }}>
            {windowToast.message}
          </span>
          <button
            id="window-toast-banner-close"
            type="button"
            aria-label="Dismiss notification"
            onClick={() => dismissWindowToastIfId(windowToast.id)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
};

export const GlobalToastBannerFallback: React.FC = () => {
  const hasStageHost = useSyncExternalStore(
    subscribeStageHost,
    getHasMountedStageHost,
    () => false,
  );
  const windowToast = useUiStore((s) => s.windowToast);
  const stageToast = useUiStore((s) => s.stageToast);
  const dismissWindowToastIfId = useUiStore((s) => s.dismissWindowToastIfId);
  const dismissStageToastIfId = useUiStore((s) => s.dismissStageToastIfId);

  if (hasStageHost) {
    return null;
  }

  return (
    <>
      {windowToast && (
        <div
          id={DOM_IDS.WINDOW_TOAST_BANNER}
          className="tg-window-toast--global"
          data-testid="toast-notification"
          data-toast-scope="window"
          data-toast-kind={windowToast.kind}
          role={windowToast.kind === 'error' ? 'alert' : 'status'}
          aria-live={windowToast.kind === 'error' ? 'assertive' : 'polite'}
        >
          {windowToast.kind === 'error' && (
            <span className="tg-toast-error-badge" aria-hidden="true">
              !
            </span>
          )}
          <span className="tg-wrap-anywhere" style={{ flex: '1 1 auto' }}>
            {windowToast.message}
          </span>
          <button
            id="window-toast-banner-close"
            type="button"
            aria-label="Dismiss notification"
            onClick={() => dismissWindowToastIfId(windowToast.id)}
          >
            ×
          </button>
        </div>
      )}

      {stageToast && (
        <div
          id={DOM_IDS.STAGE_TOAST_PILL}
          data-testid="toast-notification"
          data-toast-scope="stage"
          data-toast-kind={stageToast.kind}
          role={stageToast.kind === 'error' ? 'alert' : 'status'}
          aria-live={stageToast.kind === 'error' ? 'assertive' : 'polite'}
          onClick={() => dismissStageToastIfId(stageToast.id)}
          style={{
            position: 'fixed',
            top: windowToast ? '68px' : '16px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 'var(--tg-z-toast)',
          }}
        >
          <span>{stageToast.message}</span>
        </div>
      )}
    </>
  );
};
