import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TELEGRAM_WAVEFORM_BARS,
  base64ToBytes,
  clampGenerativeProgress,
  decodeWaveform5Bit,
  isSafeEntityUrl,
  peerAvatarColorIndex,
  type EncryptedEnvelope,
  type MessageItem,
  type PollData,
} from '@gpui-telegram/protocol';
import { getClientAdapter } from '../../adapters';
import { formatDurationClock } from '../../i18n';
import { decryptEnvelope } from '../../services/e2eeClient';
import {
  useAiWorkspaceStore,
  type StreamingHermesTurn,
} from '../../store/useAiWorkspaceStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useUiStore } from '../../store/useUiStore';
import { RichEntities } from './RichEntities';

export interface MessageCardsProps {
  message: MessageItem;
  peerUserId?: number;
}

const AVATAR_COLORS = [
  '#3390EC',
  '#00C972',
  '#E5A030',
  '#E86C52',
  '#E15B64',
  '#3FC1B0',
  '#29B6F6',
];

function resolveMediaUrl(fileId: string, explicitUrl?: string): string {
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

function formatByteSize(bytes: number): string {
  const safe = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  if (safe < 1024) return `${safe} B`;
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} KB`;
  return `${(safe / (1024 * 1024)).toFixed(2)} MB`;
}

function extractExtensionBadge(fileName?: string, mimeType?: string): string {
  if (fileName && fileName.includes('.')) {
    const ext = fileName.split('.').pop()?.trim().toUpperCase();
    if (ext && ext.length <= 6) return ext;
  }
  if (mimeType) {
    const sub = mimeType.split('/')[1]?.split(';')[0]?.trim().toUpperCase();
    if (sub && sub.length <= 6) return sub;
  }
  return 'FILE';
}

function decode100VoiceBars(
  rawWaveform?: number[],
  waveformB64?: string,
  seedId = 1,
): number[] {
  let decoded: number[] = [];

  if (waveformB64 && waveformB64.trim().length > 0) {
    try {
      const bytes = base64ToBytes(waveformB64);
      decoded = Array.from(decodeWaveform5Bit(bytes));
    } catch {
      decoded = [];
    }
  }

  if (decoded.length === 0 && rawWaveform && rawWaveform.length > 0) {
    if (rawWaveform.length === 63 && rawWaveform.every((v) => v >= 0 && v <= 255)) {
      const unpacked = Array.from(decodeWaveform5Bit(rawWaveform));
      if (unpacked.some((v) => v > 0)) {
        decoded = unpacked;
      }
    }
    if (decoded.length === 0) {
      decoded = rawWaveform.map((v) =>
        Math.max(0, Math.min(31, Math.round(v > 31 ? (v / 255) * 31 : v))),
      );
    }
  }

  if (decoded.length === 0) {
    // Neutral flat low-amplitude track when server provided no waveform metadata
    return Array.from({ length: TELEGRAM_WAVEFORM_BARS }, () => 4);
  }

  if (decoded.length === TELEGRAM_WAVEFORM_BARS) {
    return decoded;
  }

  // Resample to exact 100 bars
  return Array.from({ length: TELEGRAM_WAVEFORM_BARS }, (_, idx) => {
    const srcIdx = Math.min(
      decoded.length - 1,
      Math.floor((idx / TELEGRAM_WAVEFORM_BARS) * decoded.length),
    );
    return Math.max(0, Math.min(31, decoded[srcIdx] ?? 4));
  });
}

async function triggerBrowserFileDownload(url: string, fileName: string): Promise<void> {
  try {
    const token = useAuthStore.getState().token;
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} (${res.statusText || 'download failed'})`);
    }
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(objUrl), 10_000);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Network error';
    useUiStore
      .getState()
      .pushToast(`File download failed · 文件下载失败 (${detail})`, 'error');
  }
}

export const ProviderErrorCard: React.FC<{ messageText: string }> = ({ messageText }) => {
  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const setActiveStudioTab = useAiWorkspaceStore((s) => s.setActiveStudioTab);

  const handleConfigureProvider = (e: React.MouseEvent): void => {
    e.stopPropagation();
    closeSettings();
    setActiveStudioTab('magpie');
    setActiveNavDest('hermes');
  };

  return (
    <div
      data-testid="provider-error-card"
      data-error-code="PROVIDER_ERROR"
      role="alert"
      className="tg-provider-error-card"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, fontSize: '13px', color: 'var(--tg-danger)' }}>
        <span>⚠</span>
        <span>AI Provider Not Configured · 未配置模型供应商 (PROVIDER_ERROR)</span>
      </div>
      <div style={{ fontSize: '12.5px', lineHeight: 1.45, color: 'var(--tg-text-primary)', whiteSpace: 'pre-wrap' }}>
        {messageText}
      </div>
      <div>
        <button
          type="button"
          data-testid="btn-configure-ai-provider"
          onClick={handleConfigureProvider}
          className="tg-btn tg-btn--primary"
          style={{ padding: '6px 12px', fontSize: '12.5px' }}
        >
          ⚙ Configure AI Provider · 配置模型供应商
        </button>
      </div>
    </div>
  );
};

// ============================================================================
// Hermes Streaming Reasoning Bubble
// ============================================================================

