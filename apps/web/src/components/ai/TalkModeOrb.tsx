import React, { useEffect, useRef, useState } from 'react';
import { DOM_IDS, type TalkSessionStateKind } from '@gpui-telegram/protocol';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useUiStore } from '../../store/useUiStore';
import { MagpieGatewayPanel } from './MagpieGatewayPanel';

export interface TalkModeOrbProps {
  onClose?: () => void;
}

const STATE_LABELS: Record<TalkSessionStateKind, { label: string; color: string; bg: string }> = {
  idle: {
    label: 'Idle · 待机就绪',
    color: 'var(--tg-text-secondary)',
    bg: 'var(--tg-bg-elevated)',
  },
  listening: {
    label: 'Listening · 全双工倾听中',
    color: 'var(--tg-info)',
    bg: 'var(--tg-info-soft)',
  },
  thinking: {
    label: 'Thinking · 实时推理中',
    color: 'var(--tg-accent)',
    bg: 'var(--tg-accent-soft)',
  },
  speaking: {
    label: 'Speaking · 语音播报中',
    color: 'var(--tg-success)',
    bg: 'var(--tg-success-soft)',
  },
  interrupted: {
    label: 'Interrupted · 已打断抢话',
    color: 'var(--tg-warning)',
    bg: 'var(--tg-warning-soft)',
  },
};

function drawVoiceOrbFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  state: TalkSessionStateKind,
  phase: number,
): void {
  ctx.clearRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height / 2;
  const baseRadius = Math.min(width, height) * 0.28;

  // Strictly zero-purple Apple / Muse dark palette
  const colorMap: Record<TalkSessionStateKind, string> = {
    idle: '#64748B',
    listening: '#29B6F6',
    thinking: '#0A84FF',
    speaking: '#00BA69',
    interrupted: '#E5A030',
  };
  const strokeHex = colorMap[state] ?? '#0A84FF';

  for (let ring = 0; ring < 3; ring++) {
    const pulse =
      state === 'idle'
        ? 0
        : Math.sin(phase * (1.8 + ring * 0.45) + ring * 1.1) * (state === 'speaking' ? 14 : 8);
    const radius = baseRadius + ring * 16 + pulse;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(12, radius), 0, Math.PI * 2);
    ctx.strokeStyle = strokeHex;
    ctx.globalAlpha = 0.24 - ring * 0.06;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  const grad = ctx.createRadialGradient(
    cx - baseRadius * 0.25,
    cy - baseRadius * 0.25,
    6,
    cx,
    cy,
    baseRadius,
  );
  grad.addColorStop(0, '#FFFFFF');
  grad.addColorStop(0.28, strokeHex);
  grad.addColorStop(1, '#0E0E0E');

  ctx.beginPath();
  ctx.arc(cx, cy, baseRadius, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
}

export function TalkModeOrb({ onClose }: TalkModeOrbProps = {}): React.JSX.Element {
  const talkSession = useAiWorkspaceStore((s) => s.talkSession);
  const talkProviderError = useAiWorkspaceStore((s) => s.talkProviderError);
  const startTalk = useAiWorkspaceStore((s) => s.startTalk);
  const sendTalkAudioBlob = useAiWorkspaceStore((s) => s.sendTalkAudioBlob);
  const bargeInTalk = useAiWorkspaceStore((s) => s.bargeInTalk);
  const stopTalk = useAiWorkspaceStore((s) => s.stopTalk);

  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);
  const pushToast = useUiStore((s) => s.pushToast);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const [isRecordingMic, setIsRecordingMic] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [lastBargeInMs, setLastBargeInMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [magpieOpen, setMagpieOpen] = useState(false);

  const currentState: TalkSessionStateKind = talkSession?.state ?? 'idle';
  const stateBadge = STATE_LABELS[currentState] ?? STATE_LABELS.idle;

  useEffect(() => {
    let rafId = 0;
    let phase = 0;
    const render = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          drawVoiceOrbFrame(ctx, canvas.width, canvas.height, currentState, phase);
        }
      }
      phase += 0.04;
      rafId = window.requestAnimationFrame(render);
    };
    rafId = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(rafId);
  }, [currentState]);

  useEffect(() => {
    return () => {
      try {
        mediaRecorderRef.current?.stop();
      } catch {
        // Ignore stop cleanup error
      }
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const stopMicCapture = () => {
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    } catch {
      // Ignore stop error
    }
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    setIsRecordingMic(false);
  };

  const handleStartTalk = async () => {
    setBusy(true);
    setMicError(null);
    try {
      await startTalk();
      pushToast('Talk Mode session started · 已开启语音会话', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMicError(msg);
      pushToast(msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleMicCapture = async () => {
    setMicError(null);
    if (isRecordingMic) {
      stopMicCapture();
      return;
    }

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function' ||
      typeof MediaRecorder === 'undefined'
    ) {
      const msg =
        'Microphone / MediaRecorder API is unavailable in this browser context. · 当前浏览器环境不支持麦克风录音。';
      setMicError(msg);
      pushToast(msg, 'error');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          chunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = () => {
        const mimeType = recorder.mimeType || 'audio/webm';
        const audioBlob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        stream.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        setIsRecordingMic(false);
        if (audioBlob.size > 0) {
          void sendTalkAudioBlob(audioBlob).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            setMicError(msg);
          });
        }
      };

      recorder.start();
      setIsRecordingMic(true);
    } catch (err) {
      const msg =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone permission denied by user or browser policy. · 麦克风权限被拒绝。'
          : err instanceof Error
            ? err.message
            : 'Unable to access microphone';
      setMicError(msg);
      pushToast(msg, 'error');
    }
  };

  const handleBargeIn = async () => {
    setBusy(true);
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      await bargeInTalk();
      const elapsed = Number(
        ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(2),
      );
      setLastBargeInMs(elapsed);
      pushToast(`Barge-In acknowledged in ${elapsed}ms`, 'info');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleStopTalk = async () => {
    stopMicCapture();
    setBusy(true);
    try {
      await stopTalk();
      pushToast('Talk Mode stopped · 已结束语音会话', 'info');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleBack = () => {
    stopMicCapture();
    if (onClose) onClose();
    else setActiveNavDest('chats');
  };

  return (
    <section id={DOM_IDS.TALK_MODE_ORB} className="tg-ai-workspace">
      <header className="tg-ai-workspace__header">
        <div className="tg-ai-workspace__title-group">
          <h2 className="tg-ai-workspace__title">🎙️ Full-Duplex Talk Mode · 全双工语音对话</h2>
          <span className="tg-ai-workspace__subtitle">
            Real WebAudio MediaRecorder capture & server speech pipeline (zero simulated text fallback)
          </span>
        </div>
        <div className="tg-ai-workspace__actions">
          <span
            className="tg-ai-badge"
            style={{ color: stateBadge.color, background: stateBadge.bg }}
          >
            {stateBadge.label}
          </span>
          <button type="button" className="tg-btn tg-btn--ghost" onClick={handleBack}>
            ← Back to Chats · 返回
          </button>
        </div>
      </header>

      <div className="tg-ai-workspace__body">
        <div className="tg-ai-card tg-talk-stage">
          <canvas
            ref={canvasRef}
            width={240}
            height={240}
            aria-label="Talk Mode voice activity orb"
          />

          <div className="tg-ai-row">
            <button
              type="button"
              className="tg-btn tg-btn--primary"
              disabled={busy}
              onClick={() => void handleStartTalk()}
            >
              ▶ Start Talk · 开启对话
            </button>
            <button
              type="button"
              className={`tg-btn ${isRecordingMic ? 'tg-btn--danger' : 'tg-btn--secondary'}`}
              disabled={busy}
              onClick={() => void handleToggleMicCapture()}
            >
              {isRecordingMic ? '⏹ Stop & Send Audio · 停止并发送录音' : '🎤 Record Microphone · 麦克风录音'}
            </button>
            <button
              type="button"
              className="tg-btn tg-btn--secondary"
              disabled={busy}
              onClick={() => void handleBargeIn()}
            >
              ⚡ Barge-In · 打断抢话
            </button>
            <button
              type="button"
              className="tg-btn tg-btn--ghost"
              disabled={busy}
              onClick={() => void handleStopTalk()}
            >
              ■ Stop · 结束
            </button>
          </div>

          {lastBargeInMs !== null && (
            <span className="tg-ai-badge tg-ai-badge--info">
              Last Barge-In Round-Trip: {lastBargeInMs}ms
            </span>
          )}
        </div>

        {/* Truthful Microphone / API Error Banner */}
        {micError && (
          <div role="alert" className="tg-secret-leak-alert">
            {micError}
          </div>
        )}

        {/* Structured 503 PROVIDER_ERROR Card */}
        {talkProviderError && (
          <div
            role="alert"
            data-testid="provider-error-card"
            data-error-code="PROVIDER_ERROR"
            className="tg-provider-error-card provider-error-card"
          >
            <div className="tg-provider-error-title">
              ⚠️ PROVIDER_ERROR ({talkProviderError.error}) · 语音/模型管线未配置
            </div>
            <div className="tg-provider-error-body">{talkProviderError.message}</div>
            <div>
              <button
                type="button"
                className="tg-btn tg-btn--primary"
                onClick={() => setMagpieOpen(true)}
              >
                Configure AI Provider · 配置模型供应商
              </button>
            </div>
          </div>
        )}

        {/* Live Turn Transcript */}
        <section className="tg-ai-card">
          <div className="tg-ai-card__header">
            <h3 className="tg-ai-card__title">📝 Live Turn Transcript · 实时转写与回复</h3>
            {talkSession && (
              <span className="tg-ai-badge">
                Seq #{talkSession.signal_seq} · Chunks: {talkSession.buffered_chunks}
              </span>
            )}
          </div>
          {talkSession?.last_transcript || talkSession?.last_reply ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {talkSession.last_transcript && (
                <div className="tg-ai-card tg-ai-card--elevated">
                  <span className="tg-ai-workspace__subtitle">Recognized Speech · 识别文本</span>
                  <div>{talkSession.last_transcript}</div>
                </div>
              )}
              {talkSession.last_reply && (
                <div className="tg-ai-card tg-ai-card--elevated">
                  <span className="tg-ai-workspace__subtitle">AI Reply · 智能回复</span>
                  <div>{talkSession.last_reply}</div>
                </div>
              )}
            </div>
          ) : (
            <div className="tg-ai-empty">
              No voice turns recorded yet. Press Start Talk and record with your real microphone. · 暂无语音回合记录。
            </div>
          )}
        </section>
      </div>

      {magpieOpen && <MagpieGatewayPanel asModal onClose={() => setMagpieOpen(false)} />}
    </section>
  );
}
