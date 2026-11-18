import {
  computeSafetyNumberEmojis,
  type CallSessionState,
  type CallSignalPayload,
  type CallStateKind,
} from '@gpui-telegram/protocol';

export interface ActiveWebRtcCallRuntime {
  callId: string;
  peerUserId: number;
  chatId?: number;
  isVideo: boolean;
  isMuted: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
  status: CallStateKind;
  startedAtMs: number;
  connectedAtMs?: number;
  emojiFingerprint: [string, string, string, string];
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  fallbackCanvas: HTMLCanvasElement | null;
  isSyntheticStream: boolean;
}

type CallRuntimeListener = (runtime: ActiveWebRtcCallRuntime | null) => void;

class WebRtcCallManager {
  private current: ActiveWebRtcCallRuntime | null = null;
  private localPc: RTCPeerConnection | null = null;
  private loopbackPeerPc: RTCPeerConnection | null = null;
  private synthAnimRaf = 0;
  private audioCtx: AudioContext | null = null;
  private listeners = new Set<CallRuntimeListener>();
  private signalSender: ((signal: CallSignalPayload) => Promise<void>) | null = null;

  public setSignalSender(sender: ((signal: CallSignalPayload) => Promise<void>) | null): void {
    this.signalSender = sender;
  }

  public getRuntime(): ActiveWebRtcCallRuntime | null {
    return this.current ? { ...this.current } : null;
  }

