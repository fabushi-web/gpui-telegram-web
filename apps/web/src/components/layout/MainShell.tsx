import React, { useEffect, useRef, useState } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore, type MobilePaneId } from '../../store/useUiStore';
import { ConnectionBanner } from './ConnectionBanner';
import { NavRail } from './NavRail';
import { RemoteTakeoverBanner } from './RemoteTakeoverBanner';
import { TopAudioBar } from './TopAudioBar';
import { TopCallBar } from './TopCallBar';

export type ViewportTier = 'desktop-3col' | 'desktop-2col' | 'tablet' | 'mobile';

export interface MainShellProps {
  leftSlot?: React.ReactNode;
  middleSlot?: React.ReactNode;
  rightSlot?: React.ReactNode;
  workspaceOverlaySlot?: React.ReactNode;
  hideNavRail?: boolean;
  hideBuiltInTopBars?: boolean;
  children?: React.ReactNode;
  className?: string;
}

function detectViewportTier(width: number): ViewportTier {
  if (width >= 1276) return 'desktop-3col';
  if (width >= 926) return 'desktop-2col';
  if (width >= 601) return 'tablet';
  return 'mobile';
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

export const MainShell: React.FC<MainShellProps> = ({
  leftSlot,
  middleSlot,
  rightSlot,
  workspaceOverlaySlot,
  hideNavRail = false,
  hideBuiltInTopBars = false,
  children,
  className,
}) => {
  const mobilePane = useUiStore((s) => s.mobilePane);
  const tabletLeftDrawerOpen = useUiStore((s) => s.tabletLeftDrawerOpen);
  const isRightOpen = useUiStore((s) => s.isRightOpen);
  const activeNavDest = useUiStore((s) => s.activeNavDest);
  const isComposeStageOpen = useUiStore((s) => s.appleComposeStage.isOpen);

  const setMobilePane = useUiStore((s) => s.setMobilePane);
  const setTabletLeftDrawerOpen = useUiStore((s) => s.setTabletLeftDrawerOpen);
  const toggleLeftCollapsed = useUiStore((s) => s.toggleLeftCollapsed);
  const toggleRightSidebar = useUiStore((s) => s.toggleRightSidebar);
  const popTopEscapeLayer = useUiStore((s) => s.popTopEscapeLayer);
  const openAppleComposeStage = useUiStore((s) => s.openAppleComposeStage);

  const cycleTheme = useSettingsStore((s) => s.cycleTheme);
  const toggleLanguage = useSettingsStore((s) => s.toggleLanguage);

  const activeChatId = useChatStore((s) => s.activeChatId);
  const openSavedMessages = useChatStore((s) => s.openSavedMessages);

  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1440,
  );

  const prevActiveChatRef = useRef<number | null>(activeChatId);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = (): void => {
      setViewportWidth(window.innerWidth);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Automatically transition mobile/tablet pane when activeChatId changes
  useEffect(() => {
    const prev = prevActiveChatRef.current;
    prevActiveChatRef.current = activeChatId;

    if (activeChatId !== null && activeChatId !== prev) {
      setTabletLeftDrawerOpen(false);
      if (useUiStore.getState().mobilePane === 'left') {
        setMobilePane('middle');
      }
    } else if (activeChatId === null && prev !== null) {
      if (useUiStore.getState().mobilePane === 'middle') {
        setMobilePane('left');
      }
    }
  }, [activeChatId, setMobilePane, setTabletLeftDrawerOpen]);

  // Global Keyboard Shortcuts (idempotent via defaultPrevented guard)
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.defaultPrevented) return;

      const mod = ev.ctrlKey || ev.metaKey;
      const lowerKey = ev.key.toLowerCase();

      // Escape -> 7-Layer Deterministic Escape Stack
      if (ev.key === 'Escape') {
        const handled = popTopEscapeLayer();
        if (handled) {
          ev.preventDefault();
        }
        return;
      }

      // Cmd/Ctrl+N -> Open inline #apple-compose-stage
      if (mod && !ev.shiftKey && !ev.altKey && lowerKey === 'n') {
        ev.preventDefault();
        openAppleComposeStage();
        return;
      }

      // Ctrl/Cmd+B (outside editable) or Ctrl/Cmd+\ -> Toggle 64px collapsed sidebar
      if (
        mod &&
        !ev.shiftKey &&
        !ev.altKey &&
        (ev.key === '\\' || (lowerKey === 'b' && !isEditableElement(ev.target)))
      ) {
        ev.preventDefault();
        toggleLeftCollapsed();
        return;
      }

      // Ctrl/Cmd+D -> Cycle 4 themes (Night -> Tinted -> Day -> Classic -> Night)
      if (mod && !ev.shiftKey && !ev.altKey && lowerKey === 'd') {
        ev.preventDefault();
        cycleTheme();
        return;
      }

      // Ctrl+L -> Toggle EN / 中文 language (Note: Ctrl+Shift+L is Passcode Lock in useAuthStore)
      if (mod && !ev.shiftKey && !ev.altKey && lowerKey === 'l') {
        ev.preventDefault();
        toggleLanguage();
        return;
      }

      // Ctrl+K -> Focus Global Search Input
      if (mod && !ev.shiftKey && !ev.altKey && lowerKey === 'k') {
        ev.preventDefault();
        const searchEl = document.getElementById(DOM_IDS.GLOBAL_SEARCH_INPUT);
        if (searchEl instanceof HTMLInputElement) {
          searchEl.focus();
          searchEl.select();
        }
        return;
      }

      // Ctrl+0 -> Open Saved Messages
      if (mod && !ev.shiftKey && !ev.altKey && ev.key === '0') {
        ev.preventDefault();
        useUiStore.getState().setActiveNavDest('chats');
        void openSavedMessages();
        return;
      }

      // '/' when not typing in an input -> Focus Global Search Input
      if (!mod && !ev.altKey && !ev.shiftKey && ev.key === '/' && !isEditableElement(ev.target)) {
        ev.preventDefault();
        const searchEl = document.getElementById(DOM_IDS.GLOBAL_SEARCH_INPUT);
        if (searchEl instanceof HTMLInputElement) {
          searchEl.focus();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    popTopEscapeLayer,
    openAppleComposeStage,
    toggleLeftCollapsed,
    cycleTheme,
    toggleLanguage,
    openSavedMessages,
  ]);

  const tier = detectViewportTier(viewportWidth);

  const isTabletLeftOpen =
    tier === 'tablet' &&
    !isComposeStageOpen &&
    (tabletLeftDrawerOpen || activeChatId === null || mobilePane === 'left');

  const effectiveMobilePane: MobilePaneId =
    tier === 'mobile'
      ? isRightOpen
        ? 'right'
        : activeNavDest !== 'chats'
          ? 'workspace'
          : isComposeStageOpen
            ? 'middle'
            : activeChatId === null
              ? 'left'
              : mobilePane
      : mobilePane;

  const showLeftDrawerBackdrop =
    tier === 'tablet' && isTabletLeftOpen && (activeChatId !== null || isComposeStageOpen);
  const showRightDrawerBackdrop =
    (tier === 'desktop-2col' || tier === 'tablet') && isRightOpen;

  const isWorkspaceActive = activeNavDest !== 'chats' && Boolean(workspaceOverlaySlot);

  // On mobile <= 600px, hide inactive panes so scrollWidth === innerWidth (zero horizontal overflow)
  const hideLeftOnCurrentTier =
    (tier === 'tablet' && !isTabletLeftOpen) ||
    (tier === 'mobile' && effectiveMobilePane !== 'left');

  const hideCenterOnMobile =
    tier === 'mobile' &&
    (effectiveMobilePane === 'left' || effectiveMobilePane === 'right');

  return (
    <div
      id={DOM_IDS.APP_SHELL}
      data-viewport-tier={tier}
      data-mobile-pane={effectiveMobilePane}
      data-tablet-left-open={String(isTabletLeftOpen)}
      className={`tg-app-shell ${className ?? ''}`.trim()}
    >
      {!hideNavRail && <NavRail />}

      {/* Tablet Left Slide-Over Backdrop (601px - 925px) */}
      {showLeftDrawerBackdrop && (
        <div
          className="tg-drawer-backdrop"
          data-testid="tablet-left-backdrop"
          style={{ zIndex: 'calc(var(--tg-z-column-drawer) - 1)' }}
          onClick={() => {
            setTabletLeftDrawerOpen(false);
            if (activeChatId !== null) {
              setMobilePane('middle');
            }
          }}
        />
      )}

      {/* Left Sidebar Column */}
      {!hideLeftOnCurrentTier && leftSlot}

      {/* Main Center Stage (Top Banners + Middle Chat Column or AI Workspace) */}
      {!hideCenterOnMobile && (
        <div
          className="tg-main-stage"
          style={{
            width: tier === 'mobile' ? '100vw' : undefined,
            height:
              tier === 'mobile' && effectiveMobilePane === 'workspace'
                ? 'calc(100dvh - 54px)'
                : '100%',
          }}
        >
          {!hideBuiltInTopBars && (
            <>
              <RemoteTakeoverBanner />
              <TopCallBar />
              <TopAudioBar />
            </>
          )}

          {!isWorkspaceActive && middleSlot}
          {workspaceOverlaySlot}
        </div>
      )}

      {/* When center stage is hidden on mobile, still mount fixed overlays inside workspaceOverlaySlot */}
      {hideCenterOnMobile && workspaceOverlaySlot}

      {/* Floating Connection Pill stays mounted across all mobile panes (left/middle/right/workspace) */}
      {!hideBuiltInTopBars && <ConnectionBanner />}

      {/* Right Column Slide-Over Backdrop on Tier 2 & Tier 3 */}
      {showRightDrawerBackdrop && (
        <div
          className="tg-drawer-backdrop"
          data-testid="right-drawer-backdrop"
          style={{ zIndex: 'calc(var(--tg-z-column-drawer) - 1)' }}
          onClick={() => toggleRightSidebar(false)}
        />
      )}

      {/* Right Inspector Column */}
      {isRightOpen && rightSlot}

      {children}
    </div>
  );
};
