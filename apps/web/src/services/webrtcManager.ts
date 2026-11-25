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
  mediaError?: string | null;
}

type CallRuntimeListener = (runtime: ActiveWebRtcCallRuntime | null) => void;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302'] },
];

class WebRtcCallManager {
  private current: ActiveWebRtcCallRuntime | null = null;
  private localPc: RTCPeerConnection | null = null;
  private localUserId = 0;
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

  public async startCallSession(params: {
    callSession: CallSessionState;
    localUserId: number;
    chatId?: number;
    iceServers?: RTCIceServer[];
  }): Promise<ActiveWebRtcCallRuntime> {
    await this.cleanupConnections();

    const { callSession, localUserId, chatId, iceServers } = params;
    this.localUserId = localUserId;
    const peerUserId =
      callSession.caller_id === localUserId ? callSession.callee_id : callSession.caller_id;

    let localStream: MediaStream | null = null;
    let mediaError: string | null = null;

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
      } catch (err) {
        localStream = null;
        const msg = err instanceof Error ? err.message : String(err || 'NotAllowedError');
        mediaError = `Camera/microphone permission denied: ${msg} · 权限被拒绝，无法访问麦克风或摄像头`;
      }
    } else {
      mediaError =
        'Camera/microphone permission denied: WebRTC MediaDevices unavailable (requires HTTPS or localhost) · 权限受限';
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
      // Keep server-provided safety emojis
    }

    this.current = {
      callId: callSession.call_id,
      peerUserId,
      chatId: chatId ?? callSession.chat_id,
      isVideo: callSession.is_video,
      isMuted: Boolean(callSession.is_muted),
      isVideoEnabled: callSession.is_video && Boolean(localStream?.getVideoTracks().length),
      isScreenSharing: Boolean(callSession.is_screen_sharing),
      status: 'ringing',
      startedAtMs: callSession.started_at_ms || Date.now(),
      emojiFingerprint,
      localStream,
      remoteStream: null,
      mediaError,
    };
    this.emit();

    if (typeof RTCPeerConnection !== 'undefined' && !mediaError) {
      try {
        const resolvedIceServers =
          iceServers && iceServers.length > 0 ? iceServers : DEFAULT_ICE_SERVERS;
        const pc = new RTCPeerConnection({ iceServers: resolvedIceServers });
        this.localPc = pc;

        const remoteMedia = new MediaStream();
        pc.ontrack = (ev) => {
          for (const track of ev.streams[0]?.getTracks() ?? [ev.track]) {
            remoteMedia.addTrack(track);
          }
          if (this.current) {
            this.current.remoteStream =
              remoteMedia.getTracks().length > 0 ? remoteMedia : this.current.remoteStream;
            this.current.status = 'connected';
            this.current.connectedAtMs = this.current.connectedAtMs ?? Date.now();
            this.emit();
          }
        };

        if (localStream) {
          for (const track of localStream.getTracks()) {
            pc.addTrack(track, localStream);
          }
        }

        pc.onicecandidate = (ev) => {
          if (ev.candidate && this.signalSender && this.current) {
            void this.signalSender({
              call_id: this.current.callId,
              chat_id: this.current.chatId,
              from_user_id: this.localUserId,
              target_user_id: this.current.peerUserId,
              signal_type: 'ice_candidate',
              candidate: JSON.stringify(ev.candidate.toJSON()),
            }).catch(() => undefined);
          }
        };

        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: callSession.is_video,
        });
        await pc.setLocalDescription(offer);
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
      } catch (err) {
        if (this.current) {
          this.current.mediaError =
            err instanceof Error
              ? `WebRTC connection error: ${err.message} · WebRTC 连接初始化失败`
              : 'WebRTC connection error · WebRTC 连接初始化失败';
          this.emit();
        }
      }
    }

    return this.getRuntime()!;
  }

  public async handleRemoteSignal(signal: CallSignalPayload): Promise<void> {
    if (!this.current || signal.call_id !== this.current.callId) return;

    if (signal.signal_type === 'hangup' || signal.signal_type === 'reject') {
      await this.endCurrentCall();
      return;
    }

    if (this.localPc) {
      try {
        if (signal.signal_type === 'answer' && signal.sdp) {
          await this.localPc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        } else if (signal.signal_type === 'offer' && signal.sdp) {
          await this.localPc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
          const answer = await this.localPc.createAnswer();
          await this.localPc.setLocalDescription(answer);
          if (this.signalSender) {
            void this.signalSender({
              call_id: this.current.callId,
              chat_id: this.current.chatId,
              from_user_id: this.localUserId,
              target_user_id: signal.from_user_id,
              signal_type: 'answer',
              sdp: answer.sdp,
            }).catch(() => undefined);
          }
        } else if (signal.signal_type === 'ice_candidate' && signal.candidate) {
          const parsed = JSON.parse(signal.candidate) as RTCIceCandidateInit;
          await this.localPc.addIceCandidate(parsed);
        }
      } catch {
        // Ignore stale or out-of-order signaling frames
      }
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

    if (
      nextVideo &&
      (!this.current.localStream || this.current.localStream.getVideoTracks().length === 0)
    ) {
      if (
        typeof navigator !== 'undefined' &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function'
      ) {
        void navigator.mediaDevices
          .getUserMedia({ video: { width: 640, height: 360 } })
          .then((camStream) => {
            if (!this.current) return;
            const vt = camStream.getVideoTracks()[0];
            if (vt) {
              if (!this.current.localStream) {
                this.current.localStream = new MediaStream();
              }
              this.current.localStream.addTrack(vt);
              this.localPc?.addTrack(vt, this.current.localStream);
              this.current.mediaError = null;
              this.emit();
            }
          })
          .catch((err) => {
            if (!this.current) return;
            this.current.isVideoEnabled = false;
            const msg = err instanceof Error ? err.message : String(err || 'NotAllowedError');
            this.current.mediaError = `Camera permission denied: ${msg} · 无法开启摄像头`;
            this.emit();
          });
      } else {
        this.current.isVideoEnabled = false;
        this.current.mediaError =
          'Camera permission denied: MediaDevices unavailable · 无法开启摄像头';
      }
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
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getDisplayMedia !== 'function'
      ) {
        this.current.mediaError =
          'Screen share unsupported: getDisplayMedia unavailable · 当前浏览器不支持屏幕共享';
        this.emit();
        return false;
      }

      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        });
        this.current.localStream = screenStream;
        this.current.mediaError = null;
        this.current.isScreenSharing = true;
        this.current.isVideo = true;
        this.current.isVideoEnabled = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err || 'NotAllowedError');
        this.current.mediaError = `Screen share denied or cancelled: ${msg} · 屏幕共享已取消或受限`;
        this.emit();
        return false;
      }
    } else {
      if (this.current.localStream) {
        for (const t of this.current.localStream.getVideoTracks()) {
          t.stop();
        }
      }
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
  }
}

export const webrtcManager = new WebRtcCallManager();
export { WebRtcCallManager };
