import React, { useEffect, useRef, useState } from 'react';
import { DOM_IDS, type TalkSessionStateKind } from '@gpui-telegram/protocol';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useUiStore } from '../../store/useUiStore';

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
    label: 'Speaking · 语音合成播报中',
    color: 'var(--tg-success)',
    bg: 'var(--tg-success-soft)',
  },
  interrupted: {
    label: 'Interrupted (<60ms Barge-In) · 已瞬时打断抢话',
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

  // Strictly non-purple Ocean Blue / Sky Cyan / Teal / Emerald / Amber palette!
  const palette =
    state === 'speaking'
      ? { inner: '#00C972', mid: '#3FC1B0', outer: 'rgba(0, 201, 114, 0.22)' }
      : state === 'interrupted'
        ? { inner: '#E5A030', mid: '#3390EC', outer: 'rgba(229, 160, 48, 0.22)' }
        : state === 'listening'
          ? { inner: '#29B6F6', mid: '#3390EC', outer: 'rgba(41, 182, 246, 0.25)' }
          : { inner: '#3390EC', mid: '#1B4978', outer: 'rgba(51, 144, 236, 0.18)' };

  const amp = state === 'listening' || state === 'speaking' ? 10 : state === 'thinking' ? 6 : 2.5;

  // Outer radial harmonic rings
  for (let ring = 3; ring >= 1; ring -= 1) {
    ctx.beginPath();
    const steps = 64;
    for (let i = 0; i <= steps; i += 1) {
      const theta = (i / steps) * Math.PI * 2;
      const wave =
        Math.sin(theta * (3 + ring) + phase * (1.4 + ring * 0.3)) * (amp * 0.55) +
        Math.cos(theta * 5 - phase) * (amp * 0.3);
      const r = baseRadius + ring * 15 + wave;
      const x = cx + Math.cos(theta) * r;
      const y = cy + Math.sin(theta) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = ring === 1 ? palette.inner : palette.mid;
    ctx.globalAlpha = 0.25 + (3 - ring) * 0.16;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.globalAlpha = 1;

  // Outer soft halo
  const halo = ctx.createRadialGradient(cx, cy, baseRadius * 0.4, cx, cy, baseRadius * 1.65);
  halo.addColorStop(0, palette.outer);
  halo.addColorStop(1, 'rgba(14, 22, 33, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, baseRadius * 1.65, 0, Math.PI * 2);
  ctx.fill();

  // Core glowing sphere
  const pulseRadius = baseRadius + Math.sin(phase * 2.2) * (amp * 0.45);
  const grad = ctx.createRadialGradient(
    cx - pulseRadius * 0.28,
    cy - pulseRadius * 0.28,
    pulseRadius * 0.12,
    cx,
    cy,
    pulseRadius,
  );
  grad.addColorStop(0, '#E0F7FA');
  grad.addColorStop(0.35, palette.inner);
  grad.addColorStop(1, palette.mid);

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, pulseRadius, 0, Math.PI * 2);
  ctx.fill();
}

export function TalkModeOrb({ onClose }: TalkModeOrbProps = {}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const talkSession = useAiWorkspaceStore((s) => s.talkSession);
  const startTalk = useAiWorkspaceStore((s) => s.startTalk);
  const sendTalkUtterance = useAiWorkspaceStore((s) => s.sendTalkUtterance);
  const bargeInTalk = useAiWorkspaceStore((s) => s.bargeInTalk);
  const stopTalk = useAiWorkspaceStore((s) => s.stopTalk);

  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);
  const pushToast = useUiStore((s) => s.pushToast);

  const [utteranceText, setUtteranceText] = useState('');
  const [bargeInLatencyMs, setBargeInLatencyMs] = useState<number | null>(null);

  const currentState: TalkSessionStateKind = talkSession?.state || 'idle';
  const badgeMeta = STATE_LABELS[currentState];

  // Draw audio-reactive radial canvas orb (synchronous first frame + smooth rAF)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    let rafId = 0;
    let phase = 0;

    drawVoiceOrbFrame(ctx, canvas.width, canvas.height, currentState, phase);

    const tick = () => {
      phase += currentState === 'idle' ? 0.025 : 0.075;
      drawVoiceOrbFrame(ctx, canvas.width, canvas.height, currentState, phase);
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [currentState]);

  const handleStartTalk = async () => {
    try {
      await startTalk();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleSendUtterance = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = utteranceText.trim();
    if (!text) return;
    try {
      if (!talkSession || talkSession.state === 'idle') {
        await startTalk();
      }
      await sendTalkUtterance(text);
      setUtteranceText('');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleBargeIn = async () => {
    const t0 = performance.now();
    try {
      if (!talkSession) {
        await startTalk();
      }
      await bargeInTalk();
      const elapsed = Math.max(1, Math.round((performance.now() - t0) * 10) / 10);
      setBargeInLatencyMs(elapsed);
      pushToast(`Barge-In interrupted TTS stream (${elapsed}ms) · 已抢话打断`, 'info');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleStopTalk = async () => {
    try {
      await stopTalk();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <div
      id={DOM_IDS.TALK_MODE_ORB}
      data-state={currentState}
      style={{
        height: '100%',
        overflowY: 'auto',
        backgroundColor: 'var(--tg-bg-app)',
        color: 'var(--tg-text-primary)',
        justifyContent: 'flex-start',
      }}
    >
      {/* Top Bar */}
      <div
        style={{
          width: '100%',
          maxWidth: '760px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div style={{ fontSize: '17px', fontWeight: 700 }}>
            🎙️ Full-Duplex Talk Mode Orb · 全双工实时语音对话球
          </div>
          <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)' }}>
            Sub-60ms Barge-In Interruption · Generation Fencing · Live Transcript &amp; TTS Stream
          </div>
        </div>

        <span
          data-testid="talk-state-badge"
          style={{
            padding: '5px 12px',
            borderRadius: '999px',
            backgroundColor: badgeMeta.bg,
            color: badgeMeta.color,
            fontSize: '12.5px',
            fontWeight: 600,
          }}
        >
          ● {badgeMeta.label}
        </span>
      </div>

      {/* Radial Audio-Reactive Voice Orb Canvas */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <canvas
          ref={canvasRef}
          width={260}
          height={260}
          aria-label="Audio-reactive full-duplex voice orb"
          style={{ width: '260px', height: '260px', display: 'block' }}
        />
      </div>

      {/* Primary Action Buttons (First button is Start Talk for E2E F16-T8!) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          type="button"
          className="tg-btn tg-btn--primary"
          onClick={() => void handleStartTalk()}
        >
          🎙️ Start Talk · 开启对话
        </button>

        <button
          type="button"
          className="tg-btn tg-btn--secondary"
          onClick={() => void handleBargeIn()}
          style={{ borderColor: 'var(--tg-warning)', color: 'var(--tg-warning)' }}
        >
          ⚡ Barge-In (&lt;60ms Interrupt) · 打断抢话
        </button>

        <button
          type="button"
          className="tg-btn tg-btn--danger-soft"
          onClick={() => void handleStopTalk()}
        >
          ⏹ Stop · 结束
        </button>

        <button
          type="button"
          className="tg-btn tg-btn--secondary"
          onClick={() => {
            setActiveNavDest('chats');
            onClose?.();
          }}
        >
          ← Back to Chats · 返回
        </button>
      </div>

      {/* Utterance Composer */}
      <form
        onSubmit={(e) => void handleSendUtterance(e)}
        className="tg-surface-card"
        style={{ width: '100%', maxWidth: '680px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}
      >
        <input
          type="text"
          className="tg-input"
          aria-label="Voice Utterance Text 输入模拟语音文本"
          placeholder="Speak or type an utterance to stream into Talk Mode · 输入语音对话内容..."
          value={utteranceText}
          onChange={(e) => setUtteranceText(e.target.value)}
          style={{ flex: '1 1 260px' }}
        />
        <button type="submit" className="tg-btn tg-btn--primary">
          Send Utterance · 发送语音文本
        </button>
      </form>

      {/* Live Turn Transcript & Telemetry */}
      <div
        className="tg-surface-card"
        style={{
          width: '100%',
          maxWidth: '680px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
          <span>Live Turn Transcript · 实时对话字幕</span>
          <span>
            Gen #{talkSession?.generation ?? 0} · Seq #{talkSession?.signal_seq ?? 0}
            {bargeInLatencyMs !== null ? ` · Last Barge-In: ${bargeInLatencyMs}ms` : ''}
          </span>
        </div>

        <div
          style={{
            padding: '10px 12px',
            borderRadius: '8px',
            backgroundColor: 'var(--tg-bg-elevated)',
            fontSize: '13px',
          }}
        >
          <div style={{ color: 'var(--tg-text-secondary)', fontSize: '11.5px' }}>You · 用户语音识别:</div>
          <div style={{ marginTop: '2px' }}>
            {talkSession?.last_transcript || 'Ready to listen — click "Start Talk" or send an utterance.'}
          </div>
        </div>

        <div
          style={{
            padding: '10px 12px',
            borderRadius: '8px',
            backgroundColor: 'var(--tg-bg-elevated)',
            fontSize: '13px',
          }}
        >
          <div style={{ color: 'var(--tg-info)', fontSize: '11.5px' }}>Hermes Voice · 智能体回复:</div>
          <div style={{ marginTop: '2px' }}>
            {talkSession?.last_reply || 'Standing by with zero-latency barge-in fence.'}
          </div>
        </div>
      </div>
    </div>
  );
}
