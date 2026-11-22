import {
  createTextContent,
  detectPtsGap,
  enrichMessageItem,
  mapChatDtoToDomain,
  mapChatFolderDtoToDomain,
  mapForumTopicDtoToDomain,
  mapStoryDtoToDomain,
  mapUserDtoToDomain,
  type AdapterMode,
  type AuthResponse,
  type BotRegistryEntry,
  type BrowserAuditLogEntry,
  type BrowserCommandRequest,
  type BrowserCommandResult,
  type BrowserControlClientPort,
  type BrowserControlRevokeResponse,
  type BrowserRegisterPayload,
  type BrowserSnapshotDto,
  type BrowserStateReportPayload,
  type BrowserTargetDescriptor,
  type CallSessionState,
  type CallSignalPayload,
  type ChannelStatisticsDto,
  type ChatDetailDto,
  type ChatFolder,
  type ChatFolderDto,
  type ChatMemberDto,
  type ChatSummary,
  type ComputerNodeDto,
  type ComputerRunPolicy,
  type ConnectionState,
  type DesktopPairingTicketDto,
  type DraftState,
  type ForumTopic,
  type ForumTopicDto,
  type GifResultDto,
  type GlobalSearchResponse,
  type HeadlessBrowserSessionDto,
  type HermesCommandDescriptor,
  type HermesCronJobDto,
  type HermesKanbanBoardDto,
  type HermesMemoryState,
  type HermesSessionSummary,
  type HermesSkillDto,
  type HermesStreamEvent,
  type HermesStudioSnapshot,
  type HermesStudioTab,
  type InviteLinkDto,
  type InvoiceCard,
  type MagpieConfigSnapshot,
  type MagpieMaskingConfig,
  type MagpieMaskingPreviewResult,
  type MagpiePreset,
  type MagpieProviderView,
  type MagpieRoutingGroup,
  type MagpieUsageLedgerSummary,
  type McpJsonRpcRequest,
  type McpJsonRpcResponse,
  type McpPendingApprovalDto,
  type McpServerDto,
  type McpToolDto,
  type MediaDescriptor,
  type MessageEntity,
  type MessageItem,
  type MiniAppEntry,
  type MiniAppLaunchContext,
  type PendingComputerCommandDto,
  type PollData,
  type PublishPreKeysRequest,
  type PublishPreKeysResponse,
  type PtsUpdate,
  type QrPairSessionDto,
  type ReactionCount,
  type ReactionDetail,
  type SearchHitDto,
  type SearchTabCategory,
  type SendMessagePortInput,
  type SessionDto,
  type StickerSetDto,
  type StoryDto,
  type StoryGroup,
  type StoryItem,
  type SyncGetDifferenceRequest,
  type SyncGetDifferenceResponse,
  type TailnetStatusDto,
  type TalkSessionDto,
  type TaskItemDto,
  type TelegramClientPort,
  type TwoFactorStatusDto,
  type TypingAction,
  type UnsubscribeFn,
  type UpdateEvent,
  type UserPreKeyBundlesResponse,
  type UserPrivacySettingsDto,
  type UserProfile,
  type UserProfileDto,
  type WalletStateDto,
  type WsClientFrame,
  type WsServerFrame,
} from '@gpui-telegram/protocol';
import { browserControlAgent } from '../services/browserControlAgent';
import { broadcastSync } from './broadcastSync';
import { indexedDbCache } from './indexedDbCache';

const CHUNK_PART_BYTES = 524_288; // 512 KiB chunks matching server CAS upload engine

async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  let h1 = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i]!;
    h1 = Math.imul(h1, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(64, '0');
}

function generateNumericClientNonce(): number {
  return Math.floor(Date.now() * 100 + Math.random() * 99);
}

export class TwoFactorChallengeError extends Error {
  public readonly challengeToken: string;
  public readonly hint?: string;

  constructor(challengeToken: string, hint?: string) {
    super('Two-factor authentication required');
    this.name = 'TwoFactorChallengeError';
    this.challengeToken = challengeToken;
    this.hint = hint;
  }
}

export class HttpWsServerAdapter implements TelegramClientPort, BrowserControlClientPort {
  public readonly mode: AdapterMode = 'server';

  private baseUrl = '';
  private token: string | null = null;
  private accountId = 'default';
  private currentUserId = 1;
  private connectionState: ConnectionState = 'disconnected';
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private manualDisconnect = false;
  private flushingOutbox = false;
  private chatPtsMap = new Map<number, number>();
  private discoveredPeers = new Map<number, UserProfile>();

  private connListeners = new Set<(state: ConnectionState) => void>();
  private updateListeners = new Set<(event: UpdateEvent, ptsUpdate?: PtsUpdate) => void>();