export const ThinkingBubble: React.FC<{ turn: StreamingHermesTurn }> = ({ turn }) => {
  const [expanded, setExpanded] = useState<boolean>(true);
  const isProviderError = Boolean(
    turn.error && /provider_not_configured|provider_error|no\s+.*provider|unconfigured/i.test(turn.error),
  );

  return (
    <div
      data-testid="thinking-bubble"
      aria-expanded={expanded}
      style={{
        alignSelf: 'flex-start',
        maxWidth: 'min(480px, 86%)',
        minWidth: '220px',
        padding: '10px 14px',
        borderRadius: '18px 18px 18px 6px',
        backgroundColor: 'var(--tg-bubble-in)',
        border: '1px solid var(--tg-hairline-border)',
        color: 'var(--tg-text-primary)',
        boxShadow: 'var(--tg-shadow-sm)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          marginBottom: expanded ? '6px' : 0,
        }}
      >
        <span
          style={{
            fontSize: '12px',
            fontWeight: 600,
            color: 'var(--tg-accent)',
          }}
        >
          {turn.isStreaming
            ? `Thinking · 思考推理中… (${turn.model || 'Hermes'})`
            : `Reasoning Complete (${turn.model || 'Hermes'})`}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            padding: '2px 7px',
            borderRadius: '5px',
            border: '1px solid var(--tg-hairline-border)',
            backgroundColor: 'transparent',
            color: 'var(--tg-text-secondary)',
            fontSize: '11px',
            cursor: 'pointer',
          }}
        >
          {expanded ? 'Hide ▴' : 'Show ▾'}
        </button>
      </div>

      {expanded && (
        <>
          {turn.thinkingText && (
            <div
              style={{
                fontSize: '12px',
                color: 'var(--tg-text-secondary)',
                padding: '6px 8px',
                borderRadius: '6px',
                backgroundColor: 'var(--tg-bubble-code-bg)',
                whiteSpace: 'pre-wrap',
                marginBottom: turn.outputText ? '8px' : 0,
              }}
            >
              {turn.thinkingText}
            </div>
          )}

          {turn.toolCalls.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '6px' }}>
              {turn.toolCalls.map((tc) => (
                <span
                  key={tc.id}
                  style={{
                    padding: '2px 7px',
                    borderRadius: '999px',
                    backgroundColor: tc.ok === false ? 'var(--tg-danger-soft)' : 'var(--tg-success-soft)',
                    color: tc.ok === false ? 'var(--tg-danger)' : 'var(--tg-success)',
                    fontSize: '11px',
                    fontFamily: 'var(--tg-font-mono)',
                  }}
                >
                  ⚙ {tc.name} {tc.ok === false ? '✕' : tc.ok ? '✓' : '…'}
                </span>
              ))}
            </div>
          )}

          {isProviderError && turn.error && (
            <ProviderErrorCard messageText={turn.error} />
          )}

          {turn.error && !isProviderError && (
            <div
              role="alert"
              style={{
                padding: '8px 10px',
                borderRadius: '8px',
                backgroundColor: 'var(--tg-danger-soft)',
                color: 'var(--tg-danger)',
                fontSize: '12.5px',
              }}
            >
              {turn.error}
            </div>
          )}

          {turn.outputText && (
            <div style={{ fontSize: '14px', whiteSpace: 'pre-wrap' }}>
              {turn.outputText}
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ============================================================================
// Sub-Renderers for Rich Message Cards
// ============================================================================

const SpoilerPhotoVideoCard: React.FC<{
  chatId: number;
  messageId: number;
  fileId: string;
  explicitUrl?: string;
  mimeType: string;
  caption?: string | null;
  hasSpoiler?: boolean;
  isOutgoing?: boolean;
  width?: number;
  height?: number;
}> = ({
  chatId,
  messageId,
  fileId,
  explicitUrl,
  mimeType,
  caption,
  hasSpoiler,
  isOutgoing,
}) => {
  const openLightbox = useUiStore((s) => s.openLightbox);
  const [revealed, setRevealed] = useState<boolean>(!hasSpoiler);
  const streamUrl = resolveMediaUrl(fileId, explicitUrl);
  const isVideo = mimeType.toLowerCase().startsWith('video/');
  const concealed = Boolean(hasSpoiler && !revealed);

  const handleActivate = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (concealed) {
      setRevealed(true);
      return;
    }
    openLightbox({
      chatId,
      messageId,
      mediaUrl: streamUrl,
      mimeType,
      caption: caption ?? undefined,
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div
        data-testid={isVideo ? 'video-card' : 'photo-card'}
        onClick={handleActivate}
        style={{
          position: 'relative',
          borderRadius: '10px',
          overflow: 'hidden',
          cursor: 'pointer',
          backgroundColor: '#0E1621',
          maxWidth: '420px',
          minWidth: '180px',
        }}
      >
        {isVideo ? (
          <video
            src={streamUrl}
            controls={!concealed}
            playsInline
            preload="metadata"
            style={{
              display: 'block',
              width: '100%',
              maxHeight: '340px',
              objectFit: 'cover',
              filter: concealed ? 'blur(20px)' : 'none',
              transition: 'filter 160ms ease',
            }}
          />
        ) : (
          <img
            src={streamUrl}
            alt={caption || 'Photo'}
            loading="eager"
            style={{
              display: 'block',
              width: '100%',
              maxHeight: '340px',
              objectFit: 'cover',
              filter: concealed ? 'blur(20px)' : 'none',
              transition: 'filter 160ms ease',
            }}
          />
        )}

        {concealed && (
          <div
            data-testid="media-spoiler-overlay"
            data-spoiler="true"
            data-revealed="false"
            role="button"
            tabIndex={0}
            aria-label="Reveal media spoiler"
            onClick={(e) => {
              e.stopPropagation();
              setRevealed(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                setRevealed(true);
              }
            }}
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(14, 22, 33, 0.42)',
              color: '#FFFFFF',
              fontSize: '12.5px',
              fontWeight: 600,
            }}
          >
            <span
              style={{
                padding: '6px 12px',
                borderRadius: '999px',
                backgroundColor: 'rgba(14, 22, 33, 0.78)',
                border: '1px solid rgba(255,255,255,0.2)',
              }}
            >
              Spoiler · Tap to reveal
            </span>
          </div>
        )}
      </div>

      {caption && (
        <RichEntities
          text={caption}
          chatId={chatId}
          suppressAutoPreview
          isOutgoing={isOutgoing}
        />
      )}
    </div>
  );
};

const VoiceNoteCard: React.FC<{
  message: MessageItem;
  fileId: string;
  durationSecs: number;
  waveform?: number[];
  waveformB64?: string;
  initialTranscript?: string;
  titleLabel?: string | null;
}> = ({
  message,
  fileId,
  durationSecs,
  waveform,
  waveformB64,
  initialTranscript,
  titleLabel,
}) => {
  const audioPlayerState = useUiStore((s) => s.audioPlayerState);
  const playVoiceOrAudio = useUiStore((s) => s.playVoiceOrAudio);
  const toggleAudioPlayPause = useUiStore((s) => s.toggleAudioPlayPause);
  const seekAudioProgress = useUiStore((s) => s.seekAudioProgress);
  const cycleAudioRate = useUiStore((s) => s.cycleAudioRate);

  const voiceTranscripts = useChatStore((s) => s.voiceTranscripts);
  const transcribeVoiceMessage = useChatStore((s) => s.transcribeVoiceMessage);

  const [localProgress, setLocalProgress] = useState<number>(0);
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false);

  const bars = useMemo(
    () => decode100VoiceBars(waveform, waveformB64, message.id),
    [message.id, waveform, waveformB64],
  );

  const streamUrl = resolveMediaUrl(fileId);
  const isActiveTrack =
    audioPlayerState.isOpen &&
    audioPlayerState.message?.id === message.id &&
    audioPlayerState.chatId === message.chat_id;
  const isPlaying = isActiveTrack && audioPlayerState.isPlaying;
  const progress = isActiveTrack ? audioPlayerState.progress : localProgress;
  const effectiveDuration = Math.max(
    1,
    isActiveTrack && audioPlayerState.durationSec > 0
      ? audioPlayerState.durationSec
      : durationSecs || 3,
  );
  const currentSec = progress * effectiveDuration;
  const transcript = voiceTranscripts[fileId] ?? initialTranscript;

  const handleTogglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isActiveTrack) {
      toggleAudioPlayPause();
    } else {
      playVoiceOrAudio(message.chat_id, message, streamUrl, effectiveDuration);
      if (localProgress > 0 && localProgress < 0.99) {
        seekAudioProgress(localProgress);
      }
    }
  };

  const seekFromClientX = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const raw = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const clamped = Math.max(0, Math.min(1, raw));
    setLocalProgress(clamped);
    if (!isActiveTrack) {
      playVoiceOrAudio(message.chat_id, message, streamUrl, effectiveDuration);
    }
    seekAudioProgress(clamped);
  };

  const handleTranscribe = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isTranscribing) return;
    setIsTranscribing(true);
    try {
      await transcribeVoiceMessage(fileId);
    } finally {
      setIsTranscribing(false);
    }
  };

  return (
    <div
      data-testid="voice-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        minWidth: '250px',
        maxWidth: '380px',
      }}
    >
      {titleLabel && (
        <div style={{ fontSize: '12px', fontWeight: 600 }}>{titleLabel}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <button
          type="button"
          data-testid="btn-play-voice"
          data-playing={isPlaying ? 'true' : 'false'}
          aria-label={isPlaying ? 'Pause voice message' : 'Play voice message'}
          onClick={handleTogglePlay}
          style={{
            width: '38px',
            height: '38px',
            borderRadius: '50%',
            border: 'none',
            backgroundColor: 'var(--tg-accent, #3390EC)',
            color: '#FFFFFF',
            fontSize: '14px',
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {isPlaying ? '❚❚' : '▶'}
        </button>{' '}

        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          {/* 100-Bar 5-Bit Interactive Waveform Scrubber */}
          <div
            data-testid="voice-waveform"
            role="slider"
            tabIndex={0}
            aria-label="Voice waveform scrubber"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            data-progress={progress.toFixed(3)}
            onClick={(e) => {
              e.stopPropagation();
              seekFromClientX(e.clientX, e.currentTarget);
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              seekFromClientX(e.clientX, e.currentTarget);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') {
                e.preventDefault();
                const next = Math.min(1, progress + 0.1);
                setLocalProgress(next);
                if (isActiveTrack) seekAudioProgress(next);
              } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                const prev = Math.max(0, progress - 0.1);
                setLocalProgress(prev);
                if (isActiveTrack) seekAudioProgress(prev);
              }
            }}
            style={{
              height: '28px',
              display: 'flex',
              alignItems: 'center',
              gap: '1px',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            {bars.map((amp, idx) => {
              const played = idx / TELEGRAM_WAVEFORM_BARS <= progress;
              const pctHeight = Math.max(18, Math.round(((amp + 3) / 34) * 100));
              return (
                <span
                  key={idx}
                  data-waveform-bar="true"
                  data-played={played ? 'true' : 'false'}
                  className="tg-waveform-bar"
                  style={{
                    flex: '1 1 0',
                    minWidth: '1.5px',
                    height: `${pctHeight}%`,
                    borderRadius: '2px',
                    backgroundColor: played
                      ? 'var(--tg-accent, #3390EC)'
                      : 'rgba(255, 255, 255, 0.34)',
                  }}
                />
              );
            })}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: '3px',
              fontSize: '11px',
              color: 'var(--tg-text-secondary, #8FA2B7)',
            }}
          >
            <span data-testid="voice-duration">
              {isPlaying || progress > 0
                ? `${formatDurationClock(currentSec)} / ${formatDurationClock(effectiveDuration)}`
                : formatDurationClock(effectiveDuration)}
            </span>{' '}

            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <button
                type="button"
                data-testid="btn-voice-rate"
                aria-label={`Playback speed ${audioPlayerState.rate}x`}
                title="Playback speed"
                onClick={(e) => {
                  e.stopPropagation();
                  cycleAudioRate();
                }}
                style={miniPillBtnStyle}
              >
                {audioPlayerState.rate}x
              </button>{' '}

              <button
                type="button"
                data-testid="btn-transcribe-voice"
                aria-label="Transcribe voice to text"
                onClick={(e) => void handleTranscribe(e)}
                style={miniPillBtnStyle}
              >
                {isTranscribing ? '…' : '->A'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {transcript && (
        <div
          data-testid="voice-transcript"
          style={{
            padding: '6px 9px',
            borderRadius: '7px',
            backgroundColor: 'rgba(0, 0, 0, 0.2)',
            borderLeft: '2px solid var(--tg-accent, #3390EC)',
            fontSize: '12.5px',
            lineHeight: 1.4,
            color: 'var(--tg-text-primary, #F5F5F5)',
          }}
        >
          {transcript}
        </div>
      )}
    </div>
  );
};

const RoundVideoNoteCard: React.FC<{
  fileId: string;
  durationSecs: number;
}> = ({ fileId, durationSecs }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [muted, setMuted] = useState<boolean>(true);
  const [playing, setPlaying] = useState<boolean>(true);
  const [videoFailed, setVideoFailed] = useState<boolean>(false);
  const streamUrl = resolveMediaUrl(fileId);

  const toggleRoundVideo = (e: React.MouseEvent) => {
    e.stopPropagation();
    const v = videoRef.current;
    if (!v || videoFailed) {
      setMuted((m) => !m);
      setPlaying((p) => !p);
      return;
    }
    if (muted) {
      v.muted = false;
      setMuted(false);
      void v.play().catch(() => undefined);
      setPlaying(true);
    } else if (!v.paused) {
      v.pause();
      setPlaying(false);
    } else {
      void v.play().catch(() => undefined);
      setPlaying(true);
    }
  };

  return (
    <div
      data-testid="round-video"
      onClick={toggleRoundVideo}
      role="button"
      tabIndex={0}
      aria-label="Round video message"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleRoundVideo(e as unknown as React.MouseEvent);
        }
      }}
      style={{
        width: '240px',
        height: '240px',
        borderRadius: '50%',
        overflow: 'hidden',
        position: 'relative',
        border: '2.5px solid var(--tg-accent, #3390EC)',
        backgroundColor: '#0E1621',
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      {!videoFailed ? (
        <video
          ref={videoRef}
          src={streamUrl}
          autoPlay
          loop
          muted={muted}
          playsInline
          onError={() => setVideoFailed(true)}
          style={{
            width: '240px',
            height: '240px',
            borderRadius: '50%',
            objectFit: 'cover',
            display: 'block',
          }}
        />
      ) : (
        <div
          style={{
            width: '240px',
            height: '240px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background:
              'radial-gradient(circle at 35% 30%, #1F3B57 0%, #0E1621 75%)',
            color: '#DCE6F2',
            fontSize: '13px',
          }}
        >
          <span style={{ fontSize: '28px', marginBottom: '4px' }}>
            {playing ? '❚❚' : '▶'}
          </span>
          <span>Video Note</span>
        </div>
      )}

      <div
        style={{
          position: 'absolute',
          bottom: '12px',
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '2px 9px',
          borderRadius: '999px',
          backgroundColor: 'rgba(14, 22, 33, 0.76)',
          color: '#FFFFFF',
          fontSize: '11px',
          fontWeight: 600,
        }}
      >
        {formatDurationClock(durationSecs || 3)} · {muted ? 'Muted' : 'Sound On'}
      </div>
    </div>
  );
};