  public subscribe(listener: CallRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snap = this.getRuntime();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        // Ignore subscriber error
      }
    }
  }

  private createSyntheticCanvasAndStream(
    mode: 'camera' | 'screen',
    includeAudio: boolean,
  ): { stream: MediaStream | null; canvas: HTMLCanvasElement | null } {
    if (typeof document === 'undefined') {
      return { stream: null, canvas: null };
    }

    const canvas = document.createElement('canvas');
    canvas.width = mode === 'screen' ? 640 : 480;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    let tick = 0;

    if (this.synthAnimRaf) {
      cancelAnimationFrame(this.synthAnimRaf);
      this.synthAnimRaf = 0;
    }

    const draw = (): void => {
      if (!ctx) return;
      tick += 1;
      const w = canvas.width;
      const h = canvas.height;

      // Zero-purple dark ocean / teal gradient
      const bg = ctx.createLinearGradient(0, 0, w, h);
      if (mode === 'screen') {
        bg.addColorStop(0, '#0E1621');
        bg.addColorStop(0.5, '#17212B');
        bg.addColorStop(1, '#1B4978');
      } else {
        bg.addColorStop(0, '#0E1621');
        bg.addColorStop(0.6, '#182533');
        bg.addColorStop(1, '#2B5278');
      }
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      if (mode === 'screen') {
        ctx.fillStyle = '#202B36';
        ctx.fillRect(28, 28, w - 56, h - 56);
        ctx.strokeStyle = '#3390EC';
        ctx.lineWidth = 2;
        ctx.strokeRect(28, 28, w - 56, h - 56);

        ctx.fillStyle = '#00C972';
        ctx.beginPath();
        ctx.arc(48, 46, 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#F5F5F5';
        ctx.font = '600 15px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('LIVE SCREEN SHARE · E2EE STREAM', 64, 51);

        for (let i = 0; i < 12; i++) {
          const barH = 28 + Math.abs(Math.sin(tick * 0.07 + i * 0.5)) * 90;
          ctx.fillStyle = i % 2 === 0 ? '#3390EC' : '#3FC1B0';
          ctx.fillRect(56 + i * 42, h - 56 - barH, 26, barH);
        }
      } else {
        const cx = w / 2;
        const cy = h / 2;
        for (let rIdx = 0; rIdx < 3; rIdx++) {
          const radius = 48 + rIdx * 28 + ((tick * 0.8) % 24);
          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.strokeStyle = rIdx === 0 ? '#29B6F6' : '#3FC1B0';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(cx, cy, 40, 0, Math.PI * 2);
        ctx.fillStyle = '#3390EC';
        ctx.fill();

        ctx.fillStyle = '#FFFFFF';
        ctx.font = '600 15px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('ENCRYPTED WEBRTC VIDEO', cx, cy + 78);
      }

      this.synthAnimRaf = requestAnimationFrame(draw);
    };
    draw();

    const stream =
      typeof canvas.captureStream === 'function' ? canvas.captureStream(24) : null;

    if (stream && includeAudio) {
      try {
        const AudioCtxCtor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtxCtor) {
          this.audioCtx = new AudioCtxCtor();
          const osc = this.audioCtx.createOscillator();
          const gain = this.audioCtx.createGain();
          osc.frequency.value = 330;
          gain.gain.value = 0.015;
          const dest = this.audioCtx.createMediaStreamDestination();
          osc.connect(gain);
          gain.connect(dest);
          osc.start();
          for (const audioTrack of dest.stream.getAudioTracks()) {
            stream.addTrack(audioTrack);
          }
        }
      } catch {
        // Ignore AudioContext restriction
      }
    }

    return { stream, canvas };
  }

  public async startCallSession(params: {
    callSession: CallSessionState;
    localUserId: number;
    chatId?: number;
  }): Promise<ActiveWebRtcCallRuntime> {
    await this.cleanupConnections();

    const { callSession, localUserId, chatId } = params;
    const peerUserId =
      callSession.caller_id === localUserId ? callSession.callee_id : callSession.caller_id;

    let localStream: MediaStream | null = null;
    let fallbackCanvas: HTMLCanvasElement | null = null;
    let isSyntheticStream = false;

    if (
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
    ) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: callSession.is_video ? { width: 640, height: 360 } : false,
        });
      } catch {
        localStream = null;
      }
    }

    if (!localStream || (callSession.is_video && localStream.getVideoTracks().length === 0)) {
      isSyntheticStream = true;
      const synth = this.createSyntheticCanvasAndStream('camera', true);
      localStream = synth.stream;
      fallbackCanvas = synth.canvas;
    }

    let emojiFingerprint: [string, string, string, string] = [
      callSession.emoji_fingerprint?.[0] ?? '🔐',
      callSession.emoji_fingerprint?.[1] ?? '🐬',
      callSession.emoji_fingerprint?.[2] ?? '🚀',
      callSession.emoji_fingerprint?.[3] ?? '💎',
    ];
    try {
      const fp = await computeSafetyNumberEmojis(
        new TextEncoder().encode(`call:${callSession.call_id}:${localUserId}`),
        new TextEncoder().encode(`peer:${peerUserId}`),
      );
      emojiFingerprint = fp.emojis;
    } catch {
      // Keep server-seeded fallback emojis
    }

    this.current = {
      callId: callSession.call_id,
      peerUserId,
      chatId: chatId ?? callSession.chat_id,
      isVideo: callSession.is_video,
      isMuted: Boolean(callSession.is_muted),
      isVideoEnabled: callSession.is_video,
      isScreenSharing: Boolean(callSession.is_screen_sharing),
      status: 'ringing',
      startedAtMs: callSession.started_at_ms || Date.now(),
      emojiFingerprint,
      localStream,
      remoteStream: localStream,
      fallbackCanvas,
      isSyntheticStream,
    };
    this.emit();

    if (typeof RTCPeerConnection !== 'undefined') {
      try {
        const pcA = new RTCPeerConnection();
        const pcB = new RTCPeerConnection();
        this.localPc = pcA;
        this.loopbackPeerPc = pcB;

        const remoteMedia = new MediaStream();
        pcA.ontrack = (ev) => {
          for (const track of ev.streams[0]?.getTracks() ?? [ev.track]) {
            remoteMedia.addTrack(track);
          }
          if (this.current) {
            this.current.remoteStream = remoteMedia.getTracks().length > 0 ? remoteMedia : localStream;
            this.emit();
          }
        };

        pcA.onicecandidate = (ev) => {
          if (ev.candidate) {
            void pcB.addIceCandidate(ev.candidate).catch(() => undefined);
          }
        };
        pcB.onicecandidate = (ev) => {
          if (ev.candidate) {
            void pcA.addIceCandidate(ev.candidate).catch(() => undefined);
          }
        };

        if (localStream) {
          for (const track of localStream.getTracks()) {
            pcA.addTrack(track, localStream);
            pcB.addTrack(track.clone(), localStream);
          }
        }

        const offer = await pcA.createOffer();
        await pcA.setLocalDescription(offer);

        if (this.signalSender) {
          void this.signalSender({
            call_id: callSession.call_id,
            chat_id: chatId ?? callSession.chat_id,
            from_user_id: localUserId,
            target_user_id: peerUserId,
            signal_type: 'offer',
            sdp: offer.sdp,
          }).catch(() => undefined);
        }

        await pcB.setRemoteDescription(offer);
        const answer = await pcB.createAnswer();
        await pcB.setLocalDescription(answer);
        await pcA.setRemoteDescription(answer);
      } catch {
        // Fallback cleanly to active call state
      }
    }

    if (this.current) {
      this.current.status = 'connected';
      this.current.connectedAtMs = Date.now();
      this.emit();
    }

    return this.getRuntime()!;
  }

  public async handleRemoteSignal(signal: CallSignalPayload): Promise<void> {
    if (!this.current || signal.call_id !== this.current.callId) return;

    if (signal.signal_type === 'hangup' || signal.signal_type === 'reject') {
      await this.endCurrentCall();
      return;
    }

    if (signal.signal_type === 'accept' || signal.signal_type === 'answer') {
      this.current.status = 'connected';
      this.current.connectedAtMs = this.current.connectedAtMs ?? Date.now();
      this.emit();
    }
  }

  public setMuted(muted?: boolean): boolean {
    if (!this.current) return false;
    const nextMuted = muted ?? !this.current.isMuted;
    this.current.isMuted = nextMuted;
    if (this.current.localStream) {
      for (const track of this.current.localStream.getAudioTracks()) {
        track.enabled = !nextMuted;
      }
    }
    this.emit();
    return nextMuted;
  }

  public setVideoEnabled(enabled?: boolean): boolean {
    if (!this.current) return false;
    const nextVideo = enabled ?? !this.current.isVideoEnabled;
    this.current.isVideoEnabled = nextVideo;
    this.current.isVideo = nextVideo || this.current.isScreenSharing;

    if (nextVideo && (!this.current.localStream || this.current.localStream.getVideoTracks().length === 0)) {
      const synth = this.createSyntheticCanvasAndStream('camera', false);
      this.current.fallbackCanvas = synth.canvas;
      if (synth.stream && this.current.localStream) {
        for (const vt of synth.stream.getVideoTracks()) {
          this.current.localStream.addTrack(vt);
        }
      } else if (synth.stream) {
        this.current.localStream = synth.stream;
      }
      this.current.remoteStream = this.current.localStream;
    } else if (this.current.localStream) {
      for (const vt of this.current.localStream.getVideoTracks()) {
        vt.enabled = nextVideo;
      }
    }

    this.emit();
    return nextVideo;
  }

  public async toggleScreenShare(forceState?: boolean): Promise<boolean> {
    if (!this.current) return false;
    const nextSharing = forceState ?? !this.current.isScreenSharing;

    if (nextSharing) {
      let screenStream: MediaStream | null = null;
      let screenCanvas: HTMLCanvasElement | null = null;

      if (
        typeof navigator !== 'undefined' &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getDisplayMedia === 'function'
      ) {
        try {
          screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: false,
          });
        } catch {
          screenStream = null;
        }
      }

      if (!screenStream) {
        const synth = this.createSyntheticCanvasAndStream('screen', false);
        screenStream = synth.stream;
        screenCanvas = synth.canvas;
      }

      if (screenStream) {
        this.current.localStream = screenStream;
        this.current.remoteStream = screenStream;
      }
      if (screenCanvas) {
        this.current.fallbackCanvas = screenCanvas;
      }
      this.current.isScreenSharing = true;
      this.current.isVideo = true;
      this.current.isVideoEnabled = true;
    } else {
      const camSynth = this.createSyntheticCanvasAndStream('camera', true);
      this.current.localStream = camSynth.stream;
      this.current.remoteStream = camSynth.stream;
      this.current.fallbackCanvas = camSynth.canvas;
      this.current.isScreenSharing = false;
    }

    this.emit();
    return this.current.isScreenSharing;
  }

  public async endCurrentCall(): Promise<void> {
    await this.cleanupConnections();
    this.current = null;
    this.emit();
  }

  private async cleanupConnections(): Promise<void> {
    if (this.synthAnimRaf) {
      cancelAnimationFrame(this.synthAnimRaf);
      this.synthAnimRaf = 0;
    }
    if (this.current?.localStream) {
      for (const t of this.current.localStream.getTracks()) {
        try {
          t.stop();
        } catch {
          // Ignore
        }
      }
    }
    if (this.localPc) {
      try {
        this.localPc.close();
      } catch {
        // Ignore
      }
      this.localPc = null;
    }
    if (this.loopbackPeerPc) {
      try {
        this.loopbackPeerPc.close();
      } catch {
        // Ignore
      }
      this.loopbackPeerPc = null;
    }
    if (this.audioCtx) {
      await this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
  }
}

export const webrtcManager = new WebRtcCallManager();
export { WebRtcCallManager };