  constructor(initialBaseUrl = '') {
    this.baseUrl = this.normalizeBaseUrl(initialBaseUrl);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        if (this.token && !this.manualDisconnect) {
          void this.connect(this.token);
          void this.flushOutbox();
        }
      });
      window.addEventListener('offline', () => {
        if (this.connectionState === 'connected') {
          this.setConnectionState('reconnecting');
        }
      });
    }
  }

  private normalizeBaseUrl(url: string): string {
    const trimmed = url.trim().replace(/\/+$/, '');
    return trimmed;
  }

  public configure(opts: {
    serverUrl?: string;
    token?: string | null;
    accountId?: string;
    userId?: number | string;
  }): void {
    if (opts.serverUrl !== undefined) {
      this.baseUrl = this.normalizeBaseUrl(opts.serverUrl);
    }
    if (opts.token !== undefined) {
      this.token = opts.token;
    }
    if (opts.accountId !== undefined) {
      this.accountId = opts.accountId;
    }
    if (opts.userId !== undefined) {
      const n = Number(opts.userId);
      if (Number.isFinite(n) && n > 0) {
        this.currentUserId = n;
      }
    }
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public getToken(): string | null {
    return this.token;
  }

  public async probeServerHealth(overrideUrl?: string): Promise<{
    ok: boolean;
    version?: string;
    server?: string;
    mode?: string;
    latencyMs: number;
    error?: string;
  }> {
    const base =
      overrideUrl !== undefined ? this.normalizeBaseUrl(overrideUrl) : this.baseUrl;
    const candidates = ['/api/v1/status', '/api/v1/health', '/health'];
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let lastError = '无法连接到服务器';

    for (const ep of candidates) {
      try {
        const url = base ? `${base}${ep}` : ep;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3_000);
        const res = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          lastError = `HTTP ${res.status}`;
          continue;
        }
        const ct = res.headers.get('content-type') || '';
        const latencyMs = Math.max(
          1,
          Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0),
        );
        if (ct.includes('application/json')) {
          const data = (await res.json()) as Record<string, unknown>;
          return {
            ok: data.ok !== false,
            version: typeof data.version === 'string' ? data.version : undefined,
            server:
              typeof data.server === 'string'
                ? data.server
                : typeof data.service === 'string'
                  ? data.service
                  : undefined,
            mode: typeof data.mode === 'string' ? data.mode : undefined,
            latencyMs,
          };
        }
        return { ok: true, latencyMs };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    const latencyMs = Math.max(
      1,
      Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0),
    );
    return { ok: false, latencyMs, error: lastError };
  }

  public getDiscoveredPeers(): UserProfile[] {
    return Array.from(this.discoveredPeers.values());
  }

  private recordUsers(dtos?: Array<UserProfileDto | UserProfile>): UserProfile[] {
    if (!dtos) return [];
    const out: UserProfile[] = [];
    for (const raw of dtos) {
      const mapped =
        'firstName' in raw && typeof raw.userId === 'number'
          ? (raw as UserProfile)
          : mapUserDtoToDomain(raw as UserProfileDto);
      this.discoveredPeers.set(mapped.userId, mapped);
      out.push(mapped);
    }
    return out;
  }

  private resolveHttpUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    if (this.baseUrl) {
      return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    }
    return path.startsWith('/') ? path : `/${path}`;
  }

  private resolveWsUrl(token: string): string {
    const encoded = encodeURIComponent(token);
    if (this.baseUrl) {
      const wsBase = this.baseUrl.replace(/^http/i, 'ws');
      return `${wsBase}/api/v1/ws?token=${encoded}`;
    }
    if (typeof window !== 'undefined') {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}/api/v1/ws?token=${encoded}`;
    }
    return `ws://127.0.0.1:8080/api/v1/ws?token=${encoded}`;
  }

  private setConnectionState(next: ConnectionState): void {
    if (this.connectionState === next) return;
    this.connectionState = next;
    for (const fn of this.connListeners) {
      try {
        fn(next);
      } catch {
        // Ignore
      }
    }
  }

  private emitUpdate(event: UpdateEvent, ptsUpdate?: PtsUpdate): void {
    for (const fn of this.updateListeners) {
      try {
        fn(event, ptsUpdate);
      } catch {
        // Ignore
      }
    }
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...extraHeaders,
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    let payloadBody: BodyInit | undefined;
    if (body instanceof Uint8Array) {
      const copy = new Uint8Array(body.byteLength);
      copy.set(body);
      payloadBody = copy.buffer;
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/octet-stream';
    } else if (body instanceof Blob) {
      payloadBody = body;
      headers['Content-Type'] = headers['Content-Type'] ?? (body.type || 'application/octet-stream');
    } else if (body !== undefined) {
      payloadBody = JSON.stringify(body);
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    }

    const res = await fetch(this.resolveHttpUrl(path), {
      method,
      headers,
      body: payloadBody,
    });

    if (res.status === 204) {
      return {} as T;
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(text || `HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return text as unknown as T;
    }

    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      if (data?.requires_2fa) {
        throw new TwoFactorChallengeError(
          typeof data.challenge_token === 'string' ? data.challenge_token : '',
          typeof data.hint === 'string' ? data.hint : undefined,
        );
      }
      const errMsg =
        (typeof data?.message === 'string' && data.message) ||
        (typeof data?.error === 'string' && data.error) ||
        `HTTP ${res.status}`;
      const err = new Error(errMsg) as Error & { status?: number; code?: string };
      err.status = res.status;
      if (typeof data?.error === 'string') err.code = data.error;
      throw err;
    }

    return data as T;
  }

  private sendWsFrame(frame: WsClientFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(frame));
      } catch {
        // Ignore transient WS send error
      }
    }
  }

  // ==========================================================================
  // Lifecycle & Real-Time WebSocket + PTS Sync + Offline Outbox Flush
  // ==========================================================================

  public async connect(token?: string): Promise<void> {
    if (token !== undefined) {
      this.token = token;
    }
    if (!this.token) {
      this.setConnectionState('disconnected');
      return;
    }

    this.manualDisconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.setConnectionState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    browserControlAgent.setWsReplySender((result) => {
      this.sendWsFrame({ type: 'BrowserCommandResult', payload: result });
    });

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      try {
        const socket = new WebSocket(this.resolveWsUrl(this.token!));
        this.ws = socket;

        const openTimeout = setTimeout(() => {
          finish();
        }, 3_500);

        socket.onopen = () => {
          clearTimeout(openTimeout);
          const wasReconnect = this.reconnectAttempts > 0;
          this.reconnectAttempts = 0;
          this.setConnectionState('connected');

          if (this.pingTimer) clearInterval(this.pingTimer);
          this.pingTimer = setInterval(() => {
            const now = Date.now();
            this.sendWsFrame({ type: 'Ping', payload: { nonce: now, client_ts: now } });
          }, 25_000);

          // Register live browser tab for F17 Desktop-to-Browser control bridge
          this.sendWsFrame({
            type: 'BrowserRegister',
            payload: browserControlAgent.buildRegisterPayload(),
          });

          void this.flushOutbox();
          if (wasReconnect) {
            void this.reconcilePtsAfterReconnect();
          }
          finish();
        };

        socket.onmessage = (ev: MessageEvent) => {
          if (typeof ev.data !== 'string') return;
          try {
            const frame = JSON.parse(ev.data) as WsServerFrame;
            void this.handleServerWsFrame(frame);
          } catch {
            // Ignore malformed frame
          }
        };

        socket.onerror = () => {
          clearTimeout(openTimeout);
          finish();
        };

        socket.onclose = () => {
          clearTimeout(openTimeout);
          if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
          }
          this.ws = null;
          if (!this.manualDisconnect && this.token) {
            this.scheduleReconnect();
          } else {
            this.setConnectionState('disconnected');
          }
          finish();
        };
      } catch {
        this.scheduleReconnect();
        finish();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.manualDisconnect || !this.token) return;
    this.setConnectionState('reconnecting');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delayMs = Math.min(8_000, 350 * Math.pow(1.8, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(this.token ?? undefined);
    }, delayMs);
  }

  private async reconcilePtsAfterReconnect(): Promise<void> {
    if (this.chatPtsMap.size === 0) return;
    this.setConnectionState('updating');
    try {
      for (const [chatId, localPts] of this.chatPtsMap.entries()) {
        const diff = await this.getDifference({ chat_id: chatId, from_pts: localPts });
        this.chatPtsMap.set(chatId, diff.current_pts);
        for (const msg of diff.new_messages ?? []) {
          this.emitUpdate({ type: 'NewMessage', data: enrichMessageItem(msg) });
        }
        for (const upd of diff.other_updates ?? []) {
          this.emitUpdate(upd);
        }
        for (const ptsItem of diff.updates ?? []) {
          this.emitUpdate(ptsItem.event, ptsItem);
        }
      }
    } catch {
      // Ignore transient sync error
    } finally {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.setConnectionState('connected');
      }
    }
  }

  private async handleServerWsFrame(frame: WsServerFrame): Promise<void> {
    switch (frame.type) {
      case 'AuthOk': {
        this.currentUserId = frame.payload.user_id;
        break;
      }
      case 'BrowserRegistered': {
        browserControlAgent.setTargetId(frame.payload.target_id);
        browserControlAgent.setControlGeneration(frame.payload.control_generation);
        break;
      }
      case 'BrowserCommand': {
        await browserControlAgent.handleIncomingWsCommand(frame.payload);
        break;
      }
      case 'BrowserControlRevoked': {
        browserControlAgent.setControlGeneration(frame.payload.control_generation);
        break;
      }
      case 'Ack':
      case 'SendAck': {
        await indexedDbCache.removeOutbox(this.accountId, frame.payload.client_nonce);
        break;
      }
      case 'PtsUpdate':
      case 'PtsPush': {
        const ptsUpd = frame.payload;
        const chatId = ptsUpd.chat_id;
        const localPts = this.chatPtsMap.get(chatId);
        if (localPts !== undefined) {
          const gap = detectPtsGap(ptsUpd, localPts);
          if (gap) {
            this.setConnectionState('updating');
            try {
              const diff = await this.getDifference({ chat_id: chatId, from_pts: localPts });
              this.chatPtsMap.set(chatId, diff.current_pts);
              for (const m of diff.new_messages ?? []) {
                this.emitUpdate({ type: 'NewMessage', data: enrichMessageItem(m) }, ptsUpd);
              }
              for (const upd of diff.other_updates ?? []) {
                this.emitUpdate(upd, ptsUpd);
              }
            } catch {
              // Ignore
            } finally {
              this.setConnectionState('connected');
            }
            return;
          }
        }
        this.chatPtsMap.set(chatId, ptsUpd.pts);
        void indexedDbCache.setPtsCursor(this.accountId, ptsUpd.pts, String(chatId));
        this.emitUpdate(ptsUpd.event, ptsUpd);
        break;
      }
      case 'Update': {
        this.emitUpdate(frame.payload);
        break;
      }
      default:
        break;
    }
  }

  public async flushOutbox(): Promise<void> {
    if (this.flushingOutbox || !this.token) return;

    this.flushingOutbox = true;
    try {
      const pending = await indexedDbCache.listOutbox(this.accountId);
      for (const item of pending) {
        try {
          const res = await this.sendMessageOverHttp({
            ...item.req,
            clientNonce: item.clientNonce,
          });
          await indexedDbCache.removeOutbox(this.accountId, item.clientNonce);
          const enriched = enrichMessageItem({
            ...res.message,
            client_nonce: item.clientNonce,
            delivery_status: 'sent',
          });
          this.emitUpdate({ type: 'NewMessage', data: enriched });
          broadcastSync.publish({
            kind: 'message_upsert',
            accountId: this.accountId,
            chatId: item.chatId,
            message: enriched,
            pts: res.pts,
          });
        } catch {
          // Stop flushing on network error; retry on next online/reconnect
          break;
        }
      }
    } finally {
      this.flushingOutbox = false;
    }
  }

  public async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'Client disconnect');
      } catch {
        // Ignore
      }
      this.ws = null;
    }
    this.setConnectionState('disconnected');
  }

  public getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  public onConnectionStateChange(listener: (state: ConnectionState) => void): UnsubscribeFn {
    this.connListeners.add(listener);
    return () => {
      this.connListeners.delete(listener);
    };
  }

  public onUpdate(
    listener: (event: UpdateEvent, ptsUpdate?: PtsUpdate) => void,
  ): UnsubscribeFn {
    this.updateListeners.add(listener);
    return () => {
      this.updateListeners.delete(listener);
    };
  }

  public async getDifference(req: SyncGetDifferenceRequest): Promise<SyncGetDifferenceResponse> {
    return this.requestJson<SyncGetDifferenceResponse>('POST', '/api/v1/sync/get_difference', {
      chat_id: req.chat_id,
      from_pts: req.from_pts ?? req.pts ?? 0,
      pts: req.pts ?? req.from_pts ?? 0,
      limit: req.limit ?? 100,
    });
  }

  // ==========================================================================
  // F1: Authentication, 2FA, QR, Passkeys & Sessions
  // ==========================================================================

  private applyAuthSuccess(res: AuthResponse): AuthResponse {
    if (res.token) {
      this.token = res.token;
    }
    if (res.user_id) {
      this.currentUserId = res.user_id;
      this.accountId = String(res.user_id);
    }
    if (res.user) {
      this.recordUsers([res.user]);
    }
    return res;
  }

  public async loginDemo(slot = 0): Promise<AuthResponse> {
    const res = await this.requestJson<AuthResponse>('POST', '/api/v1/auth/demo', { slot });
    return this.applyAuthSuccess(res);
  }

  public async sendPhoneCode(
    phone: string,
  ): Promise<{ phone_code_hash: string; timeout_secs: number; dev_code?: string }> {
    return this.requestJson('POST', '/api/v1/auth/phone/send-code', { phone });
  }

  public async verifyPhoneCode(req: {
    phone: string;
    phone_code_hash?: string;
    code: string;
    password?: string;
    first_name?: string;
    last_name?: string;
  }): Promise<AuthResponse | { requires_2fa: true; challenge_token: string; hint?: string }> {
    const res = await this.requestJson<
      AuthResponse | { requires_2fa: true; challenge_token: string; hint?: string }
    >('POST', '/api/v1/auth/phone/verify', req);
    if ('token' in res && res.token) {
      return this.applyAuthSuccess(res);
    }
    return res;
  }

  public async verify2fa(req: {
    challenge_token: string;
    password: string;
  }): Promise<AuthResponse> {
    const res = await this.requestJson<AuthResponse>('POST', '/api/v1/auth/2fa/verify', {
      challenge_token: req.challenge_token,
      password: req.password,
      cloud_password: req.password,
    });
    return this.applyAuthSuccess(res);
  }

  public async get2faStatus(): Promise<TwoFactorStatusDto> {
    return this.requestJson<TwoFactorStatusDto>('GET', '/api/v1/auth/2fa/status');
  }

  public async set2faPassword(req: {
    current_password?: string;
    new_password: string;
    hint?: string;
    recovery_email?: string;
  }): Promise<TwoFactorStatusDto> {
    return this.requestJson<TwoFactorStatusDto>('POST', '/api/v1/auth/2fa/set', req);
  }

  public async disable2faPassword(currentPassword?: string): Promise<{ ok: boolean }> {
    return this.requestJson<{ ok: boolean }>('POST', '/api/v1/auth/2fa/disable', {
      current_password: currentPassword,
    });
  }

  public async initQrPairing(deviceName = 'Telegram Web'): Promise<QrPairSessionDto> {
    const res = await this.requestJson<QrPairSessionDto & { pair_token?: string }>(
      'POST',
      '/api/v1/auth/pair/init',
      { device_name: deviceName },
    );
    return {
      ...res,
      pair_id: res.pair_id ?? res.pair_token ?? '',
      pair_token: res.pair_token ?? res.pair_id,
    };
  }

  public async pollQrPairing(pairId: string): Promise<QrPairSessionDto> {
    const res = await this.requestJson<
      QrPairSessionDto & {
        user_id?: number;
        username?: string;
        session_id?: string;
      }
    >('GET', `/api/v1/auth/pair/poll/${encodeURIComponent(pairId)}`);
    if (res.session?.token) {
      this.applyAuthSuccess(res.session);
    } else if (res.token && (res.user || res.user_id)) {
      const auth: AuthResponse = {
        user_id: Number(res.user?.user_id ?? res.user_id ?? 0),
        username: res.user?.username ?? res.username ?? '',
        session_id: res.session_id ?? `qr_${pairId}`,
        token: res.token,
        user: res.user,
      };
      this.applyAuthSuccess(auth);
      return { ...res, session: auth };
    }
    return res;
  }

  public async acceptQrPairing(pairId: string): Promise<QrPairSessionDto> {
    return this.requestJson<QrPairSessionDto>('POST', '/api/v1/auth/pair/accept', {
      pair_id: pairId,
      pair_token: pairId,
    });
  }

  public async loginPassword(
    username: string,
    password: string,
    twoFaPassword?: string,
  ): Promise<AuthResponse> {
    const res = await this.requestJson<AuthResponse>('POST', '/api/v1/auth/login', {
      username,
      password,
      two_fa_password: twoFaPassword,
    });
    return this.applyAuthSuccess(res);
  }

  public async registerPassword(req: {
    username: string;
    password: string;
    first_name: string;
    last_name?: string;
  }): Promise<AuthResponse> {
    const res = await this.requestJson<AuthResponse>('POST', '/api/v1/auth/register', req);
    return this.applyAuthSuccess(res);
  }

  public async sendEmailCode(
    email: string,
  ): Promise<{ email_code_hash: string; dev_code?: string }> {
    return this.requestJson('POST', '/api/v1/auth/email/send-code', { email });
  }

  public async verifyEmailCode(req: {
    email: string;
    code: string;
    email_code_hash?: string;
  }): Promise<AuthResponse> {
    const res = await this.requestJson<AuthResponse>('POST', '/api/v1/auth/email/verify', req);
    return this.applyAuthSuccess(res);
  }

  public async emailRegister(req: {
    email: string;
    code: string;
    username: string;
    password: string;
    first_name?: string;
    last_name?: string;
    email_code_hash?: string;
  }): Promise<AuthResponse> {
    const res = await this.requestJson<AuthResponse>('POST', '/api/v1/auth/email/register', req);
    return this.applyAuthSuccess(res);
  }

  public async startAlipayAuth(): Promise<{
    session_id: string;
    qr_url: string;
    svg: string;
    expires_at_ms: number;
  }> {
    const res = await this.requestJson<{
      session_id?: string;
      attempt_id?: string;
      qr_url?: string;
      auth_url?: string;
      qr_payload?: string;
      svg?: string;
      expires_at_ms?: number;
    }>('POST', '/api/v1/auth/alipay/start', {});
    return {
      session_id: res.session_id ?? res.attempt_id ?? '',
      qr_url: res.qr_url ?? res.qr_payload ?? res.auth_url ?? '',
      svg: res.svg ?? '',
      expires_at_ms: res.expires_at_ms ?? Date.now() + 180_000,
    };
  }

  public async pollAlipayAuth(
    sessionId: string,
  ): Promise<{ status: string; auth?: AuthResponse }> {
    const res = await this.requestJson<{
      status: string;
      auth?: AuthResponse;
      session?: AuthResponse;
      token?: string;
      user_id?: number;
      username?: string;
      first_name?: string;
      session_id?: string;
      user?: UserProfileDto;
    }>('GET', `/api/v1/auth/alipay/poll/${encodeURIComponent(sessionId)}`);
    let authPayload = res.auth ?? res.session;
    if (!authPayload && res.token && (res.user_id || res.user)) {
      authPayload = {
        user_id: Number(res.user?.user_id ?? res.user_id ?? 0),
        username: res.user?.username ?? res.username ?? '',
        first_name: res.user?.first_name ?? res.first_name,
        session_id: res.session_id ?? `alipay_${sessionId}`,
        token: res.token,
        user: res.user,
      };
    }
    if (authPayload?.token) {
      this.applyAuthSuccess(authPayload);
    }
    return { status: res.status, auth: authPayload };
  }

  public async confirmAlipayAuth(sessionId: string): Promise<AuthResponse> {
    const res = await this.requestJson<AuthResponse & { auth?: AuthResponse }>(
      'POST',
      '/api/v1/auth/alipay/confirm',
      { session_id: sessionId },
    );
    const unwrapped = res.auth ?? res;
    return this.applyAuthSuccess(unwrapped);
  }

  public async getPasskeyChallenge(
    username?: string,
  ): Promise<{ challenge_id: string; challenge: string; rp_id: string }> {
    return this.requestJson('POST', '/api/v1/auth/passkey/challenge', { username });
  }

  public async registerPasskey(req: {
    cred_id?: string;
    label: string;
    public_key_b64?: string;
  }): Promise<{ cred_id: string; label: string }> {
    return this.requestJson('POST', '/api/v1/auth/passkey/register', req);
  }

  public async verifyPasskey(req: {
    challenge_id: string;
    credential_id: string;
  }): Promise<AuthResponse> {
    const res = await this.requestJson<AuthResponse>('POST', '/api/v1/auth/passkey/verify', req);
    return this.applyAuthSuccess(res);
  }

  public async listSessions(): Promise<SessionDto[]> {
    const res = await this.requestJson<{ sessions?: SessionDto[] } | SessionDto[]>(
      'GET',
      '/api/v1/auth/sessions',
    );
    return Array.isArray(res) ? res : (res.sessions ?? []);
  }

  public async revokeSession(sessionId: string): Promise<void> {
    await this.requestJson('DELETE', `/api/v1/auth/sessions/${encodeURIComponent(sessionId)}`);
  }

  public async revokeOtherSessions(): Promise<number> {
    const res = await this.requestJson<{ revoked_count?: number; count?: number }>(
      'DELETE',
      '/api/v1/auth/sessions/others',
    );
    return Number(res.revoked_count ?? res.count ?? 0);
  }

  public async logout(): Promise<void> {
    try {
      await this.requestJson('POST', '/api/v1/auth/logout', {});
    } catch {
      // Ignore if token already expired
    }
    await this.disconnect();
    this.token = null;
  }

  // ==========================================================================
  // F4, F5 & F14: Chats, Folders, Topics, Contacts, Admin, Stories, Search, Stats
  // ==========================================================================

  public async listChats(opts?: {
    archived?: boolean;
    folderId?: string | number;
  }): Promise<{ chats: ChatSummary[]; users: UserProfile[] }> {
    const qs = new URLSearchParams();
    if (opts?.archived !== undefined) qs.set('archived', String(opts.archived));
    if (opts?.folderId !== undefined) qs.set('folder_id', String(opts.folderId));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';

    const res = await this.requestJson<{
      chats?: ChatDetailDto[];
      users?: UserProfileDto[];
    } | ChatDetailDto[]>('GET', `/api/v1/chats${suffix}`);

    const rawChats = Array.isArray(res) ? res : (res.chats ?? []);
    const rawUsers = Array.isArray(res) ? undefined : res.users;
    const chats = rawChats.map((dto) => {
      const domain = mapChatDtoToDomain(dto);
      this.chatPtsMap.set(domain.chatId, domain.pts);
      return domain;
    });
    const users = this.recordUsers(rawUsers);
    void indexedDbCache.saveChats(this.accountId, chats);
    return { chats, users };
  }

  public async getChat(chatId: number): Promise<ChatSummary> {
    const res = await this.requestJson<ChatDetailDto & { chat?: ChatDetailDto }>(
      'GET',
      `/api/v1/chats/${chatId}`,
    );
    const dto = res.chat ?? res;
    const mapped = mapChatDtoToDomain(dto);
    this.chatPtsMap.set(mapped.chatId, mapped.pts);
    return mapped;
  }

  public async openSavedMessages(): Promise<ChatSummary> {
    const dto = await this.requestJson<ChatDetailDto>('POST', '/api/v1/chats/saved', {}).catch(
      () =>
        this.requestJson<ChatDetailDto>('POST', '/api/v1/chats', {
          chat_type: 5,
          title: 'Saved Messages',
        }),
    );
    return mapChatDtoToDomain(dto);
  }

  public async createChat(req: {
    title: string;
    chatType: number;
    about?: string;
    username?: string;
    isForum?: boolean;
    peerUserId?: number;
    memberIds?: number[];
  }): Promise<ChatSummary> {
    const res = await this.requestJson<ChatDetailDto & { chat?: ChatDetailDto }>(
      'POST',
      '/api/v1/chats',
      {
        title: req.title,
        chat_type: req.chatType,
        about: req.about,
        username: req.username,
        is_forum: req.isForum,
        peer_user_id: req.peerUserId,
        member_ids: req.memberIds,
      },
    );
    return mapChatDtoToDomain(res.chat ?? res);
  }

  public async updateChat(
    chatId: number,
    patch: Partial<{
      title: string;
      about: string;
      username: string;
      slowModeSeconds: number;
      isForum: boolean;
    }>,
  ): Promise<ChatSummary> {
    const res = await this.requestJson<ChatDetailDto & { chat?: ChatDetailDto }>(
      'PUT',
      `/api/v1/chats/${chatId}`,
      {
        title: patch.title,
        about: patch.about,
        username: patch.username,
        slow_mode_seconds: patch.slowModeSeconds,
        is_forum: patch.isForum,
      },
    );
    return mapChatDtoToDomain(res.chat ?? res);
  }

  public async deleteOrLeaveChat(chatId: number): Promise<void> {
    await this.requestJson('DELETE', `/api/v1/chats/${chatId}`);
  }

  public async clearChatHistory(chatId: number, forEveryone = false): Promise<void> {
    await this.requestJson('POST', `/api/v1/chats/${chatId}/history/clear`, {
      for_everyone: forEveryone,
    }).catch(() =>
      this.requestJson('POST', `/api/v1/chats/${chatId}/clear`, {
        for_everyone: forEveryone,
      }),
    );
  }

  public async updateChatSettings(
    chatId: number,
    patch: Partial<{
      isPinned: boolean;
      isArchived: boolean;
      isMuted: boolean;
      unreadMark: boolean;
      folderId: number | null;
    }>,
  ): Promise<ChatSummary> {
    const res = await this.requestJson<ChatDetailDto & { chat?: ChatDetailDto }>(
      'PATCH',
      `/api/v1/chats/${chatId}/settings`,
      {
        is_pinned: patch.isPinned,
        is_archived: patch.isArchived,
        is_muted: patch.isMuted,
        unread_mark: patch.unreadMark,
        folder_id: patch.folderId,
      },
    );
    return mapChatDtoToDomain(res.chat ?? res);
  }

  public async setChatTtl(chatId: number, ttlSeconds: number): Promise<void> {
    await this.requestJson('POST', `/api/v1/chats/${chatId}/ttl`, {
      ttl_seconds: ttlSeconds,
    });
  }

  public async saveDraft(chatId: number, draft: DraftState | null): Promise<void> {
    await indexedDbCache.saveDraft(this.accountId, chatId, draft);
    if (!draft || (!draft.text.trim() && !draft.replyToMsgId)) {
      await this.requestJson('DELETE', `/api/v1/chats/${chatId}/draft`);
      return;
    }
    await this.requestJson('PUT', `/api/v1/chats/${chatId}/draft`, {
      text: draft.text,
      entities: draft.entities,
      reply_to_msg_id: draft.replyToMsgId,
      quote_text: draft.quoteText,
      topic_id: draft.topicId,
    });
  }

  public async listFolders(): Promise<ChatFolder[]> {
    const res = await this.requestJson<{ folders?: ChatFolderDto[] } | ChatFolderDto[]>(
      'GET',
      '/api/v1/folders',
    );
    const list = Array.isArray(res) ? res : (res.folders ?? []);
    return list.map(mapChatFolderDtoToDomain);
  }

  public async upsertFolder(folder: Partial<ChatFolder> & { title: string }): Promise<ChatFolder> {
    const res = await this.requestJson<ChatFolderDto & { folder?: ChatFolderDto }>(
      folder.id ? 'PUT' : 'POST',
      folder.id ? `/api/v1/folders/${folder.id}` : '/api/v1/folders',
      {
        id: folder.id,
        title: folder.title,
        emoticon: folder.emoticon,
        include_chats: folder.includedChatIds ?? [],
        exclude_chats: folder.excludedChatIds ?? [],
        pinned_chats: folder.pinnedChatIds ?? [],
        include_contacts: folder.includeContacts ?? false,
        include_non_contacts: folder.includeNonContacts ?? false,
        include_groups: folder.includeGroups ?? true,
        include_channels: folder.includeChannels ?? true,
        include_bots: folder.includeBots ?? false,
        exclude_muted: folder.excludeMuted ?? false,
        exclude_read: folder.excludeRead ?? false,
        exclude_archived: folder.excludeArchived ?? true,
        sort_order: folder.sortOrder ?? 0,
      },
    );
    return mapChatFolderDtoToDomain(res.folder ?? res);
  }

  public async deleteFolder(folderId: number | string): Promise<void> {
    await this.requestJson('DELETE', `/api/v1/folders/${encodeURIComponent(String(folderId))}`);
  }

  public async listForumTopics(chatId: number): Promise<ForumTopic[]> {
    const res = await this.requestJson<{ topics?: ForumTopicDto[] } | ForumTopicDto[]>(
      'GET',
      `/api/v1/chats/${chatId}/topics`,
    );
    const list = Array.isArray(res) ? res : (res.topics ?? []);
    return list.map(mapForumTopicDtoToDomain);
  }

  public async createForumTopic(
    chatId: number,
    req: { title: string; iconColor?: number; iconEmoji?: string },
  ): Promise<ForumTopic> {
    const res = await this.requestJson<ForumTopicDto & { topic?: ForumTopicDto }>(
      'POST',
      `/api/v1/chats/${chatId}/topics`,
      {
        title: req.title,
        icon_color: req.iconColor,
        icon_emoji: req.iconEmoji,
      },
    );
    return mapForumTopicDtoToDomain(res.topic ?? res);
  }

  public async updateForumTopic(
    chatId: number,
    topicId: number,
    patch: Partial<{ title: string; isClosed: boolean; isPinned: boolean }>,
  ): Promise<ForumTopic> {
    const res = await this.requestJson<ForumTopicDto & { topic?: ForumTopicDto }>(
      'PATCH',
      `/api/v1/chats/${chatId}/topics/${topicId}`,
      {
        title: patch.title,
        is_closed: patch.isClosed,
        is_pinned: patch.isPinned,
      },
    );
    return mapForumTopicDtoToDomain(res.topic ?? res);
  }

  public async deleteForumTopic(chatId: number, topicId: number): Promise<void> {
    await this.requestJson('DELETE', `/api/v1/chats/${chatId}/topics/${topicId}`);
  }

  public async listContacts(): Promise<UserProfile[]> {
    const res = await this.requestJson<{ contacts?: UserProfileDto[]; users?: UserProfileDto[] }>(
      'GET',
      '/api/v1/contacts',
    );
    return this.recordUsers(res.contacts ?? res.users ?? []);
  }

  public async addContact(req: {
    userId?: number;
    username?: string;
    phone?: string;
    firstName?: string;
    lastName?: string;
  }): Promise<UserProfile> {
    const res = await this.requestJson<{ contact?: UserProfileDto; user?: UserProfileDto } & UserProfileDto>(
      'POST',
      '/api/v1/contacts',
      {
        user_id: req.userId,
        username: req.username,
        phone: req.phone,
        first_name: req.firstName,
        last_name: req.lastName,
      },
    );
    const dto = res.contact ?? res.user ?? res;
    return this.recordUsers([dto])[0]!;
  }

  public async deleteContact(userId: number): Promise<void> {
    await this.requestJson('DELETE', `/api/v1/contacts/${userId}`);
  }

  public async resolveUsername(
    username: string,
  ): Promise<{ peerType: string; user?: UserProfile; chat?: ChatSummary }> {
    const res = await this.requestJson<{
      peer_type?: string;
      peerType?: string;
      user?: UserProfileDto;
      chat?: ChatDetailDto;
    }>('GET', `/api/v1/peers/resolve?username=${encodeURIComponent(username)}`);

    return {
      peerType: res.peer_type ?? res.peerType ?? (res.chat ? 'chat' : 'user'),
      user: res.user ? this.recordUsers([res.user])[0] : undefined,
      chat: res.chat ? mapChatDtoToDomain(res.chat) : undefined,
    };
  }

  public async listMembers(
    chatId: number,
  ): Promise<{ members: ChatMemberDto[]; users: UserProfile[] }> {
    const res = await this.requestJson<{
      members: ChatMemberDto[];
      users?: UserProfileDto[];
    }>('GET', `/api/v1/chats/${chatId}/members`);
    return {
      members: res.members ?? [],
      users: this.recordUsers(res.users ?? []),
    };
  }

  public async addMembers(chatId: number, userIds: number[]): Promise<void> {
    await this.requestJson('POST', `/api/v1/chats/${chatId}/members`, {
      user_ids: userIds,
    });
  }

  public async updateMemberRole(
    chatId: number,
    userId: number,
    patch: { role: ChatMemberDto['role']; customTitle?: string },
  ): Promise<ChatMemberDto> {
    const res = await this.requestJson<ChatMemberDto & { member?: ChatMemberDto }>(
      'PATCH',
      `/api/v1/chats/${chatId}/members/${userId}`,
      {
        role: patch.role,
        custom_title: patch.customTitle,
      },
    );
    return res.member ?? res;
  }

  public async removeMember(chatId: number, userId: number): Promise<void> {
    await this.requestJson('DELETE', `/api/v1/chats/${chatId}/members/${userId}`);
  }

  public async listInviteLinks(chatId: number): Promise<InviteLinkDto[]> {
    const res = await this.requestJson<{ invites?: InviteLinkDto[] } | InviteLinkDto[]>(
      'GET',
      `/api/v1/chats/${chatId}/invites`,
    );
    return Array.isArray(res) ? res : (res.invites ?? []);
  }

  public async createInviteLink(
    chatId: number,
    req?: { title?: string; usageLimit?: number; expireAtMs?: number },
  ): Promise<InviteLinkDto> {
    const res = await this.requestJson<InviteLinkDto & { invite?: InviteLinkDto }>(
      'POST',
      `/api/v1/chats/${chatId}/invites`,
      {
        title: req?.title,
        usage_limit: req?.usageLimit,
        expire_date_ms: req?.expireAtMs,
      },
    );
    return res.invite ?? res;
  }

  public async revokeInviteLink(chatId: number, code: string): Promise<void> {
    await this.requestJson(
      'DELETE',
      `/api/v1/chats/${chatId}/invites/${encodeURIComponent(code)}`,
    );
  }

  public async joinByInvite(code: string): Promise<ChatSummary> {
    const cleanCode = code.trim().replace(/^https?:\/\/[^/]+\/\+?/i, '').replace(/^\+/, '');
    const res = await this.requestJson<ChatDetailDto & { chat?: ChatDetailDto }>(
      'POST',
      `/api/v1/invites/${encodeURIComponent(cleanCode)}/join`,
      {},
    );
    return mapChatDtoToDomain(res.chat ?? res);
  }

  public async getChannelStatistics(chatId: number): Promise<ChannelStatisticsDto> {
    return this.requestJson<ChannelStatisticsDto>('GET', `/api/v1/chats/${chatId}/statistics`);
  }

  public async listStories(): Promise<StoryGroup[]> {
    const res = await this.requestJson<{
      groups?: Array<{
        user_id?: number;
        userId?: number;
        username?: string;
        first_name?: string;
        firstName?: string;
        avatar_media_id?: string;
        has_unviewed?: boolean;
        stories: StoryDto[];
      }>;
      stories?: StoryDto[];
    }>('GET', '/api/v1/stories');

    if (Array.isArray(res.groups)) {
      return res.groups.map((g) => {
        const stories = (g.stories ?? []).map(mapStoryDtoToDomain);
        return {
          userId: Number(g.userId ?? g.user_id ?? stories[0]?.userId ?? 0),
          username: g.username ?? stories[0]?.username,
          firstName: g.firstName ?? g.first_name ?? stories[0]?.firstName ?? 'User',
          avatarMediaId: g.avatar_media_id,
          hasUnviewed: g.has_unviewed ?? stories.some((s) => !s.isViewed),
          stories,
        };
      });
    }

    const byUser = new Map<number, StoryGroup>();
    for (const dto of res.stories ?? []) {
      const item = mapStoryDtoToDomain(dto);
      const group = byUser.get(item.userId) ?? {
        userId: item.userId,
        username: item.username,
        firstName: item.firstName,
        hasUnviewed: false,
        stories: [],
      };
      group.stories.push(item);
      if (!item.isViewed) group.hasUnviewed = true;
      byUser.set(item.userId, group);
    }
    return Array.from(byUser.values());
  }

  public async createStory(req: {
    caption?: string;
    mediaFileId?: string;
    backgroundGradient?: string;
  }): Promise<StoryItem> {
    const res = await this.requestJson<StoryDto & { story?: StoryDto }>(
      'POST',
      '/api/v1/stories',
      {
        caption: req.caption,
        media_id: req.mediaFileId,
        background_gradient: req.backgroundGradient,
      },
    );
    return mapStoryDtoToDomain(res.story ?? res);
  }

  public async markStoryViewed(storyId: string): Promise<number> {
    const res = await this.requestJson<{ views_count?: number; viewsCount?: number }>(
      'POST',
      `/api/v1/stories/${encodeURIComponent(storyId)}/view`,
      {},
    );
    return Number(res.views_count ?? res.viewsCount ?? 1);
  }

  public async searchGlobal(
    query: string,
    opts?: { tab?: SearchTabCategory; minDate?: number; maxDate?: number },
  ): Promise<GlobalSearchResponse> {
    const qs = new URLSearchParams({ q: query });
    if (opts?.tab) qs.set('tab', opts.tab);
    if (opts?.minDate !== undefined) qs.set('min_date', String(opts.minDate));
    if (opts?.maxDate !== undefined) qs.set('max_date', String(opts.maxDate));
    const res = await this.requestJson<GlobalSearchResponse>(
      'GET',
      `/api/v1/search?${qs.toString()}`,
    );
    this.recordUsers(res.users);
    return res;
  }

  public async searchMessages(
    chatId: number,
    query: string,
    opts?: { senderId?: number; topicId?: number; minDate?: number; maxDate?: number },
  ): Promise<SearchHitDto[]> {
    const qs = new URLSearchParams({ q: query, chat_id: String(chatId) });
    if (opts?.senderId !== undefined) qs.set('sender_id', String(opts.senderId));
    if (opts?.topicId !== undefined) qs.set('topic_id', String(opts.topicId));
    if (opts?.minDate !== undefined) qs.set('min_date', String(opts.minDate));
    if (opts?.maxDate !== undefined) qs.set('max_date', String(opts.maxDate));
    const res = await this.requestJson<{ hits?: SearchHitDto[]; messages?: SearchHitDto[] }>(
      'GET',
      `/api/v1/search/messages?${qs.toString()}`,
    );
    return res.hits ?? res.messages ?? [];
  }

  public async exportChat(chatId: number, format: 'json' | 'html'): Promise<string> {
    const res = await this.requestJson<string | Record<string, unknown>>(
      'GET',
      `/api/v1/chats/${chatId}/export?format=${format}`,
    );
    return typeof res === 'string' ? res : JSON.stringify(res, null, 2);
  }

  // ==========================================================================
  // F6–F13: Messages, Reactions, Polls, Todos, Invoices & Media
  // ==========================================================================

  public async listMessages(
    chatId: number,
    opts?: {
      limit?: number;
      beforeId?: number;
      afterId?: number;
      topicId?: number;
      mediaFilter?: string;
    },
  ): Promise<{ messages: MessageItem[]; pts: number; hasMore: boolean }> {
    const qs = new URLSearchParams();
    if (opts?.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts?.beforeId !== undefined) qs.set('before_id', String(opts.beforeId));
    if (opts?.afterId !== undefined) qs.set('after_id', String(opts.afterId));
    if (opts?.topicId !== undefined) qs.set('topic_id', String(opts.topicId));
    if (opts?.mediaFilter) qs.set('media_filter', opts.mediaFilter);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';

    const res = await this.requestJson<{
      messages: MessageItem[];
      pts: number;
      has_more?: boolean;
      hasMore?: boolean;
    }>('GET', `/api/v1/chats/${chatId}/messages${suffix}`);

    const messages = (res.messages ?? []).map(enrichMessageItem);
    const pts = Number(res.pts ?? 0);
    this.chatPtsMap.set(chatId, pts);
    this.sendWsFrame({ type: 'SubscribeChat', payload: { chat_id: chatId } });
    void indexedDbCache.saveChatMessages(this.accountId, chatId, messages);

    return {
      messages,
      pts,
      hasMore: Boolean(res.has_more ?? res.hasMore),
    };
  }

  private async sendMessageOverHttp(
    req: SendMessagePortInput,
  ): Promise<{ message: MessageItem; pts: number; duplicate?: boolean }> {
    const res = await this.requestJson<{
      message?: MessageItem;
      message_id?: number;
      id?: number;
      pts: number;
      duplicate?: boolean;
      date?: string;
      date_ms?: number;
      sender_id?: number;
      chat_id?: number;
      text?: string;
    }>('POST', `/api/v1/chats/${req.chatId}/messages`, {
      chat_id: req.chatId,
      text: req.text,
      entities: req.entities,
      content: req.content,
      reply_to: req.replyToMsgId
        ? { reply_to_msg_id: req.replyToMsgId, quote_text: req.quoteText }
        : undefined,
      reply_to_id: req.replyToMsgId,
      quote_text: req.quoteText,
      topic_id: req.topicId,
      client_nonce: req.clientNonce,
      silent: req.silent,
      schedule_at_ms: req.scheduleAtMs,
      ttl_seconds: req.ttlSeconds,
      send_as_peer_id: req.sendAsPeerId,
    });

    const baseMsg: MessageItem = res.message ?? {
      id: Number(res.message_id ?? res.id ?? 0),
      chat_id: Number(res.chat_id ?? req.chatId),
      peer_id: { Chat: req.chatId },
      to_peer: { Chat: req.chatId },
      sender_id: Number(res.sender_id ?? this.currentUserId),
      topic_id: req.topicId,
      flags: {
        is_out: true,
        is_pinned: false,
        is_silent: Boolean(req.silent),
        is_edited: false,
        is_scheduled: Boolean(req.scheduleAtMs),
        media_unread: false,
        has_reactions: false,
        no_forwards: false,
        is_forwarded: false,
      },
      date: res.date ?? new Date(res.date_ms ?? Date.now()).toISOString(),
      date_ms: res.date_ms ?? Date.now(),
      text: res.text ?? req.text ?? '',
      entities: req.entities ?? [],
      content: req.content ?? createTextContent(res.text ?? req.text ?? '', req.entities),
      reactions: [],
      client_nonce: req.clientNonce,
    };

    const enriched = enrichMessageItem({
      ...baseMsg,
      client_nonce: req.clientNonce ?? baseMsg.client_nonce,
      delivery_status: 'sent',
    });
    this.chatPtsMap.set(req.chatId, Number(res.pts ?? 0));
    return {
      message: enriched,
      pts: Number(res.pts ?? 0),
      duplicate: res.duplicate,
    };
  }

  public async sendMessage(
    req: SendMessagePortInput,
  ): Promise<{ message: MessageItem; pts: number; duplicate?: boolean }> {
    const clientNonce = req.clientNonce ?? generateNumericClientNonce();
    const normalizedReq: SendMessagePortInput = {
      ...req,
      clientNonce,
    };

    try {
      const sent = await this.sendMessageOverHttp(normalizedReq);
      broadcastSync.publish({
        kind: 'message_upsert',
        accountId: this.accountId,
        chatId: req.chatId,
        message: sent.message,
        pts: sent.pts,
      });
      return sent;
    } catch {
      // Queue in durable IndexedDB outbox when offline or fetch fails
    }

    const nowIso = new Date().toISOString();
    const optimisticId = -Math.abs((clientNonce % 900_000_000) + 1);
    const optimisticMessage = enrichMessageItem({
      id: optimisticId,
      chat_id: req.chatId,
      peer_id: { Chat: req.chatId },
      to_peer: { Chat: req.chatId },
      sender_id: this.currentUserId,
      topic_id: req.topicId,
      flags: {
        is_out: true,
        is_pinned: false,
        is_silent: Boolean(req.silent),
        is_edited: false,
        is_scheduled: Boolean(req.scheduleAtMs),
        media_unread: false,
        has_reactions: false,
        no_forwards: false,
        is_forwarded: false,
      },
      date: nowIso,
      date_ms: Date.now(),
      text: req.text ?? '',
      entities: req.entities ?? [],
      content: req.content ?? createTextContent(req.text ?? '', req.entities),
      reply_to: req.replyToMsgId
        ? { reply_to_msg_id: req.replyToMsgId, quote_text: req.quoteText }
        : undefined,
      reactions: [],
      client_nonce: clientNonce,
      ttl_seconds: req.ttlSeconds,
      delivery_status: 'sending',
    });

    await indexedDbCache.enqueueOutbox({
      accountId: this.accountId,
      chatId: req.chatId,
      clientNonce,
      req: normalizedReq,
      optimisticMessageId: optimisticId,
      createdAtMs: Date.now(),
    });

    return {
      message: optimisticMessage,
      pts: this.chatPtsMap.get(req.chatId) ?? 0,
    };
  }

  public async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    entities?: MessageEntity[],
  ): Promise<{ message: MessageItem; pts: number }> {
    const res = await this.requestJson<{ message: MessageItem; pts: number }>(
      'PUT',
      `/api/v1/chats/${chatId}/messages/${messageId}`,
      { text, entities },
    );
    const enriched = enrichMessageItem(res.message);
    broadcastSync.publish({
      kind: 'message_upsert',
      accountId: this.accountId,
      chatId,
      message: enriched,
      pts: res.pts,
    });
    return { message: enriched, pts: Number(res.pts) };
  }

  public async deleteMessages(
    chatId: number,
    messageIds: number[],
    forEveryone: boolean,
  ): Promise<{ pts: number }> {
    const res = await this.requestJson<{ pts?: number }>(
      'POST',
      `/api/v1/chats/${chatId}/messages/delete-batch`,
      {
        message_ids: messageIds,
        for_everyone: forEveryone,
        revoke: forEveryone,
      },
    ).catch(() =>
      this.requestJson<{ pts?: number }>('POST', '/api/v1/messages/delete', {
        chat_id: chatId,
        message_ids: messageIds,
        for_everyone: forEveryone,
        revoke: forEveryone,
      }),
    );
    broadcastSync.publish({
      kind: 'messages_deleted',
      accountId: this.accountId,
      chatId,
      messageIds,
      pts: Number(res.pts ?? 0),
    });
    return { pts: Number(res.pts ?? 0) };
  }

  public async forwardMessages(
    fromChatId: number,
    toChatId: number,
    messageIds: number[],
    opts?: { hideSender?: boolean; comment?: string },
  ): Promise<MessageItem[]> {
    const res = await this.requestJson<{ messages?: MessageItem[]; message?: MessageItem }>(
      'POST',
      `/api/v1/chats/${toChatId}/messages/forward`,
      {
        from_chat_id: fromChatId,
        to_chat_id: toChatId,
        message_ids: messageIds,
        hide_sender: opts?.hideSender,
        comment: opts?.comment,
      },
    );
    const list = res.messages ?? (res.message ? [res.message] : []);
    return list.map(enrichMessageItem);
  }

  public async pinMessage(chatId: number, messageId: number, pinned: boolean): Promise<number[]> {
    const res = await this.requestJson<{ pinned_message_ids?: number[]; pinned_ids?: number[] }>(
      pinned ? 'POST' : 'DELETE',
      `/api/v1/chats/${chatId}/messages/${messageId}/pin`,
      pinned ? {} : undefined,
    ).catch(() =>
      pinned
        ? this.requestJson<{ pinned_message_ids?: number[]; pinned_ids?: number[] }>(
            'POST',
            `/api/v1/chats/${chatId}/pins`,
            { message_id: messageId },
          )
        : this.requestJson<{ pinned_message_ids?: number[]; pinned_ids?: number[] }>(
            'DELETE',
            `/api/v1/chats/${chatId}/pins/${messageId}`,
          ),
    );
    return res.pinned_message_ids ?? res.pinned_ids ?? [];
  }

  public async listPinnedMessages(chatId: number, topicId?: number): Promise<MessageItem[]> {
    const suffix = topicId !== undefined ? `?topic_id=${topicId}` : '';
    const res = await this.requestJson<{ messages?: MessageItem[] } | MessageItem[]>(
      'GET',
      `/api/v1/chats/${chatId}/pins${suffix}`,
    );
    const list = Array.isArray(res) ? res : (res.messages ?? []);
    return list.map(enrichMessageItem);
  }

  public async readHistory(
    chatId: number,
    maxId: number,
    topicId?: number,
  ): Promise<{ unreadCount: number; pts: number }> {
    const res = await this.requestJson<{ unread_count?: number; unreadCount?: number; pts?: number }>(
      'POST',
      `/api/v1/chats/${chatId}/read`,
      { max_id: maxId, topic_id: topicId },
    );
    const unreadCount = Number(res.unread_count ?? res.unreadCount ?? 0);
    const pts = Number(res.pts ?? this.chatPtsMap.get(chatId) ?? 0);
    broadcastSync.publish({
      kind: 'read_history',
      accountId: this.accountId,
      chatId,
      maxId,
      unreadCount,
    });
    return { unreadCount, pts };
  }

  public async sendTyping(chatId: number, action: TypingAction, topicId?: number): Promise<void> {
    this.sendWsFrame({
      type: 'Typing',
      payload: { chat_id: chatId, topic_id: topicId, action },
    });
  }

  public async toggleReaction(
    chatId: number,
    messageId: number,
    emoji: string,
  ): Promise<ReactionCount[]> {
    const res = await this.requestJson<{ reactions?: ReactionCount[] }>(
      'POST',
      `/api/v1/chats/${chatId}/messages/${messageId}/reactions`,
      { emoji },
    );
    const reactions = res.reactions ?? [];
    broadcastSync.publish({
      kind: 'reaction_updated',
      accountId: this.accountId,
      chatId,
      messageId,
      reactions,
    });
    return reactions;
  }

  public async getReactionDetails(chatId: number, messageId: number): Promise<ReactionDetail[]> {
    const res = await this.requestJson<{ details?: ReactionDetail[]; reactions?: ReactionDetail[] }>(
      'GET',
      `/api/v1/chats/${chatId}/messages/${messageId}/reactions`,
    );
    return res.details ?? res.reactions ?? [];
  }

  public async sendCallbackQuery(
    chatId: number,
    messageId: number,
    data: string,
  ): Promise<{ answerText?: string; message?: MessageItem }> {
    const res = await this.requestJson<{
      answer_text?: string;
      answerText?: string;
      text?: string;
      message?: MessageItem;
    }>('POST', `/api/v1/chats/${chatId}/messages/${messageId}/callback`, {
      callback_data: data,
      data,
    }).catch(() =>
      this.requestJson<{
        answer_text?: string;
        answerText?: string;
        text?: string;
        message?: MessageItem;
      }>('POST', `/api/v1/chats/${chatId}/callback`, {
        message_id: messageId,
        callback_data: data,
        data,
      }),
    );
    return {
      answerText: res.answer_text ?? res.answerText ?? res.text,
      message: res.message ? enrichMessageItem(res.message) : undefined,
    };
  }

  public async createPoll(
    chatId: number,
    req: {
      question: string;
      options: string[];
      isAnonymous?: boolean;
      allowsMultipleAnswers?: boolean;
      isQuiz?: boolean;
      correctOptionId?: number;
      explanation?: string;
      topicId?: number;
    },
  ): Promise<{ message: MessageItem; poll: PollData }> {
    const res = await this.requestJson<{ message: MessageItem; poll: PollData }>(
      'POST',
      `/api/v1/chats/${chatId}/polls`,
      {
        question: req.question,
        options: req.options,
        is_anonymous: req.isAnonymous,
        multiple_choice: req.allowsMultipleAnswers,
        is_quiz: req.isQuiz,
        correct_option_id: req.correctOptionId,
        explanation: req.explanation,
        topic_id: req.topicId,
      },
    );
    return {
      message: enrichMessageItem(res.message),
      poll: res.poll,
    };
  }

  public async votePoll(pollId: number, optionIds: number[]): Promise<PollData> {
    const res = await this.requestJson<PollData & { poll?: PollData }>(
      'POST',
      `/api/v1/polls/${pollId}/vote`,
      { option_ids: optionIds },
    );
    return res.poll ?? res;
  }

  public async closePoll(pollId: number): Promise<PollData> {
    const res = await this.requestJson<PollData & { poll?: PollData }>(
      'POST',
      `/api/v1/polls/${pollId}/close`,
      {},
    );
    return res.poll ?? res;
  }

  public async createTodo(
    chatId: number,
    req: { title: string; items: string[]; topicId?: number },
  ): Promise<MessageItem> {
    const res = await this.requestJson<MessageItem & { message?: MessageItem }>(
      'POST',
      `/api/v1/chats/${chatId}/todos`,
      {
        title: req.title,
        items: req.items,
        topic_id: req.topicId,
      },
    );
    return enrichMessageItem(res.message ?? res);
  }

  public async toggleTodoItem(
    chatId: number,
    messageId: number,
    itemId: string,
    completed?: boolean,
  ): Promise<MessageItem> {
    const res = await this.requestJson<MessageItem & { message?: MessageItem }>(
      'POST',
      `/api/v1/chats/${chatId}/messages/${messageId}/todo`,
      {
        item_id: itemId,
        completed,
      },
    );
    return enrichMessageItem(res.message ?? res);
  }

  public async createInvoice(
    chatId: number,
    req: { title: string; description?: string; currency?: string; amount: number },
  ): Promise<{ message: MessageItem; invoice: InvoiceCard; pts: number }> {
    const res = await this.requestJson<{
      message: MessageItem;
      invoice: InvoiceCard;
      pts: number;
    }>('POST', `/api/v1/chats/${chatId}/invoices`, {
      title: req.title,
      description: req.description,
      currency: req.currency ?? 'XTR',
      amount: req.amount,
    });
    return {
      message: enrichMessageItem(res.message),
      invoice: res.invoice,
      pts: Number(res.pts ?? 0),
    };
  }

  public async payInvoice(
    chatId: number,
    messageId: number,
  ): Promise<{ paid: boolean; balance: number; receiptMessage?: MessageItem }> {
    const res = await this.requestJson<{
      paid?: boolean;
      balance?: number;
      stars_balance?: number;
      receipt_message?: MessageItem;
      receiptMessage?: MessageItem;
    }>('POST', `/api/v1/chats/${chatId}/messages/${messageId}/pay`, {});
    const receipt = res.receiptMessage ?? res.receipt_message;
    return {
      paid: res.paid ?? true,
      balance: Number(res.balance ?? res.stars_balance ?? 0),
      receiptMessage: receipt ? enrichMessageItem(receipt) : undefined,
    };
  }

  public async uploadMedia(
    data: Uint8Array | Blob,
    meta: {
      fileName: string;
      mimeType: string;
      width?: number;
      height?: number;
      durationSecs?: number;
      waveform?: number[];
    },
    onProgress?: (pct: number) => void,
  ): Promise<MediaDescriptor> {
    const bytes =
      data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
    const expectedSha256 = await computeSha256Hex(bytes);

    const init = await this.requestJson<{
      upload_id: string;
      part_size: number;
      total_parts: number;
    }>('POST', '/api/v1/media/upload/init', {
      file_name: meta.fileName,
      mime_type: meta.mimeType,
      total_size: bytes.byteLength,
      part_size: CHUNK_PART_BYTES,
      expected_sha256: expectedSha256,
    });

    const partSize = init.part_size || CHUNK_PART_BYTES;
    const totalParts = Math.max(1, init.total_parts || Math.ceil(bytes.byteLength / partSize));

    for (let partIdx = 0; partIdx < totalParts; partIdx++) {
      const start = partIdx * partSize;
      const end = Math.min(bytes.byteLength, start + partSize);
      const chunk = bytes.subarray(start, end);
      await this.requestJson(
        'PUT',
        `/api/v1/media/upload/${encodeURIComponent(init.upload_id)}/part/${partIdx}`,
        chunk,
      );
      onProgress?.(Math.min(98, Math.round(((partIdx + 1) / totalParts) * 95)));
    }

    const descriptor = await this.requestJson<MediaDescriptor>(
      'POST',
      '/api/v1/media/upload/complete',
      {
        upload_id: init.upload_id,
        width: meta.width,
        height: meta.height,
        duration_seconds: meta.durationSecs,
        waveform: meta.waveform,
        expected_sha256: expectedSha256,
      },
    );
    onProgress?.(100);
    return {
      ...descriptor,
      url: descriptor.url ? this.resolveHttpUrl(descriptor.url) : this.getMediaStreamUrl(descriptor.file_id),
    };
  }

  public getMediaStreamUrl(fileId: string): string {
    const base = this.resolveHttpUrl(`/api/v1/media/stream/${encodeURIComponent(fileId)}`);
    if (this.token) {
      return `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.token)}`;
    }
    return base;
  }

  public async listStickerSets(): Promise<StickerSetDto[]> {
    const res = await this.requestJson<{ sets?: StickerSetDto[] } | StickerSetDto[]>(
      'GET',
      '/api/v1/stickers/sets',
    );
    return Array.isArray(res) ? res : (res.sets ?? []);
  }

  public async installStickerSet(setId: string, install: boolean): Promise<void> {
    await this.requestJson(
      'POST',
      `/api/v1/stickers/sets/${encodeURIComponent(setId)}/install`,
      { installed: install, install },
    );
  }

  public async searchGifs(query: string): Promise<GifResultDto[]> {
    const endpoint = query.trim()
      ? `/api/v1/gifs/search?q=${encodeURIComponent(query)}`
      : '/api/v1/gifs/trending';
    const res = await this.requestJson<{ gifs?: GifResultDto[]; results?: GifResultDto[] }>(
      'GET',
      endpoint,
    );
    return res.gifs ?? res.results ?? [];
  }

  public async transcribeVoice(fileId: string): Promise<string> {
    const res = await this.requestJson<{ transcript?: string; text?: string }>(
      'POST',
      `/api/v1/media/${encodeURIComponent(fileId)}/transcribe`,
      {},
    );
    return res.transcript ?? res.text ?? '';
  }

  public async aiComposeAssist(
    text: string,
    mode: 'improve' | 'shorter' | 'formal' | 'translate_zh' | 'translate_en',
  ): Promise<string> {
    const res = await this.requestJson<{ result?: string; text?: string }>(
      'POST',
      '/api/v1/messages/ai-compose',
      { text, mode },
    );
    return res.result ?? res.text ?? text;
  }

  // ==========================================================================
  // F14 & F15: Profile, Privacy, Calls & Secret Chats E2EE
  // ==========================================================================

  public async getMe(): Promise<UserProfile> {
    const res = await this.requestJson<UserProfileDto & { user?: UserProfileDto }>(
      'GET',
      '/api/v1/users/me',
    );
    const mapped = mapUserDtoToDomain(res.user ?? res);
    this.currentUserId = mapped.userId;
    this.discoveredPeers.set(mapped.userId, mapped);
    return mapped;
  }

  public async updateProfile(
    patch: Partial<{
      firstName: string;
      lastName: string;
      username: string;
      bio: string;
      photoFileId: string;
    }>,
  ): Promise<UserProfile> {
    const res = await this.requestJson<UserProfileDto & { user?: UserProfileDto }>(
      'PUT',
      '/api/v1/users/me',
      {
        first_name: patch.firstName,
        last_name: patch.lastName,
        username: patch.username,
        bio: patch.bio,
        photo_file_id: patch.photoFileId,
      },
    );
    const mapped = mapUserDtoToDomain(res.user ?? res);
    this.discoveredPeers.set(mapped.userId, mapped);
    return mapped;
  }

  public async getPrivacySettings(): Promise<UserPrivacySettingsDto> {
    return this.requestJson<UserPrivacySettingsDto>('GET', '/api/v1/account/privacy').catch(() =>
      this.requestJson<UserPrivacySettingsDto>('GET', '/api/v1/users/me/settings'),
    );
  }

  public async updatePrivacySettings(
    patch: Partial<UserPrivacySettingsDto>,
  ): Promise<UserPrivacySettingsDto> {
    return this.requestJson<UserPrivacySettingsDto>('PUT', '/api/v1/account/privacy', patch).catch(
      () => this.requestJson<UserPrivacySettingsDto>('PUT', '/api/v1/users/me/settings', patch),
    );
  }

  public async listBlockedUsers(): Promise<UserProfile[]> {
    const res = await this.requestJson<{ blocked?: UserProfileDto[]; users?: UserProfileDto[] }>(
      'GET',
      '/api/v1/users/blocked',
    );
    return this.recordUsers(res.blocked ?? res.users ?? []);
  }

  public async setBlockedUser(userId: number, blocked: boolean): Promise<void> {
    await this.requestJson(
      blocked ? 'POST' : 'DELETE',
      `/api/v1/users/${userId}/block`,
      blocked ? {} : undefined,
    );
  }

  public async startCall(
    calleeId: number,
    isVideo: boolean,
    chatId?: number,
  ): Promise<CallSessionState> {
    const res = await this.requestJson<CallSessionState & { call?: CallSessionState }>(
      'POST',
      '/api/v1/calls',
      {
        callee_id: calleeId,
        is_video: isVideo,
        chat_id: chatId,
      },
    );
    return res.call ?? res;
  }

  public async sendCallSignal(signal: CallSignalPayload): Promise<void> {
    await this.requestJson('POST', '/api/v1/calls/signal', signal);
  }

  public async endCall(callId: string, rating?: number): Promise<CallSessionState> {
    const res = await this.requestJson<CallSessionState & { call?: CallSessionState }>(
      'POST',
      `/api/v1/calls/${encodeURIComponent(callId)}/end`,
      { rating },
    );
    if (rating !== undefined) {
      await this.requestJson(
        'POST',
        `/api/v1/calls/${encodeURIComponent(callId)}/rate`,
        { rating },
      ).catch(() => undefined);
    }
    return res.call ?? res;
  }

  public async listCalls(): Promise<CallSessionState[]> {
    const res = await this.requestJson<{ calls?: CallSessionState[] } | CallSessionState[]>(
      'GET',
      '/api/v1/calls',
    );
    return Array.isArray(res) ? res : (res.calls ?? []);
  }

  public async publishPreKeys(req: PublishPreKeysRequest): Promise<PublishPreKeysResponse> {
    return this.requestJson<PublishPreKeysResponse>('POST', '/api/v1/e2ee/prekeys', req);
  }

  public async getUserPreKeyBundles(userId: number): Promise<UserPreKeyBundlesResponse> {
    return this.requestJson<UserPreKeyBundlesResponse>(
      'GET',
      `/api/v1/e2ee/users/${userId}/prekeys`,
    ).catch(() =>
      this.requestJson<UserPreKeyBundlesResponse>('GET', `/api/v1/e2ee/prekeys/${userId}`),
    );
  }

  public async createSecretChat(peerUserId: number, ttlSeconds = 30): Promise<ChatSummary> {
    const res = await this.requestJson<{ chat: ChatDetailDto } & ChatDetailDto>(
      'POST',
      '/api/v1/secret-chats',
      {
        peer_user_id: peerUserId,
        ttl_seconds: ttlSeconds,
      },
    );
    return mapChatDtoToDomain(res.chat ?? res);
  }

  // ==========================================================================
  // F16: Bots, MiniApps, Hermes, Magpie, Tasks, MCP, Talk, Computers, Wallet
  // ==========================================================================

  public async listBots(): Promise<BotRegistryEntry[]> {
    const res = await this.requestJson<{ bots?: BotRegistryEntry[] } | BotRegistryEntry[]>(
      'GET',
      '/api/v1/bots',
    ).catch(() =>
      this.requestJson<{ bots?: BotRegistryEntry[] } | BotRegistryEntry[]>('GET', '/api/v1/bots/my'),
    );
    return Array.isArray(res) ? res : (res.bots ?? []);
  }

  public async createBot(req: {
    displayName: string;
    username: string;
    description?: string;
  }): Promise<{ bot: BotRegistryEntry; botToken: string; chatId: number }> {
    const res = await this.requestJson<{
      bot: BotRegistryEntry;
      bot_token?: string;
      botToken?: string;
      chat_id?: number;
      chatId?: number;
    }>('POST', '/api/v1/bots', {
      display_name: req.displayName,
      username: req.username,
      description: req.description,
    });
    return {
      bot: res.bot,
      botToken: res.bot_token ?? res.botToken ?? '',
      chatId: Number(res.chat_id ?? res.chatId ?? 0),
    };
  }

  public async listMiniApps(query?: string): Promise<MiniAppEntry[]> {
    const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
    const res = await this.requestJson<{ apps?: MiniAppEntry[]; miniapps?: MiniAppEntry[] }>(
      'GET',
      `/api/v1/miniapps${suffix}`,
    );
    return res.apps ?? res.miniapps ?? [];
  }

  public async launchMiniApp(
    botUsername: string,
    shortName: string,
    chatId?: number,
  ): Promise<MiniAppLaunchContext> {
    const cleanBot = botUsername.replace(/^@/, '');
    const res = await this.requestJson<MiniAppLaunchContext>(
      'POST',
      `/api/v1/miniapps/${encodeURIComponent(cleanBot)}/${encodeURIComponent(shortName)}/launch`,
      { chat_id: chatId },
    );
    return {
      ...res,
      launch_url: this.resolveHttpUrl(res.launch_url),
    };
  }

  public async getMiniAppCloudStorage(
    botUsername: string,
    shortName: string,
    keys?: string[],
  ): Promise<Record<string, string>> {
    const cleanBot = botUsername.replace(/^@/, '');
    const qs = keys && keys.length > 0 ? `?keys=${encodeURIComponent(keys.join(','))}` : '';
    const res = await this.requestJson<{ items?: Record<string, string>; storage?: Record<string, string> }>(
      'GET',
      `/api/v1/miniapps/${encodeURIComponent(cleanBot)}/${encodeURIComponent(shortName)}/cloud-storage${qs}`,
    );
    return res.items ?? res.storage ?? {};
  }

  public async setMiniAppCloudStorage(
    botUsername: string,
    shortName: string,
    key: string,
    value: string,
  ): Promise<void> {
    const cleanBot = botUsername.replace(/^@/, '');
    await this.requestJson(
      'PUT',
      `/api/v1/miniapps/${encodeURIComponent(cleanBot)}/${encodeURIComponent(shortName)}/cloud-storage`,
      { key, value },
    );
    await indexedDbCache.setCloudStorageItem(this.accountId, cleanBot, shortName, key, value);
  }

  public async deleteMiniAppCloudStorage(
    botUsername: string,
    shortName: string,
    keys: string[],
  ): Promise<void> {
    const cleanBot = botUsername.replace(/^@/, '');
    const qs = `?keys=${encodeURIComponent(keys.join(','))}`;
    await this.requestJson(
      'DELETE',
      `/api/v1/miniapps/${encodeURIComponent(cleanBot)}/${encodeURIComponent(shortName)}/cloud-storage${qs}`,
    );
    await indexedDbCache.deleteCloudStorageItems(this.accountId, cleanBot, shortName, keys);
  }

  public async streamHermesTurn(
    req: { prompt: string; sessionId?: string; chatId?: number; model?: string },
    onEvent: (event: HermesStreamEvent) => void,
  ): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const res = await fetch(this.resolveHttpUrl('/api/v1/hermes/turns'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: req.prompt,
        session_id: req.sessionId,
        chat_id: req.chatId,
        model: req.model,
        stream: true,
      }),
    });

    if (!res.ok) {
      throw new Error(`Hermes stream failed (${res.status})`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json') || !res.body) {
      const json = (await res.json()) as { events?: HermesStreamEvent[] };
      for (const ev of json.events ?? []) {
        onEvent(ev);
      }
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const jsonPart = line.slice(5).trim();
        if (!jsonPart || jsonPart === '[DONE]') continue;
        try {
          const ev = JSON.parse(jsonPart) as HermesStreamEvent;
          onEvent(ev);
        } catch {
          // Ignore non-JSON SSE keepalive
        }
      }
    }
  }

  public async executeHermesSlashCommand(
    command: string,
    chatId?: number,
    sessionId?: string,
  ): Promise<{ responseText: string; uiEffect: unknown }> {
    const res = await this.requestJson<{
      response_text?: string;
      responseText?: string;
      ui_effect?: unknown;
      uiEffect?: unknown;
    }>('POST', '/api/v1/hermes/command', {
      command,
      chat_id: chatId,
      session_id: sessionId,
    });
    return {
      responseText: res.response_text ?? res.responseText ?? '',
      uiEffect: res.ui_effect ?? res.uiEffect ?? null,
    };
  }

  public async listHermesCommands(prefix?: string): Promise<HermesCommandDescriptor[]> {
    const suffix = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
    const res = await this.requestJson<{ commands?: HermesCommandDescriptor[] } | HermesCommandDescriptor[]>(
      'GET',
      `/api/v1/hermes/commands${suffix}`,
    );
    return Array.isArray(res) ? res : (res.commands ?? []);
  }

  public async getHermesStudioState(): Promise<HermesStudioSnapshot> {
    const [status, sessionsRes, memory, skillsRes, toolsetsRes, cronRes, kanbanRes] =
      await Promise.all([
        this.requestJson<Record<string, unknown>>('GET', '/api/v1/hermes/status'),
        this.requestJson<{ sessions?: HermesSessionSummary[] }>('GET', '/api/v1/hermes/sessions'),
        this.requestJson<HermesMemoryState>('GET', '/api/v1/hermes/memory'),
        this.requestJson<{ skills?: HermesSkillDto[] }>('GET', '/api/v1/hermes/skills'),
        this.requestJson<{ enabled?: string[]; enabled_toolsets?: string[] }>(
          'GET',
          '/api/v1/hermes/toolsets',
        ),
        this.requestJson<{ jobs?: HermesCronJobDto[] }>('GET', '/api/v1/hermes/cron'),
        this.requestJson<{ boards?: HermesKanbanBoardDto[]; board?: HermesKanbanBoardDto }>(
          'GET',
          '/api/v1/hermes/kanban',
        ),
      ]);

    return {
      status,
      sessions: sessionsRes.sessions ?? [],
      memory,
      skills: skillsRes.skills ?? [],
      enabledToolsets: toolsetsRes.enabled_toolsets ?? toolsetsRes.enabled ?? [],
      cronJobs: cronRes.jobs ?? [],
      kanbanBoards: kanbanRes.boards ?? (kanbanRes.board ? [kanbanRes.board] : []),
    };
  }

  public async updateHermesStudioState(
    tab: HermesStudioTab,
    patch: Record<string, unknown>,
  ): Promise<HermesStudioSnapshot> {
    switch (tab) {
      case 'memory':
        if ('soul_markdown' in patch) {
          await this.requestJson('PUT', '/api/v1/hermes/soul', patch);
        } else {
          await this.requestJson('PUT', '/api/v1/hermes/memory', patch);
        }
        break;
      case 'skills':
        if (typeof patch.deleteSkillName === 'string') {
          await this.requestJson(
            'DELETE',
            `/api/v1/hermes/skills/${encodeURIComponent(patch.deleteSkillName)}`,
          );
        } else if (typeof patch.trustSkillName === 'string') {
          await this.requestJson(
            'POST',
            `/api/v1/hermes/skills/${encodeURIComponent(patch.trustSkillName)}/trust`,
            {},
          );
        } else {
          await this.requestJson('POST', '/api/v1/hermes/skills', patch);
        }
        break;
      case 'toolsets':
        await this.requestJson('PUT', '/api/v1/hermes/toolsets', patch);
        break;
      case 'cron':
        if (typeof patch.triggerJobId === 'string') {
          await this.requestJson(
            'POST',
            `/api/v1/hermes/cron/${encodeURIComponent(patch.triggerJobId)}/trigger`,
            {},
          );
        } else if (typeof patch.deleteJobId === 'string') {
          await this.requestJson(
            'DELETE',
            `/api/v1/hermes/cron/${encodeURIComponent(patch.deleteJobId)}`,
          );
        } else {
          await this.requestJson('POST', '/api/v1/hermes/cron', patch);
        }
        break;
      case 'kanban':
        if (typeof patch.deleteCardId === 'string') {
          await this.requestJson(
            'DELETE',
            `/api/v1/hermes/kanban/cards/${encodeURIComponent(patch.deleteCardId)}`,
          );
        } else if (typeof patch.cardId === 'string') {
          await this.requestJson(
            'PATCH',
            `/api/v1/hermes/kanban/cards/${encodeURIComponent(patch.cardId)}`,
            patch,
          );
        } else {
          await this.requestJson('POST', '/api/v1/kanban/cards', patch).catch(() =>
            this.requestJson('POST', '/api/v1/hermes/kanban/cards', patch),
          );
        }
        break;
      case 'sessions':
      default:
        if (typeof patch.deleteSessionId === 'string') {
          await this.requestJson(
            'DELETE',
            `/api/v1/hermes/sessions/${encodeURIComponent(patch.deleteSessionId)}`,
          );
        } else {
          await this.requestJson('POST', '/api/v1/hermes/sessions', patch);
        }
        break;
    }
    return this.getHermesStudioState();
  }

  private mapMagpieSnapshot(raw: Record<string, unknown>): MagpieConfigSnapshot {
    return {
      presets: (raw.presets as MagpiePreset[]) ?? [],
      providers: (raw.providers as MagpieProviderView[]) ?? [],
      activeProvider: String(raw.active_provider ?? raw.activeProvider ?? ''),
      activeModel: String(raw.active_model ?? raw.activeModel ?? ''),
      allowLocalFallback: Boolean(raw.allow_local_fallback ?? raw.allowLocalFallback ?? false),
      routingGroups: (raw.routing_groups ?? raw.routingGroups ?? []) as MagpieRoutingGroup[],
      routingStrategy: String(raw.routing_strategy ?? raw.routingStrategy ?? 'smart'),
      masking: (raw.masking as MagpieMaskingConfig) ?? {
        enabled: true,
        mask_secrets: true,
        mask_personal: true,
        custom_words: [],
        allow_list: [],
        default_action: 'mask',
      },
    };
  }

  public async getMagpieConfig(): Promise<MagpieConfigSnapshot> {
    const raw = await this.requestJson<Record<string, unknown>>(
      'GET',
      '/api/v1/hermes/magpie/config',
    ).catch(() =>
      this.requestJson<Record<string, unknown>>('GET', '/api/v1/hermes/magpie/state'),
    );
    return this.mapMagpieSnapshot(raw);
  }

  public async updateMagpieConfig(patch: Record<string, unknown>): Promise<MagpieConfigSnapshot> {
    if (patch.upsertProvider && typeof patch.upsertProvider === 'object') {
      await this.requestJson('POST', '/api/v1/hermes/magpie/providers', patch.upsertProvider);
      return this.getMagpieConfig();
    }
    if (typeof patch.deleteProviderId === 'string') {
      await this.requestJson(
        'DELETE',
        `/api/v1/hermes/magpie/providers/${encodeURIComponent(patch.deleteProviderId)}`,
      );
      return this.getMagpieConfig();
    }
    const raw = await this.requestJson<Record<string, unknown>>(
      'PUT',
      '/api/v1/hermes/magpie/config',
      {
        active_provider: patch.activeProvider ?? patch.active_provider,
        active_model: patch.activeModel ?? patch.active_model,
        allow_local_fallback: patch.allowLocalFallback ?? patch.allow_local_fallback,
        routing_strategy: patch.routingStrategy ?? patch.routing_strategy,
        routing_groups: patch.routingGroups ?? patch.routing_groups,
        masking: patch.masking,
      },
    );
    return this.mapMagpieSnapshot(raw);
  }

  public async probeMagpieProvider(providerId: string): Promise<{
    ok: boolean;
    latency_ms?: number;
    models?: string[];
    error?: string;
  }> {
    return this.requestJson(
      'POST',
      `/api/v1/hermes/magpie/providers/${encodeURIComponent(providerId)}/probe`,
      {},
    );
  }

  public async scanMagpieSubscriptions(): Promise<{
    subscriptions: Array<Record<string, unknown>>;
  }> {
    const res = await this.requestJson<{
      subscriptions?: Array<Record<string, unknown>>;
      detected?: Array<Record<string, unknown>>;
    }>('POST', '/api/v1/hermes/magpie/subscriptions/scan', {});
    return { subscriptions: res.subscriptions ?? res.detected ?? [] };
  }

  public async importMagpieConfig(payload: {
    raw_text?: string;
    providers?: Array<Record<string, unknown>>;
  }): Promise<MagpieConfigSnapshot> {
    await this.requestJson('POST', '/api/v1/hermes/magpie/import', payload);
    return this.getMagpieConfig();
  }

  public async getMagpieUsage(): Promise<MagpieUsageLedgerSummary> {
    return this.requestJson<MagpieUsageLedgerSummary>('GET', '/api/v1/hermes/magpie/usage');
  }

  public async testMagpiePrivacyMask(text: string): Promise<MagpieMaskingPreviewResult> {
    return this.requestJson<MagpieMaskingPreviewResult>(
      'POST',
      '/api/v1/hermes/magpie/masking/preview',
      { text },
    );
  }

  public async listTasks(): Promise<TaskItemDto[]> {
    const res = await this.requestJson<{ tasks?: TaskItemDto[] } | TaskItemDto[]>(
      'GET',
      '/api/v1/tasks',
    );
    return Array.isArray(res) ? res : (res.tasks ?? []);
  }

  public async createTask(req: {
    title: string;
    description?: string;
    cronExpr?: string;
    chatId?: number;
  }): Promise<TaskItemDto> {
    const res = await this.requestJson<TaskItemDto & { task?: TaskItemDto }>(
      'POST',
      '/api/v1/tasks',
      {
        title: req.title,
        description: req.description,
        cron_expr: req.cronExpr,
        chat_id: req.chatId,
      },
    );
    return res.task ?? res;
  }

  public async updateTask(
    taskId: string,
    patch: Partial<{ state: TaskItemDto['state']; title: string; cronExpr: string }>,
  ): Promise<TaskItemDto> {
    const res = await this.requestJson<TaskItemDto & { task?: TaskItemDto }>(
      'PATCH',
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
      {
        state: patch.state,
        title: patch.title,
        cron_expr: patch.cronExpr,
      },
    );
    return res.task ?? res;
  }

  public async deleteTask(taskId: string): Promise<void> {
    await this.requestJson('DELETE', `/api/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  public async listMcpServers(): Promise<McpServerDto[]> {
    const res = await this.requestJson<{ servers?: McpServerDto[] } | McpServerDto[]>(
      'GET',
      '/api/v1/mcp/servers',
    );
    return Array.isArray(res) ? res : (res.servers ?? []);
  }

  public async registerMcpServer(req: {
    name: string;
    transport: string;
    url?: string;
    command?: string;
    args?: string[];
  }): Promise<McpServerDto> {
    const res = await this.requestJson<McpServerDto & { server?: McpServerDto }>(
      'POST',
      '/api/v1/mcp/servers',
      req,
    );
    return res.server ?? res;
  }

  public async deleteMcpServer(serverId: string): Promise<void> {
    await this.requestJson('DELETE', `/api/v1/mcp/servers/${encodeURIComponent(serverId)}`);
  }

  public async listMcpTools(): Promise<{
    tools: McpToolDto[];
    approvals: McpPendingApprovalDto[];
  }> {
    const res = await this.requestJson<{
      tools?: McpToolDto[];
      approvals?: McpPendingApprovalDto[];
    }>('GET', '/api/v1/mcp/tools');
    return {
      tools: res.tools ?? [],
      approvals: res.approvals ?? [],
    };
  }

  public async invokeMcpTool(req: {
    toolId?: string;
    toolName?: string;
    arguments?: Record<string, unknown>;
    forceApprove?: boolean;
  }): Promise<Record<string, unknown>> {
    const payload = {
      tool_id: req.toolId,
      tool_name: req.toolName,
      arguments: req.arguments ?? {},
      force_approve: req.forceApprove,
    };
    return this.requestJson<Record<string, unknown>>('POST', '/api/v1/mcp/invoke', payload).catch(
      () => this.requestJson<Record<string, unknown>>('POST', '/api/v1/mcp/call', payload),
    );
  }

  public async approveMcpToolCall(requestId: string, allow: boolean): Promise<void> {
    await this.requestJson('POST', '/api/v1/mcp/approve', {
      request_id: requestId,
      allow,
      approved: allow,
    }).catch(() =>
      this.requestJson('POST', '/api/v1/mcp/permission/approve', {
        request_id: requestId,
        allow,
        approved: allow,
      }),
    );
  }

  public async startTalkSession(): Promise<TalkSessionDto> {
    return this.requestJson<TalkSessionDto>('POST', '/api/v1/talk/start', {});
  }

  public async sendTalkAudio(
    audioOrTranscript: Uint8Array | { transcript: string },
  ): Promise<TalkSessionDto> {
    return this.requestJson<TalkSessionDto>('POST', '/api/v1/talk/audio', audioOrTranscript);
  }

  public async bargeInTalkSession(): Promise<TalkSessionDto> {
    return this.requestJson<TalkSessionDto>('POST', '/api/v1/talk/barge-in', {}).catch(() =>
      this.requestJson<TalkSessionDto>('POST', '/api/v1/talk/barge_in', {}),
    );
  }

  public async stopTalkSession(): Promise<TalkSessionDto> {
    return this.requestJson<TalkSessionDto>('POST', '/api/v1/talk/stop', {});
  }

  public async listComputers(): Promise<{
    computers: ComputerNodeDto[];
    pendingApprovals: PendingComputerCommandDto[];
  }> {
    const res = await this.requestJson<{
      computers?: ComputerNodeDto[];
      pending_approvals?: PendingComputerCommandDto[];
      pendingApprovals?: PendingComputerCommandDto[];
    }>('GET', '/api/v1/computers');
    return {
      computers: res.computers ?? [],
      pendingApprovals: res.pending_approvals ?? res.pendingApprovals ?? [],
    };
  }

  public async createCloudComputer(req: {
    display_name: string;
    host: string;
    port?: number;
    ssh_user: string;
    secret?: string;
    run_policy?: ComputerRunPolicy;
  }): Promise<ComputerNodeDto> {
    const res = await this.requestJson<ComputerNodeDto & { computer?: ComputerNodeDto }>(
      'POST',
      '/api/v1/computers/cloud',
      req,
    );
    return res.computer ?? res;
  }

  public async testComputerConnection(nodeId: string): Promise<{
    ok: boolean;
    latency_ms?: number;
    message?: string;
  }> {
    return this.requestJson(
      'POST',
      `/api/v1/computers/${encodeURIComponent(nodeId)}/test`,
      {},
    );
  }

  public async deleteComputer(nodeId: string): Promise<void> {
    await this.requestJson('DELETE', `/api/v1/computers/${encodeURIComponent(nodeId)}`);
  }

  public async executeComputerOp(
    nodeId: string,
    operation: Record<string, unknown>,
    callerLabel?: string,
  ): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(
      'POST',
      `/api/v1/computers/${encodeURIComponent(nodeId)}/commands`,
      {
        ...operation,
        caller_label: callerLabel,
      },
    ).catch(() =>
      this.requestJson<Record<string, unknown>>('POST', '/api/v1/computers/exec', {
        node_id: nodeId,
        ...operation,
        caller_label: callerLabel,
      }),
    );
  }

  public async approveComputerCommand(
    commandId: string,
    approve: boolean,
  ): Promise<PendingComputerCommandDto> {
    return this.requestJson<PendingComputerCommandDto>(
      'POST',
      `/api/v1/computers/commands/${encodeURIComponent(commandId)}/decide`,
      { approve, approved: approve },
    ).catch(() =>
      this.requestJson<PendingComputerCommandDto>(
        'POST',
        `/api/v1/computers/commands/${encodeURIComponent(commandId)}/approve`,
        { approve, approved: approve },
      ),
    );
  }

  public async updateComputerPolicy(
    nodeId: string,
    policy: ComputerRunPolicy,
  ): Promise<ComputerNodeDto> {
    const res = await this.requestJson<ComputerNodeDto & { computer?: ComputerNodeDto }>(
      'PATCH',
      `/api/v1/computers/${encodeURIComponent(nodeId)}/policy`,
      { run_policy: policy },
    );
    return res.computer ?? res;
  }

  public async emergencyTakeoverComputer(
    nodeId = '',
  ): Promise<{ status: string; newGeneration: number; latencySub10ms: boolean }> {
    const target = nodeId || 'default';
    const res = await this.requestJson<{
      status?: string;
      new_generation?: number;
      newGeneration?: number;
      latency_sub10ms?: boolean;
      latencySub10ms?: boolean;
    }>('POST', `/api/v1/computers/${encodeURIComponent(target)}/takeover`, {});
    return {
      status: res.status ?? 'revoked',
      newGeneration: Number(res.new_generation ?? res.newGeneration ?? 2),
      latencySub10ms: Boolean(res.latency_sub10ms ?? res.latencySub10ms ?? true),
    };
  }

  public async getTailnetStatus(): Promise<TailnetStatusDto> {
    return this.requestJson<TailnetStatusDto>('GET', '/api/v1/tailnet/status').catch(() =>
      this.requestJson<TailnetStatusDto>('GET', '/api/v1/tailnet/netmap'),
    );
  }

  public async getWalletState(): Promise<WalletStateDto> {
    return this.requestJson<WalletStateDto>('GET', '/api/v1/wallet').catch(async () => {
      const [bal, txs] = await Promise.all([
        this.requestJson<{
          user_id?: number;
          stars_balance?: number;
          balance?: number;
          ton_nano?: number;
          ton_balance?: string;
        }>('GET', '/api/v1/wallet/balance'),
        this.requestJson<{ transactions?: WalletStateDto['transactions'] }>(
          'GET',
          '/api/v1/wallet/transactions',
        ).catch(() => ({ transactions: [] })),
      ]);
      const tonNano = Number(bal.ton_nano ?? 0);
      const starsBal = Number(bal.stars_balance ?? bal.balance ?? 0);
      return {
        user_id: Number(bal.user_id ?? this.currentUserId),
        balance: starsBal,
        stars_balance: starsBal,
        ton_nano: tonNano,
        ton_balance: bal.ton_balance ?? (tonNano / 1e9).toFixed(4),
        updated_at_ms: Date.now(),
        transactions: txs.transactions ?? [],
      };
    });
  }

  public async topUpStars(amount: number): Promise<WalletStateDto> {
    return this.requestJson<WalletStateDto>('POST', '/api/v1/wallet/topup', {
      amount,
      amount_stars: amount,
    });
  }

  public async sendStarGift(req: {
    toUserId: number;
    chatId?: number;
    amountStars: number;
    giftId?: string;
    message?: string;
  }): Promise<WalletStateDto> {
    return this.requestJson<WalletStateDto>('POST', '/api/v1/wallet/gift', {
      to_user_id: req.toUserId,
      chat_id: req.chatId,
      amount_stars: req.amountStars,
      gift_id: req.giftId,
      message: req.message,
    });
  }

  // ==========================================================================
  // F17: BrowserControlClientPort (`/api/v1/browser/*` & `/api/v1/mcp/rpc`)
  // ==========================================================================

  public async createDesktopPairingTicket(opts?: {
    label?: string;
    ttlSecs?: number;
  }): Promise<DesktopPairingTicketDto> {
    return this.requestJson<DesktopPairingTicketDto>('POST', '/api/v1/browser/pair/create', {
      label: opts?.label,
      ttl_secs: opts?.ttlSecs,
    });
  }

  public async claimDesktopPairingTicket(
    pairCode: string,
    controllerLabel?: string,
  ): Promise<DesktopPairingTicketDto> {
    return this.requestJson<DesktopPairingTicketDto>('POST', '/api/v1/browser/pair/claim', {
      pair_code: pairCode,
      controller_label: controllerLabel,
    });
  }

  public async listBrowserTargets(): Promise<{
    targets: BrowserTargetDescriptor[];
    control_generation: number;
  }> {
    return this.requestJson('GET', '/api/v1/browser/targets');
  }

  public async registerBrowserTarget(
    payload: BrowserRegisterPayload,
  ): Promise<BrowserTargetDescriptor> {
    return this.requestJson('POST', '/api/v1/browser/targets/register', payload);
  }

  public async reportBrowserState(
    payload: BrowserStateReportPayload,
  ): Promise<BrowserTargetDescriptor> {
    return this.requestJson(
      'POST',
      `/api/v1/browser/targets/${encodeURIComponent(payload.target_id)}/state`,
      payload,
    );
  }

  public async sendBrowserCommand(req: BrowserCommandRequest): Promise<BrowserCommandResult> {
    return this.requestJson<BrowserCommandResult>('POST', '/api/v1/browser/command', req);
  }

  public async revokeBrowserControl(opts?: {
    targetId?: string;
    revokeTokens?: boolean;
  }): Promise<BrowserControlRevokeResponse> {
    browserControlAgent.emergencyTakeover('operator_revoke');
    return this.requestJson<BrowserControlRevokeResponse>('POST', '/api/v1/browser/revoke', {
      target_id: opts?.targetId,
      revoke_tokens: opts?.revokeTokens ?? true,
    });
  }

  public async listBrowserAuditLogs(limit = 50): Promise<{ entries: BrowserAuditLogEntry[] }> {
    return this.requestJson('GET', `/api/v1/browser/audit?limit=${limit}`);
  }

  public async openHeadlessSession(req?: {
    url?: string;
    viewport?: { width: number; height: number };
    preferFallback?: boolean;
  }): Promise<{ session: HeadlessBrowserSessionDto; snapshot: BrowserSnapshotDto }> {
    return this.requestJson('POST', '/api/v1/browser/headless/open', {
      url: req?.url,
      viewport: req?.viewport,
      prefer_fallback: req?.preferFallback,
    });
  }

  public async listHeadlessSessions(): Promise<{ sessions: HeadlessBrowserSessionDto[] }> {
    return this.requestJson('GET', '/api/v1/browser/headless/sessions');
  }

  public async executeHeadlessAction(
    sessionId: string,
    req: Omit<BrowserCommandRequest, 'target_id'>,
  ): Promise<BrowserCommandResult> {
    return this.requestJson(
      'POST',
      `/api/v1/browser/headless/${encodeURIComponent(sessionId)}/action`,
      req,
    );
  }

  public async captureHeadlessScreenshot(sessionId: string): Promise<{
    session_id: string;
    screenshot_data_url: string;
    mime_type: string;
    backend: HeadlessBrowserSessionDto['backend'];
  }> {
    return this.requestJson(
      'POST',
      `/api/v1/browser/headless/${encodeURIComponent(sessionId)}/screenshot`,
      {},
    );
  }

  public async closeHeadlessSession(
    sessionId: string,
  ): Promise<{ ok: boolean; session_id: string }> {
    return this.requestJson(
      'POST',
      `/api/v1/browser/headless/${encodeURIComponent(sessionId)}/close`,
      {},
    );
  }

  public async invokeMcpRpc(req: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
    return this.requestJson<McpJsonRpcResponse>('POST', '/api/v1/mcp/rpc', req);
  }
}
