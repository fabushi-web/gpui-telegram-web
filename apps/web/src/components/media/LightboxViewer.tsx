import React, { useCallback, useEffect, useMemo } from 'react';
import { DOM_IDS, type MessageItem } from '@gpui-telegram/protocol';
import { getClientAdapter } from '../../adapters';
import { t } from '../../i18n';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';

export interface LightboxGalleryEntry {
  key: string;
  chatId: number;
  messageId: number;
  mediaUrl: string;
  mimeType: string;
  fileName: string;
  caption?: string;
}

function resolveStreamUrl(fileId: string, explicitUrl?: string): string {
  if (explicitUrl && explicitUrl.trim().length > 0) {
    return explicitUrl;
  }
  if (
    fileId.startsWith('blob:') ||
    fileId.startsWith('data:') ||
    fileId.startsWith('http://') ||
    fileId.startsWith('https://') ||
    fileId.startsWith('/')
  ) {
    return fileId;
  }
  return getClientAdapter().getMediaStreamUrl(fileId);
}

function collectChatGalleryEntries(
  chatId: number,
  messages: MessageItem[],
): LightboxGalleryEntry[] {
  const entries: LightboxGalleryEntry[] = [];
  for (const msg of messages) {
    const c = msg.content;
    if (c.type === 'Photo') {
      entries.push({
        key: `${msg.id}:0`,
        chatId,
        messageId: msg.id,
        mediaUrl: resolveStreamUrl(c.data.file_id),
        mimeType: 'image/png',
        fileName: `photo-${msg.id}.png`,
        caption: c.data.caption ?? undefined,
      });
    } else if (c.type === 'Video') {
      entries.push({
        key: `${msg.id}:0`,
        chatId,
        messageId: msg.id,
        mediaUrl: resolveStreamUrl(c.data.file_id),
        mimeType: 'video/mp4',
        fileName: `video-${msg.id}.mp4`,
        caption: c.data.caption ?? undefined,
      });
    } else if (c.type === 'Gif') {
      entries.push({
        key: `${msg.id}:0`,
        chatId,
        messageId: msg.id,
        mediaUrl: resolveStreamUrl(c.data.file_id, c.data.url),
        mimeType: 'image/gif',
        fileName: `gif-${msg.id}.gif`,
        caption: c.data.caption ?? undefined,
      });
    } else if (c.type === 'Media') {
      const mime = c.data.mime_type || 'application/octet-stream';
      if (mime.startsWith('image/') || mime.startsWith('video/')) {
        entries.push({
          key: `${msg.id}:0`,
          chatId,
          messageId: msg.id,
          mediaUrl: resolveStreamUrl(c.data.file_id, c.data.url),
          mimeType: mime,
          fileName:
            c.data.file_name ??
            (mime.startsWith('video/') ? `video-${msg.id}.mp4` : `image-${msg.id}.png`),
          caption: c.data.caption ?? undefined,
        });
      }
    } else if (c.type === 'Album') {
      c.data.items.forEach((item, idx) => {
        const mime = item.mime_type || 'image/png';
        entries.push({
          key: `${msg.id}:${idx}`,
          chatId,
          messageId: msg.id,
          mediaUrl: resolveStreamUrl(item.file_id),
          mimeType: mime,
          fileName: mime.startsWith('video/')
            ? `album-${msg.id}-${idx + 1}.mp4`
            : `album-${msg.id}-${idx + 1}.png`,
          caption: item.caption ?? c.data.caption ?? undefined,
        });
      });
    }
  }
  return entries;
}

function extensionForMime(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg';
  if (lower.includes('webp')) return 'webp';
  if (lower.includes('gif')) return 'gif';
  if (lower.includes('mp4')) return 'mp4';
  if (lower.includes('webm')) return 'webm';
  return 'png';
}