const PollQuizCard: React.FC<{
  chatId: number;
  messageId: number;
  poll: PollData;
}> = ({ chatId, messageId, poll }) => {
  const votePoll = useChatStore((s) => s.votePoll);
  const closePoll = useChatStore((s) => s.closePoll);
  const peersById = useChatStore((s) => s.peersById);
  const currentUser = useAuthStore((s) => s.currentUser);

  const [resultsOpen, setResultsOpen] = useState<boolean>(false);

  useEffect(() => {
    if (!resultsOpen || typeof window === 'undefined') return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setResultsOpen(false);
      }
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [resultsOpen]);

  const chosenIds = useMemo(
    () => poll.options.filter((o) => o.is_chosen).map((o) => o.option_id),
    [poll.options],
  );
  const hasVoted = chosenIds.length > 0;
  const showPercentages = hasVoted || poll.is_closed;
  const totalVotes = Math.max(
    poll.total_voters,
    poll.options.reduce((acc, o) => acc + (o.vote_count || 0), 0),
  );

  const handleOptionClick = (optionId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (poll.is_closed) return;
    if (poll.is_quiz && hasVoted) return;

    if (poll.allows_multiple_answers) {
      const exists = chosenIds.includes(optionId);
      const next = exists
        ? chosenIds.filter((id) => id !== optionId)
        : [...chosenIds, optionId];
      void votePoll(chatId, messageId, poll.poll_id, next);
      return;
    }

    if (hasVoted && chosenIds[0] === optionId && !poll.is_quiz) {
      return;
    }
    void votePoll(chatId, messageId, poll.poll_id, [optionId]);
  };

  const subtitleParts: string[] = [];
  if (poll.is_closed) {
    subtitleParts.push('Final Results · 已结束');
  } else if (poll.is_quiz) {
    subtitleParts.push(poll.is_anonymous ? 'Anonymous Quiz · 匿名测验' : 'Quiz · 测验');
  } else {
    subtitleParts.push(
      poll.is_anonymous ? 'Anonymous Poll · 匿名投票' : 'Public Poll · 公开投票',
    );
  }
  if (poll.allows_multiple_answers && !poll.is_quiz) {
    subtitleParts.push('Multiple Answers');
  }

  return (
    <div
      data-testid="poll-card"
      data-closed={poll.is_closed ? 'true' : 'false'}
      data-quiz={poll.is_quiz ? 'true' : 'false'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minWidth: '250px',
        maxWidth: '400px',
      }}
    >
      <div>
        <div style={{ fontSize: '14.5px', fontWeight: 700, lineHeight: 1.35 }}>
          {poll.question}
        </div>
        <div
          style={{
            fontSize: '11.5px',
            color: 'var(--tg-text-secondary, #8FA2B7)',
            marginTop: '2px',
          }}
        >
          {subtitleParts.join(' · ')}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {poll.options.map((opt) => {
          const pct =
            opt.percentage !== undefined && Number.isFinite(opt.percentage) && totalVotes > 0
              ? Math.round(opt.percentage)
              : totalVotes > 0
                ? Math.round((opt.vote_count / totalVotes) * 100)
                : 0;
          const isQuizCorrect =
            poll.is_quiz && showPercentages && poll.correct_option_id === opt.option_id;
          const isQuizWrongChosen =
            poll.is_quiz &&
            showPercentages &&
            opt.is_chosen &&
            poll.correct_option_id !== undefined &&
            poll.correct_option_id !== opt.option_id;

          const barColor = isQuizCorrect
            ? '#00C972'
            : isQuizWrongChosen
              ? '#E15B64'
              : 'var(--tg-accent, #3390EC)';

          return (
            <button
              key={opt.option_id}
              type="button"
              data-testid="poll-option"
              data-option-id={String(opt.option_id)}
              data-chosen={opt.is_chosen ? 'true' : 'false'}
              aria-pressed={opt.is_chosen}
              data-locked={poll.is_closed || (poll.is_quiz && hasVoted) ? 'true' : undefined}
              onClick={(e) => handleOptionClick(opt.option_id, e)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '8px 10px',
                borderRadius: '8px',
                border: opt.is_chosen
                  ? `1px solid ${barColor}`
                  : '1px solid rgba(255, 255, 255, 0.14)',
                backgroundColor: 'rgba(0, 0, 0, 0.18)',
                color: 'var(--tg-text-primary, #F5F5F5)',
                cursor:
                  poll.is_closed || (poll.is_quiz && hasVoted)
                    ? 'default'
                    : 'pointer',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  fontSize: '13px',
                  fontWeight: opt.is_chosen ? 600 : 400,
                }}
              >
                <span>
                  {isQuizCorrect
                    ? '✓ '
                    : isQuizWrongChosen
                      ? '✕ '
                      : opt.is_chosen
                        ? '● '
                        : '○ '}
                  {opt.text}
                </span>
                {showPercentages && (
                  <span style={{ fontSize: '12px', fontWeight: 600, flexShrink: 0 }}>
                    {pct}% ({opt.vote_count})
                  </span>
                )}
              </div>

              {showPercentages && (
                <div
                  style={{
                    marginTop: '6px',
                    height: '5px',
                    width: '100%',
                    borderRadius: '999px',
                    backgroundColor: 'rgba(255, 255, 255, 0.1)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                    data-percent={String(pct)}
                    className="tg-poll-option-bar"
                    style={{
                      width: `${pct}%`,
                      height: '100%',
                      borderRadius: '999px',
                      backgroundColor: barColor,
                      transition: 'width 180ms ease',
                    }}
                  />
                </div>
              )}
            </button>
          );
        })}
      </div>

      {poll.is_quiz && showPercentages && (poll.explanation || poll.solution) && (
        <div
          data-testid="quiz-explanation"
          style={{
            padding: '7px 10px',
            borderRadius: '8px',
            backgroundColor: 'rgba(0, 201, 114, 0.14)',
            borderLeft: '3px solid #00C972',
            fontSize: '12.5px',
            color: 'var(--tg-text-primary, #F5F5F5)',
          }}
        >
          <strong>Explanation: </strong>
          {poll.explanation || poll.solution}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '6px',
          paddingTop: '4px',
          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
          fontSize: '11.5px',
          color: 'var(--tg-text-secondary, #8FA2B7)',
        }}
      >
        <span>
          {totalVotes} {totalVotes === 1 ? 'vote' : 'votes'}
        </span>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {hasVoted && !poll.is_quiz && !poll.is_closed && (
            <button
              type="button"
              data-testid="btn-retract-vote"
              onClick={(e) => {
                e.stopPropagation();
                void votePoll(chatId, messageId, poll.poll_id, []);
              }}
              style={miniPillBtnStyle}
            >
              Retract Vote · 撤销投票
            </button>
          )}

          {!poll.is_closed && (
            <button
              type="button"
              data-testid="btn-stop-poll"
              onClick={(e) => {
                e.stopPropagation();
                void closePoll(chatId, messageId, poll.poll_id);
              }}
              style={miniPillBtnStyle}
            >
              Stop Poll · 结束投票
            </button>
          )}

          <button
            type="button"
            data-testid="btn-poll-results"
            onClick={(e) => {
              e.stopPropagation();
              setResultsOpen(true);
            }}
            style={miniPillBtnStyle}
          >
            View Results · 查看结果
          </button>
        </div>
      </div>

      {resultsOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Poll Results"
          data-testid="poll-results"
          onClick={(e) => {
            e.stopPropagation();
            if (e.target === e.currentTarget) setResultsOpen(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1250,
            backgroundColor: 'rgba(10, 15, 22, 0.76)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
          }}
        >
          <div
            style={{
              width: 'min(420px, 94vw)',
              maxHeight: '80dvh',
              overflowY: 'auto',
              backgroundColor: 'var(--tg-bg-surface, #17212B)',
              border: '1px solid var(--tg-border, #242F3D)',
              borderRadius: '12px',
              padding: '16px',
              color: 'var(--tg-text-primary, #F5F5F5)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '12px',
              }}
            >
              <strong>Poll Results · 投票详情</strong>
              <button
                type="button"
                aria-label="Close poll results"
                onClick={() => setResultsOpen(false)}
                style={miniPillBtnStyle}
              >
                Close ✕
              </button>
            </div>
            <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '10px' }}>
              {poll.question}
            </div>
            {poll.options.map((opt) => {
              const voterIds =
                opt.voter_ids && opt.voter_ids.length > 0
                  ? opt.voter_ids
                  : opt.is_chosen && currentUser
                    ? [currentUser.userId]
                    : [];
              return (
                <div
                  key={opt.option_id}
                  style={{
                    padding: '8px 10px',
                    marginBottom: '8px',
                    borderRadius: '8px',
                    backgroundColor: 'rgba(255,255,255,0.04)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                    <strong>{opt.text}</strong>
                    <span>
                      {opt.vote_count} vote(s)
                    </span>
                  </div>
                  {voterIds.length > 0 && !poll.is_anonymous && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
                      {voterIds.map((uid) => {
                        const p = peersById[uid];
                        const name =
                          uid === currentUser?.userId
                            ? currentUser.firstName || 'You'
                            : p?.firstName || `User #${uid}`;
                        return (
                          <span
                            key={uid}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              fontSize: '12px',
                              padding: '2px 7px',
                              borderRadius: '999px',
                              backgroundColor: 'rgba(51, 144, 236, 0.16)',
                            }}
                          >
                            <span
                              data-avatar="true"
                              style={{
                                width: '18px',
                                height: '18px',
                                borderRadius: '50%',
                                backgroundColor:
                                  AVATAR_COLORS[peerAvatarColorIndex(uid)] ?? '#3390EC',
                                color: '#FFF',
                                fontSize: '10px',
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              {name.slice(0, 1).toUpperCase()}
                            </span>
                            <span>{name}</span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

const EncryptedSecretCard: React.FC<{
  message: MessageItem;
  envelope: EncryptedEnvelope;
  peerUserId?: number;
}> = ({ message, envelope, peerUserId }) => {
  const decryptedSecretTexts = useChatStore((s) => s.decryptedSecretTexts);
  const currentUser = useAuthStore((s) => s.currentUser);
  const [localPlaintext, setLocalPlaintext] = useState<string | null>(null);
  const [tamperError, setTamperError] = useState<string | null>(null);

  const cacheKey = `${message.chat_id}:${message.id}`;
  const cachedText = decryptedSecretTexts[cacheKey];

  useEffect(() => {
    if (cachedText !== undefined) {
      setLocalPlaintext(cachedText);
      setTamperError(null);
      return;
    }

    let cancelled = false;
    const localUid = currentUser?.userId ?? 1;
    const fanoutRecipientId =
      envelope.kind.kind === 'PairwiseFanout' ||
      envelope.kind.kind === 'SenderKeyDistribution'
        ? envelope.kind.payload.recipients[0]?.recipient_user_id
        : undefined;
    const remoteUid =
      peerUserId ??
      (envelope.sender_user_id === localUid
        ? (fanoutRecipientId ?? localUid)
        : envelope.sender_user_id);

    decryptEnvelope({
      localUserId: localUid,
      chatId: message.chat_id,
      peerUserId: remoteUid,
      envelope,
    })
      .then((res) => {
        if (!cancelled) {
          setLocalPlaintext(res.text);
          setTamperError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setTamperError(
            err instanceof Error
              ? err.message
              : 'Invalid or tampered E2EE ciphertext',
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cachedText, currentUser?.userId, envelope, message.chat_id, message.id, peerUserId]);

  if (tamperError) {
    return (
      <div
        data-testid="e2ee-tamper-warning"
        style={{
          padding: '8px 10px',
          borderRadius: '8px',
          backgroundColor: 'rgba(225, 91, 100, 0.16)',
          border: '1px solid rgba(225, 91, 100, 0.45)',
          color: '#FF9DA4',
          fontSize: '12.5px',
        }}
      >
        ⚠ Decryption rejected: Tampered or unverified E2EE envelope ({tamperError})
      </div>
    );
  }

  return (
    <div data-testid="e2ee-decrypted-body">
      <RichEntities
        text={cachedText ?? localPlaintext ?? 'Decrypting E2EE message…'}
        chatId={message.chat_id}
        isOutgoing={Boolean(message.flags?.is_out)}
      />
    </div>
  );
};

// ============================================================================
// Main MessageCards Dispatcher + Bot Inline Keyboard + TTL Countdown
// ============================================================================

export const MessageCards: React.FC<MessageCardsProps> = ({
  message,
  peerUserId,
}) => {
  const openLightbox = useUiStore((s) => s.openLightbox);
  const setMiniAppModalOpen = useUiStore((s) => s.setMiniAppModalOpen);
  const pushToast = useUiStore((s) => s.pushToast);

  const toggleTodoItem = useChatStore((s) => s.toggleTodoItem);
  const payInvoice = useChatStore((s) => s.payInvoice);
  const clickInlineKeyboardButton = useChatStore(
    (s) => s.clickInlineKeyboardButton,
  );
  const sendText = useChatStore((s) => s.sendText);
  const deleteMessages = useChatStore((s) => s.deleteMessages);
  const chatsById = useChatStore((s) => s.chatsById);

  const launchMiniApp = useAiWorkspaceStore((s) => s.launchMiniApp);

  const [revealedAlbumTiles, setRevealedAlbumTiles] = useState<
    Record<number, boolean>
  >({});
  const [localPaidInvoice, setLocalPaidInvoice] = useState<boolean>(false);
  const [payingInvoice, setPayingInvoice] = useState<boolean>(false);
  const [remainingTtlSec, setRemainingTtlSec] = useState<number | null>(null);

  // Live Self-Destruct TTL Countdown & Auto-Purge
  useEffect(() => {
    const ttl = message.ttl_seconds;
    if (!ttl || ttl <= 0) {
      setRemainingTtlSec(null);
      return;
    }

    const baseStartMs = message.date_ms ?? Date.parse(message.date) ?? Date.now();
    const expiresAt =
      message.expires_at_ms && message.expires_at_ms > 0
        ? message.expires_at_ms
        : baseStartMs + ttl * 1000;

    const tick = () => {
      const left = Math.ceil((expiresAt - Date.now()) / 1000);
      if (left <= 0) {
        setRemainingTtlSec(0);
        void deleteMessages(message.chat_id, [message.id], false);
      } else {
        setRemainingTtlSec(left);
      }
    };

    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [
    deleteMessages,
    message.chat_id,
    message.date,
    message.date_ms,
    message.expires_at_ms,
    message.id,
    message.ttl_seconds,
  ]);

  const handlePayInvoice = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (payingInvoice) return;
      setPayingInvoice(true);
      try {
        const res = await payInvoice(message.chat_id, message.id);
        if (res.paid) {
          setLocalPaidInvoice(true);
          pushToast('Payment complete · Receipt generated', 'success');
        }
      } catch (err) {
        pushToast(
          err instanceof Error ? err.message : 'Payment failed',
          'error',
        );
      } finally {
        setPayingInvoice(false);
      }
    },
    [message.chat_id, message.id, payInvoice, payingInvoice, pushToast],
  );

  const c = message.content;

  const renderContentBody = (): React.ReactNode => {
    switch (c.type) {
      case 'Text': {
        const textBody = message.text ?? c.data.text;
        const isProviderError =
          /provider_not_configured|\bPROVIDER_ERROR\b|未配置.*模型供应商/i.test(
            textBody,
          );
        if (isProviderError) {
          return <ProviderErrorCard messageText={textBody} />;
        }
        return (
          <RichEntities
            text={textBody}
            entities={message.entities ?? c.data.entities}
            webPage={message.web_page}
            chatId={message.chat_id}
            isOutgoing={Boolean(message.flags?.is_out)}
          />
        );
      }

      case 'Photo':
        return (
          <SpoilerPhotoVideoCard
            chatId={message.chat_id}
            messageId={message.id}
            fileId={c.data.file_id}
            mimeType="image/png"
            caption={c.data.caption}
            hasSpoiler={c.data.has_spoiler}
            isOutgoing={Boolean(message.flags?.is_out)}
            width={c.data.width}
            height={c.data.height}
          />
        );

      case 'Video':
        return (
          <SpoilerPhotoVideoCard
            chatId={message.chat_id}
            messageId={message.id}
            fileId={c.data.file_id}
            mimeType="video/mp4"
            caption={c.data.caption}
            hasSpoiler={c.data.has_spoiler}
            isOutgoing={Boolean(message.flags?.is_out)}
            width={c.data.width}
            height={c.data.height}
          />
        );

      case 'Media': {
        const mime = (c.data.mime_type || 'application/octet-stream').toLowerCase();
        if (mime.startsWith('image/') || mime.startsWith('video/')) {
          return (
            <SpoilerPhotoVideoCard
              chatId={message.chat_id}
              messageId={message.id}
              fileId={c.data.file_id}
              explicitUrl={c.data.url}
              mimeType={c.data.mime_type}
              caption={c.data.caption}
              hasSpoiler={c.data.has_spoiler}
              isOutgoing={Boolean(message.flags?.is_out)}
              width={c.data.width}
              height={c.data.height}
            />
          );
        }
        if (mime.startsWith('audio/')) {
          return (
            <VoiceNoteCard
              message={message}
              fileId={c.data.file_id}
              durationSecs={c.data.duration_seconds ?? 4}
              waveform={c.data.waveform}
              waveformB64={c.data.waveform_b64}
              titleLabel={c.data.file_name}
            />
          );
        }
        const docUrl = resolveMediaUrl(c.data.file_id, c.data.url);
        const docName = c.data.file_name || `document-${message.id}.bin`;
        const badge = extractExtensionBadge(docName, c.data.mime_type);
        return (
          <div
            data-testid="document-card"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              minWidth: '230px',
            }}
          >
            <div style={fileExtBadgeStyle}>{badge}</div>{' '}
            <div
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div
                style={{
                  fontSize: '13.5px',
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {docName}
              </div>{' '}
              <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary, #8FA2B7)' }}>
                {formatByteSize(c.data.size_bytes)}
              </div>
            </div>{' '}
            <button
              type="button"
              data-testid="btn-download-file"
              aria-label={`Download ${docName}`}
              onClick={(e) => {
                e.stopPropagation();
                void triggerBrowserFileDownload(docUrl, docName);
              }}
              style={miniPillBtnStyle}
            >
              ⬇ Download
            </button>
          </div>
        );
      }

      case 'Document': {
        const docUrl = resolveMediaUrl(c.data.file_id);
        const docName = c.data.file_name || `file-${message.id}.bin`;
        const badge = extractExtensionBadge(docName, c.data.mime_type);
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div
              data-testid="document-card"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                minWidth: '230px',
              }}
            >
              <div style={fileExtBadgeStyle}>{badge}</div>{' '}
              <div
                style={{
                  flex: '1 1 auto',
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div
                  style={{
                    fontSize: '13.5px',
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {docName}
                </div>{' '}
                <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary, #8FA2B7)' }}>
                  {formatByteSize(c.data.size_bytes)}
                </div>
              </div>{' '}
              <button
                type="button"
                data-testid="btn-download-file"
                aria-label={`Download ${docName}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void triggerBrowserFileDownload(docUrl, docName);
                }}
                style={miniPillBtnStyle}
              >
                ⬇ Download
              </button>
            </div>
            {c.data.caption && (
              <RichEntities
                text={c.data.caption}
                chatId={message.chat_id}
                suppressAutoPreview
                isOutgoing={Boolean(message.flags?.is_out)}
              />
            )}
          </div>
        );
      }

      case 'Album': {
        const items = c.data.items.slice(0, 10);
        const count = items.length;
        const gridColumns =
          count === 1
            ? '1fr'
            : count === 2 || count === 4
              ? 'repeat(2, minmax(112px, 1fr))'
              : count === 3
                ? '2fr 1fr'
                : 'repeat(3, minmax(88px, 1fr))';

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div
              data-testid="media-album"
              data-count={String(count)}
              className="tg-album-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: gridColumns,
                gap: '3px',
                width: '100%',
                minWidth: count >= 2 ? '240px' : '180px',
                maxWidth: '420px',
                borderRadius: '10px',
                overflow: 'hidden',
              }}
            >
              {items.map((item, idx) => {
                const tileUrl = resolveMediaUrl(item.file_id);
                const tileMime = item.mime_type || 'image/png';
                const tileVideo = tileMime.toLowerCase().startsWith('video/');
                const tileConcealed = Boolean(
                  item.has_spoiler && !revealedAlbumTiles[idx],
                );
                return (
                  <div
                    key={`${item.file_id}-${idx}`}
                    data-testid="album-tile"
                    className="tg-album-cell"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (tileConcealed) {
                        setRevealedAlbumTiles((prev) => ({ ...prev, [idx]: true }));
                        return;
                      }
                      openLightbox({
                        chatId: message.chat_id,
                        messageId: message.id,
                        mediaUrl: tileUrl,
                        mimeType: tileMime,
                        caption: item.caption ?? c.data.caption,
                      });
                    }}
                    style={{
                      position: 'relative',
                      aspectRatio: count === 3 && idx === 0 ? '1 / 2' : '1 / 1',
                      gridRow: count === 3 && idx === 0 ? 'span 2' : undefined,
                      overflow: 'hidden',
                      backgroundColor: '#0E1621',
                      cursor: 'pointer',
                    }}
                  >
                    {tileVideo ? (
                      <video
                        src={tileUrl}
                        muted
                        playsInline
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          display: 'block',
                          filter: tileConcealed ? 'blur(16px)' : 'none',
                        }}
                      />
                    ) : (
                      <img
                        src={tileUrl}
                        alt={item.caption || `Album item ${idx + 1}`}
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          display: 'block',
                          filter: tileConcealed ? 'blur(16px)' : 'none',
                        }}
                      />
                    )}
                    {tileConcealed && (
                      <div
                        data-spoiler="true"
                        data-revealed="false"
                        style={{
                          position: 'absolute',
                          inset: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          backgroundColor: 'rgba(14,22,33,0.45)',
                          color: '#FFF',
                          fontSize: '11px',
                          fontWeight: 600,
                        }}
                      >
                        Spoiler
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {c.data.caption && (
              <RichEntities
                text={c.data.caption}
                entities={c.data.entities}
                chatId={message.chat_id}
                suppressAutoPreview
                isOutgoing={Boolean(message.flags?.is_out)}
              />
            )}
          </div>
        );
      }

      case 'Sticker': {
        const hasGraphicUrl =
          c.data.file_id &&
          (c.data.file_id.startsWith('data:') ||
            c.data.file_id.startsWith('blob:') ||
            c.data.file_id.startsWith('http'));
        return (
          <div
            data-testid="sticker-card"
            style={{
              width: '160px',
              height: '160px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              userSelect: 'none',
            }}
          >
            {hasGraphicUrl ? (
              <img
                src={c.data.file_id}
                alt={c.data.emoji || 'Sticker'}
                style={{ width: '160px', height: '160px', objectFit: 'contain' }}
              />
            ) : (
              <span style={{ fontSize: '96px', lineHeight: 1 }}>
                {c.data.emoji || '😎'}
              </span>
            )}
          </div>
        );
      }

      case 'Gif': {
        const gifUrl = resolveMediaUrl(c.data.file_id, c.data.url);
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div
              data-testid="gif-card"
              onClick={(e) => {
                e.stopPropagation();
                openLightbox({
                  chatId: message.chat_id,
                  messageId: message.id,
                  mediaUrl: gifUrl,
                  mimeType: 'image/gif',
                  caption: c.data.caption,
                });
              }}
              style={{
                position: 'relative',
                borderRadius: '10px',
                overflow: 'hidden',
                cursor: 'pointer',
                maxWidth: '320px',
                minWidth: '180px',
              }}
            >
              <img
                src={gifUrl}
                alt={c.data.caption || 'GIF'}
                style={{ width: '100%', maxHeight: '260px', objectFit: 'cover', display: 'block' }}
              />
              <span
                style={{
                  position: 'absolute',
                  top: '8px',
                  left: '8px',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  backgroundColor: 'rgba(14, 22, 33, 0.72)',
                  color: '#FFF',
                  fontSize: '10px',
                  fontWeight: 700,
                }}
              >
                GIF
              </span>
            </div>
            {c.data.caption && (
              <RichEntities
                text={c.data.caption}
                chatId={message.chat_id}
                suppressAutoPreview
                isOutgoing={Boolean(message.flags?.is_out)}
              />
            )}
          </div>
        );
      }

      case 'Voice':
        return (
          <VoiceNoteCard
            message={message}
            fileId={c.data.file_id}
            durationSecs={c.data.duration_seconds}
            waveform={c.data.waveform}
            waveformB64={c.data.waveform_b64}
            initialTranscript={c.data.transcript}
          />
        );

      case 'Audio':
        return (
          <VoiceNoteCard
            message={message}
            fileId={c.data.file_id}
            durationSecs={c.data.duration}
            titleLabel={
              [c.data.performer, c.data.title].filter(Boolean).join(' — ') ||
              'Audio Track'
            }
          />
        );

      case 'VideoNote':
        return (
          <RoundVideoNoteCard
            fileId={c.data.file_id}
            durationSecs={c.data.duration_seconds}
          />
        );

      case 'Poll':
        return (
          <PollQuizCard
            chatId={message.chat_id}
            messageId={message.id}
            poll={c.data}
          />
        );

      case 'Todo': {
        const items = c.data.items ?? [];
        const completedCount = items.filter((i) => i.completed).length;
        return (
          <div
            data-testid="todo-card"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              minWidth: '240px',
              maxWidth: '380px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
              }}
            >
              <strong style={{ fontSize: '14px' }}>{c.data.title}</strong>
              <span
                data-testid="todo-progress"
                style={{
                  padding: '2px 8px',
                  borderRadius: '999px',
                  backgroundColor: 'rgba(0, 201, 114, 0.16)',
                  color: '#00C972',
                  fontSize: '11px',
                  fontWeight: 700,
                }}
              >
                {completedCount}/{items.length}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              {items.map((item) => (
                <label
                  key={item.id}
                  data-testid="todo-item"
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 8px',
                    borderRadius: '7px',
                    backgroundColor: 'rgba(0, 0, 0, 0.16)',
                    cursor: 'pointer',
                    fontSize: '13px',
                  }}
                >
                  <input
                    type="checkbox"
                    aria-label={item.title}
                    checked={item.completed}
                    onChange={() =>
                      void toggleTodoItem(
                        message.chat_id,
                        message.id,
                        item.id,
                        !item.completed,
                      )
                    }
                    style={{ accentColor: '#3390EC', cursor: 'pointer' }}
                  />
                  <span
                    style={{
                      textDecoration: item.completed ? 'line-through' : 'none',
                      color: item.completed
                        ? 'var(--tg-text-secondary, #8FA2B7)'
                        : 'var(--tg-text-primary, #F5F5F5)',
                    }}
                  >
                    {item.title}
                  </span>
                </label>
              ))}
            </div>
          </div>
        );
      }

      case 'Invoice': {
        const inv = c.data;
        const isPaid =
          localPaidInvoice || Boolean(inv.is_paid) || inv.status === 'paid';
        const displayAmount =
          inv.total_amount > 0
            ? inv.total_amount
            : Math.max(1, Math.round(inv.amount_cents / 100));
        const isStars =
          !inv.currency ||
          inv.currency.toUpperCase() === 'XTR' ||
          inv.currency.toUpperCase() === 'STARS';

        return (
          <div
            data-testid="invoice-card"
            data-paid={isPaid ? 'true' : 'false'}
            data-status={isPaid ? 'paid' : inv.status}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              minWidth: '240px',
              maxWidth: '360px',
              padding: '4px 2px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <strong style={{ fontSize: '14.5px' }}>{inv.title}</strong>
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: '6px',
                  backgroundColor: 'rgba(229, 160, 48, 0.18)',
                  color: '#E5A030',
                  fontSize: '12px',
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {isStars ? `★ ${displayAmount}` : `${inv.currency} ${displayAmount}`}
              </span>
            </div>

            {inv.description && (
              <div
                style={{
                  fontSize: '12.5px',
                  color: 'var(--tg-text-secondary, #8FA2B7)',
                }}
              >
                {inv.description}
              </div>
            )}

            {isPaid ? (
              <div
                data-testid="invoice-receipt"
                style={{
                  padding: '8px 12px',
                  borderRadius: '8px',
                  backgroundColor: 'rgba(0, 201, 114, 0.18)',
                  border: '1px solid rgba(0, 201, 114, 0.4)',
                  color: '#00C972',
                  fontSize: '13px',
                  fontWeight: 700,
                  textAlign: 'center',
                }}
              >
                ✓ Paid · Payment Receipt · 已支付收据
                {inv.receipt_id ? ` (${inv.receipt_id})` : ''}
              </div>
            ) : (
              <button
                type="button"
                data-testid="btn-pay-invoice"
                disabled={payingInvoice}
                onClick={(e) => void handlePayInvoice(e)}
                style={{
                  padding: '8px 14px',
                  borderRadius: '8px',
                  border: 'none',
                  backgroundColor: 'var(--tg-accent, #3390EC)',
                  color: '#FFFFFF',
                  fontSize: '13px',
                  fontWeight: 700,
                  cursor: payingInvoice ? 'wait' : 'pointer',
                }}
              >
                {payingInvoice
                  ? 'Processing…'
                  : isStars
                    ? `Pay ★ ${displayAmount} · 立即支付`
                    : `Pay ${inv.currency} ${displayAmount} · 立即支付`}
              </button>
            )}
          </div>
        );
      }

      case 'Gift':
        return (
          <div
            data-testid="gift-card"
            style={{
              padding: '10px',
              borderRadius: '10px',
              backgroundColor: 'rgba(229, 160, 48, 0.14)',
              textAlign: 'center',
              minWidth: '200px',
            }}
          >
            <div style={{ fontSize: '36px' }}>{c.data.emoji || '🎁'}</div>
            <div style={{ fontWeight: 700, marginTop: '4px' }}>{c.data.title}</div>
            <div style={{ fontSize: '12px', color: '#E5A030', fontWeight: 600 }}>
              ★ {c.data.stars} Stars Gift
            </div>
            {c.data.message && (
              <div style={{ fontSize: '12px', marginTop: '4px' }}>{c.data.message}</div>
            )}
          </div>
        );

      case 'Location':
        return (
          <div
            data-testid="location-card"
            style={{
              padding: '8px 10px',
              borderRadius: '8px',
              backgroundColor: 'rgba(51, 144, 236, 0.12)',
              minWidth: '210px',
            }}
          >
            <div style={{ fontWeight: 600 }}>
              📍 {c.data.title || 'Shared Location'}
            </div>
            {c.data.address && (
              <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary, #8FA2B7)' }}>
                {c.data.address}
              </div>
            )}
            <div style={{ fontSize: '11.5px', fontFamily: 'var(--tg-font-mono, monospace)' }}>
              {c.data.latitude.toFixed(5)}, {c.data.longitude.toFixed(5)}
            </div>
          </div>
        );

      case 'Contact':
        return (
          <div
            data-testid="contact-card"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              minWidth: '200px',
            }}
          >
            <div
              data-avatar="true"
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                backgroundColor: '#3390EC',
                color: '#FFF',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
              }}
            >
              {c.data.first_name.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight: 600 }}>
                {c.data.first_name} {c.data.last_name ?? ''}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary, #8FA2B7)' }}>
                {c.data.phone_number}
              </div>
            </div>
          </div>
        );

      case 'GenerativeCard':
        return (
          <div
            data-testid="generative-card"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              minWidth: '240px',
            }}
          >
            <div>
              <strong style={{ fontSize: '14px' }}>{c.data.title}</strong>
              {c.data.subtitle && (
                <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary, #8FA2B7)' }}>
                  {c.data.subtitle}
                </div>
              )}
            </div>
            {c.data.components.map((comp, idx) => {
              if (comp.type === 'Divider') {
                return (
                  <hr
                    key={idx}
                    style={{
                      border: 'none',
                      borderTop: '1px solid rgba(255,255,255,0.1)',
                      margin: '2px 0',
                    }}
                  />
                );
              }
              if (comp.type === 'Text') {
                return (
                  <div
                    key={idx}
                    style={{
                      fontWeight: comp.bold ? 600 : 400,
                      fontSize: '13px',
                    }}
                  >
                    {comp.text}
                  </div>
                );
              }
              if (comp.type === 'Badge') {
                return (
                  <span
                    key={idx}
                    style={{
                      alignSelf: 'flex-start',
                      padding: '2px 8px',
                      borderRadius: '999px',
                      backgroundColor: 'rgba(51,144,236,0.18)',
                      color: '#6AB8FF',
                      fontSize: '11px',
                      fontWeight: 600,
                    }}
                  >
                    {comp.label}
                  </span>
                );
              }
              if (comp.type === 'Progress') {
                const ratio = clampGenerativeProgress(comp.value, comp.max);
                return (
                  <div key={idx}>
                    {comp.label && (
                      <div style={{ fontSize: '11.5px', marginBottom: '3px' }}>
                        {comp.label}
                      </div>
                    )}
                    <div
                      style={{
                        height: '6px',
                        borderRadius: '999px',
                        backgroundColor: 'rgba(255,255,255,0.12)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.round(ratio * 100)}%`,
                          height: '100%',
                          backgroundColor: '#3390EC',
                        }}
                      />
                    </div>
                  </div>
                );
              }
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void sendText(message.chat_id, comp.action_payload);
                  }}
                  style={miniPillBtnStyle}
                >
                  {comp.label}
                </button>
              );
            })}
          </div>
        );

      case 'Encrypted':
        return (
          <EncryptedSecretCard
            message={message}
            envelope={c.data}
            peerUserId={peerUserId}
          />
        );

      case 'Service':
        return null;
    }
  };

  const inlineRows = message.inline_keyboard ?? [];
  const chatUsername = chatsById[message.chat_id]?.username ?? '';
  const openModal = useUiStore((s) => s.openModal);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {renderContentBody()}

      {remainingTtlSec !== null && remainingTtlSec > 0 && (
        <div
          data-testid="message-ttl-countdown"
          style={{
            alignSelf: 'flex-start',
            padding: '1px 7px',
            borderRadius: '999px',
            backgroundColor: 'var(--tg-warning-soft)',
            color: 'var(--tg-warning)',
            fontSize: '11px',
            fontWeight: 600,
          }}
        >
          ⏱ {remainingTtlSec}s
        </div>
      )}

      {inlineRows.length > 0 && (
        <div
          data-testid="inline-keyboard"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            marginTop: '4px',
          }}
        >
          {inlineRows.map((row, rIdx) => (
            <div
              key={rIdx}
              style={{
                display: 'flex',
                gap: '4px',
              }}
            >
              {row.map((btn, bIdx) => {
                const cb = btn.callback_data ?? '';
                const isCodingDeny = cb.startsWith('coding:approve:') && cb.endsWith(':deny');
                const isCodingAllow =
                  cb.startsWith('coding:approve:') && !cb.endsWith(':deny');
                const btnBorder = isCodingDeny
                  ? '1px solid var(--tg-danger)'
                  : isCodingAllow
                    ? '1px solid var(--tg-success)'
                    : '1px solid var(--tg-hairline-border)';
                const btnBg = isCodingDeny
                  ? 'var(--tg-danger-soft)'
                  : isCodingAllow
                    ? 'var(--tg-success-soft)'
                    : 'var(--tg-accent-soft)';
                const btnColor = isCodingDeny
                  ? 'var(--tg-danger)'
                  : isCodingAllow
                    ? 'var(--tg-success)'
                    : 'var(--tg-accent)';

                return (
                  <button
                    key={bIdx}
                    type="button"
                    data-testid="inline-keyboard-btn"
                    data-callback-data={btn.callback_data}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (btn.web_app_url) {
                        if (chatUsername) {
                          setMiniAppModalOpen(true);
                          await launchMiniApp(
                            chatUsername,
                            'app',
                            message.chat_id,
                          ).catch(() => {
                            openModal('miniapp_catalog', { chatId: message.chat_id });
                          });
                        } else {
                          openModal('miniapp_catalog', { chatId: message.chat_id });
                        }
                        return;
                      }
                      const switchInline =
                        (btn as { switch_inline_query_current_chat?: string; switch_inline_query?: string })
                          .switch_inline_query_current_chat ??
                        (btn as { switch_inline_query?: string }).switch_inline_query;
                      if (typeof switchInline === 'string' && typeof window !== 'undefined') {
                        const botUname = chatUsername || 'FabushiBot';
                        window.dispatchEvent(
                          new CustomEvent('fabushi:prefill-inline-query', {
                            detail: {
                              chatId: message.chat_id,
                              botUsername: botUname,
                              query: switchInline,
                            },
                          }),
                        );
                        return;
                      }
                      if (btn.url && isSafeEntityUrl(btn.url)) {
                        window.open(btn.url, '_blank', 'noopener,noreferrer');
                        return;
                      }
                      const answer = await clickInlineKeyboardButton(
                        message.chat_id,
                        message.id,
                        btn.callback_data || btn.text,
                      );
                      if (answer) {
                        pushToast(answer, 'info');
                      }
                    }}
                    style={{
                      flex: '1 1 0',
                      padding: '6px 10px',
                      borderRadius: '8px',
                      border: btnBorder,
                      backgroundColor: btnBg,
                      color: btnColor,
                      fontSize: '12.5px',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {btn.web_app_url ? `↗ ${btn.text}` : btn.text}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const fileExtBadgeStyle: React.CSSProperties = {
  width: '40px',
  height: '44px',
  borderRadius: '8px',
  backgroundColor: 'var(--tg-accent, #3390EC)',
  color: '#FFFFFF',
  fontSize: '11px',
  fontWeight: 800,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  letterSpacing: '0.02em',
};

const miniPillBtnStyle: React.CSSProperties = {
  padding: '3px 8px',
  borderRadius: '6px',
  border: '1px solid rgba(255, 255, 255, 0.16)',
  backgroundColor: 'rgba(255, 255, 255, 0.06)',
  color: 'var(--tg-text-primary, #F5F5F5)',
  fontSize: '11.5px',
  fontWeight: 600,
  cursor: 'pointer',
};
