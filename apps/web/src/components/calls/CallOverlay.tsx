import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DOM_IDS, peerAvatarColorIndex } from '@gpui-telegram/protocol';
import { getClientAdapter } from '../../adapters';
import { formatDurationClock, t } from '../../i18n';
import {
  webrtcManager,
  type ActiveWebRtcCallRuntime,
} from '../../services/webrtcManager';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';

export interface CallOverlayProps {
  className?: string;
}

interface CompletedCallSnapshot {
  callId: string;
  chatId: number | null;
  openedOnChatId: number | null;
  peerName: string;
  durationSec: number;
  isVideo: boolean;
  endedAtMs: number;
}

export const CallOverlay: React.FC<CallOverlayProps> = ({ className }) => {
  const language = useSettingsStore((s) => s.language);
  const currentUser = useAuthStore((s) => s.currentUser);

  const activeCall = useUiStore((s) => s.activeCall);
  const toggleCallMinimize = useUiStore((s) => s.toggleCallMinimize);
  const toggleCallMute = useUiStore((s) => s.toggleCallMute);
  const toggleCallVideo = useUiStore((s) => s.toggleCallVideo);
  const toggleCallScreenShare = useUiStore((s) => s.toggleCallScreenShare);
  const endActiveCall = useUiStore((s) => s.endActiveCall);
  const pushToast = useUiStore((s) => s.pushToast);

  const activeChatId = useChatStore((s) => s.activeChatId);
  const chatsById = useChatStore((s) => s.chatsById);
  const peersById = useChatStore((s) => s.peersById);
  const contacts = useChatStore((s) => s.contacts);
  const membersByChat = useChatStore((s) => s.membersByChat);
  const loadChatAdminData = useChatStore((s) => s.loadChatAdminData);
  const sendText = useChatStore((s) => s.sendText);

  const isZh = language === 'zh-CN';

  const [liveRuntime, setLiveRuntime] = useState<ActiveWebRtcCallRuntime | null>(
    activeCall.runtime,
  );
  const [elapsedSec, setElapsedSec] = useState(0);
  const [ratingModal, setRatingModal] = useState<CompletedCallSnapshot | null>(null);
  const [selectedStars, setSelectedStars] = useState<number>(5);
  const [isSubmittingRating, setIsSubmittingRating] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Sync live runtime from webrtcManager into both local state & useUiStore (so #top-call-bar stays in sync too!)
  useEffect(() => {
    setLiveRuntime(activeCall.runtime ?? webrtcManager.getRuntime());
    const unsubscribe = webrtcManager.subscribe((next) => {
      setLiveRuntime(next);
      if (next) {
        useUiStore.setState((prev) =>
          prev.activeCall.isOpen
            ? { activeCall: { ...prev.activeCall, runtime: next } }
            : prev,
        );
      }
    });
    return unsubscribe;
  }, [activeCall.isOpen, activeCall.runtime?.callId]);

  // Live 1-second call duration clock
  useEffect(() => {
    if (!activeCall.isOpen || !liveRuntime) {
      setElapsedSec(0);
      return;
    }

    const computeSec = () => {
      const anchor = liveRuntime.connectedAtMs ?? liveRuntime.startedAtMs ?? Date.now();
      return Math.max(0, Math.floor((Date.now() - anchor) / 1000));
    };

    setElapsedSec(computeSec());
    const timer = setInterval(() => {
      setElapsedSec(computeSec());
    }, 500);

    return () => clearInterval(timer);
  }, [activeCall.isOpen, liveRuntime?.callId, liveRuntime?.connectedAtMs, liveRuntime?.startedAtMs]);

  const resolvedChatId = liveRuntime?.chatId ?? activeChatId ?? null;
  const chat = resolvedChatId !== null ? chatsById[resolvedChatId] ?? null : null;

  useEffect(() => {
    if (activeCall.isOpen && chat && (chat.isGroup || chat.isSupergroup)) {
      void loadChatAdminData(chat.chatId);
    }
  }, [activeCall.isOpen, chat?.chatId, chat?.isGroup, chat?.isSupergroup, loadChatAdminData]);

  // Bind genuine WebRTC MediaStream to <video> (zero synthetic <canvas>!)
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl || !liveRuntime) return;
    const stream = liveRuntime.remoteStream ?? liveRuntime.localStream;
    if (stream && videoEl.srcObject !== stream) {
      try {
        videoEl.srcObject = stream;
        void videoEl.play().catch(() => undefined);
      } catch {
        // Ignore autoplay rejection; mediaError alert surfaces status honestly
      }
    }
  }, [
    liveRuntime,
    liveRuntime?.remoteStream,
    liveRuntime?.localStream,
    liveRuntime?.isVideoEnabled,
    liveRuntime?.isScreenSharing,
    activeCall.isMinimized,
  ]);

  const peerDisplayName = useMemo(() => {
    if (chat) return chat.title;
    if (liveRuntime?.peerUserId) {
      const p =
        peersById[liveRuntime.peerUserId] ??
        contacts.find((c) => c.userId === liveRuntime.peerUserId);
      if (p) {
        return `${p.firstName} ${p.lastName ?? ''}`.trim() || p.username || `User ${p.userId}`;
      }
    }
    return isZh ? '加密通话联系人' : 'Encrypted Peer';
  }, [chat, liveRuntime?.peerUserId, peersById, contacts, isZh]);

  const isGroupCall = Boolean(chat && (chat.isGroup || chat.isSupergroup));

  const groupParticipants = useMemo(() => {
    if (!isGroupCall || !chat) return [];
    const members = membersByChat[chat.chatId] ?? [];
    if (members.length >= 2) {
      return members.map((m) => ({
        userId: m.user_id,
        name: `${m.first_name} ${m.last_name ?? ''}`.trim() || m.username || `User ${m.user_id}`,
        isSelf: m.user_id === currentUser?.userId,
      }));
    }
    const fallback: Array<{ userId: number; name: string; isSelf: boolean }> = [];
    if (currentUser) {
      fallback.push({
        userId: currentUser.userId,
        name: `${currentUser.firstName} ${currentUser.lastName ?? ''}`.trim() || 'You',
        isSelf: true,
      });
    }
    for (const c of [...contacts, ...Object.values(peersById)]) {
      if (c.userId !== currentUser?.userId && fallback.length < 4) {
        fallback.push({
          userId: c.userId,
          name: `${c.firstName} ${c.lastName ?? ''}`.trim() || c.username || `User ${c.userId}`,
          isSelf: false,
        });
      }
    }
    return fallback;
  }, [isGroupCall, chat, membersByChat, currentUser, contacts, peersById]);

  const appendCallSummaryIfMissing = async (snap: CompletedCallSnapshot, stars?: number) => {
    if (!snap.chatId) return;
    const msgs = useChatStore.getState().messagesByChat[snap.chatId] ?? [];
    const alreadyLogged = msgs.some(
      (m) =>
        (m.date_ms ?? 0) >= snap.endedAtMs - 4000 &&
        ((m.content.type === 'Service' && m.content.data.kind === 'call_ended') ||
          /call|通话/i.test(m.text ?? '')),
    );
    if (alreadyLogged) return;

    const kindStr = snap.isVideo
      ? isZh
        ? '视频通话 (Video Call)'
        : 'Video Call'
      : isZh
        ? '语音通话 (Audio Call)'
        : 'Audio Call';
    const durStr = formatDurationClock(Math.max(1, snap.durationSec));
    const ratingPart = stars ? ` · ★ ${stars}/5` : '';
    try {
      await sendText(snap.chatId, `📞 ${kindStr} · ${durStr}${ratingPart}`);
    } catch {
      // Ignore if chat is read-only
    }
  };

  const handleHangUp = async () => {
    const snap: CompletedCallSnapshot | null = liveRuntime
      ? {
          callId: liveRuntime.callId,
          chatId: resolvedChatId,
          openedOnChatId: activeChatId ?? null,
          peerName: peerDisplayName,
          durationSec: Math.max(1, elapsedSec),
          isVideo: Boolean(liveRuntime.isVideo || liveRuntime.isVideoEnabled),
          endedAtMs: Date.now(),
        }
      : null;

    await endActiveCall();

    if (snap) {
      setSelectedStars(5);
      setRatingModal(snap);
    }
  };

  // Auto-dismiss non-blocking post-call rating card if user switches to a different chat
  useEffect(() => {
    if (ratingModal && activeChatId !== ratingModal.openedOnChatId) {
      setRatingModal(null);
    }
  }, [activeChatId, ratingModal]);

  const handleSubmitRating = async () => {
    if (!ratingModal) return;
    setIsSubmittingRating(true);
    try {
      await getClientAdapter()
        .endCall(ratingModal.callId, selectedStars)
        .catch(() => undefined);
      await appendCallSummaryIfMissing(ratingModal, selectedStars);
      pushToast(
        isZh ? `感谢通话质量反馈 (${selectedStars}/5 ★)` : `Call rated ${selectedStars}/5 ★`,
        'success',
      );
    } finally {
      setIsSubmittingRating(false);
      setRatingModal(null);
    }
  };

  const handleDismissRating = async () => {
    if (ratingModal) {
      await appendCallSummaryIfMissing(ratingModal);
    }
    setRatingModal(null);
  };

  const showOverlay = Boolean(
    activeCall.isOpen && !activeCall.isMinimized && liveRuntime !== null,
  );

  if (!showOverlay && !ratingModal) {
    return null;
  }

  const showVideoViewport = Boolean(
    liveRuntime &&
      (liveRuntime.isVideo || liveRuntime.isVideoEnabled || liveRuntime.isScreenSharing),
  );

  return (
    <>
      {showOverlay && liveRuntime && (
        <div
          id={DOM_IDS.CALL_OVERLAY}
          className={className}
          role="region"
          aria-label={
            liveRuntime.isVideo
              ? t('call.videoCall', language)
              : t('call.audioCall', language)
          }
        >
          {/* Top Bar: Minimize, E2EE 4-Emoji Key Fingerprint, Call Type */}
          <div
            style={{
              width: '100%',
              maxWidth: '920px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              flexWrap: 'wrap',
            }}
          >
            <button
              type="button"
              data-testid="btn-call-minimize"
              className="tg-btn tg-btn--secondary"
              aria-label={t('call.minimize', language)}
              onClick={() => toggleCallMinimize(true)}
            >
              ↙ {t('call.minimize', language)}
            </button>

            {/* Non-button 4-Emoji E2EE Safety Fingerprint */}
            <div
              data-testid="call-key-fingerprint"
              aria-label={t('call.keyFingerprint', language)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '10px',
                padding: '6px 14px',
                borderRadius: '999px',
                background: 'rgba(23, 33, 43, 0.92)',
                border: '1px solid #242F3D',
              }}
            >
              <span style={{ fontSize: '12px', color: '#8BB8E8' }}>
                {t('call.keyFingerprint', language)}:
              </span>
              <span style={{ fontSize: '19px', letterSpacing: '4px' }}>
                {liveRuntime.emojiFingerprint.join(' ')}
              </span>
            </div>

            {liveRuntime.isScreenSharing && (
              <div
                data-testid="screen-share-badge"
                data-screen-share="true"
                data-sharing="true"
                style={{
                  padding: '6px 12px',
                  borderRadius: '999px',
                  background: 'rgba(0, 201, 114, 0.18)',
                  border: '1px solid #00C972',
                  color: '#00C972',
                  fontSize: '12.5px',
                  fontWeight: 600,
                }}
              >
                🖥️ {isZh ? '正在共享屏幕 (Sharing Screen)' : 'Sharing Screen'}
              </div>
            )}
          </div>

          {/* Center Stage: Peer Info / Video Stream / Group Participant Grid */}
          <div
            style={{
              flex: '1 1 auto',
              width: '100%',
              maxWidth: '920px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '18px',
              padding: '16px 0',
            }}
          >
            {/* Header Info & Live Timer */}
            <div style={{ textAlign: 'center' }}>
              <h2 style={{ margin: '0 0 4px', fontSize: '22px', fontWeight: 700, color: '#F5F5F5' }}>
                {peerDisplayName}
              </h2>
              <div
                data-testid="call-status-timer"
                style={{ fontSize: '14px', color: '#8BB8E8', fontWeight: 500 }}
              >
                {liveRuntime.status === 'ringing' || liveRuntime.status === 'dialing'
                  ? t('call.ringing', language)
                  : `${t('call.connected', language)} · ${formatDurationClock(elapsedSec)}`}
              </div>
              {liveRuntime.mediaError && (
                <div
                  role="alert"
                  style={{
                    marginTop: '8px',
                    padding: '6px 12px',
                    borderRadius: '8px',
                    background: 'rgba(229, 160, 48, 0.16)',
                    border: '1px solid rgba(229, 160, 48, 0.45)',
                    color: '#F5C469',
                    fontSize: '12px',
                  }}
                >
                  ⚠️ {liveRuntime.mediaError}
                </div>
              )}
            </div>

            {/* Group Call Participant Grid */}
            {isGroupCall && (
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ textAlign: 'center', fontSize: '12.5px', color: '#3FC1B0', fontWeight: 600 }}>
                  👥 {isZh ? `群组通话 · ${groupParticipants.length} 位参与者` : `Group Call · ${groupParticipants.length} Participants`}
                </div>
                <div
                  data-testid="group-call-grid"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: '12px',
                    width: '100%',
                  }}
                >
                  {groupParticipants.map((p) => (
                    <div
                      key={p.userId}
                      data-testid="call-participant-tile"
                      data-participant-id={p.userId}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        padding: '18px 12px',
                        borderRadius: '14px',
                        background: '#17212B',
                        border: p.isSelf ? '2px solid #00C972' : '1px solid #242F3D',
                      }}
                    >
                      <div
                        className="tg-avatar tg-avatar--lg"
                        data-color-index={peerAvatarColorIndex(p.userId)}
                      >
                        {p.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#F5F5F5' }}>
                        {p.name} {p.isSelf ? `(${t('chat.you', language)})` : ''}
                      </div>
                      <div style={{ fontSize: '11.5px', color: p.isSelf && liveRuntime.isMuted ? '#E15B64' : '#00C972' }}>
                        {p.isSelf && liveRuntime.isMuted
                          ? isZh
                            ? '🔇 已静音'
                            : '🔇 Muted'
                          : isZh
                            ? '🎙️ 正在讲话'
                            : '🎙️ Speaking'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Video / Screen Share Stream Viewport (STRICTLY ZERO synthetic <canvas>!) */}
            {showVideoViewport ? (
              <div
                data-testid="call-video-stage"
                style={{
                  position: 'relative',
                  width: 'min(640px, 92vw)',
                  height: 'min(360px, 48dvh)',
                  borderRadius: '16px',
                  overflow: 'hidden',
                  background: 'var(--tg-bg-surface)',
                  border: '1px solid var(--tg-hairline-border)',
                  boxShadow: 'var(--tg-shadow-md)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    display:
                      liveRuntime.remoteStream || liveRuntime.localStream
                        ? 'block'
                        : 'none',
                  }}
                />
                {!liveRuntime.remoteStream && !liveRuntime.localStream && (
                  <div
                    data-testid="call-video-unavailable"
                    style={{
                      padding: '20px',
                      textAlign: 'center',
                      color: 'var(--tg-text-secondary)',
                      fontSize: '13.5px',
                    }}
                  >
                    {liveRuntime.mediaError ||
                      (isZh
                        ? '摄像头或屏幕流不可用 · 等待真实媒体轨道'
                        : 'Camera / screen stream unavailable · awaiting media track')}
                  </div>
                )}
              </div>
            ) : (
              !isGroupCall && (
                <div
                  data-avatar="true"
                  className="tg-avatar tg-avatar--lg"
                  data-color-index={peerAvatarColorIndex(liveRuntime.peerUserId || 1)}
                  style={{
                    width: '108px',
                    height: '108px',
                    fontSize: '34px',
                  }}
                >
                  {peerDisplayName.slice(0, 2).toUpperCase()}
                </div>
              )
            )}
          </div>

          {/* Bottom Controls Bar: Mic Mute, Camera, Screen Share, Hang Up */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '14px',
              flexWrap: 'wrap',
              padding: '12px 20px',
              borderRadius: '999px',
              background: '#17212B',
              border: '1px solid #242F3D',
            }}
          >
            <button
              type="button"
              data-testid="btn-call-mute"
              aria-pressed={liveRuntime.isMuted}
              data-muted={String(liveRuntime.isMuted)}
              aria-label={
                liveRuntime.isMuted
                  ? t('call.unmute', language)
                  : t('call.mute', language)
              }
              className={`tg-btn ${liveRuntime.isMuted ? 'tg-btn--danger-soft' : 'tg-btn--secondary'}`}
              onClick={() => {
                toggleCallMute();
              }}
            >
              {liveRuntime.isMuted ? '🔇' : '🎙️'}{' '}
              {liveRuntime.isMuted
                ? isZh
                  ? '取消静音'
                  : 'Unmute'
                : isZh
                  ? '静音'
                  : 'Mute'}
            </button>

            <button
              type="button"
              data-testid="btn-call-video"
              aria-pressed={liveRuntime.isVideoEnabled}
              aria-label={t('call.camera', language)}
              className={`tg-btn ${liveRuntime.isVideoEnabled ? 'tg-btn--primary' : 'tg-btn--secondary'}`}
              onClick={() => {
                toggleCallVideo();
              }}
            >
              📹 {t('call.camera', language)}
            </button>

            <button
              type="button"
              data-testid="btn-call-screen"
              aria-pressed={liveRuntime.isScreenSharing}
              data-sharing={String(liveRuntime.isScreenSharing)}
              aria-label={
                liveRuntime.isScreenSharing
                  ? t('call.stopScreenShare', language)
                  : t('call.screenShare', language)
              }
              className={`tg-btn ${liveRuntime.isScreenSharing ? 'tg-btn--primary' : 'tg-btn--secondary'}`}
              onClick={async () => {
                try {
                  await toggleCallScreenShare();
                } catch {
                  pushToast(
                    isZh ? '屏幕共享已取消或受限' : 'Screen share unavailable',
                    'warning',
                  );
                }
              }}
            >
              🖥️{' '}
              {liveRuntime.isScreenSharing
                ? t('call.stopScreenShare', language)
                : t('call.screenShare', language)}
            </button>

            <button
              type="button"
              data-testid="btn-call-end"
              aria-label={t('call.endCall', language)}
              className="tg-btn tg-btn--danger"
              onClick={() => void handleHangUp()}
            >
              📞 {t('call.endCall', language)}
            </button>
          </div>
        </div>
      )}

      {/* Post-Call 1–5 Star Quality Rating Non-Blocking Floating Card */}
      {ratingModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'flex-end',
            padding: '20px',
            zIndex: 180,
          }}
        >
          <div
            id="call-rating-modal"
            data-testid="call-rating-dialog"
            role="dialog"
            aria-modal="false"
            aria-label={isZh ? '通话质量评价' : 'Rate Call Quality'}
            className="tg-modal-card"
            style={{
              width: 'min(360px, 92vw)',
              pointerEvents: 'auto',
            }}
          >
            <div className="tg-modal-header">
              <span>⭐ {isZh ? '评价本次通话质量' : 'Rate Call Quality'}</span>
              <button
                type="button"
                className="tg-icon-btn"
                aria-label={t('common.close', language)}
                onClick={() => void handleDismissRating()}
              >
                ×
              </button>
            </div>

            <div
              className="tg-modal-body"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '14px',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '13.5px', color: 'var(--tg-text-secondary)' }}>
                {ratingModal.peerName} · {formatDurationClock(ratingModal.durationSec)}
              </div>

              <div
                role="radiogroup"
                aria-label="Star Rating"
                style={{ display: 'flex', gap: '8px' }}
              >
                {[1, 2, 3, 4, 5].map((star) => {
                  const active = star <= selectedStars;
                  return (
                    <button
                      key={star}
                      type="button"
                      data-rating={star}
                      data-star={star}
                      aria-label={`${star} stars`}
                      aria-pressed={selectedStars === star}
                      onClick={() => setSelectedStars(star)}
                      style={{
                        fontSize: '30px',
                        lineHeight: 1,
                        padding: '4px 6px',
                        color: active ? '#E5A030' : '#7F91A4',
                        background: 'transparent',
                      }}
                    >
                      ★
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="tg-modal-footer">
              <button
                type="button"
                className="tg-btn tg-btn--secondary"
                disabled={isSubmittingRating}
                onClick={() => void handleDismissRating()}
              >
                {t('common.cancel', language)}
              </button>
              <button
                type="button"
                data-testid="btn-submit-call-rating"
                className="tg-btn tg-btn--primary"
                disabled={isSubmittingRating}
                onClick={() => void handleSubmitRating()}
              >
                {isZh ? '提交评价 (Submit)' : 'Submit Rating'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default CallOverlay;