export const LightboxViewer: React.FC = () => {
  const lightboxState = useUiStore((s) => s.lightboxState);
  const openLightbox = useUiStore((s) => s.openLightbox);
  const zoomLightbox = useUiStore((s) => s.zoomLightbox);
  const rotateLightbox = useUiStore((s) => s.rotateLightbox);
  const closeLightbox = useUiStore((s) => s.closeLightbox);
  const messagesByChat = useChatStore((s) => s.messagesByChat);
  const locale = useSettingsStore((s) => s.language);

  const galleryEntries = useMemo<LightboxGalleryEntry[]>(() => {
    if (!lightboxState || !lightboxState.isOpen) return [];
    const rawMessages = messagesByChat[lightboxState.chatId] ?? [];
    const collected = collectChatGalleryEntries(lightboxState.chatId, rawMessages);
    const hasExact = collected.some(
      (item) =>
        item.messageId === lightboxState.messageId &&
        item.mediaUrl === lightboxState.mediaUrl,
    );
    if (hasExact) {
      return collected;
    }
    const fallbackItem: LightboxGalleryEntry = {
      key: `${lightboxState.messageId}:active`,
      chatId: lightboxState.chatId,
      messageId: lightboxState.messageId,
      mediaUrl: lightboxState.mediaUrl,
      mimeType: lightboxState.mimeType || 'image/png',
      fileName: `media-${lightboxState.messageId}.${extensionForMime(lightboxState.mimeType || 'image/png')}`,
      caption: lightboxState.caption,
    };
    return [...collected, fallbackItem];
  }, [lightboxState, messagesByChat]);

  const activeIndex = useMemo(() => {
    if (!lightboxState || galleryEntries.length === 0) return -1;
    const exactIdx = galleryEntries.findIndex(
      (item) =>
        item.messageId === lightboxState.messageId &&
        item.mediaUrl === lightboxState.mediaUrl,
    );
    if (exactIdx !== -1) return exactIdx;
    return galleryEntries.findIndex(
      (item) => item.messageId === lightboxState.messageId,
    );
  }, [galleryEntries, lightboxState]);

  const canGoPrev = activeIndex > 0;
  const canGoNext = activeIndex >= 0 && activeIndex < galleryEntries.length - 1;

  const handleStep = useCallback(
    (delta: -1 | 1) => {
      if (!lightboxState) return;
      const targetIdx = activeIndex + delta;
      const target = galleryEntries[targetIdx];
      if (!target) return;
      openLightbox({
        chatId: target.chatId,
        messageId: target.messageId,
        mediaUrl: target.mediaUrl,
        mimeType: target.mimeType,
        caption: target.caption,
      });
    },
    [activeIndex, galleryEntries, lightboxState, openLightbox],
  );

  const handleDownload = useCallback(async () => {
    if (!lightboxState) return;
    const activeEntry = galleryEntries[activeIndex];
    const suggestedName =
      activeEntry?.fileName ??
      `media-${lightboxState.messageId}.${extensionForMime(lightboxState.mimeType)}`;

    try {
      const token = useAuthStore.getState().token;
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetch(lightboxState.mediaUrl, { headers });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = suggestedName;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Download failed';
      useUiStore
        .getState()
        .pushToast(`Download failed · 下载失败 (${detail})`, 'error');
    }
  }, [activeIndex, galleryEntries, lightboxState]);

  useEffect(() => {
    if (!lightboxState?.isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        if (canGoPrev) {
          e.preventDefault();
          handleStep(-1);
        }
      } else if (e.key === 'ArrowRight') {
        if (canGoNext) {
          e.preventDefault();
          handleStep(1);
        }
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomLightbox(0.5);
      } else if (e.key === '-') {
        e.preventDefault();
        zoomLightbox(-0.5);
      } else if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        rotateLightbox();
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        closeLightbox();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    canGoNext,
    canGoPrev,
    closeLightbox,
    handleStep,
    lightboxState?.isOpen,
    rotateLightbox,
    zoomLightbox,
  ]);

  if (!lightboxState || !lightboxState.isOpen) {
    return null;
  }

  const isVideo = lightboxState.mimeType.toLowerCase().startsWith('video/');
  const transformCss = `scale(${lightboxState.zoom}) rotate(${lightboxState.rotation}deg)`;

  return (
    <div
      id={DOM_IDS.LIGHTBOX_VIEWER}
      data-testid="lightbox-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={t('media.lightbox', locale) || 'Media Viewer'}
      onWheel={(e) => {
        e.preventDefault();
        zoomLightbox(e.deltaY < 0 ? 0.25 : -0.25);
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          closeLightbox();
        }
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        backgroundColor: 'rgba(10, 15, 22, 0.94)',
        color: '#F5F7FA',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        userSelect: 'none',
      }}
    >
      {/* Top Toolbar */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 18px',
          backgroundColor: 'rgba(14, 22, 33, 0.78)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          zIndex: 2,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px' }}>
          <span data-testid="lightbox-counter" style={{ fontWeight: 600 }}>
            {galleryEntries.length > 0 && activeIndex >= 0
              ? `${activeIndex + 1} / ${galleryEntries.length}`
              : '1 / 1'}
          </span>
          <span style={{ color: '#8FA2B7' }}>
            {Math.round(lightboxState.zoom * 100)}% · {lightboxState.rotation}°
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            type="button"
            data-testid="lightbox-zoom-out"
            aria-label="Zoom Out"
            title="Zoom Out (-)"
            onClick={() => zoomLightbox(-0.5)}
            disabled={lightboxState.zoom <= 1}
            style={toolbarBtnStyle(lightboxState.zoom <= 1)}
          >
            −
          </button>
          <button
            id={DOM_IDS.LIGHTBOX_ZOOM_IN}
            type="button"
            data-testid="lightbox-zoom-in"
            aria-label="Zoom In"
            title="Zoom In (+)"
            onClick={() => zoomLightbox(0.5)}
            disabled={lightboxState.zoom >= 4}
            style={toolbarBtnStyle(lightboxState.zoom >= 4)}
          >
            ＋
          </button>
          <button
            id={DOM_IDS.LIGHTBOX_ROTATE}
            type="button"
            data-testid="lightbox-rotate"
            aria-label="Rotate 90°"
            title="Rotate 90° (R)"
            onClick={() => rotateLightbox()}
            style={toolbarBtnStyle(false)}
          >
            ↻
          </button>
          <button
            id={DOM_IDS.LIGHTBOX_DOWNLOAD}
            type="button"
            data-testid="lightbox-download"
            aria-label="Download"
            title="Download"
            onClick={() => void handleDownload()}
            style={toolbarBtnStyle(false)}
          >
            ⬇ Download
          </button>
          <button
            id={DOM_IDS.LIGHTBOX_CLOSE}
            type="button"
            data-testid="lightbox-close"
            aria-label="Close"
            title="Close (Esc)"
            onClick={() => closeLightbox()}
            style={toolbarBtnStyle(false)}
          >
            ✕
          </button>
        </div>
      </header>

      {/* Main Media Stage */}
      <div
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            closeLightbox();
          }
        }}
        style={{
          position: 'relative',
          flex: '1 1 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          padding: '24px 64px',
        }}
      >
        <button
          id={DOM_IDS.LIGHTBOX_PREV}
          type="button"
          data-testid="lightbox-prev"
          aria-label="Previous media"
          disabled={!canGoPrev}
          onClick={(e) => {
            e.stopPropagation();
            handleStep(-1);
          }}
          style={{
            ...navArrowStyle('left'),
            opacity: canGoPrev ? 1 : 0.35,
            cursor: canGoPrev ? 'pointer' : 'not-allowed',
          }}
        >
          ‹
        </button>

        {isVideo ? (
          <video
            key={lightboxState.mediaUrl}
            src={lightboxState.mediaUrl}
            controls
            autoPlay
            playsInline
            style={{
              maxWidth: '80vw',
              maxHeight: '74vh',
              objectFit: 'contain',
              transform: transformCss,
              transformOrigin: 'center center',
              borderRadius: '6px',
            }}
          />
        ) : (
          <img
            key={lightboxState.mediaUrl}
            src={lightboxState.mediaUrl}
            alt={lightboxState.caption || 'Media preview'}
            draggable={false}
            style={{
              maxWidth: '80vw',
              maxHeight: '74vh',
              objectFit: 'contain',
              transform: transformCss,
              transformOrigin: 'center center',
              borderRadius: '4px',
            }}
          />
        )}

        <button
          id={DOM_IDS.LIGHTBOX_NEXT}
          type="button"
          data-testid="lightbox-next"
          aria-label="Next media"
          disabled={!canGoNext}
          onClick={(e) => {
            e.stopPropagation();
            handleStep(1);
          }}
          style={{
            ...navArrowStyle('right'),
            opacity: canGoNext ? 1 : 0.35,
            cursor: canGoNext ? 'pointer' : 'not-allowed',
          }}
        >
          ›
        </button>
      </div>

      {/* Caption Footer */}
      <footer
        style={{
          minHeight: '44px',
          padding: '10px 20px',
          textAlign: 'center',
          backgroundColor: 'rgba(14, 22, 33, 0.78)',
          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
          color: '#DCE6F2',
          fontSize: '14px',
          zIndex: 2,
        }}
      >
        {lightboxState.caption ? (
          <span data-testid="lightbox-caption">{lightboxState.caption}</span>
        ) : (
          <span style={{ color: '#7F91A4', fontSize: '12px' }}>
            {galleryEntries[activeIndex]?.fileName ?? ''}
          </span>
        )}
      </footer>
    </div>
  );
};

function toolbarBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: '8px',
    border: '1px solid rgba(255, 255, 255, 0.14)',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    color: '#F5F7FA',
    fontSize: '13px',
    fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  };
}

function navArrowStyle(side: 'left' | 'right'): React.CSSProperties {
  return {
    position: 'absolute',
    [side]: '16px',
    top: '50%',
    transform: 'translateY(-50%)',
    width: '44px',
    height: '44px',
    borderRadius: '50%',
    border: '1px solid rgba(255, 255, 255, 0.18)',
    backgroundColor: 'rgba(14, 22, 33, 0.82)',
    color: '#F5F7FA',
    fontSize: '26px',
    lineHeight: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 3,
  };
}
