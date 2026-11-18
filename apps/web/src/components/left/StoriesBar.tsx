import React, { useEffect, useMemo, useState } from 'react';
import { DOM_IDS, type StoryGroup } from '@gpui-telegram/protocol';
import { getClientAdapter } from '../../adapters';
import { formatChatTimestamp, t } from '../../i18n';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';

export interface StoriesBarProps {
  className?: string;
}

export interface StoriesViewerModalProps {
  className?: string;
}

// Zero-purple curated story background gradients (Ocean, Teal, Amber, Coral)
const STORY_GRADIENTS: Array<{ id: string; label: string; css: string }> = [
  {
    id: 'ocean',
    label: 'Ocean Blue',
    css: 'linear-gradient(135deg, #0D253F 0%, #1C5D99 52%, #3390EC 100%)',
  },
  {
    id: 'teal',
    label: 'Emerald Teal',
    css: 'linear-gradient(135deg, #0A2E2A 0%, #136F63 52%, #00C972 100%)',
  },
  {
    id: 'amber',
    label: 'Warm Amber',
    css: 'linear-gradient(135deg, #3B2308 0%, #9E5A0E 52%, #E5A030 100%)',
  },
  {
    id: 'coral',
    label: 'Sunset Coral',
    css: 'linear-gradient(135deg, #3D1712 0%, #A63A2B 52%, #E86C52 100%)',
  },
];

