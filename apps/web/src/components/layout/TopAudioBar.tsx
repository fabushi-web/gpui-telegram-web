import React from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { formatDurationClock, t } from '../../i18n';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';

export interface TopAudioBarProps {
  className?: string;
}

export const TopAudioBar: React.FC<TopAudioBarProps> = ({ className }) => {
  const language = useSettingsStore((s) => s.language);
  const audioPlayerState = useUiStore((s) => s.audioPlayerState);
  const toggleAudioPlayPause = useUiStore((s) => s.toggleAudioPlayPause);
  const seekAudioProgress = useUiStore((s) => s.seekAudioProgress);
  const cycleAudioRate = useUiStore((s) => s.cycleAudioRate);
  const closeAudioPlayer = useUiStore((s) => s.closeAudioPlayer);
  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);

  const chatsById = useChatStore((s) => s.chatsById);
  const peersById = useChatStore((s) => s.peersById);
  const selectChat = useChatStore((s) => s.selectChat);

  if (!audioPlayerState.isOpen) {
    return null;
  }

  const chatTitle =
    audioPlayerState.chatId !== null
      ? chatsById[audioPlayerState.chatId]?.title
      : undefined;

  const msg = audioPlayerState.message;
  const senderPeer = msg ? peersById[msg.sender_id] : undefined;
  const audioTitle =
    msg?.content.type === 'Audio' && msg.content.data.title
      ? msg.content.data.title
      : undefined;
  const trackLabel =
    audioTitle ||
    (senderPeer ? `${senderPeer.firstName} ${senderPeer.lastName ?? ''}`.trim() : '') ||
    chatTitle ||
    (language === 'zh-CN' ? '语音消息' : 'Voice Message');
  const subtitle =
    msg?.text?.trim() ||
    (language === 'zh-CN' ? '语音播放中' : 'Playing Audio');

  const handleJumpToSourceChat = (): void => {
    if (audioPlayerState.chatId !== null) {
      setActiveNavDest('chats');
      void selectChat(audioPlayerState.chatId);
    }
  };

  return (
    <div
      id={DOM_IDS.TOP_AUDIO_PLAYER_BAR}
      role="region"
      aria-label="Persistent Audio Player"
      className={className}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: '1 1 auto' }}>
        <button
          type="button"
          onClick={toggleAudioPlayPause}
          aria-label={
            audioPlayerState.isPlaying
              ? t('voice.pause', language)
              : t('voice.play', language)
          }
          className="tg-voice-play-btn"
          style={{ width: '32px', height: '32px' }}
        >
          {audioPlayerState.isPlaying ? '❚❚' : '▶'}
        </button>

        <button
          type="button"
          onClick={handleJumpToSourceChat}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            minWidth: 0,
            maxWidth: '220px',
            textAlign: 'left',
          }}
        >
          <span
            style={{
              fontSize: '12.5px',
              fontWeight: 600,
              color: 'var(--tg-text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '100%',
            }}
          >
            {trackLabel}
          </span>
          <span
            style={{
              fontSize: '11px',
              color: 'var(--tg-text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '100%',
            }}
          >
            {subtitle}
          </span>
        </button>

        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(audioPlayerState.progress * 1000)}
          onChange={(e) => seekAudioProgress(Number(e.target.value) / 1000)}
          aria-label="Audio scrub progress"
          className="tg-slider"
          style={{ flex: '1 1 120px', maxWidth: '280px' }}
        />

        <span
          data-testid="audio-player-timestamp"
          style={{
            fontSize: '11.5px',
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--tg-text-secondary)',
            flexShrink: 0,
          }}
        >
          {formatDurationClock(audioPlayerState.currentTimeSec)} /{' '}
          {formatDurationClock(audioPlayerState.durationSec)}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => cycleAudioRate()}
          aria-label={t('voice.speed', language)}
          data-testid="audio-speed-btn"
          className="tg-btn tg-btn--secondary"
          style={{ padding: '4px 8px', fontSize: '12px', fontWeight: 600 }}
        >
          {audioPlayerState.rate}x
        </button>

        <button
          type="button"
          onClick={closeAudioPlayer}
          aria-label={t('common.close', language)}
          data-testid="audio-close-btn"
          className="tg-icon-btn"
          style={{ width: '30px', height: '30px' }}
        >
          ✕
        </button>
      </div>
    </div>
  );
};