function initialsFromName(name?: string): string {
  const clean = (name ?? 'U').trim();
  if (!clean) return 'U';
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

export const StoriesBar: React.FC<StoriesBarProps> = ({ className }) => {
  const language = useSettingsStore((s) => s.language);
  const currentUser = useAuthStore((s) => s.currentUser);
  const storyGroups = useChatStore((s) => s.storyGroups);
  const createStory = useChatStore((s) => s.createStory);
  const markStoryViewed = useChatStore((s) => s.markStoryViewed);
  const openStoriesViewer = useUiStore((s) => s.openStoriesViewer);

  const [composerOpen, setComposerOpen] = useState<boolean>(false);
  const [caption, setCaption] = useState<string>('');
  const [selectedGradient, setSelectedGradient] = useState<string>(STORY_GRADIENTS[0].css);
  const [uploadedFileId, setUploadedFileId] = useState<string | undefined>(undefined);
  const [uploadedPreviewName, setUploadedPreviewName] = useState<string>('');
  const [posting, setPosting] = useState<boolean>(false);

  const orderedGroups = useMemo<StoryGroup[]>(() => {
    const myUserId = currentUser?.userId;
    if (!myUserId) return storyGroups;
    const own = storyGroups.filter((g) => g.userId === myUserId);
    const others = storyGroups.filter((g) => g.userId !== myUserId);
    return [...own, ...others];
  }, [storyGroups, currentUser?.userId]);

  const handleOpenGroup = (groupIdx: number): void => {
    const group = orderedGroups[groupIdx];
    if (!group || group.stories.length === 0) return;
    openStoriesViewer(orderedGroups, groupIdx, 0);
    const firstStory = group.stories[0];
    if (firstStory && !firstStory.isViewed) {
      void markStoryViewed(firstStory.storyId);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const uploaded = await getClientAdapter().uploadMedia(file, {
        fileName: file.name,
        mimeType: file.type || 'image/png',
      });
      setUploadedFileId(uploaded.file_id);
      setUploadedPreviewName(file.name);
    } catch {
      // Fallback to gradient story if upload fails
    }
  };

  const handleCreateStory = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!caption.trim() && !uploadedFileId) return;

    setPosting(true);
    try {
      await createStory({
        caption: caption.trim() || undefined,
        mediaFileId: uploadedFileId,
        backgroundGradient: selectedGradient,
      });
      setCaption('');
      setUploadedFileId(undefined);
      setUploadedPreviewName('');
      setComposerOpen(false);
    } finally {
      setPosting(false);
    }
  };

  return (
    <>
      <div
        id={DOM_IDS.STORIES_BAR}
        role="region"
        aria-label={t('stories.title', language)}
        className={`tg-stories-bar ${className ?? ''}`.trim()}
        style={{ minHeight: '66px' }}
      >
        {/* + Post Story Trigger */}
        <button
          type="button"
          data-testid="add-story-trigger"
          aria-label={t('stories.post', language)}
          onClick={() => setComposerOpen(true)}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '3px',
            flexShrink: 0,
            minWidth: '52px',
          }}
        >
          <span
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '50%',
              border: '2px dashed var(--tg-accent)',
              backgroundColor: 'var(--tg-accent-soft)',
              color: 'var(--tg-accent)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '20px',
              fontWeight: 600,
            }}
          >
            +
          </span>
          <span
            style={{
              fontSize: '10.5px',
              color: 'var(--tg-text-secondary)',
              maxWidth: '56px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {t('stories.post', language)}
          </span>
        </button>

        {/* Peer Story Rings */}
        {orderedGroups.map((group, idx) => {
          const isOwn = group.userId === currentUser?.userId;
          const firstStory = group.stories[0];
          const ringBg = group.hasUnviewed
            ? 'linear-gradient(135deg, #29B6F6 0%, #3390EC 50%, #00C972 100%)'
            : 'var(--tg-border)';

          return (
            <button
              key={group.userId}
              type="button"
              data-story-id={firstStory?.storyId}
              data-peer-id={String(group.userId)}
              data-own-story={isOwn ? 'true' : undefined}
              onClick={() => handleOpenGroup(idx)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '3px',
                flexShrink: 0,
                minWidth: '52px',
              }}
            >
              <span
                style={{
                  width: '46px',
                  height: '46px',
                  padding: '2px',
                  borderRadius: '50%',
                  background: ringBg,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <span
                  className="tg-avatar"
                  data-color-index={String(Math.abs(group.userId) % 7)}
                  style={{
                    width: '40px',
                    height: '40px',
                    fontSize: '13px',
                    border: '2px solid var(--tg-bg-surface)',
                  }}
                >
                  {initialsFromName(group.firstName)}
                </span>
              </span>
              <span
                style={{
                  fontSize: '10.5px',
                  color: 'var(--tg-text-primary)',
                  fontWeight: group.hasUnviewed ? 600 : 400,
                  maxWidth: '58px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {isOwn
                  ? language === 'zh-CN'
                    ? '我的动态'
                    : 'My Story'
                  : group.firstName}
              </span>
            </button>
          );
        })}
      </div>

      {/* Standalone Post Story Composer Dialog */}
      {composerOpen && (
        <div
          className="tg-modal-overlay"
          onClick={() => setComposerOpen(false)}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-label={t('stories.post', language)}
            data-testid="story-composer-dialog"
            className="tg-modal-card"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => void handleCreateStory(e)}
          >
            <div className="tg-modal-header">
              <span>{t('stories.post', language)}</span>
              <button
                type="button"
                onClick={() => setComposerOpen(false)}
                aria-label={t('common.close', language)}
                className="tg-icon-btn"
              >
                ✕
              </button>
            </div>

            <div
              className="tg-modal-body"
              style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
            >
              <div
                style={{
                  height: '130px',
                  borderRadius: 'var(--tg-radius-md)',
                  background: selectedGradient,
                  padding: '16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#FFFFFF',
                  fontWeight: 600,
                  textAlign: 'center',
                  overflow: 'hidden',
                }}
              >
                {caption.trim() ||
                  (language === 'zh-CN' ? '实时预览动态卡片' : 'Live Story Preview')}
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {STORY_GRADIENTS.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    aria-label={g.label}
                    onClick={() => setSelectedGradient(g.css)}
                    style={{
                      width: '30px',
                      height: '30px',
                      borderRadius: '50%',
                      background: g.css,
                      border:
                        selectedGradient === g.css
                          ? '2px solid #FFFFFF'
                          : '1px solid var(--tg-border)',
                      outline:
                        selectedGradient === g.css
                          ? '2px solid var(--tg-accent)'
                          : 'none',
                    }}
                  />
                ))}

                <label
                  className="tg-btn tg-btn--secondary"
                  style={{ marginLeft: 'auto', padding: '5px 10px', fontSize: '12px', cursor: 'pointer' }}
                >
                  📷 {uploadedPreviewName || (language === 'zh-CN' ? '上传图片' : 'Add Photo')}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => void handleFileChange(e)}
                    style={{ display: 'none' }}
                  />
                </label>
              </div>

              <textarea
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder={t('media.captionPlaceholder', language)}
                aria-label="Story caption"
                rows={3}
                autoFocus
                className="tg-textarea"
              />
            </div>

            <div className="tg-modal-footer">
              <button
                type="button"
                onClick={() => setComposerOpen(false)}
                className="tg-btn tg-btn--secondary"
              >
                {t('common.cancel', language)}
              </button>
              <button
                type="submit"
                disabled={posting || (!caption.trim() && !uploadedFileId)}
                className="tg-btn tg-btn--primary"
              >
                {t('stories.post', language)}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
};

export const StoriesViewerModal: React.FC<StoriesViewerModalProps> = ({ className }) => {
  const language = useSettingsStore((s) => s.language);
  const storiesViewerState = useUiStore((s) => s.storiesViewerState);
  const advanceStory = useUiStore((s) => s.advanceStory);
  const closeStoriesViewer = useUiStore((s) => s.closeStoriesViewer);
  const markStoryViewed = useChatStore((s) => s.markStoryViewed);

  const [progressPct, setProgressPct] = useState<number>(0);

  const isOpen = Boolean(storiesViewerState?.isOpen);
  const currentGroup = storiesViewerState?.groups[storiesViewerState.activeGroupIndex];
  const currentStory = currentGroup?.stories[storiesViewerState?.activeStoryIndex ?? 0];

  useEffect(() => {
    if (!isOpen || !currentStory) return;
    setProgressPct(0);
    if (!currentStory.isViewed) {
      void markStoryViewed(currentStory.storyId);
    }

    const stepMs = 100;
    const durationMs = 6000;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += stepMs;
      if (elapsed >= durationMs) {
        clearInterval(timer);
        advanceStory(1);
      } else {
        setProgressPct(Math.min(100, Math.round((elapsed / durationMs) * 100)));
      }
    }, stepMs);

    return () => clearInterval(timer);
  }, [isOpen, currentStory?.storyId, advanceStory, markStoryViewed, currentStory]);

  useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        advanceStory(-1);
      } else if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        advanceStory(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, advanceStory]);

  if (!isOpen || !storiesViewerState || !currentGroup || !currentStory) {
    return null;
  }

  const mediaUrl = currentStory.mediaId
    ? getClientAdapter().getMediaStreamUrl(currentStory.mediaId)
    : null;

  const fallbackGradient =
    currentStory.backgroundGradient || STORY_GRADIENTS[0].css;

  return (
    <div
      id={DOM_IDS.STORIES_VIEWER}
      role="dialog"
      aria-modal="true"
      aria-label="Stories Viewer"
      className={className}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--tg-z-stories)',
        backgroundColor: 'rgba(8, 13, 20, 0.94)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        color: '#FFFFFF',
      }}
      onClick={closeStoriesViewer}
    >
      {/* Previous Story Button */}
      <button
        type="button"
        aria-label={language === 'zh-CN' ? '上一条动态' : 'Previous story'}
        onClick={(e) => {
          e.stopPropagation();
          advanceStory(-1);
        }}
        className="tg-icon-btn"
        style={{
          marginRight: '12px',
          backgroundColor: 'rgba(255, 255, 255, 0.14)',
          color: '#FFFFFF',
        }}
      >
        ‹
      </button>

      {/* Story Card */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: 'min(420px, 88vw)',
          height: 'min(700px, 86dvh)',
          borderRadius: '18px',
          overflow: 'hidden',
          background: fallbackGradient,
          boxShadow: '0 20px 48px rgba(0, 0, 0, 0.5)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        {/* Top Progress Bars + Author Header */}
        <div
          style={{
            position: 'relative',
            zIndex: 2,
            padding: '12px 14px',
            background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, transparent 100%)',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ display: 'flex', gap: '4px' }}>
            {currentGroup.stories.map((st, idx) => {
              const activeIdx = storiesViewerState.activeStoryIndex;
              const widthPct =
                idx < activeIdx ? 100 : idx === activeIdx ? progressPct : 0;
              return (
                <div
                  key={st.storyId}
                  role="progressbar"
                  aria-valuenow={widthPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  style={{
                    flex: '1 1 0',
                    height: '3px',
                    borderRadius: '2px',
                    backgroundColor: 'rgba(255, 255, 255, 0.32)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${widthPct}%`,
                      height: '100%',
                      backgroundColor: '#FFFFFF',
                      transition: 'width 90ms linear',
                    }}
                  />
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span
                className="tg-avatar tg-avatar--sm"
                data-color-index={String(Math.abs(currentGroup.userId) % 7)}
              >
                {initialsFromName(currentGroup.firstName)}
              </span>
              <div>
                <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
                  {currentGroup.firstName}
                </div>
                <div style={{ fontSize: '11px', opacity: 0.8 }}>
                  {formatChatTimestamp(currentStory.createdAtMs, language)}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={closeStoriesViewer}
              aria-label={t('common.close', language)}
              className="tg-icon-btn"
              style={{ color: '#FFFFFF' }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Center Media or Caption Stage */}
        <div
          style={{
            flex: '1 1 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
            textAlign: 'center',
            position: 'relative',
          }}
        >
          {mediaUrl && (
            <img
              src={mediaUrl}
              alt={currentStory.caption || 'Story media'}
              style={{
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
                borderRadius: '8px',
              }}
            />
          )}
          {!mediaUrl && currentStory.caption && (
            <div style={{ fontSize: '20px', fontWeight: 600, lineHeight: 1.45 }}>
              {currentStory.caption}
            </div>
          )}
        </div>

        {/* Bottom Caption (when paired with media) & Views Footer */}
        <div
          style={{
            position: 'relative',
            zIndex: 2,
            padding: '14px 16px',
            background: 'linear-gradient(0deg, rgba(0,0,0,0.6) 0%, transparent 100%)',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
          }}
        >
          {mediaUrl && currentStory.caption && (
            <div style={{ fontSize: '14px', lineHeight: 1.4 }}>
              {currentStory.caption}
            </div>
          )}
          <div style={{ fontSize: '12px', opacity: 0.85 }}>
            👁 {t('stories.views', language, { count: currentStory.viewsCount })}
          </div>
        </div>
      </div>

      {/* Next Story Button */}
      <button
        type="button"
        aria-label={language === 'zh-CN' ? '下一条动态' : 'Next story'}
        onClick={(e) => {
          e.stopPropagation();
          advanceStory(1);
        }}
        className="tg-icon-btn"
        style={{
          marginLeft: '12px',
          backgroundColor: 'rgba(255, 255, 255, 0.14)',
          color: '#FFFFFF',
        }}
      >
        ›
      </button>
    </div>
  );
};
